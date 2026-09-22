// ============================================================
//  识图：把群里的图片 / 表情包变成一句可读的话，接进正常对话流程
//
//  用户需求（2026-09-22）：「给 bot 增加识图功能，不然发表情包他都看不懂」
//
//  🔑 下面这几条都是**实测结论**，别重复踩（都是先踩了才写下来的）：
//
//  1. QQ 推图片来的时候 **message_type 是 0**，不是 1！
//     图片在 `attachments[]` 里：
//       {content_type, filename, width, height, size, url}
//     ⚠️ 旧版把它当"空消息"直接扔了（线上日志里就是 `不回（空消息）`），
//        所以群友发多少表情包机器人都毫无反应。
//     历史事件统计：image/jpeg ×131、image/gif ×59、image/png ×19。
//
//  2. 那个 URL 长这样：
//       https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=...&rkey=...
//     · **裸 GET 就能下载**（实测不需要任何 header / UA / Referer）
//     · 长度约 250 字符（模型侧上限 8192，够用）
//     · 🔴 **`rkey` 有时效** → 收到消息必须**立刻**下载，
//       不能排队、不能缓存、不能"等一会儿再说"（社区里"图片地址过期"的
//       问题就是这个，见 AstrBot issue #1004）
//
//  3. **模型不用换**：现有的 `deepseek-flash` 本身就支持图片输入 ——
//     旧的 `deepseek-v4-flash-vision-exp` 已下线，它的请求由最新 Flash 承接。
//     所以 **同一个 key、同一个 baseUrl、同一个模型名**，零新增依赖、
//     零新增凭证，也天然不会触发"跨服务商误配"那个坑。
//     （官方文档：https://api-docs.deepseek.com/zh-cn/guides/vision）
//
//  4. 成本：一张图 ≈ 220 token（`detail: 'low'` 会缩到 512×512），
//     输出 40~70 token。合计**约 ¥0.0004/张** —— 基本等于免费。
//     实测单张耗时 1.1 ~ 1.6 秒。
//
//  5. ⚠️ **`filename` 的后缀会骗人**：实测有个 `xxx.jpg` 实际内容是 GIF
//     （content_type 也写着 image/gif、magic 是 474946）。
//     DeepSeek 是按**字节**判格式的所以能容错，但我们仍按 magic 嗅探一次，
//     免得把一个 GIF 当 JPEG 报上去。
//
//  6. ⚠️ 图片**只能放在 `user` 消息里**，塞进 `system`/`assistant` 会 400。
// ============================================================
const cfg = require('./config');
const qqmedia = require('./qqmedia');
const brain = require('./brain');

// ---------- 格式嗅探（按字节，不信 filename）----------
function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG') return 'image/png';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return '';
}

