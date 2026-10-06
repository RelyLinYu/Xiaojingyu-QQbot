// ============================================================
//  convo.js —— 把原始日志行**翻译成"人看得懂的对话卡片"**(2026-10-05 新增)
//
//  🎯 用户原话：
//    「日志显示不清晰……有很多纯英文乱码，那个对我来说没有用，毕竟我看不懂，
//      并且消息统一接收，也没有群或者私聊的区分。我建议是日志显示**提问者+决策+回答**，
//      并且不同的群，私聊对话之间的消息放在**不同卡片**，卡片首行读取**群名字和群号**，
//      如果读取不到，就默认占位符，让我可以手动修改」
//
//  ⇒ 这个模块只做一件事：**把 journal 的行流解析成一条条结构化的对话记录**：
//       { scope, kind, who, text, at(时间), decision, reply[] }
//    并把**英文/技术噪音**过滤掉（`message_type=0 mentions=[]`、`[ai] deepseek-flash in=…`
//    这类"我们内部看的"东西，用户看不懂，不该占版面）。
//
//  ⚠️ 纯函数：不读文件、不联网、不依赖时间。自测直接喂字符串。
//  ⚠️ 这是**只读展示层**：不改变任何业务行为、不落盘、不影响机器人。
// ============================================================

// journal 的 `-o short-iso` 格式：
//   2026-10-05T18:07:35+08:00 host node[123]: [群] GROUP_MESSAGE_CREATE | 名字: 内容
// 前面两段是固定噪音，我们只关心时间 + 冒号后面的正文。
const LINE_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})[^\s]*\s+\S+\s+\S+:\s?(.*)$/;

// ANSI 颜色码（journalctl 有时会带）—— 不清掉会在页面上显示成乱码
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function clean(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '').replace(/\s+$/, '');
}

// 🔴 真实日志里决策行**前面有缩进**（`"  └ 不回（…）"`），所以判据一律基于 trim 后的文本。
//    踩过：一开始要求"行首就是树形符号" ⇒ 所有决策行都被跳过，卡片里一个决策都没有。
function trimmed(s) {
  return clean(s).replace(/^\s+/, '');
}

// 解析一行 → { time, body } 或 null（不是日志正文行）
function parseLine(raw) {
  const line = clean(raw);
  if (!line) return null;
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return { time: m[2], body: m[3] };
}

// 这些行是"给人看的决策/结果"，要留下
const DECISION_PREFIX = /^[├└│]\s*/;

