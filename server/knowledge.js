// ============================================================
//  knowledge.js —— 「点播式知识」（2026-10-07 用户拍板方案 A）
//
//  🎯 用户需求：「找一下有没有群机器人常用的知识库」→ 选了方案 A。
//     做法：**群里有人"问"的时候，才去取一次**（热搜 / 历史上的今天），
//     拼成一小段事实注给模型，让鱼用自己的话说出来。
//
//  🔴 四条设计红线（为什么这么做，别改坏）：
//    ① **绝不挂主链路**：调用点放在「已经决定要回话之后」——
//       外部接口实测延迟 **1~5 秒**（见 2026-10-07 实测），放前面会让每次回话都变慢。
//    ② **缓存**：热搜 10 分钟、历史上的今天 6 小时 ⇒ 同一批人问，只取一次。
//    ③ **超时 3 秒** + **每日上限**：防止慢接口拖住回话、防止被刷爆调用。
//    ④ **fail-open**：取不到就返回空串（照常回话，只是没有这段事实），
//       **绝不抛错、绝不因为外部挂了就不回**。
//
//  ⚠️ 零依赖：只用 node 内置能力 + 全局 fetch（Node 18+）。
//  ⚠️ 数据源：https://github.com/vikiboss/60s（免费开源、无需 key）
//     —— 已实测从阿里云北京可达；路径约定是 `/v2/<名字>`（平铺）。
// ============================================================

const BASE_DEFAULT = 'https://60s.viki.moe';

// 数据源登记（path + 缓存时长 + 标题 + 最多取几条 + **各自的超时**）
// 🔴 超时为什么按源分开：2026-10-07 在服务器实测，各源速度差很多 ——
//    历史上的今天 ≈1.2s、抖音热搜 ≈2.5s、**微博热搜 3.5~7.8s**（会抖动）
//    ⇒ 用同一个 3 秒会把微博热搜全部掐掉（我第一版就是这么错的，被服务器实测抓出来）。
//    ⚠️ 但它们都还在"有界"范围内：慢的那个也只等 6 秒，且**只在有人问的时候**才等。
const SOURCES = {
  hot: {
    path: '/v2/weibo?encoding=text',
    ttlMs: 10 * 60 * 1000,
    waitMs: 2500,          // 用户最多等这么久
    hardTimeoutMs: 9000,   // 等不到就转后台，最多跑到这里（回来写缓存）
    title: '微博实时热搜',
    maxLines: 8,
  },
  douyin: {
    path: '/v2/douyin?encoding=text',
    ttlMs: 10 * 60 * 1000,
    waitMs: 2000,
    hardTimeoutMs: 6000,
    title: '抖音热搜',
    maxLines: 8,
  },
  history: {
    path: '/v2/today_in_history?encoding=text',
    ttlMs: 6 * 60 * 60 * 1000,
    waitMs: 1500,
    hardTimeoutMs: 5000,
    title: '历史上的今天',
    maxLines: 5,
  },
};

// ---------- 触发判据（故意做窄）----------
// 🔴 原则：**必须"在问"，不能只是"提到"** —— 否则「这热搜真离谱」也会触发一次外部调用。
//    做法：命中主题词 **且** 句中带疑问/请求语气（什么/啥/看看/来点/多少/？…）。
const TOPIC_RES = [
  { kind: 'history', re: /历史上的今天|今天是什么日子|今天是啥日子/ },
  { kind: 'douyin', re: /抖音.{0,4}(热搜|热榜|热点)/ },
  { kind: 'hot', re: /(微博|全网|今天|现在|最近)?\s*(热搜|热榜|热点)/ },
];
const ASK_RE = /[？?]|什么|啥|多少|哪些|看看|讲讲|说说|来点|有没有|咋样|怎么样|是啥|有什么/;

function detect(text) {
  const s = String(text || '');
  if (!s || s.length > 200) return '';
  if (!ASK_RE.test(s)) return '';          // 不是"在问" ⇒ 不触发
  for (const t of TOPIC_RES) {
    if (t.re.test(s)) return t.kind;
  }
  return '';
}

// ---------- 运行时状态 ----------
const cache = new Map();     // kind -> { at, text }
const inflight = new Map();  // kind -> Promise（同一个源并发时只发一次请求）
let dayStamp = '';
let dayCalls = 0;

