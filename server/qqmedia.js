// ============================================================
//  QQ 富媒体上传：分片上传 + 发送媒体消息（msg_type=7）
//
//  ⚠️ 零依赖：只用 Node 内置的 fetch / crypto（md5、sha1 都在 crypto 里）。
//
//  官方流程（4 步，2026-09-22 在真机上逐步验证过）：
//    ① POST /v2/{groups|users}/{id}/upload_prepare
//         body: file_type, file_size, file_name, md5, sha1, md5_10m
//         ← upload_id, block_size, parts[{index, presigned_url, block_size}]
//    ② PUT <presigned_url>           把每一片二进制直接 PUT 上去（不带鉴权头）
//    ③ POST /v2/{groups|users}/{id}/upload_part_finish
//         body: upload_id, part_index, block_size, md5
//    ④ POST /v2/{groups|users}/{id}/files   body: { file_type, upload_id }
//         ← file_info（透传即可，不要解析它的内容）
//    ⑤ 发消息 msg_type=7 + media.file_info
//
//  ⚠️⚠️ 踩过的坑（2026-09-22，实测）：
//     官方文档写 `parts[].index` **从 0 开始**，但**真实 API 返回的是 1**。
//     第一版按 `index * block_size` 算偏移 → 越界 → 上传了 0 字节 →
//     合并时报 `850019 富媒体文件格式不支持`（**错误信息把人往"格式"上带，其实是空的**）。
//     ✅ 正解：**按每片自己的 block_size 顺序累加偏移**，完全不依赖 index 语义。
//
//  其它官方限制（都会影响功能设计）：
//     · file_type: 1=图片 2=视频 3=语音 4=文件
//     · 视频**只支持 mp4**，软限制 30MB（超了降级成"文件"，就不是可播放视频了），硬限制 200MB
//     · 上传接口 10~50 QPS，我们远用不到
//     · file_info 有 ttl，过期要重传 —— 所以我们**上传完立刻发**
//     · 错误码 40093002 = 超过今天发送文件容量上限
// ============================================================
const crypto = require('crypto');
const cfg = require('./config');
const { getAccessToken } = require('./auth');

const API = 'https://api.bot.qq.com';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

// ---------- 🆕 2026-10-14 晚：`file_info` 复用缓存（治大图每次重传那 6 秒）----------
//
// 🔴 为什么要这个（实测数据，见本机 `_srv/_probe-stall*.cjs`）：一张 1.13MB 的长图发一次约 **6 秒**，拆开是
//    预上传 0.2~0.7s + 分片 PUT 1.7~2.4s（1.13MB，服务器上行 ~3Mbps）+ 合并 0.3~1.0s
//    + **发媒体消息 2~3s（QQ 侧固定成本，跟大小无关：0.01MB 的小图也要 1~2s）**。
//    而同一份字节**每次都要重传一遍** —— 同一个群、同一张图，白扔那 2.5~3.1s。
//    QQ 合并出来的 `file_info` 有有效期，**实测 15 分钟后的旧票据仍能直接发**（`_srv/_wall-fi-reuse.cjs`）。
// 🔴 缓存必须带**失效条件**（本项目老教训：靠"重启才更新"的缓存就是静默雷）：
//    ① 键里带**内容 sha256**（文件换了 = 换键，自动失效，不靠人记得清）；
//    ② TTL（默认 2 小时，可用 `XLJ_MEDIA_TTL_MS` 覆盖）；
//    ③ **发送失败立刻 `forgetMedia()` 重传一次**（票据过期是唯一可能的失败模式）。
// ⚠️ 只对**显式传 `{ reuse: true }`** 的调用生效 —— 图库配图那种"每次都不同"的图不受影响。
const MEDIA_CACHE = new Map();                      // key -> { fileInfo, at }
const MEDIA_TTL = Number(process.env.XLJ_MEDIA_TTL_MS || 2 * 60 * 60 * 1000);

function mediaKey(scope, id, buf, fileName, fileType) {
  return [scope, id, fileType, fileName,
    crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)].join('|');
}
function mediaFresh(at, now = Date.now()) { return (now - at) < MEDIA_TTL; }

// md5_10m = 文件前 10002432 字节的 MD5（官方拿来判"秒传"）
const MD5_10M_BYTES = 10002432;

function timeoutMs() {
  // 上传接口官方建议超时 ≥5 秒；大文件分片要更宽
  return cfg.policy.linkParse?.video?.uploadTimeoutMs || 60000;
}

async function api(path, body, token) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: {
      Authorization: 'QQBot ' + token,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    signal: AbortSignal.timeout(timeoutMs()),
  });
  const t = await r.text();
  let j;
  try { j = t ? JSON.parse(t) : {}; } catch { throw new Error(`HTTP ${r.status} 返回非 JSON: ${t.slice(0, 200)}`); }
  return { ok: r.ok && !j.err_code, status: r.status, j };
}

