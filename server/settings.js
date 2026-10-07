// ============================================================
//  settings.js —— 面板可改的参数（2026-10-05 新增）
//
//  🎯 用户需求：「增加 apikey，每天限额，总限额，回复次数上限，一键开关机等等
//     参数设定的可更改项」
//
//  🔴 安全设计（这本来是"全站只读"的面板，现在要开口子，必须想清楚）：
//    ① **白名单**：只有下面 `SPEC` 里列出的键能改，**不接受任意键/任意文件路径**
//       （否则等于给了一个"任意写文件"的后门）
//    ② **密钥永不回显**：`AI_API_KEY` 只返回掩码（`sk-abc…xyz`），
//       API 里**绝不把明文吐回浏览器**；改它必须重新完整输入
//    ③ **校验**：数字必须落在合理区间（防止手滑改成 0 或 999999）
//    ④ **原子写**：tmp + rename；`.env` 改动前先备份一份 `.env.bak-<时间>`
//    ⑤ 面板本身仍然要密码（见 logweb.js 的 authed）
//
//  ⚠️ 分工：**能即时生效的走这个文件**（额度/次数上限——主进程每次判额度时现读）；
//     **必须重启才生效的写 `.env`**（API Key / 模型名——它们是启动时读进内存的）。
// ============================================================

const fs = require('fs');
const path = require('path');

// 🔴🔴 2026-10-07 修一个**潜伏很久的真 bug**：数据目录必须和 budget/power/memory 用**同一个算法**。
//   原来这里是 `process.env.APP_DIR || path.join(__dirname, '..')`，而 **bot 服务没有设 APP_DIR**
//   （只有 logweb 的 unit 里设了）⇒ 机器人算出来是 `/opt/data`、面板算出来是 `/opt/xiaolanjing/data`
//   ⇒ **两边读写的根本不是同一个文件**：用户在面板改的次数上限 / 人设 / 示范，**机器人从来没看到过**。
//   证据：面板显示上限 3000，而机器人日志一直打 `今日第 N/1600 次`（代码默认值）。
//   ⇒ 现在统一成 `process.env.APP_DIR || __dirname`：
//       · 服务器是**扁平布局**（模块就在 /opt/xiaolanjing 下）⇒ `__dirname` 就是应用根 ✅
//       · 本地是 `server/` 子目录 ⇒ 数据落在 server/data（与 budget.js / power.js / memory.js 一致）✅
const APP_DIR = process.env.APP_DIR || __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const FILE = path.join(DATA_DIR, 'settings.json');
const ENV_FILE = path.join(APP_DIR, '.env');

// ---------- 允许改的键（白名单）----------
// type: 'env' = 写 .env（需重启生效）；'runtime' = 写 settings.json（即时生效）
const SPEC = {
  aiApiKey: { type: 'env', env: 'AI_API_KEY', label: 'AI 密钥（DeepSeek API Key）', secret: true },
  budgetDaily: { type: 'runtime', key: 'budgetDailyYuan', env: 'BUDGET_DAILY_YUAN', label: '每天限额（元）', min: 0.1, max: 1000 },
  budgetTotal: { type: 'runtime', key: 'budgetTotalYuan', env: 'BUDGET_TOTAL_YUAN', label: '总限额（元）', min: 1, max: 100000 },
  // 🔴 2026-10-06：`budgetAnchor`（累计已花锚点）**已按用户要求删除** —— 他原话：
  //    「不需要那个锚点，我自己看，删掉」。⇒ "累计已花"只用本地账本（页面显示 `spentYuan`）。
  dailyCalls: { type: 'runtime', key: 'dailyCallLimit', env: 'DAILY_CALL_LIMIT', label: '每天回复调用上限（次）', min: 10, max: 100000 },
  // 🆕 2026-10-06（用户要的"改人设"）：**人设补充** —— 一小段话，追加到 system 人设**末尾**。
  //    ⚠️ 走 runtime（settings.json）而不是 env ⇒ **改完即时生效、不用重启**（cfg.persona.systemPrompt 是 getter，每次现算）。
  //    ⚠️ 但它**在 system 里** ⇒ 一改就会让 prompt 前缀缓存失效一次（命中价 1/50 → 全价）。
  //       所以：**改一次没关系，别频繁改**（面板提示里也写了）。
  personaExtra: { type: 'runtime', key: 'personaExtra', label: '人设补充（追加到人设末尾，留空=不改）', text: true, max: 1200 },

  // 2026-10-06 用户要的改人设本体：整段人设覆盖。
  //   他先说 改人设的功能呢，我做成了只能追加的人设补充；他随即说我原本要的人设修改呢
  //   ==> 补上这个：整段可改（留空 = 用代码里的默认）。
  //   优先级：personaText（整段覆盖）> 代码默认 + personaExtra（末尾追加）。
  //   同样在 system 里 ==> 改一次会让 prompt 前缀缓存失效一次（命中价 1/50 变成全价）。
  personaText: { type: 'runtime', key: 'personaText', label: '人设（整段可改，留空=用默认）', text: true, max: 4000 },
};

