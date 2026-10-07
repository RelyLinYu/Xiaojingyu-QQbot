// ============================================================
//  usage.js —— 每日用量趋势（2026-10-07，用户要的"用量趋势曲线"）
//
//  🎯 要解决的问题：面板上只有"今天"和"累计"两个数，**看不出趋势**
//     （"这个月比上个月费多少""日额度 ¥3 是不是太紧"这类问题都没法回答）。
//
//  📦 数据怎么来（两条腿，缺一不可）：
//    ① **累积**：机器人进程每 10 分钟把"今天"的快照写进 `data/usage.json`
//       （calls / spent / 时间戳）⇒ 从这里往后，数据是**准确的**。
//    ② **回填**：启动时从 journal 抓最近 N 天的 `[ai]` / `[budget]` 行**倒推历史**
//       （日志里本来就带着 `(今日第 N/1600 次 · 今日剩¥X)`）⇒ 让曲线**一上线就有内容**，
//       不用等十天半个月才看得出趋势。
//
//  🔴 三条设计约束（别改坏）：
//    ① **零依赖**：只用 node 内置能力（fs / path / child_process）。
//    ② **绝不抛错**：读不到/写不了/日志抓不到 ⇒ 一律降级成"空数据"，**绝不影响机器人回话**。
//    ③ **纯函数可测**：`parseJournalText()` 是**纯函数**（喂字符串、出结构化数据），
//       自测直接喂假日志就能验，不用碰真实文件。
//
//  ⚠️ `data/usage.json` 是**真实历史数据**（不可再生），写入用"tmp + rename"原子方式、
//     且改动前先备份一份 `.bak`（同 settings.js / examples.js 的做法）。
// ============================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ⚠️ 数据目录算法必须和 budget/power/memory/settings **完全一致**（2026-10-07：
//   之前 settings/examples 用了 `__dirname/..`，而 bot 服务没设 APP_DIR ⇒ 两边读写不同文件、
//   面板改的设置机器人看不到 —— 所以这里一开始就用统一算法，别重蹈覆辙）
const APP_DIR = process.env.APP_DIR || __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const FILE = path.join(DATA_DIR, 'usage.json');

const MAX_DAYS = 120;          // 最多留多少天（防文件无限长）
const KEEP_BACKFILL_DAYS = 14; // 回填多少天

// ---------- 纯函数：从 journal 文本里倒推每日用量 ----------
// 认这两种行（都是本项目真实打印的）：
//   [ai] deepseek-flash in=992 out=36 缓存命中640(65%) (今日第 693/1600 次 · 今日剩¥1.845 · 累计剩¥11.363)
//   [budget] 今日 ¥1.1020 / ¥3　累计 ¥14.5263 / ¥20（10735 次调用）
// ⚠️ journal 的 `-o short-iso` 行首是 `2026-10-07T13:26:55+08:00 ...`，取前 10 位当日期。
function parseJournalText(text, opts) {
  const o = opts || {};
  const dailyLimit = Number(o.dailyLimitYuan) || 3;
  const out = {};                     // date -> { calls, spent, at }
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const d = /^(\d{4}-\d{2}-\d{2})T/.exec(line);
    if (!d) continue;
    const date = d[1];

    // ⚠️ 只有**真的解析出用量**才建这一天（否则"只是带日期的行"会凭空造出一天 0 数据）
    const t = /T(\d{2}:\d{2}:\d{2})/.exec(line);

    // ① [ai] 行：今日第 N 次 + 今日剩¥X
    const mAi = /\[ai\][^\n]*?今日第\s*(\d+)\s*\/\s*\d+\s*次[^\n]*?今日剩¥([\d.]+)/.exec(line);
    if (mAi) {
      let cur = out[date];
      if (!cur) cur = out[date] = { calls: 0, spent: 0, at: '' };
      const n = Number(mAi[1]) || 0;
      const left = Number(mAi[2]);
      if (n > cur.calls) cur.calls = n;
      if (Number.isFinite(left)) {
        const spent = Math.max(0, Number((dailyLimit - left).toFixed(4)));
        if (spent > cur.spent) cur.spent = spent;    // 同日取"当天花了最多"的那条
      }
      if (t) cur.at = t[1];
      continue;
    }

    // ② [budget] 横幅：今日 ¥x / ¥y
    //    🔴🔴 只取"今日花费"，**绝不能取那个 `（N 次调用）`** ——
    //      它是**终身累计**，不是"今天"！（项目文档里早有这条结论，我第一版还是踩了：
    //      回填出来 10/5 显示 10735 次调用，一眼就是假值 —— 那是累计数。）
    //    ⇒ 每日调用次数**只信 `[ai]` 行的"今日第 N 次"**。
    const mBg = /\[budget\][^\n]*?今日\s*¥([\d.]+)\s*\/\s*¥([\d.]+)/.exec(line);
    if (mBg) {
      let cur = out[date];
      if (!cur) cur = out[date] = { calls: 0, spent: 0, at: '' };
      const spent = Number(mBg[1]);
      if (Number.isFinite(spent) && spent > cur.spent) cur.spent = spent;
      if (t) cur.at = t[1];
    }
  }
  return out;
}

