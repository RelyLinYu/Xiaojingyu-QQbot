// ============================================================
//  大脑：L0 硬规则 → L1 便宜模型判断 → L2 生成回复
//  修好的坑：
//   1. isAt 改为按「事件名」判断（官方 mentions 不含机器人自己，原来永远 false）
//   2. @ 进来的消息跳过长度检查（官方已剥掉 @前缀，剩余文字往往很短）
//   3. 非文本消息显式过滤，不再假装"空消息"
//   4. 时区锁定北京时间（服务器 UTC 会让昼伏夜出变成白天装死）
//   5. maxConsecutive 真正生效
//   6. 两个 Map 都会过期清理
//   7. fetch 带超时 + 先看 res.ok 再解析
//   8. 只取 content，绝不把 reasoning_content（思维链）发出去
// ============================================================

const cfg = require('./config');
const budget = require('./budget');

const contexts = new Map();     // gid -> [{name, content}]
const lastReply = new Map();    // "scope|openid" -> ts
const replyLog = [];            // {scope, ts}  用于 maxConsecutive

let callCount = 0;
let callDay = todayKey();

// ---------- 时间 ----------
// ⚠️ 一律用北京时间。服务器默认 UTC 会让 quietHours 整体偏 8 小时。
function nowInBeijing() {
  const d = new Date();
  const ms = d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600 * 1000;
  return new Date(ms);
}
function todayKey() {
  const d = nowInBeijing();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// ---------- 定期清理，防止 Map 无限涨 ----------
setInterval(() => {
  const ttl = cfg.dedupe.ttlMs;
  const now = Date.now();
  for (const [k, t] of lastReply) if (now - t > ttl) lastReply.delete(k);
}, cfg.dedupe.sweepMs).unref();

// ---------- 主人识别 ----------
// ⚠️ 比对的是 member_openid / user_openid，**不是 QQ 号**。
//    QQ 官方出于隐私不提供 QQ 号，事件里只有按机器人隔离的 openid。
//    ownerOpenid 留空 = 没有主人，所有人一律按普通群员对待。
function isOwner(msg) {
  const owner = String(cfg.ownerOpenid || '').trim();
  if (!owner) return false;
  const id = String(msg?.author?.member_openid || msg?.author?.user_openid || '');
  return id !== '' && id === owner;
}

// 给对方身份 —— 这段会写进给模型的提示里，人设靠它决定用哪套规则
function roleLabel(msg) {
  return isOwner(msg) ? `主人（${cfg.ownerName}）` : '普通群员';
}

// ---------- ⭐ 反重复：记住"它最近说过什么" ----------
// 为什么要这个：
//   示例对话只给一个生气表达（尾鳍拍你）时，反复挑衅就永远得到同一句，很乏味。
//   加示例能缓解，但模型仍可能"锁定"其中一个说法。
//   这里把它最近说过的话回灌进提示词，明确要求"换个说法"。
const recentReplies = new Map();   // scope -> [{ text, ts }]

function recordReply(scope, text) {
  if (!cfg.antiRepeat?.enabled || !text) return;
  const arr = recentReplies.get(scope) || [];
  arr.push({ text: String(text).slice(0, 120), ts: Date.now() });
  const keep = Math.max(1, cfg.antiRepeat?.historySize || 5);
  while (arr.length > keep) arr.shift();
  recentReplies.set(scope, arr);
}

function recentReplyTexts(scope) {
  if (!cfg.antiRepeat?.enabled) return [];
  const arr = recentReplies.get(scope) || [];
  return arr.map((x) => x.text);
}

// 定期清理，防内存涨
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of recentReplies) {
    const fresh = arr.filter((x) => now - x.ts <= 30 * 60 * 1000);
    if (!fresh.length) recentReplies.delete(k);
    else if (fresh.length !== arr.length) recentReplies.set(k, fresh);
  }
}, 60 * 1000).unref();

// ---------- 上下文（三重约束：条数 + 时效 + 长度）----------
// msgId：这条消息自己的 id（可选）。**只用于"别把当前这条送两遍"**，见 contextText()
function pushContext(gid, name, content, msgId) {
  const arr = contexts.get(gid) || [];
  // ⚠️ 必须记时间戳。只记内容的话没法判断"这条是 1 分钟前还是 3 小时前"，
  //    冷场后机器人会拿着很久以前的话题硬接，显得很怪。
  arr.push({ name, content, ts: Date.now(), msgId: msgId || '' });
  while (arr.length > cfg.policy.contextSize) arr.shift();
  contexts.set(gid, arr);
}

// 取"该给模型看的"上下文：最近 N 条 **且在时效内** **且总长度不超标** 的
//
// 🆕 第三道闸：长度（2026-09-22 加的）
//
// 起因：用户问「群里刷的图片多了，判断是否回复所需要的 token 不是也增加了？」
//       —— **他说得对**，而且这是"条数+时效"两道闸拦不住的：
//
//   实测（当天真机数据）：
//     · 真实群聊消息 中位 **7 字** · 识图描述 中位 **47 字** → **一条图 ≈ 7 条话**
//     · 中文换算比（精确测的）**1 字 ≈ 0.567 token**
//     · 30 条全是图 → `30 × 57 ≈ 1710 字 ≈ 970 token`
//       30 条全是短句 → `30 × 15 ≈ 450 字 ≈ 255 token`   ← **差 3.8 倍**
//
//   🔴 而上下文是**每次 L1 判断 / L2 回复都要重发一遍**的 ——
//      一条描述不是"花一次"，是"在它待在上下文里的这段时间里每次都花"。
//
// 所以：单条截断 + 总量收口，超了**从最旧的丢**（最近的才最有用）。
// ⚠️ 取值留了余量，正常聊天完全不受影响（见 config.js 的说明）。
function recentContext(gid) {
  const arr = contexts.get(gid) || [];
  const maxAge = cfg.policy.contextMaxAgeMs || 0;
  const now = Date.now();
  const fresh = maxAge > 0 ? arr.filter((m) => now - (m.ts || 0) <= maxAge) : arr;

  // ① 单条截断：一条 600 字的粘贴不该霸占整个上下文
  const perMsg = cfg.policy.contextMsgMaxChars || 0;
  let out = perMsg > 0
    ? fresh.map((m) => (String(m.content || '').length > perMsg
      ? { ...m, content: String(m.content).slice(0, perMsg) + '…' }
      : m))
    : fresh;

  // ② 总量收口：从最旧的开始丢，但至少留 minKeep 条最近的
  const total = cfg.policy.contextMaxChars || 0;
  if (total > 0 && out.length) {
    const lenOf = (m) => String(m.content || '').length + String(m.name || '').length + 2;  // +2 = ": "
    const minKeep = Math.max(1, cfg.policy.contextMinKeep ?? 5);
    let sum = out.reduce((a, m) => a + lenOf(m), 0);
    let cut = 0;
    while (cut < out.length - minKeep && sum > total) {
      sum -= lenOf(out[cut]);
      cut++;
    }
    if (cut > 0) out = out.slice(cut);
  }
  return out;
}

