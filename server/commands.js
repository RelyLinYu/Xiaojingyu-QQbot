// ============================================================
//  👥 群内指令系统
//
//  ── 来历 ──
//  2026-10-10 用户需求：「无需@，当用户在群里输入 "/菜单" 时，会返回菜单面板，罗列功能」
//  2026-10-14 用户改版（**当前生效的版本**）：
//    「1.菜单/加Q等等命令触发的前缀改为 #，舍弃原本的 /
//      2.清空现有功能指令
//      3.规定菜单模板 #指令 --- 功能，例如 #cd --- 菜单」
//
//  ⇒ 现在本模块只认**一条指令**：
//     `#cd`  菜单（纯拼串，0 次网络）
//     另外 `#tg`（群友投稿图库）由 `submit.js` 自己接 —— 这里只把它算进"我们的指令"。
//     旧的两条（`/菜单`、`/加Q`）**已从匹配里下线** —— 用户要求"清空现有功能指令"。
//     `/加Q` 的卡片代码还留着（文件下半部分），要恢复就把 match 里那两行接回来。
//
//  ── 为什么单独一个模块、而不是塞进 brain.js ──
//  · 这些都是**确定性指令**（正则命中就执行），和"要不要接话"那套概率判断无关。
//  · 必须跑在 **power 开关机之前**（关机了也要能调出菜单）。
//  · 全程 **0 次模型调用**（能不用模型解决的就不用模型 —— 项目铁律）。
//
//  ── 🔴 两条平台事实 ──
//  ① QQ 群机器人**默认只收到被 @ 的消息**，要"不 @"就得在开放平台后台开
//     「获取群内全部消息」（只有群主能改）。本项目测试群已开。
//  ② 官方机器人**发不了 ark 名片卡**，markdown 里塞 `mqqapi://` 也会被服务端拒
//     （HTTP 400 / code=40034028）⇒ 只能用 **https 跳转页** 落地。
//
//  ── 护栏 ──
//  · 机器人自己发的消息绝不处理（防自环，调用方已挡）
//  · 冷却：菜单按群（一个群一份 —— 一个人刷不该害得全群用不了）
//  · 号码必须过「纯数字」校验才准拼进 URL（安全红线）
// ============================================================
const cfg = require('./config');

const CC = () => cfg.policy.commands || {};

