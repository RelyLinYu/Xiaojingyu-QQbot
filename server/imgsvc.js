// ============================================================
//  imgsvc.js —— 「把图压小」的统一入口（2026-10-16）
//
//  📝 用户两条要求：「**这个返图还是大图**」+「要考虑用户上传大图之后**自动压缩成小图**」
//
//  实测逼出来的分工：
//    · 群里出现过 **99 帧的 GIF、7.6MB**，线上发一次 **36 秒**
//    · 图库里还有 JPEG/WebP（纯 Node 没有解码器）
//    · 服务器上**已有 Pillow 12.3**（在 `/opt/meme-api/.venv/bin/python` 里，
//      `meme-frames.py` 本来就用它）⇒ 拿它当**离线工具**，**不往 Node 加依赖**（项目铁律）
//
//  ⇒ 两个引擎，按格式自动选（**别两头都试**，浪费 CPU 也难排查）：
//    · **PNG**  → Node 的 `imgcompress.js`（零依赖、无子进程；PNG-8 量化实测最狠：
//                 1439KB→158KB，比 Pillow 只缩放强得多）
//    · **其它**（GIF/JPEG/WebP）→ 调 `tools/img-shrink.py`（Pillow）
//      ⚠️ GIF **保持动图**：缩画布 + 均匀抽帧（实测：7.6MB→763KB，100 帧→16 帧）
//
//  ⚠️ 三件事**永远不做**：① 不改磁盘上的原素材（只有 `imglib.add` 例外 —— 那是用户明确
//     要求的"入库即压缩"，而且是**新文件**，不是覆盖旧的）；② 压不小就原样返回；
//     ③ 任何异常都吞掉并返回原字节（**压缩绝不能挡住发图**）。
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 默认的 python / 脚本位置（都在服务器上，配置可覆盖）
// ⚠️ 脚本路径必须按 **`__dirname`（代码在哪）** 算，**不能用 APP_DIR（数据在哪）** ——
//    这是 2026-10-16 灌事件体检抓到的：沙箱把 APP_DIR 指到 /tmp 之后，
//    这里去找 `/tmp/.../tools/img-shrink.py` 自然找不到，压缩静默失效（表现为"上传还是 3.6MB"）。
//    ⇒ 分工记牢：**代码/工具跟着 `__dirname` 走，状态/数据跟着 `APP_DIR` 走**。
const PY_DEFAULT = '/opt/meme-api/.venv/bin/python';
const SCRIPT_DEFAULT = path.join(__dirname, 'tools', 'img-shrink.py');

// 🆕 2026-10-16 **两条链路共用的长边上限**（唯一真源）
//
// 🔴 用户第三次反馈「怎么感觉有大有小的」—— 量出来是我自己造成的：
//    发送侧写 384、入库侧写 640 ⇒ 同一张图，两条链路出来的大小明显不一样。
//    ⇒ 统一到这一个常量；config 里那两处 `maxEdge` 只是"允许单独覆盖"的出口，
//      **默认值必须一致**（自测里钉了这条）。
const COMMON_EDGE = 512;

function pngInfoOf(buf) {
  try { return require('./imgcompress').pngInfo(buf); } catch { return null; }
}

// ---------- 🆕 便宜的"像素尺寸"嗅探（不 spawn、不解码）----------
//
// 🔴 2026-10-16 用户第二次说"还是大图"逼出来的：**他说的"大"是显示尺寸（像素），不是字节**。
//    实测机器人发出去的那几张是 **1254×1254 的 JPEG，只有 212~268KB** ——
//    字节小得低于我的 `minBytes` 阈值（300KB），于是**整个压缩流程被跳过**，
//    群里看到的还是一张占满屏的大图。
//    ⇒ 判据必须**先看像素**：`长边 > maxEdge` 就必须压（跟字节大小无关）；
//      只有"像素没超、字节也小"才真跳过。
//    自己能嗅出尺寸就不用起子进程（PNG/GIF/JPEG(SOF)/WebP 四种够用了）。
function dimsOf(buf) {
  try {
    const p = pngInfoOf(buf);
    if (p) return { w: p.w, h: p.h, fmt: 'PNG' };
    if (!buf || buf.length < 20) return null;
    const a = buf;
    // GIF：'GIF87a'/'GIF89a' + 宽高是 little-endian 的 2 字节
    if (a.slice(0, 3).toString('ascii') === 'GIF') {
      return { w: a.readUInt16LE(6), h: a.readUInt16LE(8), fmt: 'GIF' };
    }
    // WebP：RIFF....WEBP 之后按块类型取
    if (a.slice(0, 4).toString('ascii') === 'RIFF' && a.slice(8, 12).toString('ascii') === 'WEBP') {
      const t = a.slice(12, 16).toString('ascii');
      if (t === 'VP8X') {
        const w = 1 + (a[24] | (a[25] << 8) | (a[26] << 16));
        const h = 1 + (a[27] | (a[28] << 8) | (a[29] << 16));
        return { w, h, fmt: 'WEBP' };
      }
      if (t === 'VP8 ') {
        return { w: a.readUInt16LE(26) & 0x3fff, h: a.readUInt16LE(28) & 0x3fff, fmt: 'WEBP' };
      }
      if (t === 'VP8L') {
        const b = a.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, fmt: 'WEBP' };
      }
      return null;
    }
    // JPEG：扫 SOF0/1/2/3/5/6/7/9/10/11/13/14/15 段里的高宽
    if (a[0] === 0xFF && a[1] === 0xD8) {
      let i = 2;
      while (i + 9 < a.length) {
        if (a[i] !== 0xFF) { i++; continue; }
        const m = a[i + 1];
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
        const len = a.readUInt16BE(i + 2);
        const isSOF = (m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7)
          || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF);
        if (isSOF) return { h: a.readUInt16BE(i + 5), w: a.readUInt16BE(i + 7), fmt: 'JPEG' };
        i += 2 + len;
      }
      return null;
    }
    return null;
  } catch { return null; }
}

