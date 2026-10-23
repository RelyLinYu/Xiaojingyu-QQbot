// ============================================================
//  群内指令系统的回归测试（纯函数，本地跑，**不发网络请求**）
//
//  跑法：node devtools/test-commands.cjs
//
//  ── 2026-10-14 改版（**当前生效的那一套**）──
//   · 触发前缀从 `/` 改成 `#`（用户：「菜单/加Q 等等命令触发的前缀改为 #」）
//   · 原来的 `/菜单`、`/加Q` **从匹配里下线**（用户：「清空现有功能指令」）
//   · 现在只认 `#cd` 菜单；`#tg`（群友投稿）由 submit.js 自己接，这里只验"算我们的指令"
//
//  ⚠️ 2026-10-16 起 `match()` / `build()` 都是 **async**（指令里可能要去取图 / 发请求），
//     所以这个文件整体跑在一个 async 主流程里 —— 忘了 await 会拿到 Promise 而**假绿**。
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

(async () => {
// ---------- 1. 指令识别 ----------
console.log('\n=== 1. 指令识别（前缀已改成 #，旧的 /菜单 必须认不出）===');
const kindOf = async (s) => { const m = await cmds.match(s); return m ? m.kind : null; };

check('#cd → menu', await kindOf('#cd'), 'menu');
check('＃cd（全角井号，手机键盘同一个键）→ menu', await kindOf('＃cd'), 'menu');
check('#菜单 → menu', await kindOf('#菜单'), 'menu');
check('#cd 后面有标点 → menu', await kindOf('#cd。'), 'menu');
check('@它 + #cd → menu', await kindOf('<@ABCDEF> #cd'), 'menu');
check('#cd pic → 仍是 menu（图片版菜单已撤，它只是被忽略的多余参数）', await kindOf('#cd pic'), 'menu');

// 🔴 2026-10-14 用户定死：「清空现有功能指令」+ 前缀改 `#` ⇒ 这几条**必须认不出**
check('/菜单（旧前缀）→ **不命中**', await kindOf('/菜单'), null);
check('菜单（无前缀）→ 不命中', await kindOf('菜单'), null);
check('help → 不命中（旧版把它当菜单）', await kindOf('help'), null);
check('/加Q 10001（旧指令）→ 不命中', await kindOf('/加Q 10001'), null);
check('#加Q 10001 → 不命中（卡片代码还在，但没接线）', await kindOf('#加Q 10001'), null);
check('#st all → 不命中（生图指令族不在本仓库）', await kindOf('#st all'), null);
check('普通聊天 → 不命中', await kindOf('今天天气不错'), null);
check('空串 → 不命中', await kindOf(''), null);

// ---------- 2. 号码解析（`/加Q` 卡片那套代码还留着，纯函数照样要准）----------
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
const menuLines = menu.split('\n');
truthy('菜单含标题「功能菜单」', menu.includes('# 功能菜单'));
check('菜单**恰好 3 行**（标题 + 两条功能）', menuLines.length, 3);
truthy('菜单含 `#cd` --- 功能菜单', menu.includes('`#cd` --- 功能菜单'));
truthy('菜单含 `#tg` --- 投稿图库(引用图片)', menu.includes('`#tg` --- 投稿图库(引用图片)'));
const jsTag = '#' + 'js';
falsy('菜单里没有已删除的视频解析指令（2026-10-23）', menu.includes(jsTag));
falsy('菜单里**没有** `#st` 那两行（用户 2026-10-16：「#st all 和 #st 序号 QQ 这两行删掉」）',
  /#st/.test(menu));
falsy('菜单**不含**旧前缀 /菜单', menu.includes('`/菜单`'));
falsy('菜单里没有未替换的模板变量', /\$\{|\{\{/.test(menu));
falsy('菜单没有空行（QQ 的 markdown 会把空行渲染成一段高度）', /\n\s*\n/.test(menu));
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
falsy('卡片没有空行（与菜单卡片同构）', /\n\s*\n/.test(card));
console.log('----- QQ 卡片渲染结果 -----\n' + card + '\n------------------------');

const bad = cmds.renderBadNumber();
truthy('号码非法时给的是人话提示', bad.includes('#加Q'));
truthy('非法提示里**不含**任何链接', !/https?:\/\/|mqqapi:/.test(bad));

// ---------- 4. 冷却 ----------
console.log('\n=== 4. 冷却 ===');
cmds._cooldownReset();
const scope = 'group:TEST';
const r1 = await cmds.build('#cd', scope);
truthy('第 1 次命中 → 出文本', r1 && r1.text);
const r2 = await cmds.build('#cd', scope);
truthy('第 2 次（10 秒内）→ silent', r2 && r2.silent === true);
const r3 = await cmds.build('#cd', 'group:OTHER');
truthy('换一个会话 → 不受影响', r3 && r3.text);

// ---------- 5. 别人的指令别去接话 ----------
console.log('\n=== 5. 别人的指令（ignoreForeign）===');
truthy('/菜单 看着像别人的指令 → 不回', cmds.looksForeign('/菜单'));
truthy('别的 bot 的 #help → 不回', cmds.looksForeign('#help'));
check('中文话题标签 #今日份的快乐 → 照常交给模型', cmds.looksForeign('#今日份的快乐'), '');
check('我们自己的 #cd → 放过', cmds.looksForeign('#cd'), '');
check('我们自己的 #tg（submit.js 接的）→ 放过', cmds.looksForeign('#tg'), '');
check('普通聊天 → 不管', cmds.looksForeign('今天天气不错'), '');

// ---------- 6. 关机策略闸（纯函数）----------
console.log('\n=== 6. 关机时哪些指令还放行 ===');
check("'all' → 一律放行（旧行为）", cmds.allowedWhenOff('menu', 'all'), true);
check("'all' 对别的 kind 也放行", cmds.allowedWhenOff('sticker', 'all'), true);
check("'none' → 一条都不放（现在默认）", cmds.allowedWhenOff('menu', 'none'), false);
check("'menu' → 只放菜单", cmds.allowedWhenOff('menu', 'menu'), true);
check("'menu' → 别的指令拦", cmds.allowedWhenOff('sticker', 'menu'), false);
check('模式写错（认不出）⇒ 按 none 处理（宁可少放行）', cmds.allowedWhenOff('menu', 'bogus'), false);

// ---------- 7. build 全链路 ----------
console.log('\n=== 7. build 全链路 ===');
cmds._cooldownReset();
const cd = await cmds.build('#cd', 'group:A');
truthy('#cd → 出菜单文本', cd && cd.kind === 'menu' && /功能菜单/.test(cd.text));
falsy('普通聊天 → null', await cmds.build('你好呀', 'group:C'));
// ⚠️ 旧指令走的是 **silent**（被 looksForeign 当成"别人的指令"静默），不是 null —— 两者都算"不回"，
//    但断言要分清，否则以后有人把 silent 改成 null 会假绿（2026-10-16 写这条时踩到）
const oldMenu = await cmds.build('/菜单', 'group:D');
truthy('旧指令 /菜单 → silent（不回，已下线）', oldMenu && oldMenu.silent === true && !oldMenu.text);
const oldQ = await cmds.build('/加Q 10001', 'group:E');
truthy('旧指令 /加Q 10001 → silent（卡片已下线，别偷偷复活）', oldQ && oldQ.silent === true && !oldQ.text);

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
process.exit(fail ? 1 : 0);
})();
