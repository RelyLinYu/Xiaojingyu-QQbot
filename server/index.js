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
const linkparse = require('./linkparse');
const vision = require('./vision');
const power = require('./power');
const budget = require('./budget');   // 只为"没钱了"的节流（shouldAnnounceStop）
const qqmedia = require('./qqmedia');
const emotion = require('./emotion');   // 🆕 情绪观察器（只观察、不注入，见 config.policy.emotionObserve）
const commands = require('./commands'); // 🆕 群内指令（#cd 菜单 —— 0 次模型调用）
const repeat = require('./repeat');     // 🆕 连续两条一样的消息 → 复读（0 次模型调用，见 repeat.js）
const submit = require('./submit');     // 🆕 群友投稿表情包（#tg + 引用一张图 → 进图库待确认，见 submit.js）

// ============================================================
//  🆕 2026-10-13：**引用消息必须标出"这句话是谁说的"**（用户报的真实 bug）
//
//  现象（用户原话）：「我引用别人的消息，bot 把其他人的发言当成了我的发言做出回复」——
//  他引用了群友「棠吟」说的"我下了大肥鱼的（表情包）"、回了句「@棠吟 奥奥」，
//  机器人却答「**主人**下表情包还专门挑我这份」：它把**被引用者**说的话算到了**当前发言者**头上。
//
//  根因：QQ 的引用事件里 `msg_elements` 只给 `content / message_type / msg_idx`，
//  **没有任何作者信息**（2026-10-13 实测线上事件确认），而 `brain.extractText` 原来只拼
//  `（引用了一条消息：「…」）` ⇒ 模型只能默认"这是当前这位说的"。
//
//  解：QQ 给**每条**消息都带一个 `msg_idx`（在 `message_scene.ext` 里），被引用的那条也在其中
//  ⇒ 进程内存一张 `scope|msg_idx → 昵称` 的小表，遇到引用就查回来标上说话人。
//  ⚠️ 查不到时（消息早于机器人启动、或不在推送范围）也**必须写明"不是当前说话人说的"**，
//     否则模型照样张冠李戴。
// ============================================================
const authorByIdx = new Map();        // `${scope}|${msg_idx}` -> { n: 昵称, b: 是否机器人 }
const AUTHOR_IDX_MAX = 3000;

function rememberAuthor(scope, msg) {
  const idx = vision.msgIdxOf(msg);
  if (!idx) return;
  if (authorByIdx.size >= AUTHOR_IDX_MAX) {          // 简单清理：先丢最早的四分之一
    let n = 0;
    for (const k of authorByIdx.keys()) { authorByIdx.delete(k); if (++n >= AUTHOR_IDX_MAX / 4) break; }
  }
  authorByIdx.set(`${scope}|${idx}`, { n: msg.author?.username || '', b: !!msg.author?.bot });
}

// 返回被引用那条消息的说话人（查不到返回空串）
function quotedAuthor(scope, msg) {
  const ref = vision.refIdxOf(msg);
  if (!ref) return { name: '', isSelf: false };
  const hit = authorByIdx.get(`${scope}|${ref}`);
  if (!hit) return { name: '', isSelf: false };
  if (hit.b) return { name: '', isSelf: true };
  return { name: hit.n || '', isSelf: false };
}

// 🆕 2026-10-18：问"你用的什么模型 / 是 flash 还是 pro"的识别
//  🔴 起因（真实现场）：用户把模型切到 V4-Pro 后问「你接入的是 flash 还是 pro」，
//     机器人答「flash 呀，跑得快又便宜」—— 模型**没有运行时自省**，它不知道自己
//     跑在哪个模型上，只能按先验瞎猜（同类：问"你能上网吗"它也会编）。
//  ⇒ 这类"我自己怎么运行"的事实由**代码直接答**：0 次模型调用、不花钱，
//    答案永远等于当前真实配置（读 cfg.ai.replyModel），不会随人设/上下文漂。
//  ⚠️ 判据要窄：只认"问模型的型号"，别把聊模型价格/性能的普通对话也拦下来。
//     11 个正反用例已验过（"这个模型多少钱"/"你觉得哪个模型好用" 都不会误伤）。
const MODEL_ASK_RE = /(flash|falsh|pro)\s*(还是|or)\s*(flash|falsh|pro)|(你|机器人)[^，。？!?]{0,8}(用|接|跑|是)[^，。？!?]{0,6}模型|模型\s*(是|用|接|跑|选)\s*(什么|哪个|啥)|接入的?\s*(是)?\s*(什么|哪个|啥)\s*模型/i;

// ============================================================
//  🔴🔴 2026-10-17：引用读不出来时，**主动认领"我自己的图"**
//
//  用户第二次报（一个「？」）：群里引用**机器人刚发的图**问「这个是你吗」，
//  机器人却答「不是我。棕发蓝眼还戴粉蝴蝶结，认错鱼了」—— 那描述的是**别人**刚发的那张。
//  日志逐行看过：`brain` 那边"读不到被引用的内容"的说明**确实进了提示词**（01:24:12 那行），
//  但光说"读不到"挡不住模型 —— 别人那张图的描述就在 3 秒前的上下文里，太近太显眼。
//  ⇒ 治本：把**我们已知的事实**喂给它，而不是只叫它别猜。两条线索按可信度用：
//     ① 精确：被引用的 `msg_idx` 正好命中**我们发图时记下的消息 id**
//        （`vision.noteSelfImage` 已顺手写进正常索引 ⇒ 上面 `getImageDesc` 就命中了，走不到这儿）
//     ② 兜底：被引用元素**像一条图片消息**（有 idx、没文字）且**我们自己刚发过图** ——
//        群成员发的图我们**都会**识图进索引，能读到就根本不会走到这里
//        ⇒ "读不出来 + 我刚发过图"基本就是"他引用的就是我发的那张"。
//  ⚠️ 这不是让它猜：图是我们自己发出去的，"它长什么样"本来就在我们手里。
// ============================================================
const SELF_QUOTE_MS = 5 * 60 * 1000;      // 我发图后 5 分钟内被引用才算（想调就改这一行）

// 被引用元素"像一条图片消息"吗（有 idx、但**没有文字** —— 图片消息的 content 就是空的）
function quotedMediaLike(msg) {
  const e = (Array.isArray(msg?.msg_elements) ? msg.msg_elements : [])[0];
  if (!e) return false;
  if (String(e.content || '').trim()) return false;       // 有文字就不是"纯图片消息"
  return !!String(e.msg_idx || '').trim();                // 有 idx 才敢判断
}

// 引用读不出来时，尽力给出"它是我发的那张图"的说明；给不出就返回空串
function selfQuotedImageText(scope, msg, refIdx) {
  const recent = vision.lastSelfImage(scope, SELF_QUOTE_MS);
  if (!recent || !recent.desc) return '';
  if (!quotedMediaLike(msg)) return '';
  console.log('  ├ 🖼 引用读不出来、但我刚发过图 ⇒ 按"我发的那张"告诉它'
    + `（别再拿群里别人刚发的图当它；ref=${String(refIdx).slice(0, 12)}…）`);
  return `（引用的是我自己刚发过的那张图，它就是：${recent.desc}）`;
}

const {
  sendGroupMessage, sendPrivateMessage,
  sendGroupMarkdown, sendPrivateMarkdown,
  sendGroupMedia, sendPrivateMedia,
} = require('./qqapi');
const fs = require('fs');

// ---------- 兜底：绝不因为一条消息让进程死掉 ----------
process.on('unhandledRejection', (e) => console.error('[未捕获的 Promise 异常]', e));
process.on('uncaughtException', (e) => console.error('[未捕获的异常]', e));

// ---------- 重复推送去重 ----------
// 官方原文：为确保消息可达，相同 msg_id 可能重复推送，开发者需结合 msg_seq 做去重
// ⚠️ 别叫 path：线上 #st 自愈补丁会再声明一个 `const path = require('node:path')`，
//    同名会直接 SyntaxError 起不来（2026-10-24 真踩过）。用 nodePath 避让。
const nodePath = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;

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
    const dir = nodePath.join(APP_DIR, 'data');
    fs.mkdirSync(dir, { recursive: true });
    // ⚠️ 2026-10-24：原来用 toISOString（UTC）命名，而面板按**本地日期**找文件 ⇒
    //    北京时间 00:00–08:00 期间面板找不到当天文件（直发页群列表空）。改用本地日期。
    const _d = new Date();
    const day = _d.getFullYear() + '-' + String(_d.getMonth() + 1).padStart(2, '0') + '-' + String(_d.getDate()).padStart(2, '0');
    fs.appendFileSync(nodePath.join(dir, 'events-' + day + '.jsonl'), JSON.stringify({ t: type, d }) + String.fromCharCode(10));
  } catch (e) {
    // 提升到 error：事件日志是观测地基，静默 warn 会让人误判成"群权限没开"
    console.error('[log] 事件落盘失败:', e.stack || e.message);
  }
}

// ---------- 主流程 ----------
// ---------- 🆕 同群发送排队（2026-10-06）----------
//
// 🔴 要修的问题（用户原话）：「两个人连续提问，两个回答都是 4 条消息，
//    那会一次性回复 8 条，没有 @ 也没有引用」（已确认是**同一个群**）
//
// 逻辑本体在 `sendqueue.js`（纯函数、可自测）；这里只是接线 + 日志。
const sendqueue = require('./sendqueue');