let cache = null;

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (raw && typeof raw === 'object') ? raw : {};
  } catch {
    return {};
  }
}

// 主进程/网页都会调。⚠️ 每次都**真读一次文件**（几 KB，代价极小），内容没变就直接复用旧对象。
//    🔴 曾经按 mtime 变化做缓存，结果**卡住不更新**：实测把"每天回复调用上限"从 1600 改成 3000、
//       面板显示"已保存"、`settings.snapshot()` 也读到 3000，**但额度区仍显示 1600**。
//    ⇒ 教训：**这种"必须实时反映"的配置，宁可靠"读内容 + 比对"，别靠 mtime 的相等性**
//      （同秒写入、别处回写、mtime 精度不够，都会让 mtime 跟踪错位）。
//    ⚠️ 另一个坑（我第一版修法就踩了）：**不能在"已经解析出对象"之后再挂 `_raw`**，
//       否则第一次比较时 `_raw` 还不存在，缓存判断直接失效（表现为"永远读不到新值"）。
function load(force) {
  // ⚠️ 测试模式（XLJ_NO_PERSIST=1）：**不读文件**，直接用内存里那份
  //    （否则"只更新内存"会被这次读文件覆盖掉，测试里读回旧值）。
  if (process.env.XLJ_NO_PERSIST === '1') return cache || (cache = {});
  let txt;
  try {
    txt = fs.readFileSync(FILE, 'utf8');
  } catch {
    if (!cache) cache = {};
    return cache;                       // 文件不存在 ⇒ 用内存里的（或空）
  }
  if (!force && cache && cache._raw === txt) return cache;
  try {
    const obj = JSON.parse(txt);
    const next = (obj && typeof obj === 'object') ? obj : {};
    Object.defineProperty(next, '_raw', { value: txt, enumerable: false });   // 非枚举 ⇒ 不会混进配置项
    cache = next;
  } catch {
    if (!cache) cache = {};
  }
  return cache;
}