// scope: 'groups' | 'users'
async function prepareAndUpload(scope, id, buf, fileName, fileType, log) {
  const token = await getAccessToken();
  const base = `/v2/${scope}/${id}`;
  const mb = (buf.length / 1024 / 1024).toFixed(2);

  // ---- ① 预上传 ----
  const t0 = Date.now();
  const pre = await api(`${base}/upload_prepare`, {
    file_type: fileType,
    file_size: String(buf.length),
    file_name: fileName,
    md5: md5(buf),
    sha1: sha1(buf),
    md5_10m: md5(buf.subarray(0, MD5_10M_BYTES)),
  }, token);
  if (!pre.ok || !pre.j.upload_id) {
    throw new Error(`预上传失败 HTTP ${pre.status} code=${pre.j.err_code || pre.j.code} ${pre.j.message || ''}`);
  }
  const { upload_id, parts } = pre.j;
  log(`预上传 OK（${Date.now() - t0}ms）· upload_id=${upload_id} · ${parts.length} 个分片`);

  // ---- ② + ③ 逐片 PUT + part_finish ----
  // ⚠️ 偏移**按每片自己的 block_size 累加**，不要用 index * block_size（见文件头的坑）
  let offset = 0;
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  for (const part of ordered) {
    const size = Number(part.block_size);
    const chunk = buf.subarray(offset, Math.min(offset + size, buf.length));
    offset += size;
    if (!chunk.length) continue;

    const tp = Date.now();
    const put = await fetch(part.presigned_url, {
      method: 'PUT',
      body: chunk,
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!put.ok) {
      const txt = await put.text().catch(() => '');
      throw new Error(`分片 ${part.index} PUT 失败 HTTP ${put.status} ${txt.slice(0, 120)}`);
    }

    const fin = await api(`${base}/upload_part_finish`, {
      upload_id,
      part_index: part.index,
      block_size: String(chunk.length),
      md5: md5(chunk),
    }, token);
    if (!fin.ok) {
      throw new Error(`分片 ${part.index} finish 失败 code=${fin.j.err_code || fin.j.code} ${fin.j.message || ''}`);
    }
    log(`  分片 ${part.index} 完成（${(chunk.length / 1024 / 1024).toFixed(2)}MB / ${((Date.now() - tp) / 1000).toFixed(1)}s）`);
  }

  // ---- ④ 合并拿 file_info ----
  const tm = Date.now();
  const merge = await api(`${base}/files`, { file_type: fileType, upload_id, srv_send_msg: false }, token);
  if (!merge.ok || !merge.j.file_info) {
    throw new Error(`合并失败 HTTP ${merge.status} code=${merge.j.err_code || merge.j.code} ${merge.j.message || ''}`);
  }
  log(`合并 OK（${Date.now() - tm}ms）· 总计 ${((Date.now() - t0) / 1000).toFixed(1)}s / ${mb}MB`);
  return merge.j.file_info;
}

/**
 * 把一个 Buffer 作为富媒体上传，返回 file_info
 * @param {'groups'|'users'} scope
 * @param {string} id          群 openid 或用户 openid
 * @param {Buffer} buf         文件内容
 * @param {string} fileName    文件名（要带扩展名，视频必须是 .mp4）
 * @param {number} fileType    1=图片 2=视频 3=语音 4=文件
 * @param {(m:string)=>void} [log]
 */
async function uploadMedia(scope, id, buf, fileName, fileType, log = () => {}, opts = {}) {
  // 🆕 2026-10-14 晚：显式要求复用时，先看缓存（键里带内容 sha256 ⇒ 文件改了自动失效）
  if (opts.reuse) {
    const key = mediaKey(scope, id, buf, fileName, fileType);
    const hit = MEDIA_CACHE.get(key);
    if (hit && mediaFresh(hit.at)) {
      log(`复用 ${((Date.now() - hit.at) / 60000).toFixed(1)} 分钟前的 file_info（跳过上传，省 2~3 秒）`);
      return hit.fileInfo;
    }
  }
  const fi = await prepareAndUpload(scope, id, buf, fileName, fileType, log);
  if (opts.reuse) MEDIA_CACHE.set(mediaKey(scope, id, buf, fileName, fileType), { fileInfo: fi, at: Date.now() });
  return fi;
}

// 🔴 票据作废（发送失败时的兜底：清掉再重传一次，别让一次过期票据把功能卡死）
function forgetMedia(scope, id) {
  const pre = `${scope}|${id}|`;
  for (const k of [...MEDIA_CACHE.keys()]) if (k.startsWith(pre)) MEDIA_CACHE.delete(k);
}

/**
 * 下载一个 URL 到内存（带大小上限，防止被超大文件打爆 2G 内存）
 * @param {object} opts { headers, maxBytes, timeoutMs }
 */
async function downloadToBuffer(url, opts = {}) {
  const max = opts.maxBytes || 40 * 1024 * 1024;
  const r = await fetch(url, {
    headers: opts.headers || {},
    signal: AbortSignal.timeout(opts.timeoutMs || 60000),
  });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);

  const declared = Number(r.headers.get('content-length') || 0);
  if (declared && declared > max) {
    throw new Error(`文件过大：${(declared / 1048576).toFixed(1)}MB > 上限 ${(max / 1048576).toFixed(0)}MB`);
  }
  const ab = await r.arrayBuffer();
  if (ab.byteLength > max) {
    throw new Error(`文件过大：${(ab.byteLength / 1048576).toFixed(1)}MB > 上限 ${(max / 1048576).toFixed(0)}MB`);
  }
  return Buffer.from(ab);
}

module.exports = {
  uploadMedia, downloadToBuffer, forgetMedia,
  _md5: md5, _sha1: sha1,
  // 🆕 给自测用（不联网就能验缓存命中/失效）
  _mediaKey: mediaKey, _mediaFresh: mediaFresh, _mediaCache: MEDIA_CACHE, _mediaTtl: () => MEDIA_TTL,
};
