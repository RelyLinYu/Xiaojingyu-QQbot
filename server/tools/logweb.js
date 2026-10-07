#!/usr/bin/env node
// ============================================================
//  日志监控网页 —— 手机浏览器看机器人日志
//
//  为什么单独一个进程：
//    ① 崩了不影响机器人（各自 systemd 服务）
//    ② 只读，不碰任何业务状态
//    ③ 权限最小：只运行 journalctl / 读 data/ 下的文件
//
//  ⚠️ 安全设计（必须理解，否则等于把群聊记录公开）：
//    · 必须带正确密码才能看，密码走环境变量 LOG_PASSWORD
//    · 只监听 0.0.0.0:PORT，**入站安全组只放行这一个端口**
//    · 全站只读，没有任何"执行命令""改配置"的入口
//    · 不上传任何用户输入到别处，不落盘访问日志
//    · 🆕 只有 `/og/...` 一条路径是**公开**的（放给 QQ 平台抓图片用，它不会带密码），
//         而且那条路径只接受结构化的 `<owner>/<repo>`，**不接受任意 URL** ——
//         细节与理由见 tools/ogcache.js 的文件头
//
//  用法：
//    LOG_PASSWORD=你的密码 PORT=8080 node tools/logweb.js
//  手机访问： http://<你的服务器IP>:8080/?p=你的密码
//  （加到手机主屏幕就像个 App）
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ogcache = require('./ogcache');
const convo = require('./convo');        // 🆕 把原始日志翻译成人看得懂的对话卡片
const settings = require('../settings'); // 🆕 面板可改的参数（白名单 + 密钥掩码）

const PORT = Number(process.env.PORT) || 8080;
const PASSWORD = process.env.LOG_PASSWORD || '';
const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..');
const SERVICE = process.env.SERVICE_NAME || 'xiaolanjing';

if (!PASSWORD) {
  console.error('❌ 必须设置 LOG_PASSWORD（否则谁都能看你的群聊日志）');
  console.error('   例如： LOG_PASSWORD=abc12345 node tools/logweb.js');
  process.exit(1);
}

// ---------- 取数据 ----------
// ⚠️ execFile 在"命令不存在"时会**同步抛异常**，所以必须包 try ——
//    不然整个进程会被未捕获异常干掉（本地测试时踩到过：调一次 /api/state 服务就死了）。
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve({ err, stdout: stdout || '' });
      });
    } catch (e) {
      resolve({ err: e, stdout: '' });
    }
  });
}

async function journalLines(n) {
  const { err, stdout } = await run('journalctl',
    ['-u', SERVICE, '-n', String(n), '--no-pager', '-o', 'short-iso'], 5000);
  if (!stdout) return `(读不到日志${err ? ': ' + err.message : ''})\n（本机没有 journalctl 时属正常）`;
  return stdout;
}

async function serviceState() {
  const { err, stdout } = await run('systemctl', ['is-active', SERVICE], 3000);
  if (err && !stdout) return 'unknown';
  return (stdout || '').trim() || 'unknown';
}

// 🆕 开关机状态（2026-09-22）
//
// 🔴 为什么日志网页必须显示它：这是"开关机"功能**唯一的自救入口之一**。
//    "关机"之后它就不说话了，很容易忘了 —— 打开这个页面一眼就能看到是开是关，
//    而不用去猜"它怎么不理人"。
// ⚠️ 故意**不 require power.js**：那样会把 brain/config 一起拉进这个只读进程，
//    而且两个进程各有一份内存状态、容易看串。直接读文件最准。
function powerState() {
  try {
    const f = path.join(APP_DIR, 'data', 'power.json');
    if (!fs.existsSync(f)) return { on: true, since: 0, by: '', default: true };
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { on: j.on !== false, since: Number(j.since) || 0, by: String(j.by || ''), default: false };
  } catch (e) {
    // 读坏了按"开机"显示 —— 和 power.js 的处理保持一致
    return { on: true, since: 0, by: '', error: e.message };
  }
}