function todayStamp(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function rollover(now) {
  const s = todayStamp(now);
  if (s !== dayStamp) { dayStamp = s; dayCalls = 0; }
}

// 不会拖住进程的 sleep（定时器 unref）
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

// ---------- 取数（超时 + fail-open）----------
async function fetchText(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    const t = await r.text();
    return t ? t.trim() : null;
  } catch {
    return null;                              // 超时/网络错/DNS 挂了 ⇒ 一律当"取不到"
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 把原始文本压成"一小段事实" ----------
// 60s 的 `?encoding=text` 已经是人话（标题 + 编号列表），这里只做裁剪与拼装：
// 目的：**又短又有用**（它要进 user 消息，太长就是白花钱）。
function format(kind, raw) {
  const cfg = SOURCES[kind];
  if (!cfg || !raw) return '';
  const lines = String(raw).split('\n').map((x) => x.trim()).filter(Boolean);
  const items = [];
  for (const l of lines) {
    // 只要"编号条目"（`1. xxx (123)`），跳过标题行/空行
    const m = /^\d+[.、]\s*(.+)$/.exec(l);
    if (!m) continue;
    items.push(m[1].replace(/\s*\(\d+\)\s*$/, ''));   // 去掉热度数字（对聊天没用，还占字）
    if (items.length >= cfg.maxLines) break;
  }
  if (!items.length) return '';
  return cfg.title + '（刚查的）：' + items.join('；');
}

// ---------- 对外：给这条消息找一段"事实" ----------
// 返回**字符串**（拿不到就是空串）—— 调用方直接拼进 note，不需要判断 null。
//
// 🔴 核心策略：**有界等待 + 后台预热缓存**（2026-10-07 服务器实测后改的）：
//    实测这个 API 的延迟**剧烈抖动**（同一个"历史上的今天"从 1.2s 抖到 >3s；
//    微博热搜 2.6s~7.8s）⇒ **固定超时不可能既快又准**：
//      · 设短了 ⇒ 经常取不到（白问一次）；
//      · 设长了 ⇒ 回话被拖住好几秒。
//    解法：**只等一小会儿（waitMs）**；如果没等到，**不让用户继续等** ——
//    请求转后台继续跑，**回来就写进缓存**；这次先空手（照常回话），
//    **下次再有人问，就是缓存命中、0 毫秒**。
//    ⚠️ 这和项目里 GitHub 预览图的 `warmOgImage()` 是同一个套路（先预热、到时必中）。
async function lookup(text, opts) {
  const o = opts || {};
  const base = o.base || BASE_DEFAULT;
  const dailyLimit = Number(o.dailyLimit) || 100;
  const now = Date.now();

  if (o.enabled === false) return '';
  const kind = detect(text);
  if (!kind) return '';

  const src = SOURCES[kind];
  const hit = cache.get(kind);
  if (hit && now - hit.at < src.ttlMs) return hit.text;   // 命中缓存：0 毫秒

  rollover(now);

  // 有请求在飞 ⇒ 就等它（不重复发请求）
  let p = inflight.get(kind);
  if (!p) {
    if (dayCalls >= dailyLimit) return '';                // 到上限：静默不取
    dayCalls += 1;
    p = startFetch(kind, base + src.path, src.hardTimeoutMs || 9000);
  }

  const waited = await Promise.race([p, sleep(src.waitMs || 2500).then(() => null)]);
  if (waited) return waited;                              // 等到了
  // 没等到：请求留在后台继续（回来会写缓存），这次空手返回 —— **绝不拖住回话**
  return '';
}

// 发起一次抓取（并发去重），成功就写缓存；**永不抛错**
function startFetch(kind, url, hardMs) {
  const src = SOURCES[kind];
  const p = fetchText(url, hardMs)
    .then((raw) => {
      if (!raw) return '';
      const out = format(kind, raw);
      if (out) cache.set(kind, { at: Date.now(), text: out });
      return out;
    })
    .catch(() => '')
    .then((v) => { if (inflight.get(kind) === p) inflight.delete(kind); return v; });
  inflight.set(kind, p);
  return p;
}

// ---------- 给自测/排查用 ----------
function _stats() {
  return { day: dayStamp, dayCalls, cached: Array.from(cache.keys()) };
}
function _reset() {
  cache.clear(); dayStamp = ''; dayCalls = 0;
}
function _setDayForTest(stamp, calls) {
  dayStamp = stamp; dayCalls = calls || 0;
}

module.exports = {
  lookup, detect, format, SOURCES, BASE_DEFAULT,
  _stats, _reset, _setDayForTest,
};
