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

function budgetState() {
  try {
    const f = path.join(APP_DIR, 'data', 'budget.json');
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));

    // 上限优先取文件里保存的；旧文件没有就用 .env / 环境变量兜底，最后给个默认值。
    // （budget.json 早期版本只存花费不存上限，兼容一下）
    const envDaily = Number(process.env.BUDGET_DAILY_YUAN) || 3;
    const envTotal = Number(process.env.BUDGET_TOTAL_YUAN) || 10;
    const dl = Number(j.dailyLimit) || envDaily;
    const tl = Number(j.totalLimit) || envTotal;
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
      dailyCallLimit: Number(j.dailyCallLimit) || 1600,   // 🆕 上限，用来显示"今日 N / 上限"
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
          scopeId: d.group_openid || d.group_id || d.author?.member_openid || '',
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

function authorTimeMap() {
  const byTime = new Map();     // `${who}@${HH:MM:SS}` -> scopeId
  const byAuthor = new Map();
  for (const e of recentEvents(3000)) {
    if (!e.who || !e.scopeId) continue;
    if (e.time) byTime.set(`${e.who}@${e.time}`, e.scopeId);
    byAuthor.set(e.who, e.scopeId);      // 后来者覆盖 = 最近优先（仅作兜底）
  }
  // 每个作者的时间键：排序 + 带秒数，供"容差查找"用
  const sorted = new Map();
  for (const [key, scopeId] of byTime) {
    const at = key.lastIndexOf('@');
    const who = key.slice(0, at);
    const sec = toSec(key.slice(at + 1));
    if (sec === null) continue;
    if (!sorted.has(who)) sorted.set(who, []);
    sorted.get(who).push({ sec, scopeId });
  }
  for (const arr of sorted.values()) arr.sort((a, b) => a.sec - b.sec);

  return {
    byTime,
    byAuthor,
    /** 容差查找：这个作者、这个时间 ±N 秒 的群号；找不到返回 '' */
    lookup(who, time) {
      const sec = toSec(time);
      if (sec === null) return '';
      const arr = sorted.get(who);
      if (!arr || !arr.length) return '';
      // 二分定位到 <= sec 的最后一项，再左右扫一小段
      let lo = 0; let hi = arr.length - 1; let pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].sec <= sec) { pos = mid; lo = mid + 1; } else hi = mid - 1;
      }
      let best = ''; let bestGap = 1e9;
      for (let i = Math.max(0, pos - 6); i < Math.min(arr.length, pos + 7); i++) {
        const gap = Math.abs(arr[i].sec - sec);
        if (gap <= TIME_TOLERANCE_SEC && gap < bestGap) { bestGap = gap; best = arr[i].scopeId; }
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
  for (const [k, v] of map.byAuthor) if (knownIds.includes(v)) authorKnown.set(k, v);

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
      key = `private:${c.who}`;
      how = 'private';
    } else {
      // ① 作者 + 时间（带 ±3 秒容差：日志比平台 timestamp 晚约 1 秒）
      let found = map.lookup(c.who, c.time);
      if (found) how = 'time';
      // ② 退回：只按作者（同一人跨群时会不准）
      if (!found) { found = map.byAuthor.get(c.who) || ''; if (found) how = 'author'; }
      // ③ 🆕 吸附：一个群号都没查到，但这个人**在某个已知群里说过话** ⇒ 归到那个群
      //    （这一条就是"把同一个群分裂出来的两张卡合并"的关键）
      if (!found) { found = authorKnown.get(c.who) || ''; if (found) how = 'attach'; }
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

const PAGE = (pwd) => `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1220">
<title>🐋 大肥鱼 · 控制台</title>
<!-- BUILD:__BUILD__ -->
<style>
  :root { color-scheme: dark; --bg:#0b1220; --card:#111a2e; --line:#1f2b45;
          --dim:#8ea0bb; --txt:#e6edf7; --ok:#10b981; --bad:#ef4444; --warn:#f59e0b; --link:#60a5fa; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; background:var(--bg); color:var(--txt);
         font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:16px; margin:0; font-weight:700; letter-spacing:.02em; }
  h2 { font-size:15px; color:#eaf1ff; margin:0 0 10px; font-weight:700; letter-spacing:.02em;
       display:flex; align-items:center; gap:8px; }
  h2::before { content:''; width:4px; height:16px; border-radius:2px;
       background:linear-gradient(180deg,#60a5fa,#2563eb); }
  header { position:sticky; top:0; z-index:20; background:rgba(11,18,32,.92); backdrop-filter:blur(8px);
           border-bottom:1px solid var(--line); padding:10px 14px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  main { padding:14px 12px 76px; max-width:900px; margin:0 auto; }
  section { margin-bottom:18px; }
  .pill { font-size:11px; padding:3px 9px; border-radius:999px; background:var(--card); color:var(--dim); border:1px solid var(--line); }
  .pill.on { background:rgba(16,185,129,.16); color:#6ee7b7; border-color:rgba(16,185,129,.4); }
  .pill.off { background:rgba(239,68,68,.16); color:#fca5a5; border-color:rgba(239,68,68,.4); }
  .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  @media (min-width:620px) { .grid { grid-template-columns:repeat(4,minmax(0,1fr)); } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px; }
  .card b { color:#fff; font-size:18px; display:block; font-variant-numeric:tabular-nums; }
  .card span { color:var(--dim); font-size:11px; }
  .warn { color:var(--warn); }
  #errbar { display:none; background:#7c2d12; color:#fed7aa; padding:10px 14px;
            font-size:12.5px; word-break:break-all; }
  #offbar { display:none; background:linear-gradient(90deg,#7f1d1d,#991b1b); color:#fff;
            padding:10px 14px; font-size:13px; position:sticky; top:0; z-index:19; }

  /* 🆕 一个群 = 一张卡（可收起/展开，跟"原始日志"一个交互） */
  .gcard { background:var(--card); border:1px solid var(--line); border-radius:12px;
           margin-bottom:12px; overflow:hidden; }
  .gcard > summary { padding:10px 12px; background:#0e1729; cursor:pointer;
           display:flex; gap:8px; align-items:center; flex-wrap:wrap; list-style:none; }
  .gcard > summary::-webkit-details-marker { display:none; }
  .gcard > summary::before { content:'▸'; color:#93c5fd; font-size:17px; font-weight:700;
       width:22px; text-align:center; flex:0 0 auto; transition:transform .15s; }
  .gcard[open] > summary::before { transform:rotate(90deg); }
  .gtitle { font-weight:700; color:#c7d2fe; font-size:14.5px; }
  .gid { color:var(--dim); font-size:11px; word-break:break-all; }
  .cnt { color:var(--dim); font-size:11px; margin-left:auto; }
  .gedit { display:flex; gap:6px; flex-wrap:wrap; padding:8px 12px; background:#0e1729;
           border-bottom:1px solid var(--line); }
  .gedit input { flex:1; min-width:120px; }
  .gcode { padding:0 12px 8px; color:var(--dim); font-size:10.5px; word-break:break-all;
           font-family:ui-monospace,Menlo,Consolas,monospace; }
  .msgs { padding:4px 12px 10px; }
  .msg { padding:8px 0; border-bottom:1px dashed var(--line); }
  .msg:last-child { border-bottom:0; }
  .mtop { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .who { font-weight:700; color:#fbbf24; }
  .tm { color:var(--dim); font-size:11px; margin-left:auto; font-variant-numeric:tabular-nums; }
  .txt { color:var(--txt); word-break:break-word; }
  .tag { display:inline-block; font-size:11px; padding:1px 7px; border-radius:6px;
         background:#1e293b; color:var(--dim); margin-right:6px; }
  .tag.no { background:rgba(148,163,184,.15); }
  .tag.yes { background:rgba(16,185,129,.18); color:#6ee7b7; }
  .dec { margin-top:3px; color:var(--dim); font-size:12.5px; }
  .ans { background:#0d1729; border-left:3px solid var(--ok); padding:7px 10px;
         border-radius:0 8px 8px 0; margin:6px 0 2px; color:#d1fae5; }
  input[type=text], input[type=number], input[type=password] { font:inherit; color:var(--txt);
         background:#0d1729; border:1px solid var(--line); border-radius:8px; padding:7px 9px; min-width:0; }
  input:focus { outline:1px solid var(--link); }
  button { font:inherit; color:var(--txt); background:#1e293b; border:1px solid #334155;
           border-radius:9px; padding:8px 12px; cursor:pointer; }
  button:active { transform:translateY(1px); }
  button.primary { background:#1d4ed8; border-color:#2563eb; }
  button.danger { background:#7f1d1d; border-color:#b91c1c; }
  button.sm { padding:6px 9px; font-size:12px; }
  details { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px 12px; }
  summary { cursor:pointer; font-weight:700; color:var(--dim); font-size:13px; }
  .frow { display:flex; gap:8px; align-items:center; margin:8px 0; flex-wrap:wrap; }
  .frow label { width:150px; color:var(--dim); font-size:12px; }
  .frow input { flex:1; min-width:120px; }
  .hint { color:var(--dim); font-size:11px; margin:4px 0 0; }
  pre { margin:0; padding:10px; background:#080e1a; border:1px solid var(--line); border-radius:10px;
        overflow:auto; max-height:340px; font-size:11.5px; line-height:1.55; color:#9fb3d1; }
  footer { position:fixed; left:0; right:0; bottom:0; background:rgba(11,18,32,.95);
           backdrop-filter:blur(8px); border-top:1px solid var(--line); padding:9px 12px;
           display:flex; gap:8px; max-width:900px; margin:0 auto; }
  footer .sp { flex:1; }
  #toast { position:fixed; left:50%; bottom:74px; transform:translateX(-50%); background:#111a2e;
           border:1px solid var(--line); color:var(--txt); padding:9px 14px; border-radius:999px;
           font-size:12.5px; display:none; z-index:50; max-width:92vw; }
</style></head>
<body>
<header>
  <h1>🐋 大肥鱼</h1>
  <span id="svc" class="pill">…</span>
  <span id="build" class="pill" style="background:#1e3a8a;color:#bfdbfe">v?</span>
  <span id="upd" class="pill">…</span>
</header>
<div id="offbar"></div>
<div id="errbar"></div>
<main>
  <section>
    <h2>额度与用量</h2>
    <div class="grid" id="budget"></div>
  </section>

  <section>
    <h2>开关机</h2>
    <div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <b id="pwstate" style="font-size:15px">…</b>
      <span id="pwby" style="color:var(--dim);font-size:12px"></span>
      <span style="flex:1"></span>
      <button class="primary sm" onclick="setPower(true)">开机</button>
      <button class="danger sm" onclick="setPower(false)">关机</button>
    </div>
    <p class="hint">关机后：不回话、不解析链接、不识别图片（一分钱不花）。改完几秒内生效，不用重启。</p>
  </section>

  <details>
    <summary>⚙️ 参数设置（点开修改）</summary>
    <div id="settings"></div>
    <div class="frow" style="margin-top:10px">
      <button onclick="restartBot()">重启机器人</button>
      <span class="hint" style="margin:0">（每个参数改完点它自己的「保存」）</span>
    </div>
    <p class="hint">额度/次数上限：保存后立即生效。<b>AI 密钥</b>：保存后需要点一次「重启机器人」才生效。密钥不会回显，只显示前后几位。</p>
  </details>

  <section>
    <h2>对话</h2>
    <div id="convos"></div>
  </section>

  <details>
    <summary>🔍 原始日志（排查用，平时不用看）</summary>
    <div style="margin-top:8px"><pre id="log">加载中…</pre></div>
  </details>
</main>
<footer>
  <button onclick="load(true)">刷新</button>
  <button id="autoBtn" onclick="toggleAuto()">自动刷新 5s</button>
  <span class="sp"></span>
  <button onclick="toggleRaw()">原始日志</button>
</footer>
<div id="toast"></div>
<script>
const P = ${JSON.stringify(pwd)};

// 🔴 最重要的一段（2026-10-06 加）：**任何脚本错误都要看得见**。
//    之前踩的坑：页面脚本在"发第一个请求之前"就静默崩了 ⇒ 页面只剩一堆空占位，
//    错误只在控制台里（用户看不到），我连查三轮都没定位。
try { window.addEventListener('error', function(ev){
  try {
    var e = document.getElementById('errbar');
    if (e) {
      e.style.display = 'block';
      e.textContent = '⚠️ 脚本错误：' + (ev.message || ev.error) +
        '（' + (ev.filename || '').split('/').pop() + ':' + (ev.lineno || '?') + '）';
    }
  } catch (_) {}
});
} catch (_) {}   // ⚠️ 挂监听本身也要防错（否则会复现"脚本起步即崩"）
try { window.addEventListener('unhandledrejection', function(ev){
  try {
    var e = document.getElementById('errbar');
    if (e) {
      e.style.display = 'block';
      e.textContent = '⚠️ 请求出错：' + ((ev.reason && (ev.reason.message || ev.reason)) || '未知');
    }
  } catch (_) {}
});
} catch (_) {}
document.cookie = 'lp=' + encodeURIComponent(P) + ';path=/;max-age=31536000';
let auto = null;

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function yuan(v){ return '\\u00a5' + (Number(v)||0).toFixed(4); }
function toast(msg, ms){
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._t); t._t = setTimeout(()=>{ t.style.display='none'; }, ms || 2600);
}
function toggleRaw(){ const d = document.querySelectorAll('main > details'); if (d.length) { const last = d[d.length-1]; last.open = !last.open; } }

function showErr(msg){
  const e = document.getElementById('errbar');
  if (!e) return;
  if (!msg) { e.style.display = 'none'; return; }
  e.style.display = 'block';
  e.textContent = '⚠️ ' + msg;
}
function mark(id, txt){ const el = document.getElementById(id); if (el) el.textContent = txt; }

async function load(manual){
  // ⚠️ 这里**故意不调用 mark/showErr** —— 直接操作 DOM。
  //    原因：万一辅助函数有问题，会导致"load 第一行就抛错、连请求都发不出去"（真实踩过）。
  const _upd = document.getElementById('upd');
  const _build = document.getElementById('build');
  const _err = document.getElementById('errbar');
  const setErr = (m) => { if (_err) { _err.style.display = m ? 'block' : 'none'; if (m) _err.textContent = '⚠️ ' + m; } };
  setErr('');
  if (_upd) _upd.textContent = '加载中…';
  if (_build) _build.textContent = 'v…';
  try {
    const r = await fetch('/api/state?p=' + encodeURIComponent(P));
    if (!r.ok) throw new Error('服务器返回 ' + r.status + (r.status === 401 ? '（密码不对或 cookie 过期）' : ''));
    const j = await r.json();

    const svc = document.getElementById('svc');
    svc.textContent = (j.service === 'active' ? '运行中' : j.service);
    svc.className = 'pill ' + (j.service === 'active' ? 'on' : 'off');

    const off = document.getElementById('offbar');
    const pw = j.power || {};
    if (!pw.on) {
      off.style.display = 'block';
      off.textContent = '⏻ 已关机：不回话、不解析链接、不识别图片'
        + (pw.by ? '（由 ' + pw.by + ' 设置）' : '') + '　点下面的「开机」恢复';
    } else off.style.display = 'none';
    document.getElementById('pwstate').textContent = pw.on ? '⏻ 运行中' : '⏻ 已关机';
    document.getElementById('pwstate').className = pw.on ? '' : 'warn';

    // 每一步单独兜底 —— 某一块出错不该让整页变成空白（之前就是这样，还只弹了个会消失的提示）
    try { renderBudget(j.budget); } catch (e) { setErr('额度渲染失败：' + e.message); }
    try { renderSettings(j.settings); } catch (e) { setErr('设置渲染失败：' + e.message); }
    try { renderGroups(j.convos); } catch (e) { setErr('对话渲染失败：' + e.message); }
    try { document.getElementById('log').textContent = j.log || '(空)'; } catch (e) {}
    if (_build) _build.textContent = 'v' + (j.build || '?');
    const n = (j.convos || []).length;
    if (_upd) _upd.textContent = '更新 ' + new Date().toLocaleTimeString('zh-CN') + (n ? '' : '（0 条对话）');
  } catch (err) {
    setErr('取数据失败：' + err.message);
    if (_upd) _upd.textContent = '失败';
    toast('取数据失败：' + err.message);
  }
}

function renderBudget(b){
  const el = document.getElementById('budget');
  if (!b) { el.innerHTML = '<div class="card"><span>暂无花费数据</span></div>'; return; }
  const spent = (b.official && b.official.spent != null) ? b.official.spent : b.spentYuan;
  el.innerHTML =
    card(yuan(b.daySpent), '今日已花 / 上限 ' + yuan(b.dailyLimit)) +
    card(yuan(spent), '累计已花 / 上限 ' + yuan(b.totalLimit)) +
    card((b.dayCalls||0), '今日调用 / 上限 ' + (b.dailyCallLimit||'?') + ' 次') +
    card(b.dayLeft==null?'—':yuan(b.dayLeft), '今日剩余', (b.dayLeft!=null && b.dayLeft<1));
}
function card(big, small, warn){
  return '<div class="card"><b class="' + (warn?'warn':'') + '">' + big + '</b><span>' + small + '</span></div>';
}

function renderSettings(s){
  const el = document.getElementById('settings');
  if (!s || !Object.keys(s).length) { el.innerHTML = '<p class="hint">没有可改的参数（settings.snapshot() 返回空）</p>'; return; }
  const order = ['aiApiKey','budgetDaily','budgetTotal','budgetAnchor','dailyCalls'];
  const rows = order.filter(k => s[k]).map(k => {
    const it = s[k];
    const val = it.value == null ? '' : it.value;
    const id = 'set_' + k;
    return '<div class="frow"><label for="' + id + '">' + esc(it.label) + '</label>' +
      '<input id="' + id + '" data-key="' + k + '" ' +
      (it.secret ? 'type="password" placeholder="留空=不改；粘贴新的会覆盖" value=""' :
        'type="number" step="0.01" value="' + esc(val) + '"') +
      '<button class="sm" onclick="saveOne(' + "'" + k + "'" + ')">保存</button></div>';
  }).join('');
  el.innerHTML = rows + (s.aiApiKey ? '<p class="hint">当前密钥：' + esc(s.aiApiKey.value || '（未设置）') + '</p>' : '');
}

async function saveOne(key){
  const inp = document.querySelector('#settings input[data-key="' + key + '"]');
  if (!inp) return;
  const v = (inp.value || '').trim();
  const patch = {};
  if (v) patch[key] = v;
  if (!Object.keys(patch).length) { toast('这个参数没改（空 = 不改）'); return; }
  const r = await fetch('/api/settings?p=' + encodeURIComponent(P), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch),
  });
  const j = await r.json();
  if (!j.ok) { toast('❌ ' + (j.why||'保存失败')); return; }
  toast('✅ 已保存' + (j.needRestart ? '（密钥需点「重启机器人」才生效）' : '（立即生效）'));
  load(true);
}

async function saveSettings(){
  const patch = {};
  for (const inp of document.querySelectorAll('#settings input[data-key]')) {
    const k = inp.dataset.key;
    const v = (inp.value || '').trim();
    if (!v) continue;
    patch[k] = v;
  }
  if (!Object.keys(patch).length) { toast('没有要改的内容'); return; }
  const r = await fetch('/api/settings?p=' + encodeURIComponent(P), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch),
  });
  const j = await r.json();
  if (!j.ok) { toast('❌ ' + (j.why||'保存失败')); return; }
  toast('✅ 已保存' + (j.needRestart ? '（密钥需点「重启机器人」才生效）' : '（立即生效）'));
  load(true);
}

async function restartBot(){
  if (!confirm('现在重启机器人？大约 5 秒内恢复，期间不回复消息。')) return;
  toast('正在重启…');
  const r = await fetch('/api/restart?p=' + encodeURIComponent(P), { method:'POST' });
  const j = await r.json();
  toast(j.ok ? '✅ 已发出重启' : ('❌ ' + (j.why||'重启失败')));
  setTimeout(()=>load(true), 4000);
}

async function setPower(on){
  const r = await fetch('/api/power?p=' + encodeURIComponent(P), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({on}),
  });
  const j = await r.json();
  toast(j.ok ? ('✅ 已' + (on?'开机':'关机') + '（几秒内生效）') : ('❌ ' + (j.why||'失败')));
  setTimeout(()=>load(true), 2500);
}

// 🔴 一个会话（群/私聊）= 一张卡：群信息只出现一次（卡片顶部），下面是这个群的所有消息。
//    （用户 2026-10-05 纠正：每条消息各带一个编辑框"很奇怪而且占地方"。）
function renderGroups(list){
  const el = document.getElementById('convos');
  if (!list || !list.length) { el.innerHTML = '<div class="card"><span>最近没有对话（日志里没解析到 [群]/[私聊] 行）</span></div>'; return; }

  // 按 scope 归组，保持"最先出现的会话排最前"（跟列表顺序一致 = 时间倒序）
  const groups = [];
  const idx = new Map();
  for (const c of list) {
    let g = idx.get(c.scope);
    if (!g) {
      g = { scope:c.scope, kind:c.kind, name:c.groupName,
            groupNo:c.groupNo || '', realId:c.realId || '', msgs:[] };
      idx.set(c.scope, g); groups.push(g);
    }
    g.msgs.push(c);
  }

  el.innerHTML = groups.map((g, gi) => {
    const isPriv = g.kind === 'private';
    const nameVal = /未命名/.test(g.name || '') ? '' : (g.name || '');
    // 卡片标题栏 + 编辑区，塞进 summary 里（点击标题就能收起/展开，跟"原始日志"一个交互）
    const sum = '<summary>' +
        '<span class="gtitle">' + esc(g.name || '未命名') + '</span>' +
        '<span class="tag">' + (isPriv ? '私聊' : '群') + '</span>' +
        '<span class="cnt">' + g.msgs.length + ' 条（每群最多 60）</span>' +
      '</summary>';
    // ⚠️ 编辑框放在 summary **外面** —— 否则点输入框会连带收起卡片
    // ① 群内码：**只读**（用户说"那串乱码对我没啥用，非要写就固定在群昵称旁边或下面独占一行"）
    // ② 输入框：默认空缺，**专门用来填你要看的群号**
    const edit = '<div class="gedit">' +
        '<input type="text" placeholder="' + (isPriv ? '备注名（可手改）' : '群名（可手改）') + '" value="' + esc(nameVal) + '" data-g="' + gi + '" data-f="name">' +
        '<input type="text" placeholder="群号（自己填，方便你认）" value="' + esc(g.groupNo || '') + '" data-g="' + gi + '" data-f="no">' +
        '<button class="sm" onclick="saveGroup(' + gi + ')">保存</button>' +
      '</div>' +
      (isPriv ? '' : '<div class="gcode">群内码 ' + esc(g.realId || '（认不出）') + '</div>');

    // 🔴 卡内排序（2026-10-06 用户要求反过来）：
    //    原话「**卡片内消息排序方式从上到下是从早到晚，但是这样每次刷新消息都会出现在卡片最下面了，
    //    要去翻，不合理，排序反一下**」⇒ 现在**最新在上**（后端已按此顺序给，直接用不 reverse）。
    //    ⚠️ 每会话 60 条的上限已在**后端按真实群号裁好**，这里不再截断（避免"上面写 60、实际 40"）。
    const msgs = g.msgs.map((c) => {
      const q = '<div class="mtop"><span class="who">' + esc(c.who) + '</span>' +
        '<span class="tm">' + esc(c.time || '') + '</span></div>' +
        '<div class="txt">' + (esc(c.text) || '<span style="color:var(--dim)">（非文字消息）</span>') + '</div>';
      let dec = '';
      if (c.decision) {
        const isNo = /^不回/.test(c.decision);
        dec = '<div class="dec"><span class="tag ' + (isNo?'no':'yes') + '">' + (isNo?'没回':'回了') + '</span>' + esc(c.decision) + '</div>';
      } else if (!(c.replies && c.replies.length)) {
        dec = '<div class="dec"><span class="tag no">没回</span>（没触发回复条件）</div>';
      }
      const ans = (c.replies && c.replies.length)
        ? c.replies.map(t => '<div class="ans">' + esc(t) + '</div>').join('') : '';
      return '<div class="msg">' + q + dec + ans + '</div>';
    }).join('');

    return '<details class="gcard" open>' + sum + edit + '<div class="msgs">' + msgs + '</div></details>';
  }).join('');

  // 把分组结果挂到 window 上，保存时按索引取
  window.__groups = groups;
}

async function saveGroup(gi){
  const g = (window.__groups || [])[gi];
  if (!g) return;
  const wrap = document.querySelectorAll('.gcard')[gi];
  if (!wrap) return;
  const name = (wrap.querySelector('input[data-f=name]').value || '').trim();
  const no = (wrap.querySelector('input[data-f=no]').value || '').trim();
  const aliases = {};
  aliases[g.scope] = { name, no };
  const r = await fetch('/api/groups?p=' + encodeURIComponent(P), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({aliases}),
  });
  const j = await r.json();
  toast(j.ok ? '✅ 已保存' : ('❌ ' + (j.why||'保存失败')));
  if (j.ok) load(true);
}

function toggleAuto(){
  if (auto) { clearInterval(auto); auto = null; document.getElementById('autoBtn').textContent = '自动刷新 5s'; }
  else { auto = setInterval(()=>load(false), 5000); document.getElementById('autoBtn').textContent = '停止自动刷新'; }
}
try { load(true); } catch (e) {
  var _e2 = document.getElementById('errbar');
  if (_e2) { _e2.style.display = 'block'; _e2.textContent = '⚠️ 启动失败：' + e.message; }
}
</script>
</body></html>`;

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
      settings: settings.snapshot(),          // 🆕 可改参数（密钥只给掩码）
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
      //    "官方口径还没配锚点"这件事只在这个**排查用的**摘要端点里说明。
      `累计已花 : ¥${(b?.official && b.official.spent != null
        ? Number(b.official.spent)
        : (b?.spentYuan ?? 0)).toFixed(4)} / ¥${b?.totalLimit ?? '?'}`
        + (b?.official && b.official.spent != null ? '' : '   （官方口径：配 BUDGET_ANCHOR_YUAN 后自动切换）'),
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
    res.end(PAGE(url.searchParams.get('p') || ''));
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
