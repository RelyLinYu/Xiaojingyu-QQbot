// ============================================================
//  presets.js —— 「人设预设」（2026-10-07 用户需求）
//
//  📝 用户原话：「增加一个功能，人设预设，可以把当前的人设提示词+示范做成一个人设预设，
//     存成预设卡片，然后点击卡片可以切换不同的人设预设」
//
//  🎯 一个预设 = **一整套"性格"的快照** = 人设提示词（system）+ 语气示范（examples）。
//     点卡片切换 = 把这一整套**写回**现有的两个真源：
//        · 人设  → `data/settings.json` 的 `personaText`（settings.update）
//        · 示范  → `data/examples.json`（examples.save）
//     ⇒ 🔴 **故意不做"第二套真源"**：切换就是写那两个文件，所以切换完
//       「人设框/示范表」里立刻显示新内容、机器人也立刻用上（复用已有的即时生效链路）。
//
//  🔴 四条设计约束：
//    ① **零依赖**、只用 node 内置；
//    ② **绝不影响机器人**：任何读失败 ⇒ 当空列表，绝不抛错；
//    ③ **写入安全**：原子写（tmp+rename）+ 改前备份 `.bak` + 上限/长度校验；
//    ④ **测试模式** `XLJ_NO_PERSIST=1` ⇒ 只动内存（这个坑在本项目踩过，新模块一开始就带）。
//
//  ⚠️ 「当前使用哪个预设」不用存状态：**内容比对**得出（人设+示范和某个预设完全一致 ⇒ 就是它）
//     —— 这样他手动改过之后，卡片会自然显示"已改动"，不需要额外的失效逻辑。
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;      // ⚠️ 必须和其他模块同一算法（见 settings.js 注释）
const DATA_DIR = path.join(APP_DIR, 'data');
const FILE = path.join(DATA_DIR, 'presets.json');

const MAX_ITEMS = 20;
const MAX_NAME = 20;
const MAX_PERSONA = 5000;

let cache = null;
let cacheRaw = '';

function read() {
  if (process.env.XLJ_NO_PERSIST === '1') return cache || (cache = { items: [] });
  let txt;
  try { txt = fs.readFileSync(FILE, 'utf8'); } catch { return { items: [] }; }
  if (cache && txt === cacheRaw) return cache;
  try {
    const o = JSON.parse(txt);
    const items = Array.isArray(o && o.items) ? o.items : [];
    cache = { items };
    cacheRaw = txt;
    return cache;
  } catch {
    return { items: [] };            // 坏了当空，绝不让机器人或面板起不来
  }
}