// 🆕 日额度吃紧时**不拆段**（少发几条也算帮忙）
//    判据：次数已过 80% 或当天钱已花掉 80%。
function splitAllowed() {
  try {
    const b = require('./budget').persistedStatus();
    const callCap = Number(b.dailyCallLimit) || 0;
    const calls = Number(b.dayCalls) || 0;
    if (callCap > 0 && calls / callCap >= 0.8) return false;
    const moneyCap = Number(b.dailyLimit) || 0;
    const spent = Number(b.daySpent) || 0;
    if (moneyCap > 0 && spent / moneyCap >= 0.8) return false;
    return true;
  } catch { return true; }   // 查不到就照常拆（别因为统计问题改变说话方式）
}

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

  // 🆕 2026-10-13：先记下"这条消息是谁说的"（引用标注要用，见文件顶部的注释）
  rememberAuthor(scope, d);

  // 3.5 🆕 全局开关机（2026-09-22）
  //
  // 🔴 位置很关键：必须在**识图 / 链接解析 / L0 之前**。
  //    关机要真的是"什么都不做" —— 不识图（不花钱）、不解析链接（不发卡片）、不回话。
  //    放到后面任何一步，那一步的钱就已经花掉了。
  //
  // ⚠️ 但"开关机命令"本身**必须在关机状态下也能用** —— 否则关了就打不开了。
  //    所以顺序是：先看是不是开关机命令 → 是就处理；不是、且已关机 → 静默跳过。
  const powerCmd = power.matchCommand(d, isPrivate);
  if (powerCmd) {
    const who2 = d.author?.member_openid || d.author?.user_openid;
    // 🆕 2026-10-18：群里的 @它「开机/关机」**只改本群**；面板 = 批量覆盖所有群。
    //   （用户口径修正：单群随时能单独开/关，不再被全局挡住）
    const changed = isGroup
      ? power.setGroup(scope, powerCmd === 'on', who2)
      : power.setOn(powerCmd === 'on', who2);
    const text = power.replyFor(powerCmd, changed, { group: isGroup });
    const eff = power.isOn(isGroup ? scope : '');
    console.log(`  ├ ⏻ 主人 ${who} 发送了「${powerCmd === 'on' ? '开机' : '关机'}」`
      + `${changed ? '' : '（状态没变）'} → ${isGroup ? '本群' : '全局'}现在【${eff ? '开机' : '关机'}】`);
    const sent = isGroup
      ? await sendGroupMessage(openid, text, d.id)
      : await sendPrivateMessage(openid, text, d.id);
    console.log(`  └ ${sent ? '✓ 已回复' : '✗ 回复失败'}: ${text}`);
    return;   // 🛑 处理完就结束，不走下面任何流程
  }

  // 🆕 2026-10-18 投稿开关（面板可改、立即生效）：
  //   · 开着：#tg 走投稿分支；
  //   · 关掉：#tg **不投稿、也不当外站指令静默**，原样交给正常聊天（用户明确要求）。
  const submitOn = Number(require('./settings').num('submitEnabled', 1)) !== 0;
  const isTgMsg = isGroup && !d.author?.bot && submit.isCommand(String(d.content || ''));
  if (isTgMsg && !submitOn) console.log('  ├ 📥 投稿已关 → #tg 当普通聊天处理');

  // 3.7 🆕 群内指令：`#cd`（菜单）
  //
  // 🔴 位置讲究：这段**在"关机"判断之前**，但**受 `policy.commandsWhenOff` 控制**
  //    （2026-10-16 用户实测发现"关机了指令还能用"，问"开关机范围是不是没设置好"
  //    ⇒ 把它做成**可配**，默认只留菜单）：
  //      · `'all'`  = 关机时指令照常（**旧行为**：当初的理由是"关了菜单就看不见指令表了"）
  //      · `'menu'` = **只留 `#cd` 菜单**（0 成本、0 副作用），别的指令静默 ← 现在默认
  //      · `'none'` = 关机时一条指令都不理（除开关机命令自己）
  //    ⚠️ 为什么默认不是 'all'：有的指令是真的**干活**（上游 fetch + 占上行带宽），
  //       跟"关机就是什么都不做"冲突；而菜单只是拼个串发出去，留着没坏处。
  //
  // 🔴 用 **markdown（msg_type=2）** 发文字，用**富媒体（msg_type=7）**发图 ——
  //    卡片里的"点了就跳"靠的就是 markdown 链接；纯文本里带 scheme 是死文本。
  //
  // 🔴 全程 0 次模型调用（能不用模型解决的就不用模型）：纯正则命中 → 拼串/取图发出去。
  //    所以它**不花额度**，也就不需要过 budget 闸。
  //
  // ⚠️ 群友不 @ 也想收到 → 得在开放平台后台开「获取群内全部消息」（只有群主能改）。
  //    没开的话 @它说「#cd」照样能用。
  try {
    // 🆕 2026-10-16 关机策略闸：**先用纯正则的 `match()` 认出是哪条指令**（不发网络请求），
    //    再决定"关机时放不放它过去" —— 放行了才调 `build()` 真干活。
    //    ⚠️ 必须用 `match()` 而不是 `build()` 来做这个判断：`build()` 会真的去干活
    //       （取图 / 发网络请求），关机时不该白花这个力气。
    const rawContent = String(d.content || '');
    const hit = d.author?.bot ? null : await commands.match(rawContent, scope, d, (m) => console.log(`  ├ 📋 ${m}`));
    if (!power.isOn(scope) && hit && !commands.allowedWhenOff(hit.kind, (cfg.policy.commands || {}).commandsWhenOff)) {
      console.log(`  ├ ⏻ 已关机：指令【${hit.kind}】按策略 commandsWhenOff=`
        + `${String((cfg.policy.commands || {}).commandsWhenOff || 'menu')} 忽略（不回）`);
      return;
    }
    const cmd = d.author?.bot ? null
      : await commands.build(rawContent, scope, d, (m) => console.log(`  ├ 📋 ${m}`));
    if (cmd && cmd.silent) {
      console.log(`  ├ 📋 命中群内指令，但跳过（${cmd.why}）`);
      return;
    }
    if (cmd) {
      console.log('  ├ 📋 群内指令【#cd 菜单】文字回复');
      const ok = isGroup
        ? await sendGroupMarkdown(openid, cmd.text, d.id)
        : await sendPrivateMarkdown(openid, cmd.text, d.id);
      console.log(`  └ 📋 ${ok ? '✓ 已回复' : '✗ 回复失败'}（markdown）`);
      return;   // 🛑 指令走完就结束，不进上下文、不进 L0/L1/L2
    }
  } catch (e) {
    // 指令出问题**绝不能影响正常聊天** —— 打一行日志继续往下走
    console.warn(`  ├ 📋 群内指令处理异常（已忽略，继续正常流程）: ${e.message || e}`);
  }

  // 🛑 已关机：只留一行日志，什么都不做（不识别、不解析、不回话、不花钱）
  //
  // ⚠️ 连"上下文"都不记 —— 关机期间发生的事，开机后不该被它拿去接话
  //    （否则会出现"它刚醒就评论几小时前的话题"这种怪事）。
  // ⚠️ 事件仍然会落盘（handleEvent 第 1 步）—— 那是排查用的，不花钱，也方便看
  //    "关机这段时间群里发生了什么"。
  if (!power.isOn(scope)) {
    console.log(`  └ ⏻ ${isGroup ? '本群' : ''}已关机，忽略（@我说「开机」可恢复）`);
    return;
  }

  // 3.8 🆕 2026-10-15 复读：群里**连着两条一模一样**的消息 → 跟着读一遍
  //
  // 🔴 位置：开机之后、识图之前。理由：
  //    · 它在**关机判断之后** —— 遵守"关机 = 什么都不做"那条铁律，不为它开特例；
  //    · 它在**识图和链接解析之前** —— 一分钱都不该为它花（不看图、不查链接、不进上下文）
  //      ⇒ 群里真发生"连着两条一样的图/表情包"时，这一条会先复读、**跳过识图**，
  //        顺带还省了一张图的钱（那是这个功能白捡的收益）。
  //    · 它**不占额度、不写上下文、不进 L0/L1/L2**，发完就 return（见 repeat.js 头部）。
  //
  // ⚠️ 传 `d.content` 原文（只压空白、剥 @ 标记），**不传 brain.extractText(d)** ——
  //    后者会把识图描述/引用内容拼进来，那样"两条一样的图"会因为描述不同而判不出重复。
  // ⚠️ 这段整块包在 try 里：复读出任何问题都**不许影响正常聊天**。
  if (isGroup && !d.author?.bot && !brain.isAtRobot(type, d)) {
    try {
      const rp = repeat.note(scope, {
        text: String(d.content || ''),
        quoted: vision.refIdxOf(d),     // 两条都引用**同一句**才算复读（见 repeat.judge ②）
        isBot: !!d.author?.bot,
        now: Date.now(),
      });
      if (rp && rp.text) {
        console.log(`  ├ 🔁 ${rp.why} → 复读「${rp.text}」`);
        const ok = await sendGroupMessage(openid, rp.text, d.id);
        console.log(`  └ 🔁 ${ok ? '✓ 已复读' : '✗ 复读失败'}`);
        return;   // 🛑 复读完就结束：不进识图 / 链接 / L0 / L1 / L2（0 次模型调用）
      }
    } catch (e) {
      console.warn(`  ├ 🔁 复读判定异常（已忽略，继续正常流程）: ${e.message || e}`);
    }
  }

  // 3.9 🆕 2026-10-15 群友**投稿表情包**（`#tg` + 引用一张图）—— 用户需求
  //
  // 🔴 位置：**识图之前、链接解析之前**。三条理由：
  //    · 它要的不是"看图说话"，而是**图片字节**（进图库待确认）⇒ 不该先花一次识图钱；
  //    · `#tg` 是**我们自己**的指令，必须赶在 `commands.looksForeign()` 之前认掉
  //      （否则"井号开头的英文指令"那条规则会把它当别家 bot 的指令静默掉）；
  //    · 它自己的冷却/入库逻辑都在 `submit.js`，这里只负责"发那句话"。
  //
  // ⚠️ 三种返回，别搞混：
  //    · `null`        → 不是 `#tg`，原样往下走；
  //    · `{silent:true}`→ 是 `#tg` 但**格式不对 / 下载失败** ⇒ 一个字都不回（用户明确要求）；
  //    · `{text}`      → 要回一句（投稿成功 / 重复 / 冷却中 剩余 N 分钟 / 我们这边存不下）。
  if (isTgMsg && submitOn) {
    try {
      const r = await submit.handle(scope, d, { log: (m) => console.log(`  ├ 📥 ${m}`) });
      if (r && r.text) {
        const ok = await sendGroupMessage(openid, r.text, d.id);
        console.log(`  └ 📥 ${ok ? '✓ 已回复' : '✗ 回复失败'}：${r.text}`);
      } else {
        console.log(`  └ 📥 ${(r && r.why) || '格式不对'}（不回）`);
      }
      return;   // 🛑 投稿这一支走完就结束：不进识图 / 链接 / L0 / L1 / L2
    } catch (e) {
      console.warn(`  ├ 📥 投稿处理异常（已忽略，继续正常流程）: ${e.message || e}`);
    }
  }

  // 4.4 🆕 识图（2026-09-22）：把图片/表情包变成一句可读的话
  //
  // 🔑 为什么必须放在"提取文本"**之前**：识图结果要当成"这条消息的文字"，
  //    挂在消息对象的 `__vision` 上，`brain.extractText()` 会把它拼进去。
  //    这样 L0/L1/L2、上下文记忆……**全都自动看得见图片**，
  //    一处改动就够（改在 extractText 那个唯一出口）。
  //
  // ⚠️ 识图"只是让它看得见"，**不是"触发回复"**：
  //    光发一张表情包（没 @ 也没关键词）描述完照样会被 L0 拦下 ——
  //    这是"不抢答 / 省钱"的既有设计，别在这里破例。
  //    但描述**已经进了上下文**，之后有人问"刚那图啥意思"它能答上来。
  //
  // ⚠️ 机器人自己发的消息绝不识图（自环）：作者是 bot 就直接跳过。
  const img = d.author?.bot ? null : vision.findImage(d);
  if (img) {
    // 🆕 2026-10-15 投稿（#tg）用：**无论识图成没成、花没花钱，都把图片地址记下来** ——
    //    投稿要的是图片字节（描述换不回文件），而引用消息里 QQ 不会再给我们附件。
    //    ⚠️ 记在识图**之前**：被识图闸门挡掉的图（冷却/上限），投稿也该能用。
    //    🆕 2026-10-16 顺带把**发送者**也记上（`vision.authorIdOf`）：`#tg` 的"本群最近一张"
    //       兜底必须确认"这张图是发指令那个人自己发的"，否则会把别人的图存进图库（用户实测抓到）。
    vision.rememberImage(scope, vision.msgIdxOf(d), '', img.url, vision.authorIdOf(d));
    const vg = vision.visionAllowed(scope);
    if (!vg.ok) {
      // 🔴 被闸门拦掉也要**留痕**（用户 2026-10-11 要的），两份：
      //    ① console —— 一直就有，跟着 journal 走；
      //    ② 落盘 data/vision-stats.json —— 能回答"今天一共被拦了多少张、卡在哪"。
      //    同时给这条消息挂一句**固定说明**，免得模型自己编"图没传上来/你网络卡了"。
      d.__visionNote = vision.missNote(vg.key, vg.why);
      vision.recordMiss(vg.key, vg.why);
      console.log(`  ├ 🖼 有图片，但跳过识别（${vg.why}）${
        d.__visionNote ? ' → 已挂固定说明' : ''}`);
    } else {
      const vt = Date.now();
      try {
        const r = await vision.describe(img, (m) => console.log(`  ├ 🖼 ${m}`));
        const desc = r && r.desc;
        if (desc) {
          // ⚠️ 缓存命中（同一张图之前认过）**不占今日张数** —— 它一分钱没花。
          //    但冷却照走（否则一个表情包刷屏会被瞬间处理一遍）。
          vision.markVision(scope, !(r && r.cached));
          vision.recordSeen(!!(r && r.cached), true);   // 留痕：今天看成了一张
          d.__vision = desc;      // ← extractText 会把它拼进文本
          // 🔑 把"这条消息的编号 → 描述"记下来：
          //    之后有人**引用这张图**时，QQ 不会再把图片给我们，
          //    只会给一个 ref_msg_idx —— 靠这个缓存才能查回来。
          vision.rememberImage(scope, vision.msgIdxOf(d), desc, img.url, vision.authorIdOf(d));
          console.log(`  ├ 🖼 ${r && r.cached ? '命中缓存' : '识别成功'}`
            + `（${((Date.now() - vt) / 1000).toFixed(1)}s）：${desc}`);
        } else {
          // 只有"识别出来是空"才走这里（真失败会抛异常）
          d.__visionNote = vision.missNote('empty');
          vision.recordMiss('empty', '模型返回空描述');
          console.log('  ├ 🖼 模型返回空描述，当没图处理（已挂固定说明）');
        }
      } catch (e) {
        // ⚠️ 识图失败**不能影响正常聊天** —— 图看不懂就照原样继续（文字还在）
        d.__visionNote = vision.missNote('error');
        vision.recordMiss('error', e.message || String(e));
        console.warn(`  ├ 🖼 识别失败: ${e.message || e}（已挂固定说明）`);
      }
    }
  } else if (!d.author?.bot) {
    // ===== 没有新图片，但可能"指向"了一张老图 =====
    //
    // 🔴 两种情况，都是用户真机上很难受、必须兜住的：
    //   ① **引用了一张图 + @它**（手机 QQ 上没法"@ + 带图"，群友就这么干）
    //      这种消息 message_type=103，QQ **不给被引用的图片附件**，
    //      只给 `ref_msg_idx` → 用缓存查回描述。
    //   ② **刚发过图，紧接着只 @ 它**（图和 @ 分成两条消息）
    //      → 用本群最近那张图的描述。
    //
    // ⚠️ ② 的判断条件是 `brain.isMentionOnly(...)`，**必须在设 `__vision` 之前问** ——
    //    设完之后它就不算"只有@"了（这是个先有鸡还是先有蛋的顺序问题）。
    const refIdx = vision.refIdxOf(d);
    let quoted = refIdx ? vision.getImageDesc(scope, refIdx) : '';
    // 🔴 2026-10-17：读不出来时**不能就这么留白** —— 见 `selfQuotedImageText` 上面那段。
    if (!quoted && refIdx) quoted = selfQuotedImageText(scope, d, refIdx);
    if (quoted) {
      d.__vision = quoted;
      console.log(`  ├ 🖼 引用的是一条**图片**消息 → 用之前存下的描述：${quoted}`);
    } else if (brain.isMentionOnly(type, d)) {
      const recent = vision.recentImageDesc(scope, cfg.policy.vision?.recentImageMs ?? 30000);
      if (recent) {
        d.__vision = recent;
        console.log(`  ├ 🖼 本群刚发过图、这句只 @ 了它 → 用那张图的描述：${recent}`);
      }
    }
  }

  // 🆕 2026-10-13：引用消息 → 挂上"被引用的那句话是谁说的"（brain.extractText 会拼进文本）
  if (d.message_type === 103) {
    const qa = quotedAuthor(scope, d);
    if (qa.name) d.__quoteFrom = qa.name;
    else if (qa.isSelf) d.__quoteIsSelf = true;
  }

  const text = brain.extractText(d);
  // 🆕 2026-10-18：只含"这条消息自己说的话"，给按提问内容做判断的代码用（日期/模型/知识闸）。
  //    ⚠️ 不能用 text：它拼了引用内容 —— 引用里出现"今天几号"，就会把「bug纪录」当成问日期。
  const askText = brain.ownText(d);

  // 🆕 2026-10-23 日志里带上**稳定 id**（会话 + 发送者），学 qq-bridge 的做法：
  //   会话身份只认 id（group:<openid> / 发送者 openid），昵称只当显示用。
  //   ⚠️ 为什么：昵称会有全角空格 / 改昵称 / 带冒号，靠昵称反查群号必然出错
  //      （面板上冒出的「群 N（未命名）」孤儿卡就是这么来的）。
  //   格式：`GROUP_MESSAGE_CREATE#scope=group:xxx,uid=yyy | 昵称: 正文`
  //   —— 标记挂在"事件类型"后面，**不进正文**，老日志没有标记就退回原来的昵称/时间反查。
  const logUid = d.author?.member_openid || d.author?.id || d.author?.user_openid || '';
  const logTag = '#scope=' + scope + (logUid ? ',uid=' + logUid : '');
  console.log(`[${isGroup ? '群' : '私聊'}] ${type}${logTag} | ${who}: ${text || '(无文本内容)'}`);
  // 🆕 2026-10-23 梗库自动采集：**纯代码频次统计（0 调用）**，攒够阈值才让模型批量释义。
  //   用户：「把梗库面板删掉，让bot自己加」⇒ 新增交给这里，面板只留改/停用/删。
  //   ⚠️ 整段包 try：采集坏了绝不能影响回话。
  try {
    if (require('./settings').num('memeAuto', 1) !== 0) {
      const ml = require('./meme-learn');
      ml.observe(scope, askText, d.author?.member_openid || d.author?.id || who);
      if (isGroup && ml.shouldScan(scope)) {
        ml.scan(scope, brain.callAI).then((added) => {
          if (added && added.length) {
            console.log(`  ├ [meme-learn] 自动收录 ${added.length} 条：${added.map((x) => x.triggers[0]).join('、')}`);
          }
        }).catch((e) => console.warn(`  ├ [meme-learn] 释义失败（不影响回话）：${e.message}`));
      }
    }
  } catch { /* 采集坏了不影响回话 */ }
  if (cfg.policy.verbose) {
    console.log(`  ├ message_type=${d.message_type} mentions=${JSON.stringify(d.mentions || [])}`);
  }

  // 4. 能提出文本的消息才进上下文（卡片/并行消息/聊天记录不进，避免污染判断）
  //    ⚠️ 不能只判 message_type===0 —— 103 引用消息是可读的，要让它也进上下文，
  //       否则机器人看不到"对方刚才引用了什么"。
  //    ⚠️ 第 4 个参数 d.id 是给"别把当前这条送两遍"用的（见 brain.contextText）：
  //       它必须进上下文（后面几条消息要看得见它），但拼提示词时要挑出去。
  if (text && brain.hasUsableText(d)) brain.pushContext(scope, who, text, d.id);

  // 4.5 🆕 链接解析（GitHub / B站）—— **故意放在 L0 之前**
  //
  // ⚠️ 为什么要绕过 L0：用户明确要求「无需 @，采集到就回复」，而 L0 里
  //    `sampleNonKeyword: 0` 会把"没 @ 也没关键词"的消息全拦掉 —— 走不到这里。
  //    代价是自己管护栏：同群冷却 / 每日上限 / 静默时段 / 连发上限（都在 linkparse 里）。
  //
  // ⚠️ 护栏没过时**不要 return**，要让它继续走下面的正常流程 ——
  //    否则"在冷却期里问它一个问题"会被这条支路吞掉，那才是 bug。
  // ⚠️⚠️ 机器人自己发的消息**绝不能走链接解析** —— 这是个真会死循环的坑：
  //      · 卡片里本身就写着 `[🔗 在 B站打开](https://www.bilibili.com/...)`
  //      · 而这条支路跑在 passHardRules **之前**，那里才是检查 author.bot 的地方
  //      · 一旦收到自己的消息（或另一个机器人发的同款卡片），就会**自己解析自己 → 自己回自己**
  //     所以这里**必须**自己先挡一道。
  // 🆕 2026-10-23 面板「链接自动解析」开关：关掉后群里贴链接不再自动回卡片。
  const lpOn = (() => {
    try { return Number(require('./settings').num('linkParseEnabled', 1)) !== 0; } catch { return true; }
  })();
  const links = (!lpOn || d.author?.bot) ? [] : linkparse.findLinks(d, cfg.policy.linkParse?.maxLinksPerMessage || 2);

  // 🆕 4.5b B站「小程序卡片」—— 平台**不给 URL**，只能拿标题去 B站反查
  //
  // 背景：群友从 B站 App 分享的卡片是 `message_type=3 / ark_type=miniapp`，
  //      里面只有 `title`（视频标题的原样拷贝）和一张封面，**一个 URL 都没有**，
  //      所以 findLinks 扫不出来、原来会被 L0 按「暂不支持的类型(卡片)」拒掉。
  //
  // ⚠️ 这里**只做纯判断、不发请求** —— 反查要打 B站搜索接口（1~3 次），
  //    得先过闸门（冷却 / 静默时段 / 连发上限）再打，否则在冷却期里就是白打。
  const card = (lpOn && !links.length && !d.author?.bot) ? linkparse.bilibiliCard(d) : null;
  const cardTitle = card ? card.title : '';

  if (links.length || cardTitle) {
    // ⚠️⚠️ 「被点名」必须和正常流程一样**绕过连发上限**（2026-09-22 实测踩到）：
    //     passHardRules 里是 `bypass = at || owner` —— @ 它、或主人说话，都不受
    //     maxConsecutive（3 分钟 2 次）约束。这条支路跑在它**前面**，得自己实现同样豁免。
    //     不这么做的后果实测过：连发三条 @（你好 / 数字 / 链接），
    //     前两条各回一次，第三条带链接时被判"连发已达上限"→ 跳过 → 退回普通闲聊，
    //     卡片死活出不来。而普通流程因为 @ 豁免了，所以看起来"它明明收到了却不解析"。
    const named = brain.isOwner(d) || brain.isAtRobot(type, d);
    const gate = linkparse.linkAllowed(scope);
    const what = links.length
      ? `${links.length} 条链接（${links[0].platform} 等）`
      : '一张 B站小程序卡片';

    // 🆕 2026-10-10：**卡片不再被"本群连发上限"挡掉**
    //
    // 用户报「小肥鱼广场的B站卡片没返回」，翻 24 小时日志统计原因：
    //   标题反查命中 27 次 · 卡片已发送 14 次 · **「连发已达上限且没被点名」跳过 7 次** ·
    //   反查没搜到 1 次（那次回了话）· 其余是普通聊天的不回
    // ⇒ 那 7 次就是"它明明收到了却一声不吭"的元凶：机器人刚在本群说过话（3 分钟 2 次），
    //   于是卡片被判超限、**静默丢弃** —— 群友体感就是"它没理我"。
    //
    // 🔑 为什么可以放心去掉这道判据：卡片解析**自己有一层更严格的闸门** ——
    //    `linkAllowed` 的**每会话冷却**（`linkParse.cooldownMs`，比"3 分钟 2 次"严得多），
    //    刷屏照样被挡，而且是**有日志、有理由**的挡。
    //    反过来，"因为机器人刚说过话就不解析卡片"是把两件无关的事绑在了一起。
    if (!gate.ok) {
      console.log(`  ├ 🔗 看到 ${what}，但先跳过（${gate.why}）`);
    } else {
      if (!named && !brain.consecutiveOk(scope)) {
        // 留痕但**不再拦**（方便以后回看有多少次是被这条放行的）
        console.log('  ├ 🔗 本群连发已达上限，但卡片照常解析（2026-10-10 起不再静默丢弃）');
      }
      // 🆕 卡片才需要反查（链接不用）—— **过了闸门才发请求**
      let found = links;
      if (!found.length) {
        found = await linkparse.resolveBilibiliCard(cardTitle, card?.preview || '', (m) => console.log(`  ├ 🔗 ${m}`));
        if (!found.length) {
          console.log('  ├ 🔗 B站小程序卡片：平台没给链接，用标题也没搜到完全同名的');
          // 🆕 2026-10-09：这里原来**完全静默** —— 群友发一张卡片、机器人一声不吭，
          //    和"它根本没识别到这张卡片"在体感上完全没区别。
          //    现在回一句（同样走节流），回完**继续走正常流程**（别 return）。
          await noticeLinkFail(scope, openid, d, cfg.policy.linkParse?.failNotice?.cardText);
        } else {
          console.log(`  ├ 🔗 B站小程序卡片 → 标题反查命中 ${found[0].url}`);
        }
      }
      if (found.length) {
        linkparse.markLink(scope);
        await handleLink(d, found, scope, isGroup, openid);
        return;
      }
    }
  }

  // 5. L0 硬规则
  const l0 = brain.passHardRules(scope, d, type, isPrivate);
  if (!l0.ok) {
    // 🆕 @ 得太频繁被挡时，说一句话告诉对方"不是坏了，是故意的"
    //    （这句话自己也有节流，见 policy.atLimits.noticeCooldownMs —— 默认 3 分钟/人）
    if (l0.rateNotice) {
      console.log(`  └ 不回（${l0.why}）→ 发一句提示`);
      const sent = isGroup
        ? await sendGroupMessage(openid, l0.rateNotice, d.id)
        : await sendPrivateMessage(openid, l0.rateNotice, d.id);
      // ⚠️ 说话要计入"本群连发上限"，否则这句提示本身会绕开防刷屏
      if (sent) brain.markScopeReplied(scope);
      return;
    }
    console.log('  └ 不回（' + l0.why + '）');
    return;
  }

  // 5.4 🆕 情绪观察器（2026-10-05）—— **只读旁路：只打日志，绝不改行为**
  //
  //   为什么放这里（过了 L0、还没进 L1）：能拿到完整文本（识图描述已在第 ① 步挂上），
  //   而且**在花钱的判断之前** —— 观察器是零成本的，不该让它挤占模型预算。
  //
  //   🔴 它对下面这条管线**没有任何影响**：
  //      · 不 push 进 `contexts`（那会变成下一轮的输入 ⇒ 自我强化污染）
  //      · 不发消息、不改人设、不落盘、不调用模型
  //      · 整个包在 try 里，***坏了也不影响后面回不回话***
  if (cfg.policy.emotionObserve?.enabled) {
    try {
      const opt = cfg.policy.emotionObserve;
      if (!opt.onlyWhenAddressed || l0.isAt || l0.hitKeyword) {
        emotion.observe({
          msgId: d.id,
          scope,
          openid: d.author?.member_openid || d.author?.id || '',
          nick: d.author?.username || '',
          text: brain.extractText(d),
          isAt: !!l0.isAt,
          hitKeyword: !!l0.hitKeyword,
          rate: Number.isFinite(opt.rate) ? opt.rate : 1,
        });
      }
    } catch (e) {
      console.warn(`  └ [emo] 观察出错（不影响回话）：${e.message}`);
    }
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

  // 5.55 🆕 2026-10-23 梗库「镜像替换」→ **代码直回，不调模型**
  //   场景：用户刷屏「@我 token来！🖐😡🤚token来！…」，期望回一屏「token回！🖐😡🤚…」。
  //   🔴 用模型做这件事实测会被改写/截断（它回了"喊这么多遍，盆都给你喊翻了"），
  //      因为"换一个字"是确定性变换 —— 按项目原则：能由代码干的别塞给模型，0 成本且不会错。
  //   只在"被 @ / 命中关键词 / 私聊 / 主人"时触发，避免它自己跑出来接所有人的梗。
  if (l0.isAt || l0.hitKeyword || isPrivate || brain.isOwner(d)) {
    let echo = null;
    try { echo = require('./memes').echoReply(askText || brain.ownText(d)); } catch { echo = null; }
    if (echo) {
      console.log(`  ├ 梗库镜像：${echo.from}→${echo.to}（不调模型）`);
      const sent = isGroup
        ? await sendGroupMessage(openid, echo.text, d.id)
        : await sendPrivateMessage(openid, echo.text, d.id);
      if (sent) brain.markReplied(scope, d.author?.user_openid || d.author?.member_openid);
      return;
    }
  }

  // 5.6 🆕 纯寒暄（打招呼 / 道别）→ **零成本固定应答**（2026-10-05）
  //
  //   🔴 起因：群里有人发「早安肥鱼」，鱼回了「早啊，今天又来找我聊天？」
  //      —— 对方只是打个招呼、没有下文，那句话等于**给不存在的对话起了个标题**。
  //      根因是"早安"命中了关键词（肥鱼）→ 固定 9 分 → 直接生成。
  //
  //   ⇒ 早安/晚安是**闭合动作**，回一句就完了：不调模型、不追问、不邀约。
  //   ⚠️ 判据很窄（见 brain.isPureGreeting）：剥掉名字后只剩寒暄词 + ≤6 字 +
  //      无疑问/请求 + 必须点名。判不准就往下走原来的流程。
  //   💰 顺带省钱：这类消息以前要花一次 L2 生成。
  if (cfg.policy.greetingReply?.enabled) {
    const g = brain.isPureGreeting(d, { isAt: !!l0.isAt }) || {};
    if (g.greeting) {
      const opt = cfg.policy.greetingReply;
      const pool = (g.kind === 'bye' ? opt.bye : opt.hello) || ['嗯'];
      const reply = pool[Math.floor(Math.random() * pool.length)];
      console.log(`  ├ 纯寒暄（${g.word}）→ 回固定应答，不调模型`);
      const sent = isGroup
        ? await sendGroupMessage(openid, reply, d.id)
        : await sendPrivateMessage(openid, reply, d.id);
      if (sent) brain.markReplied(scope, d.author?.user_openid || d.author?.member_openid);
      return;
    }
  }

  // 5.7 🆕 2026-10-18：模型自述 —— 仅在 truth 模式才代码直答（见文件头 MODEL_ASK_RE）
  //     🔴 用户拍板「人设优先」⇒ 默认 persona 模式**不接管**：人设是人是 AI，都按人设演；
  //        否则被问一句"你用什么模型"就把"我是人"的人设当场戳破。
  const selfModelMode = (cfg.policy.selfModelAnswer && cfg.policy.selfModelAnswer.mode) || 'persona';
  if (selfModelMode === 'truth' && (l0.isAt || brain.isOwner(d)) && MODEL_ASK_RE.test(askText || '')) {
    const LABEL = { 'deepseek-flash': 'V4.1 Flash', 'deepseek-v4-pro': 'V4-Pro' };
    const mid = cfg.ai.replyModel;
    const reply = `我现在跑的是 DeepSeek ${LABEL[mid] || mid}（${mid}）。`;
    console.log(`  ├ 问到模型 → 代码直答：${mid}（不调模型）`);
    const sent = isGroup
      ? await sendGroupMessage(openid, reply, d.id)
      : await sendPrivateMessage(openid, reply, d.id);
    if (sent) brain.markReplied(scope, d.author?.user_openid || d.author?.member_openid);
    return;
  }

  // 5.8 🆕 2026-10-18：日期/时间 → 代码直答
  //   🔴 事故：它先答"十月十八号"，16 秒后被同一个问题再问一次，为了**避免重复**把日期
  //      改成"十七号，星期六"。事实不能被拟人化规则改掉 ⇒ 这类问题不再交给模型。
  const dtAns = brain.dateAnswer(askText || '');
  if (dtAns && (l0.isAt || brain.isOwner(d))) {
    console.log(`  ├ 问到日期/时间 → 代码直答：${dtAns}`);
    const sent = isGroup
      ? await sendGroupMessage(openid, dtAns, d.id)
      : await sendPrivateMessage(openid, dtAns, d.id);
    if (sent) brain.markReplied(scope, d.author?.user_openid || d.author?.member_openid);
    return;
  }

  // 5.9 🆕 2026-10-19：二进制/十六进制「解码」→ 代码直算
  //   🔴 事故：@它「解码 11100101 …」，没开思考（"解码"不在事实题判据里）⇒ 答「早上好」，
  //      真值是「噫吁嚱是gay」。纯机械转换，代码算 0 成本且不会错。
  const decAns = brain.decodeAnswer(askText || '');
  if (decAns && (l0.isAt || brain.isOwner(d))) {
    console.log(`  ├ 请求解码 → 代码直算：${decAns}`);
    const sent = isGroup
      ? await sendGroupMessage(openid, decAns, d.id)
      : await sendPrivateMessage(openid, decAns, d.id);
    if (sent) brain.markReplied(scope, d.author?.user_openid || d.author?.member_openid);
    return;
  }

  // 6. L1 便宜模型判断
  const l1 = await brain.shouldReply(scope, d, l0.hitKeyword, l0.isAt);

  // 6.2 预算用尽：不只是沉默，要让群里知道原因
  //     注意判断发生在 callAI 内部，所以这里要把理由捞出来发出去。
  //
  // 🔴 2026-10-01 修：原来这里**没有节流** —— 上限撞到 ¥10 之后，
  //    每来一条触发消息就发一次「没钱了」，24 小时内发了 **285 次**，
  //    把群刷了（群友开始回「没钱了（）」）。
  //    现在改成**每个群每天最多说一次**，其余那条静默（日志照记 blocked）。
  if (l1.budgetStop) {
    if (!budget.shouldAnnounceStop(scope)) {
      console.log('  └ 预算已用尽（本群今天已经告知过，静默）');
      return;
    }
    console.log(`  └ 预算已用尽，告知群里（本群今天第一次）`);
    const msg = l1.reason === '预算已用尽' ? '没钱了，等充值吧' : l1.reason;
    const sent = isGroup
      ? await sendGroupMessage(openid, msg, d.id)
      : await sendPrivateMessage(openid, msg, d.id);
    if (sent) brain.markReplied(scope, d.author.user_openid || d.author.member_openid);
    return;
  }

  // 6.5 第二道闸：判断说"可回"之后，再抽一次概率（省钱）。
  // ⚠️ 但被 @ 是明确点名，抽签会让"@ 它一半不理"，所以 @ 直接免抽。
  const passedChance = l0.isAt || Math.random() < cfg.policy.replyChance;
  if (!l1.reply || l1.score < cfg.policy.scoreThreshold || !passedChance) {
    const why = !l1.reply || l1.score < cfg.policy.scoreThreshold
      ? `L1 ${l1.score}: ${l1.reason}`
      : `抽签未中(replyChance=${cfg.policy.replyChance})`;
    console.log(`  └ 不回（${why}）`);
    return;
  }

  // 7. L2 生成
  //    🆕 带上"本群刚刚处理过什么链接"—— 治"刚发完卡片、被问到时却说解析不了"
  const linkNote = linkparse.contextNote(scope);
  // 🆕 2026-10-22 梗库：只在**命中触发词**时注入一句提示（0 额外调用，正常聊天不加 token）
  //    ⚠️ 用 ownText（本条自己的话）匹配，不用 extractText —— 否则引用里的词会误触发。
  //    ⚠️ 注入到 user 文本（extraNote），**不进 system** —— 不动稳定前缀、不打碎缓存。
  const memeNote = (() => {
    try {
      const m = require('./memes').hint(askText || brain.ownText(d));
      if (m) console.log(`  ├ [meme] 梗库命中，注入 ${m.split('\n').length - 1} 条`);
      return m;
    } catch { return ''; }
  })();
  const extraNote = [linkNote, memeNote].filter(Boolean).join('\n');

  // 7.1 🆕 2026-10-18 知识闸（A+B 里的 B）：只在"像在问事实"时多问判断模型一句"你真的知道吗"。
  //     判为 unknown ⇒ ①生成时追加"只能说不确定"的硬约束；②回复过一遍 sanitizeReply 硬闸。
  //     ⚠️ 闸坏了/预算没了都返回 skip（fail-open）—— 宁可照常回，也不能让它一个字都不说。
  const kg = await brain.knowledgeGate(askText || '');
  const kgUnknown = kg === 'unknown';
  if (kg !== 'skip') console.log(`  ├ 知识闸：${kg}`);
  const gen = await brain.generateReply(scope, d, extraNote, { unknown: kgUnknown });

  // 7.5 生成阶段才发现预算用尽 —— 同样把理由发出去（**同一套节流**，否则这里有第二条刷屏路径）
  if (gen && gen.budgetStop) {
    if (!budget.shouldAnnounceStop(scope)) {
      console.log('  └ 预算已用尽（本群今天已经告知过，静默）');
      return;
    }
    console.log('  └ 预算已用尽，告知群里（本群今天第一次）');
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
  //    🆕 2026-10-06：整串发送**按会话排队**（修"同群两个人同时问 → 8 条交叉刷出来"）
  // 7.6 🆕 2026-10-18 回复硬闸（A）：无来源链接替换；判为不知道却仍冒出具体年份/日期/版本/价格 ⇒ 换话术
  const finalReply = brain.sanitizeReply(reply, { unknown: kgUnknown, allowedText: `${text || ''}\n${extraNote}` });
  if (finalReply !== reply) console.log('  ├ 回复硬闸：改写了模型输出');
  const replaced = finalReply !== reply;
  let segments = (!replaced && gen.segments && gen.segments.length) ? gen.segments : [finalReply];
  // 🆕 日额度吃紧时不再拆段（少发几条本身也是帮忙）
  if (segments.length > 1 && !splitAllowed()) {
    console.log('  ├ 额度吃紧：不拆段（合并成一条发）');
    segments = [segments.join('')];
  }

  // ⭐ 什么时候带"引用"：
  //    ① 因关键词触发（没被 @）时引用原消息 —— 对方才知道它在回哪句话
  //    ② 🆕 这一串是"排在其他回复之后"发的 —— 连着刷几串时不引用就分不清谁在回谁
  //    被 @ 时通常不引用（@ 已指明对象），但第 ② 种情况例外。
  const sendMeta = { queuedBehind: false };
  const quoteWanted = (cfg.policy.quoteOnKeywordReply && l0.hitKeyword && !l0.isAt);
  if (quoteWanted) console.log('  ├ 带引用回复');

  if (segments.length > 1) {
    console.log(`  ├ 分段发送：${segments.length} 条`);
  }

  const okCount = await sendqueue.enqueue(scope, sendMeta, async () => {
    // 引用在"排到我们"时才最终决定（排队期间可能又来了别的回复）
    const ref = (quoteWanted || sendMeta.queuedBehind) ? brain.messageRefId(d) : null;
    if (sendMeta.queuedBehind) {
      console.log('  ├ 同群排队：等前一条串发完再发' + (ref ? '，并带引用' : ''));
    }
    let ok = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      // 第 2 条起先等一下 —— 这是"人味"的关键：真人不会瞬间连发
      if (i > 0) await sleep(brain.nextSendDelay());
      const sent = isGroup
        ? await sendGroupMessage(openid, seg, d.id, ref)
        : await sendPrivateMessage(openid, seg, d.id, ref);
      if (sent) ok++;
    }
    // 🆕 2026-10-13 图库：模型选了图就跟着发一张（同一队列里发，顺序才不乱）
    if (isGroup && gen.imgId) await sendLibImage(d, openid, scope, gen.imgId);
    return ok;
  });

  // 9. 只有发出去才算回复过（部分成功也算，否则会重复触发同一条）
  if (okCount > 0) {
    brain.markReplied(scope, d.author.user_openid || d.author.member_openid);
    brain.pushContext(scope, cfg.persona.name, finalReply);
  } else {
    console.log('  └ 发送失败，不计入冷却（下条消息仍可尝试）');
  }
}

