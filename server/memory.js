// ============================================================
//  memory.js —— 全群共享的"事实便签本"（2026-10-05 新增）
//
//  来源：朋友那套 `astrbot_plugin_unified_memory_v2` 的**内核思路**（分层/召回/
//        衰减/去重/保底配额），按大肥鱼的形态重新实现成 Node 版。
//        **没有引框架、没有抄那 5000 行、没有向量检索。**
//
//  🎯 用户拍板的范围（见仓库外 `记忆功能方案-2026-10-05.md`）：
//     · 作用域 = **全群共享**（一条记忆全群可召回，**没有"私密记忆"这个概念**）
//     · 第一版**只做显式记**（「记住 X」），**不做自动抽事实**
//       —— 自动抽会把群友随口一句话变成"长期事实"，风险大于收益
//     · 🔴 **敏感内容一律拒收**：全群共享 + 存私密 = 把私密内容挂在群里
//
//  ⚠️ 本模块**唯一的副作用是写 data/memory.json**：
//     不发消息、不 push 上下文、不调用模型、不联网。
//     所有对外的话都由 index.js 拼（这样"说什么"跟"记什么"解耦）。
// ============================================================

const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'memory.json');

const MAX_ITEMS_DEFAULT = 200;

function opt() {
  return cfg.policy?.memory || {};
}
function on() {
  return opt().enabled !== false;
}
function maxItems() {
  return Number(opt().maxItems) || MAX_ITEMS_DEFAULT;
}

let state = { version: 1, items: [], stats: { added: 0, removed: 0, recalled: 0, rejected: 0 } };

// ---------- 落盘（原子写：tmp + rename，照 power.js/budget.js 的既有做法）----------
function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.warn(`[mem] 存不下来（${e.message}）—— 这次的记忆会丢`);
  }
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && Array.isArray(raw.items)) {
      state = {
        version: 1,
        items: raw.items.filter((x) => x && typeof x.text === 'string'),
        stats: Object.assign({ added: 0, removed: 0, recalled: 0, rejected: 0 }, raw.stats || {}),
      };
    }
  } catch (e) {
    // 读坏了按"空"处理（宁可忘掉，也不能让它起不来）
    console.warn(`[mem] 记忆文件读不了（${e.message}），按空的处理`);
    state = { version: 1, items: [], stats: { added: 0, removed: 0, recalled: 0, rejected: 0 } };
  }
}

// ---------- 🔴 隐私护栏：敏感内容一律拒收 ----------
//
// 为什么必须做：作用域是**全群共享** —— 记下来的东西**全群都能被召回**。
//   朋友那版有"私密记忆（仅本人可见）"的概念；而我们没有这个概念，
//   所以**唯一安全的做法就是根本不记敏感内容**。
//
// ⚠️ 判据取向：**宁可拒收、不可错收**。拒收的代价只是"没记住"，
//    错收的代价是**在群里泄露**（不可撤回）。
const REJECT_RULES = [
  // 联系方式
  { re: /1[3-9]\d{9}/, why: '手机号' },
  // ⚠️ QQ 号没有固定前缀，只能靠"数字串 + 上下文"：
  //    带 QQ 字样时 5~12 位就拒；不带字样时，**9 位以上纯数字**也拒
  //    （群聊事实里出现 9 位以上连续数字，绝大多数是号/卡/单号，宁可拒）
  { re: /\b\d{5,12}\b(?=[\s\S]{0,12}(?:qq|QQ|扣扣))/, why: 'QQ 号' },
  { re: /\b\d{9,}\b/, why: '很长的数字串（号/卡/单号）' },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, why: '邮箱' },
  { re: /(?:微信|wx|vx|weixin)\s*[:：]?\s*[A-Za-z0-9_-]{5,}/i, why: '微信号' },
  { re: /\b\d{17}[\dXx]\b/, why: '身份证' },
  { re: /\b\d{16,19}\b/, why: '银行卡/长数字' },
  // 账号密码类
  { re: /(?:密码|口令|验证码|动态码|登录码|token|api\s*key|密钥|私钥)/i, why: '密码/密钥' },
  // 住址类
  // ⚠️ 踩过：原来的写法假设"数字紧挨着单位"（`\d+号楼`），
  //    而中文里带空格很常见（「住在 3 号楼 502」「宿舍楼 12-305」）⇒ 漏判。
  //    中文正则要用**允许空格**的写法，否则等于给敏感内容留后门。
  { re: /(?:住址|家庭住址|门牌)/, why: '住址' },
  { re: /\d+\s*(?:号|栋|幢|单元|室)/, why: '门牌/楼栋' },
  { re: /(?:宿舍|寝室|公寓)\s*(?:楼)?\s*[\d一二三四五六七八九十]/, why: '宿舍' },
  { re: /(?:身份证|户口本|学号|工号)\s*[:：]?\s*\S+/, why: '证件号' },
  // 健康 / 情绪隐私
  { re: /(?:抑郁|精神科|精神病|自残|自伤|怀孕|流产|确诊|癌症|艾滋)/, why: '健康隐私' },
  // 钱
  { re: /(?:银行卡|信用卡|支付宝|余额宝|花呗|借呗|贷款|还款)\s*[:：]?\s*\S*/, why: '财务信息' },
  // 别人不让说的
  { re: /(?:别告诉|不要告诉|别跟人说|秘密|私密|悄悄话|我只跟你说)/, why: '明确要求保密' },
];