// 2026-10-06：面板的人设框要显示当前生效的人设（否则用户面对空框没法改）。
// 人设真源在 config.js（它 require 了 settings）；这里只做显示用的填充，不改任何存储。
function fillPersonaForPanel(snapObj) {
  try {
    if (!snapObj) return snapObj;
    // 🆕 2026-10-06（用户：「回复上限改为 3000 保存后修改框里的 3000 没有消失」→ 顺带发现
    //    "每天限额/总限额"两个框是**空的**，而额度卡片上明明显示 ¥3/¥30 —— 因为
    //    settings.json 里没存过，`snapshot()` 就给 null → 空框）⇒ **数值框也填"当前生效值"**，
    //    让用户看到的就是真正在用的数（保存 = 把它固化进 settings.json，无害）。
    try {
      const cfgNum = require('../config');
      const eff = {
        budgetDaily: cfgNum.budget.dailyLimitYuan,
        budgetTotal: cfgNum.budget.totalLimitYuan,
        dailyCalls: cfgNum.policy.dailyCallLimit,
      };
      for (const k of Object.keys(eff)) {
        const v = eff[k];
        if (snapObj[k] && (snapObj[k].value == null) && Number.isFinite(Number(v))) {
          snapObj[k].value = Number(v);
          snapObj[k].fromDefault = true;
        }
      }
    } catch (e) { /* 填不上就算了 */ }
    if (!snapObj.personaText) return snapObj;
    const cur = String(snapObj.personaText.value || '');
    if (cur.trim()) return snapObj;
    const cfg = require('../config');
    snapObj.personaText.value = String(cfg.persona.systemPrompt || '');
    snapObj.personaText.fromDefault = true;
  } catch (e) { /* 填不上不影响别的 */ }
  return snapObj;
}
function budgetState() {
  try {
    const f = path.join(APP_DIR, 'data', 'budget.json');
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));

    // 🔴 2026-10-06 修：**"上限"必须直接读动态真源 `settings.json`**。
    //    这个页面是独立进程，原来只读 `budget.json` 里主进程落盘的旧上限 ⇒
    //    用户在面板把"每天回复调用上限"改成 3000、页面提示"已保存"，
    //    **但额度区仍显示 1600**（他立刻发现："保存了之后顶部监控卡片里的 1600 没改"）。
    let dyn = {};
    try { dyn = settings.values() || {}; } catch { dyn = {}; }

    // 上限优先取**面板保存的动态值**；再取 budget.json 里落的；最后 .env / 默认值兜底。
    const envDaily = Number(process.env.BUDGET_DAILY_YUAN) || 3;
    const envTotal = Number(process.env.BUDGET_TOTAL_YUAN) || 10;
    const dl = Number(dyn.budgetDailyYuan) || Number(j.dailyLimit) || envDaily;
    const tl = Number(dyn.budgetTotalYuan) || Number(j.totalLimit) || envTotal;
    const cl = Number(dyn.dailyCallLimit) || Number(j.dailyCallLimit) || 1600;
    const daySpent = Number(j.daySpent) || 0;
    const spentYuan = Number(j.spentYuan) || 0;

    return {
      day: j.day,
      daySpent,
      dailyLimit: dl,
      dayLeft: Math.max(0, dl - daySpent),
      spentYuan,
      totalLimit: tl,
      totalLeft: Math.max(0, tl - spentYuan),
      calls: Number(j.calls) || 0,            // 终身累计
      dayCalls: Number(j.dayCalls) || 0,      // 🆕 今日（跨天清零）—— 页面显示的是它
      dailyCallLimit: cl,                     // 🆕 上限（**动态值优先**，见上面说明）
      // 🆕 2026-10-05：官方口径（余额 + 由锚点反推的"累计已花"）。
      //    ⚠️ 它是**主进程定时查回来、顺手写进 budget.json** 的（budget.js 的 save()），
      //    这个页面是独立进程，读不到主进程的内存，只能靠文件。
      //    ⚠️ 用户明确说过「**日志不需要加官方余额**」⇒ 页面上**不展示余额**，
      //      只用它的 `spent`（= 锚点 − 当前账户余额）来显示"累计已花"的官方口径。
      official: j.official || null,
      blocked: Number(j.blocked) || 0,
      byModel: j.byModel || {},
    };
  } catch { return null; }
}

// 🆕 事件读取加缓存 + 放大窗口 + **跨天读两个文件**（2026-10-05）
//    🔴 三个原因，缺一个都会让"群号反查"大面积失准（实测 `guess=weak` 刷屏）：
//      ① 一次页面刷新里 `recentEvents` 会被调用多次（建作者表、建群号顺序表…）⇒ 重复读整个文件；
//      ② 原来只取最后 3000 条，而日志面板一次显示几百行、可能跨几千条事件 ⇒ 更早的反查不到；
//      ③ **服务是跨夜跑的**：日志面板显示的是**昨天 18:xx** 的对话，而"最后那个 events 文件"
//         已经是**今天 01:xx** 的了 ⇒ 只读最后一个文件，等于**把面板要显示的那批事件全漏掉**。
let _evCache = { at: 0, rows: null };
function recentEvents(n) {
  const now = Date.now();
  if (_evCache.rows && now - _evCache.at < 3000) return _evCache.rows.slice(-n);
  try {
    const dir = path.join(APP_DIR, 'data');
    const files = fs.readdirSync(dir).filter((x) => x.startsWith('events-')).sort();
    if (!files.length) return [];
    // 同时读最近两个文件（跨天时"昨天下午的对话"在倒数第二个文件里）
    //
    // 🔴 每个文件取多少行 —— 这里踩过一次很隐蔽的坑：
    //    原来写 `slice(-Math.max(n, 20000))`，看着像"至少两万行、够了吧"，
    //    但实际效果是**"只保留尾部这么多行"**：10-05 那个文件有 4944 行，
    //    而面板要显示的 **18:31** 那条排在第 ~3800 行 ⇒ **正好被切掉**，
    //    表现为"这条对话反查不到群号，退化成按作者猜"。
    //  ⇒ 现在每个文件只取**最后 2000 行**（= 当天最近的一批），
    //    一天的事件文件本身就有几千行，取尾部 2000 行足够覆盖面板显示的窗口，
    //    而且**两个文件加起来不会太慢**（解析 4000 行 JSONL 是毫秒级）。
    const PER_FILE = Math.max(n, 2000);
    const pick = files.slice(-2);
    const lines = [];
    for (const f of pick) {
      try {
        const part = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
        lines.push(...part.slice(-PER_FILE));
      } catch { /* 单个文件读不了就跳过 */ }
    }
    const rows = lines.map((l) => {
      try {
        const e = JSON.parse(l);
        const d = e.d || {};
        return {
          t: e.t,
          time: (d.timestamp || '').slice(11, 19),
          who: d.author?.username || '?',
          text: typeof d.content === 'string' ? d.content.trim() : '',
          type: d.message_type,
          // 🆕 群/用户 id：日志里只有角色，**id 只在这里有** ⇒ 拼卡片时要用
          //    ⚠️ 私聊（C2C）事件里**没有群号**、昵称还是空的，身份在 `author.user_openid`
          scopeId: d.group_openid || d.group_id || d.author?.member_openid || d.author?.user_openid || '',
          // 🆕 事件类型（C2C=私聊 / GROUP=群）—— 用来纠正卡片上的"群/私聊"标记
          kind: String(e.t || d.message_type || '').includes('C2C') ? 'private' : 'group',
          quoted: (d.msg_elements || []).map((x) => (x.content || '').trim()).filter(Boolean).join(' '),
        };
      } catch { return null; }
    }).filter(Boolean);
    _evCache = { at: now, rows };
    return rows.slice(-n);
  } catch { return []; }
}