// ============================================================
//  🆕 2026-10-13 图库：把模型挑的那张图发进群
//
//  用户拍板：同群 **5 分钟**一张、**不设每日上限**（"允许插图"）、先只在**测试群**生效。
//  🔴 闸门判断**不在这里写第二份** —— 统一走 `imglib.sendGate()`，
//     因为 `brain.buildImgHint()` 生成前也要问同一个闸门：
//     两边判断不一致就会出「文字答应了发图、代码却没发」（2026-10-13 用户实测到的问题）。
//  这里保留检查只为**兜底**（生成后到发送之间可能过了很久 / 队列里排过队）。
//  发送链路和视频完全一样：读本地字节 → `qqmedia.uploadMedia(..., 1 /*图片*/)` → `sendGroupMedia`。
//  为什么不用 `downloadToBuffer`：图就在本地磁盘上，没有任何理由再走一次网络。
// ============================================================
async function sendLibImage(d, groupopenid, scope, imgId) {
  let lib;
  try { lib = require('./imglib'); } catch { return false; }

  const gate = lib.sendGate({
    scope,
    groupOpenid: groupopenid,
    groupId: d && d.group_id,
    isOwner: !!(d && brain.isOwner(d)),        // 主人免冷却（和生成前的判断保持一致）
    // 🆕 2026-10-14 晚：这是**发送前**那次判断 ⇒ `consume: true` = **不重抽概率签**，
    //    只验"生成前抽中的那张签还在不在"。重抽会让模型看到"能发"却发不出去（老 bug）。
    consume: true,
  });
  if (!gate.ok) {
    console.log(`  ├ 🖼 想发图但闸门没放行：${gate.why}`);
    return false;
  }

  // 🔴 2026-10-13 修「模型报的 id 在图库里找不到」⇒ 用户看到的是**文字答应了、图却没来**。
  //    真机证据（18:34:51）：回复「主人要就再给一张，这张也挺顺眼的。」后面跟着
  //    `🖼 模型报的图 gmv69bei6e2m 在图库里找不到` —— **模型自己拼了一个 id**
  //    （真 id 形如 `gmv69b3qz5za`，它照着样子编了个很像的）。
  //    ⇒ 两道兜底（都是"说了就得真的做"，而不是让文案落空）：
  //      ① **近似纠正**：库里恰好有一个"同长度且只差 ≤2 个字符"的 id → 那就是它想指的，直接用；
  //      ② **换一张**：纠正不了就**从候选里挑一张真图**发出去（闸门都放行了，说明这轮本该配图）。
  //    两条都会打日志留痕，方便事后核对到底发的是哪张。
  const id0 = String(imgId || '').trim();
  let id = id0;
  let it = lib.get(id);
  if (!it) {
    const ids = lib.approved().map((x) => x.id);
    const near = ids.filter((x) => x.length === id0.length
      && [...x].filter((c, i) => c !== id0[i]).length <= 2);
    if (near.length === 1) {
      console.log(`  ├ 🖼 模型报的 id ${id0} 不存在 → 自动纠正为最接近的 ${near[0]}`);
      id = near[0];
      it = lib.get(id);
    }
    if (!it) {
      // ② 挑一张真的（用同一套滚动窗口，保证不会老挑同一张）
      let cand = [];
      try { cand = brain._pickImgForScope(scope, 1, ''); } catch { cand = []; }
      if (!cand.length) {
        console.log(`  ├ 🖼 模型报的图 ${id0} 在图库里找不到，候选也没有 → 不发`);
        return false;
      }
      id = cand[0].id;
      it = cand[0];
      console.log(`  ├ 🖼 模型报的图 ${id0} 在图库里找不到 → 改用候选里的 ${id} 顶上（别让文案落空）`);
    }
  }
  if (it.status !== 'approved') { console.log(`  ├ 🖼 图 ${id} 还没入库（状态 ${it.status}），不发`); return false; }
  let buf = lib.readFile(id);
  if (!buf) { console.log(`  ├ 🖼 图 ${id} 的文件读不出来`); return false; }
  // 🆕 记下"发出去时到底是什么尺寸"（压缩可能改过），日志里要用
  let dimNote = (() => {
    try { const d = require('./imgsvc').dimsOf(buf); return d ? `${d.w}x${d.h}` : '尺寸?'; } catch { return '尺寸?'; }
  })();

  // 🆕 2026-10-16 用户：「从图库提取出来的图发到群里都好大，占空间，能不能压缩」
  //    ⇒ **发之前压一道**（只压 PNG、只压大图；压不小就原样发）。
  //    ⚠️ 只动"即将发出去的这份字节"，**磁盘上的素材一个字节都不改**（红线：别碰用户数据）。
  //    ⚠️ 失败/不划算都会 `changed:false`，行为与以前完全一致 —— 这条压缩**永不阻塞发图**。
  try {
    const ic = cfg.policy.imglib?.compress || {};
    if (ic.enabled !== false) {
      // ⚠️ 走 `imgsvc`（PNG→Node 引擎；JPEG/WebP→Pillow）而不是直接 `imgcompress`：
      //    图库里也有 JPEG（实测 216KB 那张全屏图就是），只压 PNG 会漏掉一半。
      // ⚠️ 第三个参数是**缓存键**（图库 id）：同一张图反复发时不重复算（CPU 不便宜）
      const r = require('./imgsvc').shrink(buf, ic, id);
      if (r.changed) {
        console.log(`  ├ 🖼 发图前压缩：${r.why}`);
        buf = r.buf;
      } else {
        console.log(`  ├ 🖼 不压缩（${r.why}）`);
      }
    }
  } catch (e) {
    console.warn(`  ├ 🖼 压缩模块异常（已忽略，原样发）：${e.message || e}`);
  }

  try {
    // ⚠️ 压缩可能改过尺寸 ⇒ 这里**重新嗅一次**（用压缩后的 buf），否则日志里报的是旧尺寸
    try { const d2 = require('./imgsvc').dimsOf(buf); if (d2) dimNote = `${d2.w}x${d2.h}`; } catch { /* 忽略 */ }
    const fileInfo = await qqmedia.uploadMedia('groups', groupopenid, buf, it.filename || (id + '.png'), 1,
      (m) => console.log(`  ├ 🖼 ${m}`));
    const ok = await sendGroupMedia(groupopenid, fileInfo, d.id);
    // 🆕 2026-10-16 把**最终尺寸**也打进日志：用户三次问"怎么有大有小"，
    //    而日志原来只有 KB —— 光看 KB 根本答不了"显示尺寸"的问题（这次就是吃了这个亏）
    console.log(ok
      ? `  └ 🖼 ✓ 已发图（${id} · ${(buf.length / 1024).toFixed(0)}KB · ${dimNote})`
      : '  └ 🖼 ✗ 图发送失败（看上面的 err_code）');
    if (ok) {
      // 🔴 2026-10-16 用户：「发图库的冷却，把主人占用扔出去，不然主人无限制发图还占用群友冷却」
      //    ⇒ 主人**不占**群冷却（只免检查、照样记账 = 群友的 180 秒窗口被主人吃掉）。
      //    判定取闸门带回来的 `gate.ownerFree`，与"免检查"那一处完全一致。
      lib.noteSent(scope, { ownerFree: gate.ownerFree, explicit: gate.explicit });   // ← 冷却以"真发出去"为准；主人、机器人自配都不占群窗口
      try { lib.markUsed(id); brain._noteImgUsed(scope, id); } catch { /* 记账失败不影响发送 */ }
      // 🆕 2026-10-17：把"我自己刚发出去的这张图"记一份（含它长什么样）——
      //    群友引用它问「这个是你吗」时，我们才答得上来（见 `selfQuotedImageText`）。
      //    ⚠️ `ok` 是发送接口的返回 JSON，`ok.id` 就是这条消息的 id；有它就能**精确**命中引用。
      try {
        vision.noteSelfImage(scope, it.desc || '', ok.id || '', id);
        console.log(`  ├ 🖼 已记档"我发出去的这张图"（${ok.id ? 'msgid=' + ok.id : '没拿到 msgid，只能按"最近一张"兜底'}）`);
      } catch { /* 记档失败不影响发图 */ }
    }
    return ok;
  } catch (e) {
    // 发图失败**绝不**影响已经发出去的文字（它已经发出去了）
    console.warn(`  └ 🖼 发图异常（已忽略）：${e.message || e}`);
    return false;
  }
}

