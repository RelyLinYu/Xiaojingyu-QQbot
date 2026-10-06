// ============================================================
//  花费预算 —— 双保险：每天上限 + 总计上限
//
//  · 每天 3 元  → 防"某天被人刷爆"
//  · 总计 10 元 → 防"慢慢漏光"（等于你充的钱花完就永久停）
//
//  为什么要本地记账：
//    平台余额用光虽然也会报错，但你**看不到"今天花了多少"**，
//    也没法设"每天最多多少"。本地记账能做到：
//      · 每次调用前查额度，超了连请求都不发（不白花）
//      · 每日/总计两个维度都有硬上限
//      · 数据落盘 data/budget.json，重启不丢
//
//  记账依据：API 返回的 usage 里真实的 prompt_tokens / completion_tokens。
//  ⚠️ 除了"缓存命中"那一段，其余都按**高峰价 + 缓存未命中**保守计算（高估），
//     实际只会花得更少。缓存命中按真实的 1/50 价算（见 record() 的注释）。
// ============================================================

// 缓存命中的单价 = 未命中价的 1/50
//   官方价目：空闲 0.02/1/4、高峰 0.04/2/8 —— 命中/未命中 恒为 1/50
const CACHE_HIT_RATIO = 0.02;

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const settings = require('./settings');   // 🆕 面板可改的参数（即时生效的那些）

const STATE_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'budget.json');

// ⚠️ 测试模式：XLJ_NO_PERSIST=1 时**不读也不写**任何文件。
//    原因：test-brain.js 会间接引入本模块，如果它读写真实的 data/budget.json，
//    就会出现两个问题 —— ① 测试污染真实预算数据 ② 测试结果依赖运行状态（时好时坏）。
//    确定性是测试的底线。
const NO_PERSIST = process.env.XLJ_NO_PERSIST === '1';

function todayKey() {
  // 按北京时间分天（和静默时段、日额度重置一致）
  const d = new Date();
  const bj = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  return `${bj.getFullYear()}-${bj.getMonth() + 1}-${bj.getDate()}`;
}

// 🆕 跨天清的"今日调用次数"（2026-10-05 新增）
//
// 🔴 为什么必须单独有这个字段：`state.calls` 是**终身累计**（只增不清），
//    但启动横幅和日志网页一直把它当"调用次数"显示在"今日"旁边 ——
//    实测误导：横幅在 18 分钟内显示 10712 → 10735，而当天真实只有 1,247 次调用。
//    用户就是这么发现问题的（「调用咋可能上万次，有点误导」）。
// ⇒ 分工定死：**`dayCalls` 给人和闸门看（跨天清零）；`calls` 只当终身统计，别拿去显示"今日"**。
function freshState() {
  return {
    day: todayKey(),
    daySpent: 0,      // 今天花了多少
    dayCalls: 0,      // 🆕 今天调用了几次模型（跨天清零）
    spentYuan: 0,     // 累计花了多少（不随跨天清零）
    calls: 0,         // 终身累计调用次数（不随跨天清零，别当"今日"用）
    blocked: 0,
    byModel: {},
    warned: false,
    // 🆕 "没钱了"在每个群**每天最多说一次**（scope → 日期）
    //    见 shouldAnnounceStop() 的注释
    stopAnnounced: {},
  };
}

let state = freshState();

function load() {
  if (NO_PERSIST) return;
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    state = Object.assign(freshState(), raw);
    // 旧版 budget.json 没有 dayCalls 字段 → 兜底成 0（别让横幅显示 undefined）
    if (!Number.isFinite(Number(state.dayCalls))) state.dayCalls = 0;
    // 跨天：只清零"今日"，累计保留
    rollover(true);
    console.log(`[budget] 今日 ¥${state.daySpent.toFixed(4)} / ¥${cfg.budget.dailyLimitYuan}　`
      + `累计 ¥${state.spentYuan.toFixed(4)} / ¥${cfg.budget.totalLimitYuan}　`
      + `今日 ${state.dayCalls}/${cfg.policy.dailyCallLimit} 次调用（终身累计 ${state.calls} 次）`);
  } catch (e) {
    console.warn('[budget] 读取失败，从零开始:', e.message);
  }
}

