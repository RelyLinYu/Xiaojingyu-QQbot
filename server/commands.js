// ============================================================
//  👥 群内指令系统（2026-10-10 用户需求）
//
//  需求原文：「现在我要制作指令体系，无需@，当用户在群里输入 "/菜单" 时，
//            会返回菜单面板，罗列功能」
//           「task1:制作加好友功能，当用户输入"加Q+具体qq号"时触发…」
//           「4.命令触发方式严格规定"/加Q(空格)qq号"，防止误触发」
//           「3.菜单介绍太多了，不需要，只要有标题和列出功能就行了」
//           「6.返回卡片做的不好看，优化一下」
//
//  ── 为什么单独一个模块、而不是塞进 brain.js ──
//  · 这几条都是**确定性指令**（正则命中就执行），和"要不要接话"那套概率判断无关。
//  · 必须跑在 **power 开关机之前**（关机了也要能调出菜单）。
//  · 全程 **0 次模型调用**（能不用模型解决的就不用模型 —— 项目铁律）。
//
//  ── 🔴 两条平台事实（决定了这块能做成什么样）──
//  ① QQ 群机器人**默认只收到被 @ 的消息**，要"不 @"就得在开放平台后台开
//     「获取群内全部消息」（只有群主能改）。本项目测试群已开。
//  ② 官方机器人**发不了 ark 名片卡**（文档：结构化卡片 单聊/群聊 发 ❌），
//     markdown 里塞 `mqqapi://` 自定义协议也被服务端直接拒
//     （HTTP 400 / code=40034028）。⇒ 只能用 **https 跳转页** 落地。
//
//  ── 护栏（照抄 linkparse/power 那套，别自己发明）──
//  · 机器人自己发的消息绝不处理（防自环）
//  · 每个会话 10 秒冷却（同一群人连着刷不重复回）
//  · 号码必须过「纯数字」校验才准拼进链接（安全红线）
// ============================================================
const cfg = require('./config');