// 给模型看的"群聊上下文"文本
//
// 🔴 必须**排除当前这条消息**（按 msgId 精确匹配），否则它会**被送两遍**：
//
//     最近群聊：
//     小红: 今天好热啊
//     小明: 这个表情包笑死我了        ← 作为"历史"（index.js 第 4 步把它推进了上下文）
//
//     最新：小明: 这个表情包笑死我了   ← 作为"当前"（L1/L2 自己又拼了一遍）
//
//   （线上实打实打出来过，就是这么两行。）
//
// 代价：短消息每次回话多约 14 token（L1+L2 各一份）；
//      **图片消息的描述有 47 字 → 一次回话多约 58 token** ——
//      而且这是"每次回话都发生"，不是一次性的。
//
// ⚠️ 为什么不能简单地"不把当前消息推进上下文"：它**必须**进上下文，
//    否则后面几条消息就看不到它了（机器人会失忆）。
//    所以只能"存进去，但拼提示词时把它挑出来"。
//
// ⚠️ 为什么不用"内容相同就跳过"：群里有人连着发两条一样的"哈哈哈"是常态，
//    那会误伤。用 msgId 是精确的。
function contextText(scope, msg) {
  const cur = msg?.id || '';
  return recentContext(scope)
    .filter((m) => !(cur && m.msgId === cur))
    .map((m) => `${m.name}: ${m.content}`)
    .join('\n');
}

// 定期清理：既清过期的消息，也清长时间没动静的整个会话（防内存无限涨）
setInterval(() => {
  const maxAge = cfg.policy.contextMaxAgeMs || 0;
  const ttl = cfg.policy.contextScopeTtlMs || 30 * 60 * 1000;
  const now = Date.now();
  for (const [gid, arr] of contexts) {
    if (!arr.length) { contexts.delete(gid); continue; }
    const kept = maxAge > 0 ? arr.filter((m) => now - (m.ts || 0) <= maxAge) : arr;
    const last = kept.length ? kept[kept.length - 1].ts : (arr[arr.length - 1].ts || 0);
    if (!kept.length || now - last > ttl) contexts.delete(gid);
    else if (kept.length !== arr.length) contexts.set(gid, kept);
  }
}, 60 * 1000).unref();

// ---------- 取真正的内容 ----------
// 官方：message_type 0=纯文本 3=卡片(ark_data) 101=并行 102=聊天记录 103=引用(msg_elements)
// 只有 0 才是我们该参与的对话；其余一律当"非文本"。
//
// ⚠️ 实测（2026-09 真机）：GROUP_MESSAGE_CREATE 的 content 里会带
//    QQ 的 @ 占位标记 <@openid>，官方文档说"已去除@机器人的前缀"并不总成立。
//    不剥掉的话，模型会看到一串乱码 ID，长度检查也会被撑长（"@它 在吗"其实是 2 个字）。
const AT_MARKUP = /<@!?[^>\s]+>/g;

// QQ 自己的**表情/图片内部标记**，形如：
//   <faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">
//   <emoji:1234>               （商城表情）
// 这些是**给客户端渲染用的协议字段**，对模型来说完全是噪音 ——
// 实测（2026-09-22 加识图时）：一个表情包消息的 content 只有这串标记，
// 而它会被原样拼进提示词里，白占 token 还干扰理解。
// ⚠️ 加识图之前就存在这个问题，只是那时这类消息根本进不到模型（被判"空消息"）；
//    现在识图让它能进来了，所以顺手清掉。
const QQ_INTERNAL_MARKUP = /<(?:faceType|emoji)[^>]*>/gi;