/**
 * 压一份字节。返回 `{ buf, changed, why, engine }`（**永不抛**）
 * @param {Buffer} buf
 * @param {object} opt  { maxEdge, minBytes, minGain, maxColors, maxFrames, quality,
 *                        pyPath, script, timeoutMs }
 * @param {string} cacheKey 图库 id 之类（PNG 引擎用；给了就缓存）
 */
function shrink(buf, opt = {}, cacheKey = '') {
  const done = (b, changed, why, engine) => ({ buf: b, changed, why, engine });
  try {
    if (!buf || !buf.length) return done(buf, false, '空字节', 'none');
    const maxEdge = Number(opt.maxEdge) > 0 ? Number(opt.maxEdge) : COMMON_EDGE;
    const minBytes = Number(opt.minBytes) > 0 ? Number(opt.minBytes) : 200 * 1024;
    const d = dimsOf(buf);
    const longEdge = d ? Math.max(d.w, d.h) : 0;
    // 🔴 **像素优先**：长边超了就必须压（用户说的"大图"是显示尺寸，不是字节）
    const tooBigPixels = longEdge > maxEdge;
    if (!tooBigPixels && buf.length < minBytes) {
      return done(buf, false, `${d ? d.w + 'x' + d.h + ' ' : ''}${(buf.length / 1024).toFixed(0)}KB 已经够小`, 'none');
    }

    // ① PNG 走 Node（零依赖、最快、量化最狠）
    if (d && d.fmt === 'PNG') {
      const r = require('./imgcompress').shrink(buf, { ...opt, maxEdge, minBytes: tooBigPixels ? 0 : minBytes }, cacheKey);
      return done(r.buf, r.changed, r.why, 'node-png');
    }
    // ② 其它格式走 Pillow（GIF 保持动图）
    const py = String(opt.pyPath || PY_DEFAULT);
    const script = String(opt.script || SCRIPT_DEFAULT);
    if (!fs.existsSync(py)) return done(buf, false, `没有 python（${py}）`, 'none');
    if (!fs.existsSync(script)) return done(buf, false, `没有压缩脚本（${script}）`, 'none');

    ensureTmp();
    const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const src = path.join(TMP, `in-${stamp}`);
    const dst = path.join(TMP, `out-${stamp}`);
    fs.writeFileSync(src, buf);
    const args = [script, '--in', src, '--out', dst,
      '--max-edge', String(maxEdge),
      '--max-frames', String(Number(opt.maxFrames) > 0 ? Number(opt.maxFrames) : 40),
      '--max-colors', String(Number(opt.maxColors) > 0 ? Number(opt.maxColors) : 128),
      '--quality', String(Number(opt.quality) > 0 ? Number(opt.quality) : 82)];
    const r = spawnSync(py, args, {
      encoding: 'utf8',
      timeout: Number(opt.timeoutMs) > 0 ? Number(opt.timeoutMs) : 20000,
    });
    const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').pop() || '';
    let res;
    if (r.status === 0 && fs.existsSync(dst)) {
      const small = fs.readFileSync(dst);
      const minGain = Number(opt.minGain) > 0 ? Number(opt.minGain) : 0.2;
      const gain = 1 - small.length / buf.length;
      res = gain >= minGain
        ? done(small, true, `${(buf.length / 1024).toFixed(0)}KB → ${(small.length / 1024).toFixed(0)}KB`
          + `（省 ${(gain * 100).toFixed(0)}%）`, 'pillow')
        : done(buf, false, `压了也只省 ${(gain * 100).toFixed(0)}%（< ${(minGain * 100).toFixed(0)}%）`, 'none');
    } else {
      res = done(buf, false, `压缩脚本没成功（exit=${r.status}${out ? '：' + out.slice(0, 120) : ''}）`, 'none');
    }
    try { fs.unlinkSync(src); } catch { /* 忽略 */ }
    try { fs.unlinkSync(dst); } catch { /* 忽略 */ }
    return res;
  } catch (e) {
    return done(buf, false, `压缩异常（已忽略）：${e.message || e}`, 'none');
  }
}

const TMP = path.join(os.tmpdir(), 'xiaolanjing-shrink');
function ensureTmp() { try { fs.mkdirSync(TMP, { recursive: true }); } catch { /* 忽略 */ } }

module.exports = { shrink, dimsOf, PY_DEFAULT, SCRIPT_DEFAULT, COMMON_EDGE, _tmpDir: () => TMP };
