// ============================================================
//  submit.js —— 群友投稿表情包 / 图片（2026-10-15 用户需求）
//
//  📝 用户原话：
//    「群用户先发一张表情包or图片，然后引用该图片并发送 #tg，自动将该图片or表情包
//      上传后台待确认列表里。注意冷却，每个群都是5分钟，当在冷却期间上传时，返回：
//      冷却中 剩余几分钟。带#tg但是上传格式不对的不回复」
//
//  ⇒ 语义（四条，别改着改着跑偏）：
//    ① **引用一张图 + 发 `#tg`** ⇒ 把那张图的字节下载下来，交给 `imglib.add()` 存成
//       **待确认**（status=pending）—— 和面板上传走的是**同一条入库链路**，
//       所以在面板「图库」页的「待确认」区就能看到、点「用」才真正入库。
//       ⚠️ 投稿**不调模型**？不 —— `imglib.add()` 内部会让 AI 说一句理解（约 ¥0.0005），
//          那是"待确认列表里能看到这张图是什么"的必要信息，用户要的就是这个。
//    ② **冷却按群、5 分钟**（`cooldownMs`）：冷却期间再来一次 ⇒ 回「冷却中 剩余 N 分钟」。
//       ⚠️ 冷却**只在"确实带了图"时记录** —— 群友打错个字（`#tg` 后面没图）不该把
//          整群锁 5 分钟。这是"用户没明说但显然该这样"的一处：宁可少挡，别误伤。
//    ③ **格式不对不回复**：光杆 `#tg`、`#tg 你好`（没引用图）、引用的不是图 ⇒ 一个字都不回，
//       只留一行日志（和别的"非法指令"一个待遇：不认识的指令直接静默）。
//    ④ 图片**太大**也归"格式不对"（`maxMB`，默认 16，和图库上限一致）⇒ 同样不回。
//       ⚠️ 文案已经写好放在 config 里（`oversizeTexts`），想改成"回一句"只需一行。
//
//  ── 为什么单独一个模块 ──
//  · 和 `repeat.js` 一样是**确定性指令**（正则命中就执行），和"要不要接话"无关；
//  · 它需要 `vision`（图片索引缓存）+ `imglib`（入库）+ `qqmedia`（下载）三样，
//    塞进 `commands.js` 会让那个"0 次网络"的模块多背一层。
//
//  ── 🔴 三条平台事实（决定了它只能这么做）──
//  ① 引用消息(103) 里 **QQ 不给被引用那条的附件**，只给 `ref_msg_idx`
//     ⇒ 必须靠收到图时存下的「msg_idx → 图片地址」小表反查（见 vision.rememberImage）。
//  ② 图片地址带 rkey、**几小时就失效** ⇒ 收到就下、不能排队（同识图那条纪律）。
//  ③ `#tg` 是**我们自己**的指令，必须在 `commands.looksForeign()` 之前认掉，
//     否则"井号开头的英文指令"那条规则会把它当"别的 bot 的指令"静默掉。
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;

function SC() {
  try { return (require('./config').policy || {}).submit || {}; } catch { return {}; }
}

function pick(arr, fallback) {
  const a = (Array.isArray(arr) && arr.length) ? arr : fallback;
  return String(a[Math.floor(Math.random() * a.length)]);
}
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : vars[k]));

