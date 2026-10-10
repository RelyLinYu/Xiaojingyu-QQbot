// ============================================================
//  群内指令系统的回归测试（纯函数，本地跑，**不发网络请求**）
//
//  跑法：node devtools/test-commands.cjs
//
//  2026-10-10 第二轮（用户反馈后）：
//   · 触发方式**严格**化成 `/加Q 12345`（防误触发）—— 见下面的正/反例
//   · 菜单砍成"标题 + 功能列表"
//   · 卡片砍成"标题 + 号码 + 链接 + 一行短提示"
// ============================================================
const cmds = require('../server/commands');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) console.log(`     期望: ${JSON.stringify(want)}\n     实际: ${JSON.stringify(got)}`);
}
function truthy(name, v) {
  const ok = !!v;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}
function falsy(name, v) {
  const ok = !v;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `（实际: ${JSON.stringify(v)}）`}`);
}

// ---------- 1. 指令识别 ----------
console.log('\n=== 1. 指令识别（触发方式已严格化）===');
const kindOf = (s) => { const m = cmds.match(s); return m ? m.kind : null; };
const numOf = (s) => { const m = cmds.match(s); return m ? m.num : null; };

check('/菜单 → menu', kindOf('/菜单'), 'menu');
check('菜单（无斜杠）→ menu', kindOf('菜单'), 'menu');
check('菜单后面有标点 → menu', kindOf('菜单。'), 'menu');
check('@它 + /菜单 → menu', kindOf('<@ABCDEF> /菜单'), 'menu');
check('／菜单（全角斜杠）→ menu', kindOf('／菜单'), 'menu');
check('help → menu', kindOf('help'), 'menu');
check('菜单栏 → 不命中（防误判）', kindOf('菜单栏在哪'), null);

// 🔴 2026-10-10 用户定死：**斜杠不可省、分隔符只认空格** ⇒ 正写法只有 `/加Q 10001`
check('/加Q 10001 → qq（★ 唯一正写法）', kindOf('/加Q 10001'), 'qq');
check('／加Q 10001（全角斜杠也认，同一个键）→ qq', kindOf('／加Q 10001'), 'qq');
check('/加QQ 10001 → qq', kindOf('/加QQ 10001'), 'qq');
check('号码取到 10001', numOf('/加Q 10001'), '10001');

// 🔴 这几条是"防误触发 + 防变体"的核心断言
check('加Q 10001（无斜杠）→ **不命中**', kindOf('加Q 10001'), null);
check('/加Q：10001（中文冒号）→ 不命中（只认空格）', kindOf('/加Q：10001'), null);
check('/加Q+10001（加号）→ 不命中（只认空格）', kindOf('/加Q+10001'), null);
check('/加Q12345（贴着的）→ 不命中', kindOf('/加Q12345'), null);
check('/加Q（没号码）→ 不命中', kindOf('/加Q'), null);
check('/加Q （只有空格）→ 不命中', kindOf('/加Q '), null);
check('加好友 10001 → 不命中（变体已收紧）', kindOf('加好友 10001'), null);
check('搜Q 10001 → 不命中（变体已收紧）', kindOf('搜Q 10001'), null);
check('强制搜索 10001 → 不命中（变体已收紧）', kindOf('强制搜索 10001'), null);
check('我要加QQ好友 → 不命中', kindOf('我要加QQ好友'), null);
check('今天加Q了没 → 不命中', kindOf('今天加Q了没'), null);
check('/加Q abc → 不命中（非数字）', kindOf('/加Q abc'), null);
check('/加Q 10001 谢谢 → 不命中（尾部有多余内容）', kindOf('/加Q 10001 谢谢'), null);

// ⛔ `/加群` 已整个删除（2026-10-10 用户要求）⇒ 这几条断言改成"**必须认不出**"
check('/加群 10001 → **不命中**（功能已删除）', kindOf('/加群 10001'), null);
check('加群 10001（无斜杠）→ 不命中', kindOf('加群 10001'), null);
check('/加群 10001 谢谢 → 不命中', kindOf('/加群 10001 谢谢'), null);
check('我要加群 → 不命中', kindOf('我要加群'), null);
check('普通聊天 → 不命中', kindOf('今天天气不错'), null);
check('空串 → 不命中', kindOf(''), null);

// ---------- 2. 号码解析 ----------
console.log('\n=== 2. 号码解析 ===');
check('全角数字 １０００１ → 10001', cmds.normalizeDigits('１０００１'), '10001');
check('尾标点 10001。 → 10001', cmds.normalizeDigits('10001。'), '10001');
check('5 位有效', cmds.isValidQQ('10001'), true);
check('11 位有效', cmds.isValidQQ('12345678901'), true);
check('4 位太短', cmds.isValidQQ('1000'), false);
check('12 位太长', cmds.isValidQQ('123456789012'), false);
check('前导零非法', cmds.isValidQQ('0123456'), false);
check('含字母非法', cmds.isValidQQ('1000a'), false);

// ---------- 3. 渲染 ----------
console.log('\n=== 3. 渲染 ===');
const menu = cmds.renderMenu();
const cmdMenu = menu;      // 下面卡片要跟菜单比"同构排版"
truthy('菜单含标题', menu.includes('/ 指令菜单'));
truthy('菜单含 /菜单', menu.includes('`/菜单`'));
truthy('菜单含 /加Q 12345', menu.includes('`/加Q 12345`'));
truthy('菜单**不含** /加群（功能已删除）', !menu.includes('/加群'));
falsy('菜单**不含**简介', /不用 @|下面这些/.test(menu));
falsy('菜单**不含**尾部说明', /冷却|长按复制|还在做/.test(menu));
falsy('菜单里没有未替换的模板变量', /\$\{|\{\{/.test(menu));
console.log('----- 菜单渲染结果 -----\n' + menu + '\n------------------------');

const card = cmds.renderCard('10001');
truthy('卡片含标题', card.includes('👤 QQ 联系人'));
truthy('卡片含号码', card.includes('`10001`'));
// 🔴 第二版（用户定调「做不了就改回第一个版本的方案」）：卡片**给链接**，不给二维码
truthy('卡片含 markdown 链接', /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(card));
truthy('链接指向机领网强制搜索页（能搜隐藏号的那个）',
  /\]\(https:\/\/tool\.gljlw\.com\/qq\/\?qq=10001\)/.test(card));
truthy('卡片用零宽空格换行（QQ markdown 方言）', card.includes('\u200B\n'));
// 🔴 安全断言：号码必须是纯数字拼进去，不能有任何拼接残留
truthy('链接里的号码是纯数字', /qq=10001\b/.test(card));
falsy('链接里没有多余字符（防拼接注入）', /qq=10001[^\s)\]]/.test(card));
falsy('卡片里不含 mqqapi 自定义协议（官方 40034028 拒收）', /mqqapi:/.test(card));
truthy('卡片里不再有二维码图片（用户明确否掉扫码路线）', !/!\[[^\]]*\]\([^)]*qr\.png/.test(card));
// 🔴 用户要求「排版紧密，跟菜单卡片一样」⇒ 与菜单同构：标题 + 内容紧跟，不插空行
falsy('卡片没有空行（与菜单卡片同构）', /\n\s*\n/.test(card));
truthy('菜单也没有空行（两边同构）', !/\n\s*\n/.test(cmdMenu));
console.log('----- QQ 卡片渲染结果 -----\n' + card + '\n------------------------');

const bad = cmds.renderBadNumber();
truthy('号码非法时给的是人话提示', bad.includes('/加Q'));
truthy('非法提示里**不含**任何链接', !/https?:\/\/|mqqapi:/.test(bad));

// ---------- 4. 冷却 ----------
console.log('\n=== 4. 冷却 ===');
cmds._cooldownReset();
const scope = 'group:TEST';
const r1 = cmds.build('/菜单', scope);
truthy('第 1 次命中 → 出文本', r1 && r1.text);
const r2 = cmds.build('/菜单', scope);
truthy('第 2 次（10 秒内）→ silent', r2 && r2.silent === true);
const r3 = cmds.build('/菜单', 'group:OTHER');
truthy('换一个会话 → 不受影响', r3 && r3.text);

// ---------- 5. build 全链路 ----------
console.log('\n=== 5. build 全链路 ===');
cmds._cooldownReset();
const good = cmds.build('/加Q 10001', 'group:A');
truthy('/加Q 10001 → 出卡片', good && good.text && good.num === '10001' && !good.bad);
const badNum = cmds.build('/加Q 123', 'group:B');
truthy('/加Q 123（太短）→ 出提示而非卡片', badNum && badNum.bad === true);
falsy('/加Q 123 的返回里没有链接', /https?:\/\/|mqqapi:/.test(badNum.text));
falsy('普通聊天 → null', cmds.build('你好呀', 'group:C'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
process.exit(fail ? 1 : 0);