function stripAtMentions(text) {
  return String(text ?? '')
    .replace(AT_MARKUP, ' ')
    .replace(QQ_INTERNAL_MARKUP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 提取被引用的内容（message_type=103）----------
// 实测样本（2026-09 真机，一次"引用 + @机器人提问"）：
//   content      : "还挺聪明"                          ← 引用者自己说的话
//   msg_elements : [{ content: " 砍一个人，剩下五个正好一人一个",
//                     msg_type: 103, msg_id: "REFIDX_..." }]  ← 被引用的原文
//   message_scene.ext: ["ref_msg_idx=REFIDX_...", "msg_idx=REFIDX_...", "auth_token=..."]
//
// 所以 103 是**完全可读的**，之前一律拒绝是错的 —— 白白丢掉了真实提问。
// 被引用的内容要拼进来，否则机器人不知道对方在说什么（"还挺聪明"指什么？）。
function extractQuoted(msg) {
  const els = Array.isArray(msg?.msg_elements) ? msg.msg_elements : [];
  const parts = els
    .map((e) => stripAtMentions(e?.content).trim())
    .filter(Boolean);
  return parts.join(' ').trim();
}

function extractText(msg) {
  const own = stripAtMentions(msg.content).trim();

  // ⭐ 助手模式：去掉暗号，只把真正的问题交给它
  //    （不去掉的话模型会看到"ovo 帮我解释X"，可能把 ovo 当内容一起答）
  //    顺序说明：先判暗号、再拼引用 —— 两者可叠加，见下。
  const am = detectAssistantMode(msg);
  const main = am.on ? am.text : own;

  // 🆕 识图结果：vision.js 把描述写在 msg.__vision 上。
  //
  // 🔑 为什么挂在**消息对象**上、而不是每个调用点自己拼：
  //    extractText() 是**唯一的文本出口**（hasUsableText / passHardRules /
  //    isMentionOnly / 上下文入栈 全都走它）。挂在消息上，只改这一处，
  //    下面所有逻辑就自动"看得见"图片了 —— 少改一处就少一个漏改的坑。
  const vis = String(msg?.__vision || '').trim();
  const withVis = (t) => {
    if (!vis) return t;
    // 分成两种情况，是为了让模型分得清"他说的话"和"图里是什么"
    return t ? `${t}（附带图片：${vis}）` : `【图片】${vis}`;
  };

  // 引用消息：把自己的话 + 被引用的原文一起给它，让它看得懂上下文
  if (msg.message_type === 103) {
    const quoted = extractQuoted(msg);
    if (quoted && main) return withVis(`（引用了一条消息：「${quoted}」）${main}`);
    if (quoted) return withVis(`（引用了一条消息：「${quoted}」）`);
    return withVis(main);
  }
  return withVis(main);
}

// 这条消息是不是"提不出文本"（真正该跳过的那些）
function hasUsableText(msg) {
  return extractText(msg).length > 0;
}

// content 里有没有 @ 占位标记（还没剥之前的原文）
function hasAtMarkup(rawContent) {
  return /<@!?[^>\s]+>/.test(String(rawContent ?? ''));
}

// 是否 @ 了机器人
//
// 官方文档说靠事件名 GROUP_AT_MESSAGE_CREATE 判断，但真机实测（2026-09）：
// 在群里 @ 机器人，事件名来的**仍然是 GROUP_MESSAGE_CREATE**，
// content 里的 <@openid> 也没被剥掉。所以只认事件名会永远漏判 → 走 5% 抽样 → 基本不理人。
//
// 因此这里按"证据链"判断，命中任意一条即算被 @：
//   1. 事件名就是 GROUP_AT_MESSAGE_CREATE（官方路径）
//   2. mentions 里有 is_you === true（QQ 明确标了"这条@的是你"）← 实测最可靠
//   3. content 里的 @ 占位标记指向机器人自己的 openid
function isAtRobot(eventType, msg, botOpenid) {
  if (eventType === 'GROUP_AT_MESSAGE_CREATE') return true;

  const mentions = Array.isArray(msg?.mentions) ? msg.mentions : [];

  // 证据 2：QQ 直接告诉了我们"这条 @ 的是你" ← 实测最可靠
  const selfMention = mentions.find((m) => m && m.is_you === true);
  if (selfMention) return true;

  // 证据 3：content 里的 <@xxx> 指向机器人自己
  // （selfMention 的 member_openid 就是机器人自己的 openid，可以就地取用）
  const raw = String(msg?.content ?? '');
  const selfIds = [botOpenid, selfMention?.member_openid, selfMention?.id].filter(Boolean);
  if (selfIds.some((id) => raw.includes(id))) return true;

  // ⚠️ 这里**故意不再有"只要有 <@...> 就算被 @"的兜底**。
  //    踩过的坑：那条兜底把"群友之间互相 @"也判成了 @ 机器人 ——
  //    而群里 @ 别人是**最常见**的操作，结果机器人到处乱插话。
  //    实测案例：某群友 @群主 请吃饭 → 机器人凑上来聊"设定"。
  //    结论：**只有能确认指向自己的 @，才算被 @。** 判不准就沉默，比乱插话好。
  return false;
}

// 这条消息是不是"只 @ 了**机器人**、没写内容"？
//
// ⚠️ 一定要判断 @ 的是谁 —— 这是个真实的 bug：
//    线上日志（2026-09-18）：
//      [群] 某群友D: (无文本内容)
//        ├ mentions=[{... "username":"群主" ...}]     ← @的是群主
//        └ 只有@没有内容 → 回固定应答
//      [send:group] ✓ 咋了                              ← 却回了"咋了"
//    原因是旧实现只看"消息里有没有 <@...>"，不看指向谁，于是**群友 @ 别人也触发**。
//
// ⚠️⚠️ 还有**第二条**路径（同样是 2026-09-18 从日志发现的）：
//    手机端 @ 机器人时，平台可能发来 `GROUP_AT_MESSAGE_CREATE` 事件，
//    而这种事件的 **content 和 mentions 都是空的**（实测该事件 78 条，mentions 全空）。
//    旧实现因为 content 为空直接判 false → 落到"空消息"分支 → **被点名却装死**。
//    实测：这类"空 content 的 @ 事件"占 7/78（9%）。
//    判定依据：**事件名本身**就说明是"被 @"，所以 content+mentions 都空 = 纯 @ 机器人。
function isMentionOnly(eventType, msg) {
  const raw = String(msg?.content ?? '');
  const mentions = Array.isArray(msg?.mentions) ? msg.mentions : [];

  // 🔴🆕 有识图结果就**绝对不是**"只有@没内容"。
  //
  //    踩过的坑（2026-09-22 加识图时想到的）：`@机器人 + 一张表情包` 的 content
  //    只有 `<@openid>` 占位、mentions 有 is_you，正好满足下面的路径 B →
  //    被判成"纯 @" → 回一句固定的「咋了」→ **图完全白看了**，
  //    而且用户会觉得"识图没生效"。
  if (String(msg?.__vision || '').trim()) return false;

  // ⚠️ 只处理 message_type === 0（纯文本）。
  //    卡片(3)/并行(101)/聊天记录(102) 的 content 本来就是空的，
  //    但那是"提不出内容"，不是"没说话" —— 它们有自己的分支，不能被误判成纯 @。
  //    （不加这条会误伤，实测挂了 4 条测试）
  const type = msg?.message_type ?? 0;

  // 路径 A：官方"被 @"专用事件，但平台没给 content / mentions
  if (type === 0 && eventType === 'GROUP_AT_MESSAGE_CREATE'
      && raw.trim() === '' && mentions.length === 0) {
    return true;
  }

  // 路径 B：普通群消息里的纯 @（content 里有 <@机器人>，剥掉后没别的字）
  if (!raw.trim()) return false;
  if (stripAtMentions(raw).trim() !== '') return false;
  return mentions.some((m) => m && m.is_you === true);
}

// ---------- 额度 ----------
function budgetOk() {
  const today = todayKey();
  if (today !== callDay) { callDay = today; callCount = 0; }   // 跨天重置
  return callCount < cfg.policy.dailyCallLimit;
}

function inQuietHours() {
  // ⚠️ 静默时段可以被**整体关掉**（config 的 policy.quietHoursEnabled: false）。
  //    2026-09-21 起就是关着的 —— 半夜本来没几个人，静默反而让偶尔来的人以为它坏了。
  if (cfg.policy.quietHoursEnabled === false) return false;

  const h = nowInBeijing().getHours();
  const [a, b] = cfg.policy.quietHours;
  return a <= b ? (h >= a && h < b) : (h >= a || h < b);
}

// ---------- 连续回复上限 ----------
function consecutiveOk(scope) {
  const now = Date.now();
  const win = cfg.policy.maxConsecutiveWindowMs;
  while (replyLog.length && now - replyLog[0].ts > win) replyLog.shift();
  const n = replyLog.filter((r) => r.scope === scope).length;
  return n < cfg.policy.maxConsecutive;
}

// ---------- L0：硬规则 ----------
// eventType / botOpenid 由 index.js 透传；isAt 的判断见 isAtRobot
function passHardRules(scope, msg, eventType, isPrivate, opts = {}) {
  const p = cfg.policy;
  const text = extractText(msg);
  const key = `${scope}|${msg.author?.user_openid || msg.author?.member_openid || 'unknown'}`;

  // 官方 author.bot 是权威字段。
  // ⚠️ 不要用 msg_id 是否以 ROBOT 开头来判断——官方文档里所有示例的 msg_id
  //    都以 ROBOT1.0_ 开头（别人的真实消息也是），用前缀判断会把群友全屏蔽掉。
  if (msg.author?.bot) return { ok: false, why: '发送者是机器人' };

  // ⭐ 助手模式（暗号 ovo）：一律放行，不走后面的抽样/冷却/长度检查。
  //    理由：这是用户**明确点名要求准确答案**，不该被"省钱逻辑"拦住。
  //    （日额度仍然生效 —— 那是钱包底线，在下面统一检查）
  const am = detectAssistantMode(msg);
  if (am.on) {
    if (inQuietHours()) return { ok: false, why: '静默时段' };
    if (!budgetOk()) return { ok: false, why: `今日调用次数已用完（${callCount}/${cfg.policy.dailyCallLimit} 次；这是次数上限，跟话费无关）` };
    return { ok: true, assistant: true, hitKeyword: false, isAt: isAtRobot(eventType, msg, opts.botOpenid), isOwner: isOwner(msg) };
  }

  // 只有 @ 了机器人、没有内容 —— 必须**先于** message_type 检查，
  // 否则会被误报成"非文本消息"。
  //
  // ⚠️ 这个判断改过多次，把最终结论记清楚：
  //    【最终行为】纯 @ 机器人 → 回一句"咋了"（由 mentionOnlyReply 开关控制）
  //    踩过的坑：isMentionOnly 旧实现只看"有没有 <@...>"，不看指向谁，
  //              于是**群友 @ 别人也被判成纯@机器人** → 乱回"咋了"。
  //              正确做法是必须 mentions 里 is_you === true。
  if (isMentionOnly(eventType, msg)) {
    const mo = cfg.policy.mentionOnlyReply;
    if (mo?.enabled) {
      return { ok: true, mentionOnly: true, hitKeyword: false, isAt: true, isOwner: isOwner(msg) };
    }
    return { ok: false, why: '只有@没有内容（不回，见 mentionOnlyReply 开关）' };
  }

  // 非文本消息处理（放在抽样之前，避免白烧额度）
  //
  // ⚠️ 这里改过一次，记录原因：
  //    一开始是"message_type !== 0 一律拒绝"，理由是官方说非文本消息的 content 可能是空格。
  //    但实测发现 **103（引用消息）的 content 就是引用者说的话，完全可读** ——
  //    一律拒绝等于把「引用某条消息 + @机器人提问」这类真实对话全丢了。
  //    现在改成：**能提取出文本就处理，提不出来才拒绝**。
  if (msg.message_type !== 0) {
    // 3=卡片 101=并行 102=聊天记录：内容在 ark_data / 嵌套 msg_elements 里，
    // 我们暂时不解（也没实测样本），明确说明是"不支持"而不是"空消息"。
    const UNSUPPORTED = { 3: '卡片', 101: '并行消息', 102: '聊天记录' };
    if (UNSUPPORTED[msg.message_type]) {
      return { ok: false, why: `暂不支持的类型(${UNSUPPORTED[msg.message_type]})` };
    }
    // 103 引用消息、以及未来新增的类型：只要提得出文本就放行
    if (!text) {
      return { ok: false, why: `非文本且提不出内容(type=${msg.message_type})` };
    }
  }

  if (!text) return { ok: false, why: '空消息' };

  const at = isAtRobot(eventType, msg, opts.botOpenid);

  // 私聊：对方是专门来找它说话的，跳过抽样和冷却
  if (isPrivate && p.alwaysAnswerPrivate) {
    if (inQuietHours()) return { ok: false, why: '静默时段' };
    if (!budgetOk()) return { ok: false, why: `今日调用次数已用完（${callCount}/${cfg.policy.dailyCallLimit} 次；这是次数上限，跟话费无关）` };
    return { ok: true, hitKeyword: false, isAt: true, isOwner: isOwner(msg) };
  }

  // 群里被 @ 时不做长度检查：
  // 正文剥掉 <@openid> 后常常只剩"在吗""你好"这种短句，再按 minLength 卡就永远不回。
  if (!at && text.length < p.minLength) return { ok: false, why: `太短(${text.length}<${p.minLength})` };

  if (inQuietHours()) return { ok: false, why: '静默时段' };

  // ⭐ 被 @ = 有人专门叫它 → 冷却和连续上限都必须让路。
  //
  // 为什么：这两道闸的目的是防"群里有人对着它刷屏"（主动插话），
  // 但被 @ 是明确的点名，跟上一条回没回无关。
  // 老逻辑的后果：@ 它一次 → 回 → 之后 60 秒内再 @ 一律装死，调试时几乎无法验证。
  // 主人的消息随叫随到：不受冷却和连续上限约束
  const owner = isOwner(msg);
  const bypass = at || (owner && p.ownerBypassLimits);
  if (!bypass) {
    if (Date.now() - (lastReply.get(key) || 0) < p.cooldownMs) {
      return { ok: false, why: '该成员冷却中' };
    }
    if (!consecutiveOk(scope)) {
      return { ok: false, why: `连续发言已达上限(${p.maxConsecutive})` };
    }
  }

  if (!budgetOk()) return { ok: false, why: `今日调用次数已用完（${callCount}/${cfg.policy.dailyCallLimit} 次；这是次数上限，跟话费无关）` };

  const hitKeyword = p.keywords.some((k) => text.includes(k));

  // ⭐ 省钱：没被 @ 也没命中关键词 → 只按概率抽样（主人和 @ 都不抽样）
  if (!bypass && !hitKeyword && Math.random() > p.sampleNonKeyword) {
    return { ok: false, why: '未命中关键词且未抽样中（省钱）' };
  }

  return { ok: true, hitKeyword, isAt: at, isOwner: owner };
}

// 从 message_scene.ext 里取 msg_idx —— 引用回复要用它
//
// 官方文档（发送群聊消息 → MessageReference.message_id）：
//   "被引用消息 ID，例如 REFIDX_xxxxxx
//    · 非机器人发的消息，从消息事件的 MessageScene 的 ext 数组，msg_idx 字段中获取
//    · 机器人自己发的消息，从发消息请求响应 ext_info.ref_idx 获取"
//
// 真实事件里的样子：
//   "message_scene": { "ext": ["ref_msg_idx=REFIDX_...", "msg_idx=REFIDX_...", "auth_token=..."] }
//   ↑ 注意 ref_msg_idx 是"被引用的那条"的索引，msg_idx 才是"这条消息自己"的索引。
//     我们要引用的是**对方这条消息**，所以取 msg_idx。
function messageRefId(msg) {
  const ext = msg?.message_scene?.ext;
  if (!Array.isArray(ext)) return null;
  const hit = ext.find((x) => typeof x === 'string' && x.startsWith('msg_idx='));
  return hit ? hit.slice('msg_idx='.length).trim() || null : null;
}

// ---------- ⭐ 助手模式：暗号切换 ----------
// 想法：保持拟人风格不变，但允许用暗号**临时**切到"精准回答"模式。
//
// 触发三条同时满足：
//   ① 消息以暗号开头（先剥掉 <@...>，所以 "@它 ovo 问题" 也认）
//   ② 暗号后面还有内容（整条只有暗号 = 等于没说话，**不触发**）
//   ③ 返回的 text 已去掉暗号
//
// 返回 { on: false } 或 { on: true, text: '去掉暗号后的真正问题' }
function detectAssistantMode(msg) {
  const opt = cfg.policy.assistantMode;
  if (!opt?.enabled || !opt.trigger) return { on: false };

  // 先剥 @ 标记 —— 否则 "@机器人 ovo 问题" 这种写法认不出来
  const raw = stripAtMentions(msg.content).trim();
  if (!raw) return { on: false };

  const trigger = String(opt.trigger);
  const head = raw.slice(0, trigger.length);
  const matched = opt.caseSensitive
    ? head === trigger
    : head.toLowerCase() === trigger.toLowerCase();
  if (!matched) return { on: false };

  // ⚠️ 边界检查：暗号后面必须是**分隔符或结束**。
  //    不加这条会误判 —— 实测 "ovoid 这不是暗号" 会被当成暗号，截出 "id 这不是暗号"。
  //    允许的分隔：空格/标点/冒号等；也允许直接接中文（"ovo帮我看看"）。
  const after = raw.charAt(trigger.length);
  if (after && !/[\s,，、.。!！?？:：;；~～)）\]】]/.test(after) && !/[\u4e00-\u9fa5]/.test(after)) {
    return { on: false };
  }

  // 暗号后面的部分
  const rest = raw.slice(trigger.length).replace(/^[\s,，、:：]+/, '').trim();

  // ② 没有内容 → 不触发（整条只有暗号等于没说话）
  if (!rest) return { on: false };

  return { on: true, text: rest };
}

