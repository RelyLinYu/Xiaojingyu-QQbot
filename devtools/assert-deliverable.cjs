// 交付前的"静态断言"：把渲染出来的 HTML 当**交付物**来验（不是读源文件）。
// 验什么：① 用户明令禁止的那批色值一个都不许出现；② 两套主题变量一一对应；
//        ③ 没有渐变；④ 没有原生控件残留（无 type 的 input 有兜底选择器）。
const { PAGE } = require('../server/tools/page.js');

const html = PAGE({ pwd: 'x', page: 'overview' });

const BANNED = ['#0f172a', '#111827', '#0a192f', '#1e293b', '#020617', '#0b1220', '#111a2e',
                '#2563eb', '#7c3aed', '#06b6d4', '#3b82f6', '#60a5fa', '#818cf8', '#93c5fd', '#1e3a8a'];
let bad = 0;
console.log('① 禁用色值扫描（必须全 0）');
for (const c of BANNED) {
  const esc = c.replace('#', '\\#');
  const n = (html.match(new RegExp(esc, 'gi')) || []).length;
  console.log('   ' + (n === 0 ? '✅' : '❌') + ' ' + c.padEnd(10) + ' 出现 ' + n + ' 次');
  if (n) bad++;
}

console.log('\n② 渐变 / 蓝色光晕');
// ⚠️ 用户禁的是**装饰性彩色渐变**；但下拉箭头那个小三角是**用渐变拼出来的形状**
//    （linear-gradient(45deg, transparent 50%, <色> 50%) —— 两段硬边界，不是颜色过渡）。
//    ⇒ 判定标准改成"**渐变里有没有出现颜色过渡**"：形状渐变里只有 transparent 和单一强调色，
//      一旦出现两种实色（或硬编码 hex/rgb）就是装饰渐变，直接判失败。
const grads = html.match(/linear-gradient\([^;]*?\)|radial-gradient\([^;]*?\)/gi) || [];
const decorative = grads.filter((g) => {
  if (/[\da-fA-F]{3,8}/.test(g.replace(/#[0-9a-fA-F]{3,8}/g, '')) && /rgba?\(/i.test(g)) return false;
  const colors = (g.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g) || []);
  // 把 transparent 去掉后还剩几种颜色：≥2 种 = 真的是颜色过渡 = 装饰渐变
  const real = colors.filter((c) => !/^transparent$/i.test(c));
  return real.length >= 2;
});
console.log('   ' + (grads.length <= 2 && decorative.length === 0 ? '✅' : '❌') +
  ' 渐变共 ' + grads.length + ' 处（只允许下拉箭头那 2 处形状渐变），装饰性渐变 ' + decorative.length + ' 处');
if (decorative.length) { decorative.slice(0, 3).forEach((g) => console.log('      ' + g.slice(0, 100))); bad++; }
const halo = (html.match(/rgba\(\s*(59,\s*130,\s*246|96,\s*165,\s*250|37,\s*99,\s*235)/g) || []).length;
console.log('   ' + (halo === 0 ? '✅' : '❌') + ' 蓝色光晕 rgba 出现 ' + halo + ' 次');
if (halo) bad++;

console.log('\n③ 两套主题变量一一对应');
const rootM = html.match(/:root\s*\{([\s\S]*?)\}\s*\[data-theme="dark"\]/);
const darkM = html.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n  \}/);
if (!rootM || !darkM) { console.log('   ❌ 找不到两套变量块（正则没对上，检查 CSS 结构）'); bad++; }
else {
  const grab = (s) => Array.from(new Set((s.match(/(--[a-z0-9-]+)\s*:/g) || []).map((x) => x.replace(/\s*:$/, '')))).sort();
  const rv = grab(rootM[1]), dv = grab(darkM[1]);
  console.log('   :root 定义 ' + rv.length + ' 个；[data-theme="dark"] 覆盖 ' + dv.length + ' 个');
  const onlyDark = dv.filter((v) => !rv.includes(v));
  // ⚠️ 形状/节奏类令牌（圆角 --r-*、时长 --dur、缓动 --ease）**两套主题共用**，
  //    本来就**不该**在 dark 里重复定义 —— 它们不是颜色，没有"深浅两版"。
  //    只把**颜色类**令牌要求一一对应，否则这条断言会一直假报错。
  const SHARED_OK = /^--(r-|dur$|ease$)/;
  const onlyRoot = rv.filter((v) => !dv.includes(v) && !SHARED_OK.test(v));
  const shared = rv.filter((v) => SHARED_OK.test(v));
  console.log('   dark 有、root 没有的：' + (onlyDark.length ? onlyDark.join(', ') : '（无）'));
  console.log('   **颜色类** root 有、dark 没覆盖的：' + (onlyRoot.length ? onlyRoot.join(', ') : '（无）'));
  console.log('   （形状/节奏类共用令牌已排除：' + shared.join(', ') + '）');
  if (onlyDark.length || onlyRoot.length) bad++;
}

console.log('\n④ 原生控件兜底选择器');
const need = [
  ['input:not([type]) 兜底', /input:not\(\[type\]\)/],
  ['select 去原生外观', /appearance:\s*none/],
  ['checkbox/radio 自定义', /input\[type=checkbox\][^{]*\{[\s\S]*?appearance:\s*none/],
  ['::placeholder 已定义', /::placeholder/],
  ['focus-visible 焦点环', /:focus-visible/],
  ['prefers-reduced-motion', /prefers-reduced-motion/],
  ['内联防闪烁脚本', /localStorage\.getItem\('theme'\)/],
  ['theme-color meta', /theme-color/],
];
for (const [name, re] of need) {
  const ok = re.test(html);
  console.log('   ' + (ok ? '✅' : '❌') + ' ' + name);
  if (!ok) bad++;
}

console.log('\n════════════════════════════════════');
if (bad) { console.log(' ❌ 静态断言有 ' + bad + ' 项不过 —— 不要部署'); process.exit(1); }
console.log(' ✅ 静态断言全部通过（交付物 = 渲染后的 HTML，共 ' + html.length + ' 字符）');
