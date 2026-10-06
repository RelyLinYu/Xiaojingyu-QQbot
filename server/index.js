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
const memory = require('./memory');     // 🆕 记忆（全群共享便签本，见 config.policy.memory）

// 🆕 记忆注入的节流表：scope -> 上次注入时间
//    （防"每条消息都塞记忆"，见 config.policy.memory.recallMinIntervalMs）
const lastRecallAt = new Map();
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
    const changed = power.setOn(powerCmd === 'on', d.author?.member_openid || d.author?.user_openid);
    const text = power.replyFor(powerCmd, changed, who);
    console.log(`  ├ ⏻ 主人 ${who} 发送了「${powerCmd === 'on' ? '开机' : '关机'}」`
      + `${changed ? '' : '（状态没变）'} → 现在【${power.isOn() ? '开机' : '关机'}】`);
    const sent = isGroup
      ? await sendGroupMessage(openid, text, d.id)
      : await sendPrivateMessage(openid, text, d.id);
    console.log(`  └ ${sent ? '✓ 已回复' : '✗ 回复失败'}: ${text}`);
    return;   // 🛑 处理完就结束，不走下面任何流程
  }

  // 🛑 已关机：只留一行日志，什么都不做（不识别、不解析、不回话、不花钱）
  //
  // ⚠️ 连"上下文"都不记 —— 关机期间发生的事，开机后不该被它拿去接话
  //    （否则会出现"它刚醒就评论几小时前的话题"这种怪事）。
  // ⚠️ 事件仍然会落盘（handleEvent 第 1 步）—— 那是排查用的，不花钱，也方便看
  //    "关机这段时间群里发生了什么"。
  if (!power.isOn()) {
    console.log('  └ ⏻ 已关机，忽略（@我说「开机」可恢复）');
    return;
  }

  // 4.4 🆕 识图（2026-09-22）：把图片/表情包变成一句可读的话
  //
  // 🔑 为什么必须放在"提取文本"**之前**：识图结果要当成"这条消息的文字"，
  //    挂在消息对象的 `__vision` 上，`brain.extractText()` 会把它拼进去。
  //    这样 L0/L1/L2、上下文记忆、助手模式……**全都自动看得见图片**，
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
    const vg = vision.visionAllowed(scope);
    if (!vg.ok) {
      console.log(`  ├ 🖼 有图片，但跳过识别（${vg.why}）`);
    } else {
      const vt = Date.now();
      try {
        const r = await vision.describe(img, (m) => console.log(`  ├ 🖼 ${m}`));
        const desc = r && r.desc;
        if (desc) {
          // ⚠️ 缓存命中（同一张图之前认过）**不占今日张数** —— 它一分钱没花。
          //    但冷却照走（否则一个表情包刷屏会被瞬间处理一遍）。
          vision.markVision(scope, !(r && r.cached));
          d.__vision = desc;      // ← extractText 会把它拼进文本
          // 🔑 把"这条消息的编号 → 描述"记下来：
          //    之后有人**引用这张图**时，QQ 不会再把图片给我们，
          //    只会给一个 ref_msg_idx —— 靠这个缓存才能查回来。
          vision.rememberImage(scope, vision.msgIdxOf(d), desc);
          console.log(`  ├ 🖼 ${r && r.cached ? '命中缓存' : '识别成功'}`
            + `（${((Date.now() - vt) / 1000).toFixed(1)}s）：${desc}`);
        } else {
          // 只有"识别出来是空"才走这里（真失败会抛异常）
          console.log('  ├ 🖼 模型返回空描述，当没图处理');
        }
      } catch (e) {
        // ⚠️ 识图失败**不能影响正常聊天** —— 图看不懂就照原样继续（文字还在）
        console.warn(`  ├ 🖼 识别失败: ${e.message || e}`);
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
    const quoted = refIdx ? vision.getImageDesc(scope, refIdx) : '';
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

  const text = brain.extractText(d);

  console.log(`[${isGroup ? '群' : '私聊'}] ${type} | ${who}: ${text || '(无文本内容)'}`);
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
  const links = d.author?.bot ? [] : linkparse.findLinks(d, cfg.policy.linkParse?.maxLinksPerMessage || 2);
  if (links.length) {
    // ⚠️⚠️ 「被点名」必须和正常流程一样**绕过连发上限**（2026-09-22 实测踩到）：
    //     passHardRules 里是 `bypass = at || owner` —— @ 它、或主人说话，都不受
    //     maxConsecutive（3 分钟 2 次）约束。这条支路跑在它**前面**，得自己实现同样豁免。
    //     不这么做的后果实测过：连发三条 @（你好 / 数字 / 链接），
    //     前两条各回一次，第三条带链接时被判"连发已达上限"→ 跳过 → 退回普通闲聊，
    //     卡片死活出不来。而普通流程因为 @ 豁免了，所以看起来"它明明收到了却不解析"。
    const named = brain.isOwner(d) || brain.isAtRobot(type, d);
    const gate = linkparse.linkAllowed(scope);
    if (!gate.ok) {
      console.log(`  ├ 🔗 看到 ${links.length} 条链接（${links[0].platform} 等），但先跳过（${gate.why}）`);
    } else if (!named && !brain.consecutiveOk(scope)) {
      console.log('  ├ 🔗 看到链接，但先跳过（本群连发已达上限，且没被点名）');
    } else {
      linkparse.markLink(scope);
      await handleLink(d, links, scope, isGroup, openid);
      return;
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

  // 5.4 🆕 记忆指令（记 / 忘 / 看）—— **零模型调用**，自己拼一句话回
  //
  //   作用域是**全群共享**（用户拍板 C），所以：
  //     · 谁都能记、谁都能看（这是"群共享"的题中之义）
  //     · **只有主人能删**（防止有人把别人记的东西删掉）
  //     · 🔴 **敏感内容一律拒收**（见 memory.js 的护栏）——
  //       全群共享 + 存私密 = 把私密内容挂在群里
  //   ⚠️ 放在情绪观察器之前：它的回复是我们自己发的话，不该被当成"群友的情绪"。
  if (cfg.policy.memory?.enabled) {
    try {
      const cmd = memory.parseCommand(brain.extractText(d));
      if (cmd) {
        let text = '';
        if (cmd.action === 'add') {
          const r = memory.add(cmd.content, d.author?.member_openid || d.author?.id || '');
          if (r.ok) {
            text = r.dup ? `这个我记过了：${cmd.content}` : `行，记下了：${cmd.content}`;
            console.log(`  ├ [mem] 记下（${r.dup ? '重复' : '新增'}）：${cmd.content}`);
          } else if (r.why === 'privacy') {
            text = '这个我不记 —— 涉及隐私，记在群里不合适。';
            console.log(`  ├ [mem] 拒收（${r.category}）：不落盘、不复述`);
          } else {
            text = '这个我记不了（太长或者空的）。';
          }
        } else if (cmd.action === 'del') {
          if (!l0.isOwner) {
            text = '删记忆得我主人来 —— 你记的可以留着，别删别人的。';
            console.log('  ├ [mem] 非主人想删记忆 → 拒绝');
          } else {
            const r = memory.remove(cmd.content);
            text = r.removed ? `好，把和「${cmd.content}」有关的 ${r.removed} 条清掉了。` : `没找到和「${cmd.content}」有关的。`;
            console.log(`  ├ [mem] 删除 ${r.removed} 条`);
          }
        } else if (cmd.action === 'list') {
          const l = memory.list(10);
          text = l.total === 0
            ? '我还没记住什么。你跟我说「记住 XXX」，我就记下来。'
            : `我记着这些（共 ${l.total} 条）：\n` + l.shown.map((x, i) => `${i + 1}. ${x}`).join('\n')
              + (l.total > l.shown.length ? `\n…还有 ${l.total - l.shown.length} 条` : '');
          console.log(`  ├ [mem] 列出记忆（共 ${l.total} 条）`);
        }
        if (text) {
          const sent = isGroup
            ? await sendGroupMessage(openid, text, d.id)
            : await sendPrivateMessage(openid, text, d.id);
          if (sent) brain.markReplied(scope, d.author?.user_openid || d.author?.member_openid);
          return;
        }
      }
    } catch (e) {
      console.warn(`  └ [mem] 指令处理出错（不影响回话）：${e.message}`);
    }
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
  //    🆕 带上"本群刚刚处理过什么链接"—— 治"刚发完卡片、被问到时却说解析不了"
  //    🆕 带上"群里记得的相关事实"—— 全群共享的记忆，命中时才注入
  //
  //    ⚠️ 注入频率上限：同一个群至少隔 `recallMinIntervalMs`（默认 5 分钟）才注入一次，
  //       否则"每条消息都塞记忆"会把成本和噪音都抬上去。
  //    ⚠️ 注入内容**只拼进这一轮的 user 文本**，绝不 push 进 contexts ——
  //       否则它会变成下一轮的输入，形成自我强化污染。
  const memItems = (() => {
    if (!cfg.policy.memory?.enabled) return [];
    const last = lastRecallAt.get(scope) || 0;
    if (Date.now() - last < (Number(cfg.policy.memory.recallMinIntervalMs) || 300000)) return [];
    const hit = memory.recall(brain.extractText(d));
    if (!hit.length) return [];
    lastRecallAt.set(scope, Date.now());
    memory.markHit(hit.map((x) => x.id));      // 用进废退：记下"这条被用上了"
    return hit;
  })();
  const linkNote = linkparse.contextNote(scope);
  const memNote = memItems.length ? memory.render(memItems) : '';
  const extraNote = [linkNote, memNote].filter(Boolean).join('\n');
  if (memItems.length) console.log(`  ├ [mem] 注入 ${memItems.length} 条记忆（${memNote.length} 字）`);
  const gen = await brain.generateReply(scope, d, extraNote);

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
  let segments = (gen.segments && gen.segments.length) ? gen.segments : [reply];
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
    return ok;
  });

  // 9. 只有发出去才算回复过（部分成功也算，否则会重复触发同一条）
  if (okCount > 0) {
    brain.markReplied(scope, d.author.user_openid || d.author.member_openid);
    brain.pushContext(scope, cfg.persona.name, reply);
  } else {
    console.log('  └ 发送失败，不计入冷却（下条消息仍可尝试）');
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
async function handleLink(d, links, scope, isGroup, openid) {
  // ① 先把所有链接都解析出来（解析失败的不占位置）
  const parsed = [];
  const seenId = new Set();
  for (const link of links) {
    console.log(`  ├ 🔗 ${link.platform} 链接: ${String(link.url).slice(0, 90)}`);
    try {
      // ⚠️ 第二个参数（消息原文）只有抖音图文用得到：它平台不给数据，
      //    要靠分享文案里的「【作者.的图文作品】正文」兜底（见 linkparse.fetchDouyin）
      const p = await linkparse.parse(link, String(d.content || ''));
      if (!p || !p.card) { console.log('  │  └ 这条解析不出内容，跳过'); continue; }

      // 🔴 解析之后**再**去一次重 —— 按"解析出来的身份"，不是按 URL。
      //    实测：一条合并转发里有 3 个 issue 链接（141/140/136），全指向同一个仓库，
      //    按 URL 去重一个都不少 → 发了 2 张一模一样的卡片。
      //    （findLinks 里已经按 URL 抠出的 id 去过一次，这里兜住"短链才解析出真 id"的情况）
      const ikey = linkparse.infoKey(p.info);
      if (ikey && seenId.has(ikey)) {
        console.log(`  │  └ 和前面那条指向同一个内容（${ikey}），跳过`);
        continue;
      }

      // 🔴 "刚发过"就跳过 —— 这是治「群友引用机器人卡片 → 卡片又发一次」的主防线。
      //    引用时 QQ 会把我们卡片的 markdown 原样喂回来，链接一模一样，
      //    按 key 一查就知道"这是我们自己刚发的"。
      const ago = linkparse.wasCarded(scope, [link.key, ikey]);
      if (ago) {
        console.log(`  │  └ 本群 ${ago} 秒前刚发过这条（${ikey || link.key}），跳过（防自我二次解析）`);
        continue;
      }

      if (ikey) seenId.add(ikey);
      p._keys = [link.key, ikey];
      parsed.push(p);
    } catch (e) {
      console.warn(`  │  └ 链接解析异常: ${e.message || e}`);
    }
  }
  if (!parsed.length) {
    // ⚠️ 各平台的失败原因不一样，写全，免得以后翻日志时误判
    console.log('  └ 不回（链接解析不出内容 / 刚发过 —— 私有仓库 / 已删除 / 番剧付费 / 抖音爬虫 UA 失效 / 快手页面改版）');
    return;
  }

  // ② 逐张发卡片
  let sentAny = false;
  let lastCardInfo = null;
  for (const p of parsed) {
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
  //    ⚠️ 抖音**没有直链**（见 linkparse.js 里 fetchDouyin 的注释），只会被跳过。
  const vcfg = cfg.policy.linkParse?.video;
  if (!isGroup || !vcfg?.enabled) return;
  const vtarget = parsed.find((p) => p.platform === 'bilibili' || p.platform === 'kuaishou');
  if (!vtarget) return;
  if (parsed.length > 1) {
    console.log(`  ├ ⚠️ 这条消息有 ${parsed.length} 个链接，视频只发第一个（${vtarget.platform}）—— 被动回复配额只有 5 条`);
  }
  await sendVideo(d, vtarget.info, openid, scope);
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

// 🆕 解析期间的提示语
//
// ⚠️ 调用时机很关键：必须**过了大小检查、确定要发**之后才调。
//    否则会出现"提示了却什么都没来" —— 那比不提示更让人困惑。
async function sendVideoPending(d, groupopenid, info, src, v) {
  // 快手不给 size / quality，所以这两项都做成"有才显示"
  const size = src.size ? (src.size / 1048576).toFixed(1) + 'MB' : '';
  const quality = QN_NAME[src.quality] || src.qualityLabel || '原画';
  const pool = Array.isArray(v.pendingTexts) && v.pendingTexts.length ? v.pendingTexts : [v.pendingTemplate];
  let text = pool[Math.floor(Math.random() * pool.length)] || '🎬 正在解析视频…';
  text = String(text)
    .replace(/\{size\}/g, size)
    .replace(/\{quality\}/g, quality)
    .replace(/\{title\}/g, String(info.title || '').slice(0, 30));

  const ok = await sendGroupMessage(groupopenid, text, d.id);
  console.log(`  ├ 🎬 已发解析提示${ok ? '' : '（⚠️ 发送失败）'}：${text}`);
}

async function sendVideo(d, info, groupOpenid, scope) {
  const v = cfg.policy.linkParse.video;
  const tag = info.platform === 'kuaishou' ? '  ├ 🎬[快手]' : '  ├ 🎬';

  if (videoBusy) { console.log(`${tag} 已有视频在处理，跳过这一个`); return; }

  // 时长太长的先挡掉（下载+上传太久，而且大概率超 30MB）
  if (info.durationSec && info.durationSec > v.maxDurationSec) {
    console.log(`${tag} 跳过（时长 ${info.durationSec}s > 上限 ${v.maxDurationSec}s）`);
    // 🆕 记下"为什么没发视频"，生成回复时才答得对
    if (scope) {
      linkparse.noteVideoSkip(scope,
        `时长 ${Math.round(info.durationSec / 60)} 分钟，超过上限 ${Math.round(v.maxDurationSec / 60)} 分钟，搬不动`);
    }
    return;
  }

  videoBusy = true;
  const t0 = Date.now();
  try {
    // ① 拿直链（快手和 B站 是两套完全不同的取法）
    const maxBytes = v.maxMB * 1024 * 1024;
    const src = info.platform === 'kuaishou'
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
console.log('[小蓝鲸] 判断模型:', cfg.ai.judgeModel, '| 日额度:', cfg.policy.dailyCallLimit);

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
