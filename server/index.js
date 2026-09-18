// ============================================================
//  小蓝鲸 QQ 机器人 —— 入口
//  修好的坑：
//   1. 整个事件处理包了 try/catch，任何一步抛错都不会杀进程
//   2. 同一 msg_id 重复推送去重（官方明确说会重复推）
//   3. 支持群聊 + 单聊
//   4. 事件原文落盘，调试阶段照旧能翻原始字段
// ============================================================

const cfg = require('./config');
const gateway = require('./gateway');
const brain = require('./brain');
const { sendGroupMessage, sendPrivateMessage } = require('./qqapi');
const fs = require('fs');

// ---------- 兜底：绝不因为一条消息让进程死掉 ----------
process.on('unhandledRejection', (e) => console.error('[未捕获的 Promise 异常]', e));
process.on('uncaughtException', (e) => console.error('[未捕获的异常]', e));

// ---------- 重复推送去重 ----------
// 官方原文：为确保消息可达，相同 msg_id 可能重复推送，开发者需结合 msg_seq 做去重
const seen = new Map();     // msg_id -> ts

function alreadyHandled(id) {
  if (!id) return false;
  const now = Date.now();
  const hit = seen.has(id);
  if (!hit) seen.set(id, now);
  return hit;
}

// 定期清理，防内存涨
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > cfg.dedupe.ttlMs) seen.delete(k);
}, cfg.dedupe.sweepMs).unref();

