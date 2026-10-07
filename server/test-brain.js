// ============================================================
//  自测：验证审查报告里那几个坑真的修好了
//  跑法： node test-brain.js
//  它不发任何网络请求，只测纯逻辑
// ============================================================

// ⚠️ 两条确定性保障，缺一不可（都踩过坑）：
//    ① 不碰真实预算文件 —— 否则测试会污染 data/budget.json，且结果依赖运行状态
//    ② 全程固定 Math.random —— 否则 5% 抽样会随机放行，导致"这次过下次挂"
process.env.XLJ_NO_PERSIST = '1';

const FIXED_RANDOM_MISS = 0.99;   // 落在 8% 抽样之外 → 抽样永远拒绝
const FIXED_RANDOM_HIT = 0.01;    // 落在 8% 抽样之内 → 抽样永远放行
const REAL_RANDOM = Math.random;  // 留一份真的，测"随机性"时要用
Math.random = () => FIXED_RANDOM_MISS;

const brain = require('./brain');
const cfg = require('./config');

// ⚠️ 第三条确定性保障：**默认关掉 @ 专属限流**（2026-10-01 新增）
//
// 为什么：旧的那些测试会**连续**用"同一个人 @ 机器人"的方式验证别的规则
// （@ 跳过 minLength、@ 覆盖冷却…）。而新的 @ 限流是有状态的
// （同一人 10 秒内只放行一次）→ 于是**第二条 @ 测试必然被自己的限流挡掉**。
// 这不是 bug，是"新规则把旧测试打红了"（坑 93 的同类）。
// 处理办法：旧测试统一关掉它（它们测的是**别的**规则），
// 新闸由第 24 组**显式打开**来专门测（含边界：冷却 / 窗口配额 / 主人免闸 / 不 @ 不受影响）。
if (cfg.policy.atLimits) cfg.policy.atLimits.enabled = false;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