// 这条消息有没有 @ 别人（不是机器人）？
// 用途：**@ 了别人 = 在跟那个人说话**，机器人不该抢答。
// 实测案例：问「@某群友A 你喜欢吃米饭吗」→ 机器人抢答"米饭我能吃三碗"，
//          因为判断器只看到"这话题我能接"，不知道这句话是问别人的。
function mentionedOthers(msg) {
  const mentions = Array.isArray(msg?.mentions) ? msg.mentions : [];
  return mentions.some((m) => m && m.is_you !== true);
}

// ---------- L1：便宜模型判断 ----------
async function shouldReply(scope, msg, hitKeyword, at) {
  if (at) return { reply: true, score: 10, reason: '被 @ 或私聊' };
  if (hitKeyword) return { reply: true, score: 9, reason: '提到关键词' };

  // 只带"时效内"的消息 —— 冷场 10 分钟后不该再拿旧话题判断
  // ⚠️ 用 contextText() 而不是直接 recentContext()：它会把**当前这条**挑出去，
  //    否则同一条消息会在提示词里出现两次（见 contextText 的注释）
  const ctx = contextText(scope, msg);

  // ⭐ @ 了别人 → 对方在跟那个人说话，机器人不该抢答
  //    （开关见 config.js 的 policy.avoidButtingInWhenAtOther，默认开）
  const toOther = cfg.policy.avoidButtingInWhenAtOther !== false && mentionedOthers(msg);
  const hint = toOther
    ? `\n⚠️ 注意：这条消息 **@ 了群里其他人**，说明说话人是**在跟那个人讲话**，不是对机器人说。`
      + `除非内容明显在问机器人或提到机器人，否则应当 reply=false。\n`
    : '';

  const sys = `你是群聊观察者。判断机器人"${cfg.persona.name}"现在插话是否自然。
只输出 JSON：{"reply":true/false,"score":0-10,"reason":"简短理由"}
score：10=非常适合接话，6=可以接，3=勉强，0=完全不相关。`;

  const user = `最近群聊：\n${ctx}\n\n`
    + `最新：${msg.author?.username || '群友'}: ${extractText(msg)}\n${hint}\n适合接话吗？`;

  try {
    const r = await callAI(sys, user, cfg.ai.judgeModel, cfg.ai.judgeMaxTokens, true);
    // 预算用光：不要在判断阶段就发消息（那是生成阶段的活），直接当作"不回"
    if (r.budgetStop) return { reply: false, score: 0, reason: '预算已用尽', budgetStop: true };
    const verdict = JSON.parse(r.text);

    // ⚠️ 双保险：即使判断器给了高分，只要"@ 了别人且没提机器人"，**直接否决**。
    //    判断器是概率性的，这种明确场景不该交给它自由发挥。
    //    实测它会把"问别人的问题"当成"能接的话题"，所以这里硬拦一道。
    if (toOther && verdict.reply && verdict.score < 10) {
      return { reply: false, score: 0, reason: '消息 @ 了别人，不抢答' };
    }
    return verdict;
  } catch (e) {
    console.warn('[L1] 判断失败，保守不回:', e.message);
    return { reply: false, score: 0, reason: '判断异常' };
  }
}

