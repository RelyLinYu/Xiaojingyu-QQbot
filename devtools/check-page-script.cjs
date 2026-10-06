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
const m = /<script>([\s\S]*)<\/script>/.exec(tpl);
if (!m) { console.log('❌ PAGE 里找不到 <script> 块'); process.exit(1); }

// 服务端插值 → 字符串字面量（还原浏览器实际收到的内容）
const rendered = m[1].replace(/\$\{JSON\.stringify\([^)]*\)\}/g, '"PW"');
try {
  new vm.Script(rendered);
  console.log('✅ 渲染后的页面脚本能解析（' + (rendered.split('\n').length) + ' 行）');
} catch (e) {
  console.log('❌ 渲染后的页面脚本语法错误：' + e.message);
  const mm = /<anonymous>:(\d+)/.exec(e.stack || '');
  if (mm) {
    const lines = rendered.split('\n');
    const n = Number(mm[1]);
    for (let x = Math.max(0, n - 3); x < Math.min(lines.length, n + 2); x++) {
      console.log(`   ${x + 1 === n ? '>>' : '  '} ${x + 1}: ${lines[x].slice(0, 140)}`);
    }
  }
  process.exit(1);
}

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
