// ============================================================
//  全局开关机（2026-09-22 用户需求）
//
//  需求原文：「我要给机器人添加开关机功能，条件就是主人发送
//            @bot名字，开机 / @bot名字，关机 来控制，全局控制」
//
//  ── 语义 ──
//  · **全局**：一个开关管所有群 + 所有私聊（不是"每个群单独开关"）
//  · **只有主人**能操作（`brain.isOwner` — 比对的是 openid，不是 QQ 号）
//  · 关机后：**不回话、不解析链接、不识别图片** —— 也就是**一分钱都不花**
//  · 开关机命令**自己不受关机影响**（否则关了就打不开了）
//
//  ── 为什么状态要落盘 ──
//  systemd 是 `Restart=always`，而且我们每次改代码都会 restart。
//  状态只放内存的话，"关机"会被下一次重启悄悄撤销 —— 那种"它自己又活了"
//  的行为比没有这个功能更让人困惑。
//
//  ── ⚠️ 忘了开回来怎么办（这是这个功能唯一的真风险）──
//  关机之后它就不会主动说话了，很容易忘了。三条自救路径（都写进文档了）：
//    1. 在群里 @它说「开机」（**唯一推荐**的正常路径）
//    2. 删掉状态文件再重启：`rm /opt/xiaolanjing/data/power.json && systemctl restart xiaolanjing`
//    3. 日志网页顶部会显示当前是开机还是关机（一眼能看到，不会瞎猜）
//  我们**故意没有做"N 天后自动开机"** —— 那会让"关机"变成不可靠的承诺。
// ============================================================
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const brain = require('./brain');

// 🔴 2026-10-16 修一处**契约违反**（是"灌假事件的体检"逼出来的）：
//    这里原来是 `path.join(__dirname, 'data')` —— **不认 `APP_DIR`**。
//    线上一时没出问题是因为"碰巧"：power.js 就在 /opt/xiaolanjing 下，而 panels 的单元
//    设的 `APP_DIR` 也是 /opt/xiaolanjing ⇒ 两边算出同一个文件。
//    但它违反项目自己定的**数据目录契约**（"所有落盘模块统一 `process.env.APP_DIR || __dirname`"，
//    settings.js 2026-10-07 就按这条改过），后果是：**想给状态文件做个沙箱都做不到** ——
//    我的事件回放体检往沙箱写 `on:false`，power.js 却一直读真身那份，
//    于是"关机时群指令还能用"这个 bug **根本没法用假事件复现**（差点得出错误结论）。
//    ⚠️ 线上行为零变化：bot 单元不设 APP_DIR（回落 __dirname = 同一个目录）、
//       logweb 单元设的就是 /opt/xiaolanjing。
const APP_DIR = process.env.APP_DIR || __dirname;
const STATE_DIR = path.join(APP_DIR, 'data');
const STATE_FILE = path.join(STATE_DIR, 'power.json');

let on = true;            // 全局开关（默认开机）
let since = 0;            // 状态是什么时候变成这样的
let by = '';              // 谁改的（记 openid 后 8 位 —— 日志里够用，不外泄完整 id）
// 🆕 2026-10-18 用户需求：**每个群单独开关机**
//   · 面板的开关机 = 全局（统一控制所有群）；全局关 ⇒ 所有群静默；
//   · 群里 @它 说「开机 / 关机」（**只认这两个词**）= 只改本群状态；
//   · 全局开机时清空群级覆盖（"统一控制所有群"的语义）。
let groups = {};          // scope -> { on, since, by }

function maskId(id) {
  const s = String(id || '');
  return s ? s.slice(0, 8) + '…' : '?';
}

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw.on === 'boolean') {
      on = raw.on;
      since = Number(raw.since) || 0;
      by = String(raw.by || '');
      groups = (raw.groups && typeof raw.groups === 'object') ? raw.groups : {};
    }
  } catch (e) {
    // ⚠️ 读坏了**按开机**处理 —— 宁可多花几分钱，也不能让机器人莫名其妙装死
    console.warn(`[power] 状态文件读不了（${e.message}），按"开机"处理`);
    on = true;
  }
}