// 🆕 链接卡片支路：抓元信息 → 发 Markdown 卡片（可能有多条链接 → 多张卡片）
//
// 全程**不调模型**（卡片是模板拼的）→ 这个功能不花钱，也天然免疫提示注入
// （抓回来的标题是用户可控文本，但我们只把它当字符串拼进卡片，不当指令读）。
//
// 🔴 支持一条消息里贴**多个**链接（2026-09-22 用户实测踩到）：
//    用户一条消息发了「抖音链接 + 快手链接」，旧版只解析第一个 →
//    快手那条被**静默丢掉**，用户完全不知道发生了什么。
//    ⚠️ 但不能无限发：**被动回复配额是 5 条 / 单条消息**，
//       而每个链接最多要 3 条（卡片 + 解析提示 + 视频）。
//       所以：卡片最多发 `maxLinksPerMessage`（默认 2）张，
//       **视频整条消息最多发 1 个**（2 卡片 + 1 提示 + 1 视频 = 4 ≤ 5）。
// 🆕 2026-10-09：链接 / 卡片**识别到了、但解析不出内容**时，回一句短的。
//
// 起因（用户原话）：「看测试群日志，为什么快手视频不@没自检」
//   —— 查日志发现**自检是有的**（`🔗 kuaishou 链接` 那行就是证据），只是快手取数靠
//      "抓页面 HTML 再抠内嵌 JSON"，页面一抖就抠不到；失败之后**除了日志一声不吭**，
//      于是群里看到的就是"机器人没理我"，被当成"它根本没检测到链接"。
//
// ⚠️ 必须节流：快手偶尔会连着翻车，每次都回就是刷屏 —— 同一个群 N 分钟只提示一次。
const linkFailAt = new Map();
function pickFailText() {
  const c = cfg.policy.linkParse?.failNotice;
  const pool = (Array.isArray(c?.texts) && c.texts.length)
    ? c.texts : ['🔗 链接收到了，但没解析出内容'];
  return String(pool[Math.floor(Math.random() * pool.length)]);
}
async function noticeLinkFail(scope, openid, d, text) {
  const c = cfg.policy.linkParse?.failNotice;
  if (c?.enabled === false) return;
  const cd = Number(c?.cooldownMs) || 5 * 60 * 1000;
  const last = linkFailAt.get(scope) || 0;
  if (Date.now() - last < cd) {
    console.log(`  ├ 🔗 本可以回一句"没解析出内容"，但本群 ${Math.round((Date.now() - last) / 1000)}s 前刚说过 → 不重复`);
    return;
  }
  linkFailAt.set(scope, Date.now());
  const msg = text || pickFailText();
  const ok = await sendGroupMessage(openid, msg, d.id);
  console.log(`  ├ 🔗 已回一句"解析失败"提示${ok ? '' : '（⚠️ 发送失败）'}：${msg}`);
}

