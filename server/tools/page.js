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
// ============================================================
const PAGE = (opts) => `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1220">
<title>🐋 大肥鱼 · 控制台</title>
<!-- BUILD:__BUILD__ -->
<style>
  :root { color-scheme: dark; --bg:#0b1220; --card:#111a2e; --line:#1f2b45;
          --dim:#8ea0bb; --txt:#e6edf7; --ok:#10b981; --bad:#ef4444; --warn:#f59e0b; --link:#60a5fa; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; background:var(--bg); color:var(--txt);
         font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:16px; margin:0; font-weight:700; letter-spacing:.02em; }
  h2 { font-size:15px; color:#eaf1ff; margin:0 0 10px; font-weight:700; letter-spacing:.02em;
       display:flex; align-items:center; gap:8px; }
  h2::before { content:''; width:4px; height:16px; border-radius:2px;
       background:linear-gradient(180deg,#60a5fa,#2563eb); }
  header { position:sticky; top:0; z-index:20; background:rgba(11,18,32,.92); backdrop-filter:blur(8px);
           border-bottom:1px solid var(--line); padding:10px 14px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  main { padding:14px 12px 76px; max-width:900px; margin:0 auto; }
  section { margin-bottom:18px; }
  .pill { font-size:11px; padding:3px 9px; border-radius:999px; background:var(--card); color:var(--dim); border:1px solid var(--line); }
  .pill.on { background:rgba(16,185,129,.16); color:#6ee7b7; border-color:rgba(16,185,129,.4); }
  .pill.off { background:rgba(239,68,68,.16); color:#fca5a5; border-color:rgba(239,68,68,.4); }
  .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  @media (min-width:620px) { .grid { grid-template-columns:repeat(4,minmax(0,1fr)); } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px; }
  .card b { color:#fff; font-size:18px; display:block; font-variant-numeric:tabular-nums; }
  .card span { color:var(--dim); font-size:11px; }
  .warn { color:var(--warn); }
  #errbar { display:none; background:#7c2d12; color:#fed7aa; padding:10px 14px;
            font-size:12.5px; word-break:break-all; }
  #offbar { display:none; background:linear-gradient(90deg,#7f1d1d,#991b1b); color:#fff;
            padding:10px 14px; font-size:13px; position:sticky; top:0; z-index:19; }

  /* 🆕 一个群 = 一张卡（可收起/展开，跟"原始日志"一个交互） */
  .gcard { background:var(--card); border:1px solid var(--line); border-radius:12px;
           margin-bottom:12px; overflow:hidden; }
  .gcard > summary { padding:10px 12px; background:#0e1729; cursor:pointer;
           display:flex; gap:8px; align-items:center; flex-wrap:wrap; list-style:none; }
  .gcard > summary::-webkit-details-marker { display:none; }
  .gcard > summary::before { content:'▸'; color:#93c5fd; font-size:17px; font-weight:700;
       width:22px; text-align:center; flex:0 0 auto; transition:transform .15s; }
  .gcard[open] > summary::before { transform:rotate(90deg); }
  .gtitle { font-weight:700; color:#c7d2fe; font-size:14.5px; }
  .gid { color:var(--dim); font-size:11px; word-break:break-all; }
  .cnt { color:var(--dim); font-size:11px; margin-left:auto; }
  .gedit { display:flex; gap:6px; flex-wrap:wrap; padding:8px 12px; background:#0e1729;
           border-bottom:1px solid var(--line); }
  .gedit input { flex:1; min-width:120px; }
  .gcode { padding:0 12px 8px; color:var(--dim); font-size:10.5px; word-break:break-all;
           font-family:ui-monospace,Menlo,Consolas,monospace; }
  .msgs { padding:4px 12px 10px; }
  .msg { padding:8px 0; border-bottom:1px dashed var(--line); }
  .msg:last-child { border-bottom:0; }
  .mtop { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .who { font-weight:700; color:#fbbf24; }
  .tm { color:var(--dim); font-size:11px; margin-left:auto; font-variant-numeric:tabular-nums; }
  .txt { color:var(--txt); word-break:break-word; }
  .tag { display:inline-block; font-size:11px; padding:1px 7px; border-radius:6px;
         background:#1e293b; color:var(--dim); margin-right:6px; }
  .tag.no { background:rgba(148,163,184,.15); }
  .tag.yes { background:rgba(16,185,129,.18); color:#6ee7b7; }
  .dec { margin-top:3px; color:var(--dim); font-size:12.5px; }
  .ans { background:#0d1729; border-left:3px solid var(--ok); padding:7px 10px;
         border-radius:0 8px 8px 0; margin:6px 0 2px; color:#d1fae5; }
  input[type=text], input[type=number], input[type=password] { font:inherit; color:var(--txt);
         background:#0d1729; border:1px solid var(--line); border-radius:8px; padding:7px 9px; min-width:0; }
  input:focus { outline:1px solid var(--link); }
  button { font:inherit; color:var(--txt); background:#1e293b; border:1px solid #334155;
           border-radius:9px; padding:8px 12px; cursor:pointer; }
  button:active { transform:translateY(1px); }
  button.primary { background:#1d4ed8; border-color:#2563eb; }
  button.danger { background:#7f1d1d; border-color:#b91c1c; }
  button.sm { padding:6px 9px; font-size:12px; }
  details { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px 12px; }
  summary { cursor:pointer; font-weight:700; color:var(--dim); font-size:13px; }
  .frow { display:flex; gap:8px; align-items:center; margin:8px 0; flex-wrap:wrap; }
  .frow label { width:150px; color:var(--dim); font-size:12px; }
  .frow input { flex:1; min-width:120px; }
  /* 2026-10-06 用户反馈：人设框「这么小这么多字这么看」+「输入框风格跟 ui 不配」
     ⇒ 长文本行改成"标签在上、控件铺满"，高度给足，颜色/圆角/边框与其它控件一致 */
  .frow.tall { display:block; }
  .frow.tall label { display:block; width:auto; margin-bottom:6px; }
  .frow.tall textarea { width:100%; box-sizing:border-box; min-height:380px; line-height:1.75; }
  .frow.tall button { margin-top:8px; }
  .hint { color:var(--dim); font-size:11px; margin:4px 0 0; }
  pre { margin:0; padding:10px; background:#080e1a; border:1px solid var(--line); border-radius:10px;
        overflow:auto; max-height:340px; font-size:11.5px; line-height:1.55; color:#9fb3d1; }
  /* 🆕 2026-10-06 用户：原始日志既然已经放到单独界面了，那展示框可以加长啊
     ⇒ 日志页的 pre 去掉 340px 上限（由行内 style 覆盖 + 这里给个高下限） */
  body[data-page="raw"] pre#log { max-height:none; min-height:65vh; }
  .toolbar { display:flex; gap:8px; align-items:center; margin:2px 0 12px; }
  /* 🆕 语气示范表格（2026-10-06） */
  .exrow { display:grid; grid-template-columns:1fr 1fr 104px 40px; gap:8px; align-items:center; margin:6px 0; }
  .exrow input, .exrow select { width:100%; box-sizing:border-box; }
  .exbar { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  @media (max-width:640px) { .exrow { grid-template-columns:1fr 40px; } .exrow select { grid-column:1; } }
  nav#tabs { position:fixed; left:0; right:0; bottom:0; z-index:30;
    display:flex; background:rgba(11,18,32,.97); backdrop-filter:blur(8px);
    border-top:1px solid var(--line); max-width:900px; margin:0 auto; }
  nav#tabs a { flex:1; text-align:center; padding:9px 4px 10px; text-decoration:none;
    color:var(--dim); font-size:12.5px; }
  nav#tabs a.on { color:#bfdbfe; background:#152039; font-weight:700; }
  main { padding-bottom:86px !important; }
  /* 🔴 只对 main 里的区块生效 —— **千万别写成通配的 [data-page]{display:none}**：
     body 自身也带 data-page（当前页标记），通配规则会把整个 body 藏掉 ⇒ 整页黑屏（踩过）。 */
  main > [data-page] { display:none; }
  body[data-page="overview"] main > [data-page="overview"],
  body[data-page="chat"] main > [data-page="chat"],
  body[data-page="settings"] main > [data-page="settings"],
  body[data-page="raw"] main > [data-page="raw"] { display:block; }
  footer { position:fixed; left:0; right:0; bottom:0; background:rgba(11,18,32,.95);
           backdrop-filter:blur(8px); border-top:1px solid var(--line); padding:9px 12px;
           display:flex; gap:8px; max-width:900px; margin:0 auto; }
  footer .sp { flex:1; }
  #toast { position:fixed; left:50%; bottom:74px; transform:translateX(-50%); background:#111a2e;
           border:1px solid var(--line); color:var(--txt); padding:9px 14px; border-radius:999px;
           font-size:12.5px; display:none; z-index:50; max-width:92vw; }
  /* ============================================================
     2026-10-07 视觉升级（用户：「这个界面整体看着太老套了，能不能做高级一点，
     点击交互音效什么的，还有展开收拢动画之类的」）
     ⚠️ 这一层是"皮肤"：只覆盖观感与动效，**不改任何结构与逻辑**（类名/ DOM 都不动）。
     ============================================================ */
  :root { --r-lg:16px; --r-md:12px; --r-sm:10px;
          --acc1:#60a5fa; --acc2:#818cf8;
          --sh-1:0 1px 2px rgba(0,0,0,.35);
          --sh-2:0 12px 32px -18px rgba(0,0,0,.85); }
  body { background:
      radial-gradient(1200px 620px at 12% -12%, rgba(37,99,235,.20), transparent 62%),
      radial-gradient(900px 520px at 100% 0%, rgba(129,140,248,.15), transparent 58%),
      var(--bg);
    background-attachment:fixed; }
  header { box-shadow:0 10px 30px -22px #000; }
  h1 { font-size:17px; letter-spacing:.03em;
       background:linear-gradient(92deg,#e0ecff,#a5b4fc); -webkit-background-clip:text;
       background-clip:text; color:transparent; }
  .card, details, .gcard { border-radius:var(--r-lg); box-shadow:var(--sh-2); }
  .card { transition:transform .18s cubic-bezier(.2,.7,.2,1), border-color .18s ease, box-shadow .18s ease; }
  .card:hover { transform:translateY(-2px); border-color:#2b3d61; }
  .card b { font-size:20px; letter-spacing:.01em; }
  /* 展开/收拢：图标旋转 + 内容渐入（关闭用原生瞬时，避免测量高度） */
  details > summary, .gcard > summary { list-style:none; transition:color .15s ease; }
  details > summary:hover, .gcard > summary:hover { color:#cfe0ff; }
  details > summary::before { content:'▸'; color:#93c5fd; font-weight:700;
    display:inline-block; width:14px; transition:transform .22s cubic-bezier(.2,.7,.2,1); }
  details[open] > summary::before { transform:rotate(90deg); }
  details > summary::-webkit-details-marker { display:none; }
  details[open] > *:not(summary), .gcard[open] > *:not(summary) {
    animation:reveal .26s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes reveal { from { opacity:0; transform:translateY(-7px); } to { opacity:1; transform:none; } }
  /* 按钮微交互 */
  button { border-radius:var(--r-sm); box-shadow:var(--sh-1);
    transition:transform .12s ease, filter .16s ease, box-shadow .16s ease, background .16s ease, border-color .16s ease; }
  button:hover { filter:brightness(1.13); }
  button:active { transform:translateY(1px) scale(.985); }
  button.primary { background:linear-gradient(180deg,#2563eb,#1d4ed8); border-color:#3b82f6;
    box-shadow:0 8px 22px -12px #2563eb; }
  button.danger { background:linear-gradient(180deg,#b91c1c,#7f1d1d); border-color:#dc2626; }
  /* 输入控件聚焦光环 */
  input, textarea, select { transition:border-color .15s ease, box-shadow .15s ease; }
  input:focus, textarea:focus, select:focus { outline:none; border-color:#3b82f6;
    box-shadow:0 0 0 3px rgba(59,130,246,.18); }
  /* 底部标签栏：活动态光条 */
  nav#tabs { border-top:1px solid rgba(255,255,255,.07); box-shadow:0 -14px 34px -22px #000; }
  nav#tabs a { position:relative; transition:color .15s ease; }
  nav#tabs a:hover { color:#cfe0ff; }
  nav#tabs a.on { background:transparent; color:#dbeafe; }
  nav#tabs a.on::after { content:''; position:absolute; left:16%; right:16%; top:0; height:2px;
    border-radius:2px; background:linear-gradient(90deg,transparent,var(--acc1),transparent);
    box-shadow:0 0 14px rgba(96,165,250,.75); }
  /* 切换页面：入场动画 */
  main { animation:pageIn .28s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes pageIn { from { opacity:0; transform:translateY(7px); } to { opacity:1; transform:none; } }
  /* 提示条滑入 */
  #toast { animation:toastIn .22s ease both; }
  @keyframes toastIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
  #upd, #build, .card b { font-variant-numeric:tabular-nums; }
  /* 滚动条 */
  *::-webkit-scrollbar { width:10px; height:10px; }
  *::-webkit-scrollbar-thumb { background:#243352; border-radius:9px;
    border:2px solid transparent; background-clip:content-box; }
  *::-webkit-scrollbar-thumb:hover { background:#33486f; background-clip:content-box; }
  /* ♿ 尊重"减少动效"系统设置 */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration:.001ms !important; transition-duration:.001ms !important; }
  }
  /* ============================================================
     2026-10-07（用户：「这个框不好看」）—— 把"原生输入框味"收拾掉：
     大文本框/下拉框改成和圆角卡片同一套观感（柔和底色 + 内高光 + 聚焦光环 + 更贴合的圆角），
     并去掉浏览器那个生硬的右下角拉伸柄。
     ============================================================ */
  textarea, input[type=text], input[type=number], input[type=password], select {
    background:linear-gradient(180deg, #101c33, #0d1729);
    border:1px solid #26365a; border-radius:12px; padding:10px 12px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.03);
  }
  textarea { padding:14px; font-size:13.5px; line-height:1.85; letter-spacing:.01em;
             resize:vertical; min-height:360px; }
  textarea:hover, input:hover, select:hover { border-color:#33456e; }
  textarea:focus, input:focus, select:focus {
    border-color:#4b7bd6; box-shadow:inset 0 1px 0 rgba(255,255,255,.04), 0 0 0 3px rgba(59,130,246,.16); }
  /* 去掉 Chrome/Safari 自带的拉伸柄（那个小三角最显廉价） */
  textarea::-webkit-resizer { background:transparent; }
  select { appearance:none; -webkit-appearance:none; padding-right:30px;
    background-image:linear-gradient(45deg,transparent 50%,#8ea0bb 50%),
                     linear-gradient(135deg,#8ea0bb 50%,transparent 50%);
    background-position:calc(100% - 16px) 50%, calc(100% - 11px) 50%;
    background-size:5px 5px, 5px 5px; background-repeat:no-repeat; }
  /* 🔴 2026-10-07（用户：「文字背景同色」）：下拉**展开后的选项列表**是浏览器/系统自己画的，
     不受 select 自身 background 的影响 ⇒ **必须显式给 option 上色**，
     否则就会出现「浅色弹层 + 我们的浅色文字 = 看不见」。
     （只在 :root 上写 color-scheme:dark 不够 —— 部分平台的弹层不吃它，所以必须显式给 option 上色。） */
  select { color:var(--txt); }
  select option, select optgroup { background-color:#0d1729; color:#e6edf7; }
  select option:checked, select option:checked:hover { background-color:#1d4ed8; color:#fff; }
  /* 示范表格：删除按钮改成"幽灵按钮"，别每行一块大红 */
  .exrow button.danger { background:transparent; border-color:rgba(239,68,68,.45); color:#fca5a5;
    box-shadow:none; }
  .exrow button.danger:hover { background:rgba(239,68,68,.14); filter:none; }
</style></head>
<body>
<header>
  <h1>🐋 大肥鱼</h1>
  <span id="svc" class="pill">…</span>
  <span id="build" class="pill" style="background:#1e3a8a;color:#bfdbfe">v?</span>
  <span id="upd" class="pill">…</span>
  <!-- 🆕 2026-10-07 音效开关（用户要点击音效；默认开，选择记在 localStorage） -->
  <button id="sfxBtn" class="sm" title="点击音效开关" style="margin-left:auto">🔊</button>
</header>
<div id="offbar"></div>
<div id="errbar"></div>
<main>
  <div class="toolbar" data-page="overview">
    <button onclick="load(true)">刷新</button>
    <button id="autoBtn" onclick="toggleAuto()">自动刷新 5s</button>
    <span id="fnote" class="hint" style="margin:0"></span>
  </div>
  <section data-page="overview">
    <h2>额度与用量</h2>
    <div class="grid" id="budget"></div>
  </section>

  <section data-page="overview">
    <h2>开关机</h2>
    <div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <b id="pwstate" style="font-size:15px">…</b>
      <span id="pwby" style="color:var(--dim);font-size:12px"></span>
      <span style="flex:1"></span>
      <button class="primary sm" onclick="setPower(true)">开机</button>
      <button class="danger sm" onclick="setPower(false)">关机</button>
    </div>
    <p class="hint">关机后：不回话、不解析链接、不识别图片（一分钱不花）。改完几秒内生效，不用重启。</p>
  </section>

  <details data-page="settings">
    <summary>⚙️ 参数设置（点开修改）</summary>
    <div id="settings"></div>
    <div class="frow" style="margin-top:10px">
      <button onclick="restartBot()">重启机器人</button>
      <span class="hint" style="margin:0">（每个参数改完点它自己的「保存」）</span>
    </div>
    <p class="hint">额度/次数上限：保存后立即生效。<b>AI 密钥</b>：保存后需要点一次「重启机器人」才生效。密钥不会回显，只显示前后几位。</p>
  </details>

  <!-- 🆕 2026-10-06 用户要的「示范显化 / 可编辑」：
       鱼的语气主要由这些示范决定（比人设文字影响更大）⇒ 做成面板可改。
       2026-10-06 晚（用户）：「给示范卡片加收展功能，默认收，也就是跟其他卡片一样」
       ⇒ 从 <section>+<h2> 改成 <details>+<summary>（和「参数设置」同款），**默认收起**（不加 open）。 -->
  <details data-page="settings">
    <summary>🐟 语气示范（教它怎么说话，点开修改）</summary>
    <p class="hint">左边是「群友说」，右边是「鱼回」。<b>决定鱼语气的其实就是这些</b>（比人设那段文字影响更大）。</p>
    <div id="exList"></div>
    <div class="exbar">
      <button class="sm" onclick="exAdd()">+ 加一组</button>
      <button class="sm primary" onclick="exSave()">保存全部</button>
      <button class="sm" onclick="exReset()">恢复默认</button>
      <span id="exNote" class="hint" style="margin:0"></span>
    </div>
    <p class="hint">⚠️ 保存后会**立刻生效**（不用重启）。但示范属于 prompt 前缀 ⇒ **每改一次，模型缓存失效一次**（贵一点）。
      建议：改完先去上面「🧪 试聊」试两句，满意就别再来回改。</p>
  </details>

  <section data-page="settings">
    <h2>🧪 试聊（只给看，不发群）</h2>
    <div class="card">
      <div class="sbrow">
        <input type="text" id="sbText" placeholder="输入一句要试的话（前面加 @ 就当被 @ 了）" maxlength="500"
               onkeydown="if(event.key==='Enter'){sandboxSend();}">
        <button class="primary" onclick="sandboxSend()">试一句</button>
      </div>
      <p class="hint">走的是**和线上同一套**人设与判据；⚠️ 是**真实模型调用**（会计入账本），但**不会发到任何群**，也不占机器人的冷却/上下文。</p>
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
    <summary>🔍 原始日志（排查用，平时不用看）</summary>
    <div style="margin-top:8px"><pre id="log" style="max-height:none;min-height:65vh">加载中…</pre></div>
  </details>
</main>
<nav id="tabs">
  <a href="#" data-tab="overview">📊 概览</a>
  <a href="#" data-tab="chat">💬 对话</a>
  <a href="#" data-tab="settings">⚙️ 设置</a>
  <a href="#" data-tab="raw">🔍 日志</a>
</nav>
<!-- 🔴 2026-10-06：原来的固定 footer 被底部标签栏压住了（两条 fixed 抢同一条底边）。
       用户说「这俩按键不能扔到页面里面去吗，卡位置了」⇒ 挪进"概览"页顶部，底部只留标签栏。 -->
<div id="toast"></div>
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
let auto = null;

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

async function load(manual){
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
    document.getElementById('pwstate').className = pw.on ? '' : 'warn';

    // 每一步单独兜底 —— 某一块出错不该让整页变成空白（之前就是这样，还只弹了个会消失的提示）
    try { renderBudget(j.budget); } catch (e) { setErr('额度渲染失败：' + e.message); }
    try { renderSettings(j.settings); } catch (e) { setErr('设置渲染失败：' + e.message); }
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
      '<button class="sm" data-save="' + k + '">保存</button></div>';
  }).join('');
  el.innerHTML = rows + (s.aiApiKey ? '<p class="hint">当前密钥：' + esc(s.aiApiKey.value || '（未设置）') + '</p>' : '')
    // 🆕 2026-10-06 用户问：人设不是还有 14 组示例吗？⇒ 说清这个框管到哪、以及示例仍在生效
    + '<p class="hint">人设 = <b>上面这个大框（system 人设）</b> + <b>14 组示范（examples，写在代码里、<u>仍然生效</u>，这个框改不到它）</b>。'
    + '清空保存 = 回到默认人设。</p>';
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
    box.style.color = n > 1400 ? '#fca5a5' : '';
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

load(true);
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
  load(true);
}

async function restartBot(){
  if (!confirm('现在重启机器人？大约 5 秒内恢复，期间不回复消息。')) return;
  toast('正在重启…');
  const r = await fetch('/api/restart?p=' + encodeURIComponent(P), { method:'POST' });
  const j = await r.json();
  toast(j.ok ? '✅ 已发出重启' : ('❌ ' + (j.why||'重启失败')));
  setTimeout(()=>load(true), 4000);
}

async function setPower(on){
  const r = await fetch('/api/power?p=' + encodeURIComponent(P), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({on}),
  });
  const j = await r.json();
  if (j.ok) SFX.ok(); else SFX.err();
  toast(j.ok ? ('✅ 已' + (on?'开机':'关机') + '（几秒内生效）') : ('❌ ' + (j.why||'失败')));
  setTimeout(()=>load(true), 2500);
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
        '<button class="sm" onclick="saveGroup(' + gi + ')">保存</button>' +
      '</div>' +
      (isPriv ? '' : '<div class="gcode">群内码 ' + esc(g.realId || '（认不出）') + '</div>');

    // 🔴 卡内排序（2026-10-06 用户要求反过来）：
    //    原话「**卡片内消息排序方式从上到下是从早到晚，但是这样每次刷新消息都会出现在卡片最下面了，
    //    要去翻，不合理，排序反一下**」⇒ 现在**最新在上**（后端已按此顺序给，直接用不 reverse）。
    //    ⚠️ 每会话 60 条的上限已在**后端按真实群号裁好**，这里不再截断（避免"上面写 60、实际 40"）。
    const msgs = g.msgs.map((c) => {
      const q = '<div class="mtop"><span class="who">' + esc(c.who) + '</span>' +
        '<span class="tm">' + esc(c.time || '') + '</span></div>' +
        '<div class="txt">' + (esc(c.text) || '<span style="color:var(--dim)">（非文字消息）</span>') + '</div>';
      let dec = '';
      if (c.decision) {
        const isNo = /^不回/.test(c.decision);
        dec = '<div class="dec"><span class="tag ' + (isNo?'no':'yes') + '">' + (isNo?'没回':'回了') + '</span>' + esc(c.decision) + '</div>';
      } else if (!(c.replies && c.replies.length)) {
        dec = '<div class="dec"><span class="tag no">没回</span>（没触发回复条件）</div>';
      }
      const ans = (c.replies && c.replies.length)
        ? c.replies.map(t => '<div class="ans">' + esc(t) + '</div>').join('') : '';
      return '<div class="msg">' + q + dec + ans + '</div>';
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
  if (j.ok) load(true);
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

function toggleAuto(){
  if (auto) { clearInterval(auto); auto = null; document.getElementById('autoBtn').textContent = '自动刷新 5s'; }
  else { auto = setInterval(()=>load(false), 5000); document.getElementById('autoBtn').textContent = '停止自动刷新'; }
}
try { load(true); } catch (e) {
  var _e2 = document.getElementById('errbar');
  if (_e2) { _e2.style.display = 'block'; _e2.textContent = '⚠️ 启动失败：' + e.message; }
}
// 🆕 语气示范表格：进页面就把当前生效的那份读出来（没配过则显示"用的是默认"）
try { exLoad(); } catch (e) { /* 读不到不影响别的 */ }
// 🔴 分页面（2026-10-06 用户要求「做几个分页面，别全挤在一起」）：
//    同一份 HTML 里给每个区块打了 data-page，这里按 body[data-page] 显隐 + 高亮标签栏。
//    ⚠️ 用 CSS 显隐而不是"多套模板" —— 保证**只有一份模板**（避免又踩"两份拷贝"的坑）。
// ===== 🆕 2026-10-06 语气示范（examples）面板编辑 =====
// 说明：示范决定鱼的语气；存到 data/examples.json，改完即时生效（但会让模型缓存失效一次）。
// ⚠️ 本段**不用模板字符串、不用反引号**（模板里的反引号会把整个 PAGE 截断 —— 白屏事故的根因）。
var EX = [];
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
    '<button class="sm danger" onclick="exDel(' + i + ')">删</button>' +
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
  if (n) { n.textContent = t || ''; n.style.color = warn ? '#fca5a5' : ''; }
}

async function exLoad() {
  try {
    var r = await fetch('/api/examples?p=' + encodeURIComponent(P));
    var j = await r.json();
    EX = (j.status && j.status.items) || [];
    exRender();
    exNote(j.status && j.status.fromFile ? '（当前用的是你改过的版本）' : '（当前是代码里的默认）');
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
  if (t.closest('nav#tabs a')) { SFX.tab(); return; }
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

(function initPages(){
  document.body.setAttribute("data-page", CUR);
  var tabs = document.querySelectorAll("#tabs a");
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    // 🔴 每个标签的链接要在**运行时**拼（密码要 encodeURIComponent 一次）
    //    之前写成字面文本 '?p=" + encodeURIComponent(P) + "' ⇒ 点不动、还被当非法页码
    t.setAttribute("href", "?p=" + encodeURIComponent(P) + "&page=" + t.getAttribute("data-tab"));
    if (t.getAttribute("data-tab") === CUR) t.className = "on";
  }
  var note = document.getElementById("fnote");
  if (note) {
    note.textContent = CUR === "chat" ? "（对话页稍后会加搜索框）"
      : CUR === "settings" ? "改完点它自己的「保存」"
      : CUR === "raw" ? "技术日志，排查时才看" : "";
  }
})();
</script>
</body></html>`;

module.exports = { PAGE };