// 返回 { ok: true } 或 { ok: false, why: '手机号' }
function checkPrivacy(text) {
  const s = String(text || '');
  for (const r of REJECT_RULES) if (r.re.test(s)) return { ok: false, why: r.why };
  return { ok: true };
}

// ---------- 🆕 解析"记 / 忘 / 看"这三种显式指令 ----------
// 返回 null（不是指令）或 { action, content? }
// ⚠️ 判据要窄：必须是**以祈使动词开头**的句子（朋友的版本也是这个思路），
//    否则"我记住了"这种陈述句会被误当成"要记东西"。
const CMD_RE = {
  add: /^记(?:住|一下|下来|下)?\s*[:：,，]?\s*(.+)$/,
  del: /^(?:忘(?:掉|了)|别记(?:了)?|删(?:掉)?(?:记忆)?)\s*[:：,，]?\s*(.+)$/,
  list: /^(?:你都记得(?:我|什么|啥)|列出你记得的|你记得什么|记住了什么|看看记住的)/,
};

function parseCommand(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (CMD_RE.list.test(s)) return { action: 'list' };
  const del = s.match(CMD_RE.del);
  if (del && del[1] && del[1].trim()) return { action: 'del', content: del[1].trim() };
  const add = s.match(CMD_RE.add);
  if (add && add[1] && add[1].trim()) {
    const content = add[1].trim();
    // 🔴 反例：**反问句不能当成"要记东西"**。
    //    实测踩到：「记住这个干嘛」被解析成 add，内容成了"这个干嘛" ——
    //    万一真存进去，就是一条垃圾记忆（而且以后会被召回）。
    if (/^(?:这个|那个|它|这|那)?\s*(?:干嘛|干什么|干啥|做什么|有什么用|为什么)/.test(content)) return null;
    // 问号结尾的一律当疑问句（要记的东西一般不会以问号结束）
    if (/[?？]\s*$/.test(content)) return null;
    if (content.length < 2) return null;
    return { action: 'add', content };
  }
  return null;
}

// ---------- 记 ----------
// 返回 { ok, why?, item? }；why 是给 index.js 拼话用的原因（不是给人看的句子）
function add(text, by = '') {
  if (!on()) return { ok: false, why: 'disabled' };
  const content = String(text || '').trim();
  if (!content) return { ok: false, why: 'empty' };
  if (content.length > 200) return { ok: false, why: 'too-long' };

  const pv = checkPrivacy(content);
  if (!pv.ok) {
    state.stats.rejected += 1;
    save();
    return { ok: false, why: 'privacy', category: pv.why };
  }

  // 内容完全一样的不重复记（把 lastHit 更新一下就行）
  const dup = state.items.find((x) => x.text === content);
  if (dup) {
    dup.ts = Date.now();
    save();
    return { ok: true, item: dup, dup: true };
  }

  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: content,
    keyword: pickKeyword(content),
    by: String(by || '').slice(0, 6),   // 只留前 6 位，够审计、不外泄完整 id
    ts: Date.now(),
    hitCount: 0,
    lastHit: 0,
  };
  state.items.push(item);
  state.stats.added += 1;

  // 上限淘汰：**先打日志再丢**（绝不静默丢数据）
  const cap = maxItems();
  while (state.items.length > cap) {
    const idx = pickEvictIndex();
    const gone = state.items.splice(idx, 1)[0];
    console.log(`[mem] 条数到上限（${cap}），淘汰最不常用的：「${String(gone?.text || '').slice(0, 20)}」`);
  }
  save();
  return { ok: true, item };
}

// 取第一个 2 字以上的"词"当召回锚点（中文就取前 2-4 字，够用且简单）
function pickKeyword(text) {
  const s = String(text || '').replace(/^[：:，,。.\s]+/, '');
  const m = s.match(/[A-Za-z0-9]{3,}|[\u4e00-\u9fa5]{2,}/);
  return m ? m[0].slice(0, 8) : s.slice(0, 4);
}

