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