async function handleLink(d, links, scope, isGroup, openid) {
  // 🆕 2026-10-09「已读回执」：抖音解析要 ~17 秒（起无头浏览器），卡片迟迟不来，
  //    群友会以为机器人根本没读到这条链接。
  //    实测耗时（2026-10-09 服务器）：B站 226ms · 快手 1~3s · 抖音 ~17s
  //    ⇒ 默认**只有抖音**发这句（B站/快手秒出，发了反而怪）；想全平台发改 ackAllPlatforms。
  //    ⚠️ 一条消息**只发一次** —— 被动回复配额 5 条，2 个抖音链接发两次会超。
  {
    const dc = cfg.policy.linkParse?.douyinDirect;
    if (isGroup && links.length) {
      const needAck = dc?.ackAllPlatforms ? true : links.some((l) => l.platform === 'douyin');
      if (needAck) {
        const pool = (Array.isArray(dc?.ackTexts) && dc.ackTexts.length)
          ? dc.ackTexts : [dc?.ackTemplate || '🔗 链接收到了，正在解析，稍等一下…'];
        const text = String(pool[Math.floor(Math.random() * pool.length)]);
        const ok = await sendGroupMessage(openid, text, d.id);
        console.log(`  ├ ⏳ 已发"已读"回执${ok ? '' : '（⚠️ 发送失败）'}：${text}`);
      }
    }
  }

  // ① 先把所有链接都解析出来（解析失败的不占位置）
  const parsed = [];
  const seenId = new Set();
  // 🆕 2026-10-09：要区分两种"没出卡片"的情况（见下面 if (!parsed.length) 的处理）
  let failCount = 0;   // 真的解析不出内容
  let dupCount = 0;    // 被去重 / 防重复跳过
  for (const link of links) {
    console.log(`  ├ 🔗 ${link.platform} 链接: ${String(link.url).slice(0, 90)}`);
    try {
      // ⚠️ 第二个参数（消息原文）只有抖音图文用得到：它平台不给数据，
      //    要靠分享文案里的「【作者.的图文作品】正文」兜底（见 linkparse.fetchDouyin）
      const p = await linkparse.parse(link, String(d.content || ''));
      if (!p || !p.card) { console.log('  │  └ 这条解析不出内容，跳过'); failCount++; continue; }

      // 🔴 解析之后**再**去一次重 —— 按"解析出来的身份"，不是按 URL。
      //    实测：一条合并转发里有 3 个 issue 链接（141/140/136），全指向同一个仓库，
      //    按 URL 去重一个都不少 → 发了 2 张一模一样的卡片。
      //    （findLinks 里已经按 URL 抠出的 id 去过一次，这里兜住"短链才解析出真 id"的情况）
      const ikey = linkparse.infoKey(p.info);
      if (ikey && seenId.has(ikey)) {
        console.log(`  │  └ 和前面那条指向同一个内容（${ikey}），跳过`);
        dupCount++;
        continue;
      }

      // 🔴 "刚发过"就跳过 —— 这是治「群友引用机器人卡片 → 卡片又发一次」的主防线。
      //    引用时 QQ 会把我们卡片的 markdown 原样喂回来，链接一模一样，
      //    按 key 一查就知道"这是我们自己刚发的"。
      const ago = linkparse.wasCarded(scope, [link.key, ikey]);
      if (ago) {
        console.log(`  │  └ 本群 ${ago} 秒前刚发过这条（${ikey || link.key}），跳过（防自我二次解析）`);
        dupCount++;
        continue;
      }

      if (ikey) seenId.add(ikey);
      p._keys = [link.key, ikey];
      parsed.push(p);
    } catch (e) {
      console.warn(`  │  └ 链接解析异常: ${e.message || e}`);
      failCount++;
    }
  }
  if (!parsed.length) {
    // ⚠️ 各平台的失败原因不一样，写全，免得以后翻日志时误判
    console.log(`  └ 不回（${failCount} 条解析不出内容 / ${dupCount} 条去重跳过 —— 私有仓库 / 已删除 / 番剧付费 / 快手页面改版 / 抖音被限流）`);
    // 🆕 2026-10-09：**真的解析失败**才回话，让用户知道"看到了，是内容没取到"。
    //    ⚠️ 单纯"刚发过"（dupCount）不打扰 —— 那是我们主动去重，用户并没期待回复。
    if (failCount > 0 && isGroup) {
      await noticeLinkFail(scope, openid, d);
    }
    return;
  }

  // ② 逐张发卡片
  //   🆕 2026-10-21 用户：「B站卡片就不额外返回视频数据卡片，直接进入提示+返回视频流程」
  //   ⇒ B站小程序卡片（fromCard）不发信息卡片，直接落到 ③ 视频流程（先发"正在解析"提示，再发视频）。
  //     ⚠️ 前提是视频开关开着；关了视频就还得发卡片（否则这条消息什么都不回）。
  const cardVideoOn = cfg.policy.linkParse?.video?.enabled;
  let sentAny = false;
  let lastCardInfo = null;
  for (const p of parsed) {
    if (p.fromCard && p.platform === 'bilibili' && cardVideoOn) {
      console.log('  ├ B站小程序卡片 → 不发数据卡片，直接进视频流程');
      continue;
    }
    console.log(`  ├ 卡片已生成（${p.platform}，${p.card.length} 字）`);
    const sent = isGroup
      ? await sendGroupMarkdown(openid, p.card, d.id)
      : await sendPrivateMarkdown(openid, p.card, d.id);
    if (sent) {
      sentAny = true;
      lastCardInfo = p.info || null;
      // ✅ 只有真发出去了才记 —— 发失败的话下次还该能发
      linkparse.markCarded(scope, p._keys || []);
    } else {
      console.log(`  │  └ ${p.platform} 卡片发送失败（看上面的 err_code）`);
    }
  }
  if (sentAny) {
    // 🆕 2026-10-05：记一笔"本群刚发过这张卡片"，供生成回复时告诉模型
    //    （治"刚发完卡片、45 秒后被问却答『我解析不了』"）
    if (lastCardInfo) linkparse.noteCard(scope, lastCardInfo, 'card');
    // ⚠️ 只计入"本群连发上限"，**不调 markReplied** ——
    //    否则会把对方 60 秒的聊天冷却一起占掉，他接着问问题就不理了。
    brain.markScopeReplied(scope);
    console.log('  └ ✓ 卡片已发送');
  }

  // ③ 视频：**整条消息最多发一个**（配额只剩 1 条，且 videoBusy 本来就串行）
  //    取第一个"能出视频"的平台：B站 / 快手。
  //    🆕 2026-10-09 下半场：用户原话「**短视频直接发出来啊，长视频给链接呗**」
  //       ⇒ 抖音**已接入这条链路**：拿到直链的抖音视频在这里发出去；
  //         但时长上限单独收紧到 `douyinMaxDurationSec`（默认 60 秒），
  //         超长的仍然只在卡片里留一行无水印直链、不下载不转发。
  const vcfg = cfg.policy.linkParse?.video;
  if (!isGroup || !vcfg?.enabled) return;
  const vtarget = parsed.find((p) =>
    p.platform === 'bilibili'
    || p.platform === 'kuaishou'
    // 抖音：**只有真拿到直链才发**（没拿到就别占这条配额，卡片已经出过了）
    || (p.platform === 'douyin' && p.info?.playUrl));
  if (!vtarget) {
    // 🆕 2026-10-08 建 / 2026-10-09 修正：
    //    · 08 日那版写的是「抖音**永远发不出视频**」—— 那是当时的结论；
    //    · 09 日起已经能用无头浏览器拿到**无水印直链**了（见 douyin-direct.js），
    //      直链贴在卡片最后一行。当前**刻意不转发视频文件**（用户 2026-10-09 拍板「先只回文字链」）。
    //
    // 🔴 为什么仍要在这里记一笔：不发视频**日志里什么都没有**，而群友紧接着可能就问
    //    「视频呢？」—— 没有这笔记录，模型只能瞎猜（历史上就答过"我这边看不到视频画面"这种偏话）。
    //    noteVideoSkip 本来就是治这个的（"刚发完卡片、被问却答错"）。
    //    ⚠️ 但记的内容**必须跟事实一致**：明明拿到了直链却记"拿不到"，模型就会照着答错。
    const only = parsed[0];
    if (only && only.platform === 'douyin' && scope) {
      const isNote = only.info?.kind === 'note';
      // ⚠️ 2026-10-12：这里看的是 `shareUrl`（**卡片里真正贴给用户的那一行**），
      //    不是 `playUrl`（那是服务器下载用的 CDN 直链）。两回事，别混。
      const hasDirect = !!only.info?.shareUrl;
      // 走到这里 = vtarget 没选中抖音。只有两种情况：图文（本来没视频）、或没拿到直链。
      if (isNote) {
        linkparse.noteVideoSkip(scope, '这是抖音图文作品，本来就没有视频');
        console.log('  ├ 🎬 抖音图文：本来就没有视频 → 已记一笔');
      } else if (!hasDirect) {
        linkparse.noteVideoSkip(scope, '抖音这次没拿到直链（可能被限流），卡片里只有元信息');
        console.log('  ├ 🎬 抖音没拿到直链（可能限流）→ 已记一笔，被问到时如实回答');
      }
    }
    return;
  }
  if (parsed.length > 1) {
    console.log(`  ├ ⚠️ 这条消息有 ${parsed.length} 个链接，视频只发第一个（${vtarget.platform}）—— 被动回复配额只有 5 条`);
  }
  await sendVideo(d, vtarget.info, openid, scope, { cardSent: sentAny });
}