// ---------- 号码解析（`#加Q` 卡片用）----------
function normalizeDigits(s) {
  return String(s || '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角 ０-９
    .replace(/[\s\u3000​‌‍⁠]/g, '')                                  // 各种空格 / 零宽
    .replace(/[。，,、.．]+$/g, '')                                          // 结尾标点
    .trim();
}
function isValidQQ(s) { return /^[1-9]\d{4,10}$/.test(String(s || '')); }

// ---------- 文案 ----------
function pick(arr, fallback) {
  const a = (Array.isArray(arr) && arr.length) ? arr : fallback;
  return String(a[Math.floor(Math.random() * a.length)]);
}

// 零宽空格：QQ 的 markdown 方言里，**换行必须靠 `\u200B\n`**，纯 `\n` 不换行。
const Z = '\u200B';

function stripAt(s) { return String(s || '').replace(/<@[^>]{1,64}>/g, ' '); }

// ---------- 菜单 ----------
//
// ---------- 菜单卡片（`#cd`）----------
//
// 🔴 2026-10-14 晚**恢复**：中间一度删掉过（那时想用官方指令面板顶替），
//    但指令面板是**@ 就弹**、触发时机由 QQ 客户端定，我们控制不了 ——
//    用户拍板「不做拉起面板」，于是回到自己发卡片。
//
// 排版（用户 2026-10-10 定）：**标题 + 每行 `指令 --- 功能`，中间不留空行**
//   标题一级 + 内容紧跟（QQ 的 markdown 每层空行都会渲染成一段高度，
//   上一版卡片就是被空行撑散的）。
//
// 🔴🔴 2026-10-16 用户：「**菜单卡片同步，最好是每个功能占一行，别挤到下一行**」
//    ⇒ 硬约束（QQ 的 markdown 卡片**不会自动换行**，长行会折下去或被截断）：
//      · **一条功能 = 一行**，靠 `\n` 换行（发送侧 qqapi 会把 `\n` 变成 `Z\n`）；
//      · **每行的单行宽度要短**（中文约 30 字以内安全）⇒ 名字必须短，
//        长名字要在 config 的 `functions[].name` 里压短，别在渲染时截断（截了缺字更糟）。
function renderMenu() {
  const c = CC();
  const funcs = Array.isArray(c.functions) ? c.functions : [];
  const sep = c.separator || ' --- ';
  const lines = [`# ${c.menuTitle || '指令菜单'}`];
  for (const f of funcs) lines.push(`\`${f.usage}\`${sep}${f.name || ''}`.trim());
  return lines.join('\n');
}

// ⛔ 图片版菜单（`#cd pic`）**已于 2026-10-16 当天撤掉** —— 用户原话：
//    「不要 `#cd pic`，那是我放到机器人主页的图」⇒ 那张图是给主页/bot 资料用的，
//    不是群指令。生成物 `data/menu/menu.png` 与渲染器 `tools/make-menu.cjs` 留着（可按需复用），
//    但**不再挂任何指令**（`match()` 里不认 menu-img，`index.js` 里那条分支也删了）。

// ---------- 主人判定（冷却豁免要用）----------
// 惰性 require，避免模块加载顺序问题（index.js 里对 imglib 也是这么做的）
function ownerOf(d) {
  try { return require('./brain').isOwner(d); } catch { return false; }
}

// ---------- 冷却 ----------
//
// key 由调用方决定粒度：菜单用 `menu|scope`（**一个群一份** —— 一个人刷不该害得全群用不了）。
// 主人不受冷却限制（和 config.policy.imglib.ownerBypass 一个语义）。
const lastAt = new Map();
let lastSweep = 0;

function cooldownOk(key, cd, bypass) {
  if (bypass) return true;
  if (!(cd > 0)) return true;
  const now = Date.now();
  const last = lastAt.get(key) || 0;
  if (now - last < cd) return false;
  lastAt.set(key, now);

  if (now - lastSweep > 10 * 60 * 1000) {     // 顺手清理（别留定时器，同项目其它模块的做法）
    lastSweep = now;
    for (const [k, t] of lastAt) if (now - t > 60 * 60 * 1000) lastAt.delete(k);
  }
  return true;
}

// ---------- 指令识别 ----------
//
// 先剥掉「点击 @ 自己」的 `<@openid>` 占位符，再去空白 —— 这样
// 「@机器人 #cd」「#cd」「 /#cd 」都能命中。
async function match(rawContent, scope, d, log = () => {}) {
  const raw = stripAt(rawContent).replace(/[\u3000\s]+/g, ' ').trim();
  if (!raw) return null;

  const c = CC();
  if (c.enabled === false) return null;

  const menuRe = c.menuRe || /^(?:[\/／][#＃]?|[#＃])(?:cd|菜单)(?=$|[\s,，。.!！?？~～:：])/i;
  if (menuRe.test(raw)) return { kind: 'menu' };

  // ⛔ `#加Q` 没接线（见 config 注释）。
  return null;
}

// ---------- 别人的指令，别去接话 ----------
//
// 群里不止我们一个机器人。实测事故（2026-10-14）：管理员点了指令面板里的指令，
// 客户端给到 `/#xx`，旧正则没命中 ⇒ 这句话**掉进模型**，模型把它当聊天硬猜，
// 回出一个完全是编的答案，还顺着上下文扯到别的 bot 的菜单去了 —— 全是编的。
//
// ⇒ 判定规则（宁可少接一句，也别让模型对着别人的指令编）：
//   · `/` 或 `／` 开头：QQ 里它就是指令 / 原生大表情（`/滑稽`）前缀 ⇒ 一律不回
//   · `#` 或 `＃` 开头：只有后面跟**命令样貌**（ASCII 字母数字，如 `#help`）才不回；
//     中文的 `#今日份的快乐` 是话题标签，照常交给模型
//
// 🆕 2026-10-15：**我们自己已认领的指令前缀要先放过**（`#tg` 投稿是 submit.js 自己接的，
//    不经过 commands.build）—— 否则「# 开头的英文指令」那条规则会把 `#tg` 也当"别家的"，
//    于是"上报了成功/冷却"的那条路之外，日志里还会留一句莫名其妙的"别人的指令"。
//    ⚠️ 这里只加**已实现的**前缀；新指令上线时记得同步（和 match() 那两行一个道理）。
function isOurCommand(raw) {
  const s = String(raw || '');
  if (CC().menuRe ? CC().menuRe.test(s) : /^[#＃](?:cd|菜单)(?=$|[\s,.。!！?？~～:：])/i.test(s)) return true;
  try { if (require('./submit').isCommand(s)) return true; } catch { /* 读不到就算了 */ }
  return false;
}

// ---------- 🆕 2026-10-16 关机时哪些指令还放行 ----------
//
// 用户 2026-10-16 实测报：「关机状态下可以使用指令，开关机范围是不是没设置好」
//   ⇒ 起因是这段指令分发**排在关机判断之前**（当初的理由："关了机也得能把菜单调出来"）。
//     指令是真要干活的（上游请求 + 占上行带宽），跟"关机＝什么都不做"冲突了。
//
// 语义（`policy.commands.commandsWhenOff`）：
//   'all'  —— 关机时指令照常（**旧行为**，想退回去就填这个）
//   'menu' —— 只留 `#cd` 菜单（0 成本）
//   'none' —— **关机时一条指令都不理** ← 现在（用户 2026-10-16：「菜单也关掉」）
//
// ⚠️ 纯函数、**不碰网络**：只吃 `kind`（`match()` 的产物）与模式，喂什么都好测。
// ⚠️ 认不出的模式（写错了）按 `'none'` 处理 —— 宁可少放行，别把关机当没关。
function allowedWhenOff(kind, mode) {
  const m = ['all', 'menu', 'none'].includes(String(mode)) ? String(mode) : 'none';
  if (m === 'all') return true;
  if (m === 'none') return false;
  return kind === 'menu';          // 'menu'：只放菜单
}

function looksForeign(rawContent) {
  if (CC().ignoreForeign === false) return '';
  const raw = stripAt(rawContent).replace(/[\u3000\s]+/g, ' ').trim();
  if (!raw) return '';
  // ⚠️ `#tg` 也走这里：`isOurCommand` 会认它（submit.isCommand）⇒ 不会被当外站指令静默；
  //    投稿关掉时它在 index 里直接落到正常聊天，靠的就是这一点。
  if (isOurCommand(raw)) return '';
  if (/^[\/／]/.test(raw)) return '斜杠开头的指令/表情（不是我们的）';
  if (/^[#＃][A-Za-z0-9_-]/.test(raw)) return '井号开头的英文指令（不是我们的）';
  return '';
}

// ---------- 对外：一条指令 → 一条要发的消息 ----------
//
// ⚠️ async：接口统一成异步（将来的指令要发网络请求，调用方已经 await）。
async function build(rawContent, scope, d, log = () => {}) {
  const hit = await match(rawContent, scope, d, log);
  if (hit && hit.kind === 'menu') {
    const cd = Number(CC().cooldownMs);
    if (!cooldownOk(`menu|${scope}`, Number.isFinite(cd) ? cd : 10000, ownerOf(d))) {
      return { silent: true, why: '菜单冷却中' };
    }
    return { kind: 'menu', text: renderMenu() };
  }

  // 没命中我们的指令 —— 看看是不是"别人的指令"，是就静默（只留日志）
  const foreign = looksForeign(rawContent);
  if (foreign) {
    log(`别人的指令（${foreign}）→ 不回（ignoreForeign，只留这行日志）`);
    return { silent: true, why: `别人的指令：${foreign}` };
  }
  return null;
}

// ============================================================
//  ⛔ 以下为**已下线**的 `/加Q` 卡片（2026-10-14 起不再匹配）。
//
//  留着的原因：它是用户明确要过的功能 —— 「要的就是**强制搜索隐藏好友**的功能」
//  （普通"搜号码"搜不到隐藏号，那个页面走 QQ 名片协议才能拉出来）。
//  恢复方法：match() 里那两行 + config.policy.commands.functions 里加一行。
//
//  ── 🔴 2026-10-10 用户定调（原话）──
//  「**我要的是点击链接直接跳群主页的功能，做不了你就说，别做这种没用的功能
//    出来**」⇒ `/加群` 已**整个删除**：QQ 侧没有"按群号直跳群主页"的公开链路
//  （六条路全实测否掉：qun.qq.com/join.html / handy-tool/join-group /
//   qm.qq.com 的 auth+authSig 票据 / shang.qq.com/wpa 的 idkey / 群资料接口全 404 /
//   自建域名+HTTPS 仍被手机 QQ 的 WebView 拦协议）。
// ============================================================
const WEB_QQ = (n) => String(CC().webBase || 'https://tool.gljlw.com/qq/?qq={n}').replace('{n}', String(n));
const QQ_SCHEME = (n) => `mqqapi://card/show_pslcard?src_type=internal&version=1&card_type=person&uin=${n}`;

function renderCard(num) {
  const c = CC();
  const web = WEB_QQ(num);
  const lines = [`# ${c.qqTitle || '👤 QQ 联系人'}`];
  lines.push(`${Z}\n\`${num}\``);
  if ((c.linkMode || 'web') === 'raw') lines.push(`${Z}\n复制到浏览器打开：${web}`);
  else lines.push(`[${c.qqLinkLabel || '点这里打开名片'}](${web})`);
  if (c.qqTip) lines.push(`${Z}\n${c.qqTip}`);
  return lines.join('\n');
}

function renderBadNumber() {
  return pick(CC().badQQTexts, ['QQ 号不太对，格式是 `#加Q 12345`（5~11 位数字）。']);
}

module.exports = {
  build,
  match,
  allowedWhenOff,
  looksForeign,
  renderMenu,
  renderCard,
  renderBadNumber,
  isValidQQ,
  normalizeDigits,
  _QQ_SCHEME: QQ_SCHEME,
  _WEB_QQ: WEB_QQ,
  // 测试用：清冷却（每个用例开头调一次，别让上一个用例的冷却带过来）
  _cooldownReset: () => { lastAt.clear(); lastSweep = 0; },
};
