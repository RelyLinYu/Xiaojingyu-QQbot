// ============================================================
//  imglib.js —— Bot 图库（2026-10-13 用户需求）
//
//  📝 用户原话：「我想给机器人添加发图的功能……在后台单开一个界面来上传图片，
//     一次可以上传多张图，上传完成之后先反馈 ai 对每张图的理解，
//     等我确认无误之后再正式添加到 bot 图库，自动在适合情景从图库发相关的图片」
//     决策：① 触发方式 = **C 混合**（关键词兜底 + AI 主动挑）
//           ② 频率 = 同群 **5 分钟**一张、**不设每日上限**（用户明确"允许插图"）
//           ③ 图存**服务器**（本地不留副本）⇒ 落在 data/img-lib/，被 .gitignore 挡住，
//              **不进 GitHub**（用户明确要求这个功能不要上传）
//           ④ 先只在**测试群**生效
//
//  ── 关键设计（都是被项目里踩过的坑逼出来的）──
//  · **图必须存在本地**：QQ 给的图片地址带 rkey、几小时就失效，存 URL 等于没存。
//  · **md5 去重**：同一张图重复上传不出两份（也顺手省掉重复的 AI 描述调用）。
//  · **描述用字节重新识别**：不收「上传时浏览器说的 MIME」，按文件头判（filename 会骗人），
//    动图复用 gif.js 抽样拼网格那套（视觉 API 只认第一帧）。
//  · **写入原子 + 改前备份**，和其他落盘模块同一套；`XLJ_NO_PERSIST=1` 时只动内存。
//  · 图库**按群隔离**由调用方保证（本模块只管存和取，不管什么时候发）。
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const DIR = path.join(DATA_DIR, 'img-lib');
const FILE = path.join(DIR, 'index.json');

const MAX_ITEMS = 300;                    // 上限（防手滑传几千张）
const MAX_BYTES = 16 * 1024 * 1024;       // 单张上限 16MB（QQ 图片富媒体软限制比这个宽松）
const MAX_DESC = 200;

let cache = null;
let cacheRaw = '';

// ---------- 索引读写 ----------
function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 忽略 */ }
}

function read() {
  if (process.env.XLJ_NO_PERSIST === '1') return cache || (cache = { items: [] });
  let txt;
  try { txt = fs.readFileSync(FILE, 'utf8'); } catch { return { items: [] }; }
  if (cache && txt === cacheRaw) return cache;
  try {
    const o = JSON.parse(txt);
    cache = { items: Array.isArray(o && o.items) ? o.items : [] };
    cacheRaw = txt;
    return cache;
  } catch {
    return { items: [] };          // 坏了当空，绝不让机器人或面板起不来
  }
}