function save(obj) {
  // 🔴 测试模式：`XLJ_NO_PERSIST=1` 时**只更新内存、不写文件**。
  //    原因（真踩过）：`test-brain.js` 会调 `settings.update()`，如果它真写 `data/settings.json`，
  //    就会**污染运行配置** —— 我一次测试把"每天回复调用上限"写成了 1200，之后自测就红了
  //    （真源被改），差点当成代码 bug。⇒ 和 `budget.js` 的 `XLJ_NO_PERSIST` 一个路子。
  const noPersist = process.env.XLJ_NO_PERSIST === '1';
  try {
    if (!noPersist) {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, FILE);
    }
    // ⚠️ 写完直接刷新内存缓存（并用与 load() 一致的方式挂 `_raw`）
    if (noPersist) {
      const next = Object.assign({}, obj);
      Object.defineProperty(next, '_raw', { value: JSON.stringify(obj), enumerable: false });
      cache = next;
    } else {
      load(true);
    }
    return { ok: true, persisted: !noPersist };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// ---------- 读：给业务用的取值（带 mtime 缓存）----------
// 返回 {} 里没有的键 = 用各自的默认值
function values() {
  const s = load();
  const out = {};
  for (const [k, spec] of Object.entries(SPEC)) {
    if (spec.type !== 'runtime') continue;
    // 🆕 文本类（如"人设补充"）不在 values() 里给 —— 用 text() 单独取
    if (spec.text) continue;
    const v = Number(s[spec.key]);
    if (Number.isFinite(v)) out[spec.key] = v;
  }
  return out;
}

// 🆕 取"文本类"设置（2026-10-06 加"人设补充"时要的）
//    ⚠️ 不能塞进 values()：那个函数是"数字专用"（`Number(...)` 会把字符串变成 NaN 丢掉）
function text(specKey, fallback) {
  const spec = SPEC[specKey];
  if (!spec || !spec.text) return fallback;
  const v = load()[spec.key];
  if (typeof v !== 'string' || !v.trim()) return fallback;
  return v;
}

// 单个取（带范围兜底）
function num(specKey, fallback) {
  const spec = SPEC[specKey];
  if (!spec) return fallback;
  const v = values()[spec.key];
  if (!Number.isFinite(v)) return fallback;
  if (spec.min != null && v < spec.min) return fallback;
  if (spec.max != null && v > spec.max) return fallback;
  return v;
}

// ---------- 掩码（密钥永不回显）----------
function mask(secret) {
  const s = String(secret || '');
  if (!s) return '';
  if (s.length <= 10) return s.slice(0, 2) + '…';
  return s.slice(0, 6) + '…' + s.slice(-3);
}

// 从 .env 里读一个键（只读取，不 exec）
function readEnv(key) {
  try {
    const txt = fs.readFileSync(ENV_FILE, 'utf8');
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(txt);
    return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
  } catch { return ''; }
}

// 写 .env（**先备份**，只改指定键，其余原样保留）
function writeEnv(key, value) {
  try {
    const txt = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const bak = `${ENV_FILE}.bak-${Date.now()}`;
    if (txt) fs.writeFileSync(bak, txt);
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    const line = `${key}=${value}`;
    const next = re.test(txt) ? txt.replace(re, line) : (txt.replace(/\s*$/, '') + `\n${line}\n`);
    fs.writeFileSync(ENV_FILE, next);
    return { ok: true, backup: bak };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// ---------- 给面板的"当前值"（密钥掩码）----------
function snapshot() {
  const s = load();
  const out = {};
  for (const [k, spec] of Object.entries(SPEC)) {
    if (spec.type === 'env') {
      const raw = spec.secret ? readEnv(spec.env) : '';
      out[k] = { label: spec.label, type: spec.type, value: spec.secret ? mask(raw) : raw, secret: !!spec.secret };
    } else {
      const v = s[spec.key];
      out[k] = spec.text
        ? { label: spec.label, type: spec.type, value: typeof v === 'string' ? v : '', text: true, max: spec.max }
        : {
          label: spec.label,
          type: spec.type,
          value: Number.isFinite(Number(v)) ? Number(v) : null,
          min: spec.min, max: spec.max,
        };
    }
  }
  return out;
}

// ---------- 改：白名单 + 校验 ----------
// 返回 { ok, applied: [...], needRestart: bool, why? }
function update(patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, why: '没有要改的内容' };
  const applied = [];
  let needRestart = false;
  const next = Object.assign({}, load());

  for (const [k, rawVal] of Object.entries(patch)) {
    const spec = SPEC[k];
    if (!spec) return { ok: false, why: `不允许修改的项：${k}` };   // 🔴 白名单：拒掉一切非登记键

    if (spec.type === 'env') {
      const v = String(rawVal == null ? '' : rawVal).trim();
      if (!v) return { ok: false, why: `${spec.label} 不能为空` };
      if (v.length > 200) return { ok: false, why: `${spec.label} 太长` };
      // ⚠️ 只接受"看起来像密钥"的值，避免手滑把中文/空格写进去
      if (/\s/.test(v)) return { ok: false, why: `${spec.label} 里不能有空格` };
      const r = writeEnv(spec.env, v);
      if (!r.ok) return { ok: false, why: `写 .env 失败：${r.why}` };
      applied.push(k);
      needRestart = true;
      continue;
    }

    // 🆕 文本类（`text: true`）：接受字符串，**不能走下面的 Number() 分支**
    //    （踩过：`personaExtra` 一开始没标 text ⇒ 被当成数字 ⇒ 报"必须是数字"、根本存不进去）
    if (spec.text) {
      const v = String(rawVal == null ? '' : rawVal).trim();
      if (v.length > (spec.max || 1200)) return { ok: false, why: `${spec.label} 太长（≤${spec.max || 1200} 字）` };
      next[spec.key] = v;          // 允许空串 = 清掉补充
      applied.push(k);
      continue;
    }

    const v = Number(rawVal);
    if (!Number.isFinite(v)) return { ok: false, why: `${spec.label} 必须是数字` };
    if (spec.min != null && v < spec.min) return { ok: false, why: `${spec.label} 不能小于 ${spec.min}` };
    if (spec.max != null && v > spec.max) return { ok: false, why: `${spec.label} 不能大于 ${spec.max}` };
    next[spec.key] = v;
    applied.push(k);
  }

  // 🆕 2026-10-06 用户：「人设补充为什么要单独做功能，直接在修改里面的末尾加上不就行了？」
  //    ⇒ 面板已去掉单独的补充框；这里再兜一层：**存了整段人设，就把旧的补充值清掉**
  //    （内容已经包含在整段里了；否则 config 的优先级会让补充看着像"没生效"）
  if (typeof next.personaText === 'string' && next.personaText.trim()) next.personaExtra = '';

  if (applied.some((k) => SPEC[k].type === 'runtime')) {
    const r = save(next);
    if (!r.ok) return { ok: false, why: `保存失败：${r.why}` };
  }
  return { ok: true, applied, needRestart };
}

module.exports = { SPEC, snapshot, update, values, num, text, mask, load, FILE, ENV_FILE };