// 🆕 P2：把 B站视频下载下来 → 分片上传到 QQ → 用 msg_type=7 发出去
//
// 🔴 为什么不能把直链直接丢给 QQ：B站直链有防盗链（必须带 Referer），
//    实测让 QQ 去下会报 `40093007 富媒体文件下载失败`。所以只能我们自己下。
//
// ⏱ 实测耗时（10MB / 360P）：下载 10.2s + 上传 24.8s ≈ 37s。
//    被动回复窗口是 5 分钟，够用。
//
// ⚠️ 一次只处理一个视频 —— 服务器 2核2G / 3M 带宽，并发下载+上传会把机器压垮。
let videoBusy = false;

// B站 qn 值 → 人话（给提示语用）
const QN_NAME = {
  6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
  80: '1080P', 112: '1080P+', 116: '1080P60', 120: '4K',
};

// 把"解析中"的模板渲染成人话（纯函数抽到 videotext.js，**为了能被测试覆盖**）
//
// 🔴 2026-10-10 修的真 bug：模板写 `{size}MB`、代码又给 `{size}` 拼了 `'MB'`
//    ⇒ 线上打出「🎬 正在处理 **7.7MBMB** 的视频」。
//    规范：**单位由模板负责，代码只给裸数字**。
const { renderPendingText } = require('./videotext');

