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

const STATE_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'power.json');

let on = true;            // 默认开机（文件不存在 / 读坏了都按开机处理）
let since = 0;            // 状态是什么时候变成这样的
let by = '';              // 谁改的（记 openid 后 8 位 —— 日志里够用，不外泄完整 id）

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
      on, since, by, savedAt: new Date().toISOString(),
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

function isOn() { syncFromDisk(); return on; }

// 返回 true 表示"状态确实变了"（调用方据此决定说什么）
function setOn(v, who) {
  const next = !!v;
  const changed = next !== on;
  on = next;
  if (changed) {
    since = Date.now();
    by = maskId(who);
    save();
  }
  return changed;
}

function status() {
  syncFromDisk();          // 🆕 网页/群里改过都要能被看到
  return {
    on,
    since,
    by,
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
const ON_WORDS = ['开机', '开启', '启动', '醒来', '起床', '上班'];
const OFF_WORDS = ['关机', '关闭', '停止', '睡吧', '睡了', '下班'];

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
function replyFor(action, changed, who) {
  const c = cfg.policy.power || {};
  const pick = (arr, fallback) => {
    const a = Array.isArray(arr) && arr.length ? arr : fallback;
    return a[Math.floor(Math.random() * a.length)];
  };
  if (action === 'on') {
    return changed
      ? pick(c.onTexts, ['已开机，可以正常对话了。'])
      : pick(c.alreadyOnTexts, ['目前就是开机状态。']);
  }
  return changed
    ? pick(c.offTexts, ['已关机，暂时不回复消息。'])
    : pick(c.alreadyOffTexts, ['目前就是关机状态。']);
}

module.exports = {
  isOn,
  setOn,
  status,
  matchCommand,
  replyFor,
  _normalize: normalize,
  _ON_WORDS: ON_WORDS,
  _OFF_WORDS: OFF_WORDS,
  _STATE_FILE: STATE_FILE,
};