// 一条"不回"的判定行：
//   `不回（未命中关键词且未抽样中（省钱））`
//   `不回（L1 2: …）`（L1 前缀已被 humanizeDecision 去掉）
// ⚠️ 必须**锚定**（^不回 + 紧跟括号/结尾/词界）—— 之前用 /^不回|不回（/ 太松，
//    会把任何含"不回"的行都当成决策（自测当场抓到）。
const NO_REPLY_RE = /^不回(?=[（(]|$|\s)/;
// 用户明确说"看不懂、没用"的英文技术噪音 —— 直接丢掉：
const NOISE_RES = [
  /^message_type=\d+\s+mentions=/,     // ├ message_type=0 mentions=[]
  /^\[ai\]\s/,                          // ├ [ai] deepseek-flash in=… out=…
  /^\[budget\]/,                        // 预算内部账
  /^\[小蓝鲸\]/,                        // 启动横幅
  /^\[emo\]/,                           // 情绪观察器（我们调试用的）
  /^\[mem\]/,                           // 记忆模块内部日志
  /^\[power\]/, /^\[gateway\]/, /^\[qqapi\]/,
];
function isNoise(body) {
  const s = trimmed(body).replace(DECISION_PREFIX, '').trim();
  return NOISE_RES.some((re) => re.test(s));
}

// 把 decision 行里那些"技术尾巴"去掉，只留人话
//   例：`不回（未命中关键词且未抽样中（省钱））` → 保留（这句人能懂）
//       `不回（L1 1: …）` → 去掉 "L1 N: " 前缀
function humanizeDecision(body) {
  let s = trimmed(body).replace(DECISION_PREFIX, '').trim();
  s = s.replace(/^L1\s*\d+:\s*/, '');       // L1 3: xxx → xxx
  s = s.replace(/^L0\s*\d+:\s*/, '');
  s = s.replace(/^（?L1[^）]*）/,'');        // 兜底
  return s.trim();
}

// ---------- 主入口 ----------
// 输入：journal 文本（多行）
// 输出：{ convos: [...], raw: [...] }
//   convo = {
//     scope,            // 内部作用域串（group:xxx / private:xxx）
//     kind,             // 'group' | 'private' | 'unknown'
//     scopeId,          // 群号 / 用户号（从日志里尽量抠，抠不到就空）
//     who,              // 提问者昵称
//     text,             // 他说的话
//     time,             // 收到时间 HH:MM:SS
//     decision,         // 机器人的决策（人话版）
//     replies: [],      // 它实际发出去的话
//     wantReply,        // 决策是不是"要回"
//   }
function parseConversations(journalText, opts = {}) {
  // ⚠️ 两个上限，别混：
  //   `max`      = **总共**最多解析几条（保底，防日志太长）
  //   `perScope` = **每个会话**最多留几条（2026-10-06 新增）
  //     🔴 为什么需要它：原来只有 `max`（40）⇒ 一个活跃群会把额度吃光，
  //        其它群只剩几条，而且活跃群自己也只见 40 条。
  const max = Number(opts.max) || 30;
  const perScope = Number(opts.perScope) || 0;   // 0 = 不按会话限制
  const lines = String(journalText || '').split('\n');
  const convos = [];

  let cur = null;          // 当前正在攒的那条
  let pendingSend = null;  // 刚看到的"发送"行，等它跑到下一条消息前再归到 cur

  const push = () => {
    if (!cur) return;
    // 只保留"有内容"的：要么有决策、要么有回复，要么是普通群消息
    convos.push(cur);
    cur = null;
  };

  for (const raw of lines) {
    const p = parseLine(raw);
    if (!p) continue;
    const body = p.body;

    // ① 一条新的入站消息
    const inMsg = /^\[(群|私聊|频道)\]\s*(\S+)\s*\|\s*([^:]*):\s?(.*)$/.exec(body);
    if (inMsg) {
      push();
      const kindMap = { 群: 'group', 私聊: 'private', 频道: 'channel' };
      cur = {
        kind: kindMap[inMsg[1]] || 'unknown',
        scopeId: '',
        who: (inMsg[3] || '').trim() || '（未知）',
        text: (inMsg[4] || '').trim(),
        time: p.time,
        decision: '',
        replies: [],
        wantReply: false,
      };
      pendingSend = null;
      continue;
    }

    // ② 决策行（⚠️ 用 trimmed —— 日志里树形符号前面有缩进）
    if (cur && /^[├└│]/.test(trimmed(body))) {
      if (isNoise(body)) continue;                 // 英文噪音，直接丢
      const d = humanizeDecision(body);
      if (!d) continue;
      if (NO_REPLY_RE.test(d)) {
        cur.decision = d.trim();
        cur.wantReply = false;
      } else if (/^✓|卡片已发送|分段发送|已发送|带引用回复|纯寒暄/.test(d)) {
        cur.decision = d;
        cur.wantReply = true;
      } else if (!cur.decision) {
        cur.decision = d;
      }
      continue;
    }

    // ③ 实际发出去的话（可能一条消息分几段发）
    const send = /^\[send:(\S+)\]\s*✓\s?(.*)$/.exec(body);
    if (send) {
      const text = send[2].trim();
      if (text && text !== '') {
        if (cur) { cur.replies.push(text); cur.wantReply = true; }
        else pendingSend = text;
      }
      continue;
    }

    // ④ 自己发出去的卡片（markdown）—— 只留标题，正文太长
    const md = /^\[send:(\S+)-md\]\s*✓\s?#?\s*(.*)$/.exec(body);
    if (md) {
      const title = (md[2] || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim().slice(0, 60);
      if (cur) { cur.replies.push(`【卡片】${title}`); cur.wantReply = true; }
      continue;
    }
  }
  push();

  // ① 先按会话各留最近 perScope 条（这样"活跃群"不会把额度吃光）
  //    ⚠️ 会话标识此刻还没有（那是 logweb 里反查群号才知道的），所以这里按
  //       **同行分组**：`kind + 昵称连续段` 是 convo 层能拿到的最细粒度。
  //       真正的"每群"，由调用方（logweb.buildConvos）在反查出群号后再做一次。
  let list = convos;
  if (perScope > 0) {
    const buckets = new Map();
    const order = [];
    for (const c of convos) {
      const key = `${c.kind}|${c.who}`;
      if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
      buckets.get(key).push(c);
    }
    list = [];
    for (const key of order) list.push(...buckets.get(key).slice(-perScope));
  }

  // ② 总量保底 + 时间倒序（**最新在上**）
  return list.slice(-max).reverse();
}

module.exports = {
  parseConversations,
  // 给自测用
  _parseLine: parseLine,
  _isNoise: isNoise,
  _humanizeDecision: humanizeDecision,
};