// 淘汰谁：**最少被用到** +（并列时）**最旧**
function pickEvictIndex() {
  let best = 0;
  for (let i = 1; i < state.items.length; i++) {
    const a = state.items[i];
    const b = state.items[best];
    if ((a.hitCount || 0) < (b.hitCount || 0)) best = i;
    else if ((a.hitCount || 0) === (b.hitCount || 0) && (a.ts || 0) < (b.ts || 0)) best = i;
  }
  return best;
}

// ---------- 删 ----------
function remove(keyword) {
  if (!on()) return { ok: false, why: 'disabled', removed: 0 };
  const k = String(keyword || '').trim();
  if (!k) return { ok: false, why: 'empty', removed: 0 };
  const before = state.items.length;
  const gone = state.items.filter((x) => x.text.includes(k) || String(x.keyword || '').includes(k));
  state.items = state.items.filter((x) => !(x.text.includes(k) || String(x.keyword || '').includes(k)));
  const removed = before - state.items.length;
  if (removed) {
    state.stats.removed += removed;
    save();
  }
  return { ok: removed > 0, removed, texts: gone.map((x) => x.text) };
}

// ---------- 双字词余弦（项目里已验证过的相似度思路，不引向量）----------
function bigrams(s) {
  const clean = String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const out = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  if (!out.length && clean) out.push(clean);
  return out;
}

function cosine(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const map = new Map();
  for (const x of A) map.set(x, (map.get(x) || 0) + 1);
  let dot = 0;
  for (const y of B) if (map.has(y)) dot += map.get(y);
  return dot / (Math.sqrt(A.length) * Math.sqrt(B.length));
}

// 打分：字面包含 = 强信号；否则看双字词余弦
function scoreOf(query, item) {
  const q = String(query || '');
  const t = String(item.text || '');
  if (!q || !t) return 0;
  if (t.includes(q) || q.includes(t)) return 1;
  if (item.keyword && q.includes(String(item.keyword))) return 0.9;
  return cosine(q, t);
}

// ---------- 召回（纯计算，不产生副作用；命中计数由调用方决定要不要记）----------
// 返回 [{ text, score, id }]，已按分数降序、已按预算裁剪
function recall(query, opts2 = {}) {
  if (!on()) return [];
  const minScore = Number.isFinite(opts2.minScore) ? opts2.minScore
    : (Number(opt().minScore) || 0.25);
  const maxItemsOut = Number(opts2.maxItems) || Number(opt().recallMaxItems) || 3;
  const maxChars = Number(opts2.maxChars) || Number(opt().recallMaxChars) || 120;

  const scored = state.items
    .map((x) => ({ id: x.id, text: x.text, score: Number(scoreOf(query, x).toFixed(3)) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const out = [];
  let chars = 0;
  for (const x of scored) {
    if (out.length >= maxItemsOut) break;
    if (chars + x.text.length > maxChars && out.length) break;
    out.push(x);
    chars += x.text.length;
  }
  return out;
}

// 召回命中后更新"用进废退"的计数（**调用方显式调**，这样 recall 本身是纯函数）
function markHit(ids) {
  const now = Date.now();
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let n = 0;
  for (const x of state.items) {
    if (set.has(x.id)) { x.hitCount = (x.hitCount || 0) + 1; x.lastHit = now; n += 1; }
  }
  if (n) { state.stats.recalled += 1; save(); }
  return n;
}

// 逗号/换行拼给模型看的一段（**纯函数**）
function render(items, header) {
  if (!items || !items.length) return '';
  const head = header || opt().header || '【群里记得的事】';
  return head + '\n' + items.map((x) => `- ${x.text}`).join('\n');
}

// ---------- 看 ----------
function list(limit = 10) {
  const n = Number(limit) || 10;
  const sorted = state.items.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { total: state.items.length, shown: sorted.slice(0, n).map((x) => x.text) };
}

function stats() {
  return {
    enabled: on(),
    count: state.items.length,
    max: maxItems(),
    ...state.stats,
  };
}

// ---------- 给自测 / 运维用 ----------
function _reset() {
  state = { version: 1, items: [], stats: { added: 0, removed: 0, recalled: 0, rejected: 0 } };
}
function _all() { return state.items.map((x) => x.text); }

load();

module.exports = {
  parseCommand, checkPrivacy, add, remove, recall, markHit, render, list, stats,
  // 给自测用
  _reset, _all, _file: FILE, _scoreOf: scoreOf, _cosine: cosine,
};