function save() {
  if (NO_PERSIST) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // ⚠️ 把上限也写进去。日志网页是独立进程，读不到 config 的运行时值，
    //    只靠文件里的数字才能显示"还剩多少"。
    const out = Object.assign({}, state, {
      dailyLimit: cfg.budget.dailyLimitYuan,
      totalLimit: cfg.budget.totalLimitYuan,
      // 🆕 顺手把"官方口径"也写进文件 —— 日志网页是**独立进程**，
      //    读不到本模块的内存，只能靠这个文件显示"累计已花（官方）"。
      // ⚠️ 这里会覆盖 `state.official`（老版本存过）⇒ 文件里不会留过期字段。
      official: balanceInfo(),
      savedAt: new Date().toISOString(),
    });
    fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2));
  } catch (e) {
    console.warn('[budget] 落盘失败:', e.message);
  }
}

function rollover(quiet) {
  const today = todayKey();
  if (state.day !== today) {
    if (!quiet) {
      console.log(`[budget] 跨天重置今日额度（${state.day} → ${today}，昨天花了 ¥${state.daySpent.toFixed(4)}`
        + ` · 昨天 ${state.dayCalls || 0} 次调用）`);
    }
    state.day = today;
    state.daySpent = 0;
    state.dayCalls = 0;   // 🆕 今日次数也必须跨天清（否则横幅又变回"终身累计"那个 bug）
    state.warned = false;
    if (!quiet) save();
  }
}

// ---------- 单价 ----------
// ⚠️ 这个函数连续改错三次，教训写在这里：
//    错法1: key.startsWith(model)  → 免费的那个 命中 '同名前缀-x' 这个收费的
//    错法2: model.startsWith(key)  → 免费的那个 命中 '同名前缀' 这个收费的
//    错法3: 边界判断+最长匹配      → 仍然命中（自己没登记，前缀恰好合法）
//    ✅ 正解：免费模型**显式登记**，不靠"查不到就是免费"这种推断。
const FREE = [0, 0];

function priceOf(model) {
  const table = cfg.budget.priceTable || {};
  if (table[model]) return table[model];
  const hit = Object.keys(table)
    .filter((k) => model.startsWith(k))
    .filter((k) => {
      const rest = model.slice(k.length);
      return rest === '' || /^[-_.]/.test(rest);   // 后一位必须是分隔符或结尾
    })
    .sort((a, b) => b.length - a.length)[0];       // 取最长（最具体）
  return hit ? table[hit] : null;
}

function isFreeModel(model) {
  return (cfg.budget.freeModels || []).some((m) => model === m || model.startsWith(m + '-'));
}

// 单价表里最贵的那一档 —— 给「未登记模型」做保守兜底用。
//
// 为什么需要它（2026-09-21 踩过的坑）：
//   原来 record() 遇到"表里查不到的模型"是**直接 return，一分钱都不记**。
//   后果：换一个没登记的新模型名 → daySpent 永远是 0 → **¥3/天 的上限彻底失效**，
//   花多少都不拦。而这条路径**恰恰最该拦**（新模型通常更贵）。
//   现在改成按最贵已知价计费：宁可高估，让它早点停。
//   真要免费，就显式写进 cfg.budget.freeModels —— 那才叫"登记"。
function mostExpensivePrice() {
  const table = cfg.budget.priceTable || {};
  const all = Object.values(table).filter((v) => Array.isArray(v) && v.length >= 2);
  if (!all.length) return [10, 30];   // 表是空的也给个保守值，绝不返回"免费"
  return all.reduce((a, b) => (b[0] + b[1] > a[0] + a[1] ? b : a));
}

// ---------- 🆕 官方余额（2026-10-05 新增，用户的提议）----------
//
// 「话说额度不能直接同步官方的吗」—— 能，而且**比本地推算准**。
// DeepSeek 有 `GET /user/balance`：返回 is_available + balance_infos[]
// （currency / total_balance / granted_balance / topped_up_balance）。
//
// 🔴 为什么本地账本**不能**被它取代：
//   · 官方只给"账户还剩多少"，**没有"今天花了多少"** —— 而 ¥3/天 那道闸只能本地算；
//   · 官方**不给"本次请求花了多少"** —— 单次成本只能本地按 token × 单价算。
// ⇒ 所以正确分工是：**本地管"日"，官方管"总额"**（`totalLimitYuan` 降级成兜底）。
//
// 🔴 为什么要这道闸（实测数据）：官方余额 ¥3.94，而本地账本推算"还剩 ¥5.42" ——
//    差 ¥1.5，因为**事件日志 09-22 才开始**、更早的花费没进账本。
//    ⇒ "推算余额"永远有误差，**只有问官方才是真的**。
//
// ⚠️ 三条安全设计（都踩过同类坑）：
//   ① **只读、永不写**：本地账本是"花了多少"，官方余额是"还剩多少"，绝不混改；
//   ② **查不到就不拦**（fail-open）：网络抖一下不能把机器人弄哑 —— 还有本地那道兜底；
//   ③ **缓存 10 分钟**：不能每来一条消息就发一次 HTTP（那会把回话拖慢）。
const BALANCE_TTL = 10 * 60 * 1000;
let balCache = { at: 0, total: null, granted: null, currency: '', available: null, err: '' };