// ---------- ⭐ 多行回复：把一条长回复切成几句人话 ----------
// 真人聊天是一句一句发的，不是把一整段一次倒出来。
//
// 分段规则：
//   · 只在**句末标点**后切（。！？…），逗号不切 —— 切了会读着断气
//   · 总长不超过 minChars 就不切（一两句说完的没必要拆）
//   · 最多 maxSegments 段（QQ 限制每条消息最多被动回复 5 次）
//   · 每段至少 minSegment 字，太短的并进上一段，避免"嗯。"单独发一条
//   · 先合并再截断：把 8 个短句先拼成 3 段，而不是丢掉后面 5 句
function splitForChat(text) {
  const opt = cfg.splitReply || {};
  const s = String(text ?? '').trim();
  if (!opt.enabled || s.length <= (opt.minChars || 40)) return [s];

  const maxSeg = Math.max(1, opt.maxSegments || 3);
  const minSeg = Math.max(1, opt.minSegment || 6);

  // 在句末标点后切，标点保留在前一段
  const parts = s.split(/(?<=[。！？!?…])/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) return [s];

  // ① 先合并：把不足 minSeg 的碎片并进上一段
  const merged = [];
  for (const p of parts) {
    if (merged.length && p.length < minSeg) merged[merged.length - 1] += p;
    else if (merged.length && merged[merged.length - 1].length < minSeg) merged[merged.length - 1] += p;
    else merged.push(p);
  }

  // ② 再截断：超出 maxSegments 的，把余下的并进最后一段
  //    （不丢弃内容 —— 丢掉会让人以为机器人说话说一半）
  if (merged.length > maxSeg) {
    const head = merged.slice(0, maxSeg - 1);
    head.push(merged.slice(maxSeg - 1).join(''));
    return head.filter((x) => x.trim());
  }
  return merged.length ? merged : [s];
}

