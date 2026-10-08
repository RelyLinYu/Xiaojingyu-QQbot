// ============================================================
//  page.js —— 日志面板的页面模板（2026-10-06 单独抽出来）
//
//  🔴 为什么要单独一个文件：原来是**两份拷贝** —— logweb.js 里那份（线上跑的）
//     和 `_tmp/newpage2.html.js`（模板源文件），中间还有个 `replace-page2.cjs` 生成器。
//     结果我在一份里改了、另一份把改动**覆盖回去**，同一天被咬了三次
//     （按钮变纯文本、累计已花又读回旧字段…）。⇒ **只留一份**：
//        · logweb.js 只 `require` 本文件；
//        · 改页面**直接改这里**；
//        · 改完必须跑 `node devtools/check-page-script.cjs`（验渲染后脚本）
//          和 `node devtools/check-page-html.cjs`（验渲染后 HTML 标签完整）。
//
//  ⚠️ 本文件是**模板字符串**：里面**不能出现裸反引号**（会提前截断字符串）。
//
//  ============================================================
//  2026-10-08 UI 重做（用户要求：以 Apple 官方站的克制整洁风**重做**这个后台页面）
//
//  旧版问题：整站**写死深色**（--bg:#0b1220 深蓝底 + 蓝紫渐变标题 + 霓虹光晕），
//  正是用户明令禁止的"AI 默认科技深蓝风"。这一版做了四件事：
//    ① **双主题**：浅色（Apple 白 #FFFFFF / 次级 #F5F5F7）/ 深色（#000000 / #1C1C1E 系灰黑，
//       **不是深蓝**）。颜色全部收敛成**语义化令牌**，两套主题**一一对应、定义齐全**；
//    ② **三段式主题开关**（跟随系统 / 浅色 / 深色），选择写 localStorage('theme')，
//       head 里放**内联同步脚本**在首屏渲染前设好 html[data-theme]，**刷新不闪白/闪黑**；
//       系统主题变化时：未手动选择过才跟随；
//    ③ **去掉一切"AI 科技感"**：无渐变、无蓝紫光晕、无彩色边框卡片，
//       深色下靠"亮度差 + 描边"分层（深色阴影只用黑色，不发光）；
//    ④ 控件全部自定义外观（输入框/下拉/复选/按钮/分段控件），**没有浏览器原生外观**。
//
//  ⚠️ 结构、id、class、事件挂钩（data-save / data-ps / data-f …）**一律不动** ——
//     这一版只换"皮肤与骨架排布"，不改任何取数逻辑（改逻辑的风险远大于换皮）。
//  📦 改前的旧文件备份在仓库 backup-ui/page.js.<时间戳>.bak，验收通过后再删。
//  ============================================================
const PAGE = (opts) => `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>QQbot控制台</title>
<!-- BUILD:__BUILD__ -->
<!--
  🔴🔴 防闪烁（FOUC）内联同步脚本 —— 必须**内联、同步、且在任何样式表之前**执行。
  它做两件事：① 在首屏渲染前把 html[data-theme] 设成解析后的主题（light / dark）；
              ② 同步更新 <meta name="theme-color">（手机地址栏颜色）。
  ⚠️ 解析规则（和页面里的三段开关共用同一套 key：localStorage 'theme'）：
      · theme = 'light' / 'dark'  ⇒ 用户手动选定，**永远听它**（哪怕系统主题变了）；
      · theme 缺失 / 'system' / 读不出来 ⇒ 跟随 prefers-color-scheme；
      · 『未手动选择过』的唯一判据就是 **localStorage 里没有 light/dark 这两个值** ——
        不另起一个 storage key（两个 key 就有"写了一个漏了另一个"的失配风险）。
  ⚠️ 整段包在 try/catch 里：localStorage 在无痕模式/被禁 Cookie 时会抛错，
     绝不能因为存不了偏好就白屏。
-->
<script>
(function () {
  var m = 'system';
  try { m = localStorage.getItem('theme') || 'system'; } catch (e) { m = 'system'; }
  if (m !== 'light' && m !== 'dark') m = 'system';
  var sysDark = false;
  try { sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) {}
  var t = (m === 'system') ? (sysDark ? 'dark' : 'light') : m;
  var d = document.documentElement;
  try { d.setAttribute('data-theme', t); } catch (e) {}
  try {
    var meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', t === 'dark' ? '#1C1C1E' : '#F5F5F7');
    document.head.appendChild(meta);
  } catch (e) {}
})();
</script>
<style>
  /* ============================================================
     ① 设计令牌（语义化）—— 页面里**只允许引用变量**，不许出现散装色值。
        规则：:root 是浅色；[data-theme="dark"] 覆盖**同名**变量。
        ⚠️ 两套必须**逐条一一对应**（缺一个 = 深色下那个地方会沿用浅色值）。
     ② 唯一允许写死字面量的地方是下面「状态/强调色」那几行 ——
        它们是主题无关的 Apple 系统色（红/绿/黄），深色下也只调亮度，不做第二套色相。
     ============================================================ */
  :root {
    /* —— 底与面 —— */
    --bg:            #FFFFFF;
    --bg-subtle:     #F5F5F7;
    --bg-elevated:   #FFFFFF;
    --bg-hover:      rgba(0,0,0,.035);
    --bg-sunken:     #F5F5F7;      /* 代码块 / 引用块的内凹底 */
    --bg-overlay:    rgba(255,255,255,.82);
    --bg-inverse:    #1D1D1F;      /* 反向底（当前用于开关滑块等） */
    /* —— 描边 —— */
    --border:        #D2D2D7;
    --border-strong: #86868B;
    /* —— 文字（靠字重与字号分层，不靠颜色）—— */
    --text:          #1D1D1F;
    --text-secondary:#6E6E73;
    --text-tertiary: #86868B;
    --text-inverse:  #FFFFFF;
    /* —— 强调（全站**只许一个**强调色）—— */
    --accent:        #0071E3;
    --accent-hover:  #0077ED;
    --accent-ring:   rgba(0,113,227,.15);
    /* —— 状态（Apple 系统色：主题无关，深色下亮一档）—— */
    --danger:        #FF3B30;
    --danger-bg:     rgba(255,59,48,.10);
    --danger-ring:   rgba(255,59,48,.18);
    --success:       #34C759;
    --success-bg:    rgba(52,199,89,.12);
    --warning:       #FF9500;
    --warning-bg:    rgba(255,149,0,.12);
    /* —— 阴影：浅色用淡黑，深色改用更黑的层叠（**不许蓝色光晕**）—— */
    --shadow-card:   0 1px 3px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
    --shadow-pop:    0 12px 32px rgba(0,0,0,.12);
    --shadow-sticky: 0 1px 0 var(--border);
    /* —— 控件内部（输入框/代码块/图表的专属底色，两套主题各一份）—— */
    --control-bg:    #FFFFFF;
    --control-inner: inset 0 1px 0 rgba(255,255,255,.7);
    --code-bg:       #F5F5F7;
    --code-text:     #3A3A3C;
    --chart-bar:     #0071E3;
    --chart-bar-hot: #FF9500;
    --chart-bar-over:#FF3B30;
    --bar-warn-bg:   #FFF4E5;
    --bar-warn-text: #8A5300;
    --bar-err-bg:    #FFEBE9;
    --bar-err-text:  #8E1D16;
    --bubble-user:   #F5F5F7;      /* 群友说的话 */
    --bubble-bot:    #EAF3FF;      /* 鱼回的（很淡） */
    --divider:       rgba(0,0,0,.06);
    --skeleton:      rgba(0,0,0,.07);
    --scroll-thumb:  rgba(0,0,0,.22);
    /* —— 形状与节奏（两套主题共用）—— */
    --r-in:  10px;      /* 输入框 / 按钮 */
    --r-card:18px;      /* 卡片 */
    --r-box: 22px;      /* 大容器 / 弹层 */
    --r-pill:999px;
    --dur:  .2s;
    --ease: cubic-bezier(.2,.7,.2,1);
  }
  [data-theme="dark"] {
    --bg:            #000000;
    --bg-subtle:     #1C1C1E;
    --bg-elevated:   #2C2C2E;
    --bg-hover:      rgba(255,255,255,.06);
    --bg-sunken:     #1C1C1E;
    --bg-overlay:    rgba(28,28,30,.78);
    --bg-inverse:    #F5F5F7;
    --border:        #38383A;
    --border-strong: #545458;
    --text:          #F5F5F7;
    --text-secondary:#A1A1A6;
    --text-tertiary: #8E8E93;
    --text-inverse:  #1D1D1F;
    --accent:        #0A84FF;
    --accent-hover:  #409CFF;
    --accent-ring:   rgba(10,132,255,.35);
    --danger:        #FF453A;
    --danger-bg:     rgba(255,69,58,.16);
    --danger-ring:   rgba(255,69,58,.30);
    --success:       #30D158;
    --success-bg:    rgba(48,209,88,.16);
    --warning:       #FF9F0A;
    --warning-bg:    rgba(255,159,10,.16);
    --shadow-card:   0 1px 3px rgba(0,0,0,.5), 0 8px 24px rgba(0,0,0,.6);
    --shadow-pop:    0 12px 32px rgba(0,0,0,.7);
    --shadow-sticky: 0 1px 0 var(--border);
    --control-bg:    #2C2C2E;
    --control-inner: inset 0 1px 0 rgba(255,255,255,.05);
    --code-bg:       #1C1C1E;
    --code-text:     #C7C7CC;
    --chart-bar:     #0A84FF;
    --chart-bar-hot: #FF9F0A;
    --chart-bar-over:#FF453A;
    --bar-warn-bg:   #3A2A12;
    --bar-warn-text: #FFD9A0;
    --bar-err-bg:    #3A1512;
    --bar-err-text:  #FFB4AE;
    --bubble-user:   #2C2C2E;
    --bubble-bot:    #12283F;
    --divider:       rgba(255,255,255,.10);
    --skeleton:      rgba(255,255,255,.10);
    --scroll-thumb:  rgba(255,255,255,.20);
  }

  /* ============================================================
     ③ 基础排版：字体栈 / 4 的倍数间距 / 语义化层级
     ============================================================ */
  *, *::before, *::after { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif;
    font-size:17px; line-height:1.6; -webkit-font-smoothing:antialiased;
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  }
  h1 { font-size:17px; font-weight:600; letter-spacing:-.01em; margin:0; }
  h2 { font-size:15px; font-weight:600; letter-spacing:-.01em; color:var(--text);
       margin:0 0 12px; display:flex; align-items:center; gap:8px; }
  /* 标题前的短竖条：只作"分组提示"，不是发光装饰 —— 用描边色，不用彩色渐变 */
  h2::before { content:''; width:3px; height:15px; border-radius:2px;
       background:var(--accent); opacity:.85; flex:0 0 auto; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  pre, code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  /* ♿ 键盘焦点：统一用 accent 环，两套主题下都清晰可见 */
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:6px; }

  /* ============================================================
     ④ 顶栏 + 分段导航（原来标签栏压在页面底部且和 footer 抢边 —— 改成顶部吸顶，
        桌面端更像 macOS 应用；移动端仍然一整条可点，触控目标 ≥44px）
     ============================================================ */
  header.appbar {
    position:sticky; top:0; z-index:30;
    background:var(--bg-overlay);
    -webkit-backdrop-filter:saturate(180%) blur(20px);
    backdrop-filter:saturate(180%) blur(20px);
    border-bottom:1px solid var(--border);
    box-shadow:var(--shadow-sticky);
  }
  .bar { max-width:1120px; margin:0 auto; padding:12px 24px;
         display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .brand { display:flex; align-items:center; gap:8px; font-weight:600; letter-spacing:-.01em; }
  .brand .logo { font-size:18px; line-height:1; }
  .pills { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .spacer { flex:1 1 auto; }
  .ctrls { display:flex; align-items:center; gap:8px; }
  tabbar { display:block; }
  .tabbar { max-width:1120px; margin:0 auto; padding:0 24px 10px; display:flex; gap:4px; flex-wrap:wrap; }
  .tabbar a {
    display:inline-flex; align-items:center; gap:6px;
    min-height:32px; padding:6px 14px; border-radius:var(--r-pill);
    font-size:14px; font-weight:500; color:var(--text-secondary);
    border:1px solid transparent; text-decoration:none;
    transition:background var(--dur) var(--ease), color var(--dur) var(--ease), border-color var(--dur) var(--ease);
  }
  .tabbar a:hover { background:var(--bg-hover); color:var(--text); text-decoration:none; }
  .tabbar a.on { background:var(--bg-elevated); color:var(--text);
                 border-color:var(--border); box-shadow:var(--shadow-card); font-weight:600; }

  main { max-width:1120px; margin:0 auto; padding:32px 24px 96px; }
  main > section { margin-bottom:64px; }
  main > details { margin-bottom:24px; }

  /* ============================================================
     ⑤ 卡片 / 分组
     ============================================================ */
  .card {
    background:var(--bg-elevated); border:1px solid var(--border);
    border-radius:var(--r-card); padding:16px 18px;
    box-shadow:var(--shadow-card);
    transition:box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease);
  }
  .card:hover { box-shadow:var(--shadow-pop); }
  .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
  @media (min-width:620px) { .grid { grid-template-columns:repeat(4,minmax(0,1fr)); } }
  /* 统计卡片：大数字用字重+字号分层；**只允许"统计卡片本身"的大字**，
     绝不能写成通配的 .card b —— 那会把说明小字里的强调词也撑成大块（2026-10-08 已栽过一次） */
  .grid > .card > b { display:block; font-size:28px; font-weight:600; letter-spacing:-.02em;
                      line-height:1.15; color:var(--text); font-variant-numeric:tabular-nums; }
  .grid > .card > span { display:block; margin-top:6px; font-size:13px; color:var(--text-secondary); }
  /* 说明文字：**一个字号、一个行高**，强调靠"加粗 + 亮色"，绝不放大字号、绝不上下分层 */
  .hint { color:var(--text-secondary); font-size:13px; line-height:1.75; margin:8px 0 0; }
  .hint b, .hint strong { font-size:inherit; font-weight:600; color:var(--text); display:inline; }
  .hint u { text-decoration-color:var(--border-strong); text-underline-offset:2px; }
  .pill { display:inline-flex; align-items:center; gap:4px;
          font-size:12px; font-weight:500; padding:3px 10px; border-radius:var(--r-pill);
          background:var(--bg-subtle); color:var(--text-secondary); border:1px solid var(--border); }
  /* ⚠️ 状态胶囊：色值必须写全。只给 color/border-color 的话，background 会继续用上面那条
     的 var(--bg-subtle)（深色下是 #1C1C1E，和卡片底色一样）⇒ 胶囊看着"没上色"。
     打样截图里那个"运行中"就是这么变灰的（对比度只有 ~2:1，肉眼要仔细看才发现）。*/
  .pill.on  { background:var(--success-bg); color:var(--success); border-color:var(--success); }
  .pill.off { background:var(--danger-bg);  color:var(--danger);  border-color:var(--danger); }
  .warn { color:var(--danger); }
  /* 开关机那张卡里的状态字（原来是行内 style 写死的 #fff / --dim ⇒ 收进类里，主题自适应）*/
  .pwstate { font-size:15px; font-weight:600; color:var(--text); }
  .pwhint  { color:var(--text-secondary); font-size:13px; }

  /* 状态条（离线 / 脚本错误）：原来是红+橙双渐变，现在是**实色**状态条，两主题各自成对 */
  #errbar { display:none; background:var(--bar-err-bg); color:var(--bar-err-text);
            padding:12px 24px; font-size:14px; word-break:break-all; }
  #offbar { display:none; background:var(--bar-warn-bg); color:var(--bar-warn-text);
            padding:12px 24px; font-size:14px; font-weight:500; }

  /* ============================================================
     ⑥ 折叠块（details）：默认收起；展开时图标旋转 + 内容淡入
        右侧那个小圆点 = "可点击"的视觉暗示，不是装饰
     ============================================================ */
  details {
    background:var(--bg-elevated); border:1px solid var(--border);
    border-radius:var(--r-card); padding:14px 18px; box-shadow:var(--shadow-card);
  }
  summary { cursor:pointer; font-weight:600; color:var(--text); font-size:15px;
            display:flex; align-items:center; gap:8px; list-style:none; min-height:24px; }
  summary::-webkit-details-marker, .gcard > summary::-webkit-details-marker { display:none; }
  details > summary::before { content:''; flex:0 0 auto; width:0; height:0;
    border-left:6px solid var(--text-tertiary); border-top:5px solid transparent;
    border-bottom:5px solid transparent; transition:transform .22s var(--ease); }
  details[open] > summary::before { transform:rotate(90deg); }
  details > summary:hover { color:var(--accent); }
  details[open] > *:not(summary), .gcard[open] > *:not(summary) {
    animation:reveal .26s var(--ease) both; }
  @keyframes reveal { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:none; } }

  /* ============================================================
     ⑦ 表单控件 —— 全部自定义外观（原生外观一律覆盖掉）
        · 输入框/文本域：白/深灰底 + 1px 描边 + 10px 圆角 + 16px 字号（移动端防缩放）
        · :focus 用 4px accent 环（不是 outline:1px，那样太"网页原生"）
        · 下拉：**必须显式给 option 上色**，否则弹层会是系统浅色 + 我们的浅色字 = 看不见
     ============================================================ */
  label { display:block; font-size:13px; font-weight:500; color:var(--text); margin-bottom:6px; }
  input[type=text], input[type=number], input[type=password], input[type=search], input:not([type]), textarea, select {
    font:inherit; font-size:16px; color:var(--text); width:auto;
    background:var(--control-bg); border:1px solid var(--border); border-radius:var(--r-in);
    padding:12px 14px; min-width:0; box-shadow:var(--control-inner);
    transition:border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), background var(--dur) var(--ease);
  }
  input[type=text]:hover, input[type=number]:hover, input[type=password]:hover,
  input[type=search]:hover, input:not([type]):hover, textarea:hover, select:hover { border-color:var(--border-strong); }
  input[type=text]:focus, input[type=number]:focus, input[type=password]:focus,
  input[type=search]:focus, input:not([type]):focus, textarea:focus, select:focus {
    outline:none; border-color:var(--accent); box-shadow:0 0 0 4px var(--accent-ring); }
  ::placeholder { color:var(--text-tertiary); opacity:1; }
  input:disabled, textarea:disabled, select:disabled {
    background:var(--bg-subtle); color:var(--text-tertiary); cursor:not-allowed; }
  /* 错误态（给未来用：只要挂 .is-invalid）*/
  .is-invalid { border-color:var(--danger) !important; box-shadow:0 0 0 4px var(--danger-ring) !important; }
  textarea { padding:14px; line-height:1.75; resize:vertical; min-height:360px; width:100%; }
  textarea::-webkit-resizer { background:transparent; }   /* 去掉那个廉价的小三角拉伸柄 */
  /* 下拉箭头：自己画，不吞浏览器原生那个 */
  select { appearance:none; -webkit-appearance:none; padding-right:38px;
    background-image:linear-gradient(45deg,transparent 50%,var(--text-tertiary) 50%),
                     linear-gradient(135deg,var(--text-tertiary) 50%,transparent 50%);
    background-position:calc(100% - 19px) 50%, calc(100% - 14px) 50%;
    background-size:5px 5px, 5px 5px; background-repeat:no-repeat; }
  select option, select optgroup { background-color:var(--bg-elevated); color:var(--text); }
  select option:checked { background-color:var(--accent); color:var(--text-inverse); }
  /* 复选框 / 单选：自定义外观（原生方框在深色下是刺眼的系统色） */
  input[type=checkbox], input[type=radio] {
    appearance:none; -webkit-appearance:none; width:20px; height:20px; flex:0 0 auto;
    border:1.5px solid var(--border-strong); background:var(--control-bg);
    border-radius:6px; cursor:pointer; position:relative; margin:0;
    transition:background var(--dur) var(--ease), border-color var(--dur) var(--ease); }
  input[type=radio] { border-radius:50%; }
  input[type=checkbox]:checked, input[type=radio]:checked { background:var(--accent); border-color:var(--accent); }
  input[type=checkbox]:checked::after { content:''; position:absolute; left:6px; top:2px;
    width:5px; height:10px; border:2px solid var(--text-inverse); border-top:0; border-left:0;
    transform:rotate(45deg); }
  input[type=radio]:checked::after { content:''; position:absolute; left:5px; top:5px;
    width:8px; height:8px; border-radius:50%; background:var(--text-inverse); }
  input[type=checkbox]:focus-visible, input[type=radio]:focus-visible {
    outline:none; box-shadow:0 0 0 4px var(--accent-ring); }

  /* 按钮：主=accent 胶囊；次=底+1px 描边；危险=红描边幽灵。统一有 hover/active/focus/disabled */
  button {
    font:inherit; font-size:14px; font-weight:500; color:var(--text);
    background:var(--bg-elevated); border:1px solid var(--border);
    border-radius:var(--r-pill); padding:9px 18px; min-height:36px; cursor:pointer;
    display:inline-flex; align-items:center; justify-content:center; gap:6px;
    transition:background var(--dur) var(--ease), border-color var(--dur) var(--ease),
               color var(--dur) var(--ease), transform .12s var(--ease), box-shadow var(--dur) var(--ease);
  }
  button:hover { border-color:var(--border-strong); background:var(--bg-hover); }
  button:active { transform:scale(.98); }
  button:focus-visible { outline:none; box-shadow:0 0 0 4px var(--accent-ring); border-color:var(--accent); }
  button:disabled { opacity:.45; cursor:not-allowed; transform:none; }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--text-inverse); }
  button.primary:hover { background:var(--accent-hover); border-color:var(--accent-hover); }
  button.danger { background:transparent; border-color:var(--danger); color:var(--danger); }
  button.danger:hover { background:var(--danger-bg); border-color:var(--danger); }
  button.sm { padding:6px 13px; min-height:30px; font-size:13px; }
  /* 触控目标 ≥44px：手机上把按钮撑起来 */
  @media (pointer:coarse) { button { min-height:44px; } button.sm { min-height:40px; } }

  /* 分段控件（Apple segmented control）—— 主题开关用；选中项抬到底色之上 */
  .seg { display:inline-flex; padding:2px; gap:2px; border-radius:10px;
         background:var(--bg-subtle); border:1px solid var(--border); }
  .seg button {
    border:0; background:transparent; color:var(--text-secondary);
    border-radius:8px; padding:5px 10px; min-height:28px; font-size:13px; font-weight:500;
    transition:background var(--dur) var(--ease), color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  }
  .seg button:hover { background:transparent; color:var(--text); }
  .seg button.on { background:var(--bg-elevated); color:var(--text); font-weight:600;
                   box-shadow:var(--shadow-card); }
  .seg button.on:hover { color:var(--text); }
  .seg button:focus-visible { box-shadow:0 0 0 4px var(--accent-ring); }
  /* 音效开关：同样尺寸的圆角方按钮 */
  #sfxBtn { width:36px; height:36px; min-height:36px; padding:0; border-radius:10px; font-size:15px; }

  /* ============================================================
     ⑧ 对话卡片（一个群/私聊一张卡）
     ============================================================ */
  .gcard { background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--r-box);
           margin-bottom:16px; overflow:hidden; box-shadow:var(--shadow-card); }
  .gcard > summary { padding:14px 18px; background:var(--bg-subtle); border-bottom:1px solid transparent;
           display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .gcard[open] > summary { border-bottom-color:var(--border); }
  .gcard > summary::before { content:''; flex:0 0 auto; width:0; height:0;
    border-left:6px solid var(--text-tertiary); border-top:5px solid transparent;
    border-bottom:5px solid transparent; transition:transform .22s var(--ease); }
  .gcard[open] > summary::before { transform:rotate(90deg); }
  .gtitle { font-weight:600; color:var(--text); font-size:15px; }
  .cnt { color:var(--text-tertiary); font-size:12px; margin-left:auto; }
  .gedit { display:flex; gap:8px; flex-wrap:wrap; padding:12px 18px;
           background:var(--bg-subtle); border-bottom:1px solid var(--border); }
  .gedit input { flex:1; min-width:140px; font-size:14px; padding:9px 12px; }
  .gcode { padding:8px 18px 0; color:var(--text-tertiary); font-size:12px; word-break:break-all; }
  .msgs { padding:8px 18px 16px; }
  .msg { padding:14px 0; border-bottom:1px solid var(--divider); }
  .msg:last-child { border-bottom:0; padding-bottom:4px; }
  .mtop { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .who { font-weight:600; color:var(--text); }
  .tm { color:var(--text-tertiary); font-size:12px; margin-left:auto; font-variant-numeric:tabular-nums; }
  .txt { color:var(--text); word-break:break-word; }
  .tag { display:inline-flex; align-items:center; font-size:12px; font-weight:500;
         padding:2px 9px; border-radius:var(--r-pill);
         background:var(--bg-subtle); color:var(--text-secondary);
         border:1px solid var(--border); margin-right:6px; }
  .tag.no  { background:var(--bg-subtle); color:var(--text-secondary); }
  .tag.yes { background:var(--success-bg); color:var(--success); border-color:var(--success-bg); }
  .note { font-size:12px; color:var(--text-tertiary); margin:4px 0 6px; }
  .dec { margin-top:6px; color:var(--text-secondary); font-size:13px; }
  /* 鱼回的：很淡的一层底 + 左侧一条 accent 线（不是发光、不是渐变） */
  .ans { background:var(--bubble-bot); border-left:3px solid var(--accent);
         padding:10px 14px; border-radius:0 var(--r-in) var(--r-in) 0;
         margin:8px 0 2px; color:var(--text); }
  /* 🧪 试聊输出：旧版有 sbreply/sbrow 两个类**根本没有样式定义**（裸 div），这里补上 */
  .sbrow { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:4px; }
  .sbrow input { flex:1; min-width:180px; }
  .sbreply { background:var(--bubble-bot); border-left:3px solid var(--accent);
             padding:10px 14px; border-radius:0 var(--r-in) var(--r-in) 0; margin:6px 0; }

  /* ============================================================
     ⑨ 人设预设卡片（点卡片 = 切换）
     ============================================================ */
  .psgrid { display:flex; flex-wrap:wrap; gap:12px; }
  .pcard2 { flex:1 1 220px; max-width:340px; border:1px solid var(--border); border-radius:var(--r-card);
            padding:14px 16px; background:var(--bg-elevated); cursor:pointer;
            box-shadow:var(--shadow-card);
            transition:box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease); }
  .pcard2:hover { border-color:var(--border-strong); box-shadow:var(--shadow-pop); }
  .pcard2.on { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-ring); }
  .pcard2 b { font-size:15px; font-weight:600; display:block; color:var(--text); }
  .pcard2 .pmeta { font-size:13px; color:var(--text-secondary); margin:6px 0 10px; line-height:1.6; }
  .pcard2 .pmeta b { display:inline; font-size:inherit; font-weight:600; color:var(--text); }
  .pcard2 .prow { display:flex; gap:6px; align-items:center; }
  .pcard2 .ptag { font-size:12px; font-weight:500; color:var(--success); }

  /* ============================================================
     ⑩ 表单行：桌面标签在左，长文本行标签在上、控件铺满
     ============================================================ */
  .frow { display:flex; gap:12px; align-items:center; margin:12px 0; flex-wrap:wrap; }
  .frow label { width:auto; min-width:150px; margin-bottom:0; color:var(--text); }
  .frow input { flex:1; min-width:140px; }
  .frow.tall { display:block; }
  .frow.tall label { display:block; width:auto; margin-bottom:6px; }
  .frow.tall textarea { width:100%; min-height:380px; }
  .frow.tall button { margin-top:12px; }
  .exbar { display:flex; gap:8px; align-items:center; margin-top:12px; flex-wrap:wrap; }
  .pnmeta { font-size:13px; color:var(--text-secondary); font-variant-numeric:tabular-nums; }

  /* 语气示范表格：桌面四列（群友说 / 鱼回 / 身份 / 删），窄屏收成两列 */
  .exrow { display:grid; grid-template-columns:1fr 1fr 132px 44px; gap:10px; align-items:center; margin:8px 0; }
  .exrow input, .exrow select { width:100%; font-size:14px; padding:9px 12px; }
  .exrow button.danger { padding:6px 10px; min-height:34px; }
  @media (max-width:720px) {
    .exrow { grid-template-columns:1fr 44px; }
    .exrow select { grid-column:1; }
  }

  /* ============================================================
     ⑪ 用量趋势柱状图（纯 CSS，零依赖）
        ⚠️ 柱子的 height% 必须相对**固定高度的绘图区 .uplot** 算 ——
           标签留在绘图区外面，柱高比例才是真的（旧版把标签也放进同一容器里，
           结果 100% 和 72% 被 flex-shrink 压成"看着一样高"，用户截图点出来过）。
     ============================================================ */
  .ubars { display:flex; align-items:flex-end; gap:6px; margin:12px 0 4px; }
  .ubar { flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; min-width:0; }
  /* 🔴 绘图区必须是**独立、固定高度**的容器，而且**只装柱子**（数字和日期两行标签在外面）。
     为什么必须这样（2026-10-08 栽过一次 + 2026-10-08 用户再次强调）：
       · 柱高是 height:X% —— 百分比是相对**父元素**算的。父元素里只要还有别的行（数字/日期），
         那些行占掉的高度也会被算进 100%，大值那几根就会被 flex 的默认 flex-shrink:1
         压回"剩余可用高度" ⇒ 出现"1729 和 1252 看着一样高"的假象。
       · overflow:hidden 是**保险丝**：万一哪天比例算出超过 100%（比如我手滑或数据异常），
         最多被裁掉一点点，**绝不会把卡片撑破、把下面的内容挤走**。
     ✅ 用户的硬要求（2026-10-08）：「顶不顶格无所谓，只要所有柱子按比例长度就可以了，
        要确保有新的最大值进入表格时不会被卡片固定高度挡住」——
        固定高度绘图区 + 百分比柱高 + overflow:hidden，这三条同时成立，就是他要的效果。
     🔴 2026-10-08 用户第二次纠正：「能不能别让他倒着来呀，正常不都是从下往上的吗」
        —— 他是对的，柱子确实"从上往下悬着"。根因：align-items:flex-end（靠底对齐）在
        「容器高度 > 柱子高度」时会让 flex 反向分配空间，百分比高度就成了"从顶往下的一段"，
        柱子顶部贴顶、下方留空 ⇒ 看起来倒着长。
        ⇒ 改成 align-items:flex-start（靠**顶**对齐）+ 柱子 align-self:flex-end（自己贴**底**）。
          这样柱子百分比严格按"从底往上"算：100% 从底长到顶，64% 从底长到 64% 处。
        ⚠️ 这两个对齐属性看着像写反了，其实是关键：外层定"起始边"、柱子定"自己贴哪边"。
        （theme-audit 里有一条断言专门盯着"柱底必须与绘图区底边齐平"，就是为了锁死这件事。）*/
  .uplot { width:100%; height:120px; display:flex; align-items:flex-start; overflow:hidden; }
  /* ⚠️ 2026-10-08 打样截图抓到的一个真 bug：这里原来是 .ubar i { display:block; width:100% }，
     而 .uplot 是 display:flex **带 align-items:flex-end** —— flex 容器里**主轴（宽度）方向**由子项的
     width 决定，可它是 flex item 时 width:100% 会先按"内容宽"解析，再被 flex-shrink 分掉，
     结果**每根柱子宽度都不一样**（截图上高柱窄、矮柱宽，很脏）。⇒ 显式 flex:1 1 0 + align-self:stretch。*/
  /* ⚠️ min-height:2px —— 柱高是**严格按比例**算的（calls/本批最大值），所以极矮的一天
     就该是极矮的一条（2px 也算"有"）。这里**不设 10px 那种下限补丁**：
     一旦给矮柱补足到 10px，比例就被人为拉平了，用户要的"全都按比例"就破了。
     🔴🔴 2026-10-08 关键修正（"柱子倒着长"的真根因）：
        这里**绝对不能写 align-self:stretch**。我原来写过，结果它把外层 .uplot 的
        align-items:flex-end **整个覆盖掉**了 —— 因为按 flex 规范，align-self:stretch 在
        「子项已经是确定尺寸（这里 height:64%）」时会退化成 flex-start（靠**顶**对齐）。
        表现就是柱子**贴着顶边悬下来**、底下留一大块空（用户：「能不能别让他倒着来呀」）。
        ⇒ 去掉 align-self，只留 align-self:flex-end（贴底），柱子才真正从下往上长。
        ⚠️ 那"柱子怎么占满一整格宽"呢？靠 flex:1 1 0 就够了 ——
           **它连高度一起定了**（flex-basis:0 只作用于主轴=宽度），所以 width 交给 flex 就行。*/
  .ubar i { display:block; flex:1 1 0; align-self:flex-end; min-height:2px; border-radius:5px 5px 0 0;
            background:var(--chart-bar);
            transition:height .35s var(--ease); }
  .ubar i.hot  { background:var(--chart-bar-hot); }
  .ubar i.over { background:var(--chart-bar-over); }
  .ubar span { font-size:11px; color:var(--text-tertiary); margin-top:6px; white-space:nowrap; }
  .ubar u { font-size:11px; color:var(--text-secondary); text-decoration:none; margin-bottom:4px;
            font-variant-numeric:tabular-nums; }
  .ubar.today i { box-shadow:inset 0 0 0 2px var(--accent); }

  /* ============================================================
     ⑫ 代码块 / 原始日志 / 提示条
     ============================================================ */
  pre { margin:0; padding:14px; background:var(--code-bg); color:var(--code-text);
        border:1px solid var(--border); border-radius:var(--r-in);
        overflow:auto; max-height:340px; font-size:13px; line-height:1.6; }
  body[data-page="raw"] pre#log { max-height:none; min-height:65vh; }
  #toast { position:fixed; left:50%; bottom:32px; transform:translateX(-50%);
           background:var(--bg-elevated); border:1px solid var(--border); color:var(--text);
           padding:12px 20px; border-radius:var(--r-pill); font-size:14px; font-weight:500;
           display:none; z-index:50; max-width:92vw; box-shadow:var(--shadow-pop);
           animation:toastIn .22s var(--ease) both; }
  @keyframes toastIn { from { opacity:0; transform:translate(-50%,10px); } to { opacity:1; transform:translate(-50%,0); } }

  /* 分页面显隐：**只对 main 里的区块生效**
     ⚠️ 千万别写成通配的 [data-page]{display:none} —— body 自身也带 data-page，会把整页藏掉 */
  main > [data-page] { display:none; }
  body[data-page="overview"] main > [data-page="overview"],
  body[data-page="chat"]     main > [data-page="chat"],
  body[data-page="settings"] main > [data-page="settings"],
  body[data-page="raw"]      main > [data-page="raw"] { display:block; }

  /* 滚动条：两套主题各一份（深色下用亮色滑块，浅色下用暗色滑块） */
  *::-webkit-scrollbar { width:10px; height:10px; }
  *::-webkit-scrollbar-thumb { background:var(--scroll-thumb); border-radius:9px;
    border:2px solid transparent; background-clip:content-box; }
  *::-webkit-scrollbar-track { background:transparent; }

  @media (max-width:768px) {
    .bar { padding:12px 16px; }
    .tabbar { padding:0 16px 10px; }
    main { padding:24px 16px 72px; }
    main > section { margin-bottom:48px; }
    .grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  }
  @media (max-width:480px) {
    .grid { grid-template-columns:1fr; }
    .frow label { min-width:0; width:100%; margin-bottom:6px; }
    .ctrls { width:100%; justify-content:flex-end; }
  }
  /* ♿ 尊重"减少动效" */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration:.001ms !important; transition-duration:.001ms !important; }
  }
</style></head>
<body>
<header class="appbar">
  <div class="bar">
    <div class="brand"><span class="logo">🐋</span><h1>QQbot控制台</h1></div>
    <div class="pills">
      <span id="svc" class="pill">…</span>
      <span id="build" class="pill">v…</span>
      <span id="upd" class="pill">…</span>
    </div>
    <span class="spacer"></span>
    <div class="ctrls">
      <!-- 🆕 2026-10-08 三段式主题开关（跟随系统 / 浅色 / 深色）
           选择写 localStorage('theme')；aria-pressed 同步给读屏器 -->
      <div class="seg" id="themeSeg" role="group" aria-label="外观主题">
        <button type="button" data-theme-mode="system" aria-label="跟随系统外观" aria-pressed="false">跟随系统</button>
        <button type="button" data-theme-mode="light"  aria-label="强制浅色外观" aria-pressed="false">浅色</button>
        <button type="button" data-theme-mode="dark"   aria-label="强制深色外观" aria-pressed="false">深色</button>
      </div>
      <button id="sfxBtn" type="button" title="点击音效开关" aria-label="点击音效开关">🔊</button>
    </div>
  </div>
  <nav class="tabbar" id="tabs" aria-label="页面导航">
    <a href="#" data-tab="overview">概览</a>
    <a href="#" data-tab="chat">对话</a>
    <a href="#" data-tab="settings">设置</a>
    <a href="#" data-tab="raw">日志</a>
  </nav>
</header>
<div id="offbar"></div>
<div id="errbar"></div>
<main>
  <!-- 🔴 2026-10-08（用户：「把刷新和自动刷新两个按键都删了，没什么用，直接刷新网页就好了，又不麻烦」）
       ⇒ 去掉「刷新」「自动刷新 5s」两个按钮，连带删掉 toggleAuto() 和 auto 定时器（按钮没了，定时器不能留着空转）。
       页面本来就在打开时拉一次数据；要看最新的直接按浏览器刷新。
       ⚠️ 原来这里那个 #fnote 行内说明也一起删了：它挂在 data-page="overview" 的容器里，
       而它写的却是"设置页/对话页/日志页"的说明 ⇒ **那些页面永远看不到它**（死代码）。 -->
  <section data-page="overview">
    <h2>额度与用量</h2>
    <div class="grid" id="budget"></div>
    <!-- 🆕 2026-10-08 用户要求：「在"额度与用量"边上加入提示：全按峰值计算，真实值请查看官api key监控」
         依据（不是随口写的）：config.js 的 priceTable 明确标着"deepseek-flash 高峰：输入2元/输出8元（空闲减半）"，
         且注释写着"⚠️ 这里保守取**高峰价**（贵的那档），所以估算偏高、绝不超支"。
         ⇒ 也就是：面板上这些钱是**本地按峰值单价算出来的保守值**，比真实扣费偏高；
           要看真实花费/余额得去 DeepSeek 官方控制台。 -->
    <p class="hint" style="margin-top:12px">💡 这里的金额（今日已花 / 累计已花）<b>全按峰值单价计算</b>，是<b>偏高的保守估算</b>；<b>真实值请到官方 API Key 监控（DeepSeek 控制台）查看</b>。</p>
  </section>

  <section data-page="overview">
    <h2>用量趋势</h2>
    <div class="card">
      <div class="exbar" style="margin:0 0 12px">
        <button class="sm" onclick="loadUsage(7)" type="button">最近 7 天</button>
        <button class="sm" onclick="loadUsage(14)" type="button">14 天</button>
        <button class="sm" onclick="loadUsage(30)" type="button">30 天</button>
        <span id="useNote" class="hint" style="margin:0"></span>
      </div>
      <div id="useChart"></div>
      <!-- 🔴 2026-10-07（用户：「这 1600 不会跟着改」）：**这里的数字必须从 /api/state 的生效值来**，
           绝不能写死 —— 写死的话，他在设置里改成 3000、这段还在说 1600，等于自己打自己的脸。
           ⚠️ 另外：HTML 里不能写 Markdown 的星号（会原样显示成星号，用户就是这么发现的）⇒ 用 b 标签。
           🆕 2026-10-08（用户看到红色柱子问「这个红色的是怎么回事」）⇒ **补上颜色说明**：
              柱子会变黄/变红不是装饰，是"这天快到/已超日次数上限"的警示，必须写在图上，
              否则用户只能猜（我当时只做了颜色、没做图例，属于"做了功能没做说明"）。 -->
      <p class="hint">柱子 = 当天<b>模型调用次数</b>（最高那根满格，其余按比例）；柱子上面小字 = 当天<b>花费（元）</b>。
        日额度 <b id="useDailyTxt">…</b> 是"钱"那道闸。
        柱子颜色：<b>蓝</b> = 正常；<b>黄</b> = 已到 <b id="useLimitTxt2">…</b> 的 80%；<b>红</b> = 这天<b>撞满/超过</b>了 <b id="useLimitTxt3">…</b> 的日次数上限。</p>
    </div>
  </section>

  <!-- 🆕 2026-10-07 人设预设（用户：「把当前的人设提示词+示范做成一个人设预设，存成预设卡片，
       然后点击卡片可以切换不同的人设预设」）-->
  <details data-page="settings" class="pcard">
    <summary>人设预设（点卡片就能切换性格）</summary>
    <div class="card" style="margin-top:12px">
      <div class="exbar" style="margin:0 0 12px">
        <input type="text" id="psName" placeholder="给这套性格起个名字（如：甜系傲娇 / 冷静毒舌）" maxlength="20" style="flex:1;min-width:180px">
        <button class="primary sm" onclick="psCapture()" type="button">＋ 把当前人设+示范存成预设</button>
      </div>
      <div id="psList"></div>
      <p class="hint">一个预设 = <b>整套性格</b>（人设提示词 ＋ 语气示范）。<b>点卡片 = 切换</b>，立刻生效、不用重启。
        ⚠️ 切换属于 prompt 前缀，改一次会让模型缓存失效一次（贵一点点）。</p>
    </div>
  </details>

  <section data-page="overview">
    <h2>开关机</h2>
    <div class="card" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <b id="pwstate" class="pwstate">…</b>
      <span id="pwby" class="pwhint"></span>
      <span style="flex:1"></span>
      <button class="primary sm" onclick="setPower(true)" type="button">开机</button>
      <button class="danger sm" onclick="setPower(false)" type="button">关机</button>
    </div>
    <p class="hint">关机后：不回话、不解析链接、不识别图片（一分钱不花）。改完几秒内生效，不用重启。</p>
  </section>

  <details data-page="settings">
    <summary>参数设置（点开修改）</summary>
    <div id="settings" style="margin-top:12px"></div>
    <div class="frow" style="margin-top:12px">
      <button onclick="restartBot()" type="button">重启机器人</button>
      <span class="hint" style="margin:0">（每个参数改完点它自己的「保存」）</span>
    </div>
    <p class="hint">额度/次数上限：保存后立即生效。<b>AI 密钥</b>：保存后需要点一次「重启机器人」才生效。密钥不会回显，只显示前后几位。</p>
  </details>

  <!-- 🆕 2026-10-06 用户要的「示范显化 / 可编辑」：
       鱼的语气主要由这些示范决定（比人设文字影响更大）⇒ 做成面板可改。
       2026-10-06 晚（用户）：「给示范卡片加收展功能，默认收，也就是跟其他卡片一样」
       ⇒ 从 <section>+<h2> 改成 <details>+<summary>（和「参数设置」同款），**默认收起**（不加 open）。 -->
  <details data-page="settings">
    <summary>语气示范（教它怎么说话，点开修改）</summary>
    <p class="hint" style="margin-top:12px">左边是「群友说」，右边是「鱼回」。<b>决定鱼语气的其实就是这些</b>（比人设那段文字影响更大）。</p>
    <div id="exList" style="margin-top:12px"></div>
    <div class="exbar">
      <button class="sm" onclick="exAdd()" type="button">+ 加一组</button>
      <button class="sm primary" onclick="exSave()" type="button">保存全部</button>
      <button class="sm" onclick="exReset()" type="button">恢复默认</button>
      <span id="exNote" class="hint" style="margin:0"></span>
    </div>
    <p class="hint">⚠️ 保存后会<b>立刻生效</b>（不用重启）。但示范属于 prompt 前缀 ⇒ <b>每改一次，模型缓存失效一次</b>（贵一点）。
      建议：改完先去<b>下面</b>「试聊」试两句，满意就别再来回改。</p>
  </details>

  <section data-page="settings">
    <h2>试聊（只给看，不发群）</h2>
    <div class="card">
      <div class="sbrow">
        <input type="text" id="sbText" placeholder="输入一句要试的话（前面加 @ 就当被 @ 了）" maxlength="500"
               onkeydown="if(event.key==='Enter'){sandboxSend();}">
        <button class="primary" onclick="sandboxSend()" type="button">试一句</button>
      </div>
      <p class="hint">走的是<b>和线上同一套</b>人设与判据；⚠️ 是<b>真实模型调用</b>（会计入账本），但<b>不会发到任何群</b>，也不占机器人的冷却/上下文。</p>
      <div id="sbOut"></div>
    </div>
  </section>

  <section data-page="chat">
    <h2>对话</h2>
    <div id="convos"></div>
  </section>

  <!-- 🆕 2026-10-06 用户：原始日志既然已经放到单独界面了，那展示框可以加长啊，还有默认就是展开吧
       ⇒ details 默认 open；pre 去掉 340px 上限、给足高度（样式见 body[data-page=raw] pre#log） -->
  <details data-page="raw" open>
    <summary>原始日志（排查用，平时不用看）</summary>
    <div style="margin-top:12px"><pre id="log" style="max-height:none;min-height:65vh">加载中…</pre></div>
  </details>
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>
const P = ${JSON.stringify(opts && opts.pwd || "")};
const CUR = ${JSON.stringify(opts && opts.page || "overview")};

// 🔴 最重要的一段（2026-10-06 加）：**任何脚本错误都要看得见**。
//    之前踩的坑：页面脚本在"发第一个请求之前"就静默崩了 ⇒ 页面只剩一堆空占位，
//    错误只在控制台里（用户看不到），我连查三轮都没定位。
try { window.addEventListener('error', function(ev){
  try {
    var e = document.getElementById('errbar');
    if (e) {
      e.style.display = 'block';
      e.textContent = '⚠️ 脚本错误：' + (ev.message || ev.error) +
        '（' + (ev.filename || '').split('/').pop() + ':' + (ev.lineno || '?') + '）';
    }
  } catch (_) {}
});
} catch (_) {}   // ⚠️ 挂监听本身也要防错（否则会复现"脚本起步即崩"）
try { window.addEventListener('unhandledrejection', function(ev){
  try {
    var e = document.getElementById('errbar');
    if (e) {
      e.style.display = 'block';
      e.textContent = '⚠️ 请求出错：' + ((ev.reason && (ev.reason.message || ev.reason)) || '未知');
    }
  } catch (_) {}
});
} catch (_) {}
document.cookie = 'lp=' + encodeURIComponent(P) + ';path=/;max-age=31536000';

// ===== 🆕 2026-10-08 主题（跟随系统 / 浅色 / 深色）=====
// ⚠️ 首屏那一下是 head 里的**内联脚本**干的（防闪烁），这里是"交互 + 持久化 + 跟随系统"。
// ⚠️ media 监听的处理很关键：**只有"没手动选过"时才跟随系统** ——
//    用户手动选了浅色，系统半夜切深色，页面必须**保持浅色**（这正是他要的"强制浅色"）。
var THEME_KEY = 'theme';
function themeMode(){
  try { var v = localStorage.getItem(THEME_KEY); return (v === 'light' || v === 'dark') ? v : 'system'; }
  catch (e) { return 'system'; }
}
function prefersDark(){
  try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  catch (e) { return false; }
}
function resolveTheme(mode){ return (mode === 'system') ? (prefersDark() ? 'dark' : 'light') : mode; }
function paintTheme(){
  var mode = themeMode();
  var t = resolveTheme(mode);
  try {
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'dark' ? '#1C1C1E' : '#F5F5F7');
  } catch (e) {}
  var btns = document.querySelectorAll('#themeSeg button');
  for (var i = 0; i < btns.length; i++) {
    var on = (btns[i].getAttribute('data-theme-mode') === mode);
    btns[i].className = on ? 'on' : '';
    btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}
function setThemeMode(mode){
  if (mode !== 'light' && mode !== 'dark') mode = 'system';
  try {
    if (mode === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
  } catch (e) { /* 存不了也照样当场生效 */ }
  paintTheme();
}
// 系统主题变化：未手动选择过才跟随（手动选过 = localStorage 里就是 light/dark）
try {
  var _mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (_mq && typeof _mq.addEventListener === 'function') {
    _mq.addEventListener('change', function(){ if (themeMode() === 'system') paintTheme(); });
  } else if (_mq && typeof _mq.addListener === 'function') {
    _mq.addListener(function(){ if (themeMode() === 'system') paintTheme(); });
  }
} catch (e) {}
// 主题开关（事件委托；按钮在 body 里，本脚本在 body 末尾 ⇒ 一定已经存在）
try {
  var seg = document.getElementById('themeSeg');
  if (seg && typeof seg.addEventListener === 'function') {
    seg.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('button[data-theme-mode]') : null;
      if (!b) return;
      setThemeMode(b.getAttribute('data-theme-mode'));
      try { SFX.click(); } catch (e) {}
    });
  }
  paintTheme();
} catch (e) {}

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function yuan(v){ return '\\u00a5' + (Number(v)||0).toFixed(4); }
function toast(msg, ms){
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._t); t._t = setTimeout(()=>{ t.style.display='none'; }, ms || 2600);
}
function toggleRaw(){ const d = document.querySelectorAll('main > details'); if (d.length) { const last = d[d.length-1]; last.open = !last.open; } }

function showErr(msg){
  const e = document.getElementById('errbar');
  if (!e) return;
  if (!msg) { e.style.display = 'none'; return; }
  e.style.display = 'block';
  e.textContent = '⚠️ ' + msg;
}
function mark(id, txt){ const el = document.getElementById(id); if (el) el.textContent = txt; }

async function load(){
  // ⚠️ 这里**故意不调用 mark/showErr** —— 直接操作 DOM。
  //    原因：万一辅助函数有问题，会导致"load 第一行就抛错、连请求都发不出去"（真实踩过）。
  const _upd = document.getElementById('upd');
  const _build = document.getElementById('build');
  const _err = document.getElementById('errbar');
  const setErr = (m) => { if (_err) { _err.style.display = m ? 'block' : 'none'; if (m) _err.textContent = '⚠️ ' + m; } };
  setErr('');
  if (_upd) _upd.textContent = '加载中…';
  if (_build) _build.textContent = 'v…';
  try {
    const r = await fetch('/api/state?p=' + encodeURIComponent(P));
    if (!r.ok) throw new Error('服务器返回 ' + r.status + (r.status === 401 ? '（密码不对或 cookie 过期）' : ''));
    const j = await r.json();

    const svc = document.getElementById('svc');
    svc.textContent = (j.service === 'active' ? '运行中' : j.service);
    svc.className = 'pill ' + (j.service === 'active' ? 'on' : 'off');

    const off = document.getElementById('offbar');
    const pw = j.power || {};
    if (!pw.on) {
      off.style.display = 'block';
      off.textContent = '⏻ 已关机：不回话、不解析链接、不识别图片'
        + (pw.by ? '（由 ' + pw.by + ' 设置）' : '') + '　点下面的「开机」恢复';
    } else off.style.display = 'none';
    document.getElementById('pwstate').textContent = pw.on ? '⏻ 运行中' : '⏻ 已关机';
    document.getElementById('pwstate').className = 'pwstate' + (pw.on ? '' : ' warn');

    // 每一步单独兜底 —— 某一块出错不该让整页变成空白（之前就是这样，还只弹了个会消失的提示）
    try { renderBudget(j.budget); } catch (e) { setErr('额度渲染失败：' + e.message); }
    // 🆕 2026-10-07：额度一变，趋势图的黄/红阈值与那段说明里的数字也跟着变
    //    （用户原话「这 1600 不会跟着改」—— 写死的上限比没有上限更误导人）
    try { applyLimits(j.budget); loadUsage(lastUsageDays); } catch (e) { /* 不影响其它区块 */ }
    try { renderSettings(j.settings); } catch (e) { setErr('设置渲染失败：' + e.message); }
    try { refreshExampleHint(); } catch (e) { /* 示范还没加载完也不影响别的 */ }
    try { renderGroups(j.convos); } catch (e) { setErr('对话渲染失败：' + e.message); }
    try { document.getElementById('log').textContent = j.log || '(空)'; } catch (e) {}
    if (_build) _build.textContent = 'v' + (j.build || '?');
    const n = (j.convos || []).length;
    if (_upd) _upd.textContent = '更新 ' + new Date().toLocaleTimeString('zh-CN') + (n ? '' : '（0 条对话）');
  } catch (err) {
    setErr('取数据失败：' + err.message);
    if (_upd) _upd.textContent = '失败';
    toast('取数据失败：' + err.message);
  }
}

function renderBudget(b){
  const el = document.getElementById('budget');
  if (!b) { el.innerHTML = '<div class="card"><span>暂无花费数据</span></div>'; return; }
  // 🔴 2026-10-06：**"累计已花"只用本地账本**（官方口径/锚点已按用户要求删除）
  el.innerHTML =
    card(yuan(b.daySpent), '今日已花 / 上限 ' + yuan(b.dailyLimit)) +
    card(yuan(b.spentYuan), '累计已花 / 上限 ' + yuan(b.totalLimit)) +
    card((b.dayCalls||0), '今日调用 / 上限 ' + (b.dailyCallLimit||'?') + ' 次') +
    card(b.dayLeft==null?'—':yuan(b.dayLeft), '今日剩余', (b.dayLeft!=null && b.dayLeft<1));
}
function card(big, small, warn){
  return '<div class="card"><b class="' + (warn?'warn':'') + '">' + big + '</b><span>' + small + '</span></div>';
}

function renderSettings(s){
  const el = document.getElementById('settings');
  if (!s || !Object.keys(s).length) { el.innerHTML = '<p class="hint">没有可改的参数（settings.snapshot() 返回空）</p>'; return; }
  // 🆕 2026-10-06 用户：人设补充为什么要单独做功能，直接在修改里面的末尾加上不就行了？
  //    ⇒ 去掉单独的「人设补充」行，只留一个「人设」大框（保存时会顺手清掉旧的补充值）
  const order = ['aiApiKey','budgetDaily','budgetTotal','dailyCalls','personaText'];
  const rows = order.filter(k => s[k]).map(k => {
    const it = s[k];
    const val = it.value == null ? '' : it.value;
    const id = 'set_' + k;
    const tall = (k === 'personaText') ? ' tall' : '';   // 长文本行：标签在上、控件铺满
    return '<div class="frow' + tall + '"><label for="' + id + '">' + esc(it.label) + '</label>' +
      (k === 'personaText'
        ? '<textarea id="' + id + '" data-key="' + k + '" rows="20" placeholder="留空=用代码里的默认人设">' + esc(val) + '</textarea>'
          // 🆕 2026-10-07 用户嫌那个框"不好看"⇒ 顺手给它一点信息装饰（字数 + 估算 token，他能直接感知成本）
          + '<div class="hint pnmeta" id="pnCount"></div>'
        : '<input id="' + id + '" data-key="' + k + '" ' +
          // ⚠️⚠️ 密码分支的收尾 > **必须留着**（这个收尾符被吃掉过两次，害得「保存」变纯文本）
          (it.secret ? 'type="password" placeholder="留空=不改；粘贴新的会覆盖" value="">' :
            'type="number" step="0.01" value="' + esc(val) + '">')) +
      '<button class="sm" data-save="' + k + '" type="button">保存</button></div>';
  }).join('');
  el.innerHTML = rows + (s.aiApiKey ? '<p class="hint">当前密钥：' + esc(s.aiApiKey.value || '（未设置）') + '</p>' : '')
    // 🔴 2026-10-08（用户：「检查一遍，面板中的小文字提示中的数字会不会随着设置面板中的修改而跟着改变」）：
    //    这句原来是**写死一个固定组数**的 —— 用户增删示范之后它不会变，属于"会撒谎的提示"。
    //    ⚠️ 旧文案原文**连注释里都不留**（同下面 exLoad 那条的理由：交付出去的脚本里带着它，
    //       检索/断言就会误判成"还没改"——我这次就是这么误判了一次）。
    //    ⇒ 现在**不在这里写数字**，只留一段占位说明，真实组数由 exLoad() 拿到后填进去
    //      （见 refreshExampleHint()，去重用的也是同一份数据，两边不可能再打架）。
    + '<p class="hint">人设 = <b>上面这个大框（system 人设）</b> + <b>语气示范</b>（写在代码里、'
    + '<u>仍然生效</u>，这个框改不到它）。清空保存 = 回到默认人设。</p>'
    + '<p class="hint" id="exHintInSettings"></p>';
  personaInit();     // 🆕 文字计数（字 + 估算 token）
}

// 🆕 2026-10-07：人设框的文字计数（本项目实测过换算比：**1 字 ≈ 0.567 token**）
function personaInit(){
  var ta = document.getElementById('set_personaText');
  var box = document.getElementById('pnCount');
  // ⚠️ 防御：非浏览器环境（自测的 vm 沙箱）元素桩可能没有 addEventListener ⇒ 不能让它抛错
  if (!ta || !box || typeof ta.addEventListener !== 'function') return;
  var upd = function () {
    var n = (ta.value || '').length;
    var tok = Math.round(n * 0.567);
    box.textContent = n + ' 字 · 约 ' + tok + ' token'
      + (n > 1400 ? '　⚠️ 偏长了，建议精简（每次对话都要重发）' : '');
    // ⚠️ 原来这里写的是行内 style.color = '#fca5a5'（散装色值）⇒ 改成挂类，颜色由 CSS 变量给
    box.className = 'hint pnmeta' + (n > 1400 ? ' warn' : '');
  };
  ta.addEventListener('input', upd);
  upd();
}

async function saveOne(key){
  const inp = document.querySelector('#settings [data-key="' + key + '"]');
  if (!inp) return;
  const v = (inp.value || '').trim();
  const patch = {};
  // ⚠️ 人设补充（textarea）：**留空 = 清掉补充**（否则存了就永远删不掉）
  const isText = inp.tagName === 'TEXTAREA';
  if (v || isText) patch[key] = v;
  if (!Object.keys(patch).length) { toast('这个参数没改（空 = 不改）'); return; }
  const r = await fetch('/api/settings?p=' + encodeURIComponent(P), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch),
  });
  const j = await r.json();
  if (!j.ok) { toast('❌ ' + (j.why||'保存失败')); return; }
  toast('✅ 已保存' + (j.needRestart ? '（密钥需点「重启机器人」才生效）' : '（立即生效）'));
  // 🔴 设置区的「保存」用**事件委托 + data-save**（不再拼内联 onclick 的引号，那个坑踩过两次）
document.addEventListener('click', function (ev) {
  var b = ev.target && ev.target.closest && ev.target.closest('button[data-save]');
  if (!b) return;
  saveOne(b.getAttribute('data-save'));
});

load();
}

async function saveSettings(){
  const patch = {};
  for (const inp of document.querySelectorAll('#settings input[data-key]')) {
    const k = inp.dataset.key;
    const v = (inp.value || '').trim();
    if (!v) continue;
    patch[k] = v;
  }
  if (!Object.keys(patch).length) { toast('没有要改的内容'); return; }
  const r = await fetch('/api/settings?p=' + encodeURIComponent(P), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch),
  });
  const j = await r.json();
  if (!j.ok) { toast('❌ ' + (j.why||'保存失败')); return; }
  toast('✅ 已保存' + (j.needRestart ? '（密钥需点「重启机器人」才生效）' : '（立即生效）'));
  load();
}

async function restartBot(){
  if (!confirm('现在重启机器人？大约 5 秒内恢复，期间不回复消息。')) return;
  toast('正在重启…');
  const r = await fetch('/api/restart?p=' + encodeURIComponent(P), { method:'POST' });
  const j = await r.json();
  toast(j.ok ? '✅ 已发出重启' : ('❌ ' + (j.why||'重启失败')));
  setTimeout(()=>load(), 4000);
}

async function setPower(on){
  const r = await fetch('/api/power?p=' + encodeURIComponent(P), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({on}),
  });
  const j = await r.json();
  if (j.ok) SFX.ok(); else SFX.err();
  toast(j.ok ? ('✅ 已' + (on?'开机':'关机') + '（几秒内生效）') : ('❌ ' + (j.why||'失败')));
  setTimeout(()=>load(), 2500);
}

// 🔴 一个会话（群/私聊）= 一张卡：群信息只出现一次（卡片顶部），下面是这个群的所有消息。
//    （用户 2026-10-05 纠正：每条消息各带一个编辑框"很奇怪而且占地方"。）
function renderGroups(list){
  const el = document.getElementById('convos');
  if (!list || !list.length) { el.innerHTML = '<div class="card"><span>最近没有对话（日志里没解析到 [群]/[私聊] 行）</span></div>'; return; }

  // 按 scope 归组，保持"最先出现的会话排最前"（跟列表顺序一致 = 时间倒序）
  const groups = [];
  const idx = new Map();
  for (const c of list) {
    let g = idx.get(c.scope);
    if (!g) {
      g = { scope:c.scope, kind:c.kind, name:c.groupName,
            groupNo:c.groupNo || '', realId:c.realId || '', msgs:[] };
      idx.set(c.scope, g); groups.push(g);
    }
    g.msgs.push(c);
  }

  el.innerHTML = groups.map((g, gi) => {
    const isPriv = g.kind === 'private';
    const nameVal = /未命名/.test(g.name || '') ? '' : (g.name || '');
    // 卡片标题栏 + 编辑区，塞进 summary 里（点击标题就能收起/展开，跟"原始日志"一个交互）
    const sum = '<summary>' +
        '<span class="gtitle">' + esc(g.name || '未命名') + '</span>' +
        '<span class="tag">' + (isPriv ? '私聊' : '群') + '</span>' +
        '<span class="cnt">' + g.msgs.length + ' 条（每群最多 60）</span>' +
      '</summary>';
    // ⚠️ 编辑框放在 summary **外面** —— 否则点输入框会连带收起卡片
    // ① 群内码：**只读**（用户说"那串乱码对我没啥用，非要写就固定在群昵称旁边或下面独占一行"）
    // ② 输入框：默认空缺，**专门用来填你要看的群号**
    const edit = '<div class="gedit">' +
        '<input type="text" placeholder="' + (isPriv ? '备注名（可手改）' : '群名（可手改）') + '" value="' + esc(nameVal) + '" data-g="' + gi + '" data-f="name">' +
        '<input type="text" placeholder="群号（自己填，方便你认）" value="' + esc(g.groupNo || '') + '" data-g="' + gi + '" data-f="no">' +
        '<button class="sm" onclick="saveGroup(' + gi + ')" type="button">保存</button>' +
      '</div>' +
      (isPriv ? '' : '<div class="gcode">群内码 ' + esc(g.realId || '（认不出）') + '</div>');

    // 🔴 卡内排序（2026-10-06 用户要求反过来）：
    //    原话「**卡片内消息排序方式从上到下是从早到晚，但是这样每次刷新消息都会出现在卡片最下面了，
    //    要去翻，不合理，排序反一下**」⇒ 现在**最新在上**（后端已按此顺序给，直接用不 reverse）。
    //    ⚠️ 每会话 60 条的上限已在**后端按真实群号裁好**，这里不再截断（避免"上面写 60、实际 40"）。
    const msgs = g.msgs.map((c) => {
      const q = '<div class="mtop"><span class="who">' + esc(c.who) + '</span>' +
        '<span class="tm">' + esc(c.time || '') + '</span></div>' +
        '<div class="txt">' + (esc(c.text) || '<span class="hint" style="margin:0">（非文字消息）</span>') + '</div>';
      let dec = '';
      if (c.decision) {
        const isNo = /^不回/.test(c.decision);
        dec = '<div class="dec"><span class="tag ' + (isNo?'no':'yes') + '">' + (isNo?'没回':'回了') + '</span>' + esc(c.decision) + '</div>';
      } else if (!(c.replies && c.replies.length)) {
        dec = '<div class="dec"><span class="tag no">没回</span>（没触发回复条件）</div>';
      }
      const ans = (c.replies && c.replies.length)
        ? c.replies.map(t => '<div class="ans">' + esc(t) + '</div>').join('') : '';
      // 🆕 2026-10-07：处理细节（收到图/动图抽帧/视频跳过…）单独一行、淡淡的 ——
      //    用户问过「都是动图和下载是什么」⇒ ① 从"决策"位置挪出来 ② 已翻成人话
      const notes = (c.notes && c.notes.length)
        ? '<div class="note">' + c.notes.map(t => esc(t)).join(' · ') + '</div>' : '';
      return '<div class="msg">' + q + dec + notes + ans + '</div>';
    }).join('');

    return '<details class="gcard" open>' + sum + edit + '<div class="msgs">' + msgs + '</div></details>';
  }).join('');

  // 把分组结果挂到 window 上，保存时按索引取
  window.__groups = groups;
}

async function saveGroup(gi){
  const g = (window.__groups || [])[gi];
  if (!g) return;
  const wrap = document.querySelectorAll('.gcard')[gi];
  if (!wrap) return;
  const name = (wrap.querySelector('input[data-f=name]').value || '').trim();
  const no = (wrap.querySelector('input[data-f=no]').value || '').trim();
  const aliases = {};
  aliases[g.scope] = { name, no };
  const r = await fetch('/api/groups?p=' + encodeURIComponent(P), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({aliases}),
  });
  const j = await r.json();
  toast(j.ok ? '✅ 已保存' : ('❌ ' + (j.why||'保存失败')));
  if (j.ok) load();
}

async function sandboxSend(){
  const inp = document.getElementById('sbText');
  const out = document.getElementById('sbOut');
  const text = (inp.value || '').trim();
  if (!text) { toast('先输入要试的话'); return; }
  out.innerHTML = '<p class="hint">生成中…（真实调用，稍等几秒）</p>';
  try {
    const r = await fetch('/api/sandbox?p=' + encodeURIComponent(P), {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text}),
    });
    const j = await r.json();
    if (!j.ok) { out.innerHTML = '<p class="hint">❌ ' + esc(j.why || '失败') + '</p>'; return; }
    const segs = (j.segments && j.segments.length) ? j.segments : [j.text || '(空)'];
    out.innerHTML =
      '<div class="hint">' + (j.isAt ? '（按"被 @ 了"试）' : '（按普通消息试）') +
      ' · ' + j.ms + 'ms · 拆成 ' + segs.length + ' 条</div>' +
      segs.map(t => '<div class="sbreply">' + esc(t) + '</div>').join('');
  } catch (e) {
    out.innerHTML = '<p class="hint">❌ ' + esc(e.message) + '</p>';
  }
}

// 🔴 2026-10-08：toggleAuto() 已随两个按钮一起删除（用户要求），别再往回加。
try { load(); } catch (e) {
  var _e2 = document.getElementById('errbar');
  if (_e2) { _e2.style.display = 'block'; _e2.textContent = '⚠️ 启动失败：' + e.message; }
}
// 🆕 语气示范表格：进页面就把当前生效的那份读出来（没配过则显示"用的是默认"）
try { exLoad(); } catch (e) { /* 读不到不影响别的 */ }
// 🆕 用量趋势：默认画最近 14 天
try { loadUsage(14); } catch (e) { /* 读不到不影响别的 */ }
// 🆕 人设预设：进页面就列出卡片
try { psLoad(); } catch (e) { /* 读不到不影响别的 */ }
// 🔴 分页面（2026-10-06 用户要求「做几个分页面，别全挤在一起」）：
//    同一份 HTML 里给每个区块打了 data-page，这里按 body[data-page] 显隐 + 高亮标签栏。
//    ⚠️ 用 CSS 显隐而不是"多套模板" —— 保证**只有一份模板**（避免又踩"两份拷贝"的坑）。
// ===== 🆕 2026-10-06 语气示范（examples）面板编辑 =====
// 说明：示范决定鱼的语气；存到 data/examples.json，改完即时生效（但会让模型缓存失效一次）。
// ⚠️ 本段**不用模板字符串、不用反引号**（模板里的反引号会把整个 PAGE 截断 —— 白屏事故的根因）。
// 🆕 2026-10-08（用户：「小文字提示中的数字会不会随着设置面板中的修改而跟着改变」）
// 把"示范 N 组"这个数字**用同一份数据**同时写进两处提示：设置页人设框下面 + 示范卡片下面。
// ⚠️⚠️ 时序坑（我第一版就踩了）：load() 和 exLoad() 是两个并发请求，
//    而 load() → renderSettings() 会**重建**设置区的 DOM（把提示节点也重建一遍）——
//    如果此时 exLoad 还没回来，EX 还是空的，就会把"0 组"写进提示 ⇒ 看着像"你没配示范"。
//    ⇒ 用一个 EX_LOADED 标记：**没加载完就不填数字**（宁可先空着），加载完再刷。
var EX = [];
var EX_LOADED = false;
var EX_ROLES = ['', '普通群员', '主人'];

function exRowHtml(it, i) {
  var opts = EX_ROLES.map(function (r) {
    var sel = (String(it.role || '') === r) ? ' selected' : '';
    return '<option value="' + esc(r) + '"' + sel + '>' + (r || '（不标身份）') + '</option>';
  }).join('');
  return '<div class="exrow" data-i="' + i + '">' +
    '<input type="text" data-f="u" value="' + esc(it.u || '') + '" placeholder="群友说…" maxlength="300">' +
    '<input type="text" data-f="a" value="' + esc(it.a || '') + '" placeholder="鱼回…" maxlength="300">' +
    '<select data-f="role">' + opts + '</select>' +
    '<button class="sm danger" onclick="exDel(' + i + ')" type="button">删</button>' +
    '</div>';
}

function exRender() {
  var el = document.getElementById('exList');
  if (!el) return;
  el.innerHTML = EX.length
    ? EX.map(exRowHtml).join('')
    : '<p class="hint">（现在用的是代码里的默认示范；点「恢复默认」也是它）</p>';
}

// 从 DOM 收集当前表格内容（全空的组自动跳过）
function exCollect() {
  var rows = document.querySelectorAll('#exList .exrow');
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var u = (r.querySelector('[data-f=u]').value || '').trim();
    var a = (r.querySelector('[data-f=a]').value || '').trim();
    var role = (r.querySelector('[data-f=role]').value || '').trim();
    if (!u && !a) continue;
    var o = { u: u, a: a };
    if (role) o.role = role;
    out.push(o);
  }
  return out;
}

function exNote(t, warn) {
  var n = document.getElementById('exNote');
  // ⚠️ 原来这里写行内 style.color = '#fca5a5' ⇒ 改成挂类（颜色走变量，两套主题自动适配）
  if (n) { n.textContent = t || ''; n.className = 'hint' + (warn ? ' warn' : ''); }
}

// 🆕 2026-10-08（用户：「小文字提示中的数字会不会随着设置面板中的修改而跟着改变」）
// 把"示范 N 组"这个数字**用同一份数据**同时写进两处提示：设置页人设框下面 + 示范卡片下面。
// ⚠️ 只在**两个地方都拉完之后**才算数：这个函数挂在 exLoad() 末尾（EX 已就绪），
//    所以 EX.length 就是"当前真正生效的组数"。用户增删示范 → 保存 → exLoad() 重跑 → 两处数字一起变。
function refreshExampleHint() {
  // ⚠️ 数据还没到就**不写数字**（写了就会显示成"0 组"，比空着更容易误导）
  if (!EX_LOADED) return;
  var n = EX.length;
  var txt = n
    ? '当前生效的示范：' + n + ' 组（改完要在下面的「语气示范」里保存后这里才更新）。'
    : '当前生效的示范：0 组（增删后要在下面的「语气示范」里保存）。';
  var a = document.getElementById('exHintInSettings');
  if (a) a.textContent = txt;
}

async function exLoad() {
  try {
    var r = await fetch('/api/examples?p=' + encodeURIComponent(P));
    var j = await r.json();
    EX = (j.status && j.status.items) || [];
    EX_LOADED = true;          // ⚠️ 必须在 refreshExampleHint() 之前置位
    exRender();
    // 🔴 2026-10-08（用户：「恢复默认右边那一行小字删掉」）：
    //    原来这里会常驻一句状态小字（按 fromFile 判断"是改过的版本"还是"是代码默认"）——
    //    表格里摆着的就是当前内容，再挂一行状态小字纯属噪音 ⇒ 不再常驻，
    //    只留"保存中 / 已保存 / 报错"这类**瞬时**提示（列表为空时的说明仍在 exRender() 里）。
    //    ⚠️ 那两句旧文案**连注释里都不留原文** —— 交付出去的脚本里带着它，检索/断言就会误判成"还没删"。
    exNote('');
    // ⚠️ 这行必须**在 EX 赋值之后**（否则填进去的是上一轮的数字）
    refreshExampleHint();
  } catch (e) { exNote('读取失败：' + e.message, true); }
}

function exAdd() { EX = exCollect(); EX.push({ u: '', a: '' }); exRender(); }
function exDel(i) { EX = exCollect(); EX.splice(i, 1); exRender(); }

async function exSave() {
  var items = exCollect();
  if (!items.length) { exNote('一組都没有 —— 想清空的话请点「恢复默认」', true); return; }
  exNote('保存中…');
  try {
    var r = await fetch('/api/examples?p=' + encodeURIComponent(P), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items }),
    });
    var j = await r.json();
    if (!j.ok) { exNote(j.why || '保存失败', true); SFX.err(); return; }
    EX = (j.status && j.status.items) || [];
    exRender();
    exNote('✅ 已保存 ' + EX.length + ' 组，立刻生效');
    refreshExampleHint();       // 存完立刻把两处"当前生效 N 组"更新掉
    SFX.ok();
    toast('示范已保存（' + EX.length + ' 组）');
  } catch (e) { exNote('保存失败：' + e.message, true); }
}

async function exReset() {
  if (!confirm('恢复成代码里的默认示范？你改的那些会被删掉。')) return;
  try {
    var r = await fetch('/api/examples/reset?p=' + encodeURIComponent(P), { method: 'POST' });
    var j = await r.json();
    if (!j.ok) { exNote(j.why || '恢复失败', true); return; }
    EX = (j.status && j.status.items) || [];
    exRender();
    exNote('✅ 已恢复默认');
    refreshExampleHint();
  } catch (e) { exNote('恢复失败：' + e.message, true); }
}

// ===== 🆕 2026-10-07 点击音效（用户：「点击交互音效什么的」）=====
// 🔴 用 **Web Audio 现场合成**，**不加载任何音频文件**（保持"零依赖、零静态资源"）：
//    一个很短的正弦/三角波 + 极快衰减，音量压得很低（约 0.03），只是"嗒"一下的确认感。
// ⚠️ 浏览器要求"先有用户手势"才能出声 ⇒ 我们在**第一次点击**时才创建 AudioContext（点击本身就是手势）。
// ⚠️ 开关状态存 localStorage；默认**开**（用户明确要了），但他随时能一键关。
var SFX = (function () {
  var ctx = null, on = true;
  try { on = localStorage.getItem('sfx') !== '0'; } catch (e) { on = true; }
  function ac() {
    if (!ctx) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { ctx = new C(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }
  function blip(freq, dur, type, vol) {
    if (!on) return;
    var a = ac(); if (!a) return;
    try {
      var o = a.createOscillator(), g = a.createGain();
      o.type = type || 'triangle';
      o.frequency.value = freq;
      var t = a.currentTime;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol == null ? 0.035 : vol, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g); g.connect(a.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* 出声失败绝不影响功能 */ }
  }
  return {
    click:  function () { blip(880, 0.055, 'triangle', 0.032); },
    tab:    function () { blip(640, 0.07, 'sine', 0.038); },
    open:   function () { blip(520, 0.09, 'sine', 0.03); },
    ok:     function () { blip(784, 0.09, 'sine', 0.05);
                          setTimeout(function () { blip(1175, 0.13, 'sine', 0.042); }, 72); },
    err:    function () { blip(210, 0.17, 'sawtooth', 0.03); },
    isOn:   function () { return on; },
    set:    function (v) {
      on = !!v;
      try { localStorage.setItem('sfx', on ? '1' : '0'); } catch (e) {}
      var b = document.getElementById('sfxBtn');
      if (b) { b.textContent = on ? '🔊' : '🔇'; b.title = on ? '点击音效：开（点我关掉）' : '点击音效：关（点我打开）'; }
      return on;
    },
  };
})();

// 全局点击音（事件委托，只挂一次）：按钮/标签/折叠标题 各响一种
document.addEventListener('click', function (ev) {
  var t = ev.target;
  if (!t || !t.closest) return;
  if (t.closest('#sfxBtn')) return;                       // 开关自己处理
  if (t.closest('#themeSeg')) return;                     // 主题开关自己处理（它会响 click）
  if (t.closest('#tabs a')) { SFX.tab(); return; }
  if (t.closest('button, a')) { SFX.click(); return; }
}, true);

// 折叠展开/收起时响一声（keyboard 操作也覆盖）
document.addEventListener('toggle', function (ev) {
  if (ev.target && ev.target.tagName === 'DETAILS') SFX.open();
}, true);

// 音效开关按钮（本脚本在 body 末尾，此时按钮已经存在）
(function () {
  var b = document.getElementById('sfxBtn');
  // ⚠️ 防一手：非浏览器环境（自测的 vm 沙箱）里元素桩可能没有 addEventListener ⇒ 不能让它抛错
  if (!b || typeof b.addEventListener !== 'function') return;
  SFX.set(SFX.isOn());
  b.addEventListener('click', function () {
    var now = SFX.set(!SFX.isOn());
    if (now) SFX.click();               // 打开时给一声，让用户听到效果
  });
})();

// ===== 🆕 2026-10-07 用量趋势（用户要的"用量趋势曲线"）=====
// 纯 CSS 柱状图（不引图表库、零依赖）：高度按"这批里的最大值"归一化。
// ⚠️ 只用字符串拼接，**不用模板字符串/反引号**（模板里的反引号会把 PAGE 截断 —— 白屏事故根因）。
var USE_LIMIT = 1600;      // 每日次数上限（**初值只是兜底**，每次 load() 都会用 /api/state 的生效值刷新）
var USE_DAILY = 3;         // 每日金额上限（同上）
var lastUsageDays = 14;    // 用户当前选的趋势区间（额度刷新时按原区间重画）

// 🔴 2026-10-07（用户：「这 1600 不会跟着改」）：把"生效值"灌进来 ——
//    柱状图的黄/红阈值、以及那段说明文字里的数字，**都必须跟着设置页走**。
function applyLimits(b) {
  if (!b) return;
  var lim = Number(b.dailyCallLimit);
  if (lim > 0) USE_LIMIT = lim;
  var day = Number(b.dailyLimit || b.dailyLimitYuan);      // 金额上限（/api/state 里叫 dailyLimit）
  if (day > 0) USE_DAILY = day;
  var a = document.getElementById('useLimitTxt');
  if (a) a.textContent = USE_LIMIT + ' 次';
  // 🆕 2026-10-08：颜色说明里也要用生效值（黄=80%、红=撞满），否则写死又会"不跟着改"
  var a2 = document.getElementById('useLimitTxt2');
  if (a2) a2.textContent = USE_LIMIT + ' 次';
  var a3 = document.getElementById('useLimitTxt3');
  if (a3) a3.textContent = USE_LIMIT + ' 次';
  var c = document.getElementById('useDailyTxt');
  if (c) c.textContent = '¥' + USE_DAILY;
}

function renderUsage(days) {
  var el = document.getElementById('useChart');
  if (!el) return;
  if (!days || !days.length) { el.innerHTML = '<p class="hint">还没有数据（机器人每 10 分钟记一笔）</p>'; return; }
  // 🔴 2026-10-08 用户拍板（原话）：「**顶不顶格无所谓，只要所有柱子按比例长度就可以了，
  //    要确保有新的最大值进入表格时不会被卡片固定高度挡住**」
  //    ⇒ 归一化基准 = **本批最大值**（不是日上限）。理由：
  //      · 按日上限（3000）算的话，实际只有 800~1300 ⇒ 柱子全被压成 27~43%，看着又矮又分不出差别；
  //      · 按本批最大值算 ⇒ 最高那根满格，其余**严格等比**，高低一眼可比。
  //    ⚠️ 这样图就只回答"哪天多哪天少"，**不再回答"离上限还有多远"**（那是"日额度 ¥3"那行的活）。
  //    ⚠️ "新最大值进表格被挡住"这个担心由**结构**兜住，不靠算：
  //       柱高是相对**固定高度绘图区 .uplot** 的百分比，最大值恒为 100%，且绘图区 overflow:hidden
  //       ⇒ 数学上不可能溢出卡片。（theme-audit 里有一条断言专门锁这件事，见"柱高不超绘图区"。）
  var dataMax = 1;
  for (var i = 0; i < days.length; i++) { var c = Number(days[i].calls) || 0; if (c > dataMax) dataMax = c; }
  var today = days[days.length - 1].date;
  var bars = days.map(function (d) {
    var calls = Number(d.calls) || 0;
    var pct = (calls / dataMax) * 100;                  // 严格按比例；保留小数，避免取整把比例弄歪
    var cls = (calls >= USE_LIMIT) ? 'over' : (calls >= USE_LIMIT * 0.8 ? 'hot' : '');
    var isToday = (d.date === today) ? ' today' : '';
    return '<div class="ubar' + isToday + '" title="' + d.date + '：' + calls + ' 次 · ¥' + Number(d.spent).toFixed(2) + '">' +
      '<u>' + (calls || '') + '</u>' +
      '<div class="uplot"><i class="' + cls + '" style="height:' + pct + '%"></i></div>' +
      '<span>' + d.md + '</span>' +
      '</div>';
  }).join('');
  el.innerHTML = '<div class="ubars">' + bars + '</div>';
}

async function loadUsage(n) {
  lastUsageDays = Number(n) || lastUsageDays || 14;      // 记住用户选的区间（额度刷新时原样重画）
  try {
    var r = await fetch('/api/usage?days=' + lastUsageDays + '&p=' + encodeURIComponent(P));
    var j = await r.json();
    renderUsage(j.days || []);
    var sum = 0, sumSpent = 0;
    (j.days || []).forEach(function (d) { sum += d.calls; sumSpent += d.spent; });
    var note = document.getElementById('useNote');
    if (note) note.textContent = '这 ' + (j.days || []).length + ' 天：' + sum + ' 次调用 · ¥' + sumSpent.toFixed(2);
  } catch (e) {
    var el = document.getElementById('useChart');
    if (el) el.innerHTML = '<p class="hint">读取失败：' + esc(e.message) + '</p>';
  }
}

// ===== 🆕 2026-10-07 人设预设（用户要的「存成预设卡片，点卡片切换」）=====
// ⚠️ 只用字符串拼接，不用模板字符串/反引号（模板里的反引号会把 PAGE 截断）
async function psApi(payload) {
  const opt = payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {};
  const r = await fetch('/api/presets?p=' + encodeURIComponent(P), opt);
  return await r.json();
}

function renderPresets(j) {
  const el = document.getElementById('psList');
  if (!el) return;
  const items = (j && j.items) || [];
  if (!items.length) {
    el.innerHTML = '<p class="hint">还没有预设。点上面的按钮，把<b>现在这套性格</b>存成第一张卡片。</p>';
    return;
  }
  el.innerHTML = '<div class="psgrid">' + items.map(function (it) {
    const on = it.active ? ' on' : '';
    const tag = it.active ? '<span class="ptag">● 正在使用</span>' : '<span class="pmeta">点一下切到它</span>';
    // 🔴 空人设 = "用代码里的默认人设" ⇒ 显示「用默认（646 字）」，别显示成"0 字"
    //    （用户看到"人设 0 字"直接问「为什么人设 0 字」—— 那是我的显示没讲清楚）
    const pTxt = it.usesDefault
      ? '人设 <b>用默认</b>（' + it.personaEffectiveChars + ' 字）'
      : '人设 <b>' + it.personaChars + ' 字</b>';
    return '<div class="pcard2' + on + '" data-ps="' + esc(it.id) + '" data-psname="' + esc(it.name) + '">' +
      '<b>' + esc(it.name) + '</b>' +
      '<div class="pmeta">' + pTxt + ' · 示范 ' + it.exampleCount + ' 组<br>' +
        esc(it.preview || '（空）') + '…</div>' +
      '<div class="prow">' + tag +
        '<span style="flex:1"></span>' +
        '<button class="sm" data-psrename="' + esc(it.id) + '" type="button">改名</button>' +
        '<button class="sm danger" data-psdel="' + esc(it.id) + '" type="button">删</button>' +
      '</div></div>';
  }).join('') + '</div>';
}

async function psLoad() {
  try {
    renderPresets(await psApi(null));
  } catch (e) {
    const el = document.getElementById('psList');
    if (el) el.innerHTML = '<p class="hint">读取失败：' + esc(e.message) + '</p>';
  }
}

async function psCapture() {
  const inp = document.getElementById('psName');
  const name = inp ? inp.value.trim() : '';
  try {
    const j = await psApi({ action: 'capture', name: name });
    if (!j.ok) { showErr(j.why || '存失败'); return; }
    if (inp) inp.value = '';
    showErr('');
    renderPresets(j.status);
  } catch (e) { showErr('存失败：' + e.message); }
}

async function psActivate(id) {
  try {
    const j = await psApi({ action: 'activate', id: id });
    if (!j.ok) { showErr(j.why || '切换失败'); return; }
    showErr('');
    renderPresets(j.status);
    // 🔴 2026-10-07 修（用户：「这里还是13条，不匹配」）：
    //   切换预设会同时改**人设**和**示范**，但原来只刷设置区（人设/额度/对话），
    //   **没刷语气示范表** ⇒ 表格停在旧内容（他看到的"13 条"就是这么来的 —— 文件其实是 14 条）。
    //   ⇒ 三个都要刷：设置区（含人设框）+ 示范表 + 预设卡片。
    try { load(); } catch (e) { /* 忽略 */ }
    try { exLoad(); } catch (e) { /* 忽略 */ }
  } catch (e) { showErr('切换失败：' + e.message); }
}

async function psRename(id, old) {
  const n = prompt('预设名字：', old || '');
  if (n === null) return;
  try {
    const j = await psApi({ action: 'rename', id: id, name: n });
    if (!j.ok) { showErr(j.why || '改名失败'); return; }
    showErr('');
    renderPresets(j.status);
  } catch (e) { /* 忽略 */ }
}

async function psRemove(id) {
  try {
    const j = await psApi({ action: 'remove', id: id });
    if (!j.ok) { showErr(j.why || '删除失败'); return; }
    showErr('');
    renderPresets(j.status);
  } catch (e) { /* 忽略 */ }
}

// 预设卡片的点击：点卡片 = 切换；点"改名/删" = 不切换（事件委托）
document.addEventListener('click', function (ev) {
  var t = ev.target;
  if (!t || !t.closest) return;
  var del = t.closest('[data-psdel]');
  if (del) {
    ev.stopPropagation();
    if (confirm('删掉这个预设？（不影响当前正在用的人设）')) psRemove(del.getAttribute('data-psdel'));
    return;
  }
  var rn = t.closest('[data-psrename]');
  if (rn) {
    ev.stopPropagation();
    var card = rn.closest('.pcard2');
    psRename(rn.getAttribute('data-psrename'), card ? card.getAttribute('data-psname') : '');
    return;
  }
  var c = t.closest('[data-ps]');
  if (c && !c.classList.contains('on')) psActivate(c.getAttribute('data-ps'));
});

function initPages(){
  document.body.setAttribute("data-page", CUR);
  var tabs = document.querySelectorAll("#tabs a");
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    // 🔴 每个标签的链接要在**运行时**拼（密码要 encodeURIComponent 一次）
    //    之前写成字面文本 '?p=" + encodeURIComponent(P) + "' ⇒ 点不动、还被当非法页码
    t.setAttribute("href", "?p=" + encodeURIComponent(P) + "&page=" + t.getAttribute("data-tab"));
    if (t.getAttribute("data-tab") === CUR) t.className = "on";
  }
  // 🔴 2026-10-08：原来这里给 #fnote 写"设置页/对话页/日志页"的行内说明，但 #fnote 挂在概览页容器里
  //    ⇒ 那几句在任何页面上都不会显示（死代码）。随刷新按钮一起删掉。
  //    📌 其中「对话页稍后会加搜索框」是个**待办**（不是已完成功能），已挪进记忆里记着。
}

// 🆕 2026-10-07：**显式调用**（原来写成 (function initPages(){ … })()
// ⇒ 只要有人拿 function initPages(){ 当锚点插代码，就会被那个前导的 ( 包进括号里 ⇒ 语法错。
//   这个坑今天踩了三次（黑屏、白屏之外的那两次"Unexpected token var"），所以直接拆掉这层壳。）
initPages();

// ===== 🆕 2026-10-08 主题开关的初始化（放在最后：此时所有函数都已定义）=====
// ⚠️ 前面顶栏那段只挂了"点击委托"；这里再 paint 一次是为了保证 aria-pressed 也同步上，
//    而且顺序无所谓（paintTheme 只读 DOM 和 localStorage，不依赖任何接口数据）。
try { paintTheme(); } catch (e) {}
</script>
</body></html>`;

module.exports = { PAGE };