function isBalanceCheckOn() {
  return cfg.budget.officialBalance !== false;
}

async function fetchOfficialBalance(force = false) {
  if (!isBalanceCheckOn()) return null;
  const now = Date.now();
  if (!force && balCache.total !== null && now - balCache.at < BALANCE_TTL) return balCache;
  try {
    const key = process.env.AI_API_KEY || '';
    const base = String(process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
    if (!key) throw new Error('没有 AI_API_KEY');
    const r = await fetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const info = (j.balance_infos || []).find((b) => b.currency === 'CNY') || (j.balance_infos || [])[0] || {};
    balCache = {
      at: now,
      total: Number(info.total_balance),
      granted: Number(info.granted_balance),
      currency: info.currency || 'CNY',
      available: j.is_available !== false,
      err: '',
    };
    // ⚠️ 用户 2026-10-05 明确说「日志不需要加官方余额」⇒ **这里不再往日志里打余额**。
    //    查询本身保留（"总额"那道闸要用它、网页要显示"累计已花"的官方口径）。
    // 🔴 但**必须落盘**：日志网页是独立进程，只能从 budget.json 读到它。
    //    （踩过：只 console.log 没 save，结果网页上一直显示"查不到"。）
    save();
    return balCache;
  } catch (e) {
    // 查不到就记下来，但**不拦**（还有本地兜底）
    balCache = { ...balCache, err: e.message, available: null };
    return null;
  }
}

function balanceInfo() {
  const total = balCache.total;
  // 🆕 「累计已花」的**官方口径** = 锚点 − 当前余额（用户要的是这个同步）
  const anchor = Number(cfg.budget.balanceAnchorYuan) || 0;
  const spent = (total !== null && anchor > 0) ? Number((anchor - total).toFixed(4)) : null;
  return {
    ok: total !== null,
    total,
    spent,                                   // 🆕 官方口径的累计已花（没配锚点就是 null）
    anchor: anchor || null,
    granted: balCache.granted,
    currency: balCache.currency,
    available: balCache.available,
    at: balCache.at ? new Date(balCache.at).toISOString() : null,
    ageMs: balCache.at ? Date.now() - balCache.at : null,
    err: balCache.err || '',
    threshold: Number(cfg.budget.officialWarnYuan) || 1,
  };
}

// 给自测用：不联网，直接喂一个"官方余额"进来
function setBalanceForTest(total, opts = {}) {
  balCache = {
    at: Date.now(),
    total: total === null ? null : Number(total),
    granted: 0,
    currency: 'CNY',
    available: opts.available !== false,
    err: opts.err || '',
  };
}

// ---------- 调用前：能不能花？ ----------
// 返回 { ok, reason }。reason 是给群里看的理由（会直接发出去）。
function canSpend() {
  rollover();
  if (!cfg.budget.enabled) return { ok: true, reason: '' };

  const dl = cfg.budget.dailyLimitYuan;
  const tl = cfg.budget.totalLimitYuan;

  // 先判总计（更严重：直接就是没钱了）
  if (tl > 0 && state.spentYuan >= tl) {
    return {
      ok: false,
      reason: `没钱了。这个月的话费（¥${tl}）我已经花完了，累计 ¥${state.spentYuan.toFixed(2)}`,
    };
  }

  // 🆕 再判"官方余额" —— 这是真闸（比本地推算准）。
  //    ⚠️ 查不到（网络抖/没配 key）就**跳过这道**，别把机器人弄哑。
  const bal = balanceInfo();
  const warnAt = Number(cfg.budget.officialWarnYuan) || 1;
  if (bal.ok && bal.available === false) {
    return { ok: false, reason: '官方余额显示账户不可用了（可能欠费或被限制），先别花了' };
  }
  if (bal.ok && warnAt > 0 && bal.total < warnAt) {
    return {
      ok: false,
      reason: `官方账户只剩 ¥${bal.total.toFixed(2)} 了，先充点再说吧`,
    };
  }
  if (dl > 0 && state.daySpent >= dl) {
    return {
      ok: false,
      reason: `今天的话费花完了（¥${dl}），明天再找我吧`,
    };
  }
  return { ok: true, reason: '' };
}

// ---------- "没钱了"要不要发到群里？（2026-10-01 修）----------
//
// 🔴 真实事故：上限撞到 ¥10 之后，**每来一条触发消息就发一次「没钱了」** ——
//    实测 24 小时内发了 **285 次**，把群刷了，群友都开始回「没钱了（）」。
//
// 为什么会这样：index.js 里"预算用尽 → 告知群里"那段**完全没有节流**，
// 而 `blocked` 每次都 +1（那次 205 次），说明每条触发消息都走了这条路。
//
// 修法：**每个群、每天最多说一次**。
//   · 按群隔离：那个群的人需要知道"它为什么哑了"，别的群不用被牵连
//   · 按天限制：跨天额度会重置，新的一天重新告知是合理的
//   · 落盘（state.stopAnnounced）：否则每次 deploy 重启都会再说一遍
//
// ⚠️ 没说出口的那次也不影响别的 —— 机器人照样沉默，日志里照记 blocked。
function shouldAnnounceStop(scope) {
  const today = todayKey();
  if (!state.stopAnnounced || typeof state.stopAnnounced !== 'object') state.stopAnnounced = {};
  if (state.stopAnnounced[scope] === today) return false;
  state.stopAnnounced[scope] = today;
  save();
  return true;
}

// ---------- 调用后：记账 ----------
function record(model, usage) {
  if (!usage) return;
  const inTok = Number(usage.prompt_tokens || 0);
  const outTok = Number(usage.completion_tokens || 0);

  // ⚠️ 先问"是不是免费模型"，再查单价表 —— 顺序不能反
  //
  // 🔴 查不到单价时**绝不能当成免费**（2026-09-21 修的）：
  //    旧写法是 priceOf() 返回 null 就 return，什么都不记 ——
  //    结果是"换个没登记的新模型 = 钱的上限瞎了 = 无限花"。
  //    现在改成按最贵已知价保守计费，钱的上限在任何情况下都有效。
  const free = isFreeModel(model);
  const known = free ? FREE : priceOf(model);
  const p = known || mostExpensivePrice();
  const guessed = !free && !known;

  state.calls++;
  state.dayCalls++;      // 🆕 今日次数（跨天清零）—— 横幅/日志网页显示的是它
  state.byModel[model] = state.byModel[model] || { calls: 0, yuan: 0 };
  state.byModel[model].calls++;

  // 用了兜底价 → 提醒一次（不是错误，是让你知道这个模型的估算偏保守）
  if (guessed && !state.warnedUnpriced) {
    state.warnedUnpriced = true;
    console.warn(`[budget] ⚠️ 模型 ${model} 未登记单价 —— 已按最贵的已知价 [${p[0]}, ${p[1]}] 保守计费`
      + '（想精确请加进 priceTable，想免费请加进 freeModels）');
  }

  if (p[0] === 0 && p[1] === 0) { save(); return; }   // 免费模型，不花钱

  // 记账：**区分"缓存命中"和"缓存未命中"**（2026-09-22 改）
  //
  // 🔴 为什么要改：旧写法把**所有** prompt token 都按未命中价（高峰 2 元/M）算，
  //    而缓存命中的真实单价是它的 **1/50**（0.04 元/M）。
  //    两个后果：
  //      ① 账本虚高（保守是好事，但虚高到 4 倍就没意义了）
  //      ② **优化看不见** —— 我们刚把 system 里的时间挪走、把缓存命中率从 0% 拉到 53%，
  //         如果记账还按全价算，账本上一点变化都没有，等于白干
  //
  // ⚠️ 其余部分**保持保守**：未命中的输入按高峰价、输出按高峰价。
  //    只有"缓存命中"这一段用真实比例 —— 那是实打实省下来的。
  // ⚠️ 兼容别的服务商：它们不返回这两个字段 → hitTok=0，退化成旧公式，不会算错。
  const hitTok = Math.max(0, Number(usage.prompt_cache_hit_tokens || 0));
  const missTok = usage.prompt_cache_miss_tokens != null
    ? Math.max(0, Number(usage.prompt_cache_miss_tokens))
    : Math.max(0, inTok - hitTok);
  const cachePrice = p[0] * CACHE_HIT_RATIO;

  const yuan = (missTok / 1e6) * p[0]
    + (hitTok / 1e6) * cachePrice
    + (outTok / 1e6) * p[1];
  state.daySpent += yuan;
  state.spentYuan += yuan;
  state.byModel[model].yuan += yuan;
  save();

  const dayLeft = cfg.budget.dailyLimitYuan - state.daySpent;
  const totalLeft = cfg.budget.totalLimitYuan - state.spentYuan;
  if (!state.warned && (dayLeft < cfg.budget.warnAtYuan || totalLeft < cfg.budget.warnAtYuan)) {
    state.warned = true;
    save();
    console.warn(`[budget] ⚠️ 额度告警：今日剩 ¥${Math.max(0, dayLeft).toFixed(3)}　累计剩 ¥${Math.max(0, totalLeft).toFixed(3)}`);
  }
}

// ---------- 状态 ----------
// ⚠️ 顺带把**上限**也带上。原因：budget.json 只存"花了多少"，
//    而上限在 config.js 里。日志网页是独立进程、读不到 config 的运行时值，
//    不带上的话它显示的是 ¥? —— 手机上最想看的恰恰是"还剩多少"。
function status() {
  rollover();
  // 🆕 面板改过的值优先（即时生效）
  const dl = settings.num('budgetDaily', cfg.budget.dailyLimitYuan);
  const tl = settings.num('budgetTotal', cfg.budget.totalLimitYuan);
  return {
    day: state.day,
    daySpent: Number(state.daySpent.toFixed(6)),
    dailyLimit: dl,
    dayLeft: dl > 0 ? Number(Math.max(0, dl - state.daySpent).toFixed(6)) : null,
    spentYuan: Number(state.spentYuan.toFixed(6)),
    totalLimit: tl,
    totalLeft: tl > 0 ? Number(Math.max(0, tl - state.spentYuan).toFixed(6)) : null,
    calls: state.calls,          // 终身累计（⚠️ 别拿去显示"今日"）
    dayCalls: state.dayCalls || 0,   // 🆕 今日（跨天清零）
    dailyCallLimit: settings.num('dailyCalls', cfg.policy.dailyCallLimit),   // 🆕 面板可改
    official: balanceInfo(),     // 🆕 官方账户余额（"还剩多少钱"的真值）
    blocked: state.blocked,
    byModel: state.byModel,
  };
}

// 供日志网页调用（它跑在另一个进程里，读不到本模块的内存状态）
function persistedStatus() {
  // 🆕 面板改过的值优先（即时生效）
  const dl = settings.num('budgetDaily', cfg.budget.dailyLimitYuan);
  const tl = settings.num('budgetTotal', cfg.budget.totalLimitYuan);
  const daySpent = Number(state.daySpent || 0);
  const spentYuan = Number(state.spentYuan || 0);
  return {
    day: state.day,
    daySpent,
    dailyLimit: dl,
    dayLeft: dl > 0 ? Math.max(0, dl - daySpent) : null,
    spentYuan,
    totalLimit: tl,
    totalLeft: tl > 0 ? Math.max(0, tl - spentYuan) : null,
    calls: state.calls || 0,          // 终身累计
    dayCalls: state.dayCalls || 0,    // 🆕 今日（跨天清零）
    dailyCallLimit: settings.num('dailyCalls', cfg.policy.dailyCallLimit),   // 🆕 供日志网页显示"今日 N / 上限"
    official: balanceInfo(),          // 🆕 官方余额（日志网页显示"官方还剩多少"）
    blocked: state.blocked || 0,
    byModel: state.byModel || {},
  };
}

function markBlocked() {
  state.blocked++;
  save();
}

load();

// 🆕 定时问一次官方余额（10 分钟一轮；只读、失败不拦）。
//    ⚠️ unref() 让这个定时器**不阻止进程退出**（和项目里其他定时器一个做法）。
if (isBalanceCheckOn()) {
  fetchOfficialBalance();
  setInterval(() => { fetchOfficialBalance(); }, BALANCE_TTL).unref();
}

module.exports = {
  canSpend, shouldAnnounceStop, record, status, persistedStatus, priceOf, isFreeModel, markBlocked,
  fetchOfficialBalance, balanceInfo,   // 🆕 官方余额（给日志网页 / 运维脚本用）
  // 🆕 只给自测用：把"今天"改成指定日期，用来验证"跨天到底清了哪些字段"。
  //    ⚠️ 生产代码不要调它。NO_PERSIST 模式下它也不会写任何文件。
  setDayForTest: (d) => { state.day = String(d); },
  setBalanceForTest,
};
