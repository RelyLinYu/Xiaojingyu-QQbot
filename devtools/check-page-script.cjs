// 给 syntax-check 加一道"页面脚本闸"：
// 把 page.js 里 PAGE 模板中的 <script> 抽出来、转成浏览器实际执行的样子，再验语法。
// 🔴 为什么需要：模板里的 \' 是被**运行时**解析的 ——
//    只看模板"语法没问题"，而渲染出来可能是 onclick="saveOne('')" 这种坏代码。
//    我为此让用户白折腾了好几轮（页面一行 JS 都不执行）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TICK = String.fromCharCode(96);
// 🆕 2026-10-06：页面模板已抽到 server/tools/page.js（唯一真源）
const file = path.join(__dirname, '..', 'server', 'tools', 'page.js');
const src = fs.readFileSync(file, 'utf8');
const startMark = 'const PAGE = (opts) => ' + TICK;
const st = src.indexOf(startMark);
if (st < 0) { console.log('⚠️ skipt：page.js 里没有 PAGE 模板'); process.exit(0); }
let i = st + startMark.length, en = -1;
while (i < src.length) { if (src[i] === TICK && src[i + 1] === ';') { en = i; break; } i++; }
if (en < 0) { console.log('❌ PAGE 模板没有正常收尾'); process.exit(1); }

const tpl = src.slice(st + startMark.length, en);
// 🔴 2026-10-08 修：页面上现在有**两个** <script> 了 ——
//    head 里那个「防闪烁内联脚本」（同步设 html[data-theme]）+ body 末尾的主脚本。
//    原来的正则 /<script>([\s\S]*)<\/script>/ 是**贪婪**的：它会从**第一个** <script> 开始、
//    一直吃到**最后一个** </script> ⇒ 把两段脚本连同一大坨 HTML/CSS 全当成一段 JS 去解析，
//    必然报 "Unexpected token '<'"（假警报，害我以为页面写坏了）。
//    ⇒ 改成**逐个 <script> 块分别验**（每一块都得能解析），这才是真正要保证的事。
const blocks = [];
{
  const re = /<script>([\s\S]*?)<\/script>/g;
  let mm;
  while ((mm = re.exec(tpl)) !== null) blocks.push(mm[1]);
}
if (!blocks.length) { console.log('❌ PAGE 里找不到 <script> 块'); process.exit(1); }
console.log('   找到 ' + blocks.length + ' 段页面脚本（防闪烁内联 + 主脚本）');

// 🔴🔴 2026-10-07 加（**这个坑已经咬过我三次**）：模板字符串**内部**（含注释、CSS、JS）
//    一旦再出现反引号，模板就会被提前截断 ⇒ 表现为"某行莫名其妙的语法错 / PAGE 返回非字符串"。
//    ⇒ 专门数一遍：PAGE 区段里**只该有 2 个反引号**（开头一个、结尾一个）；
//      有了这条，诊断会直接说"你多打了个反引号"，不用再去猜语法错。
{
  let n = 0;
  for (let k = 0; k < tpl.length; k++) if (tpl[k] === TICK) n++;
  if (n > 0) {
    console.log('❌ PAGE 模板**内部**出现了 ' + n + ' 个反引号（必须为 0）—— 它会把模板字符串提前截断！');
    tpl.split('\n').forEach((l, k) => {
      if (l.includes(TICK)) console.log('   L' + (k + 1) + ': ' + l.trim().slice(0, 110));
    });
    console.log('   ⇒ 把那几行的反引号去掉（注释里要举例就直接写字，别用反引号）');
    process.exit(1);
  }
}

// 服务端插值 → 字符串字面量（还原浏览器实际收到的内容）
let blocksBad = 0, blocksLines = 0;
for (let bi = 0; bi < blocks.length; bi++) {
  // 服务端插值 → 字符串字面量（还原浏览器实际收到的内容）
  const rendered = blocks[bi].replace(/\$\{JSON\.stringify\([^)]*\)\}/g, '"PW"');
  blocksLines += rendered.split('\n').length;
  try {
    new vm.Script(rendered);
    console.log('   ✅ 第 ' + (bi + 1) + ' 段能解析（' + rendered.split('\n').length + ' 行）');
  } catch (e) {
    blocksBad++;
    console.log('❌ 第 ' + (bi + 1) + ' 段页面脚本语法错误：' + e.message);
    const at = /<anonymous>:(\d+)/.exec(e.stack || '');
    if (at) {
      const lines = rendered.split('\n');
      const n = Number(at[1]);
      for (let x = Math.max(0, n - 3); x < Math.min(lines.length, n + 2); x++) {
        console.log(`   ${x + 1 === n ? '>>' : '  '} ${x + 1}: ${lines[x].slice(0, 140)}`);
      }
    }
  }
}
if (blocksBad) process.exit(1);
console.log('✅ 渲染后的 ' + blocks.length + ' 段页面脚本都能解析（共 ' + blocksLines + ' 行）');

// 🔴🔴 2026-10-06 补：**PAGE 必须真的返回一长串 HTML**。
//    踩过的大坑：模板字符串**内部**的注释里出现了反引号（我写了一个带反引号的行）
//    ⇒ 模板被**提前截断** ⇒ 后面变成普通 JS 表达式 ⇒ `PAGE()` 返回 **boolean false**
//    ⇒ `res.end(false)` ⇒ **HTTP 200 但 0 字节** ⇒ **整页白屏**（用户报「白屏了」）。
//    ⚠️ 上面那道"脚本能解析"**完全看不出**这种错（文件语法合法、脚本也能解析），
//      所以必须**真调一次函数、检查它返回的东西** —— 这就是"验交付边界"。
try {
  const mod = require(file);
  const html = mod.PAGE({ pwd: 'x', page: 'overview' });
  if (typeof html !== 'string' || html.length < 5000) {
    console.log('❌ PAGE 必须返回长字符串，实际是 ' + typeof html +
      '（长度 ' + (html && html.length) + '）');
    console.log('   多半是模板字符串被内部的反引号提前截断了');
    process.exit(1);
  }
  // 顺带验一下几个关键标记还在
  const need = ['<main>', 'id="tabs"', 'data-page="overview"', 'renderSettings'];
  const missing = need.filter((k) => !html.includes(k));
  if (missing.length) {
    console.log('❌ PAGE 返回的 HTML 缺关键标记：' + missing.join(', '));
    process.exit(1);
  }
  console.log('✅ PAGE 返回 HTML 长度 ' + html.length + ' 字符，关键标记齐全');
} catch (e) {
  console.log('❌ PAGE 执行失败：' + e.message);
  process.exit(1);
}