// 指令前缀：`#tg` / `＃tg`（全角井号），大小写不敏感；后面必须是结尾或空白。
// ⚠️ 和 commands.js 里别的指令正则同一套写法，别各写一份导致"有的能容错有的不能"。
const TG_RE = /^[#＃](?:tg|投稿)(?=$|[\s\u3000])/i;

function isCommand(raw) {
  return TG_RE.test(String(raw || '').replace(/[\u3000\s]+/g, ' ').trim());
}

// 冷却：scope -> 上次**真的收到图**的时刻（按群，不按人 —— 用户明确"每个群都是5分钟"）
const lastAt = new Map();

// 🆕 2026-10-16 用户要求：「主人没有冷却」。
//    ⚠️ 和"图库发图冷却 / @ 限流"那几处**同一个语义**（`ownerBypass*`）：主人调试时
//       连着投几张是常态，被自己的闸挡住最难受。**判定只走 `brain.isOwner` 一处**，
//       别在这儿再写一份 openid 比较（那种两份判定迟早漂移）。
function isOwner(d) {
  try { return require('./brain').isOwner(d) === true; } catch { return false; }
}

// 返回 null（可以继续）或 { text, why }（冷却中，要把这句话回出去）
// bypass=true（主人）⇒ 直接放行，不写冷却表也不拦（和 imglib 的 ownerBypass 一致）
function cooldownState(scope, now = Date.now(), bypass = false) {
  if (bypass) return null;
  const cd = Number(SC().cooldownMs);
  if (!(cd > 0)) return null;
  const last = lastAt.get(scope) || 0;
  const left = cd - (now - last);
  if (last && left > 0) {
    // 不足 1 分钟也报 1 分钟 —— 用户要的是"剩余几分钟"，报 0 分钟反而奇怪
    const min = Math.max(1, Math.ceil(left / 60000));
    const tpl = pick(SC().coolingTexts, ['冷却中 剩余 {min} 分钟']);
    return { text: fill(tpl, { min }), why: `本群投稿冷却中（剩 ${Math.round(left / 1000)}s）` };
  }
  return null;
}

// 🔴 只在"真的拿到图、要入库了"的时候调它（见文件头 ②）
// ⚠️ 主人**不记**冷却（他连投几张之后，普通群员的 5 分钟窗不该被他的调试投喂占用）
function mark(scope, now = Date.now(), bypass = false) {
  if (bypass) return;
  lastAt.set(scope, now);
}

// ---------- 找图：这条 `#tg` 指的是哪张图？----------
//
// 三条来源，按可信度排序：
//  ① 引用了一张图（`ref_msg_idx` 能反查到地址）—— 用户需求里的正路
//  ② **本条消息自己带了图**（有人把图和 `#tg` 发在同一条，也认）
//  ③ 本群**刚刚**发过图（`recentImageMs` 内）—— 手机上手快，"图 + 指令"分两条发
//
// 返回 `{ url, source }` 或 null。
function findTargetImage(scope, d, vision, log) {
  const s = SC();
  const within = Number(s.recentImageMs) > 0 ? Number(s.recentImageMs) : 120000;

  const ref = vision.refIdxOf(d);
  if (ref) {
    const hit = vision.getImage(scope, ref, 0);
    if (hit && hit.url) return { url: hit.url, source: '引用', desc: hit.desc || '' };
    log && log('引用的那条没在我们的图片索引里（可能是机器人启动前的图）');
  }

  const own = vision.findImage ? vision.findImage(d) : null;
  if (own && own.url) return { url: own.url, source: '本条自带', desc: '' };

  const recent = vision.recentImage(scope, within);
  if (recent && recent.url) return { url: recent.url, source: '本群最近一张', desc: recent.desc || '' };

  return null;
}

// ---------- 主入口 ----------
//
// 返回 null（不是我们的指令 / 格式不对 ⇒ 调用方继续走原流程或静默）
// 或 `{ text }`（要把这句话回出去）
//
// ⚠️ 调用方（index.js）负责**发消息**，这里不碰网络发送 —— 和 commands.js 一个分工。
async function handle(scope, d, opts = {}) {
  const log = opts.log || (() => {});
  const vision = opts.vision || require('./vision');
  const sc = SC();
  if (sc.enabled === false) return null;

  const raw = String(d?.content || '').replace(/[\u3000\s]+/g, ' ').trim();
  if (!isCommand(raw)) return null;

  // ② 格式不对（没图 / 引用的不是图）⇒ **一个字都不回**（用户明确要求）
  const target = findTargetImage(scope, d, vision, log);
  if (!target) {
    log('带 #tg 但没找到图（既没引用图、本条也没带图）→ 不回（格式不对）');
    return { silent: true, why: '#tg 没带图（按规则不回）' };
  }

  // 🆕 2026-10-16 用户要求：「主人没有冷却」
  const owner = isOwner(d);

  // 冷却检查：**在下载之前**（省一次下载）
  const cool = cooldownState(scope, Date.now(), owner);
  if (cool) {
    log(`投稿冷却中（${cool.why}）→ 回剩余时间`);
    return { text: cool.text, silent: false, why: cool.why };
  }

  const maxMB = Number(sc.maxMB) > 0 ? Number(sc.maxMB) : 16;
  const maxBytes = maxMB * 1024 * 1024;
  const qqmedia = opts.qqmedia || require('./qqmedia');
  const imglib = opts.imglib || require('./imglib');

  let buf;
  try {
    buf = await qqmedia.downloadToBuffer(target.url, {
      maxBytes,
      timeoutMs: Number(sc.downloadTimeoutMs) > 0 ? Number(sc.downloadTimeoutMs) : 20000,
    });
  } catch (e) {
    const why = String(e?.message || e);
    // 太大 = 格式不对 ⇒ 不回（文案留着，想改成"回一句"把它接上就行）
    if (/过大|too large|maxBytes/i.test(why)) {
      log(`投稿图太大（${why}）→ 不回（按格式不对处理）`);
      return { silent: true, why: `投稿图超过 ${maxMB}MB（按规则不回）：${why}` };
    }
    log(`投稿下载失败：${why}`);
    return { silent: true, why: '投稿下载失败（不回）：' + why };
  }

  log(`投稿取图 OK（${target.source}）：${(buf.length / 1024).toFixed(0)}KB`);

  let r;
  const t0 = Date.now();
  try {
    r = await imglib.add(buf, { name: String(sc.name || '群友投稿') }, (m) => log(m));
  } catch (e) {
    log(`投稿入库异常：${e?.message || e}`);
    return { silent: true, why: '投稿入库异常（不回）' };
  }
  if (!r || !r.ok) {
    // 失败分两种，**别混**（2026-10-15 用户要求「上传非图片 or 格式不对不理会」）：
    //   · 格式不对（不是图片 / 空文件 / 超过大小上限，imglib 打了 `silent`）⇒ **一个字都不回**；
    //   · 我们这边出故障（图库满 / 写文件失败）⇒ **必须回一句**，
    //     否则群友以为投稿成功了，而面板待确认里根本没有这张。
    if (r && r.silent) {
      log(`投稿被拒（${r.why}）→ 不回（按"格式不对"处理）`);
      return { silent: true, why: `格式不对：${r.why}（按规则不回）` };
    }
    const tpl = pick(sc.failTexts, ['这张没存下来（{why}），等会儿再试试。']);
    log(`投稿失败：${r && r.why}`);
    return { text: fill(tpl, { why: (r && r.why) || '未知原因' }) };
  }

  // 到这里才算"真的收到了一张图" ⇒ 记冷却（**主人不记**：见 mark 的注释）
  mark(scope, Date.now(), owner);

  const dup = !!r.dup;
  const tpl = dup
    ? pick(sc.dupTexts, ['这张图库里已经有啦，不用再投一遍。'])
    : pick(sc.okTexts, ['收到！已放进待确认列表，主人确认后就能用了。']);
  const desc = String(r.item?.desc || '').trim();
  log(`投稿${dup ? '（重复）' : '成功'}：${r.item?.id || '?'}`
    + `${desc ? ` · AI 理解：${desc}` : ' · （AI 没给出理解）'}`
    + ` · 入库耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  // ⚠️ 回话里**不带 id、不带文件名**（群友不需要，也少一处会变的文案）
  return { text: tpl, dup, id: r.item?.id || '' };
}

module.exports = {
  isCommand,
  handle,
  cooldownState,
  findTargetImage,
  _mark: mark,
  _reset: () => lastAt.clear(),
  _TG_RE: TG_RE,
};