// 🆕 把"作者 + 时间"映射到群号（2026-10-05）
//
// 🔴 为什么不能只按作者：**同一个人会在多个群说话** ——
//    我先写的"作者→群号（取最近出现的）"把他**在别的群说的话也贴到了第一个群**，
//    用户立刻发现（"这些是在另外一个群说的，为什么也在第一个群的卡片里？"）。
// 🔴🔴 为什么还必须**带容差**（第二轮才发现）：日志里的时间**比平台 timestamp 晚约 1 秒**
//    （日志打的是"机器人收到的那一刻"，事件里的 timestamp 是平台发出的时刻）。
//    实测：表里是 `<某人>@18:43:27`，而面板上是 `18:43:28`
//    ⇒ **精确匹配一个都对不上，全部退化成"按作者猜"**，于是同一个群被拆成两张卡。
//    ⇒ 用 ±3 秒窗口在**同一作者**里找（键按秒排序 + 二分定位，几千条也不慢）。
const TIME_TOLERANCE_SEC = 3;

function toSec(t) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(t || ''));
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}

// 🔴 昵称归一化（2026-10-06 踩过）：事件里的昵称可能带**前导/内嵌空格**，
//    实测某群友的昵称是 `'　　　　　没有名字的海'`（5 个全角空格），而日志里已被 trim 成
//    `'没有名字的海'` ⇒ **两边不一致 ⇒ 群号反查失败 ⇒ 卡片退化成"群 N（未命名）"、群内码显示"（认不出）"**。
//    ⇒ 比较时一律**去掉所有空白字符**（含全角空格 \u3000）。
function whoKey(w) {
  return String(w || '').replace(/[\s\u3000]+/g, '');
}

function authorTimeMap() {
  const byTime = new Map();     // `${whoKey}@${HH:MM:SS}` -> { scopeId, kind }
  const byAuthor = new Map();
  const all = [];               // 🆕 全局时间轴（不看作者）：给"作者名是空白"的消息兜底
  for (const e of recentEvents(3000)) {
    if (!e.who || !e.scopeId) continue;
    const sec0 = toSec(e.time);
    if (sec0 !== null) all.push({ sec: sec0, scopeId: e.scopeId, kind: e.kind || '' });
    const w = whoKey(e.who);
    // ⚠️ 2026-10-06：**作者名归一化后可能为空**（实测有群友昵称就是 `'\u3000'` 一个全角空格）
    //    ⇒ 原来这里 `if (!w) continue` 直接把那条事件丢掉 ⇒ 那条消息永远反查不到群号
    //      ⇒ 面板上冒出一张"群 N（未命名）·群内码（认不出）"的孤儿卡（用户以为是"新群"）。
    //    ⇒ 不再丢掉：它照样进全局时间轴，靠"时间最近"归属。
    if (!w) continue;
    if (e.time) byTime.set(`${w}@${e.time}`, { scopeId: e.scopeId, kind: e.kind || '' });
    byAuthor.set(w, e.scopeId);      // 后来者覆盖 = 最近优先（仅作兜底）
  }
  all.sort((a, b) => a.sec - b.sec);
  // 每个作者的时间键：排序 + 带秒数，供"容差查找"用
  const sorted = new Map();
  for (const [key, info] of byTime) {
    const at = key.lastIndexOf('@');
    const who = key.slice(0, at);          // 已经是 whoKey 形式
    const sec = toSec(key.slice(at + 1));
    if (sec === null) continue;
    if (!sorted.has(who)) sorted.set(who, []);
    sorted.get(who).push({ sec, scopeId: info.scopeId, kind: info.kind });
  }
  for (const arr of sorted.values()) arr.sort((a, b) => a.sec - b.sec);

  return {
    byTime,
    byAuthor,
    /**
     * 容差查找：这个作者、这个时间 ±N 秒 的 **群号 + 事件类型**；找不到返回 null。
     * ⚠️ 作者名一律走 `whoKey()` 归一化（去所有空白）—— 事件里的昵称可能带前导空格。
     */
    lookup(who, time) {
      const sec = toSec(time);
      if (sec === null) return null;
      const arr = sorted.get(whoKey(who));
      if (!arr || !arr.length) return null;
      // 二分定位到 <= sec 的最后一项，再左右扫一小段
      let lo = 0; let hi = arr.length - 1; let pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].sec <= sec) { pos = mid; lo = mid + 1; } else hi = mid - 1;
      }
      let best = null; let bestGap = 1e9;
      for (let i = Math.max(0, pos - 6); i < Math.min(arr.length, pos + 7); i++) {
        const gap = Math.abs(arr[i].sec - sec);
        if (gap <= TIME_TOLERANCE_SEC && gap < bestGap) { bestGap = gap; best = arr[i]; }
      }
      return best;      // { sec, scopeId, kind } 或 null
    },
    /**
     * 🆕 2026-10-06：**只看时间、不看作者**的兜底查找。
     * 用途：作者名是空白（昵称就是空格）的消息，按昵称怎么都匹配不上 ⇒ 用"时间最近的那条事件"
     * 归属。⚠️ 它是**兜底**，只在按作者查不到时才用（忙群里可能撞到别的群，但总比变成孤儿卡好）。
     */
    lookupByTime(time) {
      const sec = toSec(time);
      if (sec === null || !all.length) return null;
      let lo = 0; let hi = all.length - 1; let pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (all[mid].sec <= sec) { pos = mid; lo = mid + 1; } else hi = mid - 1;
      }
      let best = null; let bestGap = 1e9;
      for (let i = Math.max(0, pos - 3); i < Math.min(all.length, pos + 4); i++) {
        const gap = Math.abs(all[i].sec - sec);
        if (gap <= TIME_TOLERANCE_SEC && gap < bestGap) { bestGap = gap; best = all[i]; }
      }
      return best;
    },
  };
}

