// ============================================================
//  部署前的语法体检：对每个 .js 跑 `node --check`
//
//  为什么需要它（2026-10-05 真实事故）：
//    我改了 `tools/logweb.js` 里的一段**模板字符串**（那一整个页面就是一个反引号字符串），
//    在里面的注释里写了 `` `b.calls` `` —— **反引号把字符串提前截断了** →
//    整文件 SyntaxError → 服务 `exit-code 1`，systemd 每 5 秒重启一次。
//    ⚠️ 而我的自测**全绿**：它只断言"文件里包含某段正则"，**根本没解析文件**。
//    ⇒ 教训：**"字符串里有没有那段文字" ≠ "文件能不能跑"**。
//      **改完 .js 必须先 node --check 再 scp**，这一步对 server/ 和 tools/ 都要做。
//
//  跑法： node devtools/syntax-check.cjs
//  退出码：0 = 全部能解析；1 = 有文件语法错（**用它当闸门**）
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// ⚠️ 只列顶层目录，靠 walk 递归 —— 别同时写 'server' 和 'server/tools'（会重复列出）
const DIRS = ['server', 'devtools'];
const EXTS = ['.js', '.cjs'];

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const name of fs.readdirSync(abs)) {
    const full = path.join(abs, name);
    // 🔴 2026-10-08：跳过本地打样产物。
    //    原因：devtools/shot-page.cjs / theme-audit.cjs 会拉一个**无头 Edge**，
    //    它会在 devtools/_preview/_edge-profile/ 里塞进几百个**浏览器自带**的 .js。
    //    那些不是我们的代码，却会被逐个 node --check（文件数从 52 涨到 78），
    //    既慢，又随时可能因为浏览器自己的文件解析不过而**假报"语法错、不要部署"**（闸门失去可信度）。
    if (name === '_preview') continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) { walk(path.join(dir, name), out); continue; }
    if (!EXTS.includes(path.extname(name))) continue;
    // 跳过自己（正在跑的脚本）
    if (path.resolve(full) === path.resolve(__filename)) continue;
    out.push(path.join(dir, name));
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(d));
let bad = 0;

console.log('════════════════════════════════════════════════════════');
console.log(` 语法体检 · 逐个 node --check（${files.length} 个文件）`);
console.log('════════════════════════════════════════════════════════');

for (const rel of files.sort()) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
    console.log(`  ✅ ${rel}`);
  } catch (e) {
    bad++;
    const msg = String(e.stderr || e.message || '').split('\n').slice(0, 6).join('\n      ');
    console.log(`  ❌ ${rel}\n      ${msg}`);
  }
}

console.log('════════════════════════════════════════════════════════');
// ============================================================
// 🆕 2026-10-31 「模板内不许出现反引号」专项（已经被咬过三次）
//   为什么 node --check 抓不到：page.js 是 const PAGE = (opts) => 反引号…反引号 的模板字符串，
//   注释里多写一个反引号会**提前截断模板** —— 文件照样能解析（语法没错），但 require 出来的
//   PAGE 已经不是函数 / 渲染内容错乱，线上表现是白屏或区块错位这种最难查的形态。
//   ⇒ 必须**数**：PAGE 模板开头到结尾之间，反引号个数必须为 0。
// ============================================================
(function checkTemplateBackticks() {
  const target = path.join(ROOT, 'server', 'tools', 'page.js');
  if (!fs.existsSync(target)) return;
  const s = fs.readFileSync(target, 'utf8');
  const start = s.indexOf('=> `');
  const end = s.lastIndexOf('`;');
  if (start < 0 || end < 0 || end <= start) {
    console.log('  ⚠️ 没找到 PAGE 模板边界（模板结构变了？这条检查要同步改）');
    return;
  }
  const body = s.slice(start + 4, end);
  const marks = body.match(/`/g) || [];
  if (marks.length) {
    const at = start + 4 + body.indexOf('`');
    const line = s.slice(0, at).split('\n').length;
    console.log('  ❌ server/tools/page.js 模板内部出现 ' + marks.length + ' 个反引号（第 ' + line + ' 行附近）—— 会把模板截断');
    console.log('     改法：注释里别用反引号，换成「」或直接写名字');
    process.exit(1);
  }
  console.log('  ✅ page.js 模板内部没有裸反引号');
})();

console.log('════════════════════════════════════════════════════════');
if (bad) {
  console.log(` ❌ 有 ${bad} 个文件语法错误 —— **不要部署**，先修好`);
  process.exit(1);
}
console.log(` ✅ 全部 ${files.length} 个文件都能被 Node 解析（可以部署）`);
process.exit(0);