// 🆕 解析期间的提示语
//
// ⚠️ 调用时机很关键：必须**过了大小检查、确定要发**之后才调。
//    否则会出现"提示了却什么都没来" —— 那比不提示更让人困惑。
async function sendVideoPending(d, groupopenid, info, src, v) {
  // 快手不给 size / quality，所以这两项都做成"有才显示"
  const sizeMB = src.size ? (src.size / 1048576).toFixed(1) : '';
  const quality = QN_NAME[src.quality] || src.qualityLabel || '原画';
  const pool = Array.isArray(v.pendingTexts) && v.pendingTexts.length ? v.pendingTexts : [v.pendingTemplate];
  const tpl = pool[Math.floor(Math.random() * pool.length)] || '🎬 正在解析视频…';
  const text = renderPendingText(tpl, { sizeMB, quality, title: info.title });

  const ok = await sendGroupMessage(groupopenid, text, d.id);
  console.log(`  ├ 🎬 已发解析提示${ok ? '' : '（⚠️ 发送失败）'}：${text}`);
}

// 🆕 2026-10-11：视频"太长 / 太大"没下载时，**在群里回一句**。
//
// 用户原话：「视频过长不下载加个反馈提示呗，不然别人还以为是没获取到」
//   —— 原来这种跳过只写进 `noteVideoSkip`（内部记录，给模型答话用），群里完全静默，
//      群友只看到"卡片 + 没有视频"，自然当成解析失败。
//
// ⚠️ 不节流：每条长视频都该有反馈，这正是用户要的"别让我以为坏了"。
async function noticeVideoSkip(d, groupOpenid, v, key, vars, info, opts) {
  const pool = (Array.isArray(v?.[key]) && v[key].length) ? v[key] : [];
  if (!pool.length) return;
  // 卡片里到底有没有无水印直链，决定 {tip} 填哪句
  // 🆕 2026-10-21：B站**小程序卡片**现在不发数据卡片了（直接进视频流程）⇒ 不能再让用户"点卡片里的链接"。
  //    cardSent === false 时改用视频自己的链接（B站给了 shareUrl/htmlUrl；都没有就不带这句）。
  let tip;
  if (opts && opts.cardSent === false) {
    tip = info.shareUrl ? `（直接看：${info.shareUrl}）`
      : (info.htmlUrl ? `（原视频：${info.htmlUrl}）` : '');
  } else {
    tip = info?.playUrl ? (v.skipTipWithDirect || '') : (v.skipTipNoDirect || '');
  }
  let text = String(pool[Math.floor(Math.random() * pool.length)]);
  for (const [k, val] of Object.entries({ ...vars, tip })) {
    text = text.split(`{${k}}`).join(String(val == null ? '' : val));
  }
  const ok = await sendGroupMessage(groupOpenid, text, d.id);
  console.log(`  ├ 🎬 已回一句"没下载"的说明${ok ? '' : '（⚠️ 发送失败）'}：${text}`);
}

