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

  console.log('\n=== 12. ⭐ 上下文记忆：条数 + 时效双约束 ===');
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

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
