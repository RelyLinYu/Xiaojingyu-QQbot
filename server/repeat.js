// ============================================================
//  repeat.js —— 「群里连着两条一模一样的话 → 鱼跟着复读一遍」
//  （2026-10-15 用户需求）
//
//  用户原话：「当群里出现连续两条一模一样的消息时自动复读，同时间同一个语句只会复读一次」
//
//  ── 判定（三条同时成立才复读）──
//   ① **同一个群**里，紧挨着的两条消息（中间没插任何别的消息）
//   ② 两条的**正文完全相同**（剥掉 @ 标记 / QQ 内部标记、压掉空白后比对）
//   ③ 第二次说的那句不是机器人自己发的（它是 bot 发的就只记不读 —— 否则它复读
//      一次之后又看见"自己刚才那句跟上一句一样"，会自己接自己，无限循环）
//
//  ── 「同一个语句只会复读一次」（用户点名的那条）──
//   复读过的正文进一张 **去重表**：在 `dedupeMs` 窗口内（默认 90 秒）
//   同一句话**不会再被复读第二次**。
//   · 三个人连着刷同一句「啊？」→ 第 2 条复读一次，第 3、4 条静默（正文还在去重表里）
//   · 两分钟后同一句又出现 → 可以再来一次（不会永久拉黑一句话）
//
//  ── 三条硬约束 ──
//   ① 💰 **0 次模型调用、0 元** —— 纯内存比对 + 把原文发回去，不看图、不查链接、不进上下文。
//      这也是它敢放在"关机判断之前"的原因（关机语义是"不花钱"，这条一分钱不花）。
//      想让它闭嘴就把 `config.policy.repeat.enabled` 设成 false。
//   ② 🛡 **不破现有护栏** —— 只在"连续两条"这种明确情形下动作，不看频率；但另外加了
//      `cooldownMs`（两次复读之间至少隔这么久），防的是**换着句子反复刷**
//      （"1""2""3"每句都出现两次 → 每句都能触发一次复读）。超了只记日志、不复读。
//   ③ 🔴 **不改任何既有分支的行为** —— `note()` 返回 null 时调用方原样往下走；
//      返回对象时调用方把 text 原样发出去然后 return（不进 L0/L1/L2，不花额度）。
//
//  ⚠️ 纯函数化：`judge()` 不碰网络、不碰文件，喂"上一条 + 这一条"就出结论 —— 自测直接调。
// ============================================================

// 把正文规范化：QQ 的 @ 标记 `<@openid>` / 表情内部标记 `<faceType=...>` 一律剥掉，
// 空白压成一个空格。**不做大小写归一、不做全半角转换** —— "一模一样"就按眼睛看的算。
const AT_MARKUP = /<@!?[^>\s]+>/g;
const QQ_INTERNAL_MARKUP = /<(?:faceType|emoji)[^>]*>/gi;