// ---------- 号码解析 ----------
//
// 手机会顺手带空格 / 全角数字，还可能把 QQ 号抄成带标点。
// ⇒ 先做**统一宽度归一**，再判纯数字 —— 而不是上来就 reject 让用户猜为什么不行。
function normalizeDigits(s) {
  return String(s || '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角 ０-９
    .replace(/[\s\u3000​‌‍⁠]/g, '')                                  // 各种空格 / 零宽
    .replace(/[。，,、.．]+$/g, '')                                          // 结尾标点
    .trim();
}

// QQ 号：5~11 位、不以 0 开头（现存 QQ 最短 5 位、最长 11 位）
function isValidQQ(s) {
  return /^[1-9]\d{4,10}$/.test(String(s || ''));
}

// 群号：5~12 位、不以 0 开头（群号历史上比 QQ 号多一位）
function isValidGroup(s) {
  return /^[1-9]\d{4,11}$/.test(String(s || ''));
}

// ---------- 跳转页拼接 ----------
//
// ⚠️ 号码**必须**是校验过的纯数字再进来 —— 调用方一律先过 isValidQQ
//    （杜绝属性篡改 / 消息注入 / 开放重定向）。
//
// 两种落地方案（`cfg.policy.commands.linkMode`）：
//   'web'  —— 强制搜索页（**当前生效**，实测服务端收得下、手机能跳转）
//   'raw'  —— 不拼 markdown 链接语法，把完整 URL 当纯文本贴出来（最终兜底）
//
// 📌 已废弃：'scheme'（`mqqapi://card/...`）—— 服务端 40034028 直接拒，别再试。
const WEB_QQ = (n) => String((cfg.policy.commands || {}).webBase || 'https://tool.gljlw.com/qq/?qq={n}')
  .replace('{n}', String(n));

// 群卡片走**另一条链接**（个人那条是机领网的强制搜索页，对群没用）。
// 🔴🔴 2026-10-10 用户定调：「**加群功能删掉**」⇒ `/加群` 已经整个删除（连卡片、正则、
//    文案一起），原因见下面这段留档：**"按群号直跳群主页"在 QQ 侧没有公开链路**。
//      六条路全部实测否掉：
//      · `qun.qq.com/join.html?gc=群号` → 已下线（404 / 跳到需登录的管理页）
//      · `qun.qq.com/#/handy-tool/join-group?gc=群号` → **只匹配自己建的/管的群**，
//        手机端直接回「该功能需在电脑端操作」（无头浏览器实测原文）
//      · `qm.qq.com/cgi-bin/qm/qr` → 扫群二维码的落地页，拼出的群名片链接带
//        `auth=<authKey>&authSig=<签名>` —— 票据只有腾讯服务端会填，我们造不出来
//      · 老加群组件 `shang.qq.com/wpa/qunwpa` → 要每个群唯一的 `idkey`
//      · 群资料接口（qunwpa / get_group_info / connect.qq.com）→ 全部 404
//      · 自己拿域名 + HTTPS 也**不解**：手机 QQ 的 WebView 拦所有自定义协议
//      ⇒ 结论：**对"人"能按 uin 强制拉名片（`/加Q` 就在用），对"群"QQ 没开这个口子。**
//      留一个只能复制群号的半成品没有意义，所以整个功能撤掉。

const QQ_SCHEME = (n) => `mqqapi://card/show_pslcard?src_type=internal&version=1&card_type=person&uin=${n}`;

// ---------- 取文案（全部走 config，改文案不用动代码）----------
const CC = () => cfg.policy.commands || {};

function pick(arr, fallback) {
  const a = (Array.isArray(arr) && arr.length) ? arr : fallback;
  return String(a[Math.floor(Math.random() * a.length)]);
}

// 零宽空格：QQ 的 markdown 方言里，**换行必须靠 `\u200B\n`**，纯 `\n` 不换行。
const Z = '\u200B';

// ---------- 指令识别 ----------
//
// 先剥掉「点击 @ 自己」的 `<@openid>` 占位符，再去空白 —— 这样
// 「@机器人 /菜单」「/菜单」「 /菜单 」都能命中。
//
// 🔴 2026-10-10 用户定死：「**严格规定"/加Q(空格)qq号"**，防止误触发」⇒
//    加 Q 只认 `/加Q 12345` 这一种写法（斜杠可省、空格可换成冒号/逗号/加号；
//    但**不允许**"加Q12345"这种贴着的写法，也不认「加好友」「搜Q」之类的变体）。
function stripAt(s) {
  return String(s || '').replace(/<@[^>]{1,64}>/g, ' ');
}

// 返回 { kind: 'menu' } | { kind: 'qq'|'group', num, valid, raw } | null
function match(rawContent) {
  const raw = stripAt(rawContent).replace(/[\u3000\s]+/g, ' ').trim();
  if (!raw) return null;

  const c = CC();
  const menuRe = c.menuRe || /^[\/／]?(菜单|菜單|help|menu)(?=$|[\s,，。.!！?？~～:：])/i;
  // 🔴 2026-10-10 用户定死：**斜杠不可省、分隔符只认空格** ⇒ 只认 `/加Q 12345`。
  //    （号码内部夹的空格仍容忍 —— 那是抄号码带出来的，不是分隔符写法问题）
  const qqRe = c.qqRe || /^[\/／]加QQ?[\s\u3000]+(\d[\d\s\u3000]*)$/i;

  if (menuRe.test(raw)) return { kind: 'menu' };

  const m = raw.match(qqRe);
  if (m) {
    const num = normalizeDigits(m[1]);
    return { kind: 'qq', num, valid: isValidQQ(num), raw };
  }
  return null;
}

// ---------- 菜单 ----------
//
// 🔴 2026-10-10 用户要求：「菜单介绍太多了，不需要，只要有**标题和列出功能**就行了」
//    + 「返回卡片的排版紧密一点，跟菜单卡片一样」
// ⇒ 一律**紧凑排版**：标题一级 + 内容紧跟其后，**中间不留空行**
//    （QQ 的 markdown 每层空行都会渲染成一段高度，上一版卡片就是被空行撑散的）
function renderMenu() {
  const c = CC();
  const funcs = Array.isArray(c.functions) ? c.functions : [];

  const lines = [`# ${c.menuTitle || '/ 指令菜单'}`];
  for (const f of funcs) {
    lines.push(`\`${f.usage}\`　${f.name || ''}`.trim());
  }
  return lines.join('\n');
}

// ---------- 卡片 ----------
//
// 🔴🔴 2026-10-10 用户定调（原话）：「**我要的是点击链接直接跳群主页的功能，
//      做不了你就说，别做这种没用的功能出来**」+ 第二天：「**加群功能删掉**」
//      ⇒ **`/加群` 指令已整个删除**（不止是去掉链接），原因：
//      "按群号直跳群主页"在 QQ 侧没有公开链路（六条路全实测否掉，见 config 的说明），
//      给不出这个能力就不要留一个只能复制群号的半成品。
//      留下的是 `/菜单` 和 `/加Q`（后者真有价值：能拉出**隐藏号**的名片）。
//
// 排版：**跟菜单卡片同一套紧凑样式**（标题 + 内容紧跟，不插空行）。
function renderCard(num) {
  const c = CC();
  const web = WEB_QQ(num);
  const mode = c.linkMode || 'web';

  const lines = [`# ${c.qqTitle || '👤 QQ 联系人'}`];
  lines.push(`${Z}\n\`${num}\``);
  if (mode === 'raw') {
    lines.push(`${Z}\n复制到浏览器打开：${web}`);
  } else {
    lines.push(`[${c.qqLinkLabel || '点这里打开名片'}](${web})`);
  }
  if (c.qqTip) lines.push(`${Z}\n${c.qqTip}`);
  return lines.join('\n');
}

// ---------- 号码不合法时的提示 ----------
function renderBadNumber() {
  const c = CC();
  return pick(
    c.badQQTexts,
    ['QQ 号不太对，格式是 `/加Q 12345`（5~11 位数字）。'],
  );
}

// ---------- 冷却（同一会话别被刷屏）----------
const lastAt = new Map();       // scope -> ts
let lastSweep = 0;

function cooldownOk(scope) {
  const c = CC();
  const cd = Number(c.cooldownMs) || 10000;
  if (cd <= 0) return true;
  const now = Date.now();
  const last = lastAt.get(scope) || 0;
  if (now - last < cd) return false;
  lastAt.set(scope, now);

  // 顺手清理（别留定时器，同项目其它模块的做法）
  if (now - lastSweep > 10 * 60 * 1000) {
    lastSweep = now;
    for (const [k, t] of lastAt) if (now - t > 60 * 60 * 1000) lastAt.delete(k);
  }
  return true;
}

// ---------- 对外：一条指令 → 一条要发的消息 ----------
function build(rawContent, scope) {
  const hit = match(rawContent);
  if (!hit) return null;
  if (!cooldownOk(scope)) return { silent: true, why: '会话冷却中' };

  if (hit.kind === 'menu') return { text: renderMenu(), kind: 'menu' };
  if (!hit.valid) return { text: renderBadNumber(), kind: hit.kind, bad: true, num: hit.num };
  return { text: renderCard(hit.num), kind: hit.kind, num: hit.num };
}

module.exports = {
  match,
  build,
  renderMenu,
  renderCard,
  renderBadNumber,
  isValidQQ,
  normalizeDigits,
  _QQ_SCHEME: QQ_SCHEME,
  _WEB_QQ: WEB_QQ,
  _cooldownReset: () => { lastAt.clear(); lastSweep = 0; },
};
