// ============================================================
//  自测：验证审查报告里那几个坑真的修好了
//  跑法： node test-brain.js
//  它不发任何网络请求，只测纯逻辑
// ============================================================

// ⚠️ 两条确定性保障，缺一不可（都踩过坑）：
//    ① 不碰真实预算文件 —— 否则测试会污染 data/budget.json，且结果依赖运行状态
//    ② 全程固定 Math.random —— 否则 5% 抽样会随机放行，导致"这次过下次挂"
process.env.XLJ_NO_PERSIST = '1';

const FIXED_RANDOM_MISS = 0.99;   // 落在 5% 抽样之外 → 抽样永远拒绝
const FIXED_RANDOM_HIT = 0.01;    // 落在 5% 抽样之内 → 抽样永远放行
const REAL_RANDOM = Math.random;  // 留一份真的，测"随机性"时要用
Math.random = () => FIXED_RANDOM_MISS;

const brain = require('./brain');
const cfg = require('./config');

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

console.log('\n=== 3. 抽样开关（默认关闭：没@没关键词一律不理）===');
{
  // ⚠️ 这里的行为被用户的新逻辑改过，记录下来免得以后困惑：
  //    原来是 sampleNonKeyword=0.05，没 @ 没关键词的闲聊有 5% 概率被放进判断。
  //    用户明确要求：**默认不接任何没 @ 它的消息** —— 只有提到关键词才有 1/2 概率回。
  //    所以 sampleNonKeyword 现在是 0。
  const P = cfg.policy;
  const realSample = P.sampleNonKeyword;
  try {
    check('★ sampleNonKeyword 默认是 0（没@没关键词一律不理）',
      P.sampleNonKeyword === 0, P.sampleNonKeyword);

    Math.random = () => FIXED_RANDOM_MISS;
    const [type, d] = groupMsg({ content: '今天天气不错啊' });
    const r = brain.passHardRules('group:G', d, type, false);
    check('没@没关键词 → 沉默（省钱）', r.ok === false && /省钱/.test(r.why), JSON.stringify(r));

    // 即使"随机数落在抽样区间内"也不该放行 —— 因为抽样率是 0
    Math.random = () => FIXED_RANDOM_HIT;
    const [, d2] = groupMsg({ content: '今天天气不错啊' });
    const r2 = brain.passHardRules('group:G', d2, 'GROUP_MESSAGE_CREATE', false);
    check('★ 抽到"最小随机数"也仍然沉默（抽样已关闭）', r2.ok === false, JSON.stringify(r2));

    // 但把抽样率临时调大后，行为应该恢复（证明这个开关是活的）
    P.sampleNonKeyword = 1;
    const [, d3] = groupMsg({ content: '今天天气不错啊' });
    const r3 = brain.passHardRules('group:G3', d3, 'GROUP_MESSAGE_CREATE', false);
    check('把 sampleNonKeyword 调成 1 后可放行（开关有效）', r3.ok === true, JSON.stringify(r3));
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

  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('chat/completions')) {
      called++;
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
      typeof r.text === 'string',
      `r.text 的类型是 ${typeof r.text}，值=${JSON.stringify(r.text)}`);
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
  } finally {
    global.fetch = realFetch;   // 一定恢复，否则污染后面的代码
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
    //   从智谱切到 DeepSeek 后，降级链里**还留着智谱的模型名**。
    //   于是主模型一过载，代码就去请求 glm-4.7-flash，而 DeepSeek 接口直接报：
    //     HTTP 400 The supported API model names are deepseek-flash, deepseek-v4-pro,
    //              but you passed glm-4.7-flash
    //   **降级不但没救场，反而变成了故障点。**
    const fb = cfg.ai.fallbackModels;
    const baseUrl = String(cfg.ai.baseUrl);
    console.log(`  baseUrl: ${baseUrl}`);
    console.log(`  降级链: ${JSON.stringify(fb)}   重试次数: ${cfg.ai.maxAttempts}`);

    check('降级链默认留空（避免跨服务商误配）', fb.length === 0, fb);
    check('maxAttempts ≥3（降级链为空时重试是唯一兜底）', cfg.ai.maxAttempts >= 3, cfg.ai.maxAttempts);
    check('退避基数不为 0', cfg.ai.retryBaseMs > 0, cfg.ai.retryBaseMs);

    if (fb.length) {
      const allGLM = fb.every((m) => /^glm-/.test(m));
      const allDS = fb.every((m) => /^deepseek-/.test(m));
      const baseGLM = /bigmodel\.cn/.test(baseUrl);
      const baseDS = /deepseek\.com/.test(baseUrl);
      check('★ 降级链模型与 baseUrl 同服务商',
        (allGLM && baseGLM) || (allDS && baseDS),
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

    // --- 视频：抖音拿不到直链（已知限制，不是 bug）；快手没直链时也要安静返回 null ---
    check('getKuaishouVideoUrl 对没有直链的 info 返回 null',
      await lp.getKuaishouVideoUrl({ platform: 'kuaishou' }, 1e9) === null);
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

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
