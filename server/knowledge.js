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
    hardTimeoutMs: 20000,  // 等不到就转后台，最多跑到这里（回来写缓存）
    title: '微博实时热搜',
    maxLines: 8,
  },
  douyin: {
    path: '/v2/douyin?encoding=text',
    ttlMs: 10 * 60 * 1000,
    waitMs: 2000,
    hardTimeoutMs: 20000,
    title: '抖音热搜',
    maxLines: 8,
  },
  history: {
    path: '/v2/today_in_history?encoding=text',
    ttlMs: 6 * 60 * 60 * 1000,
    waitMs: 1500,
    hardTimeoutMs: 15000,
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

// 归一化：去掉 @、名字里的装饰、标点、空白 —— 用来判"裸主题"
function bareKey(text) {
  return String(text || '')
    .replace(/<@[^>]+>/g, '')
    .replace(/@/g, '')                                // 手打的 @ 也去掉（`<@openid>` 上面已处理）
    .replace(/[蓝色大肥鱼小蓝鲸鲸少女嘉然]/g, '')   // 顺带把"叫它"的字去掉
    .replace(/[\s\u3000，。！？、~,.!?：:；;「」【】（）()]/g, '');
}

// 裸主题词：**整句就是在喊这个主题**（如「历史上的今天」）——
// 🔴 2026-10-07 服务器日志抓到的洞：用户直接发「历史上的今天」这五个字，
//    我的判据要求"带疑问词"⇒ 没触发 ⇒ 鱼答"我一时没对上号"（明明能查却不查）。
//    ⇒ 补一条：归一化后**正好等于**某个主题词，也算"在要"。
const BARE_TOPICS = [
  ['历史上的今天', 'history'], ['今天是什么日子', 'history'], ['今天是啥日子', 'history'],
  ['抖音热搜', 'douyin'], ['抖音热榜', 'douyin'],
  ['微博热搜', 'hot'], ['微博热榜', 'hot'], ['今日热搜', 'hot'], ['今天的热搜', 'hot'],
  ['热搜', 'hot'], ['热榜', 'hot'], ['热点', 'hot'],
];

function detect(text) {
  const s = String(text || '');
  if (!s || s.length > 200) return '';
  // ① 裸主题（整句 = 主题词）⇒ 直接算"在要"
  const bare = bareKey(s);
  if (bare && bare.length <= 12) {
    for (const [word, kind] of BARE_TOPICS) {
      if (bare === bareKey(word)) return kind;
    }
  }
  // ② 否则要求"在问"（带疑问/请求语气），避免「这热搜真离谱」也去调外部接口
  if (!ASK_RE.test(s)) return '';
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
// isWarm=true 时打日志（后台预热要留痕 —— 否则"到底热上了没"根本看不出来）
function startFetch(kind, url, hardMs, isWarm) {
  const t0 = Date.now();
  const p = fetchText(url, hardMs)
    .then((raw) => {
      if (!raw) {
        if (isWarm) console.log('[kb] 预热失败：' + kind + '（没拿到内容 ' + (Date.now() - t0) + 'ms）');
        return '';
      }
      const out = format(kind, raw);
      if (!out) {
        if (isWarm) console.log('[kb] 预热失败：' + kind + '（解析不出条目）');
        return '';
      }
      cache.set(kind, { at: Date.now(), text: out });
      if (isWarm) console.log('[kb] 预热完成：' + kind + '（' + out.length + ' 字，' + (Date.now() - t0) + 'ms）');
      return out;
    })
    .catch(() => '')
    .then((v) => { if (inflight.get(kind) === p) inflight.delete(kind); return v; });
  inflight.set(kind, p);
  return p;
}

// ---------- 后台预热（2026-10-07 加）----------
// 🔴 为什么需要它：服务器日志实测（13:27:10「抖音热搜有啥」→ 回复只用了 2 秒、
//    没有 [kb] 行）⇒ **冷缓存 + 只等 2.5 秒没等到 ⇒ 空手回话**，鱼只好编"我没刷到"。
//    而"有界等待"这次不能靠调大（会拖慢回话）⇒ **正解是让缓存先热起来**：
//    后台定期把热榜刷进缓存 ⇒ **第一次问就命中、0 毫秒**。
//    ⚠️ 预热**不计入"每日上限"**（那是给"被人问"用的防刷闸）：预热跑在定时器上，
//      频率天然有界（每 10 分钟一轮），而且 API 免费。
const warmState = { started: false, rounds: 0, lastAt: 0, lastLog: '' };

function warmOnce(opts) {
  const o = opts || {};
  const base = o.base || BASE_DEFAULT;
  const now = Date.now();
  const todo = [];
  for (const [kind, src] of Object.entries(SOURCES)) {
    const hit = cache.get(kind);
    // 只在"缓存缺失或已过 ttl 的一半"时刷（避免白刷）
    if (!hit || now - hit.at > src.ttlMs * 0.5) todo.push(kind);
  }
  if (!todo.length) return 0;
  for (const kind of todo) {
    if (inflight.has(kind)) continue;
    startFetch(kind, base + SOURCES[kind].path, SOURCES[kind].hardTimeoutMs || 15000, true);
  }
  warmState.rounds += 1;
  warmState.lastAt = now;
  warmState.lastLog = todo.join(',');
  // ⚠️ 后台预热要**留痕**：不然"到底有没有在预热、热上了没"根本看不出来
  //    （2026-10-07 我就是靠"douyin 没进缓存"才查出它要 4~12 秒）
  if (!o.quiet) console.log('[kb] 预热：' + warmState.lastLog + '（后台抓取，不计入每日上限）');
  return todo.length;
}

// 启动预热：**等一会儿再开始**（别和启动时的其它初始化抢资源），之后定时刷新。
// ⚠️ 定时器一律 `unref()` —— 不阻止进程退出（本项目 budget.js 的余额刷新也是这个写法）。
function startWarm(opts) {
  if (warmState.started) return false;
  if (opts && opts.enabled === false) return false;
  warmState.started = true;
  const everyMs = Number(opts && opts.everyMs) || 10 * 60 * 1000;
  const first = setTimeout(() => {
    try { warmOnce(opts); } catch (e) { /* 预热失败绝不影响主流程 */ }
  }, Number(opts && opts.firstDelayMs) || 20000);
  if (first && typeof first.unref === 'function') first.unref();
  const timer = setInterval(() => {
    try { warmOnce(opts); } catch (e) { /* 同上 */ }
  }, everyMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return true;
}

// ---------- 给自测/排查用 ----------
function _stats() {
  return { day: dayStamp, dayCalls, cached: Array.from(cache.keys()), warm: warmState };
}
function _reset() {
  cache.clear(); inflight.clear(); dayStamp = ''; dayCalls = 0;
  warmState.started = false; warmState.rounds = 0; warmState.lastAt = 0; warmState.lastLog = '';
}
function _setDayForTest(stamp, calls) {
  dayStamp = stamp; dayCalls = calls || 0;
}

module.exports = {
  lookup, detect, format, SOURCES, BASE_DEFAULT, bareKey,
  warmOnce, startWarm,
  _stats, _reset, _setDayForTest,
};