// 两条消息之间的随机间隔（固定间隔看起来像机器，忽快忽慢才像人）
function nextSendDelay() {
  const opt = cfg.splitReply || {};
  const lo = opt.delayMinMs ?? 800;
  const hi = opt.delayMaxMs ?? 1800;
  return Math.floor(lo + Math.random() * Math.max(0, hi - lo));
}

// ---------- L2：生成回复 ----------
async function generateReply(scope, msg) {
  // 只带"时效内"的消息 —— 这是"冷场后不乱接话"的关键
  // ⚠️ 同样用 contextText()：当前这条由下面的 `who` 单独给，别重复送
  const ctx = contextText(scope, msg);
  // ⭐ 把"当前时间"告诉它。
  //
  // 踩过的坑（2026-09 实测）：
  //   没给时间时，问"今天是几号"它会**编**一个（答"2月25号"，实际是 9月16日），
  //   问"现在几点"它会**躲**（"我又不是时钟"）—— 两个都是坏结果。
  //   根因不是模型不行，是**我们没告诉它**。
  //
  // 格式：星期三 (2026/9/16 17:06) —— 星期放前面，中文习惯里更醒目
  const now = nowInBeijing();
  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
  const timeStr = `${WEEK} (${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} `
    + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')})`;

  // ⭐ 助手模式（暗号 ovo）：加一段"准确优先"的要求，并**关掉**那些为拟人服务的东西
  const am = detectAssistantMode(msg);
  const assistantNote = am.on && cfg.policy.assistantMode?.systemNote
    ? `\n\n${cfg.policy.assistantMode.systemNote}`
    : '';

  // ⚠️⚠️ 【当前时间】必须放在 **user** 消息里，不能放 system（2026-09-22 实测修）
  //
  // 🔴 这是一个**纯浪费**的坑，而且很隐蔽：
  //    DeepSeek 的上下文缓存是**前缀匹配**的，命中价是未命中价的 **1/50**。
  //    我们的前缀是 `system(人设 141 token) → examples(147 token) → user`，
  //    本来是稳定的、**本该每次都命中**。
  //    但旧写法把【当前时间】**放在 system 的末尾**，而时间**每分钟都变** ——
  //    于是整个前缀每分钟失效一次。
  //
  //    实测对比（同一段前缀，只改时间）：
  //      A 时间在 system：同一条消息重发 → 命中 52%
  //                      时间过 1 分钟     → 命中 **0%**
  //                      时间过 5 分钟     → 命中 **0%**
  //      B 时间挪到 user：时间过 1 分钟     → 命中 **53%**
  //                      时间过 5 分钟     → 命中 **53%**
  //                      连上下文都换了     → 命中 **55%**
  //
  //    ⇒ 挪到 user 之后，256 token 的稳定前缀**永久可缓存**，
  //      跟时间变不变、上下文变不变都无关。
  const sys = cfg.persona.systemPrompt
    + `\n\n你的昵称是「${cfg.persona.name}」。直接说话，不要加昵称前缀，不要任何解释。`
    + assistantNote;

  // ⭐ 反重复：把它最近说过的话摆出来，要求换一种说法
  //    ⚠️ 助手模式下**不加**这段 —— "为换说法而改写"会损害答案准确性
  const last = am.on ? [] : recentReplyTexts(scope);
  const avoidHint = last.length
    ? `\n\n⚠️ 你最近已经说过这些（**不要再重复同样的说法和梗**，换个方式表达）：\n`
      + last.map((t) => `  · ${t}`).join('\n')
    : '';

  // ⭐ 明确标注说话人身份 —— 人设里的"普通群员 / 主人"两套规则靠这个生效
  //
  // ⚠️ 助手模式下**去掉身份标注**（config.policy.assistantMode.stripRoleLabel）：
  //    实测「ovo写一篇50字短文」被普通群员发出来时，它回"不写，你又不是我主人" ——
  //    因为模型看到【普通群员】就去套人设里"不执行指令"那条，即使 systemNote
  //    明确说"暂停"也不一定听。去掉标注 = 从源头消除这个冲突，比反复叮嘱可靠。
  const withRole = !(am.on && cfg.policy.assistantMode?.stripRoleLabel !== false);
  const who = withRole
    ? `现在，【${roleLabel(msg)}】${msg.author?.username || '群友'} 说：${extractText(msg)}`
    : `现在，${msg.author?.username || '群友'} 说：${extractText(msg)}`;
  const tail = withRole
    ? `\n\n注意：上面标注的身份决定了你该用哪套规则。你要接一句：`
    : `\n\n你要接一句：`;

  // 【当前时间】放在 user 的最前面（原因见上面 sys 那段注释 —— 放 system 会打掉缓存）
  const user = `【当前时间】${timeStr}\n`
    + `（有人问时间/日期/星期，直接照这个答。别编造，也别说"我又不是时钟"——你知道现在几点。）\n\n`
    + `群里最近的对话：\n${ctx}\n\n` + who + avoidHint + tail;
  const r = await callAI(sys, user, cfg.ai.replyModel, cfg.ai.replyMaxTokens, false, cfg.persona.examples);
  // 预算用光时，把"没钱了"的理由原样带回去，由 index.js 发到群里
  if (r.budgetStop) return r;

  // ⚠️ 助手模式**不做分段、不记反重复历史**：
  //    分段是为了"像人一样一句一句说"，但会把完整答案切成几条，反而妨碍阅读；
  //    反重复会让它为了"换个说法"而偏离原答案。
  if (am.on) {
    return { text: r.text, segments: [r.text], assistant: true };
  }

  // 记下这次说的话，供下次"别重复"用
  recordReply(scope, r.text);
  // 返回分段数组：短回复就是 1 段，长的切成几句
  return { text: r.text, segments: splitForChat(r.text) };
}