// 群号的"可读编号"：第 1 次出现的群叫"群 1"，以此类推
function scopeOrder() {
  const seen = [];
  for (const e of recentEvents(3000)) {
    if (e.scopeId && !seen.includes(e.scopeId)) seen.push(e.scopeId);
  }
  return seen;
}

// 🆕 最近见过的群 id（原始事件里出现过哪些）
function recentScopeIds() {
  return scopeOrder();
}

// ---------- 🆕 群名/群号的可改表（读不到就让用户手填）----------
//  ⚠️ 现实约束：QQ 官方 API **不直接给群名**，日志和事件里只有 32 位群 openid ⇒
//     所以"读不到就占位符、允许手改"是**设计必需**，不是退让。
const GROUPS_FILE = path.join(APP_DIR, 'data', 'groups.json');
function groupsLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    return (j && typeof j.aliases === 'object') ? j.aliases : {};
  } catch { return {}; }
}
function groupsSave(aliases) {
  try {
    const tmp = GROUPS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ aliases }, null, 2));
    fs.renameSync(tmp, GROUPS_FILE);
    return { ok: true };
  } catch (e) { return { ok: false, why: e.message }; }
}

// 🆕 把日志解析成对话卡片，并给**每条对话**分配它属于哪个会话（群 / 私聊）。
//    🔴 2026-10-05 修过一次：原来按"昵称"归组，结果**同一个人的跨群消息被贴到同一个群里**
//       （用户发现："这些是在另外一个群说的，为什么也在第一个群的卡片里？"）
//    ⇒ 现在按**群号**归组，群号用"作者 + 秒级时间"去原始事件里反查。
function buildConvos(journalText, opts = {}) {
  // 🔴 2026-10-06 按用户要求调整上限：
  //    原来是"**总共** 40 条"（`max: 40`）⇒ 一个活跃群就把额度吃光，其它群只剩几条。
  //    现在给**每个会话**留 60 条（`perScope`），总量上限放到 400 兜底。
  const list = convo.parseConversations(journalText, {
    max: opts.max || 400,
    // ⚠️ 这里的 perScope 只能按"作者"分组（此时还不知道群号）⇒ 给**宽**一点当第一道闸；
    //    **真正的"每群 60 条"在下面反查出群号之后再裁**（见 `cap`）。
    perScope: opts.perAuthor || 200,
  });
  const aliases = groupsLoad();
  // 🆕 群号反查：先按"作者+时间"精确匹配，再退回"作者"
  const map = authorTimeMap();
  const order = scopeOrder();

  // 🔴 把已知群号集合拿出来 —— 用来把"猜不到群号"的消息**吸附**到最可能的那个群。
  //    实测场景（用户报的）：同一个群的消息，一部分反查到了群号、另一部分没查到，
  //    结果**分裂成两张卡**（「某个群」+「群 3（未命名）」），用户要求合并。
  //    ⚠️ 判据要窄：只在"一个群号都没认出"时才吸附，而且按作者（作者在哪说过话最有信息量）。
  const knownIds = order;
  const authorKnown = new Map();
  for (const [k, v] of map.byAuthor) if (knownIds.includes(v)) authorKnown.set(whoKey(k), v);

  // 🆕 历史遗留的"合并"别名表：`group:<旧群号>` 可以指向 `group:<目标群号>`。
  //    ⚠️ 2026-10-06 用户要求**把合并功能删掉**（「没必要，那是修代码才导致出现问题，
  //       正常使用应该不会」）⇒ **写入侧已删**，但这里**读取侧保留**：
  //       万一旧数据里登记过 `movedTo`，别让它变成一张认不出的坏卡。
  const scopeAlias = new Map();
  for (const [k, v] of Object.entries(aliases)) {
    if (v && typeof v.movedTo === 'string' && v.movedTo) scopeAlias.set(k, v.movedTo);
  }

  const runs = [];                       // 反查不到时的退回方案（按昵称分段）
  const tagged = list.map((c) => {
    const isPriv = c.kind === 'private';
    let key;
    let groupId = '';
    let n = 0;
    let how = '';

    if (isPriv) {
      // ⚠️ 私聊：事件里**昵称是空的**（实测 `username: ""`）、身份只有 `user_openid`，
      //    而日志里私聊行的昵称是"未知"。⇒ 用**发信人**当键，让同一个人的私聊归到一张卡。
      key = `private:${whoKey(c.who) || 'unknown'}`;
      how = 'private';
    } else {
      // ① 作者 + 时间（带 ±3 秒容差：日志比平台 timestamp 晚约 1 秒）
      //    🔴 2026-10-06：lookup 现在返回 { scopeId, kind }；**顺带用事件类型纠正"私聊/群"** ——
      //    日志行是 [群]/[私聊]，但偶有对不上（更可靠的是原始事件里的 C2C_/GROUP_）。
      const hit = map.lookup(c.who, c.time);
      let found = hit ? hit.scopeId : '';
      if (found) how = 'time';
      if (hit && hit.kind) c.kind = hit.kind;
      // ①' 🆕 2026-10-06：**只看时间的兜底**（作者名是空白时，按昵称永远匹配不上）。
      //     实测：某群友昵称就是 `'\u3000'`（一个全角空格）⇒ 归一化后为空 ⇒ 反查不到群号
      //     ⇒ 那条消息掉成"群 N（未命名）"孤儿卡（用户以为是"出现了一个新群"）。
      if (!found) {
        const h2 = map.lookupByTime(c.time);
        if (h2) { found = h2.scopeId; how = 'time2'; if (h2.kind) c.kind = h2.kind; }
      }
      // ② 退回：只按作者（同一人跨群时会不准）
      if (!found) { found = map.byAuthor.get(whoKey(c.who)) || ''; if (found) how = 'author'; }
      // ③ 🆕 吸附：一个群号都没查到，但这个人**在某个已知群里说过话** ⇒ 归到那个群
      //    （这一条就是"把同一个群分裂出来的两张卡合并"的关键）
      if (!found) { found = authorKnown.get(whoKey(c.who)) || ''; if (found) how = 'attach'; }
      if (found) {
        groupId = found;
        key = `group:${found}`;
        n = Math.max(1, order.indexOf(found) + 1);
      } else {
        // ④ 实在认不出 ⇒ 按昵称分段，群号留空让用户填
        let run = runs.find((r) => r.who === c.who && !r.closed);
        if (!run) { run = { who: c.who, n: runs.length + 1, closed: false }; runs.push(run); }
        n = run.n;
        key = `group:${run.who}#${n}`;
        how = 'none';
      }
    }

    // 🆕 如果这个 scope 被登记过"合并到别处" ⇒ 改写 key（同一个 key = 同一张卡）
    if (scopeAlias.has(key)) key = scopeAlias.get(key);

    // 🆕 真实群内码（那串 32 位）：**只读展示**，不再占输入框。
    //    用户原话：「还要图中这串乱码，算群内码吧，对我来说没啥用，非要写可以固定在
    //    卡片群昵称旁边或者下面独占一行给你当日志用，**那个框框默认空缺拿来填群号**」
    //    ⇒ 输入框留给"你要看的群号"，群内码单独一行只读。
    //    ⚠️ 优先取 key 里的（合并后要显示目标群，而不是旧 id）；
    //       认不出来时退回该卡已登记的 id（给"按昵称分段"那种卡兜底）。
    const mReal = /^group:([0-9A-Fa-f]{16,64})$/.exec(key);
    const realId = mReal ? mReal[1] : ((aliases[key] && aliases[key].id) || '');

    const al = aliases[key] || {};
    const fallbackName = isPriv ? '私聊' : `群 ${n}（未命名）`;
    return {
      kind: c.kind,
      scope: key,
      who: c.who,
      text: c.text,
      time: c.time,
      decision: c.decision,
      replies: c.replies,
      groupName: al.name || fallbackName,   // 读不到真名就是占位符（用户可手改）
      // 卡片顶部那个输入框要填的东西：**用户自己填的可读群号**（默认空）
      groupNo: al.no || '',
      // 只读展示的真实群内码（反查/登记得来，用户不用管）
      realId,
      // 让前端知道"这条的群号有多可信"（weak/none 时提示用户手填）
      guess: how === 'time' ? 'ok' : (how === 'author' ? 'weak' : 'none'),
    };
  });

  // 🔴 2026-10-06：**按真实会话裁剪**（每群/私聊最多 perScope 条）。
  //
  //    为什么必须在这里做：`convo.parseConversations` 的 perScope 只能按"作者"分组
  //    （那时还不知道群号），而一个活跃群有几十个人说话 ⇒ 每人各留几条 ⇒ 加起来几百条
  //    （实测一个群拿了 323 条，用户问的"上限是多少"完全对不上）。
  //
  //    ⚠️ 写法说明（重要）：前面一版我写成"边遍历边数、`if (n <= cap) kept.push`"，
  //       实测**没有生效**（同一作者 5 条 + perScope=2 仍返回 5 条），排查很久没定位到根因。
  //       ⇒ 现在改成**先分组、再每组显式截断**：任何一步都看得见、也能被自测锁住。
  const cap = Math.max(1, Number(opts.perScope) || 60);
  const byScope = new Map();
  for (const c of tagged) {
    if (!byScope.has(c.scope)) byScope.set(c.scope, []);
    byScope.get(c.scope).push(c);
  }
  // ⚠️ 组内**显式按时间倒序**：别依赖上游顺序。
  //    踩过：`byScope` 是"按群收集"的，单看每个群像是新→旧，
  //    但**跨群元素交错**后整体不再是严格时间序（实测第 6/16/26/42/50 处出现"旧的在新的前面"）
  //    ⇒ 用户看到的就是"最上面那条不是最新的"。
  const tsec = (t) => {
    const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(t || ''));
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : -1;
  };
  for (const arr of byScope.values()) arr.sort((a, b) => tsec(b.time) - tsec(a.time));

  // 会话之间：**最近有动静的排最前**
  const scopesByNewest = [...byScope.keys()].sort(
    (a, b) => tsec(byScope.get(b)[0].time) - tsec(byScope.get(a)[0].time)
  );
  // 逐会话取出前 cap 条（组内已是"最新在前"）
  const capped = [];
  for (const k of scopesByNewest) capped.push(...byScope.get(k).slice(0, cap));
  return capped;
}