function save() {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      on, since, by, groups, savedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.warn(`[power] 状态存不下来（${e.message}）—— 重启后会回到开机`);
  }
}

load();

// ---------- 🆕 从磁盘同步（2026-10-05 新增）----------
//
// 为什么需要：**开关机现在有两个入口** ——
//   ① 群里 @它说「关机」（这个进程自己写文件）
//   ② 网页面板上的"一键开关机"按钮（**另一个进程** logweb 写文件）
// 而本模块的状态是启动时读一次的 ⇒ 网页改完，机器人这边**不会知道**。
//
// ⇒ 靠 `fs.statSync().mtimeMs` 变化触发重读：没变就只做一次 stat（很便宜），
//   变了才真去读文件。**同时覆盖"两个进程互相改"和"群主手动改文件"两种情况**。
//
// ⚠️ 注意不能反过来用 fs.watchFile 的轮询回调去改内存 —— 那样测试里会留定时器；
//    这里选择"读时同步"，语义最简单：**每次问它状态，它先跟磁盘对一下**。
let lastMtime = 0;
function syncFromDisk() {
  try {
    const st = fs.statSync(STATE_FILE);
    if (st.mtimeMs === lastMtime) return;
    lastMtime = st.mtimeMs;
    load();
  } catch {
    // 文件还不存在（第一次开机）→ 按开机处理，什么都不用做
  }
}

// 🆕 2026-10-18（用户口径修正）：**单群状态优先，全局只是"批量覆盖"**。
//   · 群里单独开过关过的群，按自己的值走（哪怕全局是关的）；
//   · 面板按了开机/关机 ⇒ 覆盖所有群（清空群级设置，全部回到同一个值）。
function isOn(scope) {
  syncFromDisk();
  if (scope && groups[scope] && typeof groups[scope].on === 'boolean') return groups[scope].on;
  return !!on;
}

// 返回 true 表示"状态确实变了"（调用方据此决定说什么）
// 🆕 2026-10-18：`opts.clearGroups`（默认 true）—— 面板把全局打开时清空群级覆盖，
//    实现"后台开关机统一控制所有群"。群级命令不走这里（走 setGroup）。
function setOn(v, who, opts = {}) {
  const next = !!v;
  const hadGroups = Object.keys(groups).length > 0;
  const changed = next !== on || (next && opts.clearGroups !== false && hadGroups);
  on = next;
  if (next && opts.clearGroups !== false) groups = {};   // 统一控制：全部回到开
  if (changed) {
    since = Date.now();
    by = maskId(who);
    save();
  }
  return changed;
}

// 🆕 2026-10-18：只改**本群**状态（群里的 @它「开机/关机」走这里）
function setGroup(scope, v, who) {
  if (!scope) return false;
  syncFromDisk();
  const next = !!v;
  const cur = groups[scope];
  const changed = !cur || cur.on !== next;
  groups[scope] = { on: next, since: Date.now(), by: maskId(who) };
  save();
  return changed;
}

// 🆕 2026-10-18：本群当前是否开机（本群有单独设置就听本群的，否则跟全局默认）
function groupStatus(scope) {
  syncFromDisk();
  const g = scope ? groups[scope] : null;
  const explicit = !!(g && typeof g.on === 'boolean');
  return {
    on: explicit ? g.on : !!on,
    explicit,
    since: explicit ? (Number(g.since) || 0) : 0,
  };
}

function status() {
  syncFromDisk();          // 🆕 网页/群里改过都要能被看到
  return {
    on,
    since,
    by,
    groups,
    // 人话：开机 3 小时 12 分钟
    sinceText: since ? `${Math.floor((Date.now() - since) / 60000)} 分钟前` : '(本次启动时就是)',
  };
}

