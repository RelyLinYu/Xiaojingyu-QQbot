// ============================================================
//  examples.js —— 面板可编辑的「语气示范」（2026-10-06 新增）
//
//  背景（用户要的）：决定鱼说话语气的**主要就是这十来组示范**，但它们原来只写在
//  `config.js` 里 —— 用户想调教语气只能找开发改代码。现在做成面板可改：
//    面板表格 → 保存 → 写 `data/examples.json` → `config.persona.examples` 立刻用它
//    （没配这个文件时，仍然用 `config.js` 里那套默认示范）
//
//  ⚠️ 成本提醒：示范紧跟在 system 后面，属于 **prompt 前缀**的一部分
//     ⇒ **改一次会让缓存前缀失效一次**（命中价 1/50 → 全价）。
//     ⇒ 建议：改完用「🧪 试聊」验证，满意就别再频繁动。
//
//  零依赖：只用 node 内置 fs/path。
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const FILE = path.join(DATA_DIR, 'examples.json');

// 示范条数/长度的上限（防止一次塞太多把真实群聊挤出上下文）
const MAX_ITEMS = 30;
const MAX_LEN = 300;
// 允许的"身份标注"（空 = 不标注，即普通群友）
const ROLES = ['', '普通群员', '主人', '群友'];

let cache = null;

// 校验一条示范：返回规范化的 {u,a,role?} 或 null（不合法）
function normOne(it) {
  if (!it || typeof it !== 'object') return null;
  const u = String(it.u == null ? '' : it.u).trim().slice(0, MAX_LEN);
  const a = String(it.a == null ? '' : it.a).trim().slice(0, MAX_LEN);
  if (!u || !a) return null;                       // 一半空的没意义
  const role = String(it.role == null ? '' : it.role).trim();
  const out = { u, a };
  if (ROLES.includes(role) && role) out.role = role;
  return out;
}

// 校验整个数组：返回 { ok, items } 或 { ok:false, why }
function normList(raw) {
  if (!Array.isArray(raw)) return { ok: false, why: '必须是数组' };
  if (raw.length > MAX_ITEMS) return { ok: false, why: '最多 ' + MAX_ITEMS + ' 组' };
  const items = [];
  for (const it of raw) {
    const n = normOne(it);
    if (!n) return { ok: false, why: '有一组不完整（群友说 / 鱼回 都要填）' };
    items.push(n);
  }
  return { ok: true, items };
}

// 读：返回数组；文件不存在/坏了 → null（让调用方回落默认）
function current() {
  if (cache) return cache;
  let txt;
  try {
    txt = fs.readFileSync(FILE, 'utf8');
  } catch {
    return null;                                   // 没这个文件 = 用代码里的默认
  }
  try {
    const obj = JSON.parse(txt);
    const r = normList(obj && obj.items);
    if (!r.ok) return null;
    cache = r.items.length ? r.items : null;       // 空数组也当作"没配"
    return cache;
  } catch {
    return null;                                   // JSON 坏了 → 回落默认，别让机器人起不来
  }
}

// 状态（给面板显示用）
function status() {
  const cur = current();
  return {
    items: cur || [],
    fromFile: !!cur,
    max: MAX_ITEMS,
    file: FILE,
  };
}

// 存：校验 → 备份 → 原子写
function save(rawItems) {
  const r = normList(rawItems);
  if (!r.ok) return r;
  // 🔴 测试模式（XLJ_NO_PERSIST=1）：**只更新内存、不写文件**。
  //    原因（在 settings.js 上踩过）：自测会调 save() ⇒ 如果真写 data/examples.json，
  //    就会**污染线上配置**（而且症状是"自测和线上互相影响"，很难查）。
  const noPersist = process.env.XLJ_NO_PERSIST === '1';
  if (noPersist) {
    cache = r.items.length ? r.items : null;
    return { ok: true, count: r.items.length, persisted: false };
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // 改动前备份一份（真实数据不可再生；同 settings.js 的做法）
    if (fs.existsSync(FILE)) {
      try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* 备份失败不拦 */ }
    }
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: r.items }, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
    cache = r.items.length ? r.items : null;
    return { ok: true, count: r.items.length, persisted: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// 恢复默认（= 删掉这个文件）
function reset() {
  const noPersist = process.env.XLJ_NO_PERSIST === '1';
  if (noPersist) { cache = null; return { ok: true, persisted: false }; }
  try {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
    cache = null;
    return { ok: true, persisted: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

module.exports = { current, save, reset, status, normOne, normList, FILE, MAX_ITEMS, ROLES };