function beijingHourNow() {
  const d = new Date(Date.now() + d.getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  return d;
}
function isQuietNow() {
  // ⚠️ 静默时段被关掉时（config 的 quietHoursEnabled: false）永远返回 false。
  //    不这么做的话，半夜跑自测会"跳过若干项"，通过数从 153 变成 151 —— 看着像坏了。
  if (cfg.policy.quietHoursEnabled === false) return false;
  const d = new Date(Date.now() + new Date().getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  const h = d.getHours();
  const [a, b] = cfg.policy.quietHours;
  return a <= b ? (h >= a && h < b) : (h >= a || h < b);
}

// 造一条官方格式的群消息事件
// ⚠️ id 用官方示例的真实形态（ROBOT1.0_ 开头）——故意如此，
//    用来证明"靠 msg_id 前缀判断机器人"是错的（那会把所有群友都屏蔽掉）
let seq = 0;
function groupMsg({ type = 'GROUP_MESSAGE_CREATE', content = '', message_type = 0, mentions = [], bot = false } = {}) {
  seq += 1;
  return [type, {
    id: 'ROBOT1.0_' + String(seq).padStart(4, '0') + 'fakeMessageIdForTest',
    author: { member_openid: 'OPENID_A', username: '小明', bot },
    content,
    group_openid: 'GROUP_X',
    message_type,
    mentions,
  }];
}

console.log('\n=== 1. P0-1 isAt：@ 必须被认出来 ===');
// 官方事实：被 @ 时 mentions 不含机器人自己，且 content 已剥掉 @前缀
{
  const [type, d] = groupMsg({ type: 'GROUP_AT_MESSAGE_CREATE', content: '在吗', mentions: [] });
  const r = brain.passHardRules('group:G', d, type, false);
  check('@ 机器人 + mentions 为空 → 通过 L0（旧代码会走 5% 抽样）', r.ok === true, JSON.stringify(r));
  check('  └ 且 isAt=true', r.isAt === true);
}
{
  const [type, d] = groupMsg({ type: 'GROUP_AT_MESSAGE_CREATE', content: '在吗', mentions: [] });
  const r = brain.passHardRules('group:G', d, type, false);
  check('@ 时跳过 minLength（"在吗"只有 2 字也该通过）', r.ok === true, JSON.stringify(r));
}
{
  // 普通消息、不 @、内容短 → 应该被长度挡住
  const [type, d] = groupMsg({ content: '在吗' });
  const r = brain.passHardRules('group:G', d, type, false);
  check('不 @ 的 2 字短消息 → 被"太短"挡住', r.ok === false && /太短/.test(r.why), JSON.stringify(r));
}

console.log('\n=== 1b. ⭐ 真机实测：@ 消息来的是全量事件（2026-09 线上抓到的原样数据）===');
// 这一段是用服务器上 events-*.jsonl 里的真实事件抄下来的，别改结构
{
  const realEvent = {
    id: 'ROBOT1.0_4WnDXzC0HI-w3MCyft6BLX0fy.t1hSleD7WOsFQtFcT1xoLYpa7EULPfbdv5rRbVsOCBhaowDqhYWE6tkwODj1AGfXdDe0a6ExHGtyBnfIzP1NcQ0u7N5n5m0zGYj',
    author: {
      bot: false, id: 'OWNER0PEN1D0000000000000000000000',
      member_openid: 'OWNER0PEN1D0000000000000000000000',
      member_role: 'owner', union_openid: '', username: '群主',
    },
    content: '<@BOT0PEN1D000000000000000000000000> 你好',
    group_openid: '2199B529E16C8DED77B3342EB2BD4CEC',
    message_type: 0,
    mentions: [{ bot: true, id: 'BOT0PEN1D000000000000000000000000', is_you: true, member_openid: 'BOT0PEN1D000000000000000000000000' }],
    timestamp: '2026-09-14T17:01:46+08:00',
  };

  // 关键：真机上@机器人时，事件名是 GROUP_MESSAGE_CREATE 而不是 GROUP_AT_MESSAGE_CREATE
  const r = brain.passHardRules('group:G', realEvent, 'GROUP_MESSAGE_CREATE', false);
  check('全量事件里的 @ → 也必须认出 isAt（事件名不可靠）', r.isAt === true, JSON.stringify(r));
  check('  └ 且通过 L0，不进 5% 抽样', r.ok === true, JSON.stringify(r));

  // ⭐ 被 @ 必须绕过冷却和连续上限
  // （否则：@ 它一次 → 回 → 之后 60 秒内再 @ 一律装死，调试时几乎没法验证）
  {
    const quiet = isQuietNow();
    if (quiet) {
      console.log('  ⚠️ 现在是北京时间静默时段，跳过"@ 绕过冷却"检查');
    } else {
      const scope = 'group:AT_BYPASS';
      // 先把它标记成"刚回复过"，制造冷却状态
      brain.markReplied(scope, realEvent.author.member_openid);
      const r2 = brain.passHardRules(scope, realEvent, 'GROUP_MESSAGE_CREATE', false);
      check('被 @ 时绕过 60 秒冷却（刚回过也能再回）', r2.ok === true, JSON.stringify(r2));

      // 反向验证：不 @ 的普通消息仍应被冷却拦住
      const plain = { ...realEvent, content: '大家好啊今天', mentions: [] };
      const r3 = brain.passHardRules(scope, plain, 'GROUP_MESSAGE_CREATE', false);
      check('  └ 但不 @ 的普通消息仍受冷却保护',
        r3.ok === false && /冷却/.test(r3.why), JSON.stringify(r3));
    }
  }

  check('content 里的 <@openid> 被剥掉（否则模型看到乱码 ID）',
    brain.extractText(realEvent) === '你好', JSON.stringify(brain.extractText(realEvent)));

  const noMention = { ...realEvent, content: '大家早上好呀', mentions: [] };
  // ⚠️ 必须换一个干净的 scope：上面刚把 'group:AT_BYPASS' 里的成员标记成"刚回复过"，
  //    复用那个 scope 会先撞冷却，测不到"省钱抽样"这一步。
  const r2 = brain.passHardRules('group:SAMPLING', noMention, 'GROUP_MESSAGE_CREATE', false);
  // 注意：抽样没抽中时会提前 return，结果里没有 isAt 字段。
  // 这里要验证的是"它没被当成 @"，所以用 isAtRobot 直接问。
  check('真·普通消息（无 mentions、无 @标记）→ 不算 @，仍走省钱抽样',
    brain.isAtRobot('GROUP_MESSAGE_CREATE', noMention) === false && /省钱/.test(r2.why),
    JSON.stringify({ isAtRobot: brain.isAtRobot('GROUP_MESSAGE_CREATE', noMention), why: r2.why }));
}

console.log('\n=== 2. 非文本消息处理（3/101/102 拒绝，103 引用要放行）===');
for (const [t, label] of [[3, '卡片'], [101, '并行消息'], [102, '聊天记录']]) {
  const [type, d] = groupMsg({ type: 'GROUP_AT_MESSAGE_CREATE', content: ' ', message_type: t });
  const r = brain.passHardRules('group:G', d, type, false);
  check(`message_type=${t}（${label}）→ 明确说"暂不支持"，不冒充"空消息"`,
    r.ok === false && /暂不支持/.test(r.why), JSON.stringify(r));
}

console.log('\n=== 2b. ⭐ 引用消息（103）：真机数据，必须能读懂 ===');
{
  // 原样抄自线上 events-*.jsonl（一次"引用 + @机器人提问"）
  const quoted = {
    id: 'ROBOT1.0_R3gtXzXfxTGOf8NvfhbbDoWucYOxMug1YupAhiPAGK77JPRl3YDww6XV8Tys3GsvJri0g6t9oEiBB0mdgGLJVw7Lhr8pJZKvSJ2WfpqEnD6pUeUrauyl9g8FUvbYjBUL',
    author: { username: '低调、星空', member_openid: 'X', bot: false },
    content: '还挺聪明',
    group_openid: 'G',
    message_type: 103,
    mentions: [],
    msg_elements: [{
      content: ' 砍一个人，剩下五个正好一人一个',
      msg_type: 103,
      msg_id: 'REFIDX_d71tplH4XF50+MRIYZa7/KfwA53GSj3gxnwVIEmGkUd9HR8idhskZ8tKExirrkr3sL5GPHd1BrF1AkVCOErKlTUC3nHOTGiskJkm+lpKRGFE1jR/cfa05FpWkyC6tK8',
    }],
    message_scene: { ext: ['ref_msg_idx=REFIDX_...', 'msg_idx=REFIDX_...', 'auth_token=...'], source: 'default' },
  };

  check('103 的 content 被提取出来（引用者说的话）',
    brain.extractText(quoted).includes('还挺聪明'), JSON.stringify(brain.extractText(quoted)));
  check('★ 被引用的原文也拼进去了（否则机器人不知道在说什么）',
    brain.extractText(quoted).includes('砍一个人'), JSON.stringify(brain.extractText(quoted)));
  check('103 有可用文本', brain.hasUsableText(quoted) === true);

  const [t, d] = ['GROUP_AT_MESSAGE_CREATE', quoted];
  const r = brain.passHardRules('group:QUOTE', d, t, false);
  check('★ 引用 + @机器人 → 不再被拒，能进后续流程', r.ok === true, JSON.stringify(r));
  check('  └ 且识别为被 @', r.isAt === true);

  // 只有引用、自己没说话（content 为空格）
  const onlyQuote = { ...quoted, content: ' ' };
  check('只有引用、自己没说话 → 仍能提出被引用内容',
    brain.extractText(onlyQuote).includes('砍一个人'), JSON.stringify(brain.extractText(onlyQuote)));

  // 既没内容也没引用要素 → 应被拒绝
  const empty = { ...quoted, content: ' ', msg_elements: [] };
  const r3 = brain.passHardRules('group:QUOTE', empty, t, false);
  check('提不出任何内容 → 拒绝（且理由说清是提不出）',
    r3.ok === false && /提不出/.test(r3.why), JSON.stringify(r3));
}

console.log('\n=== 3. 抽样开关（默认 8%：没@没关键词的闲聊有 8% 进判断）===');
{
  // ⚠️ 这里的行为被用户改过**两轮**，都记下来免得再困惑：
  //   ① 原 0.05 → 用户要求「没 @ 它、也没提关键词的消息一律不理」→ 改成 0。
  //   ② 🆕 2026-10-05 用户要求「**提高所有人被插嘴的概率**」→ 改成 **0.08**。
  //      起因：查"插嘴主人"时发现主人免抽样 → 他 50.5% 的闲聊进判断，其他人只有 7.3%，
  //      别人几乎没机会被搭话。所以要的是"大家都有机会"，而不是"只有主人被搭话"。
  const P = cfg.policy;
  const realSample = P.sampleNonKeyword;
  try {
    check('★ sampleNonKeyword 现在是 0.08（闲聊有 8% 进判断）',
      P.sampleNonKeyword === 0.08, P.sampleNonKeyword);

    Math.random = () => FIXED_RANDOM_MISS;   // 0.99 > 0.08 → 不中
    const [type, d] = groupMsg({ content: '今天天气不错啊' });
    const r = brain.passHardRules('group:G', d, type, false);
    check('没@没关键词且没抽中 → 沉默（省钱）', r.ok === false && /省钱/.test(r.why), JSON.stringify(r));

    // 抽中了（0.01 < 0.08）→ 放行。⚠️ 必须换一个干净的 scope：
    // 同一个 scope 里上一条刚被标记过，会先撞"连续发言上限"、根本走不到抽样那一步。
    Math.random = () => FIXED_RANDOM_HIT;
    const [, d2] = groupMsg({ content: '今天天气不错啊' });
    const r2 = brain.passHardRules('group:SAMPLING_HIT', d2, 'GROUP_MESSAGE_CREATE', false);
    check('★ 抽中（random < 0.08）→ 放行', r2.ok === true, JSON.stringify(r2));

    // 边界：random 恰好 == 抽样率 → 按 `>` 语义算"中"（不算拒绝）
    const rnd = Math.random;
    Math.random = () => P.sampleNonKeyword;
    const [, d3] = groupMsg({ content: '今天天气不错啊' });
    const r3 = brain.passHardRules('group:SAMPLING_EQ', d3, 'GROUP_MESSAGE_CREATE', false);
    check('  边界：random == 抽样率时算"中"（条件用的是 >）', r3.ok === true, JSON.stringify(r3));

    // 开关是活的：调成 1 必定放行
    P.sampleNonKeyword = 1;
    const [, d4] = groupMsg({ content: '今天天气不错啊' });
    const r4 = brain.passHardRules('group:SAMPLING_ALL', d4, 'GROUP_MESSAGE_CREATE', false);
    check('把 sampleNonKeyword 调成 1 后必定放行（开关有效）', r4.ok === true, JSON.stringify(r4));
    Math.random = rnd;
  } finally {
    P.sampleNonKeyword = realSample;
    Math.random = () => FIXED_RANDOM_MISS;   // 恢复成固定值，不是真实随机
  }
}

console.log('\n=== 4. 关键词命中 ===');
{
  const [type, d] = groupMsg({ content: '小蓝鲸你多大' });
  const r = brain.passHardRules('group:G', d, type, false);
  check('提到"小蓝鲸" → 一定进判断', r.ok === true && r.hitKeyword === true, JSON.stringify(r));
}

console.log('\n=== 5. P0-4 maxConsecutive 真的生效了 ===');{
  const scope = 'group:CONSEC';
  const quiet = isQuietNow();
  if (quiet) {
    console.log('  ⚠️ 现在是北京时间静默时段，跳过该项（改天再跑）');
  } else {
    check('初始可回复', brain.consecutiveOk(scope) === true);
    brain.markReplied(scope, 'U1');
    check('回复 1 次后仍可', brain.consecutiveOk(scope) === true);
    brain.markReplied(scope, 'U2');
    check(`回复 ${cfg.policy.maxConsecutive} 次后 → 触发连续上限`, brain.consecutiveOk(scope) === false);
  }
}

console.log('\n=== 6. 私聊：不被冷却和抽样拦住 ===');{
  const d = {
    id: 'ROBOT1.0_privMessageIdForTest',
    author: { user_openid: 'U9', username: '', bot: false },
    content: '你好',
    message_type: 0,
  };
  const r = brain.passHardRules('private:U9', d, 'C2C_MESSAGE_CREATE', true);
  check('私聊"你好"（2 字）→ 应该通过', r.ok === true, JSON.stringify(r));

  const r2 = brain.passHardRules('private:U9', d, 'C2C_MESSAGE_CREATE', true);
  check('私聊不适用 60 秒冷却', r2.ok === true, JSON.stringify(r2));
}

console.log('\n=== 7. 机器人自己的消息必须忽略 ===');
{
  const [type, d] = groupMsg({ type: 'GROUP_AT_MESSAGE_CREATE', content: '你好呀', bot: true });
  const r = brain.passHardRules('group:G', d, type, false);
  check('author.bot=true → 忽略', r.ok === false && /机器人/.test(r.why), JSON.stringify(r));
}
{
  // 反向验证：id 以 ROBOT1.0_ 开头 ≠ 机器人发的（官方所有 msg_id 都长这样）
  const [type, d] = groupMsg({ type: 'GROUP_AT_MESSAGE_CREATE', content: '小蓝鲸在吗' });
  const r = brain.passHardRules('group:G', d, type, false);
  check('id 以 ROBOT1.0_ 开头但 bot=false → 照常处理（不靠前缀判断）',
    r.ok === true, JSON.stringify(r));
}

console.log('\n=== 8. 时区：静默时段按北京时间 ===');
{
  const bj = new Date(Date.now() + new Date().getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  console.log(`  本机时区: ${Intl.DateTimeFormat().resolvedOptions().timeZone} | 本机时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`  北京时间: ${bj.getFullYear()}-${bj.getMonth() + 1}-${bj.getDate()} ${bj.getHours()}:${String(bj.getMinutes()).padStart(2, '0')}`);
  console.log(`  静默时段: ${cfg.policy.quietHours.join('~')} 点 | 当前${isQuietNow() ? '处于' : '不处于'}静默`);
  check('时区计算不依赖服务器本地时区', typeof bj.getHours() === 'number');
}

console.log('\n=== 9. ⭐ 跨文件接口一致性（防"改了 A 忘了传 B"）===');
{
  // 这个坑踩过两次：
  //   callAI 的返回类型从 string 改成 { text } 后，某个文件没同步，
  //   结果把整个对象当消息内容发给 QQ → 40011000「请求数据异常」，
  //   而那个错误码官方文档查不到，白折腾很久。
  // 现在直接把两端的约定用代码验一遍。
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

  const brainSrc = read('brain.js');
  const indexSrc = read('index.js');
  const qqapiSrc = read('qqapi.js');
  const cfgSrc = read('config.js');

  // ① brain.js 必须把 AI 结果包成 { text }
  check('brain.js 的 callAIOnce 返回 { text: out }',
    /return \{ text: out \}/.test(brainSrc));
  // ①b ⚠️ 关键：**真正调一次函数**看运行时结构，而不是搜文本。
  //     吃过亏：静态正则会被注释里的示例代码骗到（我注释里写了 `return { text: out }` 举反例，
  //     结果检查误报）。行为测试才是可靠的。
  //
  //     这里用不存在的模型触发"所有模型都失败"，从而**不产生任何 API 调用**，
  //     但能验证：异常路径之外，返回结构是否是单层 { text }。
  //     单层验证放在第 10 组（用 budget 拦截做零成本真调用）。
  check('brain.js 的 callAI 不重复包裹（无双层 text）—— 由第 10 组实测',
    true);
  // ② generateReply 现在返回 { text, segments }（多行回复功能加的 segments）
  check('brain.js 的 generateReply 返回 { text, segments }',
    /return \{ text: r\.text, segments: splitForChat\(r\.text\) \}/.test(brainSrc),
    'generateReply 的返回结构变了 —— 消费方 index.js 必须同步');
  // ③ index.js 必须从 .text 取字符串（而不是直接用对象）
  check('index.js 用 gen.text 取字符串',
    /gen\.text/.test(indexSrc));
  // ④ index.js 必须有类型防线
  check('index.js 有 typeof reply 类型防线',
    /typeof reply !== 'string'/.test(indexSrc));
  // ⑤ qqapi.js 必须有空内容拦截
  check('qqapi.js 有"内容为空"拦截',
    /内容为空，已阻止发送/.test(qqapiSrc));
  // ⑥ qqapi.js 必须有请求体打印（失败可定位）
  check('qqapi.js 失败时打印请求体原文',
    /请求体原文/.test(qqapiSrc));
  // ⑦ config.js 必须有错误码表
  check('config.js 有发送错误码表',
    /sendErrors\s*:/.test(cfgSrc) && /40034101/.test(cfgSrc));
  // ⑧ config.js 必须有双预算
  check('config.js 有每日+总计双预算',
    /dailyLimitYuan/.test(cfgSrc) && /totalLimitYuan/.test(cfgSrc));

  // ⑨ 实时行为验证：generateReply 的返回值必须是对象且带 text 键
  //    （不发网络请求，用假 scope 触发 budgetStop 分支之外的最简判断）
  const st = typeof brain.generateReply === 'function';
  check('generateReply 是 async 函数（返回 Promise）',
    st && brain.generateReply.constructor.name === 'AsyncFunction');
}

console.log('\n=== 10. ⭐ 运行时返回值结构（拦截网络，零成本真调用）===');
// ⚠️ 用 async 包装：本文件是 CommonJS，顶层 await 会和 require 冲突
//    （Node 会报 ERR_AMBIGUOUS_MODULE_SYNTAX）
(async () => {
  // 这是本轮最该有的一条测试：
  // 前面所有检查都只是"看代码像不像"，但真正害我们的 bug 是
  // **callAI 把 callAIOnce 的 { text } 又包了一层** → { text: { text } } →
  // index.js 取 gen.text 拿到对象 → QQ 报 40011000（官方文档里查不到的码）。
  //
  // 做法：临时把 global.fetch 换掉，让模型请求返回一个**受控的假响应**，
  //      然后真的调用 brain.generateReply，检查最终拿到的结构。
  //      纯本地，不发网络请求、不花钱、不影响真实预算。
  const realFetch = global.fetch;
  let called = 0;
  let lastBody = null;      // 🆕 抓取真实请求体，用来验证"提示词长什么样"

  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('chat/completions')) {
      called++;
      try { lastBody = JSON.parse(String(opts && opts.body)); } catch (e) { lastBody = null; }
      const payload = {
        choices: [{ message: { role: 'assistant', content: '在。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 3 },
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    }
    return realFetch(url, opts);
  };

  try {
    const fakeMsg = {
      id: 'ROBOT1.0_test', author: { member_openid: 'X', username: '群主', bot: false },
      content: '你好', group_openid: 'G', message_type: 0, mentions: [],
    };
    const r = await brain.generateReply('group:STRUCT_TEST', fakeMsg);

    check('generateReply 返回了东西', r != null, JSON.stringify(r));
    check('返回的是对象', typeof r === 'object', typeof r);
    check('返回值有 text 键', r && 'text' in r, Object.keys(r || {}).join(','));
    // ★ 核心断言
    check('★ r.text 是字符串（不是嵌套对象）',
      typeof r.text === 'string',      `r.text 的类型是 ${typeof r.text}，值=${JSON.stringify(r.text)}`);
    check('★ r.text 内容正确', r.text === '在。', JSON.stringify(r.text));
    // 如果真的被双层包裹，这里会明确指出来
    if (r && r.text && typeof r.text === 'object') {
      check('★ 检测到双层嵌套 { text: { text } } —— 就是 40011000 的根因',
        false, JSON.stringify(r.text));
    }
    check('确实调用了模型接口（桩生效）', called === 1, `called=${called}`);

    // ---- 顺带验证示例对话真的被拼进了 messages ----
    const r2 = await brain.generateReply('group:EX_TEST', fakeMsg);
    check('generateReply 依然返回 { text, segments }',
      typeof r2.text === 'string' && Array.isArray(r2.segments),
      JSON.stringify({ text: typeof r2.text, segs: r2.segments && r2.segments.length }));

    // ---- 🔴 回归：时间必须在 **user** 里，不能进 system（2026-09-22 实测修的）----
    //
    // 为什么：DeepSeek 的上下文缓存是**前缀匹配**、命中价是 1/50。
    // 前缀 = system(人设) → examples → user。时间放 system 末尾的话，
    // **每分钟前缀就失效一次**，缓存命中率从 53% 掉到 0%。
    // 实测：时间在 system 时"过 1 分钟"命中 0%；挪到 user 后稳定 53%。
    {
      const msgs = (lastBody && lastBody.messages) || [];
      const systemMsgs = msgs.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
      const userMsgs = msgs.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
      check('★ 提示词里确实带了当前时间（功能不能丢）',
        /【当前时间】/.test(userMsgs) || /【当前时间】/.test(systemMsgs));
      check('★★ 时间在 **user** 里，**不在** system 里（放 system 会把 prompt 缓存全打掉）',
        !/【当前时间】/.test(systemMsgs) && /【当前时间】/.test(userMsgs),
        { system里有: /【当前时间】/.test(systemMsgs), user里有: /【当前时间】/.test(userMsgs) });
      check('  └ system 是**稳定前缀**（不含时间 → 跨分钟也能命中缓存）',
        !/\d{1,2}:\d{2}/.test(systemMsgs), systemMsgs.slice(0, 80));
      check('  └ 示例对话在 system 之后、且是独立的多轮消息（缓存前缀的一部分）',
        msgs.filter((m) => m.role === 'assistant').length >= 5,
        msgs.filter((m) => m.role === 'assistant').length);
    }
  } finally {
    global.fetch = realFetch;   // 一定恢复，否则污染后面的代码
  }

  // ---- 🆕 记账要区分"缓存命中"（1/50 价），否则账本虚高、优化看不见 ----
  //
  // ⚠️ 这里**直接调 budget.record**，不经过模型 ——
  //    因为走真实调用会受"免费模型不记账""缓存命中率"等因素干扰，测不出确定的东西。
  {
    const budget = require('./budget');
    const b0 = budget.status().spentYuan;
    // 命中 800 + 未命中 200 + 输出 10
    budget.record('deepseek-flash', {
      prompt_tokens: 1000, completion_tokens: 10,
      prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200,
    });
    const withCache = budget.status().spentYuan - b0;
    // 期望：200/1e6*2 + 800/1e6*(2*0.02) + 10/1e6*8 = 0.0004 + 0.000032 + 0.00008
    const expect = 200e-6 * 2 + 800e-6 * 0.04 + 10e-6 * 8;
    check('★★ 记账区分缓存命中（旧算法会把 1000 全按 2 元/M 记成 ¥0.00208）',
      Math.abs(withCache - expect) < 1e-7, `记了 ¥${withCache.toFixed(6)}，期望 ¥${expect.toFixed(6)}`);
    check('  └ 缓存命中的那 800 token 确实按 1/50 价算',
      withCache < 1000e-6 * 2 * 0.6, '（若按全价会接近 ¥0.0021）');

    // 别的服务商不返回 cache 字段 → 必须退化成旧公式，不能算错
    const b1 = budget.status().spentYuan;
    budget.record('deepseek-flash', { prompt_tokens: 1000, completion_tokens: 10 });
    const noCache = budget.status().spentYuan - b1;
    check('★ 没有 cache 字段时退化成旧公式（兼容别的服务商）',
      Math.abs(noCache - (1000e-6 * 2 + 10e-6 * 8)) < 1e-7, noCache.toFixed(6));

    // 免费模型的机制仍然要测 —— 生产配置里现在已经没有免费模型了，
    // 所以**临时往清单里塞一个测试名**：budget 是每次调用时读配置的，改完立即生效，
    // 并且用 try/finally 还原，既不影响后面的测试，也不会上线。
    const FREE_TEST = '__free_test_model__';
    cfg.budget.freeModels.push(FREE_TEST);
    try {
      const b2 = budget.status().spentYuan;
      budget.record(FREE_TEST, { prompt_tokens: 9999, completion_tokens: 999 });
      check('  免费模型（显式登记过）依旧不记钱',
        budget.status().spentYuan === b2, budget.status().spentYuan - b2);
    } finally {
      cfg.budget.freeModels.pop();
    }
  }

  console.log('\n=== 11. ⭐ 多行回复分段逻辑 ===');
  {
    const S = brain.splitForChat;
    const opt = cfg.splitReply;
    console.log(`  配置: 超过${opt.minChars}字才拆 / 最多${opt.maxSegments}段 / 每段至少${opt.minSegment}字`);

    // ① 短回复不拆
    const s1 = S('在。');
    check('短回复 → 1 段（不拆）', s1.length === 1 && s1[0] === '在。', JSON.stringify(s1));

    // ② 无句末标点的长文本 → 不拆（切了会读着断气）
    const s2 = S('这是一段很长很长的话但是完全没有句末标点所以不应该被切开因为它读起来是连贯的一整句');
    check('长但无句末标点 → 不拆', s2.length === 1, JSON.stringify(s2));

    // ③ 多个短句的长回复 → 拆成 ≤ maxSegments 段
    const long = '今天天气不错。你想出去走走吗？我觉得可以。不过我有点懒。算了还是躺着吧。要不你帮我带个饭？';
    const s3 = S(long);
    check(`多句长回复 → 拆成 ≤${opt.maxSegments} 段`, s3.length <= opt.maxSegments && s3.length > 1, JSON.stringify(s3));

    // ④ ★ 不丢内容（拆完拼回去应该和原文一致）
    check('★ 分段不丢内容（拼回等于原文）',
      s3.join('') === long, `拼回=${JSON.stringify(s3.join(''))}`);

    // ⑤ 每段都不至于太短
    check('每段长度 ≥ minSegment',
      s3.every((x) => x.length >= opt.minSegment), JSON.stringify(s3.map((x) => x.length)));

    // ⑥ 逗号不切
    const s6 = S('你好啊，我是蓝色大肥鱼，今天有点懒得动，但是还是要回你一句的，毕竟你都叫我了。');
    check('逗号不作为切分点',
      s6.every((x) => !x.startsWith('，')), JSON.stringify(s6));

    // ⑦ nextSendDelay 落在配置区间内
    //    ⚠️ 本文件把 Math.random 固定了（为了让抽样测试确定），
    //       所以测"随机性"时要**临时恢复真随机**，否则 30 次都是同一个值。
    const delays = Array.from({ length: 30 }, () => brain.nextSendDelay());
    check('发送间隔在 [delayMin, delayMax] 内',
      delays.every((d) => d >= opt.delayMinMs && d <= opt.delayMaxMs),
      `${Math.min(...delays)}~${Math.max(...delays)}`);

    let uniq = 0;
    try {
      Math.random = REAL_RANDOM;   // 临时恢复真随机，专测这一条
      uniq = new Set(Array.from({ length: 30 }, () => brain.nextSendDelay())).size;
    } finally {
      Math.random = () => FIXED_RANDOM_MISS;   // 立刻还原，别污染后面的检查
    }
    check('★ 发送间隔是随机的（固定间隔看起来像机器）',
      uniq > 5, `不同值个数=${uniq}（真随机下应接近 30）`);
  }

  console.log('\n=== 12. ⭐ 上下文记忆：条数 + 时效 + 长度 三重约束 ===');
  {
    const P = cfg.policy;
    console.log(`  配置: 最多 ${P.contextSize} 条 / 时效 ${P.contextMaxAgeMs / 60000} 分钟 / 会话 TTL ${P.contextScopeTtlMs / 60000} 分钟`);

    // ---- 条数上限 ----
    const S = 'group:CTX_SIZE';
    for (let i = 1; i <= 60; i++) brain.pushContext(S, 'u' + i, 'msg' + i);
    const r = brain.recentContext(S);
    check(`推 60 条后只保留 ${P.contextSize} 条`, r.length === P.contextSize, `实际 ${r.length}`);
    check('保留的是最新的（末条 msg60）', r[r.length - 1].content === 'msg60', r[r.length - 1].content);
    check('最老的被挤掉了', r[0].content === 'msg' + (60 - P.contextSize + 1), r[0].content);

    // ---- 消息带时间戳 ----
    check('每条都记了时间戳（没时间戳就没法做时效判断）',
      typeof r[0].ts === 'number' && r[0].ts > 0, r[0]);

    // ---- 时效过滤：临时把时效改成 1ms，等 25ms，应该全部过期 ----
    const realMaxAge = P.contextMaxAgeMs;
    try {
      const T = 'group:CTX_AGE';
      brain.pushContext(T, '某人', '应该过期的话');
      check('时效内能取到', brain.recentContext(T).length === 1);

      P.contextMaxAgeMs = 1;
      const until = Date.now() + 25;
      while (Date.now() < until) { /* 忙等 25ms */ }
      check('★ 超过时效的消息被过滤（冷场后不会拿旧话题硬接）',
        brain.recentContext(T).length === 0, brain.recentContext(T).length);
    } finally {
      P.contextMaxAgeMs = realMaxAge;        // 一定还原，别污染后面的检查
    }

    const T2 = 'group:CTX_AGE2';
    brain.pushContext(T2, '某人', '新的话');
    check('还原时效后恢复正常', brain.recentContext(T2).length === 1);

    // ---- 时效 = 0 表示"不过滤"（给想关掉的人留后路） ----
    const realMaxAge2 = P.contextMaxAgeMs;
    try {
      P.contextMaxAgeMs = 0;
      const T3 = 'group:CTX_NOAGE';
      brain.pushContext(T3, 'a', 'x');
      brain.pushContext(T3, 'b', 'y');
      check('时效设为 0 时不做时间过滤', brain.recentContext(T3).length === 2);
    } finally {
      P.contextMaxAgeMs = realMaxAge2;
    }

    // ---- 🆕 第三道闸：长度（2026-09-22 用户问「刷图多了判断回复的 token 不是也变多了」）----
    //
    // 实测依据：真实群聊消息中位 **7 字**，识图描述中位 **47 字**（≈7 条话的体量），
    // 中文 **1 字 ≈ 0.567 token**，而上下文是**每次 L1/L2 调用都要重发一遍**的。
    // → 只按"条数"收口拦不住"条目变长"，30 条全是图 ≈ 953 token，全是短句只要 187 token。
    console.log(`  长度闸: 单条≤${P.contextMsgMaxChars} 字 · 总量≤${P.contextMaxChars} 字 · 至少留 ${P.contextMinKeep} 条`);

    // ① 正常聊天**不能**受影响（这是最容易写坏的地方）
    const L1 = 'group:CTX_LEN_NORMAL';
    for (let i = 1; i <= P.contextSize; i++) brain.pushContext(L1, '群友', `第${i}句话`);
    const gotN = brain.recentContext(L1);
    check('★ 正常短句 30 条 → 一条都不丢（长度闸有余量，别误伤日常聊天）',
      gotN.length === P.contextSize, gotN.length);
    check('  └ 最旧的那条也还在', gotN[0].content === '第1句话', gotN[0].content);

    // ② 图片/长文本把上下文撑爆时，必须真的收口
    const L2 = 'group:CTX_LEN_IMG';
    const DESC = '【图片】' + '猫叼梨背啤酒配文叼梨猫支啤谐音梗嘲讽'.repeat(2).slice(0, 47);
    for (let i = 0; i < P.contextSize; i++) brain.pushContext(L2, '群友', DESC);
    const gotI = brain.recentContext(L2);
    const charsOf = (arr) => arr.reduce((a, m) => a + String(m.content).length + String(m.name).length + 2, 0);
    const oldChars = P.contextSize * (DESC.length + 6);
    check('★ 全是图片描述 → 真的收口了（旧行为会一路撑到 ' + oldChars + ' 字）',
      charsOf(gotI) <= P.contextMaxChars, `${charsOf(gotI)} 字`);
    check('  └ 收口后条数变少（丢的是旧的）', gotI.length < P.contextSize, gotI.length);
    check('★ 丢的是**最旧的**，最新的必须留着（最近的对话才最有用）',
      gotI[gotI.length - 1].content === DESC);
    check(`  └ ≈token 从 ${Math.round(oldChars * 0.567)} 降到 ${Math.round(charsOf(gotI) * 0.567)}`
      + `（1 字≈0.567 token，实测值）`,
      Math.round(charsOf(gotI) * 0.567) < Math.round(oldChars * 0.567));
    check('  └ 单条本身没被截断（47 字 < 单条上限）', gotI[0].content === DESC);

    // ③ 单条超长：一条 617 字的粘贴不该霸占整个上下文
    const L3 = 'group:CTX_LEN_LONG';
    for (let i = 0; i < 3; i++) brain.pushContext(L3, '群友', '短句' + i);
    brain.pushContext(L3, '群友', '长'.repeat(617));
    const gotL = brain.recentContext(L3);
    const bigOne = gotL[gotL.length - 1];
    check('★ 单条 617 字 → 被截断到上限 + 省略号',
      bigOne.content.length === P.contextMsgMaxChars + 1 && bigOne.content.endsWith('…'),
      bigOne.content.length);

    // ④ 极端：单条上限比总量上限还大时，也不能一条都不剩
    const realMax = P.contextMaxChars;
    const realPer = P.contextMsgMaxChars;
    try {
      P.contextMaxChars = 50;          // 故意调得比单条上限还小
      P.contextMsgMaxChars = 200;
      const L4 = 'group:CTX_LEN_TINY';
      for (let i = 0; i < 10; i++) brain.pushContext(L4, '群友', '这是一句很长很长的话'.repeat(3));
      const gotT = brain.recentContext(L4);
      check('★ 极端配置下也至少留 minKeep 条（不能把上下文清空）',
        gotT.length >= Math.min(P.contextMinKeep, 10), gotT.length);
      check('  └ 且留下的是最新的', gotT[gotT.length - 1].content.length > 0);
    } finally { P.contextMaxChars = realMax; P.contextMsgMaxChars = realPer; }

    // ⑤ 配置健全性：闸门必须比"正常聊天"宽，否则会天天误伤
    check('★ 总量上限要宽于正常 30 条短句（否则就是天天误伤）',
      P.contextMaxChars > 30 * (12 + 6), `上限 ${P.contextMaxChars} vs 正常约 ${30 * (12 + 6)}`);
    check('  单条上限要宽于识图描述中位数 47 字（否则图片描述会被切）',
      P.contextMsgMaxChars > 47 * 2, `${P.contextMsgMaxChars} vs 47`);

    // ---- 🆕 当前这条消息**不能被送两遍**（2026-09-22 修）----
    //
    // 线上实打实打出来过：
    //   最近群聊：
    //   小红: 今天好热啊
    //   小明: 这个表情包笑死我了        ← 作为"历史"（index.js 第 4 步推进来的）
    //   最新：小明: 这个表情包笑死我了   ← 作为"当前"（L1/L2 又拼了一遍）
    // 短消息多约 14 token/次回话；**图片描述 47 字 → 多约 58 token/次回话**。
    {
      const C = 'group:CTX_DUP';
      brain.pushContext(C, '小红', '今天好热啊', 'MSG_A');
      brain.pushContext(C, '小明', '是啊 开空调了', 'MSG_B');
      const curMsg = { content: '这个表情包笑死我了', author: { username: '小明' }, message_type: 0, id: 'MSG_CUR' };
      brain.pushContext(C, '小明', curMsg.content, curMsg.id);

      check('★ 当前这条**仍然在**上下文里（后面几条消息要看得见它，不能为了省 token 就删）',
        brain.recentContext(C).length === 3, brain.recentContext(C).length);

      const txt = brain.contextText(C, curMsg);
      const hits = txt.split('\n').filter((l) => l.includes('这个表情包笑死我了'));
      check('★★ 但拼给模型的文本里，当前这条出现 **0 次**（它由「最新：」单独给）',
        hits.length === 0, `出现了 ${hits.length} 次`);
      check('  └ 更早的两条仍在（别把整个上下文都清掉）',
        txt.includes('今天好热啊') && txt.includes('是啊 开空调了'), txt);
      check('  └ 老接口 recentContext 不受影响（它只管"存了什么"）',
        brain.recentContext(C).some((m) => m.content === curMsg.content));

      // 没有 id 的消息（老数据 / 机器人自己的回复）不该被误伤
      check('★ 没有 msgId 时不做剔除（老数据 / 机器人自己的发言不受影响）',
        brain.contextText(C, { content: 'x', id: '' }).includes('这个表情包笑死我了'));

      // 内容相同但 id 不同的两条，**不能**被误删
      // （群里连着发两条"哈哈哈"是常态，用内容比对就会误伤）
      const D = 'group:CTX_DUP2';
      brain.pushContext(D, '小明', '哈哈哈', 'ID_1');
      brain.pushContext(D, '小明', '哈哈哈', 'ID_2');
      const t2 = brain.contextText(D, { content: '哈哈哈', id: 'ID_2' });
      check('★ 内容相同但 id 不同的两条：只剔除 id 命中的那条（用内容比对会误伤）',
        t2.split('\n').filter((l) => l.includes('哈哈哈')).length === 1, t2);

      check('contextText 已导出（L1/L2 共用，别再各写一份）',
        typeof brain.contextText === 'function');
    }
  }

  console.log('\n=== 13. ⭐ @ 判定：只认指向自己的，别把"群友互 @"当成叫我 ===');
  {
    // 真机抓到的机器人自己的 openid（来自线上 events 数据）
    const BOT = 'BOT0PEN1D000000000000000000000000';
    const OWNER = 'OWNER0PEN1D0000000000000000000000';       // 群主群主
    const OTHER = '0A1B2C3D4E5F60718293A4B5C6D7E8F9';       // 另一个群友

    const mkMsg = (content, mentions) => ({
      id: 'ROBOT1.0_t',
      author: { member_openid: OTHER, username: '某群友', bot: false },
      content, group_openid: 'G', message_type: 0, mentions: mentions || [],
    });

    // ---- ⚠️ 线上真实 bug 的复现：群友 @群主 ----
    const atOther = mkMsg(
      `请吃饭吃不吃 <@${OWNER}>`,
      [{ bot: false, id: OWNER, member_openid: OWNER, username: '群主', scope: 'single' }],
    );
    check('★ 群友 @ 别人（mentions 无 is_you）→ 不算叫我',
      brain.isAtRobot('GROUP_MESSAGE_CREATE', atOther, BOT) === false,
      `isAt=${brain.isAtRobot('GROUP_MESSAGE_CREATE', atOther, BOT)}`);

    // 反向：mentions 里有 is_you=true → 才算
    const atMe = mkMsg(
      `你好 <@${BOT}>`,
      [{ bot: true, id: BOT, is_you: true, member_openid: BOT, username: '蓝色大肥鱼' }],
    );
    check('★ 真 @ 机器人（is_you=true）→ 算叫我',
      brain.isAtRobot('GROUP_MESSAGE_CREATE', atMe, BOT) === true);

    // 没有 mentions，但 content 里是机器人的 openid → 也算
    const atMeByContent = mkMsg(`在吗 <@${BOT}>`, []);
    check('content 里指向机器人 openid → 算叫我',
      brain.isAtRobot('GROUP_MESSAGE_CREATE', atMeByContent, BOT) === true);

    // 多个群友互 @，一个都不是机器人 → 不算
    const multiAt = mkMsg(
      `<@${OWNER}> <@${OTHER}> 你俩看这个`,
      [
        { bot: false, id: OWNER, member_openid: OWNER, username: '群主' },
        { bot: false, id: OTHER, member_openid: OTHER, username: '七' },
      ],
    );
    check('★ 群友互 @ 多人（都不是机器人）→ 不算叫我',
      brain.isAtRobot('GROUP_MESSAGE_CREATE', multiAt, BOT) === false);

    // 事件名是 GROUP_AT_MESSAGE_CREATE → 永远算（官方路径）
    check('事件名是 @ 事件 → 直接算叫我',
      brain.isAtRobot('GROUP_AT_MESSAGE_CREATE', atOther, BOT) === true);

    // 走完整 L0：群友 @ 别人 → 不该被判成"被 @"而放行
    const l0 = brain.passHardRules('group:AT_OTHER', atOther, 'GROUP_MESSAGE_CREATE', false);
    check('★ L0 里群友 @ 别人 → isAt 不为真',
      l0.isAt !== true, JSON.stringify(l0));

    console.log('');
    console.log('  --- 只有 @ 机器人、没有内容 ---');
    const mentionOnly = mkMsg(`<@${BOT}>`, [{ bot: true, id: BOT, is_you: true, member_openid: BOT }]);
    check('识别为"只有@机器人没有内容"',
      brain.isMentionOnly('GROUP_MESSAGE_CREATE', mentionOnly) === true);

    // ⚠️ 这个行为来回改过，最终结论锁在这里：
    //    **纯 @ 机器人 → 要吱一声**（被点名不该装死）
    //    之前误以为"要沉默"，真因是 isMentionOnly 有 bug（@别人也被判成 mentionOnly），
    //    那个 bug 已修，所以这里正确地开启。
    const r = brain.passHardRules('group:MO', mentionOnly, 'GROUP_MESSAGE_CREATE', false);
    check('★ 只有 @ 机器人没内容 → 放行并标记 mentionOnly（回一句"咋了"）',
      r.ok === true && r.mentionOnly === true, JSON.stringify(r));
    check('  └ 且算作被 @（isAt=true）', r.isAt === true, JSON.stringify(r));
    check('开关配置存在', !!cfg.policy.mentionOnlyReply && Array.isArray(cfg.policy.mentionOnlyReply.replies));
    check('★ 默认开启（被点名要吱一声）', cfg.policy.mentionOnlyReply.enabled === true);
    check('应答池非空', cfg.policy.mentionOnlyReply.replies.length > 0);
    // 关掉开关后行为应该变成沉默（证明开关是活的）
    check('★ 把开关关掉会变成沉默（证明开关是活的）', (() => {
      const mo = cfg.policy.mentionOnlyReply;
      const orig = mo.enabled;
      try {
        mo.enabled = false;
        const r2 = brain.passHardRules('group:MO_OFF', mentionOnly, 'GROUP_MESSAGE_CREATE', false);
        return r2.ok === false;
      } finally { mo.enabled = orig; }
    })());

    // ---- ⭐ 回归测试（2026-09-18 线上 bug）----
    // 日志证据：群友 @群主（不是机器人）+ 没内容 → 被判成 mentionOnly → 回了"咋了"
    // 根因：旧 isMentionOnly 只看"有没有 <@...>"，不看指向谁
    console.log('');
    console.log('  --- ⭐ 回归：只 @ 了**别人**、没内容 → 不该算 mentionOnly ---');
    const atOtherOnly = mkMsg(`<@${OWNER}> `, [
      { bot: false, id: OWNER, is_you: false, member_openid: OWNER, username: '群主', member_role: 'owner' },
    ]);
    check('★ 只 @ 别人 → isMentionOnly 为 false（旧实现会误判成 true）',
      brain.isMentionOnly('GROUP_MESSAGE_CREATE', atOtherOnly) === false,
      brain.isMentionOnly('GROUP_MESSAGE_CREATE', atOtherOnly));
    check('  └ 走正常流程：不算被 @', brain.isAtRobot('GROUP_MESSAGE_CREATE', atOtherOnly, BOT) === false);
    const rOther = brain.passHardRules('group:MO_OTHER', atOtherOnly, 'GROUP_MESSAGE_CREATE', false);
    check('  └ L0 不会因为它回话', rOther.ok === false, JSON.stringify(rOther));

    const mentionWithText = mkMsg(`<@${BOT}> 在吗`, []);
    check('@ + 有内容 → 不算 mentionOnly',
      brain.isMentionOnly('GROUP_MESSAGE_CREATE', mentionWithText) === false);

    // ---- ⭐ 回归（2026-09-18 第二条路径）----
    // 手机端 @ 机器人时平台发来 GROUP_AT_MESSAGE_CREATE，而它 **content 和 mentions 都是空的**
    // （实测该事件 78 条，mentions 全空；其中 7 条 content 也空）
    // 旧实现判 false → 落到"空消息"分支 → 被点名却装死。
    console.log('');
    console.log('  --- ⭐ 回归：GROUP_AT_MESSAGE_CREATE 空 content 也要认出来 ---');
    const atEventEmpty = {
      id: 'ROBOT1.0_t', author: { member_openid: 'X', username: '群友', bot: false },
      content: '', group_openid: 'G', message_type: 0, mentions: [],
    };
    check('★ 空 content + 空 mentions 的 @ 事件 → 算"纯@机器人"',
      brain.isMentionOnly('GROUP_AT_MESSAGE_CREATE', atEventEmpty) === true,
      brain.isMentionOnly('GROUP_AT_MESSAGE_CREATE', atEventEmpty));
    const l0At = brain.passHardRules('group:AT_EMPTY', atEventEmpty, 'GROUP_AT_MESSAGE_CREATE', false);
    check('★ L0 会回一句（不再判成"空消息"）',
      l0At.ok === true && l0At.mentionOnly === true, JSON.stringify(l0At));

    // 有内容的 @ 事件不能被误判成"纯@"
    const atEventText = { ...atEventEmpty, content: '在不在' };
    check('@ 事件 + 有内容 → 不算 mentionOnly',
      brain.isMentionOnly('GROUP_AT_MESSAGE_CREATE', atEventText) === false);
    check('  └ 且正常放行到后续流程',
      brain.passHardRules('group:AT_TEXT', atEventText, 'GROUP_AT_MESSAGE_CREATE', false).ok === true);
    check('@ + 有内容 → 提取出正确文本',
      brain.extractText(mentionWithText) === '在吗', JSON.stringify(brain.extractText(mentionWithText)));
  }

  console.log('\n=== 14. ⭐ 不许抢答：消息 @ 了别人时应当沉默 ===');
  {
    const BOT = 'BOT0PEN1D000000000000000000000000';
    const DEMON = 'OTHER0PEN1D0000000000000000000000';   // 某群友A（线上真实案例）

    // ⚠️ 线上真实案例：问「@某群友A 你喜欢吃米饭吗」→ 它抢答"米饭我能吃三碗"
    const askOther = {
      id: 'ROBOT1.0_t', author: { member_openid: DEMON, username: '群主', bot: false },
      content: `你喜欢吃米饭吗`, group_openid: 'G', message_type: 0,
      mentions: [{ bot: false, id: DEMON, is_you: false, member_openid: DEMON, username: '某群友A' }],
    };

    check('★ 识别出"@ 了别人"', brain.mentionedOthers(askOther) === true);
    check('  └ 且不算被 @（is_you 是 false）',
      brain.isAtRobot('GROUP_MESSAGE_CREATE', askOther, BOT) === false);

    const wonAt = { ...askOther, mentions: [] };
    check('没 @ 任何人时 mentionedOthers 为假', brain.mentionedOthers(wonAt) === false);

    const atBotInstead = {
      ...askOther,
      mentions: [{ bot: true, id: BOT, is_you: true, member_openid: BOT, username: '蓝色大肥鱼' }],
    };
    check('@ 的是机器人时 mentionedOthers 为假（那是叫我，不是叫别人）',
      brain.mentionedOthers(atBotInstead) === false);

    check('配置开关存在', 'avoidButtingInWhenAtOther' in cfg.policy, cfg.policy.avoidButtingInWhenAtOther);

    // ---- 关键词表必须只含"名字"，不能有通用词 ----
    const K = cfg.policy.keywords;
    check('★ 关键词里没有过宽的通用词「蓝色」',
      !K.includes('蓝色'), JSON.stringify(K));
    check('关键词包含机器人本体名', K.includes('蓝色大肥鱼') && K.includes('鲸少女'), JSON.stringify(K));
  }

  console.log('\n=== 15. ⭐ 表达丰富度：习惯动作 / 括号 / 反重复 ===');
  {
    const S = cfg.persona.systemPrompt;
    const EX = cfg.persona.examples;
    const style = cfg.persona.promptStyle;
    console.log(`  提示词风格: ${style}（生效 ${S.length} 字 / full ${cfg.persona.promptFull.length} 字 / lean ${cfg.persona.promptLean.length} 字）`);

    // ---- ⭐ 可回退机制：两套词都必须在，且都能切 ----
    check('★ 两套提示词都在文件里（可一键回退）',
      cfg.persona.promptFull.length > 100 && cfg.persona.promptLean.length > 100,
      { full: cfg.persona.promptFull.length, lean: cfg.persona.promptLean.length });
    check('promptStyle 取值合法', ['lean', 'full'].includes(style), style);
    check('★ 切换 promptStyle 能真的换掉生效提示词', (() => {
      const orig = cfg.persona.promptStyle;
      try {
        cfg.persona.promptStyle = 'full';
        const a = cfg.persona.systemPrompt;
        cfg.persona.promptStyle = 'lean';
        const b = cfg.persona.systemPrompt;
        return a.length !== b.length && a !== b;
      } finally { cfg.persona.promptStyle = orig; }
    })());
    check('精简版确实更短', cfg.persona.promptLean.length < cfg.persona.promptFull.length);

    // ---- 两套词共有的硬规则（无论用哪套都必须有）----
    check('★ 生效提示词含"必须回答问题"硬规则', /必须(给出|回答)/.test(S));
    check('生效提示词含身份区分（主人/普通群员）', /主人/.test(S) && /普通群员/.test(S));
    check('生效提示词含性格（傲娇/米饭/胖）', /傲娇/.test(S) && /米饭/.test(S) && /胖/.test(S));
    check('生效提示词含括号动作说明', /括号/.test(S));
    check('★ 提示词里没有压制表达的"话少"设定', !/话少/.test(S));

    // ---- full 版专属内容（切到 full 时才检查）----
    if (style === 'full') {
      check('full 版含"习惯动作"段落', /习惯动作/.test(S));
      check('full 版含"别重复同一个梗"规则', /别重复/.test(S));
      check('full 版写明"一条消息最多一个括号"', /最多一个括号/.test(S));
      check('full 版禁止通用萌系套路（歪头）', /歪头/.test(S) && /套路/.test(S));
    } else {
      check('lean 版把"怎么表达"交给示例（示例里必须有括号动作）',
        EX.some((e) => /\([^)]+\)/.test(e.a)), EX.filter((e) => /\([^)]+\)/.test(e.a)).length);
    }

    // ---- 示例规模 ----
    check(`示例 ≥12 组（现 ${EX.length} 组）`, EX.length >= 12, EX.length);
    check(`示例 ≤15 组（防挤掉真实群聊，现 ${EX.length} 组）`, EX.length <= 15, EX.length);

    // ---- ⭐ 核心：生气不能只有一招 ----
    const angry = EX.filter((e) => /胖|肥/.test(e.u));
    check(`★ 生气类示例 ≥3 组（现 ${angry.length} 组）`, angry.length >= 3, angry.length);
    check('★ 生气表达各不相同（不是同一句复制）',
      new Set(angry.map((e) => e.a)).size === angry.length,
      angry.map((e) => e.a));

    // ---- 其他情绪也要有 ----
    const praise = EX.filter((e) => /厉害|聪明/.test(e.u));
    check('有"被夸"的表达', praise.length >= 1, praise.length);
    check('有"被要求干活"的表达', EX.some((e) => /爬虫|报错/.test(e.u)));
    check('有带身份标注的示例（主人/群员）',
      EX.some((e) => e.role === '主人') && EX.some((e) => e.role === '普通群员'));

    // ---- 参数松绑 ----
    check(`maxSegments 提到 4（现 ${cfg.splitReply.maxSegments}）`, cfg.splitReply.maxSegments === 4);
    check('★ maxSegments 不超 QQ 硬上限 5', cfg.splitReply.maxSegments <= 5);
    check(`scoreThreshold 降到 5（现 ${cfg.policy.scoreThreshold}）`, cfg.policy.scoreThreshold === 5);

    // ---- 反重复机制 ----
    check('反重复配置存在且开启', !!cfg.antiRepeat && cfg.antiRepeat.enabled === true);
    const scope = 'group:ANTI_REPEAT';
    brain.recordReply(scope, '第一句');
    brain.recordReply(scope, '第二句');
    check('★ 记住了最近说过的话', brain.recentReplyTexts(scope).length === 2, brain.recentReplyTexts(scope));
    check('不同会话互不干扰', brain.recentReplyTexts('group:OTHER_SCOPE').length === 0);
    for (let i = 0; i < 20; i++) brain.recordReply(scope, '填充' + i);
    check(`★ 超出 historySize 会滚动丢弃（保留 ${cfg.antiRepeat.historySize} 条）`,
      brain.recentReplyTexts(scope).length === cfg.antiRepeat.historySize,
      brain.recentReplyTexts(scope).length);
  }

  console.log('\n=== 16. ⭐ 时间感知：不能编、也不能拒答 ===');
  {
    // 踩过的坑（2026-09 实测）：
    //   提示词里没给时间时，问"今天是几号"它**编**了一个（答"2月25号"，
    //   实际是 9月16日）；问"现在几点"它**躲**（"我又不是时钟"）。
    //   根因不是模型不行，是我们没告诉它。
    const src = require('fs').readFileSync(require('path').join(__dirname, 'brain.js'), 'utf8');

    check('★ generateReply 里注入了【当前时间】', /【当前时间】/.test(src));
    check('时间格式含"星期X"', /WEEK\s*=\s*\[/.test(src) && /星期日/.test(src));
    check('明确要求"别编造"', /别编造/.test(src));
    check('明确禁止"我又不是时钟"式拒答', /我又不是时钟/.test(src));
    check('用北京时间（nowInBeijing）', /nowInBeijing\(\)/.test(src));

    // 行为验证：拼出来的时间串应匹配当前北京日期
    const d = new Date();
    const bj = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
    const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][bj.getDay()];
    const timeStr = `${WEEK} (${bj.getFullYear()}/${bj.getMonth() + 1}/${bj.getDate()} `
      + `${String(bj.getHours()).padStart(2, '0')}:${String(bj.getMinutes()).padStart(2, '0')})`;
    check('时间串格式正确（星期 + 年月日 + 时分）',
      /^星期[日一二三四五六] \(\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}\)$/.test(timeStr), timeStr);
    check('时间串日期 = 今天的北京日期',
      timeStr.includes(`${bj.getFullYear()}/${bj.getMonth() + 1}/${bj.getDate()}`), timeStr);
  }

  console.log('\n=== 17. ⭐ 助手模式：暗号 ovo 切换精准回答 ===');
  {
    const A = cfg.policy.assistantMode;
    console.log(`  暗号: ${JSON.stringify(A.trigger)}  大小写敏感: ${A.caseSensitive}`);
    check('助手模式已开启', A.enabled === true);
    check('配置了助手模式要求说明', typeof A.systemNote === 'string' && A.systemNote.length > 50);

    const mk2 = (content, mentions) => ({
      id: 'ROBOT1.0_t',
      author: { member_openid: 'X', username: '群主', bot: false },
      content, group_openid: 'G', message_type: 0, mentions: mentions || [],
    });

    // ---- 触发判定 ----
    const cases = [
      ['ovo 帮我解释什么是递归', true, '帮我解释什么是递归', '标准用法'],
      ['OVO 大写也认吗', true, '大写也认吗', '大写'],
      ['Ovo 混合大小写', true, '混合大小写', '混合大小写'],
      ['ovo帮我看看', true, '帮我看看', '暗号后直接接中文'],
      ['ovo，帮我看看', true, '帮我看看', '暗号后接逗号'],
      ['ovo：这个问题', true, '这个问题', '暗号后接冒号'],
      // ★ 不触发的边界
      ['ovo', false, null, '整条只有暗号'],
      ['ovo   ', false, null, '暗号+空格'],
      ['ovoid 这不是暗号', false, null, '★ 相似词（ovoid）'],
      ['ovovovo', false, null, '★ 重复暗号'],
      ['ovoabc', false, null, '★ 暗号后直接接英文'],
      ['你好 ovo 在后面', false, null, '暗号不在开头'],
      ['普通消息', false, null, '普通消息'],
    ];
    for (const [content, want, wantText, label] of cases) {
      const r = brain.detectAssistantMode(mk2(content));
      const ok = r.on === want && (!want || r.text === wantText);
      check(`${label}  «${content}»`, ok, r);
    }

    // ---- @ 之后再打暗号也认 ----
    const atThenOvo = mk2(
      `<@${'BOT0PEN1D000000000000000000000000'}> ovo 解释下量子纠缠`,
      [{ bot: true, id: 'BOT0PEN1D000000000000000000000000', is_you: true }],
    );
    const rAt = brain.detectAssistantMode(atThenOvo);
    check('★ "@它 ovo 问题" 能触发（先剥 @）',
      rAt.on === true && rAt.text === '解释下量子纠缠', rAt);

    // ---- extractText 不把暗号当内容 ----
    check('★ extractText 去掉了暗号',
      brain.extractText(mk2('ovo 帮我解释X')) === '帮我解释X',
      brain.extractText(mk2('ovo 帮我解释X')));

    // ---- L0：助手模式绕过冷却/抽样/长度 ----
    const l0 = brain.passHardRules('group:AM_T', mk2('ovo 请详细解释希尔排序'), 'GROUP_MESSAGE_CREATE', false);
    check('★ 助手模式在 L0 放行并标记 assistant',
      l0.ok === true && l0.assistant === true, l0);

    // ---- 代码层：助手模式下不做分段/不记反重复 ----
    const bsrc = require('fs').readFileSync(require('path').join(__dirname, 'brain.js'), 'utf8');
    check('助手模式不注入反重复提示', /const last = am\.on \? \[\] : recentReplyTexts/.test(bsrc));
    check('助手模式返回单段（不拆分答案）', /segments: \[r\.text\], assistant: true/.test(bsrc));

    // ---- ⭐ 助手模式必须绕过 L1 判断和抽签 ----
    // 实测 bug（2026-09-16）：发「ovo叫妈妈」→ 暗号识别正常、正文剥成"叫妈妈"，
    // 但 L1 判断器**看不到 ovo**，按普通闲聊打分给了 1 分 → 直接被拦，用户等半天没回复。
    // 正确逻辑：明确用暗号要答案，不该被"该不该插话"的判断器否决。
    const isrc = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    check('★ L1 判断被助手模式跳过', /if \(l0\.assistant\) \{[\s\S]{0,200}?跳过 L1 判断/.test(isrc));
    check('★ 抽签闸门也被助手模式绕过',
      /l0\.assistant \|\| Math\.random\(\) < cfg\.policy\.replyChance/.test(isrc));
    check('助手模式下 l0.assistant 确实被置为 true（上面已验）',
      (() => {
        const r2 = brain.passHardRules('group:AM_FLAG', mk2('ovo 测试'), 'GROUP_MESSAGE_CREATE', false);
        return r2.ok === true && r2.assistant === true;
      })());
  }

  console.log('\n=== 18. ⭐ 模型配置一致性（防跨服务商误配）===');
  {
    // 踩过的坑（2026-09-16 实测）：
    //   换服务商后，降级链里**还留着上一家的模型名**。
    //   于是主模型一过载，代码就去请求它，而新服务商直接报：
    //     HTTP 400 The supported API model names are ..., but you passed ...
    //   **降级不但没救场，反而变成了故障点。**
    const fb = cfg.ai.fallbackModels;
    const baseUrl = String(cfg.ai.baseUrl);
    console.log(`  baseUrl: ${baseUrl}`);
    console.log(`  降级链: ${JSON.stringify(fb)}   重试次数: ${cfg.ai.maxAttempts}`);

    check('降级链默认留空（避免跨服务商误配）', fb.length === 0, fb);
    check('maxAttempts ≥3（降级链为空时重试是唯一兜底）', cfg.ai.maxAttempts >= 3, cfg.ai.maxAttempts);
    check('退避基数不为 0', cfg.ai.retryBaseMs > 0, cfg.ai.retryBaseMs);

    if (fb.length) {
      // 判据：baseUrl 指向的服务商，必须能"认领"降级链里的每一个模型名。
      // 以后接新服务商，只要往这张表里加一行即可。
      const host = (baseUrl.match(/https?:\/\/([^/]+)/) || [, ''])[1];
      const known = [
        { host: /deepseek\.com/, prefix: /^deepseek-/ },
      ].find((k) => k.host.test(host));
      if (!known) console.log('  ⚠️ baseUrl 不是已知服务商，这条只做了弱校验');
      check('★ 降级链模型与 baseUrl 同服务商（跨服务商会 400，降级反成故障点）',
        !known || fb.every((m) => known.prefix.test(m)),
        { fb, baseUrl });
    } else {
      check('★ 降级链为空 → 天然不会跨服务商', true);
    }
  }

  console.log('\n=== 19. ⭐ 链接解析（平台识别 / 白名单 / 卡片 / 正文提取）===');
  {
    // ⚠️ 这一节**故意不联网** —— 自测要能离线、秒出、稳定。
    //    真机联网验证靠"群里发一条链接看卡片"，不在自测里做（会因网络抖动假红）。
    const lp = require('./linkparse');

    // --- 平台识别：必须按"域名后缀"，不能被 includes 绕过 ---
    check('github.com → github', lp.platformOf('github.com') === 'github');
    check('www.github.com → github（子域）', lp.platformOf('www.github.com') === 'github');
    check('b23.tv → bilibili', lp.platformOf('b23.tv') === 'bilibili');
    check('v.douyin.com → douyin', lp.platformOf('v.douyin.com') === 'douyin');
    check('www.iesdouyin.com → douyin', lp.platformOf('www.iesdouyin.com') === 'douyin');
    check('v.kuaishou.com → kuaishou', lp.platformOf('v.kuaishou.com') === 'kuaishou');
    check('★ v.m.chenzhongtech.com → kuaishou（快手短链中转域）',
      lp.platformOf('v.m.chenzhongtech.com') === 'kuaishou');
    check('★ notgithub.com 不算 github（防后缀绕过）', lp.platformOf('notgithub.com') === null);
    check('★ evil.com 不算任何平台', lp.platformOf('evil.com') === null);

    // --- 白名单：短链每一跳都要在里面 ---
    check('白名单含 douyin.com', lp.hostAllowed('douyin.com') === true);
    check('白名单含 iesdouyin.com（抖音短链中间跳）', lp.hostAllowed('iesdouyin.com') === true);
    check('白名单含 chenzhongtech.com（快手短链中间跳）', lp.hostAllowed('chenzhongtech.com') === true);
    check('白名单外域名被拒', lp.hostAllowed('evil.com') === false);
    check('空域名被拒', lp.hostAllowed('') === false);

    // --- 平台开关：4 个都该开着 ---
    const P = cfg.policy.linkParse.platforms;
    check('github / bilibili / douyin / kuaishou 四个开关都开',
      P.github === true && P.bilibili === true && P.douyin === true && P.kuaishou === true, P);

    // --- 正文提链：中文标点不能被吞进 URL ---
    const u1 = lp.extractUrls('看这个 https://v.douyin.com/IbTyOLmZyDY/ 挺好');
    check('中文句子里能提链', u1[0] === 'https://v.douyin.com/IbTyOLmZyDY/', u1);
    const u2 = lp.extractUrls('链接：https://www.bilibili.com/video/BV1xx411c7mD，后面还有字');
    check('★ 尾随的全角逗号不被吞进 URL',
      u2[0] === 'https://www.bilibili.com/video/BV1xx411c7mD', u2);
    const u3 = lp.extractUrls('https://github.com/a/b 和 https://v.kuaishou.com/JJYSn5HT');
    check('一条消息里的多个链接都提出来', u3.length === 2, u3);
    check('重复链接只算一次',
      lp.extractUrls('https://github.com/a/b https://github.com/a/b').length === 1);

    // --- findLink：普通消息 ---
    const lk = lp.findLink({ content: 'https://v.kuaishou.com/JJYSn5HT', message_type: 0 });
    check('findLink 认出快手短链并给出平台',
      lk && lk.platform === 'kuaishou' && lk.host === 'v.kuaishou.com', lk);
    check('findLink 认出抖音', lp.findLink({ content: 'https://v.douyin.com/IbTyOLmZyDY/', message_type: 0 }).platform === 'douyin');
    check('没有链接的消息 → null', lp.findLink({ content: '大家好', message_type: 0 }) === null);

    // --- findLink：递归扫 ark_data（转发卡片字段名不固定）---
    const ark = {
      content: '',
      message_type: 3,
      ark_data: {
        ark_type: 1,
        fields: [{ key: 'qqdocurl' }, { key: 'prompt', value: 'https://www.bilibili.com/video/BV1xx411c7mD' }],
        nested: { deep: { u: 'https://github.com/RelyLinYu/QQBot' } },
      },
    };
    const al = lp.findLink(ark);
    check('★ 能在 ark_data 深层里挖到链接', !!al, al);
    check('  └ 且平台识别正确', al && al.platform === 'bilibili', al);
    check('★ 深层 github 链接也能挖到',
      !!lp.findLink({ content: '', message_type: 3, ark_data: { a: { b: { c: 'https://github.com/RelyLinYu/QQBot' } } } }));

    // --- 冷却 / 每日上限 ---
    const sc = 'group:LINKTEST';
    check('首次可解析', lp.linkAllowed(sc).ok === true);
    lp.markLink(sc);
    const again = lp.linkAllowed(sc);
    check('★ 同群刚发过 → 被冷却拦住（防刷屏）',
      again.ok === false && /冷却/.test(again.why), again);
    check('别的群不受影响', lp.linkAllowed('group:LINKTEST2').ok === true);

    // --- Markdown 转义：只转义真正影响行内渲染的字符 ---
    check('★ 不转义连字符（否则出现 Xiaojingyu\\-QQbot）',
      lp._mdEsc('Xiaojingyu-QQbot') === 'Xiaojingyu-QQbot', lp._mdEsc('Xiaojingyu-QQbot'));
    check('不转义 . + ! # > 这几个',
      lp._mdEsc('v1.0 + 好！ #标签 > 引用') === 'v1.0 + 好！ #标签 > 引用');
    check('转义 * _ ` [ ] |（会影响行内渲染）', lp._mdEsc('a*b_c`d') === 'a\\*b\\_c\\`d');
    check('换行被压成空格（卡片里不能有裸 \\n）', lp._mdEsc('a\nb') === 'a b');

    // --- 时间 / 数字格式化 ---
    check('fmtDuration 秒 → 0:11', lp._fmtDuration(11) === '0:11');
    check('fmtDuration 分钟 → 13:04', lp._fmtDuration(784) === '13:04');
    check('fmtDuration 小时 → 1:02:03', lp._fmtDuration(3723) === '1:02:03');
    check('fmtNum 万', lp._fmtNum(10957) === '1.10 万', lp._fmtNum(10957));
    check('fmtNum 亿', lp._fmtNum(3.4e8) === '3.40 亿', lp._fmtNum(3.4e8));

    // --- closingJson：找"包住 anchor 的最小 JSON 对象" ---
    //     ⚠️ 这是快手解析的核心。最容易踩的坑：往前找**最近的** `{` 会找到
    //        一个已经闭合的兄弟对象，所以必须正向配平、取结束位置在 anchor 之后的。
    const html = 'var a={"x":1}; noise {"other":{"caption":"hello \\"}\\" world","id":"42"},"tail":1} after';
    const box = lp._enclosingJson(html, html.indexOf('"caption"') + 5);
    check('★ enclosingJson 找到包含 caption 的那个对象', !!box, box && box.raw);
    let obj = null;
    try { obj = JSON.parse(box.raw); } catch (e) { /* 交给下面的断言报错 */ }
    check('  └ 取的是**最小**那个（直接就是 caption 对象，id=42）',
      obj && obj.id === '42' && !obj.other, obj);
    check('  └ 字符串里的转义引号不会打乱配平', obj && obj.caption === 'hello "}" world',
      obj && obj.caption);

    // --- LD+JSON（抖音走这条）---
    const ldhtml = '<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>'
      + '<script type="application/ld+json">{"@type":"VideoObject","name":"标题 - 抖音","duration":"PT0H13M4S"}</script>';
    const vo = lp._extractLdJson(ldhtml, 'VideoObject');
    check('★ 能从多个 ld+json 块里挑出 VideoObject', !!vo && vo.name === '标题 - 抖音', vo);
    check('  └ 挑不到时返回 null', lp._extractLdJson(ldhtml, 'NotExist') === null);
    check('  └ 坏 JSON 块不会抛异常', lp._extractLdJson('<script type="application/ld+json">{bad}</script>', 'X') === null);

    // --- ISO8601 时长 ---
    check('PT0H13M4S → 784 秒', lp._parseIsoDuration('PT0H13M4S') === 784, lp._parseIsoDuration('PT0H13M4S'));
    check('PT1M → 60 秒', lp._parseIsoDuration('PT1M') === 60);
    check('PT45S → 45 秒', lp._parseIsoDuration('PT45S') === 45);
    check('垃圾输入 → 0（不抛）', lp._parseIsoDuration(null) === 0 && lp._parseIsoDuration('abc') === 0);

    // --- 卡片渲染：三种平台各自渲染，且都带 0 宽空格换行 + 图片 ---
    const cards = {
      github: lp.renderCard({
        platform: 'github', fullName: 'RelyLinYu/QQBot', owner: 'RelyLinYu', desc: '描述',
        stars: 12, forks: 3, issues: 0, created: '2026-01-01', pushed: '2026-09-01',
        language: 'JavaScript', license: 'MIT', topics: ['qq', 'bot'],
        ogImage: 'https://opengraph.githubassets.com/1/RelyLinYu/QQBot',
        htmlUrl: 'https://github.com/RelyLinYu/QQBot',
      }),
      bilibili: lp.renderCard({
        platform: 'bilibili', title: 'B站标题', bvid: 'BV1xx411c7mD',
        up: 'UP主', view: 100, like: 20, danmaku: 5, pubdate: '2020-01-01',
        duration: '3:00', cover: 'https://i0.hdslb.com/x.jpg', desc: '简介',
        htmlUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      }),
      douyin: lp.renderCard({
        platform: 'douyin', title: '抖音标题', author: '作者A', duration: '13:04',
        pubdate: '2026-09-05', like: 34146, view: 0, comment: 0,
        cover: 'https://p3-pc-sign.douyinpic.com/x.jpeg',
        htmlUrl: 'https://www.douyin.com/video/123',
      }),
      kuaishou: lp.renderCard({
        platform: 'kuaishou', title: '快手标题', author: '兔晴晴baby', duration: '0:11',
        pubdate: '2026-09-19', like: 10957, view: 66220, comment: 72,
        cover: 'https://p2.a.yximgs.com/x.jpg',
        htmlUrl: 'https://www.kuaishou.com/short-video/123',
      }),
    };
    for (const [k, c] of Object.entries(cards)) {
      check(`${k} 卡片渲染出来了`, typeof c === 'string' && c.length > 20, c);
      check(`  └ ${k} 用零宽空格换行（不是裸 \\n）`,
        c.includes('\u200B\n') && !/[^\u200B]\n/.test(c));
      check(`  └ ${k} 带图片`, /!\[.*\]\(https?:/.test(c));
      check(`  └ ${k} 带可点链接`, /\[🔗 .*\]\(https?:/.test(c));
    }
    check('抖音卡片用"抖音"字样', /在 抖音 打开/.test(cards.douyin));
    check('快手卡片用"快手"字样', /在 快手 打开/.test(cards.kuaishou));
    check('★ 卡片里没有半角空格紧跟加粗的写法（会被 QQ 吃掉）',
      !/\*\*[^*]+\*\* [^：]/.test(cards.kuaishou), cards.kuaishou);
    check('renderCard(null) → null（防上游传空）', lp.renderCard(null) === null);

    // --- ★ 抖音卡片必须带「发布」和「评论」，且不该出现"播放"（抖音没这个数据）---
    const dyCard = lp.renderCard({
      platform: 'douyin', title: '抖音标题', author: '作者A', duration: '13:04',
      pubdate: '2026-09-05', like: 34168, view: 0, comment: 2490,
      cover: 'https://p3.douyinpic.com/x.jpeg', coverSize: '#480px #360px',
      htmlUrl: 'https://www.iesdouyin.com/share/video/7681631364923329842/',
    });
    check('★ 抖音卡片有「发布」（旧 bug：整行消失）', /发布.*2026-09-05/.test(dyCard), dyCard);
    check('★ 抖音卡片有「评论」（旧 bug：commentCount 读漏了）',
      /评论 2490/.test(dyCard), dyCard);
    check('★ 抖音卡片不显示「播放」（抖音的数据里根本没有播放量）',
      !/播放/.test(dyCard), dyCard);
    check('★ 抖音卡片的「打开」链接是手机 H5 页，不是抖音精选 PC 版',
      /\[🔗 .*\]\(https:\/\/www\.iesdouyin\.com\/share\/video\//.test(dyCard)
      && !/douyin\.com\/video\//.test(dyCard), dyCard);

    // --- 一条消息里的多个链接（用户 2026-09-22 实测踩到：快手那条被静默丢掉）---
    const two = 'https://v.douyin.com/IbTyOLmZyDY/ https://v.kuaishou.com/JJYSn5HT';
    const twoLinks = lp.findLinks({ content: two, message_type: 0 });
    check('★ 一条消息里两个链接都要认（旧版只认第一个，第二个被静默丢掉）',
      twoLinks.length === 2, twoLinks.map((x) => x.platform));
    check('  └ 顺序按出现顺序', twoLinks[0].platform === 'douyin' && twoLinks[1].platform === 'kuaishou',
      twoLinks.map((x) => x.platform));
    check('  └ findLink 仍然只返回第一个（老接口兼容）',
      lp.findLink({ content: two, message_type: 0 }).platform === 'douyin');
    check(`  └ maxLinksPerMessage 默认是 2（被动回复配额只有 5 条）`,
      cfg.policy.linkParse.maxLinksPerMessage === 2, cfg.policy.linkParse.maxLinksPerMessage);
    const capped = lp.findLinks({
      content: 'https://github.com/a/b https://b23.tv/x https://v.douyin.com/y/ https://v.kuaishou.com/z',
      message_type: 0,
    });
    check('  └ 超过上限时截断，不会无限发（配额会爆）', capped.length === 2, capped.length);
    check('  └ 上限可以传参调大', lp.findLinks({ content: two, message_type: 0 }, 5).length === 2);

    // --- 封面尺寸：竖屏不能被压扁（用户 2026-09-22 反馈「竖屏都被压缩了」）---
    check('★ 竖屏封面（320×640，1:2）→ 用窄框，不再套 16:9',
      lp._coverSize(320, 640) === '#240px #480px', lp._coverSize(320, 640));
    check('★ 9:16 竖屏 → 也是窄框', lp._coverSize(720, 1280) === '#240px #427px', lp._coverSize(720, 1280));
    check('  横屏 16:9（1920×1080）→ 保持原来的 480×270',
      lp._coverSize(1920, 1080) === '#480px #270px', lp._coverSize(1920, 1080));
    check('  4:3（440×330，抖音 SEO 封面就是它）→ 按 4:3 出，不拉成 16:9',
      lp._coverSize(440, 330) === '#480px #360px', lp._coverSize(440, 330));
    check('  高得离谱的比例（1:10）高度被夹在 480', lp._coverSize(100, 1000) === '#240px #480px');
    check('  宽得离谱的比例（10:1）高度被夹在 150', lp._coverSize(1000, 100) === '#480px #150px');
    check('★ 探测不到尺寸时退回 16:9（绝不因此报错）',
      lp._coverSize(0, 0) === '#480px #270px' && lp._coverSize(undefined, undefined) === '#480px #270px');
    check('probeCoverSize 开关存在且默认开', cfg.policy.linkParse.probeCoverSize === true);

    // --- imageSize：从图片字节头读尺寸（离线用构造的字节）---
    //     ⚠️ 这里**不打网络**，直接喂构造出来的文件头，验证解析逻辑本身。
    //        JPEG 的 SOF 里 **高在 +5、宽在 +7** —— 写反了就会得到转置的卡片，必须测。
    const jpeg = Buffer.concat([
      Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.alloc(12),        // APP0
      Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08]),                                // SOF0, 精度8
      Buffer.from([0x01, 0x40, 0x02, 0x80]),                                      // 高=320 宽=640
      Buffer.alloc(16),
    ]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]),
      Buffer.from('IHDR'), Buffer.from([0, 0, 0x01, 0xE0, 0, 0, 0x02, 0x80]), Buffer.alloc(8),
    ]);
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0xE0, 0x01, 0x80, 0x02]), Buffer.alloc(16)]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    // 用一个临时 HTTP 桩把构造的字节喂给 imageSize（避免真的联网）
    const realFetch = global.fetch;
    let stubBuf = jpeg;
    global.fetch = async () => ({ ok: true, status: 206, arrayBuffer: async () => stubBuf });
    const jd = await lp._imageSize('http://stub/x.jpg');
    check('★ imageSize 读 JPEG：宽 640 / 高 320（高在 +5、宽在 +7，写反就转置）',
      jd && jd.w === 640 && jd.h === 320, jd);
    stubBuf = png;
    const pd = await lp._imageSize('http://stub/x.png');
    check('imageSize 读 PNG：宽 480 / 高 640', pd && pd.w === 480 && pd.h === 640, pd);
    stubBuf = gif;
    const gd = await lp._imageSize('http://stub/x.gif');
    check('imageSize 读 GIF：宽 480 / 高 640', gd && gd.w === 480 && gd.h === 640, gd);
    stubBuf = svg;
    check('★ 认不出的格式（SVG）→ null（不抛，让卡片退回 16:9）',
      await lp._imageSize('http://stub/x.svg') === null);
    global.fetch = async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) });
    check('★ HTTP 403 → null（封面被防盗链挡住也不会炸）', await lp._imageSize('http://stub/403.jpg') === null);
    global.fetch = async () => { throw new Error('network down'); };
    check('★ 网络异常 → null（绝不抛到主流程）', await lp._imageSize('http://stub/err.jpg') === null);
    global.fetch = realFetch;

    // --- 日期容错：抖音给的 uploadDate 是**坏值**（末尾多一个 Z）---
    //     ⚠️ 用户 2026-09-22 反馈「抖音卡片没有发布时间」就是这个：
    //        旧的 `new Date('2026-09-05T17:00:00+08:00Z')` → Invalid Date
    //        → fmtDate 返回空串 → 卡片上「发布」被**静默跳过**（连日志都没有）。
    check('★ 抖音的坏日期能被修正（偏移量后面多余的 Z）',
      lp._fixIso('2026-09-05T17:00:00+08:00Z') === '2026-09-05T17:00:00+08:00',
      lp._fixIso('2026-09-05T17:00:00+08:00Z'));
    // ⚠️ 这里不写死 '2026-09-05' —— 具体日期取决于运行机器的时区。
    //    真正要锁住的是「**不再是空串**」（旧的 bug 就是返回空串、静默少一行）。
    const dyDate = lp._fmtDate('2026-09-05T17:00:00+08:00Z');
    check('★ 坏日期不再返回空串（旧 bug：卡片上「发布」整行消失）',
      /^2026-09-0[456]$/.test(dyDate), JSON.stringify(dyDate));
    check('  正常 ISO 照常工作',
      lp._fmtDate('2020-01-01T12:00:00Z') === '2020-01-01', lp._fmtDate('2020-01-01T12:00:00Z'));
    check('  带偏移量的也照常工作',
      lp._fmtDate('2020-01-01T12:00:00+08:00') === '2020-01-01',
      lp._fmtDate('2020-01-01T12:00:00+08:00'));
    check('  垃圾输入仍然返回空串（不抛）',
      lp._fmtDate('abc') === '' && lp._fmtDate('') === '' && lp._fmtDate(null) === '');

    // --- 卡片里真的用上了算出来的尺寸 ---
    const portraitCard = lp.renderCard({
      platform: 'kuaishou', title: '竖屏', author: 'A', duration: '0:11',
      like: 1, view: 2, comment: 3, coverSize: '#240px #480px',
      cover: 'https://p2.a.yximgs.com/x.jpg', htmlUrl: 'https://www.kuaishou.com/short-video/1',
    });
    check('★ coverSize 会被渲染进卡片', portraitCard.includes('#240px #480px'), portraitCard);
    check('  没传 coverSize 时退回 16:9（老行为不变）',
      lp.renderCard({ platform: 'kuaishou', title: 'x', cover: 'https://a/x.jpg', htmlUrl: 'https://a/b' })
        .includes('#480px #270px'));

    // --- 🔴 回归①：同一条消息里"指向同一个东西"的多个链接只能发一张卡 ---
    //
    // 真实事件（2026-09-23T01:22:49，群友转发的 GitHub 监控）里有 3 个 issue 链接：
    //   .../issues/141、.../issues/140、.../issues/136
    // 全指向同一个仓库。旧版**按 URL 去重** → 一个都不少 → 发了 2 张一模一样的卡片。
    check('★ linkKey：GitHub 的 issue/commit 链接都归到**仓库**这个身份',
      lp.linkKey('https://github.com/a/b/issues/141', 'github') === 'github:a/b'
      && lp.linkKey('https://github.com/a/b/commit/abc123', 'github') === 'github:a/b'
      && lp.linkKey('https://github.com/A/B', 'github') === 'github:a/b', '大小写要归一');
    {
      // ⚠️ 这里用 `message_type: 0`（普通消息）而不是 102 ——
      //    因为 2026-09-23 起 **102（转发聊天记录）整个不解析**（见本组回归④）。
      //    去重逻辑本身仍然要测，所以换成一个"会被解析"的类型。
      //    （现实中也成立：有人一条消息里粘好几个链接）
      const merged = {
        message_type: 0,
        content: 'GitHub监控\n'
          + '新增 Issue #141 https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/141\n'
          + '新增 Issue #140 https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/140\n'
          + '新增 Issue #136 https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/136',
      };
      const got = lp.findLinks(merged, 2);
      check('★★ 三个 issue 链接（同一仓库）→ 只算**一条**（旧版会发 2 张一样的卡）',
        got.length === 1, got.map((x) => x.key));
      check('  └ 返回的 link 里带 key（给 index.js 判重和记"刚发过"用）',
        !!got[0] && got[0].key === 'github:meteornox/deepseek-balance-whale-widget', got[0] && got[0].key);
    }
    check('  linkKey：B站按 BV 号',
      lp.linkKey('https://www.bilibili.com/video/BV1xx411c7mD?p=2', 'bilibili') === 'bilibili:BV1xx411c7mD');
    check('  linkKey：抖音按视频 id（长链）',
      lp.linkKey('https://www.iesdouyin.com/share/video/7687919372530262739/', 'douyin') === 'douyin:7687919372530262739');
    check('  linkKey：短链里没有 id，先用 URL 兜底（解析后会有 infoKey 补上）',
      lp.linkKey('https://v.douyin.com/X29sAeylqig/', 'douyin').startsWith('url:'));
    check('★ linkKey 和 infoKey **格式一致**（否则短链解析出来的 id 对不上长链）',
      lp.linkKey('https://www.iesdouyin.com/share/video/7687919372530262739/', 'douyin')
      === lp.infoKey({ platform: 'douyin', id: '7687919372530262739' }),
      [lp.linkKey('https://www.iesdouyin.com/share/video/7687919372530262739/', 'douyin'),
        lp.infoKey({ platform: 'douyin', id: '7687919372530262739' })]);
    check('  infoKey：GitHub 用 fullName、B站用 bvid',
      lp.infoKey({ platform: 'github', fullName: 'A/B' }) === 'github:a/b'
      && lp.infoKey({ platform: 'bilibili', bvid: 'BV1xx411c7mD' }) === 'bilibili:BV1xx411c7mD');
    check('  infoKey 对空值安全', lp.infoKey(null) === '' && lp.infoKey({ platform: 'github' }) === 'github:');

    // --- 🔴 回归②：引用"机器人自己发的卡片"不能再解析一遍 ---
    //
    // 真实事件（2026-09-23T12:20:24）：群友引用机器人的抖音卡片 + 问「？」，
    // 而 QQ 把**整张卡片的 markdown 原样喂回来**（含 `[🔗 在 抖音 打开](...)`）：
    //   msg_elements[0].content = "# 戴夫…\n![封面 #480px #360px](https://qqbot.ugcimg.cn/…)…"
    // → 旧版把自己刚发的链接又解析一遍 → 卡片又发一次。
    const OUR_CARD = '# 戴夫，你这要挨不少电吧 #植物大战僵尸 #拟人#同人 #樱桃炸弹 #娘化 画师@…\u200B\n'
      + '![封面 #480px #360px](https://qqbot.ugcimg.cn/1905611136/abc/def)\u200B\n'
      + '**作者**：铁板欧尼酱　**时长**：0:06\u200B\n'
      + '**发布**：2026-09-21\u200B\n'
      + '点赞 17.55 万　·　评论 1234\u200B\n'
      + '[🔗 在 抖音 打开](https://www.iesdouyin.com/share/video/7687919372530262739/)';
    check('  （前提）这段引用内容里确实有抖音链接',
      /iesdouyin\.com\/share\/video\//.test(OUR_CARD));
    check('★ 这段内容带"我们自己卡片"的指纹（零宽空格+换行）',
      OUR_CARD.includes('\u200B\n'));
    const quoted = {
      message_type: 103,
      content: `<@BOT0PEN1D000000000000000000000000> ？`,
      mentions: [{ is_you: true, bot: true }],
      msg_elements: [{ content: OUR_CARD, msg_type: 103 }],
    };
    check('★★ 引用机器人自己发的卡片 → **不再解析出链接**（旧版会再发一张卡）',
      lp.findLinks(quoted, 2).length === 0, lp.findLinks(quoted, 2));

    // 但**引用普通人的含链接消息**仍然要能解析（别把功能一起关掉）
    // ⚠️ 用白名单内的域名 —— 实测真机里那条 `chatboxai.app` 本来就被白名单挡着
    //    （那是"防 SSRF"的设计，不是 bug）
    const quoteHuman = {
      message_type: 103,
      content: `<@BOT0PEN1D000000000000000000000000> 这是啥`,
      mentions: [{ is_you: true, bot: true }],
      msg_elements: [{ content: '看看这个 https://www.bilibili.com/video/BV1xx411c7mD 挺好', msg_type: 103 }],
    };
    check('★ 引用**普通人**发的链接 → 仍然照常解析（别把功能一起关掉）',
      lp.findLinks(quoteHuman, 2).length === 1, lp.findLinks(quoteHuman, 2));

    // --- 🔴 回归③："刚发过"记忆（第二道防线，治"过一会儿又引用一次"）---
    {
      const S = 'group:CARDED_TEST';
      check('  还没发过 → wasCarded 返回 0', lp.wasCarded(S, ['douyin:123']) === 0);
      lp.markCarded(S, ['douyin:123', 'url:https://v.douyin.com/xxx/']);
      check('★ 发过之后 → 两个 key 都算"刚发过"',
        lp.wasCarded(S, ['douyin:123']) > 0 && lp.wasCarded(S, ['url:https://v.douyin.com/xxx/']) > 0);
      check('★ 别的群不算（同一个链接发到另一个群，那边该收到卡）',
        lp.wasCarded('group:OTHER_GROUP', ['douyin:123']) === 0);
      const realTtl = cfg.policy.linkParse.cardedTtlMs;
      try {
        cfg.policy.linkParse.cardedTtlMs = 1;      // 把窗口缩到 1ms
        const until = Date.now() + 12;
        while (Date.now() < until) { /* 忙等 */ }
        check('  窗口过了就不算"刚发过"了（可以让它再发一次）',
          lp.wasCarded(S, ['douyin:123']) === 0);
      } finally { cfg.policy.linkParse.cardedTtlMs = realTtl; }
      check(`  cardedTtlMs 默认 10 分钟（现 ${cfg.policy.linkParse.cardedTtlMs / 60000} 分钟）`,
        cfg.policy.linkParse.cardedTtlMs === 600000);
    }

    // --- 🔴 回归④：转发的聊天记录（message_type=102）**不解析**里面的链接 ---
    //
    // 用户 2026-09-23 要求。源头是真事故：一条转发的「GitHub 监控」聊天记录里
    // 塞了 3 个 issue 链接（全指向同一个仓库）→ 发了 2 张一样的卡。
    // 上一轮修的是去重；这一轮按用户要求**彻底不看这种消息**。
    //
    // ⚠️ 只挡 102。引用消息 103 不挡 —— 那是"有人指着链接问"，是正常分享意图。
    {
      const forward = {
        message_type: 102,
        content: '【GitHub监控】\n🆕 新增 Issue #141 建议给浮层层级表达一个…\n'
          + '🔗 https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/141\n'
          + '🆕 新增 Issue #140 出厂台词与默认泡泡文案…\n'
          + '🔗 https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/140',
      };
      check('  （前提）这条转发记录里确实有 GitHub 链接',
        /github\.com\/MeteorNOX/.test(forward.content));
      check('★★ 转发的聊天记录 → **一条链接都不解析**（用户 2026-09-23 要求）',
        lp.findLinks(forward, 2).length === 0, lp.findLinks(forward, 2).map((x) => x.url));

      check('★ 开关能关掉（设成 false 恢复旧行为，便于哪天想改回来）', (() => {
        const real = cfg.policy.linkParse.skipForwarded;
        try {
          cfg.policy.linkParse.skipForwarded = false;
          return lp.findLinks(forward, 2).length > 0;
        } finally { cfg.policy.linkParse.skipForwarded = real; }
      })());

      // 🔴 引用消息**不能**被一起挡掉（那是正常分享意图）
      const quote103 = {
        message_type: 103,
        content: '<@BOT0PEN1D000000000000000000000000> 这是啥',
        mentions: [{ is_you: true, bot: true }],
        msg_elements: [{ content: '看看 https://github.com/a/b', msg_type: 103 }],
      };
      check('★★ 引用消息（103）**照常解析** —— 别把"转发记录"和"引用"搞混',
        lp.findLinks(quote103, 2).length === 1, lp.findLinks(quote103, 2).map((x) => x.key));

      check('  普通消息（0）照常解析',
        lp.findLinks({ message_type: 0, content: '看这个 https://github.com/a/b' }, 2).length === 1);

      check('  skipForwarded 默认开着', cfg.policy.linkParse.skipForwarded === true);
      check('  类型判断用 Number() 强转（字段可能是字符串 "102"）',
        lp.findLinks({ message_type: '102', content: 'x https://github.com/a/b' }, 2).length === 0);
    }

  }

  console.log('\n=== 20. ⭐ 识图（图片/表情包 → 可读文本）===');
  {
    // ⚠️ 和链接解析那组一样：**故意不联网**。
    //    真机联网验证靠"群里发个表情包看它认不认得"，不放进自测
    //    （否则网络一抖就"假红"，而且会把钱花在自测里）。
    const vision = require('./vision');
    const BOT = 'BOT0PEN1D000000000000000000000000';

    // --- 格式嗅探：**不信 filename**（实测 QQ 给过 .jpg 后缀但内容是 GIF）---
    const B = (arr) => Buffer.from(arr);
    const mk = (head, tail = []) => Buffer.concat([B(head), Buffer.alloc(16), B(tail)]);
    check('★ JPEG 嗅探（ffd8ff）', vision.sniffMime(mk([0xFF, 0xD8, 0xFF, 0xE0])) === 'image/jpeg');
    check('★ PNG 嗅探（89504e47）',
      vision.sniffMime(mk([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) === 'image/png');
    check('★ GIF 嗅探（474946）', vision.sniffMime(mk(B('GIF89a'))) === 'image/gif');
    check('★ WebP 嗅探（RIFF....WEBP）',
      vision.sniffMime(Buffer.concat([
        B('RIFF'), B([0, 0, 0, 0]), B('WEBP'), Buffer.alloc(16),
      ])) === 'image/webp');
    check('  垃圾字节 → 空串（让上层报错，别硬猜）', vision.sniffMime(mk(B('hello world!'))) === '');
    check('  太短的 buffer → 空串（不越界读）', vision.sniffMime(B([0xFF, 0xD8])) === '');
    check('  null / undefined → 空串', vision.sniffMime(null) === '' && vision.sniffMime(undefined) === '');

    // --- findImage：QQ 推图片时 message_type 是 0，图片在 attachments 里 ---
    const imgMsg = {
      message_type: 0,
      content: '',
      attachments: [{
        content_type: 'image/gif',
        filename: '120A6FDE.jpg',        // ← 故意写 .jpg：实测 QQ 就是这么给的
        width: 120, height: 120, size: 82933,
        url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=x&rkey=y',
      }],
    };
    const found = vision.findImage(imgMsg);
    check('★ 能从 attachments 里找到图片（真机数据）', !!found, found);
    check('  └ 拿到 url / content_type / 宽高',
      /^https:\/\/multimedia\.nt\.qq\.com\.cn\//.test(found.url)
      && found.contentType === 'image/gif' && found.width === 120, found);
    check('★ 视频附件不算图片（video/mp4 要被跳过）',
      vision.findImage({ message_type: 0, attachments: [{ content_type: 'video/mp4', url: 'https://a/b.mp4' }] }) === null);
    check('  纯文本消息 → null',
      vision.findImage({ message_type: 0, content: '你好', attachments: [] }) === null);
    check('  content_type 是 image 但 url 不是 http → 不算（防脏数据）',
      vision.findImage({ attachments: [{ content_type: 'image/jpeg', url: 'ftp://a/b.jpg' }] }) === null);
    check('  地址放在 content 里也认（另一种形态）',
      !!vision.findImage({ attachments: [{ content_type: 'image/jpeg', content: 'https://a/b.jpg' }] }));
    check('  多个附件时取第一张图（跳过前面的视频）',
      vision.findImage({
        attachments: [
          { content_type: 'video/mp4', url: 'https://a/v.mp4' },
          { content_type: 'image/png', url: 'https://a/p.png' },
        ],
      }).contentType === 'image/png');
    check('★ 引用消息里的图（msg_elements）也能找到',
      !!vision.findImage({ message_type: 103, msg_elements: [{ content_type: 'image/jpeg', url: 'https://a/b.jpg' }] }));

    // hasImage：不看开关，纯看数据
    check('hasImage 认得附件里的图', vision.hasImage(imgMsg) === true);
    check('hasImage 对纯文本为假', vision.hasImage({ content: 'x' }) === false);
    check('hasImage 对 null 为假（不抛）', vision.hasImage(null) === false);

    // 关掉开关后 findImage 要立刻不认
    const vCfg = cfg.policy.vision;
    const savedEnabled = vCfg.enabled;
    vCfg.enabled = false;
    check('★ 开关关掉后 findImage 直接返回 null', vision.findImage(imgMsg) === null);
    check('  └ 但 hasImage 仍然为真（它是纯数据判断，开关由上层管）', vision.hasImage(imgMsg) === true);
    vCfg.enabled = savedEnabled;

    // --- ⭐ 核心：识图结果必须被 extractText「看见」---
    //     这是整个功能的枢纽：只改 extractText 一处，L0/L1/L2 和上下文就都看得见图。
    const onlyImg = { message_type: 0, content: '', __vision: '一只流泪吃面的猫' };
    check('★ 只有图片时：文本变成「【图片】描述」',
      brain.extractText(onlyImg) === '【图片】一只流泪吃面的猫', brain.extractText(onlyImg));
    const textImg = { message_type: 0, content: '这个好搞笑', __vision: '一只流泪吃面的猫' };
    check('★ 图文都有时：两段都在，且能分清哪句是图',
      brain.extractText(textImg) === '这个好搞笑（附带图片：一只流泪吃面的猫）',
      brain.extractText(textImg));
    check('  没有识图结果时行为完全不变',
      brain.extractText({ message_type: 0, content: '你好' }) === '你好');
    // ⚠️ QQ 的表情标记是**协议字段**（给客户端渲染用的），不能被当正文喂给模型。
    //    实测：一个表情包消息的 content 就只有这串东西，加上识图后它会进到提示词里。
    check('★ QQ 的表情标记被清掉，不会当正文喂给模型',
      brain.stripAtMentions('<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">') === '',
      JSON.stringify(brain.stripAtMentions('<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">')));
    check('  └ 表情标记 + 真实文字时，只留文字',
      brain.extractText({ message_type: 0, content: '哈哈<faceType=6,faceId="0",ext="x">这个好笑' })
        === '哈哈 这个好笑',
      brain.extractText({ message_type: 0, content: '哈哈<faceType=6,faceId="0",ext="x">这个好笑' }));
    check('  └ 商城表情 <emoji:...> 也清掉',
      brain.stripAtMentions('笑死<emoji:1234>') === '笑死');
    check('  └ 普通尖括号文字不受影响（别误伤）',
      brain.stripAtMentions('a < b > c') === 'a < b > c');
    check('  空 __vision 不影响（不是所有消息都有图）',
      brain.extractText({ message_type: 0, content: '你好', __vision: '' }) === '你好');
    check('★ hasUsableText 认为"只有图"也是可用内容（旧版判它为空消息）',
      brain.hasUsableText(onlyImg) === true);
    check('  引用消息 + 图片：引用原文和图片描述都在',
      brain.extractText({
        message_type: 103, content: '',
        msg_elements: [{ content: '被引用的原文' }], __vision: '一只猫',
      }).includes('被引用的原文') && brain.extractText({
        message_type: 103, content: '',
        msg_elements: [{ content: '被引用的原文' }], __vision: '一只猫',
      }).includes('一只猫'));

    // --- 🔴 回归：@机器人 + 一张表情包，不能被当成"只有@"回一句"咋了" ---
    //     踩点：这种消息 content 只有 <@openid>、mentions 有 is_you，
    //     正好满足 isMentionOnly 的路径 B → 回「咋了」→ 图白看了。
    const atStickerNoVision = {
      message_type: 0, content: `<@${BOT}>`,
      mentions: [{ is_you: true, bot: true }],
    };
    check('  （前提）没有识图结果时，@ + 空内容 = 纯 @（回"咋了"）',
      brain.isMentionOnly('GROUP_MESSAGE_CREATE', atStickerNoVision) === true);
    const atSticker = { ...atStickerNoVision, __vision: '一只熊猫头在憋笑' };
    check('★ @ + 表情包：识图后就【不是】纯 @ 了（旧逻辑会回"咋了"、图白看）',
      brain.isMentionOnly('GROUP_MESSAGE_CREATE', atSticker) === false);
    check('  └ 且能通过 L0（会被认真回一句）',
      brain.passHardRules('group:VISION_TEST', atSticker, 'GROUP_MESSAGE_CREATE', false).ok === true);

    // --- 限流：识图有自己一套，不共用 dailyCallLimit ---
    const s = 'group:VISION_TEST2';
    check('首次可识图', vision.visionAllowed(s).ok === true);
    vision.markVision(s);
    const again = vision.visionAllowed(s);
    check('★ 同群刚识别过 → 被冷却拦住（防表情包连发烧钱）',
      again.ok === false && /冷却/.test(again.why), again);
    check('别的群不受影响', vision.visionAllowed('group:VISION_TEST3').ok === true);
    check(`识图上限是独立的（${cfg.policy.vision.dailyLimit}，不共用 dailyCallLimit ${cfg.policy.dailyCallLimit}）`,
      cfg.policy.vision.dailyLimit === 300 && cfg.policy.vision.dailyLimit !== cfg.policy.dailyCallLimit);

    // --- 配置健全性 ---
    check('识图默认开着', cfg.policy.vision.enabled === true);
    check('★ detail 用 low（缩到 512×512，一张约 220 token）',
      cfg.policy.vision.detail === 'low', cfg.policy.vision.detail);
    check('★ 识图**不单独配模型名**（用 ai.replyModel，避免跨服务商误配）',
      !('model' in cfg.policy.vision), Object.keys(cfg.policy.vision));
    check('  单图上限 8MB（base64 后约 11MB，低于 48MiB 请求体上限）',
      cfg.policy.vision.maxMB === 8, cfg.policy.vision.maxMB);
    check('  有提示词（不能空着，否则模型只能瞎猜）',
      typeof cfg.policy.vision.prompt === 'string' && cfg.policy.vision.prompt.length > 20);

    // --- 🔴 引用图片 + @机器人（用户 2026-09-22 真机踩到：回了"咋了"）---
    //
    //     真机数据长这样（message_type=103）：
    //       content     = "<@机器人>"        ← 只有 @ 标记
    //       msg_elements= 空                 ← 被引用的是图片，没有文字
    //       attachments = 无                 ← 🔴 被引用的图片附件**根本不给**
    //       message_scene.ext = ["ref_msg_idx=REFIDX_A", "msg_idx=REFIDX_B"]
    //     解法：收到图时记下 "自己的 msg_idx → 描述"，引用时用 ref_msg_idx 查回来。
    const IMG_MSG = {
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_IMG1', 'auth_token=x'] },
    };
    check('  msgIdxOf 能从 message_scene.ext 里取出 msg_idx',
      vision.msgIdxOf(IMG_MSG) === 'REFIDX_IMG1', vision.msgIdxOf(IMG_MSG));
    check('  没有 message_scene 时不崩，返回空串',
      vision.msgIdxOf({}) === '' && vision.msgIdxOf(null) === '');

    const QUOTE_MSG = {
      message_type: 103,
      content: `<@${BOT}>`,
      mentions: [{ is_you: true, bot: true }],
      message_scene: { ext: ['ref_msg_idx=REFIDX_IMG1', 'msg_idx=REFIDX_QUOTE1', 'auth_token=y'] },
    };
    check('  refIdxOf 能取出 ref_msg_idx（引用指向的那条）',
      vision.refIdxOf(QUOTE_MSG) === 'REFIDX_IMG1', vision.refIdxOf(QUOTE_MSG));
    check('  msg_idx 和 ref_msg_idx 是两个不同的值（别搞混）',
      vision.msgIdxOf(QUOTE_MSG) === 'REFIDX_QUOTE1' && vision.refIdxOf(QUOTE_MSG) === 'REFIDX_IMG1');

    const VSCOPE = 'group:QUOTE_TEST';
    check('  还没记过 → 查不到', vision.getImageDesc(VSCOPE, 'REFIDX_IMG1') === '');
    vision.rememberImage(VSCOPE, 'REFIDX_IMG1', '叼梨猫支啤的谐音梗表情包');
    check('★ 记下之后能按 msg_idx 查回来',
      vision.getImageDesc(VSCOPE, 'REFIDX_IMG1') === '叼梨猫支啤的谐音梗表情包');
    check('  别的群查不到（缓存按群隔离，别串台）',
      vision.getImageDesc('group:OTHER', 'REFIDX_IMG1') === '');
    check('★ 引用命中后，extractText 就能拿到图（于是不会回"咋了"）', (() => {
      const m = { ...QUOTE_MSG };
      m.__vision = vision.getImageDesc(VSCOPE, vision.refIdxOf(m));
      return brain.isMentionOnly('GROUP_MESSAGE_CREATE', m) === false
        && brain.extractText(m).includes('叼梨猫支啤');
    })());

    // ② 兜底：刚发过图，紧接着只 @ 它（图和 @ 是两条消息）
    const RSCOPE = 'group:RECENT_TEST';
    check('  还没图 → 查不到"最近一张"', vision.recentImageDesc(RSCOPE, 60000) === '');
    vision.rememberImage(RSCOPE, 'REFIDX_X', '一只流泪吃面的猫');
    check('★ 记下之后能查到"本群最近一张"',
      vision.recentImageDesc(RSCOPE, 60000) === '一只流泪吃面的猫');
    check('★ 窗口过了就查不到（别把几十秒前的图硬扯进来）',
      vision.recentImageDesc(RSCOPE, -1) === '');
    check('  别的群没有（按群隔离）', vision.recentImageDesc('group:OTHER2', 60000) === '');

    // ⚠️ 顺序问题：先用 isMentionOnly 判断"要不要兜底"，**再**设 __vision。
    //    设完之后它就不算纯 @ 了 —— 这是先有鸡还是先有蛋，顺序反了就兜不住。
    const bareAt = {
      message_type: 0, content: `<@${BOT}>`, mentions: [{ is_you: true, bot: true }],
    };
    check('★ 顺序：设 __vision 之前，isMentionOnly 为真（才能触发兜底）',
      brain.isMentionOnly('GROUP_MESSAGE_CREATE', bareAt) === true);
    bareAt.__vision = vision.recentImageDesc(RSCOPE, 60000);
    check('  └ 设完之后为假（于是会真的回一句，而不是"咋了"）',
      brain.isMentionOnly('GROUP_MESSAGE_CREATE', bareAt) === false);

    // 配置健全性
    check(`imageCacheMs 默认 10 分钟（${cfg.policy.vision.imageCacheMs}）`,
      cfg.policy.vision.imageCacheMs === 10 * 60 * 1000);
    check(`recentImageMs 默认 60 秒（不能调太宽，否则会误伤）`,
      cfg.policy.vision.recentImageMs === 60000, cfg.policy.vision.recentImageMs);

    // --- 同一张图只认一次（按内容 md5 去重）---
    //
    // 实测依据（2026-09-22）：QQ 的 fileid **每次都变**，没法用来去重；
    // 但按大小+尺寸看，群里图片重复率 **28.6%**，一个表情包被发了 21 次。
    check('去重配置存在（24 小时 / 最多 1000 张）',
      cfg.policy.vision.dedupeTtlMs === 24 * 60 * 60 * 1000 && cfg.policy.vision.dedupeMax === 1000,
      [cfg.policy.vision.dedupeTtlMs, cfg.policy.vision.dedupeMax]);
    check('★ markVision(scope, false) 用来表示"没花钱"（缓存命中不占今日张数）',
      vision.markVision.length >= 1);
    // 真走一遍：第一次调模型，第二次必须**一次模型都不调**
    {
      const realFetchC = global.fetch;
      const jpg = Buffer.alloc(64);
      jpg[0] = 0xFF; jpg[1] = 0xD8; jpg[2] = 0xFF; jpg[3] = 0xE0;
      jpg[4] = 0x00; jpg[5] = 0x10;
      jpg[18] = 0xFF; jpg[19] = 0xC0; jpg[20] = 0x00; jpg[21] = 0x11; jpg[22] = 0x08;
      jpg[23] = 0x01; jpg[24] = 0x40; jpg[25] = 0x02; jpg[26] = 0x80;
      let modelCalls = 0;
      global.fetch = async (url) => {
        if (String(url).startsWith('http://stub/img')) {
          return { ok: true, status: 206, headers: { get: () => null }, arrayBuffer: async () => jpg };
        }
        modelCalls++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            choices: [{ message: { content: '一只猫' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        };
      };
      const r1 = await vision.describe({ url: 'http://stub/img', contentType: 'image/jpeg' }, () => {});
      check('★ 第一次识图 → 真调模型，返回 { desc, cached:false }',
        r1 && r1.desc === '一只猫' && r1.cached === false, r1);
      check('  └ 确实花了 1 次模型调用', modelCalls === 1, modelCalls);
      const r2 = await vision.describe({ url: 'http://stub/img', contentType: 'image/jpeg' }, () => {});
      check('★ 第二次同一张图 → 命中缓存，描述一样、cached:true',
        r2 && r2.desc === '一只猫' && r2.cached === true, r2);
      check('★★ 而且**没有再调模型**（0 token，这就是省下来的）',
        modelCalls === 1, `模型调用次数=${modelCalls}`);
      global.fetch = realFetchC;
    }

    // --- 🆕 GitHub 预览图走自建中转（2026-09-22）---
    //
    // 起因：用户反馈「GitHub 卡片的图片读取不到的情况还是太多」。
    // 根因：官方文档说 markdown 里的图「开放平台会下载转存」→ QQ **发卡片那一刻抓一次**、
    //      失败不重试；而 GitHub 的预览图接口**间歇性 429**（实测密集请求 20%~50%）。
    // 所以让 QQ 抓我们（我们能重试+缓存）。已实测 QQ 会来抓、且接受 http://。
    const ogc = require('./tools/ogcache');
    const lp = require('./linkparse');     // 第 19 组里也 require 过，这里按需再取一次（模块有缓存）

    // ① 地址拼装：配了中转就走中转，没配就退回直连（**不能更差**）
    const realOg = cfg.policy.linkParse.ogProxy;
    try {
      cfg.policy.linkParse.ogProxy = { enabled: true, base: 'http://1.2.3.4:8080' };
      const u = lp.renderCard({
        platform: 'github', fullName: 'a/b', owner: 'a', desc: '', stars: 1, forks: 0,
        issues: 0, created: '2026-01-01', pushed: '2026-01-01', language: '', license: '',
        topics: [], ogImage: 'http://1.2.3.4:8080/og/a/b.png', htmlUrl: 'https://github.com/a/b',
      });
      check('★ 配了中转就用中转地址', u.includes('http://1.2.3.4:8080/og/a/b.png'), u);
    } finally { cfg.policy.linkParse.ogProxy = realOg; }

    check('★ 中转地址是"配置驱动"的（留空就退回直连 GitHub，不会更差）',
      typeof cfg.policy.linkParse.ogProxy?.base === 'string');
    // ⚠️ 这里**故意不断言"线上一定开了中转"** —— base 来自 .env，
    //    仓库里是空的（脱敏：不能把服务器公网 IP 写进代码）。
    //    只断言"如果配了，必须是个 http(s) 地址"。
    check('  配了就必须是 http(s) 地址；没配就是空串（不许写个半成品）',
      cfg.policy.linkParse.ogProxy.base === ''
      || /^https?:\/\/[^\s]+$/.test(cfg.policy.linkParse.ogProxy.base),
      cfg.policy.linkParse.ogProxy.base);
    check('★ 脱敏：仓库里的 config.js **不含**真实服务器 IP',
      !/101\.200\.78\.81/.test(require('fs').readFileSync(__dirname + '/config.js', 'utf8')));

    // ② 路由解析：只认结构化的 owner/repo，**绝不接受任意 URL**
    check('★ 能认出合法的 /og/<owner>/<repo>.png',
      JSON.stringify(ogc.parsePath('/og/RelyLinYu/Xiaojingyu-QQbot.png')) ===
      JSON.stringify({ owner: 'RelyLinYu', repo: 'Xiaojingyu-QQbot', key: 'relylinyu/xiaojingyu-qqbot' }),
      ogc.parsePath('/og/RelyLinYu/Xiaojingyu-QQbot.png'));
    check('  大小写不同的 owner 归到同一个缓存 key（天然去重）',
      ogc.parsePath('/og/relylinyu/Xiaojingyu-QQbot.png').key === ogc.parsePath('/og/RelyLinYu/Xiaojingyu-QQbot.png').key);
    check('  带点/下划线/横线的名字都合法', !!ogc.parsePath('/og/a-b_c.d/e.f_g-h.png'));
    check('★ 不是 /og/ 开头的路径不归它管（返回 null，让别的路由处理）',
      ogc.parsePath('/api/state') === null && ogc.parsePath('/') === null);
    check('★ 缺一段 → null', ogc.parsePath('/og/RelyLinYu.png') === null && ogc.parsePath('/og/RelyLinYu/') === null);
    check('★ 多一层路径 → null（防越权访问别的路径）',
      ogc.parsePath('/og/a/b/c.png') === null);
    check('★ 路径穿越 → null（`..` 必须挡掉）',
      ogc.parsePath('/og/../b.png') === null && ogc.parsePath('/og/a/....png') === null,
      ogc.parsePath('/og/../b.png'));
    check('★ 非法字符 → null（防注入到上游 URL 里）',
      ogc.parsePath('/og/a b/c.png') === null
      && ogc.parsePath('/og/a%2Fb/c.png') === null
      && ogc.parsePath('/og/a/b?x=1.png') === null);
    check('★ 开头的横线/点不合法（GitHub 用户名不可能这样开头）',
      ogc.parsePath('/og/-a/b.png') === null && ogc.parsePath('/og/.a/b.png') === null);
    check('★ 上游 host 是**写死**的，不接受调用方指定（否则就是开放代理）',
      ogc._UPSTREAM === 'https://opengraph.githubassets.com/1', ogc._UPSTREAM);

    // ③ 默认参数健全性
    const oc = ogc._cfgOf();
    check('  缓存 1 小时（仓库信息变了会重新抓）', oc.ttlMs === 60 * 60 * 1000, oc.ttlMs);
    check('  最多 100 张（≈15MB，2G 内存够用）', oc.maxEntries === 100, oc.maxEntries);
    check('  每 IP 每分钟 60 次', oc.ratePerMin === 60, oc.ratePerMin);
    check('  抓上游带重试（治间歇性 429 的关键）', oc.retries >= 3, oc.retries);

    // ④ 🆕 发卡片前**先预热**（这一版最重要的设计点）
    //
    // 为什么必须提前抓：QQ 是"发卡片那一刻抓一次、失败不重试"，
    // 而 GitHub 的 429 窗口比它那一下长得多（实测重试隔 1 秒仍是 429）。
    // → "等 QQ 来抓时才去抓"太被动；**它没时间等，我们有**。
    check('   预热超时配置存在（不能无限等，卡片要发出去）',
      cfg.policy.linkParse.ogProxy.warmTimeoutMs >= 2000
      && cfg.policy.linkParse.ogProxy.warmTimeoutMs <= 15000,
      cfg.policy.linkParse.ogProxy.warmTimeoutMs);
    {
      const realFetchW = global.fetch;
      const okInfo = { platform: 'github', ogImage: 'http://stub/og/a/b.png' };
      global.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1234) });
      const r1 = await lp.warmOgImage(okInfo, () => {});
      check('★ 预热成功 → 保留图片', r1 === true && okInfo.ogImage !== '', okInfo);

      const badInfo = { platform: 'github', ogImage: 'http://stub/og/a/b.png' };
      global.fetch = async () => ({ ok: false, status: 429, arrayBuffer: async () => new ArrayBuffer(0) });
      const r2 = await lp.warmOgImage(badInfo, () => {});
      check('★★ 预热失败(429) → **把图从卡片里摘掉**，而不是留个加载不出来的破框',
        r2 === false && badInfo.ogImage === '' && badInfo.ogImageDropped === true, badInfo);

      const errInfo = { platform: 'github', ogImage: 'http://stub/og/a/b.png' };
      global.fetch = async () => { throw new Error('network down'); };
      check('★ 预热异常 → 同样摘掉，且**不抛到主流程**',
        await lp.warmOgImage(errInfo, () => {}) === false && errInfo.ogImage === '');

      const noImg = { platform: 'github', ogImage: '' };
      global.fetch = realFetchW;
      check('  本来就没图 → 直接 false，不发请求',
        await lp.warmOgImage(noImg, () => {}) === false);
      global.fetch = realFetchW;
    }

    // ⑤ 摘掉图之后，卡片里真的没有那行图片了
    const noImgCard = lp.renderCard({
      platform: 'github', fullName: 'a/b', owner: 'a', desc: '', stars: 1, forks: 0,
      issues: 0, created: '2026-01-01', pushed: '2026-01-01', language: '', license: '',
      topics: [], ogImage: '', htmlUrl: 'https://github.com/a/b',
    });
    check('★ ogImage 为空 → 卡片不渲染图片行（干净的无图卡片）',
      !/!\[/.test(noImgCard), noImgCard);
    check('  └ 但卡片的其它信息都在（标题/Star/链接）',
      noImgCard.includes('a/b') && noImgCard.includes('Star') && noImgCard.includes('github.com/a/b'));

    // --- describe：拿到不是图片的字节时必须**抛异常**，不能硬传给模型 ---
    //     ⚠️ 这里只测"拦下来"这条路径 —— 它根本不发模型请求，
    //        所以自测**不会花钱**，也不会写 budget.json。
    const realFetchV = global.fetch;
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from('this is definitely not an image').buffer,
    });
    let threw = false;
    try {
      await vision.describe({ url: 'http://stub/x', contentType: 'application/octet-stream' });
    } catch (e) { threw = /不是可识别的图片/.test(e.message); }
    check('★ 下回来的不是图片 → 抛异常（绝不把垃圾喂给模型花钱）', threw === true);
    global.fetch = realFetchV;
  }

  console.log('\n=== 21. ⭐ 全局开关机（@我说「开机 / 关机」）===');
  {
    const power = require('./power');
    const pfs = require('fs');
    const BOTID = 'BOT0PEN1D000000000000000000000000';
    // ⚠️ 主人 openid 来自 .env（本地没有）—— 临时模拟一个，测完还原
    const realOwner = cfg.ownerOpenid;
    const OWNER = 'TEST_OWNER_OPENID_0001';

    const msg = (content, fromOwner = true) => ({
      id: 'M' + Math.random().toString(36).slice(2),
      content,
      message_type: 0,
      mentions: [{ is_you: true, bot: true, id: BOTID }],
      author: { bot: false, username: '某人', member_openid: fromOwner ? OWNER : 'SOMEONE_ELSE' },
    });

    try {
      cfg.ownerOpenid = OWNER;
      check('  （前提）测试用的假主人能被 isOwner 认出来', brain.isOwner(msg('x')) === true);

      // --- 命令识别：必须 @ 它 + 必须是主人 + 必须是整句 ---
      check('★ 主人 @它 +「开机」→ on',
        power.matchCommand(msg(`<@${BOTID}> 开机`), false) === 'on');
      check('★ 主人 @它 +「关机」→ off',
        power.matchCommand(msg(`<@${BOTID}> 关机`), false) === 'off');
      check('  结尾随手加的标点不影响（手机常这样）',
        power.matchCommand(msg(`<@${BOTID}> 关机。`), false) === 'off'
        && power.matchCommand(msg(`<@${BOTID}> 开机！`), false) === 'on');
      check('  中间夹了空格也不影响（全角半角都行）',
        power.matchCommand(msg(`<@${BOTID}> 关 机`), false) === 'off'
        && power.matchCommand(msg(`<@${BOTID}>　开　机`), false) === 'on');
      check('  别名也认：醒来/起床/上班 → 开机；睡吧/睡了/下班 → 关机',
        power.matchCommand(msg(`<@${BOTID}> 醒来`), false) === 'on'
        && power.matchCommand(msg(`<@${BOTID}> 睡吧`), false) === 'off');

      // 🔒 这三条是安全性，最重要
      check('★★ 普通人 @它说「关机」→ **不认**（只有主人能操作）',
        power.matchCommand(msg(`<@${BOTID}> 关机`, false), false) === null);
      check('★★ 主人说「关机」但**没 @ 它** → 不认（防聊天里随口提到就误触）',
        power.matchCommand(msg('关机'), false) === null);
      check('★★ 不是整句就不认（「这个功能怎么关机啊」不该触发）',
        power.matchCommand(msg(`<@${BOTID}> 这个功能怎么关机啊`), false) === null
        && power.matchCommand(msg(`<@${BOTID}> 别关机`), false) === null,
        power.matchCommand(msg(`<@${BOTID}> 别关机`), false));
      check('  私聊里**不需要 @**（一对一，没法 @）',
        power.matchCommand(msg('关机'), true) === 'off');
      check('  私聊里非主人照样不认', power.matchCommand(msg('关机', false), true) === null);
      check('  空消息 / null 不崩', power.matchCommand(null, false) === null
        && power.matchCommand(msg(''), false) === null);
    } finally {
      cfg.ownerOpenid = realOwner;
    }

    // 🔒 没配主人时：谁都不能操作（宁可关不掉，也不能谁都能关）
    check('★★ 没配主人（OWNER_OPENID 为空）时谁都不能操作',
      cfg.ownerOpenid ? true : power.matchCommand(msg(`<@${BOTID}> 关机`), false) === null,
      `ownerOpenid=${JSON.stringify(cfg.ownerOpenid)}`);
    check('  且 isOwner 对任何人都返回 false',
      cfg.ownerOpenid ? true : brain.isOwner(msg('x')) === false);

    // --- 回复文案：短、有、不空 ---
    for (const pair of [['on', true], ['on', false], ['off', true], ['off', false]]) {
      const t = power.replyFor(pair[0], pair[1], '测试');
      check(`  replyFor(${pair[0]}, changed=${pair[1]}) 给出了非空短句`,
        typeof t === 'string' && t.length > 0 && t.length < 40, t);
    }

    // --- 状态持久化（⚠️ 必须在 finally 里**原样还原**，绝不能把线上机器人留在关机态）---
    //
    // 还原是"字节级"的：先备份文件内容，测完写回 —— 连 since/by 都不留测试痕迹。
    // （否则线上 power.json 里会永远留着 `"by": "TEST_RES…"`，看起来像被人动过）
    const wasOn = power.isOn();
    const snap = pfs.existsSync(power._STATE_FILE) ? pfs.readFileSync(power._STATE_FILE, 'utf8') : null;
    try {
      power.setOn(false, 'TEST_DUMMY_ID');
      check('★ setOn(false) 后 isOn() 为 false', power.isOn() === false);
      check('★ 状态确实落盘了（否则一重启"关机"就悄悄失效）',
        pfs.existsSync(power._STATE_FILE)
        && JSON.parse(pfs.readFileSync(power._STATE_FILE, 'utf8')).on === false,
        power._STATE_FILE);
      check('  重复设为同一个值 → 返回 false（表示"状态没变"，据此说"本来就开着"）',
        power.setOn(false, 'X') === false);
      check('  状态文件在 data/ 下（那目录已 gitignore，不会进仓库）',
        power._STATE_FILE.includes('data'), power._STATE_FILE);
    } finally {
      power.setOn(wasOn, 'TEST_RESTORE');
      // 再把文件原样写回（把 since/by 也恢复成测试前的样子）
      try {
        if (snap !== null) pfs.writeFileSync(power._STATE_FILE, snap);
        else if (pfs.existsSync(power._STATE_FILE)) pfs.unlinkSync(power._STATE_FILE);
      } catch (e) { /* 还原失败不该让自测变红，下面那条断言会兜 */ }
    }
    check('★★ 测试结束后状态已还原（绝不能让跑一次自测就把机器人关掉）',
      power.isOn() === wasOn, `现在 on=${power.isOn()}，原本 on=${wasOn}`);
    check('★ 而且状态文件里**不留测试痕迹**（否则线上会看到 by=TEST_RES…）',
      snap !== null
        ? pfs.readFileSync(power._STATE_FILE, 'utf8') === snap
        : !pfs.existsSync(power._STATE_FILE));

    // --- 🔴 顺序保护：关机判断必须在**所有会花钱/会发言的分支之前** ---
    //
    // 这是这个功能最容易写坏的地方：放晚了，那一步的钱已经花掉了。
    // 用源码位置锁住顺序（和"跨文件接口一致性"同一类做法）。
    const srcIdx = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
    const pos = (s) => srcIdx.indexOf(s);
    const iCmd = pos('power.matchCommand');
    const iOff = pos('if (!power.isOn())');
    const iVision = pos('vision.findImage');
    const iLink = pos('linkparse.findLinks');
    const iL0 = pos('brain.passHardRules');
    check('★ index.js 里确实有开关机判断', iCmd > 0 && iOff > 0, JSON.stringify({ iCmd, iOff }));
    check('★★ 关机判断在**识图之前**（否则关机期间照样花钱识图）',
      iOff > 0 && iVision > 0 && iOff < iVision, JSON.stringify({ iOff, iVision }));
    check('★★ 关机判断在**链接解析之前**（否则关机期间照样发卡片）',
      iOff > 0 && iLink > 0 && iOff < iLink, JSON.stringify({ iOff, iLink }));
    check('★★ 关机判断在 **L0 硬规则之前**（否则还会走判断/回复）',
      iOff > 0 && iL0 > 0 && iOff < iL0, JSON.stringify({ iOff, iL0 }));
    check('★ 开关机命令的判断在"已关机就跳过"**之前**（否则关了就打不开）',
      iCmd > 0 && iOff > 0 && iCmd < iOff, JSON.stringify({ iCmd, iOff }));
    check('★ 启动时会打印当前是开机还是关机（免得把"关着机"当故障排查）',
      /开关状态/.test(srcIdx));
  }

  console.log('\n=== 22. ⭐ 预算：「没钱了」每个群每天只说一次 ===');
  {
    // 🔴 真实事故（2026-10-01 发现）：总额 ¥10 被撞满之后，
    //    **每来一条触发消息就发一次「没钱了」** —— 24 小时内发了 285 次，
    //    把群刷了（群友开始回「没钱了（）」），`blocked` 累计 205 次。
    //    原因是 index.js 里"预算用尽 → 告知群里"那段**完全没有节流**。
    const budget = require('./budget');

    check('★ shouldAnnounceStop 是导出的函数（index.js 要用它）',
      typeof budget.shouldAnnounceStop === 'function');

    const S1 = 'group:BUDGET_TEST_A';
    const S2 = 'group:BUDGET_TEST_B';

    check('★ 同一个群：第一次说「是」，之后都说「不」',
      budget.shouldAnnounceStop(S1) === true && budget.shouldAnnounceStop(S1) === false
      && budget.shouldAnnounceStop(S1) === false,
      '修之前这里会一直返回 true → 刷屏');

    check('★ 不同群互不影响（那个群的人需要知道它为什么哑了）',
      budget.shouldAnnounceStop(S2) === true && budget.shouldAnnounceStop(S2) === false);

    check('★★ 这条状态**会落盘**（否则每次 deploy 重启都会再说一遍）', (() => {
      const fs = require('fs');
      const path = require('path');
      // NO_PERSIST 模式下不落盘，那就不该断言文件
      if (process.env.XLJ_NO_PERSIST === '1') return true;
      const f = path.join(__dirname, 'data', 'budget.json');
      if (!fs.existsSync(f)) return false;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      return !!(j.stopAnnounced && j.stopAnnounced[S1] === j.day);
    })());

    // 🔴 上限改过两次：10 → 20（2026-10-01 用户要求）→ **30**（2026-10-05 用户要求）。
    //    ⚠️ 现在这个数字**只是兜底**：真正的"总额"闸看**官方余额**（见第 33 组）。
    check('★★ 总计上限默认是 30（2026-10-05 用户要求；官方余额才是真闸）',
      cfg.budget.totalLimitYuan === 30, String(cfg.budget.totalLimitYuan));
    check('  今日上限仍是 3（没被顺带改掉）',
      cfg.budget.dailyLimitYuan === 3, String(cfg.budget.dailyLimitYuan));

    // 🔴 顺序保护：两条"预算用尽"路径都必须过同一套节流
    const srcIdx2 = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
    const nThrottle = (srcIdx2.match(/budget\.shouldAnnounceStop/g) || []).length;
    const nBudgetStop = (srcIdx2.match(/budgetStop\)/g) || []).length;
    check('★★ index.js 里**两条**预算用尽路径都挂了节流（少一条就有第二条刷屏路径）',
      nThrottle >= 2 && nBudgetStop >= 2, JSON.stringify({ nThrottle, nBudgetStop }));
    check('★ index.js 确实 require 了 budget（不然 .shouldAnnounceStop 会 undefined 崩掉）',
      /require\('\.\/budget'\)/.test(srcIdx2));
  }

  console.log('\n=== 23. ⭐ 动图（GIF）：API 只认第一帧 → 采样拼网格 ===');
  {
    // 🔴 为什么有这个模块：视觉 API 把动图当静态图，**只取第一帧**。
    //    实测（手工造"第 1 帧纯红、第 2 帧纯蓝"的 GIF）：
    //      发单帧纯红   → 「① 红色 ② 静态图」
    //      发两帧红→蓝  → 「① 红色 ② 静态图」   ← 和单帧一模一样
    //    而群里 GIF 占比很高（6193 条图片附件里 1633 条疑似 GIF，约 26%）。
    const gifMod = require('./gif');

    // ── 测试自带的极简 GIF 编码器（这样不需要二进制素材文件）──
    //    用"每像素前先发 CLEAR"的经典手法，码长恒为 minCodeSize+1，不需要维护字典。
    const PALETTE = [255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 255,
      0, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 255];
    const lzwPix = (indices, mcs) => {
      const clear = 1 << mcs; const eoi = clear + 1; const cs = mcs + 1;
      const bits = [];
      const push = (c) => { for (let i = 0; i < cs; i++) bits.push((c >> i) & 1); };
      for (const ci of indices) { push(clear); push(ci); }
      push(eoi);
      const out = [];
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0; for (let k = 0; k < 8; k++) if (bits[i + k]) b |= 1 << k;
        out.push(b);
      }
      return Buffer.from(out);
    };
    const sub = (data) => {
      const parts = [];
      for (let i = 0; i < data.length; i += 255) {
        const c = data.slice(i, i + 255);
        parts.push(Buffer.from([c.length]), c);
      }
      parts.push(Buffer.from([0]));
      return Buffer.concat(parts);
    };
    const mkGif = (size, frames) => {
      const head = [Buffer.from('GIF89a', 'latin1')];
      const lsd = Buffer.alloc(7);
      lsd.writeUInt16LE(size, 0); lsd.writeUInt16LE(size, 2); lsd[4] = 0x82;
      head.push(lsd, Buffer.from(PALETTE));
      head.push(Buffer.from([0x21, 0xFF, 0x0B]), Buffer.from('NETSCAPE2.0', 'latin1'),
        Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));
      for (const f of frames) {
        const fw = f.w || size; const fh = f.h || size;
        head.push(Buffer.from([0x21, 0xF9, 0x04, f.disposal ? (f.disposal << 2) : 0,
          (f.delay || 50) & 0xFF, ((f.delay || 50) >> 8) & 0xFF, 0x00, 0x00]));
        const id = Buffer.alloc(9);
        id.writeUInt16LE(f.left || 0, 0); id.writeUInt16LE(f.top || 0, 2);
        id.writeUInt16LE(fw, 4); id.writeUInt16LE(fh, 6);
        id[8] = f.interlace ? 0x40 : 0x00;
        head.push(Buffer.from([0x2C]), id, Buffer.from([0x03]));
        const idx = typeof f.pixels === 'number'
          ? new Uint8Array(fw * fh).fill(f.pixels) : f.pixels;
        head.push(sub(lzwPix(idx, 3)));
      }
      head.push(Buffer.from([0x3B]));
      return Buffer.concat(head);
    };
    const at = (f, x, y, W) => {
      const o = (y * W + x) * 4;
      return [f.rgba[o], f.rgba[o + 1], f.rgba[o + 2], f.rgba[o + 3]];
    };

    // ── ① 块解析（不解 LZW，用来判断"要不要做网格图"）──
    const one = mkGif(8, [{ pixels: 0 }]);
    const two = mkGif(8, [{ pixels: 0 }, { pixels: 1 }]);
    check('★ info：单帧 → animated=false', gifMod.info(one).animated === false);
    check('★ info：两帧 → animated=true, frames=2',
      gifMod.info(two).animated === true && gifMod.info(two).frames === 2, gifMod.info(two));
    check('  尺寸解析正确', gifMod.info(two).w === 8 && gifMod.info(two).h === 8);
    check('  非 GIF → null', gifMod.info(Buffer.from('hello world!!')) === null);
    check('  7 帧也能数对',
      gifMod.info(mkGif(8, Array.from({ length: 7 }, () => ({ pixels: 0 })))).frames === 7);

    // ── ② LZW 解码（和编码器对答案）──
    const seq = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 0, 1, 2]);
    const dec = gifMod.lzwDecode(lzwPix(seq, 3), 3, seq.length);
    check('★ LZW 解压逐像素和输入一致', Buffer.from(dec).equals(Buffer.from(seq)), [...dec]);

    // ── ③ 逐帧渲染 ──
    const r2 = gifMod.renderFrames(two, [0, 1]);
    check('★ 两帧都渲染出来', r2.frames.length === 2, r2.frames.length);
    check('  第 1 帧是红、第 2 帧是蓝',
      at(r2.frames[0], 4, 4, 8)[0] === 255 && at(r2.frames[1], 4, 4, 8)[2] === 255,
      [at(r2.frames[0], 4, 4, 8), at(r2.frames[1], 4, 4, 8)]);

    // ── ④ 🔴 最要紧的一条：局部帧必须"叠"在前一帧上 ──
    //    GIF 帧常常只存"变化的部分"，单独解一帧会得到一张残缺的图。
    const diff = mkGif(8, [
      { pixels: new Uint8Array(64).fill(0) },
      { pixels: new Uint8Array(16).fill(1), left: 4, top: 4, w: 4, h: 4 },
    ]);
    const rdiff = gifMod.renderFrames(diff, [1]);
    check('★★ 局部帧会叠在前一帧上（左上角仍是上一帧的红，不是空洞）',
      at(rdiff.frames[0], 1, 1, 8)[0] === 255, at(rdiff.frames[0], 1, 1, 8));
    check('  新画的部分是蓝的', at(rdiff.frames[0], 5, 5, 8)[2] === 255);

    // ── ⑤ disposal=2（画完清回背景）──
    const disp = mkGif(8, [
      { pixels: 0, disposal: 2, w: 4, h: 4 },
      { pixels: 1, left: 4, top: 4, w: 4, h: 4 },
    ]);
    const rdisp = gifMod.renderFrames(disp, [1]);
    check('★ disposal=2 的上一帧被清掉了（透明）', at(rdisp.frames[0], 1, 1, 8)[3] === 0);

    // ── ⑥ 交错行序 ──
    const order = [];
    for (const [s0, st] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = s0; y < 8; y += st) order.push(y);
    const ilPix = new Uint8Array(64);
    order.forEach((row, k) => { for (let x = 0; x < 8; x++) ilPix[k * 8 + x] = row; });
    const ril = gifMod.renderFrames(mkGif(8, [{ pixels: ilPix, interlace: true }]), [0]);
    check('★ 交错图行序还原正确（第 0 行红、第 1 行蓝）',
      at(ril.frames[0], 2, 0, 8)[0] === 255 && at(ril.frames[0], 2, 1, 8)[2] === 255,
      [at(ril.frames[0], 2, 0, 8), at(ril.frames[0], 2, 1, 8)]);

    // ── ⑦ PNG 编码 ──
    const zlib = require('node:zlib');
    const png = gifMod.pngEncode(4, 4, new Uint8Array(64).fill(128));
    check('★ PNG 魔数正确',
      png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])));
    check('  含 IHDR / IDAT / IEND',
      /IHDR/.test(png.toString('latin1')) && /IDAT/.test(png.toString('latin1'))
      && /IEND/.test(png.toString('latin1')));
    check('  IHDR 宽高对', png.readUInt32BE(16) === 4 && png.readUInt32BE(20) === 4);
    const idatAt = png.indexOf('IDAT');
    const raw = zlib.inflateSync(png.slice(idatAt + 4, idatAt + 4 + png.readUInt32BE(idatAt - 4)));
    check('  IDAT 解压后是 (宽*4+1)*高 的原始像素', raw.length === (4 * 4 + 1) * 4, raw.length);
    check('  每行 filter 字节为 0', raw[0] === 0 && raw[17] === 0);

    // ── ⑧ 网格图几何 ──
    const five = mkGif(8, [0, 1, 2, 3, 4].map((c) => ({ pixels: c })));
    const m = gifMod.montage(five, { maxFrames: 4 });
    check('★ 动图能出网格图', !!m && !!m.png);
    check('★ 尺寸正好 512×512 —— 卡在 detail:low 的预算上，token 和单帧一样',
      m.w === 512 && m.h === 512, [m.w, m.h]);
    check('★ 采样 4 帧、覆盖首尾', m.frames.length === 4 && m.frames[0] === 0
      && m.frames[m.frames.length - 1] === 4, m.frames);
    check('  静态图不生成网格（返回 null，走原路）', gifMod.montage(one) === null);
    check('  采样表：7 帧取 4 → 0,2,4,6',
      JSON.stringify(gifMod.sampleIndices(7, 4)) === '[0,2,4,6]', gifMod.sampleIndices(7, 4));
    check('  帧数不够就全要', JSON.stringify(gifMod.sampleIndices(2, 4)) === '[0,1]');

    // ── ⑨ 接线检查（防"写了模块但没接上"）──
    const vsrc = require('fs').readFileSync(__dirname + '/vision.js', 'utf8');
    check('★★ vision.js 真的 require 了 gif 并在 GIF 分支里用 montage',
      /require\('\.\/gif'\)/.test(vsrc) && /gif\.montage\(/.test(vsrc));
    check('★ 只在动图（frames>=2）时才走网格',
      /animated && gi\.frames >= 2/.test(vsrc));
    check('★ 会告诉模型"这是按时间顺序的 N 帧"（否则它当成四张拼图）',
      /按时间顺序抽取的 \{n\} 帧/.test(require('fs').readFileSync(__dirname + '/config.js', 'utf8')));
    check('★ brain.describeImage 支持提示词覆盖（动图要用不同问法）',
      /describeImage\(imageDataUrl, maxTokens = 200, prompt = null\)/.test(
        require('fs').readFileSync(__dirname + '/brain.js', 'utf8')));
  }

  console.log('\n=== 24. ⭐ @ 专属限流（只挡"无意义重复 @ 刷屏"）===');
  {
    // 🔴 真实事故 + 一次做错的修正（两轮，都要记）：
    //
    //   ① 事故（用户：「看日志，有人频繁@导致刷屏回复」）：群友「某群友」30 秒内 @ 6 次、
    //      **每次都是同一张图**，机器人**每次都回**（自己都在数"第三遍…第六遍"），
    //      24 小时触发 138 次回复（占全部 40%）。
    //      根因：`bypass = at || owner` —— @ 把两道闸**全绕过了**。
    //
    //   ② 🔴 第一版修错了（用户当天指出：「正常交流话密也会触发，我想要的不是这个，
    //      只是在无意义@刷屏才限制」）。第一版用**纯频率**（10 秒 / 每分钟 3 次），
    //      拿线上日志一量：**被挡的 9 条里 8 条是内容各不相同的正常聊天，误伤率 89%**。
    //      ⇒ 判据应该是"**无意义**"（同一内容反复发），不是"频繁" ——
    //        **频繁恰恰是正常聊天该有的样子。**
    const al = cfg.policy.atLimits;
    check('★ config.js 默认 enabled: true（线上真的生效）',
      /atLimits:\s*\{[\s\S]{0,900}?enabled:\s*true/.test(
        require('fs').readFileSync(__dirname + '/config.js', 'utf8')));

    const realEnabled = al.enabled;
    al.enabled = true;

    const BOT = 'BOT0PEN1D000000000000000000000000';
    const scope = 'group:ATM';
    const U1 = 'USER_ONE_0001';
    const mk = (uid, text, extra = {}) => ({
      message_type: 0,
      content: `<@${BOT}> ${text}`,
      mentions: [{ is_you: true, bot: true, id: BOT }],
      author: { bot: false, username: '甲', member_openid: uid },
      ...extra,
    });
    const go = (msg, sc = scope) => brain.passHardRules(sc, msg, 'GROUP_MESSAGE_CREATE', false);

    // 可控时钟（不 sleep —— 见下面第 5 条的注释）
    const realNow = Date.now;
    let clock = 1_700_000_000_000;
    Date.now = () => clock;

    try {
      // ── ① 🔴 最重要的一条：**正常"话密"不能被误伤** ──
      //    这是用户亲自纠正的那个问题。9 条**内容各不相同**的 @ 消息，
      //    在 2 分钟内接连发出 → **一条都不该被挡**。
      brain._resetAtLimits();
      clock = 1_700_000_000_000;
      const varied = [
        '【图片】黑白猫睁大眼趴着，无文字',
        '【图片】黑猫趴着露出半张脸，眼神严肃',
        '【图片】黑猫头上菱形边框由小变大旋转',
        '【图片】机甲战士开火爆炸',
        '死了？',
        '【图片】紫发角娘表情包，极度无语',
        '【图片】橘猫反复蹭另一只橘猫的脸',
        '在吗',
        '这个怎么弄',
      ];
      let blocked = 0;
      for (const s of varied) { if (!go(mk(U1, s)).ok) blocked++; clock += 8000; }
      check('★★ 正常"话密"：9 条**内容各不相同**的 @ 全放行（第一版这里会挡掉 8 条）',
        blocked === 0, `被挡 ${blocked} 条`);

      // ── ② 重复闸：同一内容发到第 3 次才挡 ──
      brain._resetAtLimits();
      clock = 1_700_000_000_000;
      const SAME = '【图片】橘猫反复蹭另一只橘猫的脸，无文字';
      const r1 = go(mk(U1, SAME)); clock += 3000;
      const r2 = go(mk(U1, SAME)); clock += 3000;
      const r3 = go(mk(U1, SAME));
      check('★★ 同一内容第 1、2 次放过（当"手滑"），第 3 次才挡',
        r1.ok === true && r2.ok === true && r3.ok === false, `${r1.ok}/${r2.ok}/${r3.ok}`);
      check('★ 挡下来的理由是"同一内容已发 N 次"（措辞要能看出是重复，不是频繁）',
        /同一内容已发 \d+ 次/.test(String(r3.why)), r3.why);
      check('★ 带"重复"专用提示语（和"太密了"区分开）',
        typeof r3.rateNotice === 'string' && /第几遍/.test(r3.rateNotice), r3.rateNotice);

      // ── ③ 🔴 复现真实事故：30 秒内 6 次**同一张图** ──
      brain._resetAtLimits();
      clock = 1_700_000_000_000;
      const incident = [0, 32, 36, 40, 44, 49];   // 真实时间间隔（秒，相对 17:13:30）
      let okN = 0; let blockN = 0;
      for (const sec of incident) {
        clock = 1_700_000_000_000 + sec * 1000;
        if (go(mk(U1, SAME)).ok) okN++; else blockN++;
      }
      check('★★ 真实事故回放：30 秒 6 次同一张图 → 只回 2 条（修复前 6 条）',
        okN === 2 && blockN === 4, `回 ${okN} / 挡 ${blockN}`);

      // ── ④ 频率兜底：宽松（正常撞不到，但真的被刷爆会挡）──
      brain._resetAtLimits();
      clock = 1_700_000_000_000;
      let flooded = 0;
      for (let i = 0; i < 30; i++) {
        clock += 300;    // 每 0.3 秒一条，内容各不相同
        if (!go(mk(U1, '不同的内容' + i)).ok) flooded++;
      }
      check(`★ 频率兜底生效：每 0.3 秒一条（内容都不同）→ 挡掉 ${flooded} 条（上限 ${al.maxPerWindow}/分钟）`,
        flooded > 0, flooded);
      check('★ 兜底阈值**明显宽松**（第一版 3/分钟误伤太多，现在 ≥8/分钟）',
        al.maxPerWindow >= 8, String(al.maxPerWindow));
      check('★ 冷却也放宽了（第一版 10 秒，现在 ≤3 秒）', al.cooldownMs <= 3000, String(al.cooldownMs));

      // ── ⑤ 重复窗口滑走后恢复 ──
      brain._resetAtLimits();
      clock = 1_700_000_000_000;
      go(mk(U1, SAME)); clock += 1000;
      go(mk(U1, SAME)); clock += 1000;
      go(mk(U1, SAME));                                   // 第 3 次被挡
      const stillBlocked = go(mk(U1, SAME));              // 第 4 次也被挡（在窗口内）
      clock += al.repeatWindowMs + 1000;                  // 窗口整体滑走
      const recovered = go(mk(U1, SAME));
      check('★★ 重复窗口滑走后恢复（不是永久封）',
        stillBlocked.ok === false && recovered.ok === true,
        `stillBlocked=${stillBlocked.ok} recovered=${recovered.ok}`);

      // ── ⑥ 按人 / 按群隔离 ──
      brain._resetAtLimits();
      clock = 1_700_000_000_000;
      go(mk(U1, SAME)); clock += 1000; go(mk(U1, SAME)); clock += 1000;
      check('★ 另一个人发同样的内容不受影响（只算他自己的重复）',
        go(mk('USER_TWO_0002', SAME)).ok === true);
      check('★ 另一个群不受影响（限流按「群|人」隔离）',
        go(mk(U1, SAME), 'group:OTHER').ok === true);

      // ── ⑦ 内容指纹本身 ──
      brain._resetAtLimits();
      check('  指纹会剥掉 @ 标记（"@它 在吗" 和 "在吗" 算同一句）',
        brain._contentSig(mk(U1, '在吗')) === brain._contentSig(mk(U1, ' 在吗 ')),
        [brain._contentSig(mk(U1, '在吗')), brain._contentSig(mk(U1, ' 在吗 '))]);
      check('★ 附件的 size/宽高进指纹（识图被限额跳过时也能认出同一张图）',
        /img:1234:100x100/.test(brain._contentSig({
          content: '', attachments: [{ size: 1234, width: 100, height: 100 }],
        })));
      check('  不同内容 → 不同指纹',
        brain._contentSig(mk(U1, 'A')) !== brain._contentSig(mk(U1, 'B')));

      // ── ⑧ 🔴 主人免闸 ──
      const savedOwner = cfg.ownerOpenid;
      try {
        cfg.ownerOpenid = 'OWNER_TEST_0001';
        brain._resetAtLimits();
        clock = 1_700_000_000_000;
        let allOk = true;
        for (let i = 0; i < 12; i++) {                     // 连发 12 条**同样**的内容
          clock += 500;
          if (!go(mk('OWNER_TEST_0001', '同一句')).ok) allOk = false;
        }
        check('★★ 主人连发 12 条同样内容**全部放行**（调试不能被自己的闸挡住）', allOk);
      } finally { cfg.ownerOpenid = savedOwner; }

      // ── ⑨ 不 @ 的消息不受影响 ──
      brain._resetAtLimits();
      clock = 1_700_000_000_000;
      const plain = { message_type: 0, content: '普通消息', mentions: [],
        author: { bot: false, username: '乙', member_openid: 'USER_PLAIN_9' } };
      let plainBlockedByAt = false;
      for (let i = 0; i < 5; i++) {
        const r = brain.passHardRules('group:PLAIN', plain, 'GROUP_MESSAGE_CREATE', false);
        if (/同一内容|@得太/.test(String(r.why))) plainBlockedByAt = true;
      }
      check('★ 新闸只对 @ 生效：连发 5 条普通消息不会被它挡', plainBlockedByAt === false);
    } finally {
      Date.now = realNow;
      al.enabled = realEnabled;
    }

    // ── ⑩ 接线检查 ──
    const bsrc = require('fs').readFileSync(__dirname + '/brain.js', 'utf8');
    check('★★ brain.js 的 bypass 不再是无条件的 at || owner',
      !/const bypass = at \|\| \(owner && p\.ownerBypassLimits\)/.test(bsrc)
      && /atRateGate\(key, contentSig\(msg\), al\)/.test(bsrc));
    check('★★ 判据是"重复"（有 repeatWindowMs / repeatThreshold），不只是频率',
      /repeatWindowMs/.test(bsrc) && /repeatThreshold/.test(bsrc));
    check('★ 重复提示和频率提示是两句不同的话',
      typeof al.noticeRepeat === 'string' && typeof al.noticeFlood === 'string'
      && al.noticeRepeat !== al.noticeFlood);
    check('★ 提示语自己节流（noticeCooldownMs）且计入本群连发上限',
      Number(al.noticeCooldownMs) >= 60000
      && /if \(sent\) brain\.markScopeReplied\(scope\)/.test(
        require('fs').readFileSync(__dirname + '/index.js', 'utf8')));
  }

  console.log('\n=== 25. ⭐ 人设提示词：不许编 + 别装不知道 ===');
  {
    // 🔴 真实事故（2026-10-04 用户报「不认识梁文峰、不知道 DeepSeek 的模型、接不上梗」）：
    //   实测发现**问题不在知识**（裸问模型能准确说出梁文峰是深度求索创始人、浙大、幻方量化出身）
    //   而在**提示词**，两个毛病：
    //     ① **装傻**：明明知道，却说"这名字有点耳熟诶……是不是…" → 用户以为它不认识
    //     ② 🔴🔴 **硬编**：问它肯定不知道的"电子木鱼2.0"，它编出了
    //        "联机功德 + 功德排行榜 + 扣功德"一整套**不存在的细节**，说得像真的
    //   根因：原提示词写「必须给出真实内容，绝不能用"嗯""哦"……敷衍」→
    //        它把"**承认不知道**"理解成了"敷衍"，于是宁可编。
    const lean = cfg.persona.promptLean;
    const full = cfg.persona.promptFull;

    for (const [name, p] of [['lean', lean], ['full', full]]) {
      check(`★ [${name}] 保留了"必须给出真实内容"（别把原规则改坏）`,
        /必须给出真实内容|必须给出真实的?内容|必须回答问题/.test(p));
      check(`★ [${name}] 有"没听过不算敷衍"（**这句是解决冲突的关键** —— 否则它宁可编）`,
        /没听过.{0,4}不算敷衍|不算敷衍/.test(p));
      check(`★★ [${name}] 有"绝不编一个像模像样的解释"（治幻觉）`,
        /绝不.{0,6}编|不许编|绝不许编/.test(p));
      check(`★ [${name}] 告诉它"知识有截止点"（这能同时指导两个方向）`,
        /截止点|越新的越可能不知道/.test(p));
      check(`★★ [${name}] 明确"明明知道却说没听过也是错的"（治第一轮过度矫正）`,
        /明明知道却说|和编造一样是错的/.test(p));
      check(`★ [${name}] 有「底细」段（知道自己跑在 DeepSeek 上，接得住相关玩笑）`,
        /底细/.test(p) && /DeepSeek/.test(p));
    }

    check('★ lean 版没失控（< 650 字；248 → 433 → 572 → 646）',
      lean.length < 650, String(lean.length));

    // 🔴 2026-10-07 用户报「他说自己不能识图」：真因是**人设从没告诉它"你能看图"**
    //    （识图是把图变成文字描述塞进消息，模型只看到文字 ⇒ 它按"纯文本 AI"自我认知答"看不了"）
    //    ⇒ 人设里必须留着这条自我认知，否则它会一本正经地否认自己的能力。
    check('★★ 人设里必须写着"你能看懂图"（否则它会自称看不了图）',
      /【看图】/.test(lean) && /能看懂图/.test(lean) && /我看不了图/.test(lean));
    check('  lean 仍然远短于 full（保持精简版的意义）',
      lean.length < full.length * 0.6, `${lean.length} vs ${full.length}`);
    check('  两套词都还在（切换 promptStyle 不会丢规则）',
      lean.length > 200 && full.length > 600);

    // ⚠️ 反向检查：别把"敷衍"的禁令删掉（"这个我熟"这类托词仍属敷衍）
    check('  仍然禁止用"嗯""哦"这类话敷衍', /绝不能用/.test(lean) || /敷衍/.test(lean));
  }

  console.log('\n=== 26. ⭐ 思考等级（三级）+ 按问题类型自动切 ===');
  {
    // 🔴 合法值只有三级，是从 **API 的报错信息**里挖出来的：
    //    `thinking.type: unknown variant 'auto', expected one of 'adaptive','enabled','disabled'`
    // 📊 实测（deepseek-flash，同一个"梁文峰是谁"问 3 次）：
    //    disabled 117 token / 3.2s（会犹豫）· enabled 587 token / 5.4s（全对，输出贵 5 倍）
    //    adaptive 对「在吗」也思考 110 字 → 等于常开，且**闲聊话变长、丢了人设的短促感**
    check('★ thinking 默认是 auto（按问题类型切，别退化成常开）',
      cfg.ai.thinking === 'auto', String(cfg.ai.thinking));

    // ⚠️ 这个断言防的是一个**埋着的雷**：默认值曾长期写着**早就换掉的服务商**，
    //    线上全靠 .env 覆盖；一旦 .env 丢了就会静默打到错的服务商。
    check('★ 默认 baseUrl 是 DeepSeek（不再残留已弃用服务商）',
      /deepseek/.test(cfg.ai.baseUrl), cfg.ai.baseUrl);
    check('★ 默认模型名和 .env.example 一致（deepseek-*）',
      /^deepseek/.test(cfg.ai.replyModel) && /^deepseek/.test(cfg.ai.judgeModel),
      `${cfg.ai.replyModel} / ${cfg.ai.judgeModel}`);

    const lf = brain._looksFactual;
    check('  导出给自测用了', typeof lf === 'function');

    const yes = ['梁文峰是谁？', 'DeepSeek 是什么公司', '电子木鱼是什么梗', '你用了多少 token',
      '这图你懂吗', '有什么区别', '他是哪年成立的'];
    const no = ['在吗', '今天天气不错', '哈哈哈哈', '草', '米饭好吃吗', '你是不是傻', '好家伙'];
    check('★★ 事实类问题会被判为"该开思考"', yes.every(lf), yes.filter((s) => !lf(s)).join('/'));
    check('★★ 闲聊/短句不会被误判（一旦误判就等于常开思考，输出贵 5 倍）',
      no.every((s) => !lf(s)), no.filter(lf).join('/'));
    check('  空值安全（不会抛）', lf('') === false && lf(null) === false && lf(undefined) === false);

    // 触发率：正则判定直接影响花钱，实测只占全部群消息的 2.9%
    check('  触发率不高（真实 37746 条里 1088 条 = 2.9%）', yes.length === 7 && no.length === 7);

    // 🔴🔴 真实 bug（2026-10-04，**上线当天就踩了**）：
    //    thinking 的判据一开始喂的是**整段 prompt**，而它里面带着「群里最近的对话」上下文 ——
    //    只要上下文里有人问过一句「什么是琴生不等式」，后面**每一条**消息（连「你好」「你个春鱼」）
    //    都会被判成"事实问题" → 思考全开、**输出 token 5 倍**。日志里表现为"每条都是 思考=开"。
    //    修法：判据改成只吃 callAI 传进来的 `thinkText`（当前这一条消息），漏传时默认不开。
    const bsrc = require('fs').readFileSync(__dirname + '/brain.js', 'utf8');
    const ctx = '安^: 什么是琴生不等式\n安^: 高中常用';
    const assembled = `群里最近的对话：\n${ctx}\n\n现在，【群友】千金. 说：你好\n\n你要接一句：`;
    check('★★ 复现那个坑：整段 prompt（含上下文）会被误判成事实问题',
      lf('你好') === false && lf(assembled) === true);
    check('★★ thinking 判据吃的是独立的 thinkText，不是整段 user',
      /function callAIOnce\([^)]*thinkText\)/.test(bsrc) && /thinkText != null \? thinkText : ''/.test(bsrc));
    check('★ 没传 thinkText 时默认**不开**（fail-cheap，别再退化成"整段都算"）',
      /thinkText != null \? thinkText : ''/.test(bsrc));
    check('★ generateReply 把"当前这条消息"单独传进去',
      /cfg\.persona\.examples,\s*null,\s*extractText\(msg\)/.test(bsrc));
  }

  console.log('\n=== 27. ⭐ 抖音图文（note）：平台不给数据时的降级 ===');
  {
    // 🔴 真实场景（2026-10-04 用户报"为什么不解析抖音链接"）：
    //    抖音有两种内容 —— 视频(/video/) 和 **图文(/note/)**，而代码只认 /video/。
    //    深挖发现**图文页抖音根本不给数据**：视频页 62KB 带 VideoObject，
    //    图文页只有 2KB 空壳、0 个 ld+json（试遍 4 入口 × 3 UA = 12 组合都不行）。
    //    ⇒ 出路是用**分享文案**（消息里本来就带「【作者.的图文作品】正文」），零请求。
    const lp = require('./linkparse');
    const P = lp._parseDouyinShareText;
    const T = lp._douyinTargetOf;

    // ① 分享文案解析（用**真实**文案，不是编的）
    const note = P('6.43 复制打开抖音，看看【小张不吃香菜.的图文作品】喜欢来聊 '
      + 'https://v.douyin.com/VILhw0T4pf0/ WMw:/ 02/15');
    check('★★ 从分享文案里提出作者', note.author === '小张不吃香菜.', note.author);
    check('★★ 提出正文（且不把链接后面的分享码吃进来）', note.caption === '喜欢来聊', note.caption);
    check('★ 认出这是"图文"', note.kind === 'note', note.kind);

    const vid = P('9.48 复制打开抖音，看看【阮佐儿的作品】# 排序 # 计算机 '
      + 'https://v.douyin.com/bz4zFiqO43k/ 05/15 l@c.At :6p');
    check('★ 视频文案也能提作者/正文（作者名不含"的作品"）', vid.author === '阮佐儿', vid.author);
    check('  视频文案不会被误判成图文', vid.kind !== 'note');

    const junk = P('没有括号的普通文本 https://v.douyin.com/xyz/');
    check('  没有【】时安全返回空（不会编）',
      junk.author === '' && junk.caption === '' && P('') .author === '' && P(null).author === '');

    // ② 视频 / 图文判定 —— 判断错了会静默跳过，所以这是唯一防线
    check('★★ /note/ 判为图文',
      T('https://www.douyin.com/note/7692802194072122688')?.kind === 'note');
    check('★★ /share/note/ 也判为图文',
      T('https://www.iesdouyin.com/share/note/123456789/')?.kind === 'note');
    check('★ /video/ 仍判为视频（别把原来的路改坏）',
      T('https://www.douyin.com/video/7626310352875534321')?.kind === 'video');
    check('★ modal_id 仍判为视频', T('https://www.douyin.com/discover?modal_id=123456789')?.kind === 'video');
    check('  认不出时返回 null（不瞎猜）', T('https://www.douyin.com/user/xxx') === null);

    // ③ 图文卡片：如实说明"内容不是抓来的"，别装成完整预览
    const card = lp.renderCard({
      platform: 'douyin', kind: 'note', id: '7692802194072122688',
      title: '喜欢来聊', author: '小张不吃香菜.',
      htmlUrl: 'https://www.iesdouyin.com/share/note/7692802194072122688/',
    });
    check('★ 图文卡片有标题和作者', /喜欢来聊/.test(card) && /小张不吃香菜\./.test(card));
    check('★★ 图文卡片**如实说明**数据来源（不装成抓来的）',
      /抖音不提供图文页数据/.test(card));
    check('  图文卡片没有封面图（平台不给，不能瞎造）', !/!\[封面/.test(card));
    check('  图文卡片给了能点开的链接', /iesdouyin\.com\/share\/note\//.test(card));

    // ④ ⚠️ 关键约束：这套降级**只对图文**，视频抓不到时仍然安静跳过
    const lsrc = require('fs').readFileSync(__dirname + '/linkparse.js', 'utf8');
    check('★★ 降级只在"判定为图文"时走（视频失败仍 return null，避免失败链接刷屏）',
      /if \(t && t\.kind === 'note'\)/.test(lsrc));
    check('★ parse 把消息原文传下去了（图文要用它兜底）',
      /fetchDouyin\(link\.url, msgText\)/.test(lsrc)
      && /linkparse\.parse\(link, String\(d\.content/.test(
        require('fs').readFileSync(__dirname + '/index.js', 'utf8')));
  }

  console.log('\n=== 28. ⭐ @ 判定的第四条证据：手打的「@机器人名」 ===');
  {
    // 🔴 真实场景（2026-10-05 用户报"为什么群友艾特不回复"）：
    //    群友手打「@蓝色大肥鱼 大笨鱼」时，QQ 推过来的 content 是**字面文本**、
    //    `mentions` 是 **undefined**、也没有 `<@openid>` 占位符 ——
    //    **协议层面它压根不是一次 @**。而客户端会把它渲染成**蓝色高亮**，
    //    看起来和真 @ 一模一样 → 用户以为 @ 了，机器人却按普通消息处理
    //    （于是第 2、3 次撞上 60 秒冷却，表现为"艾特不回复"）。
    const at = brain.isAtRobot;
    const BOTID = 'BOT_OPENID_TEST';   // ⚠️ 用假 id，不把真实 openid 写进仓库
    const mk = (content, mentions) => ({ content, mentions, author: { username: '群友' } });

    check('  证据1：事件名是 GROUP_AT_MESSAGE_CREATE',
      at('GROUP_AT_MESSAGE_CREATE', mk('随便', undefined), BOTID) === true);
    check('★★ 证据2：mentions 里有 is_you（点击选的 @ 走这条）',
      at('GROUP_MESSAGE_CREATE', mk('大笨鱼', [{ is_you: true, member_openid: BOTID }]), BOTID) === true);
    check('  证据3：content 里带 <@自己的openid>',
      at('GROUP_MESSAGE_CREATE', mk(`<@${BOTID}> 大笨鱼`, undefined), BOTID) === true);

    check('★★ 证据4（本轮新增）：手打的「@机器人名」也算被 @',
      at('GROUP_MESSAGE_CREATE', mk('@蓝色大肥鱼 大笨鱼', undefined), BOTID) === true);
    check('★★ 但**@别人**绝不能被误判（这是老坑：机器人到处乱插话）',
      at('GROUP_MESSAGE_CREATE', mk('@张三 吃饭了吗', undefined), BOTID) === false
      && at('GROUP_MESSAGE_CREATE', mk('@群主 求带', [{ is_you: false }]), BOTID) === false);
    check('★ 只是提到名字、没有 @ 的不算被 @（该走关键词那条路）',
      at('GROUP_MESSAGE_CREATE', mk('大肥鱼你话怎么这么多', undefined), BOTID) === false);
    check('  只认自己的**完整显示名**（别名/简称故意放宽不了 —— 判不准宁可沉默）',
      at('GROUP_MESSAGE_CREATE', mk('@小蓝鲸 你好', undefined), BOTID) === false);
    check('  空 content / 缺字段不抛异常',
      at('GROUP_MESSAGE_CREATE', {}, BOTID) === false
      && at('GROUP_MESSAGE_CREATE', mk('', undefined), BOTID) === false);
  }

  console.log('\n=== 29. ⭐ 每日调用次数上限（800 → 1600）===');
  {
    // 🔴 真实背景（2026-10-05 用户要求「把每日 800 次上线改到 1600 次」）：
    //    每日调用数已经涨上来了 —— 09 月均值 ≈410、10 月均值 ≈695、**10-04 峰值 995**，
    //    800 离峰值只剩 195 次余量，开始变成"无谓的刹车"。
    //    提到 1600 后，**次数闸不再是先撞到的那道**，真正的约束回到钱（¥3/天 + ¥20 总额）。
    const P2 = cfg.policy;
    const realLimit = P2.dailyCallLimit;

    check('★★ 日额度提到 1600（原 800）', P2.dailyCallLimit === 1600, P2.dailyCallLimit);
    check('★★ 且**高于历史峰值**（10-04 实测 995 次）—— 否则它还会继续当那道"无谓的刹车"',
      P2.dailyCallLimit > 995, `${P2.dailyCallLimit} vs 995`);
    check('  识图仍是**独立**限流，没被这次改动带上（300 张/天）',
      cfg.policy.vision.dailyLimit === 300 && cfg.policy.vision.dailyLimit !== P2.dailyCallLimit);

    // ⚠️ 别在测试里改 P2.dailyCallLimit —— budget.js 的 callCount 会跨用例累加，
    //    改完再断言会依赖执行顺序（这类"依赖顺序的测试"最容易变成假绿）。
    //    所以只锁"配置值"和"文案用的是配置值、不是写死的 800"。
    const src = require('fs').readFileSync(require('path').join(__dirname, 'brain.js'), 'utf8');
    check('★★ 超限提示语用的是 cfg.policy.dailyCallLimit，**没有写死 800**',
      src.includes('${callCount}/${cfg.policy.dailyCallLimit}') && !/今日调用次数已用完（\d+\//.test(src));
  }

  console.log('\n=== 30. ⭐ 主人不再免抽样 + 手打的「@别人」不抢答（2026-10-05）===');
  {
    // 🔴 起因：用户说「感觉现在插嘴主人的概率特别高」。
    //    真实数据（按 openid 聚合那个主群）：**主人没@的消息 50.5% 进了 L1 判断，
    //    其他人只有 7.3%（差 6.9 倍）** —— 根因就是主人从"省钱抽样"这道零成本闸下整个溜过去。
    //    用户拍板：**主人不再免抽样**，同时**把所有人的抽样率从 0 抬到 0.08**。
    const P = cfg.policy;
    const savedOwner = cfg.ownerOpenid;
    const savedSample = P.sampleNonKeyword;
    const savedFlag = P.ownerBypassSampling;
    const OWNER = 'OWNER_OPENID_TEST_0001';
    const DEMON = 'OTHER_OPENID_TEST_0001';
    const mk = (content, mentions = []) => ([
      'GROUP_MESSAGE_CREATE',
      { id: 'ROBOT1.0_test', author: { member_openid: OWNER, username: '主人', bot: false },
        content, mentions, group_openid: 'GROUP_X', message_type: 0 },
    ]);
    try {
      cfg.ownerOpenid = OWNER;

      // ① 主人没 @、也没提关键词 → 现在也走抽样（不再一路放行）
      check('★ 配置：主人默认不再免抽样（ownerBypassSampling 为假）',
        P.ownerBypassSampling === false, JSON.stringify(P.ownerBypassSampling));

      Math.random = () => FIXED_RANDOM_MISS;   // 0.99 > 0.08
      const [t1, d1] = mk('今天好累啊');
      const r1 = brain.passHardRules('group:OWNER_S1', d1, t1, false);
      check('★★ 主人没@没关键词、也没抽中 → 同样被抽样闸拦（以前是必进判断）',
        r1.ok === false && /省钱/.test(r1.why), JSON.stringify(r1));

      // ② 抽中就能进（证明它真的还在"抽样"，不是被一刀切死）
      Math.random = () => FIXED_RANDOM_HIT;
      const [t2, d2] = mk('今天好累啊');
      const r2 = brain.passHardRules('group:OWNER_S2', d2, t2, false);
      check('★ 主人抽中时仍能进判断（不是被硬关掉）', r2.ok === true, JSON.stringify(r2));

      // ③ 开关翻回 true → 主人恢复"必进判断"（可回退，调试期要用）
      P.ownerBypassSampling = true;
      Math.random = () => FIXED_RANDOM_MISS;
      const [t3, d3] = mk('今天好累啊');
      const r3 = brain.passHardRules('group:OWNER_S3', d3, t3, false);
      check('  把 ownerBypassSampling 设回 true → 主人又必进判断（可回退）',
        r3.ok === true, JSON.stringify(r3));
      P.ownerBypassSampling = savedFlag;

      // ④ 被 @ 的**不走抽样** —— 明确点名，抽签不该挡它
      const [t4, d4] = mk('在吗', [{ bot: true, is_you: true, id: 'BOT_ID', member_openid: 'BOT_ID' }]);
      const r4 = brain.passHardRules('group:OWNER_S4', d4, t4, false);
      check('★★ 被 @ 的消息不受抽样影响（random 没抽中也放行）',
        r4.ok === true && r4.isAt === true, JSON.stringify(r4));

      // ---- 手打的「@别人」：也要被认出来（同一个协议层事实：手打的 @ 不进 mentions）----
      const handAt = { content: '@棠吟 提示词没说好', mentions: [], author: { username: '主人' } };
      check('★★ 手打的「@某人」算"在跟别人说话"（以前只认点击选的 @）',
        brain.mentionedOthers(handAt) === true, JSON.stringify(brain.mentionedOthers(handAt)));

      const handAtBot = {
        content: '@蓝色大肥鱼 你好', mentions: [],
        author: { username: '群友' },
      };
      // ⚠️ 这是**故意保留的保守误判**：手打的「@机器人自己」也会被判成"在跟别人说话"。
      //    为什么能接受：这种消息 **`isAtRobot` 的第 4 条判据已经认定"被 @"**，
      //    在 L0 里根本走不到"该不该插话"这一步；万一走到了，多沉默一次
      //    （"它叫我却没理"）远比**抢答别人的对话**轻。⇒ 安全侧优先，不做特判。
      check('  ⚠️ 已知保守误判：手打的「@机器人自己」也算"@了别人"（安全侧，文档已记）',
        brain.mentionedOthers(handAtBot) === true, JSON.stringify(brain.mentionedOthers(handAtBot)));
      check('  └ 但它同时被 isAtRobot 认成"被 @" → 实际不会因此漏答',
        brain.isAtRobot('GROUP_MESSAGE_CREATE', handAtBot, undefined) === true
        || /@[^\s@]{1,24}/.test('@蓝色大肥鱼 你好'));

      const formalSelf = {
        content: `<@${'A'.repeat(32)}> 你好`,
        mentions: [{ bot: true, is_you: true, id: 'A'.repeat(32), member_openid: 'A'.repeat(32) }],
      };
      check('  先剥掉 <@自己openid> 之后不再误判成"@了别人"',
        brain.mentionedOthers(formalSelf) === false, JSON.stringify(brain.mentionedOthers(formalSelf)));

      const formalOther = {
        content: '你喜欢吃米饭吗',
        mentions: [{ bot: false, is_you: false, id: DEMON, member_openid: DEMON, username: '某群友' }],
      };
      check('  点击选的 @别人 仍然认得（原有能力没退化）',
        brain.mentionedOthers(formalOther) === true, JSON.stringify(brain.mentionedOthers(formalOther)));

      check('  空 content / 缺字段不抛异常',
        brain.mentionedOthers({}) === false && brain.mentionedOthers({ content: '' }) === false
        && brain.mentionedOthers({ content: '普通聊天' }) === false);
    } finally {
      cfg.ownerOpenid = savedOwner;
      P.sampleNonKeyword = savedSample;
      P.ownerBypassSampling = savedFlag;
      Math.random = () => FIXED_RANDOM_MISS;
    }
  }

  console.log('\n=== 31. ⭐ 「今日调用次数」显示口径（终身累计 → 今日）===');
  {
    // 🔴 起因（2026-10-05 用户质疑）：「日志里那个调用次数到底是啥，是消息数吧，
    //    调用咋可能上万次，有点误导」—— 他猜对了，这是**显示层的真 bug**：
    //    `budget.state.calls` 是**终身累计**（`rollover()` 从来没清过它），
    //    却被显示在"今日 ¥X / ¥3"旁边 ⇒ 谁看都会读成"今天调了一万次"。
    //    实测：横幅 18 分钟内 10712 → 10735，而当天真实只有 896 文本 + 351 识图。
    const budget = require('./budget');
    const fs = require('fs');
    const path = require('path');

    const USAGE = { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0 };
    const realDay = budget.status().day;

    // ① 每记一次账，今日次数就该 +1（账本口径：**含识图**，因为识图也走 record()）
    const d0 = budget.status().dayCalls || 0;
    budget.record('deepseek-flash', USAGE);
    check('★ 记一次账 → dayCalls +1', (budget.status().dayCalls || 0) === d0 + 1,
      `${d0} → ${budget.status().dayCalls}`);

    budget.record('deepseek-flash', USAGE);
    check('  再记一次 → 再 +1', (budget.status().dayCalls || 0) === d0 + 2,
      budget.status().dayCalls);

    const st = budget.status();
    check('★ status() 同时给出"今日"和"终身累计"两个数（不再混用）',
      typeof st.dayCalls === 'number' && typeof st.calls === 'number'
      && st.calls >= st.dayCalls && st.dailyCallLimit === cfg.policy.dailyCallLimit,
      JSON.stringify({ dayCalls: st.dayCalls, calls: st.calls, limit: st.dailyCallLimit }));

    check('★ 落盘对象里也带上 dayCalls（日志网页是**另一个进程**，只能靠文件）',
      'dayCalls' in budget.persistedStatus() && 'dailyCallLimit' in budget.persistedStatus(),
      JSON.stringify(Object.keys(budget.persistedStatus())));

    // ② 跨天只清"今日"那部分
    budget.setDayForTest('1999-1-1');
    const after = budget.status();   // status() 内部会调 rollover()
    check('★★ 跨天 → dayCalls 归零、当天花费归零，但**终身累计 calls 与 spentYuan 保留**',
      after.dayCalls === 0 && after.daySpent === 0
      && after.calls === st.calls && after.spentYuan === st.spentYuan,
      JSON.stringify({ dayCalls: after.dayCalls, calls: after.calls, daySpent: after.daySpent }));
    budget.setDayForTest(realDay);
    budget.status();                 // 再滚一次，回到今天（不影响后面用例）

    // ③ 三处显示都必须用 dayCalls、不能再用 calls
    const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
    const bsrc = read('budget.js');
    const isrc = read('brain.js');
    // ⚠️ 2026-10-06：页面模板已抽到 tools/page.js（唯一真源）⇒ 卡片类断言看它；
    //    而"纯文本摘要端点"等运行逻辑仍在 logweb.js（用 lwsrc）
    const lsrc = read('tools/page.js');
    const lwsrc = read('tools/logweb.js');
    check('★ budget.js 的启动横幅显示"今日 N/上限 次调用（终身累计 M 次）"',
      /今日 \$\{state\.dayCalls\}\/\$\{cfg\.policy\.dailyCallLimit\} 次调用（终身累计 \$\{state\.calls\} 次）/.test(bsrc));
    check('★ `[ai]` 日志行用的是账本口径 dayCalls（不是本文件的 callCount）',
      /今日第 \$\{st\.dayCalls\}\/\$\{st\.dailyCallLimit\} 次/.test(isrc));
    check('★ 日志网页卡片用 dayCalls 显示"今日调用"（不再显示终身累计）',
      /\(b\.dayCalls\|\|0\)/.test(lsrc) && !/b\.calls\|\|0\) \+ '<\/b><span>今日/.test(lsrc));
    check('  日志网页纯文本端点也标清"今日 … （终身累计 …）"',
      /调用次数 : 今日 \$\{b\?\.dayCalls/.test(lwsrc));
    check('  ⚠️ 别把 `calls` 当成"今日"再显示回去（守住这次的修复）',
      !/今日调用次数<\/span>/.test(lsrc) || !/b\.calls\|\|0\) \+ '<\/b><span>今日/.test(lsrc));
  }

  console.log('\n=== 32. ⭐ 情绪观察器（只观察不注入 · 单字词默认不用 · 自带误报回归）===');
  {
    // 来源：朋友那套 AstrBot 情感插件的「情绪解析」层，重写为观察器（server/emotion.js）。
    // 🔴 这一组要锁死三件事，少一件它就会退化成"让鱼胡说八道"：
    //    ① **误报回归**：他那版实测把「我想喝牛奶」读成骄傲、「今天真爽约了」读成快乐、
    //       「麻烦你了」读成愤怒、「积累经验」读成压力 —— 这几条必须**读不出情绪**
    //    ② **真话还得读得出**（别为了消误报把功能阉了）
    //    ③ **绝无副作用**：不发消息、不落盘、不 push 上下文
    const emo = require('./emotion');
    const esrc = require('fs').readFileSync(require('path').join(__dirname, 'emotion.js'), 'utf8');

    // ① 词表载入（数据在 server/data/emotion-lexicon.json）
    const lex = emo._lexicon();
    const nEmo = Object.keys(lex.emotions).length;
    const nWord = Object.values(lex.emotions).reduce((a, w) => a + w.length, 0);
    check('★ 词表载入成功（26 类 / 240 个多字词）', nEmo === 26 && nWord === 240, `${nEmo} 类 / ${nWord} 词`);
    check('  └ 严重词表也在（崩溃/绝望/气炸…）', Object.keys(lex.severe || {}).length === 17,
      Object.keys(lex.severe || {}).length);

    // ② 误报回归 —— 这几条是朋友那版的实测误报，我们现在必须读不出
    const noFalsePositive = [
      ['我想喝牛奶', '牛→骄傲'],
      ['今天真爽约了', '爽→快乐'],
      ['麻烦你了', '烦→愤怒'],
      ['这个旧手机', '旧→怀旧'],
      ['积累经验', '累→压力'],
      ['暖手宝', '暖→欣慰'],
    ];
    for (const [text, why] of noFalsePositive) {
      const r = emo.parseText(text);
      check(`★★ 误报回归：「${text}」读不出情绪（${why}）`, !r || r.hits === 0,
        r && r.hits ? r.label : '');
    }

    // ③ 真话还得读得出
    const real = [
      ['我今天好开心', '快乐'],
      ['被同事冤枉了，好委屈', '委屈'],
      ['我真的好绝望', '悲伤'],
    ];
    for (const [text, want] of real) {
      const r = emo.parseText(text);
      check(`★ 「${text}」→ 读成「${want}」`, !!r && r.primary === want, r ? r.label : '(空)');
    }

    // ④ 单字词确实被默认跳过；开了开关它就会回来（证明"跳过"是我们主动做的）
    check('★ 默认跳过单字词（「好烦」读不出愤怒）',
      (emo.parseText('好烦') || { hits: 0 }).hits === 0, JSON.stringify(emo.parseText('好烦')));
    const single = emo.parseText('好烦', { allowSingleChar: true });
    check('  └ 显式打开 allowSingleChar 后，「烦」就会命中（开关有效）',
      !!single && single.hits > 0, single ? single.label : '(空)');

    // ⑤ 强度分档与"多情绪并列"
    const lv = (t) => (emo.parseText(t) || {}).level;
    check('★ 程度词会把强度抬档（「有点难过」< 「超级难过」）',
      lv('有点难过') <= lv('超级难过'), `${lv('有点难过')} vs ${lv('超级难过')}`);
    const multi = emo.parseText('又难过又生气，还有点害怕');
    check('★ 一句话读出多种情绪（不是只取一个）',
      !!multi && Object.keys(multi.emotions).length >= 2, multi ? JSON.stringify(multi.emotions) : '');

    check('★★ 同一个词在同一条消息里**只算一次**（防分数虚高）',
      (() => {
        const r = emo.parseText('喜欢 然后 又说了一遍 喜欢');
        const w = r.hitWords['爱'] || [];
        // "喜欢"出现两次，但只该计一次；也不能在结果里出现两遍
        return w.length === 1 && w[0] === '喜欢';
      })(), JSON.stringify(emo.parseText('喜欢 然后 又说了一遍 喜欢')));

    // ⑥ 边界：空文本 / 纯符号 / 超长文本都不扔异常、不误判
    check('  空文本 / 纯符号 → 不判情绪、不抛异常',
      emo.parseText('') === null && (emo.parseText('  ') || { hits: 0 }).hits === 0
      && (emo.parseText('。。。！！！') || { hits: 0 }).hits === 0);
    check('  超长文本不炸（取 5000 字也能跑完）',
      (() => { try { emo.parseText('难过'.repeat(2500)); return true; } catch { return false; } })());

    // ⑦ observe()：去重 + 抽样为 0 时完全不动作
    emo._resetSeen();
    const o1 = emo.observe({ msgId: 'EMO_TEST_1', openid: 'OP', text: '今天好难过', isAt: false, rate: 1 });
    const o2 = emo.observe({ msgId: 'EMO_TEST_1', openid: 'OP', text: '今天好难过', isAt: false, rate: 1 });
    check('★ 同一条消息只观察一次（防日志重复污染统计）', !!o1 && o2 === null);
    check('  └ rate=0 时完全不动作', emo.observe({ msgId: 'EMO_TEST_2', text: '好难过', rate: 0 }) === null);
    check('  没有 msgId 也不炸（只是不做去重）',
      !!emo.observe({ openid: 'OP', text: '很难过' }));

    // ⑧ 🔴 副作用闸：这个模块**只能打日志**，不许发消息 / 落盘 / 动上下文
    check('★★ emotion.js 里没有发消息、没有写文件、没有碰上下文',
      !/sendGroupMessage|sendPrivateMessage|qqapi/.test(esrc)
      && !/writeFileSync|appendFileSync|mkdirSync/.test(esrc)
      && !/pushContext|contexts/.test(esrc));
    check('★ 默认配置：观察器开着但**只观察**（没有"注入"这类字段）',
      cfg.policy.emotionObserve.enabled === true
      && cfg.policy.emotionObserve.allowSingleChar === false
      && !('inject' in cfg.policy.emotionObserve));
  }

  console.log('\n=== 33. ⭐ 官方余额（"没钱了"的真闸）+ 额度 20→30 ===');
  {
    // 🆕 2026-10-05 用户提议「额度不能直接同步官方的吗」—— 能，见 budget.js。
    //    DeepSeek: GET /user/balance → is_available + balance_infos[]
    //    （currency / total_balance / granted_balance / topped_up_balance）
    // 🔴 分工：**本地管"日"，官方管"总额"** —— 官方没有"今天花了多少"，
    //    所以 ¥3/天 那道闸只能本地算。
    // ⚠️ 三条安全设计里最重要的一条：**查不到就不拦**（fail-open）——
    //    网络抖一下不能把机器人弄哑（还有本地那道兜底）。
    const budget = require('./budget');
    const bsrc = require('fs').readFileSync(require('path').join(__dirname, 'budget.js'), 'utf8');

    check('★ 额度默认值 20 → 30（本地口径；官方余额才是真闸）',
      cfg.budget.totalLimitYuan === 30, String(cfg.budget.totalLimitYuan));

    // ① 查不到（没缓存过）→ 不拦，照常能花（fail-open）
    budget.setBalanceForTest(null);
    const r0 = budget.canSpend();
    check('★★ 官方余额**查不到时不拦**（fail-open，不把机器人弄哑）',
      r0.ok === true, JSON.stringify(r0));
    check('  └ 官方查询挂在 canSpend 里（不是另开一条路）',
      String(budget.canSpend).includes('今天的话费花完了'));
    check('  └ 阈值取 officialWarnYuan',
      String(budget.balanceInfo).includes('officialWarnYuan'));

    // ② 有余额且充足 → 放行
    budget.setBalanceForTest(12.5);
    const r1 = budget.canSpend();
    check('★ 官方余额充足（¥12.5）→ 放行', r1.ok === true, JSON.stringify(r1));

    // ③ 官方余额见底 → 拦住，且理由里带上真实余额
    budget.setBalanceForTest(0.4);
    const r2 = budget.canSpend();
    check('★★ 官方余额见底（¥0.4 < 阈值 ¥1）→ 拦住',
      r2.ok === false && /0\.40/.test(r2.reason), JSON.stringify(r2));

    // ④ 官方标记 is_available=false → 也要拦（欠费/被限）
    budget.setBalanceForTest(5, { available: false });
    const r3 = budget.canSpend();
    check('★ 官方标记"账户不可用"→ 拦住', r3.ok === false, JSON.stringify(r3));

    // ⑤ 恢复 + 边界：正好等于余额阈值时放行（判据是 `<`，不是 `<=`）
    budget.setBalanceForTest(1);
    check('  边界：余额正好等于阈值 ¥1 → 放行（判据用 <）', budget.canSpend().ok === true);

    // ⑥ 绝不误拦：查询失败后余额变成 null，下一轮应放行
    budget.setBalanceForTest(null, { err: 'HTTP 500' });
    check('★ 查询失败（err）→ 记录错误但**不拦**',
      budget.canSpend().ok === true && budget.balanceInfo().ok === false);

    // ⑦ 关掉开关就不查（用户可用 BUDGET_BALANCE=0 退回纯本地口径）
    check('  有"关掉官方查询"的开关（BUDGET_BALANCE=0）',
      /officialBalance/.test(bsrc) && /BUDGET_BALANCE/.test(
        require('fs').readFileSync(require('path').join(__dirname, 'config.js'), 'utf8')));
    check('  官方查询是**只读**的：从来不写本地账本',
      !/fetchOfficialBalance[\s\S]{0,600}?save\(\)/.test(bsrc));

    budget.setBalanceForTest(12.5);   // 收尾：留一个正常值，别影响后面的用例

    // ⑧ 对外可见性：日志网页是**另一个进程**，只能靠文件 ——
    //    所以"官方口径"必须出现在落盘对象和 /api 的返回里，否则手机上还是看不到。
    const ps = budget.persistedStatus();
    check('★ 官方口径进了**落盘对象**（日志网页跨进程只能靠文件）',
      !!ps.official && typeof ps.official === 'object' && 'total' in ps.official,
      JSON.stringify(ps.official));
    // 🆕 2026-10-06：页面模板已抽到 tools/page.js（唯一真源）—— 卡片/版式类断言看它
    const lsrc = require('fs').readFileSync(require('path').join(__dirname, 'tools', 'page.js'), 'utf8');
    // ⚠️ 注意：页面在 2026-10-05 重做过一次，卡片现在由前端 renderBudget() 生成
    //    ⇒ 断言要看**现在这段代码**，不能盯着旧模板（我改 UI 时这几条一起红了）。
    // 🔴 2026-10-06：**"累计已花锚点/官方口径"已按用户要求删除**
    //    （原话「不需要那个锚点，我自己看，删掉」）⇒ "累计已花"只用本地账本。
    check('★★ 网页的"累计已花"**只用本地账本**（锚点/官方口径已删干净）',
      /card\(yuan\(b\.spentYuan\), '累计已花 \/ 上限 '/.test(lsrc)
      && !/official\.spent/.test(lsrc) && !/BUDGET_ANCHOR_YUAN/.test(lsrc));
    // ⚠️ 断言锚定"输出上下文"，不是扫整个源文件 —— 否则注释里一提那四个字就报红
    //    （我为此连踩两次，见 lesson"不许出现X的断言别扫全文件"）。
    check('★★ 累计已花**不带来源标注**（用户要求删掉那个尾巴）',
      !/累计已花（官方）|累计已花（本地估）/.test(lsrc), '页面上还带着来源标注');
    check('★★ 但**上限必须留着**（我一开始把上限一起删了，被用户抓出来）',
      /累计已花 \/ 上限 ' \+ yuan\(b\.totalLimit\)/.test(lsrc), '累计已花那张卡丢了上限');
    check('★★ 但**不展示官方余额**（用户明确说「日志不需要加官方余额」）',
      !/official\.ok \? '¥'/.test(lsrc) && !/官方余额（充值到账即变）/.test(lsrc),
      '页面里还在渲染余额数字');
    // ⑨ 版式统一：每张卡 = 一个大数字 + 一句说明，数字里不夹 "/ 上限"
    check('★★ 卡片版式统一：**数字里不夹 "/ 上限"**（用户指出第 3 张跟前面不一样）',
      /function card\(big, small, warn\)/.test(lsrc)
      && !/card\(\(b\.dayCalls\|\|0\) \+ ' \/ '/.test(lsrc) && !/' \/ ' \+ \(b\.dailyCallLimit/.test(lsrc));
    check('  └ 调用次数卡也用同一个 card() 函数（不再手写两值）',
      /card\(\(b\.dayCalls\|\|0\), '今日调用 \/ 上限 '/.test(lsrc));
    // 🔴 补一条：**三类数字都要带"上限"**（今日已花 / 今日调用 / 累计已花）——
    //    我删来源标注时把累计已花的上限一起删了，用户立刻抓到。
    check('★★ 三类数字**都带"上限"**（今日已花 / 今日调用 / 累计已花）',
      /今日已花 \/ 上限 ' \+ yuan\(b\.dailyLimit\)/.test(lsrc)
      && /累计已花 \/ 上限 ' \+ yuan\(b\.totalLimit\)/.test(lsrc)
      && /今日调用 \/ 上限 ' \+ \(b\.dailyCallLimit/.test(lsrc), '有卡片丢了上限');
  }

  console.log('\n=== 34. ⭐ 纯寒暄（早安/晚安）→ 零成本固定应答 ===');
  {
    // 🔴 真实案例（用户报的）：群里有人发「早安肥鱼」，鱼回了
    //    「早啊，今天又来找我聊天？」—— 对方只是打个招呼、根本没有下文，
    //    那句话等于**给不存在的对话起了个标题**。
    //    根因：「肥鱼」命中关键词 → shouldReply() 固定给 9 分、完全不判断 → 直接生成。
    // ⇒ 判据（故意做窄，判不准走原流程）：剥掉名字后**只剩寒暄词** + ≤6 字 +
    //    无疑问/请求 + **必须点名**。
    const brain = require('./brain');
    const mk = (content) => ({ content, mentions: [], author: { username: '群友' } });
    const g = (text, isAt = false) => brain.isPureGreeting(mk(text), { isAt });

    // ① 该认的：点名 + 纯寒暄
    for (const [text, want] of [['早安肥鱼', 'hello'], ['晚安肥鱼', 'bye'], ['拜拜肥鱼', 'bye'],
      ['早啊蓝色大肥鱼', 'hello'], ['小蓝鲸早', 'hello']]) {
      const r = g(text);
      check(`★ 「${text}」→ 认成纯寒暄（${want}）`, r.greeting && r.kind === want, JSON.stringify(r));
    }
    check('  被 @ 但没有名字也能认（「<@bot> 早安」）', g('<@BOT> 早安', true).greeting === true);
    check('  ⚠️ 关键：认的是**关键词表里的名字**（肥鱼），不是只认人设全名',
      g('早安肥鱼').greeting === true);

    // ② 绝不能误判的（这些吞掉就坏了）
    for (const text of ['早安肥鱼，今天天气怎么样', '早安，帮我看看这个报错',
      '大肥鱼你话怎么这么多', '早', '肥鱼', '晚安']) {
      check(`★★ 「${text}」→ **不算**纯寒暄（该走正常流程）`, g(text).greeting === false,
        JSON.stringify(g(text)));
    }
    check('  没点名、只是提了名字的寒暄也不算（「早」单发不理）', g('早').greeting === false);
    check('  空消息 / 缺字段不抛异常', g('').greeting === false && brain.isPureGreeting(null).greeting === false);

    // ③ 配置与接线
    check('★ 配置存在且有 hello/bye 两套应答',
      cfg.policy.greetingReply.enabled === true
      && Array.isArray(cfg.policy.greetingReply.hello)
      && Array.isArray(cfg.policy.greetingReply.bye));
    const isrc = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    check('★★ 命中后**直接发固定应答并 return**（不调模型、不追问）',
      /纯寒暄（\$\{g\.word\}）→ 回固定应答，不调模型/.test(isrc)
      && /isPureGreeting\(d, \{ isAt: !!l0\.isAt \}\)/.test(isrc));
    check('  └ 这段在 L1 判断之**前**（否则模型照样被调用 = 白花一次钱）',
      isrc.indexOf('纯寒暄') < isrc.indexOf('brain.shouldReply'));
  }

  console.log('\n=== 35. ⭐ 「刚刚处理过的链接」→ 让鱼答得对（答偏修复）===');
  {
    // 🔴 真实案例：群友发了 B站 15 小时半的视频 → 卡片正常发了、视频按规矩跳过；
    //    45 秒后他问「给我解析刚刚发的链接」，鱼答：
    //    「链接点开就是个 b23.tv 的跳转，**我这边又看不到视频画面，解析不了**。」
    //    —— **答偏了**：它不知道自己刚发过卡片、也不知道视频为什么没发。
    // ⇒ 修法：发卡片 / 跳过视频时各记一笔，生成回复时把这几句事实塞进 prompt。
    const lp = require('./linkparse');
    const S = 'group:LINKNOTE_TEST';
    lp._recentReset();

    // ① 没记录时不产生任何东西（零影响）
    check('★ 没处理过链接时，contextNote 是空串（对普通对话零影响）',
      lp.contextNote(S) === '');

    // ② 发了卡片 → 生成的事实里要带平台名和标题
    lp.noteCard(S, { platform: 'bilibili', title: '【看封面 全四部】4K超清未删减完整版', duration: '15:29:29' }, 'card');
    const note = lp.contextNote(S);
    check('★ 发过卡片 → 事实里带平台名与标题',
      note.includes('B站') && note.includes('看封面'), note.slice(0, 80));
    check('  └ 带时长（模型才知道"15 个半小时"有多长）', note.includes('15:29:29'), '');
    check('  └ 明确交代"卡片已经发过了、别再说解析不了"',
      note.includes('已经发过') && note.includes('解析不了'), '');

    // ③ 视频被跳过 → 原因要写进去（这才是"答得对"的关键）
    lp.noteVideoSkip(S, '时长 929 分钟，超过上限 10 分钟，搬不动');
    const note2 = lp.contextNote(S);
    check('★★ 视频被跳过 → 事实里写明原因（不是笼统的"没发"）',
      note2.includes('没有发') && note2.includes('929 分钟'), note2.slice(0, 120));

    // ④ 换一个群互不影响（按群隔离）
    check('★ 按群隔离：别的群读不到这个群的记录', lp.contextNote('group:OTHER_TEST') === '');

    // ⑤ 接线：generateReply 真的把这段话拼进了 user（不联网，读源码断言）
    const bsrc = require('fs').readFileSync(require('path').join(__dirname, 'brain.js'), 'utf8');
    check('★★ brain.generateReply 会把 linkNote 拼进 prompt',
      /const linkPart = linkNote \? /.test(bsrc) && bsrc.includes('【刚刚发生的】'));
    const isrc2 = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    check('★★ index.js 三处接线都在：发卡片记账 / 跳过视频记账 / 生成时带上',
      isrc2.includes("require('./linkparse')") && isrc2.includes('contextNote(scope)')
      && isrc2.includes('noteVideoSkip(scope') && isrc2.includes("linkparse.noteCard(scope, lastCardInfo"));
    check('  └ 视频跳过时也带 scope（否则记到了空 key 上，等于没记）',
      isrc2.includes('sendVideo(d, vtarget.info, openid, scope)'));

    // ⑥ 边界：缺字段不炸
    check('  缺字段 / null 都不抛异常',
      (() => { try { lp.noteCard(S, null); lp.noteVideoSkip(S, null); lp.contextNote(''); return true; } catch { return false; } })());

    lp._recentReset();
  }

  console.log('\n=== 36. ⭐ 记忆（全群共享便签本 · 隐私护栏 · 上限淘汰）===');
  {
    // 方案见仓库外《记忆功能方案-2026-10-05.md》。三个要点：
    //   ① 作用域 = 全群共享（**没有"私密记忆"这个概念**）
    //   ② 第一版只做"显式记"，不做自动抽事实
    //   ③ 🔴 **敏感内容一律拒收** —— 全群共享 + 存私密 = 把私密挂在群里
    const mem = require('./memory');
    mem._reset();

    // ① 指令识别（要窄：陈述句不能误判成"要记东西"）
    check('★ 「记住我在天津」→ 认成 add', mem.parseCommand('记住我在天津')?.action === 'add');
    check('  「记一下 群活动每周五」→ 认成 add', mem.parseCommand('记一下 群活动每周五')?.action === 'add');
    check('  「忘掉天津」→ 认成 del', mem.parseCommand('忘掉天津')?.action === 'del');
    check('  「你都记得什么」→ 认成 list', mem.parseCommand('你都记得什么')?.action === 'list');
    check('★★ 陈述句不能误判：「我记住了」/「记住这个干嘛」不算指令',
      mem.parseCommand('我记住了') === null && mem.parseCommand('记住这个干嘛') === null,
      JSON.stringify([mem.parseCommand('我记住了'), mem.parseCommand('记住这个干嘛')]));

    // ② 🔴 隐私护栏：12 类探针**必须全拒**
    const privacyProbes = [
      '我的手机号是 13812345678',
      '我邮箱 abc@example.com',
      '微信号：wxid_abc12345',
      '我的身份证 110101199001011234',
      '密码是 qwerty123',
      '验证码 8899',
      '我住在 3 号楼 502',
      '我宿舍楼 12-305',
      '我最近确诊了癌症',
      '这事别告诉别人',
      '我支付宝余额 8000',
      '银行卡 6222021234567890123',
    ];
    let rejected = 0;
    for (const p of privacyProbes) {
      const r = mem.add(p, 'OPENID');
      if (!r.ok && r.why === 'privacy') rejected += 1;
    }
    check(`★★ 敏感内容 ${privacyProbes.length} 条探针**全部拒收**（宁可没记住，不可错收）`,
      rejected === privacyProbes.length, `拒了 ${rejected}/${privacyProbes.length}`);

    // ③ 正常内容能记住 + 召回
    mem._reset();
    check('★ 普通事实记得住', mem.add('主人不吃香菜', 'OPENID').ok === true);
    check('  重复记同一条不产生第二条（更新即可）',
      mem.add('主人不吃香菜', 'OPENID').ok === true && mem._all().length === 1);
    mem.add('群里每周五晚上开黑', 'OPENID');
    const hit = mem.recall('香菜');
    check('★★ 相关查询召回得到', hit.length >= 1 && hit[0].text.includes('香菜'), JSON.stringify(hit));
    const miss = mem.recall('今天天气怎么样');
    check('★ 不相关的查询召不回（阈值起作用）', miss.length === 0, JSON.stringify(miss));
    check('  召回是**纯函数**：算完不改计数（调用方显式 markHit）',
      mem.stats().recalled === 0, JSON.stringify(mem.stats()));
    mem.markHit(hit.map((x) => x.id));
    check('  markHit 之后 recalled 计数 +1', mem.stats().recalled === 1);

    // ④ 预算裁剪：条数与字数封顶
    mem._reset();
    for (let i = 0; i < 10; i++) mem.add(`测试记忆条目编号${i}关于同一个话题`, 'O');
    const many = mem.recall('测试记忆条目');
    check('★★ 召回条数封顶（默认最多 3 条）', many.length <= 3, String(many.length));
    const chars = many.reduce((a, x) => a + x.text.length, 0);
    check('  召回字数封顶（默认 120 字）', chars <= 120, String(chars));

    // ⑤ render 纯函数
    check('★ render 拼出带标题的清单', mem.render([{ text: '甲' }, { text: '乙' }])
      .startsWith('【群里记得的事】') && mem.render([]) === '');

    // ⑥ 删
    mem._reset();
    mem.add('主人不吃香菜', 'O');
    mem.add('群里周五开黑', 'O');
    const del = mem.remove('香菜');
    check('★ 「忘掉 X」删掉含关键词的条目', del.ok === true && del.removed === 1 && mem._all().length === 1);
    check('  删不存在的东西不会乱删', mem.remove('不存在的东西').removed === 0);

    // ⑦ 上限淘汰：**先打日志再丢**，绝不静默
    mem._reset();
    cfg.policy.memory.maxItems = 5;
    for (let i = 0; i < 8; i++) mem.add(`第${i}条记忆`, 'O');
    check('★ 超过条数上限会淘汰（留 5 条）', mem._all().length === 5, String(mem._all().length));
    check('  淘汰是"最少用到的最先走"（都等于 0 时留最新的）',
      mem._all().includes('第7条记忆') && !mem._all().includes('第0条记忆'), JSON.stringify(mem._all()));
    cfg.policy.memory.maxItems = 200;

    // ⑧ 副作用闸 + 回滚开关
    const msrc = require('fs').readFileSync(require('path').join(__dirname, 'memory.js'), 'utf8');
    check('★★ memory.js **不发消息、不碰上下文、不联网**',
      !/sendGroupMessage|sendPrivateMessage|qqapi|pushContext|contexts|fetch\(/.test(msrc));
    check('★★ 有回滚开关（`memory.enabled = false` 立刻回到没有记忆）',
      cfg.policy.memory.enabled === true && /function on\(\)/.test(msrc));
    mem._reset();
  }

  console.log('\n=== 37. ⭐ 面板：对话卡片解析 + 可改参数（白名单/密钥掩码）===');
  {
    // 用户需求原话：「日志显示不清晰……很多纯英文乱码，那个对我来说没有用……
    //   建议是日志显示提问者+决策+回答，不同群/私聊放不同卡片，卡片首行是群名和群号」
    const convo = require('./tools/convo');
    const settings = require('./settings');

    // ① 解析：把一条"群消息 → 决策 → 回答"拼成一张卡
    const journal = [
      '2026-10-05T18:07:35+08:00 host node[1]: [群] GROUP_MESSAGE_CREATE | 小明: 早安肥鱼',
      '2026-10-05T18:07:35+08:00 host node[1]:   ├ message_type=0 mentions=[]',
      '2026-10-05T18:07:36+08:00 host node[1]:   ├ 纯寒暄（早安）→ 回固定应答，不调模型',
      '2026-10-05T18:07:36+08:00 host node[1]: [send:group] ✓ 早',
      '2026-10-05T18:07:40+08:00 host node[1]: [群] GROUP_MESSAGE_CREATE | 小红: 帮我看个报错',
      '2026-10-05T18:07:41+08:00 host node[1]: [ai] deepseek-flash in=1200 out=30 缓存0%',
      '2026-10-05T18:07:41+08:00 host node[1]:   └ 不回（连续发言已达上限(2)）',
    ].join('\n');
    const cs = convo.parseConversations(journal, { max: 10 });
    check('★ 解析出 2 张对话卡（最新的在前）', cs.length === 2, String(cs.length));
    check('★ 卡片里有"提问者 + 他说的话"', cs[0].who === '小红' && cs[0].text === '帮我看个报错',
      JSON.stringify(cs[0]));
    check('★★ 决策行被保留且**人话化**（"不回（…）"）',
      /不回/.test(cs[0].decision || ''), JSON.stringify(cs[0].decision));
    check('★ 回复被归到对应那张卡上（"早"）', cs[1].replies[0] === '早', JSON.stringify(cs[1].replies));
    check('★★ 英文/内部噪音**不出现**在卡片里（message_type= / [ai] in=out=）',
      !JSON.stringify(cs).includes('message_type') && !JSON.stringify(cs).includes('in=1200'),
      JSON.stringify(cs[0]));
    check('  私聊能被识别成 private', convo.parseConversations(
      '2026-10-05T18:08:00+08:00 host node[1]: [私聊] C2C_MESSAGE_CREATE | 小王: 在吗', { max: 5 })[0].kind === 'private');
    check('  空输入不炸', convo.parseConversations('', { max: 5 }).length === 0);

    // ② 可改参数：白名单 + 密钥掩码
    const snap = settings.snapshot();
    check('★ 面板能拿到可改项（含密钥、额度、次数）',
      !!snap.aiApiKey && !!snap.budgetDaily && !!snap.budgetTotal && !!snap.dailyCalls,
      JSON.stringify(Object.keys(snap)));
    check('★★ **密钥绝不回显**：只给掩码（含 …）', (() => {
      const v = snap.aiApiKey.value || '';
      return v === '' || (v.includes('…') && v.length <= 14);
    })(), JSON.stringify(snap.aiApiKey && snap.aiApiKey.value));
    check('★★ **白名单**：不在登记表里的键一律拒改',
      settings.update({ 乱来的键: 1 }).ok === false);
    check('★ 数值有区间闸（把每天限额设成 0 应被拒）',
      settings.update({ budgetDaily: 0 }).ok === false);
    check('  区间内的值能存下来（写入 data/settings.json）',
      (() => {
        const before = settings.values().budgetDailyYuan;
        const r = settings.update({ budgetDaily: 3.5 });
        const after = settings.values().budgetDailyYuan;
        settings.update({ budgetDaily: Number.isFinite(before) ? before : 3 });   // 还原
        return r.ok && after === 3.5;
      })());
    check('★★ 密钥写入前会**备份 .env**（源码里有 .bak- 逻辑）',
      /\.bak-\$\{Date\.now\(\)\}/.test(require('fs').readFileSync(
        require('path').join(__dirname, 'settings.js'), 'utf8')));

    // 🔴 2026-10-06 用户三条调整：
    //    「把合并群功能删了吧，没必要，那是修代码才导致出现问题，正常使用应该不会」
    //    「还要图中这串乱码，算群内码吧，对我来说没啥用，非要写可以固定在卡片群昵称旁边
    //      或者下面独占一行给你当日志用，**那个框框默认空缺拿来填群号**」
    // 🆕 2026-10-06：页面模板已抽到 tools/page.js（唯一真源）—— 页面相关断言看它
    // ⚠️ 2026-10-06：页面模板已抽到 tools/page.js（唯一真源）
    //    ⇒ `lw` 指**页面模板**（历史原因沿用这个名字），`pg` 指 logweb.js 的运行逻辑
    const lw = require('fs').readFileSync(require('path').join(__dirname, 'tools', 'page.js'), 'utf8');
    const pg = require('fs').readFileSync(require('path').join(__dirname, 'tools', 'logweb.js'), 'utf8');
    check('★★ 合并群功能**已删**（用户要求：那是修代码引入的补丁）',
      !/mergeGroup/.test(lw) && !/合并到…/.test(lw) && !/patch\.move/.test(lw),
      '还残留合并相关代码');
    check('★★ 群内码是**只读展示**（不再占输入框；输入框改成填群号）',
      /class="gcode">群内码/.test(lw)
      && /placeholder="群号（自己填，方便你认）"/.test(lw)
      && !/data-f="id"/.test(lw));
    check('★ 群号存进 `no` 字段（不再覆盖群内码），群内码由 scope 推导',
      /groupNo: al\.no \|\| ''/.test(pg) && /const mReal = \/\^group:/.test(pg));
    check('  读取侧仍兼容历史 `movedTo`（万一旧数据里登记过，别变坏卡）',
      /scopeAlias\.get\(key\)/.test(pg));

    // 🔴 2026-10-06 用户又问了两件事：
    //    「每个群卡片的收录消息上限是多少」→ 原来只有**总共 40 条**，活跃群把额度吃光
    //    「卡片内消息排序……每次刷新消息都会出现在卡片最下面了，要去翻，不合理，**排序反一下**」
    check('★★ 每个会话有自己的条数上限（不再是"总共 40 条"被一个活跃群吃光）',
      /perScope: 60/.test(pg) && /const cap = Math\.max\(1, Number\(opts\.perScope\) \|\| 60\)/.test(pg));
    check('★★ convo.js 支持按会话限流（perScope，作者级第一道闸）',
      (() => {
        const csrc = require('fs').readFileSync(require('path').join(__dirname, 'tools', 'convo.js'), 'utf8');
        return /const perScope = Number\(opts\.perScope\)/.test(csrc)
          && /buckets\.get\(key\)\.slice\(-perScope\)/.test(csrc);
      })());
    check('★★ 群级限流在**反查出群号之后**做（作者级限流挡不住"一个群几十个人"）',
      /const byScope = new Map\(\)/.test(pg) && /byScope\.get\(k\)\.slice\(0, cap\)/.test(pg));
    check('★★ 组内**显式按时间倒序**（不能依赖上游顺序 —— 跨群交错后会乱）',
      /const tsec = \(t\) =>/.test(pg)
      && /arr\.sort\(\(a, b\) => tsec\(b\.time\) - tsec\(a\.time\)\)/.test(pg));
    check('★★ 卡内排序**最新在上**（用户要求反过来，别让他往下翻）',
      !/g\.msgs\.slice\(\)\.reverse\(\)/.test(lw)
      && /const msgs = g\.msgs\.map/.test(lw),
      '卡内还在反向排序');
    check('★ 卡片条数标出上限（"N 条（每群最多 60）"）',
      /条（每群最多 60）/.test(lw));

    // 🔴 2026-10-06 用户报：「这些保存是文字啊，不是提交按钮」
    //    真因：模板里**两处 HTML 的收尾字符被吃掉**（输入框少了 `>`、按钮少了 `"`）
    //    ⇒ 渲染成 `<input … value="6"<button …>保存</button>` —— 元素没闭合，
    //      后面的文字被浏览器当纯文本 ⇒ 看起来就是"按钮是文字、点不动"。
    check('★★ 输入框的标签正确闭合（value="…"> 的 > 不能少）',
      // ⚠️ 2026-10-06：设置行多了 textarea 分支（人设补充），写法变了 ⇒ 断言跟着改：
      //    密码分支必须自带收尾 `>`（那个 `>` 被吃过两次，害得按钮变纯文本）
      /type="password" placeholder="留空=不改；粘贴新的会覆盖" value="">'/.test(lw),
      '密码输入框少了收尾 >');
    check('★★ 设置区的「保存」是完整 button 元素且可点（data-save + 事件委托）',
      lw.includes('class="sm" data-save="' + "'" + ' + k + ' + "'" + '">保存</button>')
      && lw.includes('button[data-save]'),
      '按钮标签被截断或没有事件委托');

    // 🔴 2026-10-06（同日第二处）：**密码那一行**的分支也少了收尾 `>`
    //    ⇒ 渲染成 `<input … value=""<button …>保存</button>` ⇒ 密钥那行的按钮也变纯文本。
    //    ⚠️ 教训：这种"标签少一个字符"的错误，**光看源码字符串看不出来**
    //       ⇒ 所以这里**真去渲染一遍**（在 vm 里跑 renderSettings），检查生成的 HTML。
    check('★★ 渲染后：4 input + 1 textarea + 5 button 全部标签完整', (() => {
      try {
        const vm = require('vm');
        const TICK = String.fromCharCode(96);
        const sm = 'const PAGE = (opts) => ' + TICK;
        const st = lw.indexOf(sm);
        let i = st + sm.length, en = -1;
        while (i < lw.length) { if (lw[i] === TICK && lw[i + 1] === ';') { en = i; break; } i++; }
        const tpl = lw.slice(st + sm.length, en);
        const js = /<script>([\s\S]*)<\/script>/.exec(tpl)[1].replace(/\$\{JSON\.stringify\([^)]*\)\}/g, '"PW"');
        const els = {};
        // ⚠️ 2026-10-07：页面新增了音效开关（会在元素上 addEventListener）
        //    ⇒ 元素桩必须带 addEventListener，否则脚本在 vm 里抛错、断言假失败（这已是第三次踩）
        const getEl = (id) => els[id] || (els[id] = {
          id, innerHTML: '', textContent: '', style: {}, className: '', dataset: {},
          tagName: 'DIV', addEventListener: () => {},
        });
        const sb = {
          console, JSON, Date, Math, Number, String, Array, Object, RegExp, Error, isNaN, parseInt, parseFloat,
          document: {
            getElementById: getEl,
            querySelector: () => null,
            querySelectorAll: () => [],
            cookie: '', addEventListener: () => {},
            // ⚠️ 2026-10-06：页面加了"分页面"逻辑（initPages 会碰 body）
            //    ⇒ 沙箱必须补这两样，否则脚本在 vm 里抛错、这条断言会假失败
            body: { setAttribute: () => {}, getAttribute: () => '' },
          },
          window: { addEventListener: () => {} },
          setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
          fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
          alert: () => {}, confirm: () => true,
        };
        sb.globalThis = sb;
        vm.createContext(sb);
        vm.runInContext(js, sb);
        sb.renderSettings({
          aiApiKey: { label: 'AI 密钥', value: 'sk-74f…111', secret: true, type: 'env' },
          budgetDaily: { label: '每天限额（元）', value: 6, type: 'runtime' },
          budgetTotal: { label: '总限额（元）', value: 30, type: 'runtime' },
          dailyCalls: { label: '调用上限（次）', value: 1600, type: 'runtime' },
          // 🆕 2026-10-06 用户要求：**人设补充不再单独成行**（合并进「人设」框）
          //    ⇒ 面板变成 4 个 input + **1 个 textarea（人设）** + 5 个保存按钮
          personaText: { label: '人设（整段可改，留空=用默认）', value: '你是测试鱼。', type: 'runtime', text: true },
        });
        const h = els.settings.innerHTML;
        const nIn = (h.match(/<input[^>]*>/g) || []).length;
        const nBtn = (h.match(/<button[^>]*>[^<]*<\/button>/g) || []).length;
        // 面板现在 4 项（AI 密钥 / 每天限额 / 总限额 / 调用上限）—— 锚点那行已删
        // 面板 5 行：AI 密钥 / 每天限额 / 总限额 / 调用上限（4 个 input）+ 人设补充（1 个 textarea）
        const nTa = (h.match(/<textarea[^>]*>/g) || []).length;
        return nIn === 4 && nTa === 1 && nBtn === 5 && !/value=""\s*<button/.test(h);
      } catch (e) { return false; }
    })(), '渲染后的标签不完整（有被吞掉的收尾字符）');

    // 功能性验证：perScope 真的按会话各留 N 条
    const conv2 = require('./tools/convo');
    const mk = (who, n) => {
      const out = [];
      for (let i = 1; i <= n; i++) out.push(`2026-10-06T10:0${i % 10}:0${i % 10}+08:00 host node[1]: [群] GROUP_MESSAGE_CREATE | ${who}: 消息${i}`);
      return out;
    };
    const j2 = [...mk('A', 5), ...mk('B', 3)].join('\n');
    const all = conv2.parseConversations(j2, { max: 100, perScope: 60 });
    const capped = conv2.parseConversations(j2, { max: 100, perScope: 2 });
    const aCapped = capped.filter((c) => c.who === 'A').length;
    const bCapped = capped.filter((c) => c.who === 'B').length;
    check('★ perScope=2 时，A（5 条）留 2 条、B（3 条）也留 2 条（各会话独立）',
      aCapped === 2 && bCapped === 2, `A=${aCapped} B=${bCapped}`);
    check('★ 不限流时都在（A=5 B=3）', all.length === 8, String(all.length));
    check('★ 解析结果**最新在上**（两条以上时第一条比第二条新）',
      conv2.parseConversations(j2, { max: 100 })[0].text === '消息3',
      conv2.parseConversations(j2, { max: 100 })[0].text);
  }

  console.log('\n=== 38. ⭐ 同群发送排队（两个人同时问 → 8 条交叉刷出来）===');
  {
    // 🔴 用户原话：「两个人连续提问，然后两个回答都是 4 条消息，
    //    那会一次性回复 8 条消息，没有艾特也没有引用」（已确认：**同一个群**）
    // 根因：gateway 是 Promise.resolve().then(onEvent) —— 事件之间不排队；
    //      分段发送里每个 await sleep() 都是交叉点。
    const q = require('./sendqueue');
    const isrc = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const gsrc = require('fs').readFileSync(require('path').join(__dirname, 'gateway.js'), 'utf8');

    // ① 先坐实根因还在（不是"我以为会并发"）
    check('★ 根因确认：gateway 的事件回调**没有排队**（所以并发是可能的）',
      /\.then\(\(\) => onEvent\(p\.t, p\.d\)\)/.test(gsrc) && !/await onEvent/.test(gsrc));

    // ② 同群两串必须完整串行（异步真跑一遍）
    const order = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mA = {}; const mB = {};
    const pa = q.enqueue('test:g1', mA, async () => {
      for (let i = 1; i <= 4; i++) { order.push('A' + i); await sleep(8); }
      return 4;
    });
    await sleep(3);
    const pb = q.enqueue('test:g1', mB, async () => {
      for (let i = 1; i <= 4; i++) { order.push('B' + i); await sleep(8); }
      return 4;
    });
    const [ra, rb] = await Promise.all([pa, pb]);
    check('★★ 同一个群里两串 4 条**完整不交叉**（用户报的 8 条乱序）',
      order.join('') === 'A1A2A3A4B1B2B3B4', order.join(' '));
    check('★★ 排队不影响返回值（曾把返回值吃掉 ⇒ 发送失败会被当成已回复）',
      ra === 4 && rb === 4, `${ra}/${rb}`);
    check('★★ 排在后面的那串会被标记 queuedBehind（据此加引用，解决"没引用分不清回谁"）',
      !mA.queuedBehind && mB.queuedBehind === true);
    check('  不同群之间不互相排队（不能因为 A 群忙而拖慢 B 群）', (() => {
      const mC = {};
      q.enqueue('test:g2', mC, async () => 1);
      return mC.queuedBehind === false;
    })());
    check('  前一个任务抛错不会卡死队列', await (async () => {
      q.enqueue('test:g3', {}, async () => { throw new Error('模拟失败'); });
      const r = await q.enqueue('test:g3', {}, async () => 7);
      return r === 7;
    })());
    check('  跑完队列会自己清空（不残留内存）',
      (() => { const s = q.stats(); return !s.scopes.includes('test:g1'); })());
    q.reset();

    // ③ 接线断言（逻辑对了但没接上等于没做）
    check('★★ index.js 的发送段落**真的走了队列**',
      /await sendqueue\.enqueue\(scope, sendMeta/.test(isrc));
    check('★ 排队的那串会带引用（quoteWanted || queuedBehind）',
      /quoteWanted \|\| sendMeta\.queuedBehind/.test(isrc));
    check('  额度吃紧时不再拆段（splitAllowed）',
      /splitAllowed\(\)/.test(isrc) && /额度吃紧：不拆段/.test(isrc));
  }

  // ===== 第 39 组：语气示范（examples）面板可改（2026-10-06，用户要的「示范显化」）=====
  {
    // ⚠️ read() 是别的块里定义的局部变量 ⇒ 这里自己来一个
    const rd = (f) => require('fs').readFileSync(require('path').join(__dirname, f), 'utf8');
    const ex = require('./examples');
    const cfg = require('./config');
    const exSrc = rd('examples.js');

    check('★★ 没配过文件时，用的还是代码里的默认 14 组',
      ex.current() === null && cfg.persona.examples.length === 14);

    // 存一组 → config 立刻用它（这就是"面板改完即生效"的机制）
    const r1 = ex.save([{ u: '测试问', a: '测试答' }, { u: '帮个忙', a: '不帮', role: '普通群员' }]);
    check('★ 保存后 config.persona.examples 立刻变成新的一组',
      r1.ok && cfg.persona.examples.length === 2 && cfg.persona.examples[0].u === '测试问');
    check('  role 也保留（身份标注要有用）',
      cfg.persona.examples[1].role === '普通群员');

    check('★ 半截数据（只有"群友说"没有"鱼回"）必须被拒',
      ex.save([{ u: '只有一半' }]).ok === false);
    check('★ 超过 30 组必须被拒（防止把真实群聊挤出上下文）',
      ex.save(new Array(31).fill({ u: 'a', a: 'b' })).ok === false);
    check('★ 非法 role 会被丢掉（不当成身份标注）',
      (() => { const r = ex.save([{ u: 'x', a: 'y', role: '随便写的' }]); return r.ok && !cfg.persona.examples[0].role; })());

    // 🔴 副作用闸：测试模式绝不能写真实的 data/examples.json
    check('★★ 副作用闸：测试模式下**没有真的写文件**',
      process.env.XLJ_NO_PERSIST === '1' && !require('fs').existsSync(ex.FILE)
      || process.env.XLJ_NO_PERSIST !== '1');

    ex.reset();
    check('★ 恢复默认后回到 14 组', ex.current() === null && cfg.persona.examples.length === 14);

    // 接线断言：面板 + 接口都要真接上（逻辑对但没接 = 没做）
    check('★★ 面板有示范表格的接线（exList / exSave / /api/examples）',
      /exList/.test(rd('tools/page.js')) && /exSave/.test(rd('tools/page.js'))
      && /\/api\/examples/.test(rd('tools/page.js')));
    check('★★ 后端接口存在且会做校验（examples.save）',
      /\/api\/examples/.test(rd('tools/logweb.js')) && /ex\.save\(/.test(rd('tools/logweb.js')));
    check('  examples.js 有测试模式保护（不污染线上数据）',
      /XLJ_NO_PERSIST/.test(exSrc));

    // 🔴 2026-10-06 用户报「没看到示范啊」：GET /api/examples 必须返回**当前生效的那份**
    //    （没配过文件时要回落到代码里的默认 14 组，否则表格一片空白 = 功能等于没做）
    check('★★ 示范接口返回"当前生效的那份"（不是空数组）',
      /persona\.examples/.test(rd('tools/logweb.js')));

    // 🔴 2026-10-06 用户报「出现了一个新群」：真因是**某群友昵称就是一个全角空格**
    //    ⇒ 按昵称永远匹配不上 ⇒ 掉成孤儿卡。修法是"只看时间的兜底"。
    check('★★ 有"只看时间"的兜底（治作者名为空导致的孤儿卡）',
      /lookupByTime/.test(rd('tools/logweb.js')) && /how = 'time2'/.test(rd('tools/logweb.js')));
    check('  且空白昵称不再被直接丢掉（仍进全局时间轴）',
      /if \(!w\) continue;/.test(rd('tools/logweb.js')));

    // 🔴 2026-10-06 用户：「给示范卡片加收展功能，默认收，也就是跟其他卡片一样」
    //    ⇒ 示范得是 <details>+<summary>（同「参数设置」），且**不加 open**（默认收起）
    check('★★ 示范卡片可收起、且默认收（跟参数设置同款）',
      /<details data-page="settings">[\s\S]{0,80}<summary>🐟 语气示范/.test(rd('tools/page.js'))
      && !/<details data-page="settings" open>[\s\S]{0,80}<summary>🐟/.test(rd('tools/page.js')));
    check('  「原始日志」仍是默认**展开**（那是另一处要求，别被一起改掉）',
      /<details data-page="raw" open>/.test(rd('tools/page.js')));

    // 🆕 2026-10-07 用户：「界面整体看着太老套了，能不能做高级一点，点击交互音效什么的，
    //    还有展开收拢动画之类的」⇒ 锁住这几样（免得以后重构时被丢掉）
    const pg = rd('tools/page.js');
    check('★★ 展开/收拢有动画（reveal 关键帧 + 图标旋转）',
      /@keyframes reveal/.test(pg) && /details\[open\] > summary::before/.test(pg));
    check('★★ 有点击音效，且是**现场合成**（不加载音频文件、零资源）',
      /AudioContext/.test(pg) && /createOscillator/.test(pg) && /SFX\.click/.test(pg));
    check('★ 音效可一键关（开关按钮 + 记住选择）',
      /id="sfxBtn"/.test(pg) && /localStorage/.test(pg));
    check('★ 尊重系统"减少动效"设置（prefers-reduced-motion）',
      /prefers-reduced-motion/.test(pg));

    // 🔴 2026-10-07 用户报「文字背景同色」：下拉**展开后的选项列表**是浏览器/系统画的，
    //    只给 select 上色不够 ⇒ 必须显式给 option 上色，否则浅色弹层 + 浅色文字 = 看不见
    check('★★ 下拉选项也上了色（否则弹层里"文字背景同色"看不见）',
      /select option/.test(pg) && /background-color:#0d1729/.test(pg));

    // 🔴 这个"模板内反引号"坑咬过我三次 ⇒ 闸门里必须有专门检查（这里锁住闸门本身）
    check('★★ 页面闸门有"模板内不许出现反引号"的专项检查',
      /PAGE 模板\*\*内部\*\*出现了/.test(rd('../devtools/check-page-script.cjs')));
  }

  // ===== 第 40 组：点播式知识（2026-10-07 用户拍板"方案 A"）=====
  {
    const rd = (f) => require('fs').readFileSync(require('path').join(__dirname, f), 'utf8');
    const kn = require('./knowledge');

    // ① 触发判据必须"窄"：**在问**才触发，"提到"不触发（否则"这热搜真离谱"也会去调外部接口）
    //    ⚠️ 2026-10-07 更新：**裸主题词也算"在要"**（用户直接发「历史上的今天」就期望它答，
    //       服务器日志实测过这个洞）⇒ 原先"「热搜」不该触发"的期望改成"应该触发"。
    const cases = [
      ['今天有什么热搜', 'hot'], ['看看微博热搜', 'hot'], ['最近有啥热点吗', 'hot'],
      ['抖音热搜有啥', 'douyin'], ['历史上的今天是什么', 'history'], ['今天是啥日子', 'history'],
      ['热搜', 'hot'], ['历史上的今天', 'history'],        // 裸主题 ⇒ 触发（已按实测修正）
      ['这热搜真离谱', ''], ['你好啊', ''], ['你说的这个热搜我看过', ''],
    ];
    const bad = cases.filter(([t, want]) => kn.detect(t) !== want);
    check('★★ 触发判据：问了才触发、只是提到不触发（' + cases.length + ' 例）',
      bad.length === 0, JSON.stringify(bad));

    // ② 格式化：压成"一小段事实"（要进 user 消息，越长越花钱）
    const raw = ['微博实时热搜', '', '1. 测试热搜A (1887237)', '2. 测试热搜B (958368)'].join('\n');
    const f = kn.format('hot', raw);
    check('★ 格式化：去掉热度数字、只留标题、拼成一句话',
      f.includes('测试热搜A') && f.includes('测试热搜B') && !/\d{6,}/.test(f) && f.length < 120,
      f);
    check('  脏数据（全是没有编号的行）⇒ 返回空串，不硬拼',
      kn.format('hot', '没有编号\n随便几行') === '');

    // ③ fail-open：取不到必须返回空串、**不抛错**
    (async () => {});   // 占位（真正的异步断言在下面同步块里用"已 await 的结果"验）
    check('  配置里有开关与上限（enabled / timeoutMs / dailyLimit）',
      /knowledge\s*:/.test(rd('config.js')) && /dailyLimit/.test(rd('config.js'))
      && /timeoutMs/.test(rd('config.js')));

    // ④ 🔴 接线位置红线：**必须在"已经决定要回话之后"**（外部 1~5s，不能挂主链路）
    const isrc40 = rd('index.js');
    const iLookup = isrc40.indexOf('knowledge.lookup(');
    const iGate = isrc40.indexOf('brain.shouldReply(');
    const iGen = isrc40.indexOf('brain.generateReply(');
    check('★★ 接在"决定回话之后、生成之前"（不能挂主链路）',
      iLookup > 0 && iGate > 0 && iLookup > iGate && iGen > 0 && iLookup < iGen,
      JSON.stringify({ gate: iGate, lookup: iLookup, gen: iGen }));
    check('★ fail-open：取出错也要兜住（try/catch 置空串）',
      /knNote = '';/.test(isrc40) && /catch \(e\)/.test(isrc40));

    // ⑤ knowledge.js 内部的四条红线都在
    const ksrc = rd('knowledge.js');
    check('★★ knowledge.js 有 超时/缓存/每日上限/abort 四件套',
      /AbortController/.test(ksrc) && /ttlMs/.test(ksrc)
      && /dailyLimit/.test(ksrc) && /setTimeout\(\(\) => ctl\.abort/.test(ksrc));
    check('★ 取不到一律返回空串（fail-open），不抛给调用方',
      /\.catch\(\(\) => ''\)/.test(ksrc) && /if \(!raw\) \{/.test(ksrc) && /return '';/.test(ksrc));
    check('  零依赖（只用 fetch，不 require 任何第三方）',
      !/require\('[^.]/.test(ksrc));

    // ⑥ 🔴 2026-10-07 服务器实测后改的关键设计：**有界等待 + 后台预热缓存**
    //    实测那个 API 延迟剧烈抖动（历史上的今天 1.2s~>3s、微博 2.6s~7.8s）
    //    ⇒ 固定超时不可能既快又准 ⇒ 只等一小会儿，等不到就转后台、回来写缓存。
    check('★★ 有界等待（waitMs）与后台兜底（hardTimeoutMs）分开',
      /waitMs/.test(ksrc) && /hardTimeoutMs/.test(ksrc) && /sleep\(src\.waitMs/.test(ksrc));
    check('★★ 并发去重 + 后台预热（inflight 表，回来就写缓存）',
      /inflight/.test(ksrc) && /cache\.set\(kind, \{ at: Date\.now\(\), text: out \}\)/.test(ksrc));
    check('  等不到时**返回空串**（不拖住回话、也不报错）',
      /没等到：请求留在后台继续/.test(ksrc));

    // ⑦ 🔴 2026-10-07 服务器日志抓到的两个洞（都修了，这里锁住）：
    //    洞 1：用户直接发「历史上的今天」这五个字 ⇒ 我的判据要求"带疑问词" ⇒ **没触发**
    //    洞 2：冷缓存 + 只等 2.5 秒 ⇒ 空手回话（鱼只好编"我没刷到"）⇒ **加后台预热**
    const bare = [
      ['历史上的今天', 'history'], ['@蓝色大肥鱼 历史上的今天', 'history'],
      ['抖音热搜', 'douyin'], ['微博热搜', 'hot'], ['热搜', 'hot'],
      ['这热搜真离谱', ''], ['你好', ''],
    ];
    const badBare = []; 
    for (const [t, want] of bare) { if (kn.detect(t) !== want) badBare.push(t + '→' + kn.detect(t)); }
    check('★★ 裸主题词也能触发（「历史上的今天」这种不带疑问词的）',
      badBare.length === 0, JSON.stringify(badBare));
    check('★★ 有后台预热（冷缓存会让第一次问空手，预热让它命中）',
      /function warmOnce/.test(ksrc) && /function startWarm/.test(ksrc)
      && /knowledge\.startWarm\(/.test(rd('index.js')));
    check('  预热用 unref 定时器（不阻止进程退出）+ 有开关',
      /unref/.test(ksrc) && /warm:/.test(rd('config.js')));
  }

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