// ---------- 命令识别 ----------
//
// 🔴 设计原则：**宁可漏判，绝不误判**。误判的后果是"机器人莫名其妙不说话了"，
//    而且用户根本不会往"是不是误触了关机"上想。
//    所以：
//      · **必须 @ 它**（群聊里）—— 不能凭"主人说了开机两个字"就动手
//      · 匹配的是**剥掉 @ 标记后的整句**（`^...$`），不是"包含" ——
//        「这个功能怎么关机啊」不该触发
//      · 允许尾部标点和空格（手机会顺手加个句号 / 感叹号）
//      · 只认主人
//
// ⚠️ 私聊**不需要 @**（那里本来就是一对一，没法 @）—— 见 matchCommand 的说明。
// 🔴 2026-10-18 用户拍板：「关机是固定指令，其他近义词不行」
//    所以这里**只留两个词** —— 「开机」「关机」。别的说法（关闭/停止/醒来/睡吧…）**一律不触发**。
//    宁可漏判，绝不误判：关错了会让机器人莫名装死，而用户不会往"是不是关了机"上想。
const ON_WORDS = ['开机'];
const OFF_WORDS = ['关机'];

function normalize(text) {
  return String(text || '')
    .replace(/[\s\u3000]+/g, '')          // 空格（含全角）全去掉
    .replace(/[。，、！!？?~～.]+$/g, '')   // 结尾随手加的标点
    .trim();
}

// 返回 'on' | 'off' | null
//
// isPrivate=true 时不要求 @（私聊本来就点对点）；
// 群聊要求 @ —— 用 hasAtMarkup（原文里还有 <@...> 占位符）判断，
// 因为 stripAtMentions 之后就看不出有没有 @ 过了。
function matchCommand(msg, isPrivate) {
  if (!msg || !brain.isOwner(msg)) return null;      // 🔒 只认主人
  const raw = String(msg.content || '');
  if (!isPrivate && !brain.hasAtMarkup(raw)) return null;   // 🔒 群聊必须 @ 它

  const t = normalize(brain.stripAtMentions(raw));
  if (!t) return null;
  if (ON_WORDS.includes(t)) return 'on';
  if (OFF_WORDS.includes(t)) return 'off';
  return null;
}

// 回复文案。
//
// 🔴 2026-10-09 用户决定：**中性化，不绑人设**（原因同 config.js 里 ackTexts / pendingTexts）：
//    人设现在可以切换，过程文案若写死"傲娇鱼娘"的口吻，一换人设就会打架。
//    这里是**兜底值**（config.policy.power.* 有值就不会走到），但也一并中性化，
//    免得哪天 config 被清空又冒出旧口吻。
// 🆕 2026-10-18：群里的开关机只影响本群，回复文案要说清"本群"。
function replyFor(action, changed, opts = {}) {
  const c = cfg.policy.power || {};
  const group = !!opts.group;
  const pick = (arr, fallback) => {
    const a = Array.isArray(arr) && arr.length ? arr : fallback;
    return a[Math.floor(Math.random() * a.length)];
  };
  if (action === 'on') {
    return changed
      ? pick(group ? (c.groupOnTexts || c.onTexts) : c.onTexts, [group ? '本群已开机，可以正常对话了。' : '已开机，可以正常对话了。'])
      : pick(c.alreadyOnTexts, ['目前就是开机状态。']);
  }
  return changed
    ? pick(group ? (c.groupOffTexts || c.offTexts) : c.offTexts, [group ? '本群已关机，本群内暂时不回复消息。' : '已关机，暂时不回复消息。'])
    : pick(c.alreadyOffTexts, ['目前就是关机状态。']);
}

module.exports = {
  isOn,
  setOn,
  setGroup,
  groupStatus,
  status,
  matchCommand,
  replyFor,
  _normalize: normalize,
  _ON_WORDS: ON_WORDS,
  _OFF_WORDS: OFF_WORDS,
  _STATE_FILE: STATE_FILE,
};