// ---------- AI 调用（OpenAI 兼容）----------
// 判断这个错误是不是"过载/可重试"。
// 智谱 1305 = 该模型当前访问量过大（官方语义是"稍后再试"，不是额度用尽）
function isOverloaded(err) {
  const m = String(err?.message || '');
  return m.includes('1305')
    || m.includes('HTTP 429')
    || /访问量过大|稍后再试|overload|rate.?limit/i.test(m)
    || m.includes('HTTP 5');    // 5xx 也是临时故障
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 组装候选模型列表：首选放最前，然后是降级链（去重）
function modelChain(preferred) {
  const list = [preferred, ...(cfg.ai.fallbackModels || [])];
  return [...new Set(list.filter(Boolean))];
}

// 两次模型调用之间的最小间隔 —— 防 1302（账号级限速）。
// 一次回复要调两次模型（L1 判断 + L2 生成），连着 @ 几次就会撞上。
let lastCallAt = 0;
async function respectMinGap() {
  const gap = cfg.ai.minGapMs || 0;
  if (gap <= 0) return;
  const wait = lastCallAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

// 主入口：先试首选模型，过载就依次换降级链里的下一个。
//
// 为什么不是"同一个模型重试多次"：实测 glm-4.7-flash 高峰会**持续** 429，
// 死等它半天不如立刻换 glm-4-flash —— 换过去通常一次就成功。
async function callAI(system, user, preferredModel, maxTokens, forceJson, examples, imageDataUrl) {
  const chain = modelChain(preferredModel);
  const attempts = Math.max(1, cfg.ai.maxAttempts);
  let lastErr = null;

  // ⭐ 花钱前先问预算 —— 超了就连请求都不发，省得白花。
  //    注意这里**返回**而不是抛错：要把理由发到群里，让群友知道是没钱了，
  //    而不是变成一条看不懂的异常日志。
  const spend = budget.canSpend();
  if (!spend.ok) {
    budget.markBlocked();
    console.warn(`[budget] 🛑 ${spend.reason} —— 主动拒绝调用`);
    return { budgetStop: true, text: spend.reason };
  }

  for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await respectMinGap();   // 防 1302：两次模型调用之间保持最小间隔
        // ⚠️ callAIOnce 已经返回 { text } 对象了，这里**直接透传**，不要再包一层。
        //    踩过的坑：写成 `return { text: out }` 就变成 { text: { text: "..." } } 双层嵌套，
        //    于是 index.js 取的 gen.text 还是对象，QQ 收到非法内容报 40011000「请求数据异常」，
        //    而那个错误码官方文档查不到，极难定位。
        const out = await callAIOnce(system, user, model, maxTokens, forceJson, examples, imageDataUrl);
        if (mi > 0) console.log(`[ai] ↳ 已降级到 ${model}`);
        return out;
      } catch (e) {
        lastErr = e;

        // 非过载类错误（鉴权错、模型名错）= 换模型也救不了 → 直接抛
        if (!isOverloaded(e)) throw e;

        const moreModels = mi < chain.length - 1;
        const moreAttempts = attempt < attempts;
        if (!moreAttempts && !moreModels) throw e;

        const wait = cfg.ai.retryBaseMs * (2 ** (attempt - 1))
          + Math.floor(Math.random() * 400);
        const next = moreAttempts
          ? `重试本模型(${attempt + 1}/${attempts})`
          : `换 ${chain[mi + 1]}`;
        // 区分两种限流，日志里一眼看出是谁的问题
        const kind = String(e.message).includes('1302')
          ? '账号级限速(1302，请求太密)'
          : '模型过载(1305)';
        console.warn(`[ai] ${kind} → ${next}，等 ${Math.round(wait)}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('callAI 无可用模型');
}

async function callAIOnce(system, user, model, maxTokens, forceJson, examples, imageDataUrl) {
  callCount++;

  // ⭐ 示例对话：作为**真实的多轮消息**拼在 system 和当前用户消息之间。
  //
  //    为什么不在 systemPrompt 里写成 `"你好"→"在"` 这种文本？
  //    因为那样模型只把它当"规则说明"读；拼成真实对话后，
  //    它看到的是"我以前这么说过话"，风格模仿效果强得多。
  //
  //    带 role 的示例会额外标注对方身份，让"看身份"那条规则也能被示例强化。
  const exampleMsgs = [];
  for (const ex of (examples || [])) {
    if (!ex || !ex.u || !ex.a) continue;
    exampleMsgs.push({
      role: 'user',
      content: ex.role ? `现在，【${ex.role}】群友 说：${ex.u}` : ex.u,
    });
    exampleMsgs.push({ role: 'assistant', content: ex.a });
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      ...exampleMsgs,
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature: forceJson ? 0.2 : 0.9,
  };

  // 🆕 识图：把当前这条 user 消息换成**内容块数组**（文本 + 图片）。
  //
  // ⚠️ 三个硬性约束（官方文档）：
  //    1. 图片**只能出现在 user 消息里** —— 放进 system/assistant 直接 400
  //       （所以示例对话里不能带图，这里也只替换最后那条 user）
  //    2. `detail: 'low'` 会把图缩到 512×512 → 省 token（一张约 220 token）
  //    3. 传的是 base64 data URL，会计入请求体 48MiB 上限
  //       （我们的图上限 8MB，base64 后约 11MB，安全）
  if (imageDataUrl) {
    body.messages[body.messages.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: user },
        {
          type: 'image_url',
          image_url: { url: imageDataUrl, detail: cfg.policy.vision?.detail || 'low' },
        },
      ],
    };
  }

  // 关掉"思考"：我们只要一句短回复，思考既吃 token 又拖慢响应，
  // 而响应太慢会逼近 QQ 被动回复的 5 分钟上限。
  if (cfg.ai.thinking === 'enabled' || cfg.ai.thinking === 'disabled') {
    body.thinking = { type: cfg.ai.thinking };
  }

  // ⚠️ 没有超时，模型卡住会把整条处理链堵死
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.ai.timeoutMs);

  try {
    const res = await fetch(`${cfg.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.ai.apiKey}`,
        // 中文必须走 UTF-8，否则模型收到的是一串 ???
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      signal: ac.signal,
    });

    // ⚠️ 先看状态码和文本，再解析。直接 res.json() 在 502/空体时会抛
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} 返回非 JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok || j.error) {
      // 把 code 也带出来，1305 才能被 isOverloaded 识别
      const code = j.error?.code ?? j.code;
      throw new Error(`HTTP ${res.status} code=${code ?? '-'}: ${JSON.stringify(j.error || j).slice(0, 300)}`);
    }

    // ⚠️ 只取 content！
    // reasoning_content 是思维链，发到群里 = 直播思考过程
    let out = String(j.choices?.[0]?.message?.content ?? '').trim();

    if (forceJson) {
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('没返回 JSON: ' + out.slice(0, 80));
      out = m[0];
    }
    if (j.usage) {
      const st = budget.status();
      const day = st.dayLeft === null ? '不限' : `剩¥${st.dayLeft.toFixed(3)}`;
      const tot = st.totalLeft === null ? '不限' : `剩¥${st.totalLeft.toFixed(3)}`;
      // 🆕 把"缓存命中"也打出来 —— 这是唯一能**在线上看见**缓存优化有没有生效的地方。
      //    （命中价是未命中价的 1/50，命中率高低直接决定话费）
      const hit = Number(j.usage.prompt_cache_hit_tokens || 0);
      const hitPct = j.usage.prompt_tokens ? Math.round((hit / j.usage.prompt_tokens) * 100) : 0;
      console.log(`[ai] ${model} in=${j.usage.prompt_tokens} out=${j.usage.completion_tokens}`
        + (hit ? ` 缓存命中${hit}(${hitPct}%)` : ' 缓存0%')
        + ` (今日第 ${callCount}/${cfg.policy.dailyCallLimit} 次 · 今日${day} · 累计${tot})`);
    }
    // ⭐ 记账：用 API 返回的真实 token 数算钱
    budget.record(model, j.usage);
    return { text: out };
  } catch (e) {
    callCount--;    // 调用失败不该占额度
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 🆕 识图：让模型描述一张图 ----------
//
// 刻意**复用 callAI**，于是白拿一整套：预算拦截 / 重试 / 指数退避 /
// 降级链 / token 记账 / 超时 / 只取 content 丢掉思维链。
// 也正因为复用，识图的模型调用**同样计入** callCount 和 budget ——
// 这是应该的：钱是真的花了，必须记。
//
// ⚠️ 模型用 `cfg.ai.replyModel`（= `deepseek-flash`），**不单独配一个模型名**：
//    官方文档写明 `deepseek-flash` 本身就支持图片输入（旧的
//    `deepseek-v4-flash-vision-exp` 已下线，请求由最新 Flash 承接）。
//    再配一个名字只会引入"跨服务商误配"的风险 —— 那正是自测第 18 组在防的事。
async function describeImage(imageDataUrl, maxTokens = 200) {
  const v = cfg.policy.vision || {};
  const r = await callAI(
    v.system || '你是一个看图助手。',
    v.prompt || '用一句中文描述这张图。',
    cfg.ai.replyModel,
    maxTokens,
    false,
    null,
    imageDataUrl,
  );
  // 预算被拦时 callAI 返回的是 { budgetStop: true, text: 理由 } ——
  // 🔴 text 里是"钱不够了"，**绝不能**当成图片描述塞进对话。
  if (r?.budgetStop) {
    console.warn('[vision] 预算拦截，本次不识别');
    return '';
  }
  return String(r?.text || '').trim();
}

module.exports = {
  pushContext,
  recentContext,
  recordReply,
  recentReplyTexts,
  passHardRules,
  shouldReply,
  generateReply,
  extractText,
  extractQuoted,
  hasUsableText,
  // 🆕 给模型看的上下文文本（会**挑出当前这条**，避免重复送）
  contextText,
  isAtRobot,
  isMentionOnly,
  detectAssistantMode,
  mentionedOthers,
  messageRefId,
  stripAtMentions,
  // 🆕 识图用：描述一张图（复用 callAI 的预算/重试/记账）
  describeImage,
  // 🆕 识图用：静默时段检查（避免和时间计算的代码重复一份）
  inQuietHours,
  markReplied: (scope, openid) => {
    lastReply.set(`${scope}|${openid}`, Date.now());
    replyLog.push({ scope, ts: Date.now() });
  },
  stats: () => ({ calls: callCount, limit: cfg.policy.dailyCallLimit, day: callDay }),
  // 给 index.js 用的连续发言检查（回复前再确认一次）
  consecutiveOk,
  // 只登记"本群刚发过言"（喂给 maxConsecutive），**不动某个人的冷却**。
  // 用途：链接卡片是独立支路，不该占用对方 60 秒的聊天冷却，但必须计入连发上限。
  markScopeReplied: (scope) => { replyLog.push({ scope, ts: Date.now() }); },
  // 给自测用
  isOverloaded,
  modelChain,
  isOwner,
  roleLabel,
  splitForChat,
  nextSendDelay,
};
