// ============================================================
//  memes.js —— 群内「梗库」（2026-10-22 用户要求）
//
//  用途：用户不想把一堆圈内梗写进人设（人设是每次调用都重发的 system 前缀），
//       改成**命中才注入**：正常聊天 0 成本，只有消息真的出现触发词时，
//       在那一轮的用户文本里附一句「有人说「康神开播了」→ 可以接「真的假的」」。
//
//  🔴 三条设计约束（都是踩过的坑）：
//   ① **只给提示、不给固定台词** —— 存「可以接『真的假的』」，不存唯一答案。
//      固定台词会挤掉真实上下文（2026-10-17 那次"连不了外网"就是台词盖掉真材料）。
//   ② **注入走 user 文本，不进 system** —— system 是稳定前缀，改它会打碎提示词缓存，
//      那一轮变全价；user 文本随轮变化不影响缓存。
//   ③ `when`（适用语境）是可选的**条件说明**：像「隐晦=淫秽」这种谐音梗，
//      正常说"表达隐晦"不该接，必须在提示里写清"只在暧昧/擦边语境下算"。
//
//  数据：data/memes.json（原子写 tmp→rename + 改前 .bak；读失败**不覆盖**）
// ============================================================
const fs = require('fs');
const path = require('path');

// ⚠️ 数据目录口径必须和 budget/usage/settings 一致：`APP_DIR || __dirname`（**不是 __dirname/..**）
const APP_DIR = process.env.APP_DIR || __dirname;
const FILE = path.join(APP_DIR, 'data', 'memes.json');

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(j.items)) return j.items;
    return [];
  } catch { return []; }
}

function saveRaw(items) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2));
  fs.renameSync(tmp, FILE);
}

function backup() {
  try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* 备份失败不挡写 */ }
}

function save(items) {
  backup();
  saveRaw(items);
  return { ok: true };
}