// ---------- 落盘（调试阶段最有用的东西）----------
function logEvent(type, d) {
  try {
    fs.mkdirSync('data', { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(`data/events-${day}.jsonl`, JSON.stringify({ t: type, d }) + '\n');
  } catch (e) {
    console.warn('[log] 事件落盘失败:', e.message);
  }
}

// ---------- 主流程 ----------
async function handleEvent(type, d) {
  // 1. 原始事件先落盘。阶段 B 就是靠翻它看清字段的
  logEvent(type, d);

  // 2. 只处理消息类事件
  const GROUP_EVENTS = ['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'];
  const isGroup = GROUP_EVENTS.includes(type);
  const isPrivate = type === 'C2C_MESSAGE_CREATE';
  if (!isGroup && !isPrivate) return;

  if (!d || !d.author) return;

  // 3. 去重（必须在最前面，否则上下文和额度都会被重复消耗）
  if (alreadyHandled(d.id)) {
    console.log('  └ 重复推送，跳过');
    return;
  }

  const openid = isGroup ? d.group_openid : d.author.user_openid;
  if (!openid) {
    console.warn('[事件] 缺少 openid，字段可能变了:', Object.keys(d).join(','));
    return;
  }

  // 私聊事件里 username 常常是空的
  const who = d.author.username || (isPrivate ? '私聊用户' : '群友');
  const scope = isGroup ? `group:${openid}` : `private:${openid}`;
  const text = brain.extractText(d);

  console.log(`[${isGroup ? '群' : '私聊'}] ${type} | ${who}: ${text || '(无文本内容)'}`);
  if (cfg.policy.verbose) {
    console.log(`  ├ message_type=${d.message_type} mentions=${JSON.stringify(d.mentions || [])}`);
  }

  // 4. 能提出文本的消息才进上下文（卡片/并行消息/聊天记录不进，避免污染判断）
  //    ⚠️ 不能只判 message_type===0 —— 103 引用消息是可读的，要让它也进上下文，
  //       否则机器人看不到"对方刚才引用了什么"。
  if (text && brain.hasUsableText(d)) brain.pushContext(scope, who, text);

  // 5. L0 硬规则
  const l0 = brain.passHardRules(scope, d, type, isPrivate);
  if (!l0.ok) {
    console.log('  └ 不回（' + l0.why + '）');
    return;
  }

  // 5.5 只 @ 了它、没写内容 → 默认**沉默**（见 config.policy.mentionOnlyReply）
  //     想让它吱一声就把那个开关打开；开着时回一句固定应答，**不调模型**（零成本）
  if (l0.mentionOnly) {
    const opt = cfg.policy.mentionOnlyReply || {};
    const pool = Array.isArray(opt.replies) && opt.replies.length ? opt.replies : ['咋了'];
    const reply = pool[Math.floor(Math.random() * pool.length)];
    console.log('  └ 只有@没有内容 → 回固定应答');
    const sent = isGroup
      ? await sendGroupMessage(openid, reply, d.id)
      : await sendPrivateMessage(openid, reply, d.id);
    if (sent) brain.markReplied(scope, d.author.user_openid || d.author.member_openid);
    return;
  }

  // 6. L1 便宜模型判断
  //
  // ⚠️ 助手模式直接**跳过判断**：
  //    实测问题：发「ovo叫妈妈」→ 暗号识别正常、正文剥成"叫妈妈"，
  //    但 L1 判断器（它看不到 ovo）按普通闲聊打分，觉得"这话题不该接"给了 1 分 → 不回。
  //    逻辑上不该这样：用户**明确用暗号要求准确答案**，不该再被"该不该插话"的判断器否决。
  //    这和"助手模式绕过冷却/抽样"是同一个道理 —— 明确点名优先于省钱逻辑。
  let l1;
  if (l0.assistant) {
    console.log('  └ 助手模式：跳过 L1 判断，直接生成');
    l1 = { reply: true, score: 10, reason: '助手模式（暗号）' };
  } else {
    l1 = await brain.shouldReply(scope, d, l0.hitKeyword, l0.isAt);
  }

  // 6.2 预算用尽：不只是沉默，要让群里知道原因
  //     注意判断发生在 callAI 内部，所以这里要把理由捞出来发出去。
  if (l1.budgetStop) {
    console.log(`  └ 预算已用尽，告知群里`);
    const msg = l1.reason === '预算已用尽' ? '没钱了，等充值吧' : l1.reason;
    const sent = isGroup
      ? await sendGroupMessage(openid, msg, d.id)
      : await sendPrivateMessage(openid, msg, d.id);
    if (sent) brain.markReplied(scope, d.author.user_openid || d.author.member_openid);
    return;
  }

  // 6.5 第二道闸：判断说"可回"之后，再抽一次概率（省钱）。
  // ⚠️ 但被 @ 是明确点名，抽签会让"@ 它一半不理"，所以 @ 直接免抽。
  //    助手模式同理 —— 用户明确要答案，更不该抽签。
  const passedChance = l0.isAt || l0.assistant || Math.random() < cfg.policy.replyChance;
  if (!l1.reply || l1.score < cfg.policy.scoreThreshold || !passedChance) {
    const why = !l1.reply || l1.score < cfg.policy.scoreThreshold
      ? `L1 ${l1.score}: ${l1.reason}`
      : `抽签未中(replyChance=${cfg.policy.replyChance})`;
    console.log(`  └ 不回（${why}）`);
    return;
  }

  // 7. L2 生成
  const gen = await brain.generateReply(scope, d);

  // 7.5 生成阶段才发现预算用尽 —— 同样把理由发出去
  if (gen && gen.budgetStop) {
    console.log('  └ 预算已用尽，告知群里');
    const sent = isGroup
      ? await sendGroupMessage(openid, gen.text, d.id)
      : await sendPrivateMessage(openid, gen.text, d.id);
    if (sent) brain.markReplied(scope, d.author.user_openid || d.author.member_openid);
    return;
  }

  const reply = gen && gen.text;
  if (!reply) {
    console.log('  └ 生成为空（检查 max_tokens 是否太小）');
    return;
  }

  // ⚠️ 类型防线：reply 必须是字符串。
  //    踩过的坑：callAI 的返回类型从 string 改成 { text } 后，
  //    漏改的调用点把整个对象当内容发出去，QQ 报 40011000「请求数据异常」，
  //    而那个错误码在官方文档里查不到，白查了半天。
  //    这里直接把问题摆在日志里，比让 QQ 用天书报错强得多。
  if (typeof reply !== 'string') {
    console.error(`  └ ✗ reply 不是字符串而是 ${typeof reply}: ${JSON.stringify(reply).slice(0, 200)}`);
    console.error('     （大概率是某个调用点没跟上 callAI 的返回类型变更）');
    return;
  }

  // 8. 发送（支持多行：分段 + 随机间隔，像真人在一句一句打字）
  const segments = (gen.segments && gen.segments.length) ? gen.segments : [reply];

  // ⭐ 什么时候带"引用"：
  //    因关键词触发（没被 @）时引用原消息 —— 对方才知道它在回哪句话。
  //    被 @ 时不引用（@ 本身已指明对象，再引用显得啰嗦）。
  const quoteRef = (cfg.policy.quoteOnKeywordReply && l0.hitKeyword && !l0.isAt)
    ? brain.messageRefId(d)
    : null;
  if (quoteRef) console.log('  ├ 带引用回复');

  if (segments.length > 1) {
    console.log(`  ├ 分段发送：${segments.length} 条`);
  }

  let okCount = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // 第 2 条起先等一下 —— 这是"人味"的关键：真人不会瞬间连发
    if (i > 0) await sleep(brain.nextSendDelay());

    const sent = isGroup
      ? await sendGroupMessage(openid, seg, d.id, quoteRef)
      : await sendPrivateMessage(openid, seg, d.id, quoteRef);
    if (sent) okCount++;
  }

  // 9. 只有发出去才算回复过（部分成功也算，否则会重复触发同一条）
  if (okCount > 0) {
    brain.markReplied(scope, d.author.user_openid || d.author.member_openid);
    brain.pushContext(scope, cfg.persona.name, reply);
  } else {
    console.log('  └ 发送失败，不计入冷却（下条消息仍可尝试）');
  }
}

// 简单 sleep（分段发送之间的间隔用）
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 启动 ----------
console.log('[小蓝鲸] 启动中…');
console.log('[小蓝鲸] 模型:', cfg.ai.replyModel, '@', cfg.ai.baseUrl);
console.log('[小蓝鲸] 判断模型:', cfg.ai.judgeModel, '| 日额度:', cfg.policy.dailyCallLimit);

if (!cfg.appId || !cfg.secret) {
  console.error('[小蓝鲸] ❌ 缺少 QQ_BOT_APPID / QQ_BOT_SECRET，检查 .env');
}
if (!cfg.ai.apiKey) {
  console.error('[小蓝鲸] ❌ 缺少 AI_API_KEY，检查 .env');
}

gateway.connect(async (type, d) => {
  // ⚠️ 这一层 try/catch 是保命的：没有它，一次网络抖动 = 进程退出
  try {
    await handleEvent(type, d);
  } catch (e) {
    console.error('[事件处理异常]', type, e?.stack || e);
  }
});

process.on('SIGINT', () => { console.log('\n[小蓝鲸] 退出'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[小蓝鲸] 退出'); process.exit(0); });