function write(items) {
  if (process.env.XLJ_NO_PERSIST === '1') { cache = { items }; cacheRaw = ''; return { ok: true, persisted: false }; }
  try {
    ensureDir();
    if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* 备份失败不拦 */ } }
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
    cache = { items }; cacheRaw = fs.readFileSync(FILE, 'utf8');
    return { ok: true, persisted: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

function newId() {
  return 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

// ---------- 图片判别（按字节，不看文件名）----------
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

function sniff(buf) {
  try {
    const vision = require('./vision');
    if (typeof vision.sniffMime === 'function') {
      const m = vision.sniffMime(buf);
      if (m && EXT[m]) return m;
    }
  } catch { /* vision 读不到就退回自己判 */ }
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF'
    && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length > 6 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return '';
}

function md5(buf) {
  try { return require('./qqmedia')._md5(buf); } catch { return ''; }
}

// ---------- AI 描述 ----------
//
// ⚠️ 不走 `vision.describe()`：那个函数的第一件事是"按 URL 下载 + 立刻就下"，
//    我们是**本地已有字节**，走它会白下载一次、还依赖 QQ 那个带 rkey 的地址。
//    这里自己拼 dataURL 调 `brain.describeImage`（重试/预算/记账/超时都是现成的），
//    动图则复用 gif.js 抽样拼网格（视觉 API 只认第一帧）。
async function describeBuffer(buf, mime, log = () => {}) {
  const cfg = require('./config');
  const v = cfg.policy.vision || {};

  let sendBuf = buf;
  let sendMime = mime;
  // 🆕 2026-10-13：入库描述也接上「认出这是它自己的二创」（和识图共用 `v.selfHint` 一份）
  const selfHint = String(v.selfHint || '');
  let prompt = (v.libraryPrompt
    || '这是要放进机器人表情包图库的一张图。用一句中文说清：①画的是什么 ②什么情绪/什么场合发合适。别超过 40 字。')
    + selfHint;
  let note = '';

  if (mime === 'image/gif') {
    try {
      const gif = require('./gif');
      const gi = gif.info(buf);
      if (gi && gi.animated && gi.frames >= 2) {
        const m = gif.montage(buf, { maxFrames: v.gifFrames || 4 });
        if (m) {
          sendBuf = m.png;
          sendMime = 'image/png';
          prompt = String(v.gifLibraryPrompt
            || '这是一个动图按时间顺序抽取的 {n} 帧（从左到右、从上到下）。用一句中文说清：①这个动图在做什么 ②什么情绪/场合发合适。别超过 40 字。')
            .replace('{n}', String(m.frames.length)) + selfHint;
          note = ` · 动图 ${gi.frames} 帧 → 采样 ${m.frames.length} 帧拼成一张`;
        }
      } else if (gi) {
        note = ` · GIF ${gi.frames} 帧（静态）`;
      }
    } catch { /* 动图处理失败就按原图发 */ }
  }

  log(`喂给模型 ${(sendBuf.length / 1024).toFixed(0)}KB · ${sendMime}${note}`);
  const dataUrl = `data:${sendMime};base64,${sendBuf.toString('base64')}`;
  const brain = require('./brain');
  const t0 = Date.now();
  const desc = await brain.describeImage(dataUrl, v.libraryMaxTokens || 160, prompt);
  log(`模型返回（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  // 🆕 2026-10-14 晚：和识图**共用同一份**"无依据的「这是你自己」"兜底（vision.stripBaselessSelfTag）。
  //    ⚠️ 别在这里再写一份正则 —— 两处迟早漂移（这个项目已经吃过好几次这种亏）。
  let clean = String(desc || '').trim();
  try {
    const vision = require('./vision');
    if (typeof vision.stripBaselessSelfTag === 'function') clean = vision.stripBaselessSelfTag(clean);
  } catch { /* vision 读不到就原样返回 */ }
  return { desc: clean.slice(0, MAX_DESC), gifNote: note };
}

// ---------- 对外：加一张图（上传 → 待确认）----------
//
// 返回 { ok, item } 或 { ok:false, why }；重复的图直接回已存在的那张（不重复存、不再调模型）
async function add(buf, opts = {}, log = () => {}) {
  if (!buf || !buf.length) return { ok: false, why: '空文件' };
  if (buf.length > (opts.maxBytes || MAX_BYTES)) {
    return { ok: false, why: `图太大（${(buf.length / 1048576).toFixed(1)}MB > ${((opts.maxBytes || MAX_BYTES) / 1048576).toFixed(0)}MB）` };
  }
  const mime = sniff(buf);
  if (!mime) return { ok: false, why: '不是可识别的图片（只支持 png / jpg / webp / gif）' };

  const hash = md5(buf);
  const items = read().items.slice();
  if (hash) {
    const dup = items.find((x) => x.hash === hash && x.status !== 'rejected');
    if (dup) {
      log(`和图库里已有的「${dup.desc || dup.id}」是同一张（md5 相同）→ 不重复添加`);
      return { ok: true, item: dup, dup: true };
    }
  }
  if (items.filter((x) => x.status !== 'rejected').length >= MAX_ITEMS) {
    return { ok: false, why: `图库满了（${MAX_ITEMS} 张），先去页面删几张` };
  }

  const id = newId();
  const filename = id + (EXT[mime] || '.bin');
  let desc = '';
  try {
    const r = await describeBuffer(buf, mime, log);
    desc = r.desc;
  } catch (e) {
    // 识别失败**不拦**：先存进来、把原因记下，用户在页面上能看到、也能自己补描述
    log(`AI 描述失败：${e.message}（图仍然存下来，等你手动补描述）`);
    desc = '';
  }

  const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const item = {
    id, filename, mime, bytes: buf.length, hash,
    desc, name: String(opts.name || '').slice(0, 40),
    status: 'pending',                 // pending=等确认 / approved=已入库 / rejected=弃用
    createdAt: at, updatedAt: at,
    used: 0, lastUsedAt: '',
  };

  if (process.env.XLJ_NO_PERSIST !== '1') {
    ensureDir();
    try { fs.writeFileSync(path.join(DIR, filename), buf); } catch (e) {
      return { ok: false, why: '写文件失败：' + e.message };
    }
  }
  items.push(item);
  const w = write(items);
  if (w.ok === false) return { ok: false, why: '写索引失败：' + w.why };
  log(`已存下 ${filename}（${(buf.length / 1024).toFixed(0)}KB）· 状态=待确认`);
  return { ok: true, item };
}

// ---------- 对外：确认 / 弃用 / 删除 / 改描述 ----------
function setStatus(id, status) {
  const ok = ['approved', 'rejected', 'pending'];
  if (!ok.includes(status)) return { ok: false, why: '未知状态' };
  const items = read().items.slice();
  const it = items.find((x) => x.id === id);
  if (!it) return { ok: false, why: '找不到这张图' };
  it.status = status;
  it.updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const w = write(items);
  return w.ok === false ? { ok: false, why: w.why } : { ok: true, item: it };
}

function update(id, patch = {}) {
  const items = read().items.slice();
  const it = items.find((x) => x.id === id);
  if (!it) return { ok: false, why: '找不到这张图' };
  if (typeof patch.desc === 'string') it.desc = patch.desc.slice(0, MAX_DESC);
  if (typeof patch.name === 'string') it.name = patch.name.slice(0, 40);
  it.updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const w = write(items);
  return w.ok === false ? { ok: false, why: w.why } : { ok: true, item: it };
}

function remove(id) {
  const items = read().items.slice();
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, why: '找不到这张图' };
  const [it] = items.splice(i, 1);
  if (process.env.XLJ_NO_PERSIST !== '1' && it.filename) {
    try { fs.unlinkSync(path.join(DIR, it.filename)); } catch { /* 文件不在了就算了 */ }
  }
  const w = write(items);
  return w.ok === false ? { ok: false, why: w.why } : { ok: true };
}

function markUsed(id) {
  const items = read().items.slice();
  const it = items.find((x) => x.id === id);
  if (!it) return { ok: false };
  it.used = (it.used || 0) + 1;
  it.lastUsedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  write(items);
  return { ok: true };
}

// ---------- 对外：查 ----------
function list(status = null) {
  const items = read().items;
  return status ? items.filter((x) => x.status === status) : items;
}

function approved() { return list('approved'); }

function get(id) { return read().items.find((x) => x.id === id) || null; }

// 读字节（发送时用）
function readFile(id) {
  const it = get(id);
  if (!it) return null;
  try { return fs.readFileSync(path.join(DIR, it.filename)); } catch { return null; }
}

// 按关键词粗筛（给"纯代码兜底"那条路用；AI 挑图走 brain 那条）
function matchByKeyword(text, limit = 3) {
  const t = String(text || '');
  if (!t) return [];
  const score = (it) => {
    const hay = `${it.name || ''} ${it.desc || ''}`;
    let s = 0;
    for (const ch of new Set(t)) if (ch.trim() && hay.includes(ch)) s += 1;
    return s;
  };
  return approved()
    .map((it) => ({ it, s: score(it) }))
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.it);
}

function status() {
  const items = read().items;
  const by = (s) => items.filter((x) => x.status === s).length;
  return {
    total: items.length,
    pending: by('pending'),
    approved: by('approved'),
    rejected: by('rejected'),
    usedTotal: items.reduce((a, x) => a + (x.used || 0), 0),
    dir: DIR,
    maxItems: MAX_ITEMS,
    maxMB: Math.round(MAX_BYTES / 1048576),
  };
}

// ---------- 对外：发图闸门（生成前与发送前**共用同一套判断**）----------
//
// 🔴 2026-10-13 真机踩到的坑（用户原话：「我让他发三次他只回了一张…第二次回复的是"再发一张"
//    但是却没有发，随后第三次询问的回复却是"还要第二张"明显对不上」）：
//    **文字答应了发图，代码却把图拦了** —— 因为"能不能发"只有发送那一刻才判断，
//    模型在生成时**不知道**自己在冷却里，于是照样说"给你来一张"，代码随后把 `[图:ID]` 摘掉不发。
//    ⇒ 铁律：**"能不能发"必须在生成前就让模型知道**，否则文案必然对不上。
//    所以闸门搬到这里（imglib），`brain.buildImgHint()` 和 `index.sendLibImage()` 都调它。
const lastSentAt = new Map();          // scope -> 上次成功发图的时间

// 🆕 2026-10-14 晚：概率闸的"一次性通行证"。
//   生成前抽中签 → 在这个 scope 上挂一个时间戳；发送前验签（`consume: true`）。
//   ⚠️ 有 TTL：万一模型抽中却**没写** `[图:ID]`（这很常见，抽中只是"允许发"），
//     这张签不该在几分钟后还被下一轮的发送端当成"这轮中了"来用。
const passAt = new Map();              // scope -> 抽中签的时间
const PASS_TTL = 2 * 60 * 1000;

// 从调用方给的参数里取出"群标识"。
//
// 🔴 2026-10-13 加：**同时认两种写法** —— `{groupOpenid, groupId}`（我们自己拼的）
//    和 QQ 事件原样的 `{group_openid, group_id}`。踩过的坑：写自测时顺手把事件对象
//    `{group_openid: ...}` 直接传进来，函数里读的是 camelCase ⇒ 取到 undefined ⇒
//    **静默判成"不在名单"**（函数不报错、只是行为变了，最难查的那种）。干脆两种都收。
function groupIds(opts = {}) {
  return [opts.groupOpenid, opts.groupId, opts.group_openid, opts.group_id]
    .map((x) => String(x || ''))
    .filter((x) => x.length > 0);
}

// 这个群**在用图库的名单里**吗（白名单为空 = 所有群都算）
//
// 🔴 为什么要单独一个函数：不在名单的群，`buildImgHint()` 要返回**空串**——
//    既省 token（每次回复少 100 字），也不让模型知道"其实有图库只是这不让用"这件事
//    （说了它反而可能去解释"我这儿不能发图"，很怪）。
function inWhitelist(opts = {}) {
  const c = (require('./config').policy || {}).imglib || {};
  if (c.enabled === false) return false;
  const allow = Array.isArray(c.testGroups) ? c.testGroups : [];
  if (!allow.length) return true;                 // 空名单 = 所有群
  const ids = groupIds(opts);
  if (!ids.length) return false;                  // 有名单但没给群信息 → 按"不在名单"处理（保守）
  return allow.some((x) => ids.includes(String(x)));
}

function sendGate({ scope, groupOpenid, groupId, isOwner, group_openid, group_id,
  explicit, consume, rand } = {}) {
  const c = (require('./config').policy || {}).imglib || {};
  if (c.enabled === false) return { ok: false, why: '图库没开', notHere: true };

  const allow = Array.isArray(c.testGroups) ? c.testGroups : [];
  if (allow.length) {
    const ids = groupIds({ groupOpenid, groupId, group_openid, group_id });
    if (!ids.length || !allow.some((x) => ids.includes(String(x)))) {
      return { ok: false, why: '本群不在允许发图的名单里', notHere: true };
    }
  }

  // ⚠️ 顺序讲究：**先看有没有货，再看让不让发** —— "图库里没图"是硬事实，
  //    不能因为"主人免冷却"就放行（那会让模型答应发一张不存在的图）。
  if (!approved().length) return { ok: false, why: '图库里还没有入库的图' };

  // 🆕 2026-10-13 用户要求：主人不受冷却限制
  const ownerFree = c.ownerBypass !== false && !!isOwner;
  if (!ownerFree) {
    const cd = Number(c.cooldownMs) || 0;
    const last = lastSentAt.get(scope) || 0;
    if (cd > 0 && last) {
      const left = cd - (Date.now() - last);
      if (left > 0) return { ok: false, why: `刚发过一张，还要等 ${Math.ceil(left / 1000)} 秒`, waitSec: Math.ceil(left / 1000) };
    }
  }

  // ---------- 🆕 2026-10-14 晚：概率闸（用户报"发图频率高、没有概率"）----------
  //
  // 🔴 为什么敲在**闸门里**而不是别处：闸门是"能不能发"的唯一判断处，
  //    `brain.buildImgHint()`（生成前，抽签）与 `index.sendLibImage()`（发送前，验签）都走它。
  // 🔴 **一次生成只抽一次签**：
  //    · `consume` 不传 = 生成前那次 → 发签（有人明确要图 或 抽中）
  //    · `consume: true` = 发送前那次 → **不重抽**，只验签在不在
  //    重抽的后果很具体：模型看到"能发"写了 `[图:ID]`，发送时又抽一次没中 ⇒ 图不发 ⇒
  //    又变成 2026-10-13 那个「文字答应了发图、群里却没有」的 bug。
  //    ⚠️ 连带一条**必须一起满足**的条件：**免抽签的情形（有人明确要图）也得发签** ——
  //       否则生成前放行了、发送前找不到签，照样发不出去（我第一版就漏了这步）。
  //    ⚠️ `chance >= 1` 时 `gated=false` ⇒ 两条路都不启签，**完全退回旧行为**。
  const chance = sendChance();
  if (chance < 1) {
    if (consume) {
      const t = passAt.get(scope) || 0;
      if (!(t && Date.now() - t < PASS_TTL)) return { ok: false, why: '这轮不配图' };
    } else {
      const r = typeof rand === 'function' ? rand() : Math.random();
      if (explicit || r < chance) passAt.set(scope, Date.now());
      else return { ok: false, why: '这轮不配图', drawn: 'miss' };
    }
  }
  return { ok: true, why: '', bypass: ownerFree ? 'owner' : undefined };
}

// 生效的发图概率（**每次现取**，别在启动时读进内存 —— 面板改完要立即生效）。
// 优先级：面板 `settings.json` 的 `imglibChance` > 代码 `policy.imglib.sendChance`。
// ⚠️ 兜底 1（= 不抽签）：配置读坏了宁可退回旧行为，也不要静默把发图全关掉。
function sendChance() {
  let v = Number(((require('./config').policy || {}).imglib || {}).sendChance);
  try {
    const s = require('./settings').num('imglibChance', v);
    if (Number.isFinite(s)) v = s;
  } catch { /* settings 读不到就用 config */ }
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

function noteSent(scope) { lastSentAt.set(scope, Date.now()); }
function lastSent(scope) { return lastSentAt.get(scope) || 0; }

module.exports = {
  add, setStatus, update, remove, markUsed,
  list, approved, get, readFile, matchByKeyword, status,
  describeBuffer, sniff, md5,
  sendGate, noteSent, lastSent, inWhitelist,
  sendChance,
  _DIR: DIR, _FILE: FILE, _MAX_ITEMS: MAX_ITEMS,
  _reset: () => { cache = null; cacheRaw = ''; },
  _resetSent: () => { lastSentAt.clear(); passAt.clear(); },
};
