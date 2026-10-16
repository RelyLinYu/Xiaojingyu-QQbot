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

// @ 专属限流用的状态（2026-10-01，见 passHardRules 里的注释）
const atHits = new Map();       // key -> [ts]  滑动窗口内的"被 @ 回复"时间戳
const atNoticeAt = new Map();   // key -> ts    "被限流了"这句提示上次发的时间
const atSigs = new Map();       // key -> [{sig, ts}]  内容指纹（判"同一内容反复发"）

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
  if (text == null) return '';       // ⚠️ 必须先挡：String(null) 会变成 "null" 这个字符串
  return String(text)
    .replace(AT_MARKUP, ' ')
    .replace(QQ_INTERNAL_MARKUP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- ⭐ 纯寒暄判定（2026-10-05 新增）----------
//
// 🔴 真实案例（用户报的）：群里有人发「早安肥鱼」，鱼回了
//    「早啊，今天又来找我聊天？」—— 对方只是打个招呼，根本没有下文。
//
// 为什么会这样：「肥鱼」在关键词表里 → `hitKeyword=true` → `shouldReply()` 开头
//    `if (hitKeyword) return { score: 9 }` **固定给 9 分、完全不判断** →
//    模型拿到的输入只有一句「早安肥鱼」，于是**给一段不存在的对话起了个标题**。
//
// 根因不是"缺后续判断"，是**"打招呼"和"找我办事"被当成了同一类**：
//    早安/晚安是**闭合动作**（对方回一句就结束了），而机器人把它当成了"开场"。
//
// ⇒ 判据（**故意做窄，判不准就走原流程**）：
//    ① 剥掉 @ 标记和机器人名字后，剩下的**只有寒暄词**（早/早安/晚安/拜拜…）
//    ② 长度 ≤ 6 个字（打招呼不会很长）
//    ③ **不含疑问词、不含问号、不含请求词**（吗/呢/怎么/为什么/帮我/教我…）
//        —— 有任何一样就不算纯寒暄（「早安，今天天气怎么样」该走正常流程）
//    ④ **必须点了名**（@ 了它，或文字里出现它的名字）
//        —— 否则那是在跟群友道晚安，不该理
//
// ⚠️ 判不准的代价是**不对称**的：漏判最坏就是现在这样"多说一句"；
//    误判会把正经话吞掉（比如把"早，帮我看看这个报错"当成打招呼）。
//    所以这里**一律往"不算寒暄"偏**。
// ⚠️ 「晚安」同时像招呼也像道别 —— 但它本质是**收尾**（说完就去睡了），
//    所以归到 bye，回「晚安 / 睡吧」而不是「早」。两张表**不能有交集**（有交集时先判 hello）。
const GREETING_HELLO = ['早安', '早上好', '早呀', '早啊', '早', '中午好', '午安',
  '下午好', '晚上好', '好梦'];
const GREETING_BYE = ['晚安', '睡啦', '睡了', '先睡了', '拜拜', '再见', '88',
  '溜了', '走了', '下线了', '我走了', '先走了'];

// 这些词一出现就**否定**"纯寒暄"（有话题 / 有请求 / 有疑问）
const GREETING_KILL = ['?', '？', '吗', '呢', '吧', '怎么', '为什么', '啥', '什么',
  '帮我', '教我', '看看', '请问', '能不能', '可以', '麻烦', '在', '来'];

function isPureGreeting(msg, opts = {}) {
  if (!msg) return { greeting: false };
  const raw = extractText(msg);
  if (!raw) return { greeting: false };

  // ④ 必须"点了名"：@ 了它（由调用方传入 isAt），或文字里带着**它的名字**。
  //
  // ⚠️ 这里踩过一次：人设全名是「蓝色大肥鱼」，而群友日常只叫「**肥鱼**」
  //    —— 只认全名的话「早安肥鱼」会被判成"没点名"，整个修复就白做了。
  //    正解是**复用关键词表**（`policy.keywords`）：那张表本来就是
  //    "群友会怎么叫它"的登记处（蓝色大肥鱼/大肥鱼/肥鱼/鲸少女/小蓝鲸…）。
  //    仍然很窄：词表里都是**它自己的名字**，不含通用词。
  const names = [String(cfg.persona?.name || ''), ...(cfg.policy?.keywords || [])]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);     // 长的优先剥（"蓝色大肥鱼" 先于 "肥鱼"）
  const hitName = names.find((n) => raw.includes(n)) || '';
  if (!hitName && !opts.isAt) return { greeting: false };

  // ① 剥掉名字 → 剩下的应该只有寒暄词
  let rest = hitName ? raw.split(hitName).join('') : raw;
  rest = rest.replace(/[\s，,。.!！~～、]/g, '');
  if (!rest) return { greeting: false };
  if (rest.length > 6) return { greeting: false };   // ② 太长 → 不是单纯打招呼

  // ③ 有话题/疑问/请求 → 不算纯寒暄
  if (GREETING_KILL.some((k) => raw.includes(k))) return { greeting: false };

  // 剩下的必须**整体等于**某个寒暄词（不是"包含"）
  const kind = GREETING_HELLO.includes(rest) ? 'hello'
    : (GREETING_BYE.includes(rest) ? 'bye' : null);
  if (!kind) return { greeting: false };
  return { greeting: true, kind, word: rest };
}

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
  //    （不去掉的话模型会看到"ovo 帮我解释X"，可能把 ovo 当内容一起答）  //    顺序说明：先判暗号、再拼引用 —— 两者可叠加，见下。
  const am = detectAssistantMode(msg);
  const main = am.on ? am.text : own;

  // 🆕 识图结果：vision.js 把描述写在 msg.__vision 上。
  //
  // 🔑 为什么挂在**消息对象**上、而不是每个调用点自己拼：
  //    extractText() 是**唯一的文本出口**（hasUsableText / passHardRules /
  //    isMentionOnly / 上下文入栈 全都走它）。挂在消息上，只改这一处，
  //    下面所有逻辑就自动"看得见"图片了 —— 少改一处就少一个漏改的坑。
  const vis = String(msg?.__vision || '').trim();

  // 🆕 「这张图没看成」的固定说明（vision.js 写在 msg.__visionNote 上，2026-10-11）
  //
  // 🔑 为什么单独一路、不并进 `__vision`：
  //    `__vision` 是"**真的看到了什么**"，它同时被三处判定读着 ——
  //    isMentionOnly（有描述就不算"纯 @"）、contentSig（同内容去重）、上下文入栈。
  //    把"没看成"并进去会**顺手改掉"要不要回话"的行为**（用户明确要求"别的方案别动"）。
  //    所以它只干一件事：让模型知道"有图、但这次没看成"，别自己编个理由出来。
  //
  // ⚠️ 只在**这条消息本来就有文字**时拼：纯图无文字的场景保持原样
  //    （那种会走"纯 @"→回固定「咋了」，不该被这条改动带偏）。
  const vnote = String(msg?.__visionNote || '').trim();
  const withVis = (t) => {
    if (vis) {
      // 分成两种情况，是为了让模型分得清"他说的话"和"图里是什么"
      return t ? `${t}（附带图片：${vis}）` : `【图片】${vis}`;
    }
    if (vnote && t) return `${t}（${vnote}）`;
    return t;
  };

  // 引用消息：把自己的话 + 被引用的原文一起给它，让它看得懂上下文
  //
  // 🔴 2026-10-13 修：原来只拼 `（引用了一条消息：「…」）`，**没写这句话是谁说的** ⇒
  //    模型默认把被引用的内容当成**当前发言者**说的。真实事故（用户原话）：
  //    「我引用别人的消息，bot 把其他人的发言当成了我的发言做出回复」——
  //    他引用群友说的"我下了大肥鱼的"，回了句「@棠吟 奥奥」，机器人答
  //    「**主人**下表情包还专门挑我这份」，把被引用者的话算到主人头上了。
  //    ⇒ QQ 的 msg_elements 里**没有作者**（实测），所以作者名由 index.js 用
  //      「scope|msg_idx → 昵称」小表反查后挂在 `msg.__quoteFrom` 上；
  //      查不到时也**必须写明"不是当前说话人说的"**，否则模型照样张冠李戴。
  if (msg.message_type === 103) {
    const quoted = extractQuoted(msg);
    const from = String(msg?.__quoteFrom || '').trim();
    let qtag = '';
    if (quoted) {
      if (from) qtag = `（引用了一条消息，是「${from}」说的：「${quoted}」）`;
      else if (msg?.__quoteIsSelf) qtag = `（引用了我自己（机器人）说过的一条消息：「${quoted}」）`;
      else qtag = `（引用了一条消息（不是当前说话人说的）：「${quoted}」）`;
    } else {
      // 🔴🔴 2026-10-17 修（用户报：「**为什么回复的是最近一张图而不是引用**」）：
      //    引用**读不出内容**时，这里以前是**一片空白** —— 提示词里既没有被引用的内容、
      //    也没有"我读不到它"这句话 ⇒ 模型只能拿**上下文里最近那张图**去猜，还答得头头是道。
      //    实测现场（01:12 日志逐行复原）：群友引用**机器人自己发过的图**问「这是你吗」，
      //    QQ 给回的引用元素里**没有文字** ⇒ qtag 为空；而 50 秒前别人发的图刚识过图、
      //    描述已经作为普通聊天消息在上下文里 ⇒ 它就把那句话接到了那张图上。
      //    ⇒ 读不到也必须**明说读不到**，并且分清"引用的是我自己"；别留白让模型编。
      if (msg?.__quoteIsSelf) {
        qtag = '（引用了我自己（机器人）发过的一条消息 —— 但那条里没有文字，我读不到它到底是哪条，'
          + '多半是我自己发过的配图。**别拿群里别的图当它**，也别硬说它是哪张）';
      } else if (from) {
        qtag = `（引用了「${from}」说的一条消息，但那条里没有文字 —— 我读不到被引用的内容，别猜）`;
      } else {
        qtag = '（引用了一条消息，但那条里没有文字 —— 我读不到被引用的内容，别猜）';
      }
    }
    if (qtag && main) return withVis(`${qtag}${main}`);
    if (qtag) return withVis(qtag);
    return withVis(main);
  }
  return withVis(main);
}

