/**
 * tools/make-menu.cjs —— 生成**图片版菜单**的 HTML（2026-10-16 用户要求）
 *
 * 用户原话：「参考图片做菜单图片版 …… 菜单卡片同步，最好是每个功能占一行，别挤到下一行」
 *
 * 设计（对着用户给的那张参考图做的，别自己发挥）：
 *   · 浅米色纸底 + 淡淡的横线；文字**居中**；每行样式就是卡片的 `#指令 --- 功能`
 *   · **一条功能一行**（和卡片完全同一份数据：`config.policy.commands.functions`）
 *   · 顶部一行 `指令：` 当标题（参考图就是这个词）
 *
 * ⚠️ 数据源必须和卡片**共用** `config.policy.commands.functions` —— 两边各写一份必然漂移
 *    （这个项目已经吃过好几次"两份判定/两份文案"的亏）。
 * ⚠️ 这是**离线快照**：改了 functions 就要重跑一次（`bash /root/make-menu.sh`）。
 *
 * 用法：node tools/make-menu.cjs --out <html路径> [--width 430]
 *      （默认把 HTML 写到 stdout；配上 chrome 截图见 /root/make-menu.sh）
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OUT = arg('--out', '');
const W = Math.max(240, Math.min(1200, Number(arg('--width', '430')) || 430));

const cfg = require(path.join(__dirname, '..', 'config'));
const cc = cfg.policy.commands || {};
const funcs = Array.isArray(cc.functions) ? cc.functions : [];
const sep = cc.separator || ' --- ';
const title = String(cc.menuImage && cc.menuImage.title ? cc.menuImage.title : '指令：');
const lines = funcs.map((f) => `${f.usage || ''}${sep}${f.name || ''}`.trim()).filter(Boolean);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ⚠️ 字号随宽度走，保证"每行不折行"：参考图那版是 1100px 宽、字号很大；
//    我们发到 QQ 里宽度 430 就够（手机上看清楚），字号取宽度的 1/15 左右。
const FS = Math.round(W / 15);
const PAD = Math.round(W / 16);
const LH = Math.round(FS * 1.9);

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  /* 纸底 + 淡横线（照参考图做的，别改成深色/渐变 —— 那个风格用户明确否过） */
  html, body { margin: 0; padding: 0; background: #f7f4ea; }
  body {
    width: ${W}px;
    box-sizing: border-box;
    padding: ${Math.round(LH * 1.1)}px ${PAD}px;
    background-image: repeating-linear-gradient(to bottom,
      transparent 0, transparent ${LH - 1}px, #e8e3d5 ${LH - 1}px, #e8e3d5 ${LH}px);
    font-family: "Noto Serif CJK SC", "Noto Sans CJK SC", "Source Han Serif SC", serif;
    font-weight: 700;
    color: #111;
    text-align: center;
  }
  .title { font-size: ${FS}px; line-height: ${LH}px; margin: 0 0 ${Math.round(LH * 0.4)}px; letter-spacing: 1px; }
  .row { font-size: ${FS}px; line-height: ${LH}px; white-space: nowrap; }
</style></head>
<body>
  <div class="title">${esc(title)}</div>
${lines.map((l) => `  <div class="row">${esc(l)}</div>`).join('\n')}
</body></html>`;

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');
  console.log(`菜单 HTML 已写出：${OUT}（${lines.length} 行功能 · 宽 ${W}px · 字号 ${FS}px）`);
} else {
  process.stdout.write(html);
}
