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
//  ⚠️ 按"高峰价 + 缓存未命中"保守计算（高估），实际只会花得更少。
// ============================================================

const fs = require('fs');
const path = require('path');
const cfg = require('./config');

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

function freshState() {
  return {
    day: todayKey(),
    daySpent: 0,      // 今天花了多少
    spentYuan: 0,     // 累计花了多少（不随跨天清零）
    calls: 0,
    blocked: 0,
    byModel: {},
    warned: false,
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
    // 跨天：只清零"今日"，累计保留
    rollover(true);
    console.log(`[budget] 今日 ¥${state.daySpent.toFixed(4)} / ¥${cfg.budget.dailyLimitYuan}　`
      + `累计 ¥${state.spentYuan.toFixed(4)} / ¥${cfg.budget.totalLimitYuan}（${state.calls} 次调用）`);
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
      console.log(`[budget] 跨天重置今日额度（${state.day} → ${today}，昨天花了 ¥${state.daySpent.toFixed(4)}）`);
    }
    state.day = today;
    state.daySpent = 0;
    state.warned = false;
    if (!quiet) save();
  }
}

// ---------- 单价 ----------
// ⚠️ 这个函数连续改错三次，教训写在这里：
//    错法1: key.startsWith(model)  → 'glm-4.7-flash'(免费) 命中 'glm-4.7-flashx'
//    错法2: model.startsWith(key)  → 'glm-4.7-flash'(免费) 命中 'glm-4.7'
//    错法3: 边界判断+最长匹配      → 仍然命中 'glm-4.7'（自己没登记，前缀恰好合法）
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
  if (dl > 0 && state.daySpent >= dl) {
    return {
      ok: false,
      reason: `今天的话费花完了（¥${dl}），明天再找我吧`,
    };
  }
  return { ok: true, reason: '' };
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
  state.byModel[model] = state.byModel[model] || { calls: 0, yuan: 0 };
  state.byModel[model].calls++;

  // 用了兜底价 → 提醒一次（不是错误，是让你知道这个模型的估算偏保守）
  if (guessed && !state.warnedUnpriced) {
    state.warnedUnpriced = true;
    console.warn(`[budget] ⚠️ 模型 ${model} 未登记单价 —— 已按最贵的已知价 [${p[0]}, ${p[1]}] 保守计费`
      + '（想精确请加进 priceTable，想免费请加进 freeModels）');
  }

  if (p[0] === 0 && p[1] === 0) { save(); return; }   // 免费模型，不花钱

  // 保守：按缓存未命中 + 高峰价算
  const yuan = (inTok / 1e6) * p[0] + (outTok / 1e6) * p[1];
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
  const dl = cfg.budget.dailyLimitYuan;
  const tl = cfg.budget.totalLimitYuan;
  return {
    day: state.day,
    daySpent: Number(state.daySpent.toFixed(6)),
    dailyLimit: dl,
    dayLeft: dl > 0 ? Number(Math.max(0, dl - state.daySpent).toFixed(6)) : null,
    spentYuan: Number(state.spentYuan.toFixed(6)),
    totalLimit: tl,
    totalLeft: tl > 0 ? Number(Math.max(0, tl - state.spentYuan).toFixed(6)) : null,
    calls: state.calls,
    blocked: state.blocked,
    byModel: state.byModel,
  };
}

// 供日志网页调用（它跑在另一个进程里，读不到本模块的内存状态）
function persistedStatus() {
  const dl = cfg.budget.dailyLimitYuan;
  const tl = cfg.budget.totalLimitYuan;
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
    calls: state.calls || 0,
    blocked: state.blocked || 0,
    byModel: state.byModel || {},
  };
}

function markBlocked() {
  state.blocked++;
  save();
}

load();

module.exports = { canSpend, record, status, persistedStatus, priceOf, isFreeModel, markBlocked };