// 这条消息是不是"提不出文本"（真正该跳过的那些）
//
// ⚠️ 2026-10-17：**不能**再直接拿 `extractText()` 的长度来判断了 —— 引用读不出来时，
//    extractText 会补一句「（引用了一条消息…我读不到被引用的内容，别猜）」，那句**只是说明、
//    不是内容**。用长度判会让"啥都没说的纯引用"变成"有内容"⇒ 它就会去回一句本不该回的。
//    ⇒ 改成看**真材料**：自己的正文 / 能读出来的被引用内容 / 识图描述，三者之一才算有。
function hasUsableText(msg) {
  if (stripAtMentions(msg?.content).trim()) return true;
  if (String(msg?.__vision || '').trim()) return true;
  // ⚠️ 只有 103（引用消息）才会把被引用内容拼进 extractText —— 别对别的类型放行，
  //    否则会出现"判定说有材料、可 extractText 却是空"的不一致，模型拿到空提示词。
  if ((msg?.message_type === 103) && extractQuoted(msg)) return true;
  return false;
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

  // 证据 4（2026-10-05 加）：**手打的 `@机器人名`**
  //
  // 实测（群里真事）：群友手打「@蓝色大肥鱼 大笨鱼」时，QQ 推过来的 content 就是
  // **字面文本**、`mentions` 是 **undefined**、里面也没有 `<@openid>` 占位符 ——
  // 也就是**在协议层面它压根不是一次 @**（点击选的 @ 会是 `<@openid>` + `is_you:true`）。
  // 而客户端**会把它渲染成蓝色高亮**，看起来和真 @ 一模一样 →
  // 用户以为 @ 了、机器人却没反应（用户报"为什么群友艾特不回复"就是这一条）。
  //
  // ⇒ 名字被明确点到（`@` + 自己的显示名）就算被 @。
  // ⚠️ 只认"@ + **自己的名字**"，绝不能放宽成"只要有 @" —— 那会把"群友互相 @"
  //    也判进来（见下面那段注释，实测导致机器人到处乱插话）。
  const selfName = String(cfg.persona?.name || '');
  if (selfName && raw.includes('@' + selfName)) return true;

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
// 🆕 2026-10-05：日调用上限现在**可以在网页面板上改**（改完即时生效）——
//    所以每次判额度都现取一次，不能再用启动时读进内存的那个数。
function dailyLimit() {
  try { return require('./settings').num('dailyCalls', cfg.policy.dailyCallLimit); }
  catch { return cfg.policy.dailyCallLimit; }
}

function budgetOk() {
  const today = todayKey();
  if (today !== callDay) { callDay = today; callCount = 0; }   // 跨天重置
  return callCount < dailyLimit();
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
// ---------- @ 专属限流（2026-10-01；判据当天改过一版）----------
//
// 为什么需要一个**单独**的闸：原来 `bypass = at || owner` —— @ 把「同人 60 秒冷却」
// 和「同群连续上限」两道闸**全绕过了**，等于"只要一直 @ 就有无限次回复"。
// 但也不能简单把那两道闸套到 @ 上（@ 是明确点名，装死 60 秒会显得"坏了"）。
//
// 🔴🔴 第一版用**纯频率**当判据（10 秒 / 每分钟 3 次）—— **做错了**。
//    用户当天就指出：「正常交流话密也会触发，我想要的不是这个，
//    只是在无意义@刷屏才限制」。拿线上日志一量：
//      被挡的 9 条里 **8 条是内容各不相同的正常聊天**（误伤率 89%）。
//    ⇒ **判据应该是"无意义"（同一内容反复发），不是"频繁"。**
//      **频繁恰恰是正常聊天该有的样子。**
//
// 所以两层：
//   ① 重复闸（主）：同一人把**同样的内容**在窗口内发到第 N 次 → 挡
//   ② 频率兜底：设得很宽松（2 秒 / 每分钟 10 次），只防"真的被刷爆"

// 内容指纹：用来判断"是不是同一句话/同一张图又发了一遍"
//
// · 文本：剥掉 <@...>、压掉空白后比对
// · 图片：**优先用识图描述** —— 同一张图会命中 vision 的 md5 缓存，
//   描述**一字不差**，所以它天然就是一个稳定指纹 ✅
//   （识图被限额跳过时描述为空 → 退回附件的 size/宽高兜底）
function contentSig(msg) {
  let t = String(msg?.content || '');
  // 引用消息的正文里会带「（引用了一条消息：…）」，那部分也参与比对没问题
  t = t.replace(/<@[^>]*>/g, '').replace(/\s+/g, '').trim();
  const v = msg?.__vision ? String(msg.__vision).replace(/\s+/g, '').trim() : '';
  const parts = [t || v || ''];
  for (const a of (Array.isArray(msg?.attachments) ? msg.attachments : [])) {
    if (!a) continue;
    parts.push(`img:${Number(a.size) || 0}:${Number(a.width) || 0}x${Number(a.height) || 0}`);
  }
  return parts.join('#').slice(0, 300);
}

// 返回 { ok, why, notice }。`notice` 只在"该发提示"时才有值。
function atRateGate(key, sig, al) {
  const now = Date.now();
  const windowMs = Number(al.windowMs) > 0 ? al.windowMs : 60000;
  const cooldownMs = Number(al.cooldownMs) > 0 ? al.cooldownMs : 2000;
  const maxPerWindow = Number(al.maxPerWindow) > 0 ? al.maxPerWindow : 10;
  const repWindow = Number(al.repeatWindowMs) > 0 ? al.repeatWindowMs : 120000;
  const repThreshold = Number(al.repeatThreshold) > 0 ? al.repeatThreshold : 3;

  // ---- ① 重复闸（主判据）----
  const sigs = (atSigs.get(key) || []).filter((s) => now - s.ts < repWindow);
  atSigs.set(key, sigs);
  const sameCount = sigs.filter((s) => s.sig === sig).length;
  if (sig && sameCount + 1 >= repThreshold) {
    // 记下这一次（这样"第 4 遍、第 5 遍"也都在计数里，不会因为被挡就漏掉）
    sigs.push({ sig, ts: now });
    return atBlocked(key, `同一内容已发 ${sameCount + 1} 次`
      + `（${Math.round(repWindow / 1000)} 秒内，上限 ${repThreshold - 1} 次）`, al.noticeRepeat, al);
  }
  sigs.push({ sig, ts: now });

  // ---- ② 频率兜底（宽松，只防被刷爆）----
  const hits = (atHits.get(key) || []).filter((t) => now - t < windowMs);
  atHits.set(key, hits);
  const last = hits.length ? hits[hits.length - 1] : 0;
  if (last && now - last < cooldownMs) {
    return atBlocked(key, `@得太快（${Math.ceil((cooldownMs - (now - last)) / 1000)} 秒后才能再 @）`, al.noticeFlood, al);
  }
  if (hits.length >= maxPerWindow) {
    return atBlocked(key, `@得太频繁（${Math.round(windowMs / 1000)} 秒内已 ${hits.length} 次，`
      + `上限 ${maxPerWindow}）`, al.noticeFlood, al);
  }
  hits.push(now);
  return { ok: true };
}

// 被挡下来了 —— 要不要说一句话告诉对方"不是坏了，是故意的"？
// ⚠️ 提示语**自己也必须节流**，否则被挡的人只会更用力 @ → 提示成了新的刷屏源。
function atBlocked(key, why, noticeText, al) {
  const now = Date.now();
  const noticeCd = Number(al.noticeCooldownMs) >= 0 ? al.noticeCooldownMs : 180000;
  const lastNotice = atNoticeAt.get(key) || 0;
  if (noticeText && now - lastNotice >= noticeCd) {
    atNoticeAt.set(key, now);
    return { ok: false, why, notice: String(noticeText) };
  }
  return { ok: false, why };
}

// 定期清理，防内存涨（key 是"群|人"，长期跑会有很多）
setInterval(() => {
  const now = Date.now();
  const alCfg = cfg.policy.atLimits || {};
  const keep = Math.max(Number(alCfg.windowMs) || 60000, Number(alCfg.cooldownMs) || 2000) * 2;
  for (const [k, arr] of atHits) {
    const kept = arr.filter((t) => now - t < keep);
    if (kept.length) atHits.set(k, kept); else atHits.delete(k);
  }
  const sigKeep = (Number(alCfg.repeatWindowMs) || 120000) * 2;
  for (const [k, arr] of atSigs) {
    const kept = arr.filter((s) => now - s.ts < sigKeep);
    if (kept.length) atSigs.set(k, kept); else atSigs.delete(k);
  }
  const noticeKeep = Number(alCfg.noticeCooldownMs) || 180000;
  for (const [k, t] of atNoticeAt) if (now - t > noticeKeep * 2) atNoticeAt.delete(k);
}, 5 * 60 * 1000).unref();

// 测试用：清掉 @ 限流的状态（自测之间互不干扰）
function _resetAtLimits() {
  atHits.clear();
  atNoticeAt.clear();
  atSigs.clear();
}

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
    // 103 引用消息、以及未来新增的类型：只要提得出**真材料**就放行
    //   ⚠️ 2026-10-17：这里必须问 `hasUsableText()`，**不能**看 `text` 长不长 ——
    //      引用读不出来时 extractText 会补一句"我读不到被引用的内容"的**说明**（那不是内容），
    //      按长度判就会把"啥都没说的纯引用"放进来 ⇒ 它会去回一句本不该回的。
    if (!hasUsableText(msg)) {
      return { ok: false, why: `非文本且提不出内容(type=${msg.message_type})` };
    }
  }

  if (!hasUsableText(msg)) return { ok: false, why: '空消息' };

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

  // ⭐ 被 @ = 有人专门叫它 → 不走"普通消息"那两道闸（同人 60 秒冷却 / 同群连续上限）。
  //
  // 🔴 但 2026-10-01 发现：**完全不给闸会被人刷屏。**
  //    实测日志：群友「某群友」在 17:13:30～17:14:19 的 **30 秒内 @ 了 6 次**
  //    （而且都是同一张图），机器人**每次都回**，自己都在数"第三遍…第六遍"。
  //    那 24 小时里他一个人触发 **138 次回复（占全部 347 条的 40%）**，
  //    最忙的一分钟回了 **19 条**。
  //
  //    原因就是原来这行写成 `bypass = at || owner` —— **@ 把两道闸全绕过了**。
  //
  // ⇒ 现在给 @ **一条自己的闸**（`policy.atLimits`）：比普通消息松得多，
  //    正常一来一回完全不受影响（真人读完回话再 @ 通常 >10 秒），
  //    但"按着 @ 不放"会被挡住。
  //    ⚠️ 主人的消息**仍然完全免闸**（`ownerBypassLimits`）—— 调试要方便。
  const owner = isOwner(msg);
  const ownerFree = owner && p.ownerBypassLimits;
  const al = p.atLimits || {};

  if (at && !ownerFree && al.enabled !== false) {
    const gate = atRateGate(key, contentSig(msg), al);
    if (!gate.ok) return { ok: false, why: gate.why, rateNotice: gate.notice || null };
  }

  const bypass = at || ownerFree;   // 免"冷却 / 同群连发上限"
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

  // ⭐ 省钱抽样：**没被 @、也没命中关键词**的闲聊，只有 `sampleNonKeyword` 概率进判断。
  //
  // 🔴 2026-10-05 改（两处）：
  //   ① 主人**不再免**这道闸（见 config 的 ownerBypassSampling）。
  //      实测代价：不改的话主人 50.5% 的闲聊会进判断，其他人只有 7.3% —— 差 6.9 倍，
  //      而用户要的是"**所有人**都有机会被搭话"，不是只有主人被搭话。
  //   ② 抽样率 0 → 0.08（用户要求"提高所有人被插嘴的概率"）。
  // ⚠️ 条件里必须显式排除 `at`：被 @ 是明确点名，不该被抽签挡掉（否则 @ 了却沉默）。
  const sampleFree = owner && p.ownerBypassSampling;
  if (!at && !hitKeyword && !sampleFree && Math.random() > p.sampleNonKeyword) {
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
//
// 🔴 2026-10-05 补第二种形态（和 `isAtRobot` 的第 4 条判据是**同一个协议层事实**）：
//    `mentions` 只对**点击选的 @** 有值；**手打的「@某人」不会进 mentions**
//    （它是字面文本），于是"<@别人openid> 提示词没说好"这种话会被判成"没在跟别人说话"
//    → 机器人插进去回「那是你家那条的锅」。线上实测（主人 @ 别人两次都被插话）。
// ⚠️ 判据要**窄**：只认「@ + 一个不带空格的连续词」，且**先剥掉 @ 机器人自己**的
//    那段（否则"@机器人 你好"会被误判成在跟别人说话）。宁可不判，也别乱判。
// 📌 机器人自己的 id 直接从 `mentions` 里 `is_you === true` 的那条取 —— 不用外部传参。
function mentionedOthers(msg) {
  const mentions = Array.isArray(msg?.mentions) ? msg.mentions : [];
  if (mentions.some((m) => m && m.is_you !== true)) return true;   // 点击 @ 了别人
  let text = String(msg?.content || '');
  for (const m of mentions) {                                      // 先剥掉"@自己"的占位符
    if (!m || m.is_you !== true) continue;
    for (const id of [m.member_openid, m.id]) {
      if (id) text = text.split(`<@${id}>`).join(' ');
    }
  }
  return /@[^\s@]{1,24}/.test(text);                               // 手打的「@某人」
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

  // 🆕 2026-10-15 压缩（token 审计 · 每次 L1 判断都要发一遍，实测调用量比 L2 大两个数量级）：
  //    原来 4 行、约 150 字；现在 3 行、约 90 字，**判定语义一字没减**（JSON 格式、分数档、
  //    "只输出 JSON" 都还在）。⚠️ JSON 里那两个引号**本来就是中文全角**，保持原样别再换。
  const sys = `你是群聊观察者。判断机器人"${cfg.persona.name}"现在插话是否自然。
只输出 JSON：{"reply":true,"score":0-10,"reason":"简短理由"}
score：10=很适合接话，6=可以接，3=勉强，0=完全不相关。`;

  const user = `最近群聊：\n${ctx}\n\n`
    + `最新：${msg.author?.username || '群友'}: ${extractText(msg)}\n${hint}\n适合接话吗？`;

  try {
    const r = await callAI(sys, user, cfg.ai.judgeModel, cfg.ai.judgeMaxTokens, true,
      null, null, null, 'L1判断');
    // 预算用光：不要在判断阶段就发消息（那是生成阶段的活），直接当作"不回"
    if (r.budgetStop) return { reply: false, score: 0, reason: '预算已用尽', budgetStop: true };
    const verdict = JSON.parse(r.text);

    // ⚠️ 双保险：即使判断器给了高分，只要"@ 了别人且没提机器人"，**直接否决**。
    //    判断器是概率性的，这种明确场景不该交给它自由发挥。
    //    实测它会把"问别人的问题"当成"能接的话题"，所以这里硬拦一道。
    //
    // 🔴 2026-10-05：原来的条件是 `toOther && verdict.reply && verdict.score < 10`
    //    （不区分是谁说的）—— 但**主人免闸**那条路在 L1 里是靠 `score < 10` 兜的，
    //    实测主人 @ 别人时判断器照样给了 10 分 → 否决失效 → 插话（线上发生了 2 次）。
    //    改成：**只给"这次确实 @ 了机器人自己"开绿灯**（那是叫它，不是在叫别人）。
    if (toOther && !at && verdict.reply && verdict.score < 10) {
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
// `linkNote`：可选。本群刚刚处理过的链接事实（由 index.js 从 linkparse.contextNote 取）。
//   ⚠️ 默认空串 = 行为和以前**完全一样**（所以这次改动对普通对话零影响）。
async function generateReply(scope, msg, linkNote) {
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
  //
  // 🆕 2026-10-05 `linkNote`：「本群刚刚处理过什么链接」。
  //    🔴 真实案例：群友发了 15 小时半的 B站视频 → 卡片正常发了、视频按规矩跳过；
  //       45 秒后他问「给我解析刚刚发的链接」，鱼却答「我这边又看不到视频画面，解析不了」
  //       —— **答偏了**，因为模型不知道自己刚发过卡片。这句就是补给它的事实。
  //    ⚠️ 放在 user 里（不是 system）→ 不破坏 prefix cache；没内容时是空串、不影响任何东西。
  const linkPart = linkNote ? `\n\n【刚刚发生的】${linkNote}` : '';
  // 🆕 2026-10-13 图库（用户需求："自动在适合情景从图库发相关的图片"）
  //    插在 user 尾部（不是 system）—— 和 linkPart 同一个理由：不破坏 prefix cache。
  //    没图可发时是空串，对现有行为零影响。
  const imgHint = buildImgHint(scope, msg, extractText(msg), ctx);
  const user = `【当前时间】${timeStr}\n`
    + `（有人问时间/日期/星期，直接照这个答。别编造，也别说"我又不是时钟"——你知道现在几点。）\n\n`
    + `群里最近的对话：\n${ctx}\n\n` + who + avoidHint + linkPart + imgHint + tail;
  const r = await callAI(sys, user, cfg.ai.replyModel, cfg.ai.replyMaxTokens, false, cfg.persona.examples,
    null, extractText(msg), 'L2生成');
  // 预算用光时，把"没钱了"的理由原样带回去，由 index.js 发到群里
  if (r.budgetStop) return r;

  // ⚠️ 助手模式**不做分段、不记反重复历史**：
  //    分段是为了"像人一样一句一句说"，但会把完整答案切成几条，反而妨碍阅读；
  //    反重复会让它为了"换个说法"而偏离原答案。
  if (am.on) {
    const p1 = stripImgMark(r.text);
    return { text: p1.text, segments: [p1.text], imgId: p1.imgId, assistant: true };
  }

  // 记下这次说的话，供下次"别重复"用
  recordReply(scope, r.text);
  // 返回分段数组：短回复就是 1 段，长的切成几句
  const p = stripImgMark(r.text);
  return { text: p.text, segments: splitForChat(p.text), imgId: p.imgId };
}

// ---------- AI 调用（OpenAI 兼容）----------
// 判断这个错误是不是"过载/可重试"。
// 1305 = 该模型当前访问量过大（历史服务商的错误码，保留兼容；语义是"稍后再试"，不是额度用尽）
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
// 为什么不是"同一个模型重试多次"：实测小模型在高峰会**持续** 429，
// 死等它半天不如立刻换一个模型 —— 换过去通常一次就成功。
async function callAI(system, user, preferredModel, maxTokens, forceJson, examples, imageDataUrl, thinkText, tag) {
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
        const out = await callAIOnce(system, user, model, maxTokens, forceJson, examples, imageDataUrl, thinkText, tag);
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

// 「像不像在问事实」—— 用来决定要不要开"思考"（详见 callAIOnce 里的说明）。
// ⚠️ 刻意写得**保守**：只认明显的"问事实/问出处/问你知不知道"句式，
//    闲聊和玩梗都不匹配 —— 匹配多了就等于常开思考（实测输出会贵 5 倍，还话变长）。
function looksFactual(t) {
  return /(是谁|是什么|什么是|为什么|为啥|哪年|哪一年|哪个|哪一个|什么时候|多少|区别|有什么不同|介绍|来历|出处|你知道|知道吗|懂吗|什么梗|啥梗|真的假的|对不对)/.test(String(t || ''));
}

async function callAIOnce(system, user, model, maxTokens, forceJson, examples, imageDataUrl, thinkText, tag) {
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

  // 「思考」等级：**只有三级** —— `adaptive` / `enabled` / `disabled`。
  // 🔴 这不是文档里写的，是从 **API 自己的报错信息**里挖出来的：
  //    `thinking.type: unknown variant 'auto', expected one of 'adaptive', 'enabled', 'disabled'`
  //
  // 📊 实测对比（2026-10-04，deepseek-flash，同一个「梁文峰是谁」问 3 次）：
  //    disabled ：输出 117 token / 3.2s —— 它会犹豫（"有点耳熟""我说不准是哪个"）
  //    enabled  ：输出 587 token / 5.4s（**输出贵 5 倍**）—— 三次全对，连字形都纠正了
  //    adaptive ：对「在吗」也要思考 110 字 → **等于常开**，不划算
  //    ⚠️ 而且**闲聊时开思考反而更差**：话变长、还丢了人设的短促感
  //       （"米饭好吃吗"：关→"能干掉两碗…啊不是，一碗半"；开→"你该不会是想拿这个试探我吧？"）
  //
  // ⇒ 策略：**按问题类型切**。判断用（forceJson）永不开；生成时只有"像事实问题"才开。
  //   正则判定 → **零成本**，符合本项目"能不用模型解决的就不用模型"那条铁律。
  //
  // 🔴🔴 **判据只能吃 `thinkText`（当前这一条消息），绝不能吃整段 `user`。**
  //   踩过的坑（2026-10-04，上线当天就踩了）：一开始判的是整段 prompt，而它里面带着
  //   「群里最近的对话」上下文 —— 只要上下文里有人问过一句「**什么是**琴生不等式」，
  //   后面**每一条**消息（连「你好」「你个春鱼」）都会被判成"事实问题" → 思考全开、
  //   **输出 token 5 倍**。日志里表现为"每条都是 思考=开"。
  //   ⚠️ 所以没显式传 `thinkText` 时**默认不开**（fail-cheap）：宁可少思考，
  //      也别因为漏传参数又退化成"整段都算"。
  const thinkSrc = thinkText != null ? thinkText : '';
  const thinkMode = (() => {
    if (cfg.ai.thinking === 'enabled' || cfg.ai.thinking === 'disabled') return cfg.ai.thinking;
    if (cfg.ai.thinking !== 'auto') return null;
    if (forceJson) return 'disabled';                    // L1 只要一个短判断，思考纯属浪费
    return looksFactual(thinkSrc) ? 'enabled' : 'disabled';
  })();
  if (thinkMode) body.thinking = { type: thinkMode };

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
    // ⭐ 记账：用 API 返回的真实 token 数算钱
    //    ⚠️ 顺序很关键（2026-10-05）：**先记账再打日志** ——
    //    这样下面 `st.dayCalls` 里已经包含"这一次"，横幅/网页/日志三处口径才一致。
    budget.record(model, j.usage);
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
        + (thinkMode === 'enabled' ? ' 思考=开' : '')
        // 🔴 这里用 `st.dayCalls`（账本口径：**跨天清零、含识图**），不用本文件的 `callCount`
        //    —— 后者只在"过闸时"自增、**不含识图**，两个数会差一截（2026-10-05 发现）。
        //    显示口径统一到账本，人看到的数字就和"那道闸消耗了多少"是同一个。
        + ` (今日第 ${st.dayCalls}/${st.dailyCallLimit} 次 · 今日${day} · 累计${tot})`
        // 🆕 2026-10-15：**按功能记账的标记**（放在行尾，**不动行首格式** ——
        //    `_ops/*.sh` 和 usage.js 都靠 `[ai] <模型> in=… out=…` 这个前缀解析）。
        //    有了它才能回答"token 到底花在哪：识图 / L1 判断 / L2 生成"。
        + (tag ? ` [${tag}]` : ''));
    }
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
// 🆕 `prompt` 可选覆盖（识图用）：动图会换成"这是一个动图的 N 帧…"的说法，
//    否则模型会把网格图当成"四张拼在一起的图"而不是"一个动作的四个瞬间"。
async function describeImage(imageDataUrl, maxTokens = 200, prompt = null) {
  const v = cfg.policy.vision || {};
  const r = await callAI(
    v.system || '你是一个看图助手。',
    prompt || v.prompt || '用一句中文描述这张图。',
    cfg.ai.replyModel,
    maxTokens,
    false,
    null,
    imageDataUrl,
    null,          // thinkText：识图**永不开思考**（否则一张图多花 5 倍输出 token）
    '识图',
  );
  // 预算被拦时 callAI 返回的是 { budgetStop: true, text: 理由 } ——
  // 🔴 text 里是"钱不够了"，**绝不能**当成图片描述塞进对话。
  if (r?.budgetStop) {
    console.warn('[vision] 预算拦截，本次不识别');
    return '';
  }
  return String(r?.text || '').trim();
}

// ============================================================
//  🆕 2026-10-13 图库：把"可用的图"告诉模型，并把它选中的那张取回来
//
//  设计（用户拍板：混合触发 / 同群 5 分钟一张 / 不设每日上限 / 先只测试群）：
//   · **给模型的只有 id + 一句话描述**，图本身不塞进 prompt（省钱，也不挤掉群聊上下文）；
//   · 模型要配图时在结尾另起一行写 `[图:ID]`，由下面的 stripImgMark 摘掉，
//     实际发图由 index.js 做（走富媒体上传，和发视频同一条链路）；
//   · **冷却/只测试群**由 index.js 判断（那里才知道 scope 和群号）；这里只负责
//     "最近发过的别再给" + "给不出图就别提这件事"。
// ============================================================
const IMG_HIST = new Map();          // scope -> [id, ...] 最近发过的（防复读同一张）

function recentImgIds(scope) {
  const a = IMG_HIST.get(scope) || [];
  return a;
}
function noteImgUsed(scope, id) {
  const a = IMG_HIST.get(scope) || [];
  a.push(id);
  // 🆕 2026-10-13 晚：6 → 12 —— 原来只排最近 6 张，滑出太快，同一张图隔几条又能再发
  //    （实测 Top3 占 41.5%）。排得更久一点，复读的概率就低一截。
  while (a.length > 12) a.shift();
  IMG_HIST.set(scope, a);
}

// 给模型的候选图（拿不到图库 / 没图 / 关掉开关时一律返回空数组）
//
// 🔴 2026-10-13 重做（用户一问就问在点子上：「**候选图为什么是 12，一共不是 18 张吗**」）：
//    原来就是 `approved().slice(0, limit)` = **固定取最前面 12 张**，问题有两个：
//      · 第 13 张之后的图**永远进不了候选**（除非"最近发过的"被排除后恰好腾出位置）⇒ 半个图库白存；
//      · 每次给的清单顺序完全一样 ⇒ 模型容易反复挑同一张。
//    ⇒ 改成 **相关度优先 + 滚动窗口**：
//      ① 先按"跟当前这句话的字面重合度"把明显相关的排到最前（纯字符串打分，**不额外调模型、不花钱**）；
//      ② 其余用滚动窗口补齐：每次往后挪一格，**保证每张图都有机会露面**；
//      ③ 清单长度仍由 `hintMax` 控制 —— ⚠️ **那是"这次给它看几张"，不是"图库能装几张"**（容量 300）。
const IMG_ROTATE = new Map();          // scope -> 下次从第几位开始取

// 🔴 2026-10-13 晚（用户澄清他的意思：「我说的关键词是**图片描述关键词**和**群友交流关键词**
//    对得上、或者**意思相近**」）：
//    原来是**按单字**算重合 —— 「哈哈这就很可爱」里蹭到一个"可"字也计分，噪声大、
//    也不符合"关键词对得上"的直觉。⇒ 两处一起改：
//      ① 换成 **双字词（bigram）**：只有连着两个字都在描述里出现才算命中（"可爱/米饭/饿了"这种）；
//      ② 匹配字段**优先取描述里的「适合…」那段场景词** —— 因为"蓝发/女仆/Q版"这些词
//         **每张图都有**，拿全文匹配等于白送分（噪声来源）；场景词才真正区分"这张该什么时候发"。
//    ⚠️ 阈值跟着降（bigram 天然比单字少）：相关度门槛 5 → 2。
//    ⚠️ 但"**意思相近**"（近义/同义）靠字面永远做不到 —— 那一层由**模型**负责：
//       它读的是每张图的完整描述（含"适合…时发"），在候选清单里做真正的语义挑选；
//       这里的字面打分只决定"哪几张进清单"。
function overlapScore(a, b) {
  const t = String(a || '').replace(/[\s\p{P}]/gu, '');
  const hay = String(b || '').replace(/[\s\p{P}]/gu, '');
  if (t.length < 2 || !hay) return 0;
  let s = 0;
  const seen = new Set();
  for (let i = 0; i + 1 < t.length; i++) {
    const g = t.slice(i, i + 2);
    if (seen.has(g)) continue;
    seen.add(g);
    if (hay.includes(g)) s += 1;
  }
  return s;
}

// 从图片描述里取「适合…」那段（场景词）；取不到就退回整条描述
function sceneTextOf(desc) {
  const s = String(desc || '');
  const m = /适合([^。！？\n]*)/.exec(s);
  return m ? m[1] : s;
}

// 🔴 2026-10-13 晚：**关键词标签匹配**（这才是用户要的"关键词对得上"）
//
//  起因（用户原话）：「我说的关键词是**图片描述关键词**和**群友交流关键词**对得上、或者**意思相近**」。
//  实测教训：拿**整条描述**去做字面匹配根本对不上 —— 描述写「适合催饭或表达饿到委屈时发」，
//  群友说的是「我好饿啊有饭吃吗」，两边的连续两字词（bigram）几乎没有交集 ⇒ 命不中。
//  ⇒ 解法：先用模型给每张图**提炼一组口语关键词**存进索引（`tags` 字段，共 46 张已生成），
//     例如 dfy013 的 tags = 饿 / 饿了 / 好饿 / 饭呢 / 催饭 / 投喂 / 想吃 / 没吃饭 / 干饭
//     —— "好饿""没吃饭"这类**群友真的会说的话**都在里面，字面就能对上。
//     匹配规则：长度 ≥2 的词命中 +3 分、单字命中 +1.5 分。
//     ⚠️ 近义仍靠**模型**在候选清单里判断；这里只负责"把对的图推进清单"。
function tagScore(text, tags) {
  const t = String(text || '');
  if (!t || !Array.isArray(tags) || !tags.length) return 0;
  let s = 0;
  for (const tag of tags) {
    const g = String(tag || '').trim();
    if (!g) continue;
    if (g.length >= 2) { if (t.includes(g)) s += 3; }
    else if (t.includes(g)) s += 1.5;
  }
  return s;
}

// 用滚动窗口把清单补满（剩下的图也要轮得到）
function fillImgSlots(head, rest, limit, scope) {
  const out = head.slice(0, limit);
  if (out.length >= limit || !rest.length) return out;
  const have = new Set(out.map((x) => x.id));
  const tail = rest.filter((x) => !have.has(x.id));
  if (!tail.length) return out;
  const off = (IMG_ROTATE.get(scope) || 0) % tail.length;
  IMG_ROTATE.set(scope, (off + 1) % tail.length);
  for (let i = 0; out.length < limit && i < tail.length; i++) out.push(tail[(off + i) % tail.length]);
  return out;
}

// 选"这次给它看哪几张"。
//
// 🔴 2026-10-13 晚**再次**重做 —— 起因是用户又一句直觉命中的追问：
//    「我发现他有些表情包发的很频繁，会不会同类里总抽最合适的那张，其他永远抽不到」，
//    紧接着给了方案：「让描述的权重减小，同时参考群友最近谈话关键词来返图呢？」
//    线上实测**证实偏斜很严重**：已入库 46 张里 **32 张（70%）从没发过**，Top3 占 41.5%
//    （dfy007 发了 8 次）。两个原因叠加：① 描述高度相似（都是"蓝发女仆…懵/无语"），
//    模型每次只能挑最顺眼那几张；② 原来"相关度最高的最多 6 张"**排在最前面**，
//    而模型有"看开头"的偏好 ⇒ 后面那些（含所有新图）等于没露面。
//    ⇒ 这一版的四件事：
//      ① **均衡池（治偏斜的关键）**：把"发得最少 + 最久没用过"的几张**固定放清单最前**，
//         并在文案里点名叫模型优先考虑它们 —— 纯靠调权重复不了这一点；
//      ② **描述权重调低**：相关度阈值 3 → 5、名额 1/2 → 1/3，别让"巧合相关"占满前排；
//      ③ **参考最近群聊**（用户要的）：匹配文本从"当前这一句"扩成"当前句 + 最近几条群聊"
//         （群聊部分权重 0.5，别盖过当下这句话）；
//      ④ 其余位置仍由滚动窗口补齐，保证每张都轮得到。
function pickImgForScope(scope, limit = 12, msgText = '', recentText = '') {
  let lib;
  try { lib = require('./imglib'); } catch { return []; }
  const recent = new Set(recentImgIds(scope));
  let pool = lib.approved().filter((x) => !recent.has(x.id));
  if (pool.length <= limit) return pool;      // 够少就全给（这时没有"谁轮不到"的问题）

  // ① 均衡池：发得最少、且最久没用过的几张，固定排最前（limit=12 ⇒ 3 张）
  const rareN = Math.max(2, Math.floor(limit / 4));
  const rare = pool.slice().sort((a, b) =>
    (a.used || 0) - (b.used || 0)
    || String(a.lastUsedAt || '').localeCompare(String(b.lastUsedAt || ''))).slice(0, rareN);
  const rareIds = new Set(rare.map((x) => x.id));
  const rest = pool.filter((x) => !rareIds.has(x.id));

  // ② 相关度（权重调低）：当前句为主 + 最近群聊为辅（0.5 倍）
  const text = String(msgText || '');
  const ctxText = String(recentText || '');
  let hot = [];
  if (text || ctxText) {
    const scored = rest.map((x) => {
      const scene = `${x.name || ''} ${sceneTextOf(x.desc)}`;
      return {
        x,
        // 主：**关键词标签**命中（tags 是从描述提炼的"群里会说的话"，见 tagScore 注释）
        // 辅：描述场景词的字面重合（bigram），权重减半 —— 它噪声大，只当补充
        s: tagScore(text, x.tags) + tagScore(ctxText, x.tags) * 0.5
          + 0.5 * (overlapScore(text, scene) + overlapScore(ctxText, scene) * 0.5),
      };
    });
    // 阈值 3 = 至少命中一个双字关键词（或两个单字）
    hot = scored.filter((y) => y.s >= 3).sort((a, b) => b.s - a.s).map((y) => y.x)
      .slice(0, Math.max(1, Math.floor(limit / 3)));
  }
  const hotIds = new Set(hot.map((x) => x.id));
  const out = fillImgSlots([...rare, ...hot], rest.filter((x) => !hotIds.has(x.id)), limit, scope);
  // ⚠️ 用**浅拷贝**打标记，绝不写回索引文件（那是要落盘的）
  return out.map((x) => (rareIds.has(x.id) ? Object.assign({}, x, { _rare: true }) : x));
}

// 🆕 2026-10-14 晚：「有人**明确要图**」的粗判 —— 只用来**免抽签**（要就给）。
//    ⚠️ 故意写松（宁可多判中）：判错一条的代价只是"这一次多给一张图"，
//       判漏的代价是"群友张嘴要图却被告知发不了"，那个更难看。
//    概率闸本身在 `imglib.sendGate()` 里，这里只负责把"有人在要图"这个事实传进去。
//
// 🔴🔴 2026-10-16 修（用户实测：「为什么不给我图了，我不是没冷却吗」）：
//    旧正则是 `发[一1]?[张个]?图` 这种**紧挨着**的写法 ⇒
//      · 「**发出一张**图库图片」❌ 不认（发 和 图 中间隔了"出一张"）
//      · 「**给我一张**」❌ 不认（旧式只认"给…图"，这条连"图"字都没有）
// 写法拆成四条（方向按注释里那句"**宁可多判中**"；第一版太严会漏、太松会误伤，两边都实测过）：
//   A) 动作词 + ≤6 字内出现图片类名词（含裸的"图"）→ 覆盖「发出一张图库图片」「来张图」「发图」
//      ⚠️ **不放"看"**（否则「请看上面的图」被误判）；距离也必须短（否则「我发了个图文并茂的作业」中招）
//   B) 动作词 + 可选人称 + 可选数词 + **图片量词（张/份）** → 覆盖「来一张」「给我一张」「发张」
//      ⚠️ 刻意**不收"个"**（否则「来一个」「发一个文件」这种跟图无关的也中）
//   C) 「看图」单独一条（A 里把"看"去掉了，用这条补回来）
//   D) 直接点名图库 → 覆盖「图库来一张」「图库发个」
const WANT_IMG_RE = new RegExp(
  '(发|来|给|要|整|弄|挑|换)[^。！？!?\\n]{0,6}(图片|表情包|美照|图)'
  + '|(来|发|给|整|换|要|弄|挑)[我你他]?(一|1|两|几)?[张份]'
  + '|看图|美照'                            // 「美照」直接算（提示语里就是这么举的例子）
  + '|图库[^。！？!?\\n]{0,4}(来|发|给|挑|拿)',
);

function buildImgHint(scope, msg, msgText = '', recentText = '') {
  const cfgI = (cfg.policy && cfg.policy.imglib) || {};
  if (cfgI.enabled === false) return '';
  let lib;
  try { lib = require('./imglib'); } catch { return ''; }

  const g = { groupOpenid: msg && (msg.group_openid || msg.group_id), groupId: msg && msg.group_id };

  // 🔴 不在用图库的群：**一个字都不给**（省 token，也别让模型知道有这个功能）
  //    踩过：早先版本对"别的群"也回一句"这次不能配图"，等于每次回复白加 100 字，
  //    而且模型可能去跟群友解释"我这儿不能发图"——既费钱又莫名其妙。
  if (!lib.inWhitelist(g)) return '';

  // 🔴 关键：**能不能发**要先问闸门（和 index.js 发图时用的是同一个函数）。
  //    闸门关着时必须**明确告诉模型"这次别答应发图"** —— 否则它会说"给你来一张"，
  //    而代码随后把图拦掉，文案就对不上了（2026-10-13 用户实测到的正是这个）。
  const gate = lib.sendGate({
    scope, ...g,
    isOwner: !!(msg && isOwner(msg)),          // 主人免冷却（config.policy.imglib.ownerBypass）
    // 🆕 2026-10-14 晚：这里是**生成前**那次判断 ⇒ 概率签在这里抽（中了才放行；
    //    签挂在 imglib 上，等 `index.sendLibImage()` 用 `consume: true` 去验**同一张**签）。
    //    🔴 抽签放在生成前是老 bug 逼出来的铁律：模型必须**事先知道**这次能不能发，
    //      否则它会说"给你来一张"、代码随后把图拦掉（2026-10-13 真机出过）。
    //    有人明确要图 ⇒ 不抽签（要就给）。
    explicit: WANT_IMG_RE.test(String(msgText || '')),
  });
  if (!gate.ok) {
    // 🔴🔴 2026-10-16 修（真机实测）：闸门关着时，模型**自己编理由**在群里说
    //    「图库里真没货了」「图库真的空了嘛」——**库里明明有 46 张**！
    //    旧提示语只说了"别答应发图"，**没说"也不许替我们解释原因"**，
    //    于是它拿"没货/空了"这种**看上去合理**的说法去搪塞（还连说两遍）。
    //    ⇒ 两条补上：
    //      ① 把**真实原因**（gate.why）明确给它，让它不必猜；
    //      ② 🔴 **点名禁止**编造"库空了/没货了"这类理由（那是假话，而且用户一眼能看穿——
    //         他亲手加的图）。真的只是冷却时，宁可说"刚发过、等会儿"。
    const why = String(gate.why || '');
    const isCooldown = /冷却|等 \d+ 秒/.test(why);
    return `\n\n【你的图库】这次**不能**配图（真实原因：${why}）。所以：`
      + '**别答应发图、别说"来一张/再翻一张/给你一张"这类话**，也**别描述翻图、找图的动作** ——'
      + '就正常用文字回这一句。'
      + (isCooldown
        ? '⚠️ 如果你要解释一句，只说"**我刚发过一张，等一小会儿**"这个真实的理由；'
        : '')
      + '🔴 **绝对不许说"图库空了/没货了/没有图了/图库里一张都没有"这类话** ——'
      + '那是假话（图库里有图，只是这一轮不适合发/不让发）；'
      + '也**别编**别的理由（网络问题、正在上传、找不到文件…都不许编）。'
      + '要么不解释，要么只说上面给的真实原因。';
  }
  const limit = Number(cfgI.hintMax) || 12;
  const items = pickImgForScope(scope, limit, msgText, recentText);
  if (!items.length) return '';
  const total = lib.approved().length;
  // 🔴 2026-10-13 加**格式**（用户要「来一张 webp 格式的」）——
  //    清单原来只有 id + 描述，模型根本不知道哪张是 webp/png/jpg ⇒ 想按格式挑也挑不了
  //    （那天发对一张 webp 其实是**碰巧**踩中的）。格式对模型只是几个字，直接给它。
  const fmtOf = (x) => String((/\.([a-z0-9]+)$/i.exec(x.filename || '') || [])[1] || '').toLowerCase();
  const lines = items.map((x) => {
    const f = fmtOf(x);
    const tags = Array.isArray(x.tags) && x.tags.length ? `〔${x.tags.slice(0, 6).join('/')}〕` : '';
    // 🆕 2026-10-13 晚：① 均衡池那几张打 ※（模型偏好清单开头，光"放进来了"不够，得点名）；
    //    ② 带上**关键词标签**（从描述提炼的口语词）—— 模型对"什么时候该发这张"的判断更快更准；
    //       同时把描述截断从 40 字收到 26 字，**总长度基本持平**（不额外增加每轮开销）。
    return `- ${x.id}${f ? `（${f}）` : ''}${x._rare ? ' ※很少出场' : ''}：${String(x.desc || '').slice(0, 26) || '（没有描述）'}${tags}`;
  }).join('\n');
  // ⚠️ 告诉它"这只是图库的一部分" —— 否则它会以为图库就这么几张，被问"你有没有别的图"时答错
  const more = total > items.length ? `（图库一共 ${total} 张，这次先给你看这 ${items.length} 张）` : '';
  return `\n\n【你的图库】下面这些图你可以拿来配话（**只在真的合适时才配**）${more}：
${lines}
🔴 带 **※很少出场** 的那几张是**很少被用过**的图：如果它跟现在聊的事对得上，**优先从带 ※ 的里面挑** ——
别每一回都用同一张（实测：库里 46 张有 32 张从没露过面，就是总用那几张造成的）。
要配图就在回复的**最后另起一行**写 \`[图:ID]\`（只写一次，最多一张；不想配就一个字都别写）。
🔴 **ID 必须从上面这份清单里原样复制**（大小写、每个字符都照抄）—— **绝对不要自己拼一个**：
拼的 id 在库里不存在，代码会拒绝发送，于是又变成"嘴上说给你一张、实际没发"（2026-10-13 真机出过一次）。
对方点名要某种格式（"来张 webp / png"）时，就挑清单里标着那个格式的那张；没有那种格式就正常回话，别硬凑。
⚠️ 写了就**一定会发出去**；反过来说，**没写就别在正文里提"发图"这件事**（更别演翻图、找图的动作），
否则会出现"嘴上说发了、群里却没有"的尴尬。也别为了好玩乱配，更别在别人正经讨论事情时插表情包。

🔴 **现在是可以发的**（否则这段不会出现）：**别再说"图库在冷却/发不了/翻不出来/等冷却好了"这类话**
（那是刚才的情况，现在能发就说能发），绝不出现"嘴上说发不了、图又发出去"；
有人**明确要图**（发个图/来个图/来一张/看看美照）就**直接挑一张发**，**别反问"要什么图"**。`;
}

// 把 `[图:ID]`（含全角写法）摘出来；文本里不会留下这个标记
const IMG_MARK_RE = /\[图[:：]\s*([A-Za-z0-9_-]{1,40})\s*[\]］]/;
function stripImgMark(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(IMG_MARK_RE);
  const id = m ? m[1] : '';
  if (!m) return { text: s, imgId: '' };
  const out = s.replace(IMG_MARK_RE, '').replace(/[ \t]+\n/g, '\n').trim();
  return { text: out, imgId: id };
}

module.exports = {
  pushContext,
  recentContext,
  recordReply,
  // 🆕 @ 专属限流（2026-10-01）：给自测用，线上不用直接调
  _atRateGate: atRateGate,
  _contentSig: contentSig,
  _resetAtLimits,
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
  isPureGreeting,   // 🆕 纯寒暄（打招呼/道别）判定 —— 命中就零成本固定应答，不生成
  messageRefId,
  stripAtMentions,
  // 🆕 给"开关机命令"用：判断原文里有没有 @ 标记
  //    （stripAtMentions 之后就看不出来了 —— 必须看没剥之前的 content）
  hasAtMarkup,
  // 🆕 识图用：描述一张图（复用 callAI 的预算/重试/记账）
  describeImage,
  // 🆕 识图用：静默时段检查（避免和时间计算的代码重复一份）
  inQuietHours,
  // 🆕 2026-10-13 图库：给自测用（发图后要记一笔"这张刚发过"）
  _pickImgForScope: pickImgForScope,
  _buildImgHint: buildImgHint,
  _stripImgMark: stripImgMark,
  _noteImgUsed: noteImgUsed,
  markReplied: (scope, openid) => {
    lastReply.set(`${scope}|${openid}`, Date.now());
    replyLog.push({ scope, ts: Date.now() });
  },
  stats: () => ({ calls: callCount, limit: dailyLimit(), day: callDay }),
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
  _looksFactual: looksFactual,
};