// 触发词：允许一条写多个，用 | 、 ， / 分隔
function splitTriggers(s) {
  return String(s || '')
    .split(/[|｜,，、/]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function list() {
  return load();
}

function add({ trigger, reply, when, fixed, echo }) {
  const triggers = splitTriggers(trigger);
  const rp = String(reply || '').trim();
  if (!triggers.length) return { ok: false, why: '触发词不能为空' };
  if (!rp) return { ok: false, why: '接法不能为空' };
  if (triggers.some((t) => t.length > 40) || rp.length > 200) return { ok: false, why: '太长了（触发词≤40、接法≤200）' };
  let from = '', to = '';
  if (echo) {
    // 镜像模式：reply 写成「来→回」（也认 ->），由代码把用户原话里的字换掉再原样回去
    const m = rp.split(/→|->/).map((x) => x.trim()).filter(Boolean);
    if (m.length !== 2 || m[0].length > 4 || m[1].length > 4) return { ok: false, why: '镜像模式请把接法写成「来→回」' };
    from = m[0]; to = m[1];
  }
  const items = load();
  // 同一个触发词只留一条（再添加视为更新接法）
  const dup = items.find((x) => x.triggers.some((t) => triggers.includes(t)));
  const rec = {
    id: dup ? dup.id : ('m' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    triggers,
    reply: rp,
    when: String(when || '').trim().slice(0, 80),
    // 🆕 2026-10-23 固定暗号：必须原样接（如 康神开播了→真的假的）
    fixed: !!fixed,
    // 🆕 2026-10-23 镜像替换：把原话里的 from 换成 to 再原样回（0 模型调用）
    echo: !!echo, from, to,
    enabled: true,
    ts: Date.now(),
  };
  const next = dup ? items.map((x) => (x.id === dup.id ? rec : x)) : [rec].concat(items);
  save(next.slice(0, 500));
  return { ok: true, item: rec, updated: !!dup };
}

function toggle(id, enabled) {
  const items = load();
  const it = items.find((x) => x.id === id);
  if (!it) return { ok: false, why: '没有这条' };
  it.enabled = !!enabled;
  save(items);
  return { ok: true };
}

function remove(id) {
  const items = load();
  const next = items.filter((x) => x.id !== id);
  if (next.length === items.length) return { ok: false, why: '没有这条' };
  save(next);
  return { ok: true };
}

// 🆕 2026-10-23 自动采集入库（用户：「让bot自己加」）
//   · 只存「短语 + 一句话含义」，**不存接法** ⇒ 注入时只当"群里常这么说"的背景，不当台词；
//   · 已经存在（手动或自动）就不覆盖手动条目，只给自动条目刷新次数。
function addAuto({ phrase, meaning, count, speakers }) {
  const p = String(phrase || '').trim();
  const m = String(meaning || '').trim();
  if (!p || !m) return { ok: false, why: '缺短语或释义' };
  const items = load();
  const dup = items.find((x) => (x.triggers || []).some((t) => String(t) === p));
  if (dup) {
    if (dup.origin === 'auto') {
      dup.meaning = m;
      dup.count = Math.max(Number(dup.count) || 0, Number(count) || 0);
      dup.ts = Date.now();
      save(items);
    }
    return { ok: false, why: '已存在' };
  }
  if (items.length >= 500) return { ok: false, why: '梗库满了（500）' };
  const rec = {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    triggers: [p], reply: '', meaning: m,
    origin: 'auto', count: Number(count) || 0, speakers: Number(speakers) || 0,
    when: '', fixed: false, echo: false, enabled: true, ts: Date.now(),
  };
  save([rec].concat(items));
  return { ok: true, item: rec };
}

// 面板「仅保留修改」：按 id 改含义/接法/适用语境
function update(id, patch) {
  const items = load();
  const it = items.find((x) => x.id === id);
  if (!it) return { ok: false, why: '没有这条' };
  if (patch.meaning !== undefined) it.meaning = String(patch.meaning).trim().slice(0, 120);
  if (patch.reply !== undefined) it.reply = String(patch.reply).trim().slice(0, 200);
  if (patch.when !== undefined) it.when = String(patch.when).trim().slice(0, 80);
  if (patch.enabled !== undefined) it.enabled = !!patch.enabled;
  it.ts = Date.now();
  save(items);
  return { ok: true, item: it };
}

// 命中检测 + 拼提示（**纯函数**，方便自测；不读写文件之外的东西）
// text：本条消息**自己的话**（调用方应传 ownText，别传含引用/识图的长文本）
//
// 🔴 两种模式（2026-10-23 用户反馈「token来没被识别」+「返回会不会太单一」）：
//   · fixed（固定暗号）：必须**原样**接，模型不许自己发挥 —— 不然它会把「token回」改成自己的段子；
//   · 非 fixed：把多个接法一起给（`reply` 用 | 分隔），并要求"挑一个、别每次同一句"。
function hint(text) {
  const t = String(text || '');
  if (!t.trim()) return '';
  const low = t.toLowerCase();
  const hits = [];
  // 手动条目优先命中；自动条目按出现次数排（越常用越先给）
  const all = load().filter((x) => x && x.enabled !== false && !x.echo);
  const ordered = all.filter((x) => x.origin !== 'auto')
    .concat(all.filter((x) => x.origin === 'auto').sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0)));
  for (const it of ordered) {
    const trig = (it.triggers || []).find((x) => x && low.includes(String(x).toLowerCase()));
    if (!trig) continue;
    hits.push({ it, trig, auto: it.origin === 'auto' && !!it.meaning && !String(it.reply || '').trim() });
    if (hits.length >= 3) break;      // 一轮最多 3 条，别把提示塞成小作文
  }
  if (!hits.length) return '';
  const lines = hits.map(({ it, trig, auto }) => {
    const cond = it.when ? `（只在：${it.when}）` : '';
    if (auto) {
      return '· 群里常有人说「' + trig + '」，意思是：' + it.meaning + '（知道就好，顺着用，别解释梗）' + cond;
    }
    if (it.fixed) {
      return '· 有人说「' + trig + '」时，必须原样接「' + it.reply + '」——这是群里的固定暗号，不许改写、不许换成自己的段子' + cond;
    }
    const variants = String(it.reply || '').split(/[|｜]/).map((x) => x.trim()).filter(Boolean);
    const list = variants.map((v) => '「' + v + '」').join(' / ');
    return '· 有人说「' + trig + '」时，可以接：' + list + cond
      + (variants.length > 1 ? '（挑一个最贴语境的，别每次都用同一句，也别把梗解释出来）' : '');
  });
  let out = '【群内梗库｜对得上才用，别硬接】\n' + lines.join('\n');
  if (out.length > 300) out = out.slice(0, 300) + '…';
  return out;
}

// 镜像替换：命中就把**用户原话**里的 from 全部换成 to，保留 emoji / 重复次数 / 空白。
// 用户 2026-10-23 原话：「把我发的文案里面的"来"换成"回"，更应景，不是写死」。
// ⇒ 这是确定性变换，交给模型必被改写或截断（实测它回了"喊这么多遍盆都给你喊翻了"），所以自己算。
function echoReply(text) {
  const src = String(text || '');
  if (!src.trim()) return null;
  const low = src.toLowerCase();
  for (const it of load()) {
    if (!it || it.enabled === false || !it.echo || !it.from || !it.to) continue;
    const hit = (it.triggers || []).some((x) => x && low.includes(String(x).toLowerCase()));
    if (!hit) continue;
    const out = src.split(it.from).join(it.to);
    if (out === src) continue;            // from 不在原文里，换了没意义 ⇒ 不当成镜像
    return { text: out.slice(0, 400), from: it.from, to: it.to, id: it.id };
  }
  return null;
}

module.exports = { FILE, list, add, addAuto, update, toggle, remove, hint, echoReply, splitTriggers, _reset: () => saveRaw([]) };
