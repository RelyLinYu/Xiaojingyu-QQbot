// ============================================================
//  sendqueue.js —— 按会话串行发送（2026-10-06 新增）
//
//  🔴 要修的问题（用户原话）：「如果两个人连续提问，然后两个回答都是 4 条消息，
//     那会一次性回复 8 条消息，没有艾特也没有引用」（已确认：**同一个群**里）
//
//  根因：`gateway.js` 里是 `Promise.resolve().then(() => onEvent(...))` ——
//        **事件之间不排队**；而分段发送是"发一条 → await sleep(0.8~1.8s) → 再发下一条"，
//        **每个 await 都是一个交叉点** ⇒ 第二个人的 4 段会插进第一个人的 4 段中间。
//
//  做法：**按会话（群/私聊）串行** —— 同一时刻同一个群只有一串在发；
//        不同群之间仍然并行（互不影响，也不会互相拖慢）。
//
//  附带解决"没有引用、分不清回谁"：
//        如果这一串是**排在别的回复之后**发的，就把它标成 `queuedBehind = true`，
//        调用方据此给它加**引用**（连着刷几串时，引用是唯一能看出"在回哪条"的东西）。
//
//  ⚠️ 纯逻辑，不依赖 config / 网络 / 定时器（自测可以直接喂假任务）。
// ============================================================

const queues = new Map();       // scope -> 队尾 Promise
const pendingIn = new Map();    // scope -> 还在队列里的串数
const lastDoneAt = new Map();   // scope -> 上一次发完的时间戳

// "刚发完"的窗口：这个时间内来的新一串，仍算"排在别人后面"
//   —— 真人连着回两串时，中间也就隔一两秒
const RECENT_MS = 2500;

/**
 * 把一个发送任务排进某个会话的队列。
 * @param {string} scope   会话标识（群/私聊）
 * @param {object} meta    会被写上 `queuedBehind`（true = 前面还有别的回复）
 * @param {Function} fn    真正干活的任务（返回 sent 条数）
 * @param {object} [opts]  { recentMs } 便于自测调节
 * @returns {Promise<any>} fn 的结果（失败会被吞掉并打日志，避免拖垮整条队列）
 */
function enqueue(scope, meta, fn, opts = {}) {
  const recentMs = opts.recentMs ?? RECENT_MS;
  const now = Date.now();
  const prev = queues.get(scope) || Promise.resolve();
  const pending = pendingIn.get(scope) || 0;
  const hasQueue = queues.has(scope);

  // 🔴 判据：队列里还有活儿（正在跑或排着），或刚刚才发完一串
  meta.queuedBehind = !!meta.queuedBehind
    || pending > 0 || hasQueue
    || (now - (lastDoneAt.get(scope) || 0) < recentMs);

  pendingIn.set(scope, pending + 1);
  // ⚠️ 注意这条链的**返回值**：`fn` 的结果必须原样传出去（调用方要拿它判断
  //    "到底发出去了几条"）。一度写成 `.then(fn).catch(...).then(清理)` ——
  //    清理那段返回的是 undefined，把结果吃掉了 ⇒ okCount 永远是 undefined ⇒
  //    "发送失败却标记成已回复"。用 `.then((v) => v)` 把值接回来。
  const p = prev
    .then(fn)
    .catch((e) => { console.error('[发送队列异常]', e?.message || e); return undefined; })
    .then((v) => v)
    .then((v) => {
      lastDoneAt.set(scope, Date.now());
      const left = (pendingIn.get(scope) || 1) - 1;
      if (left <= 0) { pendingIn.delete(scope); queues.delete(scope); }
      else pendingIn.set(scope, left);
      return v;
    });
  queues.set(scope, p);
  return p;
}

// 给自测/排查用
function stats() {
  return { scopes: [...queues.keys()], pending: Object.fromEntries(pendingIn) };
}
function reset() { queues.clear(); pendingIn.clear(); lastDoneAt.clear(); }

module.exports = { enqueue, stats, reset, RECENT_MS };