async function sendVideo(d, info, groupOpenid, scope, opts) {
  const v = cfg.policy.linkParse.video;
  const tag = info.platform === 'kuaishou' ? '  ├ 🎬[快手]'
    : info.platform === 'douyin' ? '  ├ 🎬[抖音]' : '  ├ 🎬';

  if (videoBusy) { console.log(`${tag} 已有视频在处理，跳过这一个`); return; }

  // 时长太长的先挡掉（下载+上传太久，而且大概率超 30MB）
  // 🆕 抖音单独一档：用户要的是「短视频直接发、长视频给链接」，**60 秒**是抖音语境的分界线
  const maxDur = info.platform === 'douyin'
    ? (v.douyinMaxDurationSec || 60)
    : v.maxDurationSec;
  if (info.durationSec && info.durationSec > maxDur) {
    console.log(`${tag} 跳过（时长 ${info.durationSec}s > 上限 ${maxDur}s）`);
    // 说人话的时长 / 上限（抖音按秒，B站快手按分钟）
    const durText = info.platform === 'douyin'
      ? `${Math.round(info.durationSec)} 秒`
      : `${Math.round(info.durationSec / 60)} 分钟`;
    const limText = info.platform === 'douyin'
      ? `${maxDur} 秒`
      : `${Math.round(maxDur / 60)} 分钟`;
    // 🆕 记下"为什么没发视频"，生成回复时才答得对
    if (scope) {
      linkparse.noteVideoSkip(scope, info.platform === 'douyin'
        ? `时长 ${durText}，超过抖音短视频上限 ${limText}，只在卡片里给了直链`
        : `时长 ${durText}，超过上限 ${limText}，搬不动`);
    }
    // 🆕 2026-10-11：**在群里也说一声**，否则群友以为解析没成功（用户提的需求）
    await noticeVideoSkip(d, groupOpenid, v, 'skipTooLongTexts',
      { dur: durText, limit: limText }, info, opts);
    return;
  }

  videoBusy = true;
  const t0 = Date.now();
  try {
    // ① 拿直链（三个平台三套取法）
    const maxBytes = v.maxMB * 1024 * 1024;
    const src = info.platform === 'douyin'
      // 抖音：直链**解析阶段就已经拿到了**（douyin-direct.js 的无头浏览器），这里直接用即可。
      // ⚠️ 必须带 Referer —— douyinvod 有防盗链，不带会 403（同 B站 的道理）
      ? { url: info.playUrl, size: info.playSize || 0, headers: { Referer: 'https://www.douyin.com/' } }
      : info.platform === 'kuaishou'
        ? await linkparse.getKuaishouVideoUrl(info, maxBytes)
        : await linkparse.getBilibiliVideoUrl(info, maxBytes);
    if (!src) {
      console.log(`${tag} 拿不到直链（番剧 / 付费 / 已删除 都可能）`);
      if (scope) linkparse.noteVideoSkip(scope, '拿不到视频直链（可能是番剧/付费/已删除）');
      return;
    }

    const mb = src.size ? (src.size / 1048576).toFixed(1) + 'MB' : '大小未知';
    console.log(`${tag} 直链 OK：${mb}${src.quality ? ' · qn=' + src.quality : ''}${src.downgraded ? '（已自动降清晰度）' : ''}`);

    if (src.size && src.size > maxBytes) {
      console.log(`${tag} 跳过（${mb} > 上限 ${v.maxMB}MB —— 超了 QQ 会把它降级成"文件"，不是可播放视频）`);
      if (scope) linkparse.noteVideoSkip(scope, `视频文件 ${mb}，超过上限 ${v.maxMB}MB，发不了`);
      // 🆕 2026-10-11：同样在群里说一声（用户提的需求）
      await noticeVideoSkip(d, groupOpenid, v, 'skipTooBigTexts',
        { mb: String(mb).replace('MB', ''), limit: v.maxMB }, info, opts);
      return;
    }

    // ①.5 🆕 到这里**基本确定能发**了 → 先给一句提示，免得后面 30 秒像卡死
    //      （注意：这一步会占掉被动回复配额里的 1 次，加上卡片和视频共 3 次 / 上限 5 次）
    await sendVideoPending(d, groupOpenid, info, src, v);

    // ② 下载（⚠️ 必须带 Referer，否则 B站 403）
    const buf = await qqmedia.downloadToBuffer(src.url, {
      headers: src.headers,
      maxBytes,
      timeoutMs: 90000,
    });
    console.log(`${tag} 下载完成 ${(buf.length / 1048576).toFixed(2)}MB · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // ③ 分片上传 → file_info（文件名用视频 id：B站是 BV 号，快手是 photoId）
    const fileInfo = await qqmedia.uploadMedia(
      'groups', groupOpenid, buf, `${info.bvid || info.id || 'video'}.mp4`, 2,
      (m) => console.log(`${tag} ${m}`),
    );

    // ④ 发送（被动回复 —— 走"被动回复配额"，不占主动消息额度）
    //    ⚠️ file_info 有 ttl，所以是"上传完立刻发"，中间不能拖
    const ok = await sendGroupMedia(groupOpenid, fileInfo, d.id);
    console.log(ok
      ? `${tag} ✓ 视频已发送（全程 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
      : `${tag} ✗ 视频发送失败（看上面的 err_code）`);
    // 🆕 成功发了视频也记一笔（这样被问到时不会说"我解析不了"）
    if (scope) {
      if (ok) linkparse.noteCard(scope, info, 'video');
      else linkparse.noteVideoSkip(scope, '视频发送失败了（QQ 那边报错）');
    }
  } catch (e) {
    console.warn(`${tag} 失败: ${e.message || e}`);
  } finally {
    videoBusy = false;
  }
}

// 简单 sleep（分段发送之间的间隔用）
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 启动 ----------
console.log('[小蓝鲸] 启动中…');
console.log('[小蓝鲸] 模型:', cfg.ai.replyModel, '@', cfg.ai.baseUrl);
// 🆕 2026-10-08 修：横幅原来打的是 `cfg.policy.dailyCallLimit`（config.js 里的**代码默认** 1600），
//    面板把上限改成 3000 之后运行时判定是对的（走 settings.num），**横幅却还在打 1600** ⇒ 会误导排查。
//    ⇒ 一律打**面板生效值**，并标出这值是"面板设的"还是"代码默认"。
const effDailyCalls = (() => {
  try { return Number(require('./settings').num('dailyCalls', cfg.policy.dailyCallLimit)) || cfg.policy.dailyCallLimit; }
  catch { return cfg.policy.dailyCallLimit; }
})();
console.log('[小蓝鲸] 判断模型:', cfg.ai.judgeModel, '| 日额度:',
  effDailyCalls, effDailyCalls === cfg.policy.dailyCallLimit ? '（代码默认）' : '（面板设定）');

// 🆕 2026-10-07 用量趋势（用户要的"用量趋势曲线"）：两条腿
//   ① **回填**：启动 25 秒后从 journal 抓最近 14 天，倒推出每日用量 ⇒ 曲线一上线就有内容
//   ② **累积**：每 10 分钟把"今天"的快照写进 data/usage.json ⇒ 从这里往后数据是准的
//   🔴 全部包 try + 定时器 unref：这个功能**绝不能影响回话**（它是纯观测）
{
  const usage = require('./usage');
  const t1 = setTimeout(() => {
    // ⚠️ backfill 现在返回 **Promise**（内部从 execSync 改成了异步 exec + journalctl -g），
    //    原因见 usage.js 那段注释：同步读 journal 会把整个机器人卡住十几秒。
    Promise.resolve()
      .then(() => usage.backfill({
        service: 'xiaolanjing',
        days: 14,
        // 🔴 2026-10-18 修：这里原来传 `cfg.budget.dailyLimitYuan`（.env 的 12），
        //    而日志里的「今日剩¥」是按**面板生效值**（settings 里的 3）算的 ⇒
        //    回填出来的每日花费虚高好几倍（面板"这 14 天 ¥150"，账本才 ¥39）。
        //    ⇒ 必须传"当前生效"的日额度（和 budget.js 用同一个来源）。
        dailyLimitYuan: Number(require('./settings').num('budgetDaily', cfg.budget.dailyLimitYuan)) || cfg.budget.dailyLimitYuan,
      }))
      .then((r) => console.log('[usage] 回填：' + (r.filled || 0) + ' 天（共 ' + (r.days || 0) + ' 天在库里）' + (r.why ? ' · ' + r.why : '')))
      .catch((e) => console.warn('[usage] 回填失败（不影响运行）：' + e.message))
      .then(() => {
        try { const b = budget.status(); usage.record({ dayCalls: b.dayCalls, daySpent: b.daySpent }); } catch (e) { /* 忽略 */ }
      });
  }, 25000);
  if (t1 && t1.unref) t1.unref();
  const t2 = setInterval(() => {
    try { const b = budget.status(); usage.record({ dayCalls: b.dayCalls, daySpent: b.daySpent }); } catch (e) { /* 忽略 */ }
  }, 10 * 60 * 1000);
  if (t2 && t2.unref) t2.unref();
}

// 🆕 开机/关机状态**一定要在启动时就打出来** ——
//    否则"它怎么不理人"会被当成故障排查半天，其实就是关着机。
{
  const ps = power.status();
  if (ps.on) console.log('[小蓝鲸] ⏻ 开关状态: 开机');
  else {
    console.warn(`[小蓝鲸] ⏻ 开关状态: 【关机】—— 不会回话、不解析链接、不识别图片`);
    console.warn(`[小蓝鲸]    （${ps.by ? `由 ${ps.by} ` : ''}于 ${ps.sinceText}设置）`);
    console.warn('[小蓝鲸]    恢复方式：在群里 @我说「开机」，或删掉 data/power.json 后重启');
  }
  if (!cfg.ownerOpenid) {
    console.warn('[小蓝鲸] ⚠️ 没有配置主人（OWNER_OPENID）—— 开关机命令将无人可用！');
  }
}

{
  const missing = [];
  if (!cfg.appId) missing.push('QQ_BOT_APPID');
  if (!cfg.secret) missing.push('QQ_BOT_SECRET');
  if (!cfg.ai.apiKey) missing.push('AI_API_KEY');
  if (missing.length) {
    console.error('[小蓝鲸] ❌ 缺少必填环境变量：' + missing.join(', '));
    console.error('  1) 在项目根目录运行： node scripts/check-env.cjs');
    console.error('  2) 按提示填 .env（模板见 .env.example），再重新启动');
    console.error('  3) 还不知道怎么拿？看 AGENT.md 第 1 节');
    process.exit(1);
  }
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