// ---------- 从一条消息里找出图片 ----------
// 两个地方都要看：
//   · `attachments[]` —— 普通图片/表情包走这里（实测）
//   · `msg_elements[]` —— 引用消息(103)里的图可能走这里
// 返回第一张，够用了：一条消息多图时描述一张即可，免得一条消息烧好几次钱。
function findImage(msg) {
  if (!cfg.policy.vision?.enabled || !msg) return null;

  const cands = [];
  for (const a of (Array.isArray(msg.attachments) ? msg.attachments : [])) cands.push(a);
  for (const e of (Array.isArray(msg.msg_elements) ? msg.msg_elements : [])) cands.push(e);

  for (const a of cands) {
    if (!a) continue;
    const ct = String(a.content_type || '');
    if (!/^image\//.test(ct)) continue;                       // 视频/文件/合并转发都不管
    // url 优先；有些形态把地址放在 content 里，也认（下面会校验是 http 开头）
    let url = String(a.url || '');
    if (!/^https?:\/\//i.test(url)) {
      url = /^https?:\/\//i.test(String(a.content || '')) ? String(a.content) : '';
    }
    if (!url) continue;
    return {
      url,
      contentType: ct,
      width: Number(a.width) || 0,
      height: Number(a.height) || 0,
      size: Number(a.size) || 0,
      filename: String(a.filename || ''),
    };
  }
  return null;
}

// 这条消息带没带图（不看开关，纯看数据）—— 给 brain.isMentionOnly 用
function hasImage(msg) {
  const cands = [
    ...(Array.isArray(msg?.attachments) ? msg.attachments : []),
    ...(Array.isArray(msg?.msg_elements) ? msg.msg_elements : []),
  ];
  return cands.some((a) => a && /^image\//.test(String(a.content_type || '')));
}

// ---------- 限流 ----------
//
// 为什么识图要**自己一套**限流，不共用 brain 的 dailyCallLimit：
//   · 图片/表情包是**高频**消息（群里动不动连发一串），
//     而 dailyCallLimit(800) 是给"真的要回话"留的。
//     不隔离的话，一波表情包就能把当天的聊天额度烧光。
//   · 所以这里默认 300 张/天，先把识图**单独**刹住。
//   · ⚠️ 但识图的模型调用**仍然会计入** brain 的 callCount 和 budget ——
//     那不是重复限制，是应该的：钱是真的花了。
const lastAt = new Map();     // scope -> ts
let visionDay = '';
let visionCount = 0;

function beijingToday() {
  const d = new Date();
  const bj = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  return `${bj.getFullYear()}-${bj.getMonth() + 1}-${bj.getDate()}`;
}

function visionAllowed(scope) {
  const v = cfg.policy.vision || {};
  if (!v.enabled) return { ok: false, why: '识图已关闭' };
  if (brain.inQuietHours()) return { ok: false, why: '静默时段' };

  const today = beijingToday();
  if (today !== visionDay) { visionDay = today; visionCount = 0; }
  if (visionCount >= (v.dailyLimit || 300)) {
    return { ok: false, why: `今日识图已达上限(${v.dailyLimit})` };
  }

  const gap = v.cooldownMs ?? 2000;
  const last = lastAt.get(scope) || 0;
  if (Date.now() - last < gap) {
    return { ok: false, why: `同群识图冷却中(${Math.round((gap - (Date.now() - last)) / 1000)}s)` };
  }
  return { ok: true };
}

function markVision(scope) {
  lastAt.set(scope, Date.now());
  visionCount++;
}

// 每 5 分钟清一次冷却表，防内存涨（和 linkparse 一样的做法）
setInterval(() => {
  const now = Date.now();
  const max = Math.max(cfg.policy.vision?.cooldownMs || 2000, 60 * 1000) * 2;
  for (const [k, t] of lastAt) if (now - t > max) lastAt.delete(k);
}, 5 * 60 * 1000).unref();

// ---------- 图片索引缓存（专门解决「引用图片 + @机器人」）----------
//
// 🔴 为什么需要（2026-09-22 用户真机踩到，线上日志原样是）：
//
//     [群] GROUP_MESSAGE_CREATE | spaceyee: (无文本内容)
//       ├ message_type=103 mentions=[{... "is_you":true ...}]
//       └ 只有@没有内容 → 回固定应答
//     [send:group] ✓ 咋了
//
//   「引用一张图 + @机器人」时，QQ 推来的消息是：
//     · message_type = 103（引用消息）
//     · content      = `<@机器人>`（**只有 @ 标记**）
//     · msg_elements = 空     ← 被引用的是**图片**，没有文字可给我们
//     · attachments  = **无** ← 🔴 **被引用的图片附件根本不给**
//     · message_scene.ext = ["ref_msg_idx=REFIDX_xxx", "msg_idx=REFIDX_yyy", ...]
//   于是 extractText 得到空串 → 被判成"只有@没内容" → 回一句固定的「咋了」，
//   图完全白看了。
//
// ✅ 但 QQ **给了 `ref_msg_idx`** —— 那就是被引用那条消息的 `msg_idx`。
//    而**每条正常消息**的 `message_scene.ext` 里都有它自己的 `msg_idx`。
//    所以：收到图时就把它自己的 `msg_idx` + 描述一起记下来，
//    之后有人引用它，用 `ref_msg_idx` 就能查回来。
//
//    💡 比"重新下载那张图"更好：不用管 rkey 过期，也不重复花钱
//       （描述在收到图的那一刻就已经算好了）。
//
// 另外再兜一层 `LAST_IMG`：**刚发过图、紧接着只 @ 它**（图和 @ 分成两条消息发）
// 这种在手机 QQ 上很常见的操作，也能用上那张图的描述，而不是回「咋了」。
const IMG_CACHE = new Map();     // `${scope}|${msg_idx}` -> { desc, ts }
const LAST_IMG = new Map();      // scope -> { desc, ts }
const IMG_CACHE_MAX = 500;       // 防内存涨

// message_scene.ext 是个 `["key=value", ...]` 的数组，转成对象
function extMap(d) {
  const out = {};
  const arr = (d && d.message_scene && d.message_scene.ext) || [];
  for (const s of arr) {
    const i = String(s).indexOf('=');
    if (i > 0) out[String(s).slice(0, i)] = String(s).slice(i + 1);
  }
  return out;
}

// 这条消息自己的编号（记图时用）
const msgIdxOf = (d) => extMap(d).msg_idx || '';
// 这条消息**引用**的那条消息的编号（找图时用）
const refIdxOf = (d) => extMap(d).ref_msg_idx || '';

function rememberImage(scope, idx, desc) {
  if (!desc) return;
  const now = Date.now();
  if (idx) IMG_CACHE.set(`${scope}|${idx}`, { desc, ts: now });
  LAST_IMG.set(scope, { desc, ts: now });
  // 超量就丢最早的（Map 保持插入顺序）
  if (IMG_CACHE.size > IMG_CACHE_MAX) {
    for (const k of IMG_CACHE.keys()) {
      IMG_CACHE.delete(k);
      if (IMG_CACHE.size <= IMG_CACHE_MAX) break;
    }
  }
}

// 按 msg_idx 查（用于"引用的是一条图片消息"）
function getImageDesc(scope, idx, withinMs) {
  const hit = IMG_CACHE.get(`${scope}|${idx}`);
  if (!hit) return '';
  if (withinMs && Date.now() - hit.ts > withinMs) return '';
  return hit.desc;
}

// 查这个群最近描述过的图（用于"刚发过图 + 只 @ 了它"）
function recentImageDesc(scope, withinMs) {
  const hit = LAST_IMG.get(scope);
  if (!hit) return '';
  return (Date.now() - hit.ts > withinMs) ? '' : hit.desc;
}

// 定期清理，防内存涨（和上面两个限流表一样的做法）
setInterval(() => {
  const v = cfg.policy.vision || {};
  const now = Date.now();
  const keep = Math.max(v.imageCacheMs || 600000, v.recentImageMs || 30000);
  for (const [k, x] of IMG_CACHE) if (now - x.ts > keep) IMG_CACHE.delete(k);
  for (const [k, x] of LAST_IMG) if (now - x.ts > keep) LAST_IMG.delete(k);
}, 60 * 1000).unref();

// ---------- 真正的识图 ----------
//
// 返回一句中文描述；任何失败都**抛异常**，由调用方决定要不要吞掉。
// （⚠️ 故意不在这里 return '' —— 调用方需要区分"识别失败"和"识别出来是空"，
//   前者该打日志，后者才该静默。）
async function describe(img, log = () => {}) {
  const v = cfg.policy.vision || {};
  const maxBytes = (v.maxMB || 8) * 1024 * 1024;

  // ① 立刻下载（rkey 有时效！）
  const buf = await qqmedia.downloadToBuffer(img.url, {
    maxBytes,
    timeoutMs: v.downloadTimeoutMs || 20000,
  });

  // ② 按**字节**判真实格式（filename 会骗人，见文件头注释第 5 条）
  const mime = sniffMime(buf) || (/^image\//.test(img.contentType) ? img.contentType : '');
  if (!mime) throw new Error(`不是可识别的图片（文件头 ${buf.slice(0, 4).toString('hex')}）`);

  log(`下载 OK ${(buf.length / 1024).toFixed(0)}KB · ${mime}`
    + (img.width && img.height ? ` · ${img.width}×${img.height}` : ''));

  // ③ 交给模型（复用 brain 的重试 / 预算 / 记账 / 超时那一整套）
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const t0 = Date.now();
  const desc = await brain.describeImage(dataUrl, v.maxTokens || 200);
  log(`模型返回（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return String(desc || '').trim();
}

module.exports = {
  findImage,
  hasImage,
  describe,
  visionAllowed,
  markVision,
  sniffMime,
  // 🆕 图片索引缓存（「引用图片 + @机器人」靠它）
  msgIdxOf,
  refIdxOf,
  rememberImage,
  getImageDesc,
  recentImageDesc,
  // 给自测用
  _beijingToday: beijingToday,
  _extMap: extMap,
};
