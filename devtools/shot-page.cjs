// ============================================================
//  devtools/shot-page.cjs —— 用无头 Edge 把打样页**截成图**（浅色 + 深色各一张）
//
//  为什么要截图：改的是"长相"，最后一道关必须是**眼睛看**，而不是再读一遍 CSS。
//  做法：在页面 <head> 最前面插一小段脚本，把 localStorage('theme') 设成 light/dark，
//        这样连"防闪烁内联脚本"都会按该主题走（等于**同时验了主题解析链路**）。
//  ⚠️ 本脚本只在本地跑（需要本机装了 Edge）；不参与部署。
//
//  跑法： node devtools/shot-page.cjs
//  产物： devtools/_preview/shot-<page>-<theme>.png
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, '_preview');
const OUT = path.join(SRC, 'shots');

if (!fs.existsSync(EDGE)) { console.log('⚠️ 本机没有 Edge，跳过截图'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const PAGES = process.argv.slice(2).length ? process.argv.slice(2) : ['overview', 'chat', 'settings'];
const THEMES = ['light', 'dark'];

function bakeTheme(html, theme) {
  // 必须插在 <head> 之后、**内联防闪烁脚本之前**（它是 <head> 里的第一段脚本）
  const inject = '<script>try{localStorage.setItem("theme","' + theme + '")}catch(e){}</script>';
  return html.replace('<style>', inject + '<style>');
}

let n = 0;
for (const page of PAGES) {
  const srcFile = path.join(SRC, 'preview-' + page + '.html');
  if (!fs.existsSync(srcFile)) { console.log('⚠️ 缺打样文件：' + srcFile); continue; }
  const raw = fs.readFileSync(srcFile, 'utf8');
  for (const theme of THEMES) {
    const tmp = path.join(OUT, '_t-' + page + '-' + theme + '.html');
    fs.writeFileSync(tmp, bakeTheme(raw, theme), 'utf8');
    const png = path.join(OUT, 'shot-' + page + '-' + theme + '.png');
    const url = 'file:///' + tmp.replace(/\\/g, '/');
    try {
      execFileSync(EDGE, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--no-first-run', '--no-default-browser-check',
        '--virtual-time-budget=4000',
        '--window-size=1280,2400',
        '--screenshot=' + png,
        url,
      ], { stdio: 'pipe', timeout: 90000 });
      const sz = fs.statSync(png).size;
      console.log('  ✅ shot-' + page + '-' + theme + '.png  (' + Math.round(sz / 1024) + ' KB)');
      n++;
    } catch (e) {
      console.log('  ❌ ' + page + '/' + theme + ' 截图失败：' + String(e.message).split('\n')[0]);
      const err = String(e.stderr || '').split('\n').filter(Boolean).slice(-4).join(' | ');
      if (err) console.log('     ' + err);
    }
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}
console.log('\n共 ' + n + ' 张图 → ' + OUT);