// ---------- 读 / 写 ----------
let cache = null;
let cacheRaw = '';

function read() {
  // 🔴 测试模式（XLJ_NO_PERSIST=1）：**不读文件**，直接用内存里那份。
  //    ⚠️ 这个坑我在 settings.js 上踩过一次：只让"写"不落盘、却仍让"读"去读文件
  //       ⇒ 测试里写了数据、下一次读又变成空的（表现为"测试全挂"，害人排查半天）。
  if (process.env.XLJ_NO_PERSIST === '1') return cache || (cache = { days: {} });
  let txt;
  try { txt = fs.readFileSync(FILE, 'utf8'); } catch { return { days: {} }; }
  if (cache && txt === cacheRaw) return cache;
  try {
    const obj = JSON.parse(txt);
    const days = (obj && typeof obj.days === 'object' && obj.days) ? obj.days : {};
    cache = { days };
    cacheRaw = txt;
    return cache;
  } catch {
    return { days: {} };            // 坏了就当空，绝不让机器人起不来
  }
}

function write(days) {
  const noPersist = process.env.XLJ_NO_PERSIST === '1';
  if (noPersist) { cache = { days }; cacheRaw = ''; return { ok: true, persisted: false }; }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* 备份失败不拦 */ } }
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ days }, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
    cache = { days }; cacheRaw = fs.readFileSync(FILE, 'utf8');
    return { ok: true, persisted: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// 把某天的数据合并进去（只增不减：同一天取更大的值，避免"重启后数字变小"）
function mergeDay(days, date, info) {
  const cur = days[date] || { calls: 0, spent: 0, at: '' };
  days[date] = {
    calls: Math.max(Number(cur.calls) || 0, Number(info.calls) || 0),
    spent: Math.max(Number(cur.spent) || 0, Number(info.spent) || 0),
    at: info.at || cur.at || '',
  };
}

function prune(days) {
  const keys = Object.keys(days).sort();
  while (keys.length > MAX_DAYS) delete days[keys.shift()];
  return days;
}

// 记一笔"今天"（机器人在跑，所以这些数是准的）
function record(state, now) {
  try {
    const t = new Date(now || Date.now());
    const date = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    const days = read().days;
    mergeDay(days, date, {
      calls: Number(state && state.dayCalls) || 0,
      spent: Number(state && state.daySpent) || 0,
      at: String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'),
    });
    prune(days);
    return write(days);
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// 启动时回填历史（抓 journal ⇒ 解析 ⇒ 并入；**已有数据不覆盖**：取更大的值）
function backfill(opts) {
  const o = opts || {};
  const days = read().days;
  let txt = '';
  try {
    const cmd = 'journalctl -u ' + (o.service || 'xiaolanjing') + ' --since "' + (o.days || KEEP_BACKFILL_DAYS) + ' days ago"'
      + ' -o short-iso --no-pager';
    txt = execSync(cmd, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
  } catch (e) {
    return { ok: false, why: '读 journal 失败：' + e.message, filled: 0 };
  }
  const parsed = parseJournalText(txt, { dailyLimitYuan: o.dailyLimitYuan });
  let filled = 0;
  for (const [date, info] of Object.entries(parsed)) {
    mergeDay(days, date, info);
    filled += 1;
  }
  prune(days);
  const w = write(days);
  return { ok: w.ok !== false, filled, days: Object.keys(days).length, why: w.why };
}

// 给面板用的：最近 n 天（按日期升序，缺失的天补 0）
function summary(n, now) {
  const cnt = Math.max(1, Math.min(60, Number(n) || 14));
  const days = read().days;
  const out = [];
  const base = new Date(now || Date.now());
  for (let i = cnt - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 24 * 3600 * 1000);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const it = days[key] || {};
    out.push({
      date: key,
      md: (d.getMonth() + 1) + '/' + d.getDate(),
      calls: Number(it.calls) || 0,
      spent: Number(it.spent) || 0,
    });
  }
  return out;
}

module.exports = {
  record, backfill, summary, parseJournalText, read, FILE, MAX_DAYS,
  _mergeDay: mergeDay, _write: write,
};