function write(items) {
  if (process.env.XLJ_NO_PERSIST === '1') { cache = { items }; cacheRaw = ''; return { ok: true, persisted: false }; }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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

function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_NAME);
}
function newId() {
  return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

// 当前生效的"人设 + 示范"（用于"把当前存成预设"和"判断当前用的是哪个预设"）
function currentSet() {
  let persona = '';
  let examples = [];
  try {
    // 面板里存过的整段人设优先；没存过就是空（= 用代码默认）
    const t = require('./settings').text('personaText', '');
    persona = typeof t === 'string' ? t : '';
  } catch { persona = ''; }
  try {
    const e = require('./config').persona.examples;      // 已做"文件优先、否则内置"的回落
    examples = Array.isArray(e) ? e : [];
  } catch { examples = []; }
  return { persona, examples };
}

function summarize(it) {
  const stored = it.persona || '';
  // 🔴 2026-10-07（用户问「为什么人设 0 字」）：空人设的语义是"**用代码里的默认人设**"，
  //    但显示成"0 字"看起来像"什么都没存" ⇒ 改成显示**生效的那份有多长 + 前 40 字**。
  let eff = stored;
  let usesDefault = false;
  if (!stored) {
    usesDefault = true;
    try { eff = require('./config').persona.systemPrompt || ''; } catch { eff = ''; }
  }
  return {
    id: it.id,
    name: it.name,
    personaChars: stored.length,
    personaEffectiveChars: eff.length,
    usesDefault: usesDefault,
    exampleCount: Array.isArray(it.examples) ? it.examples.length : 0,
    preview: String(eff).replace(/\s+/g, ' ').slice(0, 40),
    updatedAt: it.updatedAt || it.createdAt || '',
  };
}

function list() {
  const { persona, examples } = currentSet();
  const items = read().items;
  const matchOf = (it) => (it.persona || '') === persona
    && JSON.stringify(it.examples || []) === JSON.stringify(examples || []);
  // ⚠️ 可能有多张内容相同的预设（把同一套性格存了两次）⇒ **只把最新那张标成"使用中"**
  //    （否则会出现两张卡片同时显示"正在使用"，看着像 bug）
  let activeIdx = -1;
  items.forEach((it, i) => { if (matchOf(it)) activeIdx = i; });
  return items.map((it, i) => {
    const s = summarize(it);
    s.active = (i === activeIdx);
    return s;
  });
}

// 把当前生效的人设+示范存成一个新预设
function capture(name) {
  const n = cleanName(name);
  if (!n) return { ok: false, why: '给预设起个名字（1~' + MAX_NAME + ' 字）' };
  const { persona, examples } = currentSet();
  if (!persona && !examples.length) return { ok: false, why: '当前没有内容可存' };
  const items = read().items.slice();
  if (items.length >= MAX_ITEMS) return { ok: false, why: '最多存 ' + MAX_ITEMS + ' 个预设，先删掉几个' };
  if (items.some((x) => x.name === n)) return { ok: false, why: '已经有一个叫「' + n + '」的预设了' };
  const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const it = { id: newId(), name: n, persona: String(persona || '').slice(0, MAX_PERSONA), examples: examples.slice(0, 30), createdAt: at, updatedAt: at };
  items.push(it);
  const w = write(items);
  if (w.ok === false) return { ok: false, why: '写入失败：' + w.why };
  return { ok: true, item: summarize(it) };
}

// 应用某张卡片：把它的人设+示范写回两个真源（= 真正切换）
function activate(id) {
  const it = read().items.find((x) => x.id === id);
  if (!it) return { ok: false, why: '找不到这个预设' };
  const out = { ok: true, name: it.name, did: [] };
  // ① 人设 → settings.personaText（留空 = 回到代码默认人设）
  try {
    const r = require('./settings').update({ personaText: it.persona || '' });
    if (r && r.ok === false) return { ok: false, why: '人设没写进去：' + (r.why || '') };
    out.did.push('人设 ' + (it.persona ? (it.persona.length + ' 字') : '（清空=用默认）'));
  } catch (e) {
    return { ok: false, why: '写人设出错：' + e.message };
  }
  // ② 示范 → data/examples.json（空数组 = 删文件回内置 14 组）
  try {
    const ex = require('./examples');
    const r = (it.examples && it.examples.length) ? ex.save(it.examples) : ex.reset();
    if (r && r.ok === false) return { ok: false, why: '示范没写进去：' + (r.why || '') };
    out.did.push('示范 ' + (it.examples && it.examples.length ? (it.examples.length + ' 组') : '（恢复默认 14 组）'));
  } catch (e) {
    return { ok: false, why: '写示范出错：' + e.message };
  }
  return out;
}

function remove(id) {
  const items = read().items;
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, why: '找不到这个预设' };
  const gone = items[i].name;
  items.splice(i, 1);
  const w = write(items);
  if (w.ok === false) return { ok: false, why: '写入失败：' + w.why };
  return { ok: true, name: gone };
}

function rename(id, name) {
  const n = cleanName(name);
  if (!n) return { ok: false, why: '名字不能为空' };
  const items = read().items;
  const it = items.find((x) => x.id === id);
  if (!it) return { ok: false, why: '找不到这个预设' };
  if (items.some((x) => x.id !== id && x.name === n)) return { ok: false, why: '已经有叫「' + n + '」的预设了' };
  it.name = n;
  it.updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const w = write(items);
  if (w.ok === false) return { ok: false, why: '写入失败：' + w.why };
  return { ok: true, item: summarize(it) };
}

function status() {
  const items = list();
  return {
    count: items.length, max: MAX_ITEMS, maxName: MAX_NAME,
    items: items,
    current: (() => { const c = currentSet(); return { personaChars: c.persona.length, exampleCount: c.examples.length }; })(),
    file: FILE,
  };
}

module.exports = { list, capture, activate, remove, rename, status, currentSet, FILE, MAX_ITEMS, MAX_NAME, _write: write };