function normText(s) {
  return String(s == null ? '' : s)
    .replace(AT_MARKUP, ' ')
    .replace(QQ_INTERNAL_MARKUP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function opt() {
  try { return (require('./config').policy || {}).repeat || {}; } catch { return {}; }
}

// 内存状态
const lastByScope = new Map();   // scope -> { text, quoted, ts }（"这个群上一条消息说了什么"）
const echoed = new Map();        // `${scope}|${text}` -> 复读时刻（去重表）
const lastEchoAt = new Map();    // scope -> 上次真的复读的时刻

// ---------- 纯判定：喂"上一条 + 这一条"，出"读不读" ----------
// prev：上一次处理过的消息 { text, quoted, ts }（null = 没有上一条）
// cur ：{ text, quoted, now }
function judge(prev, cur, o) {
  const cfgO = o || {};
  const text = normText(cur && cur.text);
  const minLen = Number(cfgO.minLength) > 0 ? Number(cfgO.minLength) : 2;

  if (!text) return { echo: false, why: '没有可用文本' };
  if (text.length < minLen) return { echo: false, why: `太短（${text.length} 字 < ${minLen}）` };

  // ① 必须紧挨着，且内容一模一样
  if (!prev || !prev.text) return { echo: false, why: '上一条没有可比对的内容' };
  if (normText(prev.text) !== text) return { echo: false, why: '跟上一句不一样' };

  // ② 引用语境不同就不算复读：两条引用**同一句**算；一条带引用、一条不带算同字巧合
  //    （"引用+@我"和一句裸话撞词，不该被当成"连着说两遍"）
  const pq = String((prev && prev.quoted) || '');
  const cq = String((cur && cur.quoted) || '');
  if (pq !== cq) return { echo: false, why: '引用语境不同' };

  // ③ 距上一条太久 = 不算"连着说的"（默认 5 分钟；必须大于 cooldown+dedupe，见 config 注释）
  const windowMs = Number(cfgO.windowMs) > 0 ? Number(cfgO.windowMs) : 300000;
  const age = Number(cur && cur.now) - Number(prev && prev.ts);
  if (!(age >= 0 && age <= windowMs)) return { echo: false, why: `隔了 ${Math.round(age / 1000)}s，超过窗口` };

  return { echo: true, text };
}

// 去重表：这句话刚复读过吗？
function wasEchoed(scope, text, now, dedupeMs) {
  const key = `${scope}|${text}`;
  const at = echoed.get(key);
  if (!at) return false;
  if (now - at > dedupeMs) { echoed.delete(key); return false; }
  return true;
}

let lastCoolLog = 0;

// ---------- 给 index.js 用的唯一入口：记账 + 判定 ----------
//
// 语义很重要，别改：**无论读不读，这条消息都会被记成"上一条"** ——
//   否则「A A B」里第二句 A 会因为中间插了 B 而漏读（踩过的边界）。
//
// 返回 null          → 什么都不做，调用方原样往下走
// 返回 { text, why } → 调用方把 text 原样发回群里，然后 return
function note(scope, info) {
  const o = opt();
  const now = Number(info && info.now) || Date.now();
  const text = normText(info && info.text);
  const quoted = String((info && info.quoted) || '');
  const isBot = !!(info && info.isBot);

  const prev = lastByScope.get(scope) || null;
  if (text) lastByScope.set(scope, { text, quoted, ts: now });   // 先判后记

  if (o.enabled === false) return null;
  if (isBot) return null;                       // 自己/别的机器人发的：只记不读（防自环）

  const v = judge(prev, { text, quoted, now }, o);
  if (!v.echo) return null;

  // 去重：同一句话只复读一次
  const dedupeMs = Number(o.dedupeMs) > 0 ? Number(o.dedupeMs) : 90000;
  if (wasEchoed(scope, v.text, now, dedupeMs)) {
    console.log(`  ├ 🔁 连续重复，但这句刚复读过（${Math.round(dedupeMs / 1000)}s 内只读一次）→ 不读`);
    return null;
  }

  // 复读之间的最短间隔（防"换着句子反复刷"）
  const cool = Number.isFinite(Number(o.cooldownMs)) ? Number(o.cooldownMs) : 60000;
  const lastEcho = Number(lastEchoAt.get(scope)) || 0;
  if (cool > 0 && now - lastEcho < cool) {
    if (now - lastCoolLog > 10000) {            // 同一波刷屏只打一行，别把日志刷满
      lastCoolLog = now;
      console.log(`  ├ 🔁 连续重复，但距上次复读只隔 ${Math.round((now - lastEcho) / 1000)}s`
        + `（冷却 ${Math.round(cool / 1000)}s）→ 不读`);
    }
    return null;
  }

  // 抽签（默认 1 = 每条都读；调小 = 只挑一部分读）
  const chance = Number.isFinite(Number(o.chance)) ? Number(o.chance) : 1;
  if (chance < 1 && Math.random() >= chance) {
    console.log(`  ├ 🔁 连续重复，但抽签未中（chance=${chance}）→ 不读`);
    return null;
  }

  echoed.set(`${scope}|${v.text}`, now);
  lastEchoAt.set(scope, now);
  return { text: v.text, why: '连续两条一模一样' };
}

// 定期清理三张表（防内存涨；和 index.js 的 dedupe 定时器一个套路）
setInterval(() => {
  const o = opt();
  const now = Date.now();
  const win = Math.max(Number(o.windowMs) || 300000, Number(o.dedupeMs) || 90000) * 2;
  for (const [k, v] of lastByScope) if (now - (v.ts || 0) > win) lastByScope.delete(k);
  for (const [k, t] of echoed) if (now - t > (Number(o.dedupeMs) || 90000)) echoed.delete(k);
}, 60000).unref();

module.exports = {
  note,
  _normText: normText,
  _judge: judge,
  _reset: () => { lastByScope.clear(); echoed.clear(); lastEchoAt.clear(); },
  _stat: () => ({ scopes: lastByScope.size, echoed: echoed.size }),
};