// 🆕 读请求体（改参数/开关机用）。有上限，防止被塞爆。
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 64 * 1024) { s = ''; req.destroy(); } });
    req.on('end', () => resolve(s));
    req.on('error', () => resolve(''));
  });
}

// ---------- 认证 ----------
// 简单但够用：每次请求都要带对密码（?p=xxx 或 cookie）。
// 不做 session 是为了减少状态；密码走 URL 会被浏览器记住，手机加到桌面很方便。
function authed(req, url) {
  const q = url.searchParams.get('p');
  if (q === PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `lp=${PASSWORD}`);
}

// 🆕 2026-10-06：页面模板已抽到独立模块（原来有两份拷贝，互相覆盖过三次）
const { PAGE } = require('./page');

// ---------- 服务器 ----------
// 🆕 构建标记：用来判断"用户拿到的到底是哪个版本的页面 / 接口"
//    （踩过：改了页面、用户刷新还是老样子，查了很久才发现是浏览器缓存 —— 有了这个戳一眼就能定案）
const BUILD = process.env.LOGWEB_BUILD || '2026-10-06c';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 🆕 访问日志：**只记路径和状态，不记密码**（密码常在 query 里！）
  //    作用：用户说"刷新还是没变"时，能立刻看出他的请求有没有到、到了哪个路由、什么状态码。
  const t0 = Date.now();
  const safePath = url.pathname + (url.searchParams.has('p') ? '?p=***' : '');
  res.on('finish', () => {
    console.log(`[http] ${res.statusCode} ${safePath} ${Date.now() - t0}ms`);
  });

  // GitHub 仓库预览图的中转缓存（公开路由，**故意放在密码校验之前** —— QQ 不会带密码）
  //
  // 为什么需要、怎么验证的、有哪些安全约束，全部写在 tools/ogcache.js 的文件头里。
  // 一句话：官方文档说 markdown 里的图「开放平台会下载转存」，
  //         而 GitHub 的预览图接口**间歇性 429** → QQ 抓那一下失败就永远没图了。
  //         所以让它抓我们，我们抓的时候能重试 + 缓存。
  //
  // ⚠️ 只在配置了对外地址时才启用（没配就是"没这个能力"，直接 404，别留个半成品路由）。
  try {
    const handled = await ogcache.handle(req, res, url.pathname, (m) => console.log(`[ogcache] ${m}`));
    if (handled) return;
  } catch (e) {
    console.log(`[ogcache] 未捕获异常: ${e.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end('ogcache error'); }
    return;
  }

  if (!authed(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('需要密码。用法： http://<你的IP>:8080/?p=你的密码');
    return;
  }

  // 🔴 2026-10-06：认证之后、所有路由之前 —— **统一声明"不要缓存"**。
  //    这个面板的每个响应都是"当场现生"的（余额/日志/对话都在变），缓存它只会让用户看到旧数据。
  //    踩过：页面没有 Cache-Control ⇒ 手机上刷新仍是老版本。
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // 🆕 2026-10-06：**试聊**（用户要的"独立试聊"）。
  //    用途：改人设 / 改判据之后，**在面板上直接试一句**，不用部署、不用群里喊人。
  //
  //    🔴 三条安全设计：
  //      ① **只生成、绝不发送** —— 这里根本不调 qqapi / sendGroupMessage；
  //      ② **不碰线上状态** —— 日志网页是**独立进程**，它的 brain 实例与机器人不共享
  //         冷却表 / 上下文数组（所以试聊不会把机器人"聊热"、也不会占它的额度闸）；
  //      ③ **花钱是真实的**（走同一个 API key）⇒ 日志打 [sandbox] 标记，方便对账，
  //         并在页面/接口上**明确提示"这会产生真实调用"**。
  if (url.pathname === '/api/sandbox' && req.method === 'POST') {
    const body = await readBody(req);
    let text = '';
    try { text = String(JSON.parse(body || '{}').text || '').trim(); } catch { text = ''; }
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, why: '请先输入要试的话' }));
      return;
    }
    if (text.length > 500) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, why: '试聊内容太长（≤500 字）' }));
      return;
    }
    const t0 = Date.now();
    try {
      const brain = require('../brain');
      // 造一条"假的群消息"：scope 用独立的 sandbox，避免与真实会话同名
      const fake = {
        id: 'sandbox-' + Date.now(),
        content: text,
        message_type: 0,
        timestamp: new Date().toISOString(),
        author: { username: '（试聊）', member_openid: 'sandbox', user_openid: 'sandbox' },
        msg_elements: [],
        mentions: [],
      };
      const scope = 'sandbox';
      const isAt = /@/.test(text);           // 打个 @ 就当"被 @ 了"，方便试两种情形
      const gen = await brain.generateReply(scope, fake, '');
      console.log('[sandbox] 试聊一句（' + (Date.now() - t0) + 'ms）');
      const segs = (gen && gen.segments && gen.segments.length) ? gen.segments : [(gen && gen.text) || ''];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        isAt,
        text: (gen && gen.text) || '',
        segments: segs.filter(Boolean),
        ms: Date.now() - t0,
        // ⚠️ 提醒：这是真实调用，会计入账本
        note: '这是真实模型调用（会计入账本），但**不会发到任何群**、也不占机器人的冷却/上下文。',
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, why: '试聊失败：' + (e && e.message ? e.message : String(e)) }));
    }
    return;
  }

  if (url.pathname === '/api/state') {
    const [log, service] = await Promise.all([journalLines(200), serviceState()]);
    const budget = budgetState();
    const power = powerState();
    const events = recentEvents(30);
    // 🆕 对话卡片：日志窗口放大到 1500 行、**每个会话最多 60 条**（2026-10-06 按用户要求提高）
    //    原来只取 400 行 + 总共 40 条 ⇒ 活跃群把额度吃光，别的群只剩几条。
    const convos = buildConvos(await journalLines(1500), { max: 400, perScope: 60 });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      log, service, budget, power, events, convos,
      settings: fillPersonaForPanel(settings.snapshot()),   // 🆕 可改参数（密钥只给掩码；人设框填上当前生效的人设）
      scopeIds: recentScopeIds(),             // 🆕 猜群号用
      build: BUILD,                           // 🆕 版本戳（页头显示，用来确认"是不是新页面"）
    }));
    return;
  }

  // 🆕 改群名/群号（读不到真名时用户手填）
  if (url.pathname === '/api/groups' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const patch = JSON.parse(body || '{}');
      const cur = groupsLoad();
      let n = 0;
      for (const [key, v] of Object.entries(patch.aliases || {})) {
        if (!key || key.length > 120) continue;                 // 长度闸
        const name = String(v?.name || '').slice(0, 40);
        // 🆕 `no` = 用户自己填的**可读群号**（不是那串 32 位群内码；群内码只读、不在这里改）
        const no = String(v?.no || '').slice(0, 32);
        const movedTo = String(v?.movedTo || '').slice(0, 120);
        // ⚠️ 旧字段 `id` 仍然接受（历史数据里有），但 UI 已不再提供输入
        const id = String(v?.id || '').slice(0, 64);
        // ⚠️ 只在"都空"时才删 —— 否则只改群名会把 movedTo 抹掉
        if (!name && !no && !id && !movedTo) { delete cur[key]; n += 1; continue; }
        cur[key] = Object.assign({}, cur[key], {
          ...(name ? { name } : {}),
          ...(no ? { no } : {}),
          ...(id ? { id } : {}),
          ...(movedTo ? { movedTo } : {}),
        });
        n += 1;
      }
      // ⚠️ 2026-10-06：`move`（合并）**已按用户要求删掉** —— 他说「把合并群功能删了吧，
      //    没必要，那是修代码才导致出现问题，正常使用应该不会」。
      //    ⇒ 但**读取侧的 `movedTo` 仍然保留**：万一历史数据里登记过，别让它变成坏卡。
      const r = groupsSave(cur);
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: r.ok, why: r.why, saved: n }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, why: e.message }));
    }
    return;
  }

  // 🆕 改参数（白名单在 settings.js 里；密钥只接受完整重填、永不回显）
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const patch = JSON.parse(body || '{}');
      const r = settings.update(patch);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(Object.assign({}, r, { snapshot: settings.snapshot() })));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, why: e.message }));
    }
    return;
  }

  // 🆕 2026-10-06 用户要的「示范显化 / 可编辑」：语气示范（examples）面板可改。
  //    读：GET /api/examples → { items, fromFile, max }
  //    存：POST /api/examples { items:[{u,a,role?}] } → 写 data/examples.json（校验 + 备份 + 原子写）
  //    恢复默认：POST /api/examples/reset → 删掉那个文件（回落 config.js 里的默认 14 组）
  //    ⚠️ 示范属于 prompt 前缀 ⇒ **改一次缓存失效一次**；页面上有提示。
  if (url.pathname === '/api/examples') {
    const ex = require('../examples');
    if (req.method === 'GET') {
      // 🔴 2026-10-06 修（用户：「没看到示范啊」）：**返回"当前生效的那份"**。
      //    原来没配文件时返回空数组 ⇒ 面板表格一片空白，用户看不到那 14 组，
      //    而"把示范显出来给他改"正是这个功能的全部意义。
      //    ⇒ 没配文件就返回代码里的默认（`cfg.persona.examples` 已经做了这个回落）。
      let items = [];
      try { items = require('../config').persona.examples || []; } catch (e) { items = []; }
      const st = ex.status();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, status: Object.assign({}, st, { items: items }) }));
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      let items = null;
      try { items = JSON.parse(body || '{}').items; } catch { items = null; }
      const r = ex.save(items);
      // 返回的 items 也给"当前生效的那份"（保存后就是刚存进去的）
      let eff = [];
      try { eff = require('../config').persona.examples || []; } catch (e) { eff = []; }
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(Object.assign({ ok: r.ok }, r,
        { status: Object.assign({}, ex.status(), { items: eff }) })));
      return;
    }
  }
  if (url.pathname === '/api/examples/reset' && req.method === 'POST') {
    const ex = require('../examples');
    const r = ex.reset();
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(Object.assign({ ok: r.ok }, r, { status: ex.status() })));
    return;
  }

  // 🆕 2026-10-07 用量趋势（用户要的"用量趋势曲线"）：只读 `data/usage.json`
  //    ⚠️ 写它的是**机器人进程**（只有它知道当天真实用量）；面板**只读**，避免两个进程抢写。
  if (url.pathname === '/api/usage') {
    const n = Number(url.searchParams.get('days')) || 14;
    let days = [];
    try { days = require('../usage').summary(n); } catch (e) { days = []; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, days: days }));
    return;
  }

  // 🆕 开关机（写 data/power.json —— 机器人那边用 mtime 同步，几秒内生效）
  if (url.pathname === '/api/power' && req.method === 'POST') {
    const body = await readBody(req);
    let want = null;
    try { want = JSON.parse(body || '{}').on; } catch { /* ignore */ }
    if (typeof want !== 'boolean') {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, why: 'on 必须是 true/false' }));
      return;
    }
    try {
      const f = path.join(APP_DIR, 'data', 'power.json');
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        on: want, since: Date.now(), by: '网页', savedAt: new Date().toISOString(),
      }, null, 2));
      fs.renameSync(tmp, f);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, on: want, note: '已写入，机器人几秒内跟上（不用重启）' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, why: e.message }));
    }
    return;
  }

  // 🆕 重启主服务（改了 API Key / 模型名这类"启动时才读"的参数后需要）
  if (url.pathname === '/api/restart' && req.method === 'POST') {
    const r = await run('systemctl', ['restart', SERVICE], 15000);
    res.writeHead(r.err ? 500 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: !r.err, why: r.err ? String(r.err.message || r.err) : '' }));
    return;
  }

  // 精简摘要：给命令行排查用（不用在 shell 里拼 JSON 解析）
  if (url.pathname === '/api/summary') {
    const [log, service] = await Promise.all([journalLines(50), serviceState()]);
    const b = budgetState();
    const p = powerState();
    const events = recentEvents(10);
    const last = events[events.length - 1];
    const lines = [
      `服务状态 : ${service}`,
      `开关状态 : ${p.on ? '⏻ 开机' : '⏻ 【关机】—— 不回话、不解析链接、不识别图片'}`
        + (p.on ? '' : `（${p.by ? `由 ${p.by} ` : ''}设置 · 恢复：群里 @我说「开机」）`),
      `今日花费 : ¥${(b?.daySpent ?? 0).toFixed(4)} / ¥${b?.dailyLimit ?? '?'}   （剩 ¥${(b?.dayLeft ?? 0).toFixed(4)}）`,
      // ⚠️ 用户要求**尾巴上不要标注来源** ⇒ 只给数字；但**上限要留**
      //    （我一开始把上限一起删了，用户立刻发现）。
      // 🔴 2026-10-06：**"锚点/官方口径"已按用户要求整块删掉**（「不需要那个锚点，我自己看，删掉」）
      //    ⇒ "累计已花"就用**本地账本**的值，尾巴上也**不再提任何口径说明**。
      `累计已花 : ¥${(b?.spentYuan ?? 0).toFixed(4)} / ¥${b?.totalLimit ?? '?'}`,
      `调用次数 : 今日 ${b?.dayCalls ?? 0} / ${b?.dailyCallLimit ?? '?'}　（终身累计 ${b?.calls ?? 0}）`,
      `最近事件 : ${events.length} 条`,
      last ? `最新一条 : ${last.time} ${last.who} -> ${(last.text || '').slice(0, 40)}` : '最新一条 : （无）',
      `日志行数 : ${log.split('\n').length}`,
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(lines.join('\n') + '\n');
    return;
  }

  // 最近 N 行日志的纯文本版（手机上想快速看就用它）
  if (url.pathname === '/api/log') {
    const n = Math.min(2000, Math.max(10, Number(url.searchParams.get('n')) || 200));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(await journalLines(n));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // 🔴 2026-10-06：**必须禁止缓存**。
    //    原因：页面原本没有 Cache-Control ⇒ 浏览器（尤其手机"加到主屏幕"那种）会缓存旧页面，
    //    用户刷新仍然看到**老版本**（症状："我改完了，他怎么还是老样子"）。
    //    ⚠️ 这个页面每一次都该是"当场现生"的（数据都在里面），缓存它没有任何收益。
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    // 🆕 2026-10-06：分页面（概览/对话/设置/日志）—— 用 ?page= 选，缺省概览
    const wantPage = String(url.searchParams.get('page') || 'overview');
    const ALLOWED = ['overview', 'chat', 'settings', 'raw'];
    res.end(PAGE({
      pwd: url.searchParams.get('p') || '',
      page: ALLOWED.includes(wantPage) ? wantPage : 'overview',
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[logweb] 已启动，监听 0.0.0.0:${PORT}`);
  console.log(`[logweb] 手机访问： http://<服务器公网IP>:${PORT}/?p=<密码>`);
  console.log(`[logweb] 看的是 ${SERVICE} 服务的日志；数据目录 ${path.join(APP_DIR, 'data')}`);
});
