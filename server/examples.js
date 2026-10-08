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

// 🔴 数据目录算法必须和 budget/power/memory/settings 一致（2026-10-07 修：
//   原来用 `__dirname/..`，而 bot 服务没设 APP_DIR ⇒ 机器人读 `/opt/data`、面板读 `/opt/xiaolanjing/data`
//   ⇒ **用户在面板改的语气示范，机器人从来没看到过**）
const APP_DIR = process.env.APP_DIR || __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const FILE = path.join(DATA_DIR, 'examples.json');

// 示范条数/长度的上限（防止一次塞太多把真实群聊挤出上下文）
const MAX_ITEMS = 30;
const MAX_LEN = 300;
// 允许的"身份标注"（空 = 不标注，即普通群友）
const ROLES = ['', '普通群员', '主人', '群友'];

let cache = null;
let cacheRaw = null;      // 🆕 上一次读到的**文件原文**（用来判断"文件被别的进程改过"）

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
// 🔴🔴 2026-10-08 修（真实事故）：这里原来是 `if (cache) return cache` —— **进程内永久缓存**。
//    症状：面板/预设切换把 data/examples.json 改成 14 组大肥鱼示范、文件也确实变了，
//    但**机器人进程永远读它第一次读到的那份**（还是巧克力的 17 组）⇒ 群里出现
//    「白米饭喵！本喵最爱吃这个了」这种人设与示范打架的回复，而且**一个字都不报错**。
//    修法：每次都真读文件、**按内容比对**复用旧对象（同 settings.js 的做法）。
//    为什么不用 mtime：同秒写入、别处回写、精度不够都会让 mtime 跟踪错位（settings.js 里踩过）。
function current() {
  // ⚠️ 测试模式（XLJ_NO_PERSIST=1）：不读文件，直接用内存里那份
  //    （否则"只更新内存"会被这次读文件覆盖掉）
  if (process.env.XLJ_NO_PERSIST === '1') return cache;
  let txt;
  try {
    txt = fs.readFileSync(FILE, 'utf8');
  } catch {
    cache = null; cacheRaw = null;                 // 没这个文件 = 用代码里的默认
    return null;
  }
  if (txt === cacheRaw) return cache;              // 内容没变 ⇒ 复用（省掉重复解析）
  try {
    const obj = JSON.parse(txt);
    const r = normList(obj && obj.items);
    if (!r.ok) return null;                        // JSON 合法但内容不合法 → 回落默认
    cache = r.items.length ? r.items : null;       // 空数组也当作"没配"
    cacheRaw = txt;                                // ⚠️ 挂 _raw 这类技巧这里用不上：本模块返回的是数组不是对象
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
    cacheRaw = JSON.stringify({ items: r.items }, null, 2);   // 和落盘后的原文一致，避免误判"文件变了"
    return { ok: true, count: r.items.length, persisted: false };
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // 改动前备份一份（真实数据不可再生；同 settings.js 的做法）
    if (fs.existsSync(FILE)) {
      try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* 备份失败不拦 */ }
    }
    const tmp = FILE + '.tmp';
    const body = JSON.stringify({ items: r.items }, null, 2);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, FILE);
    cache = r.items.length ? r.items : null;
    cacheRaw = body;                                          // 🔴 必须同步更新，否则下一次读会被认成"文件变了"
    return { ok: true, count: r.items.length, persisted: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// 恢复默认（= 删掉这个文件）
function reset() {
  const noPersist = process.env.XLJ_NO_PERSIST === '1';
  if (noPersist) { cache = null; cacheRaw = null; return { ok: true, persisted: false }; }
  try {
    if (fs.existsSync(FILE)) {
      // 🔴🔴 2026-10-07 改（真实事故）：原来直接 unlink ⇒ **用户手改的那份被永久删掉**。
      //   我自己在"部署验证脚本"里调了一次 reset，把他删过一条的 13 组编辑弄丢了（不可再生）。
      //   ⇒ 现在**先改名留一份带时间戳的备份**，再删；"误点恢复默认"从此可挽回。
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fs.renameSync(FILE, FILE + '.reset-' + stamp);
      } catch { try { fs.unlinkSync(FILE); } catch { /* 忽略 */ } }
    }
    cache = null;
    cacheRaw = null;
    return { ok: true, persisted: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

module.exports = { current, save, reset, status, normOne, normList, FILE, MAX_ITEMS, ROLES };
