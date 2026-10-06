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
  .hint { color:var(--dim); font-size:11px; margin:4px 0 0; }
  pre { margin:0; padding:10px; background:#080e1a; border:1px solid var(--line); border-radius:10px;
        overflow:auto; max-height:340px; font-size:11.5px; line-height:1.55; color:#9fb3d1; }
  nav#tabs { position:fixed; left:0; right:0; bottom:0; z-index:30;
    display:flex; background:rgba(11,18,32,.97); backdrop-filter:blur(8px);
    border-top:1px solid var(--line); max-width:900px; margin:0 auto; }
  nav#tabs a { flex:1; text-align:center; padding:9px 4px 10px; text-decoration:none;
    color:var(--dim); font-size:12.5px; }
  nav#tabs a.on { color:#bfdbfe; background:#152039; font-weight:700; }
  main { padding-bottom:118px !important; }
  [data-page] { display:none; }
  body[data-page="overview"] [data-page="overview"],
  body[data-page="chat"] [data-page="chat"],
  body[data-page="settings"] [data-page="settings"],
  body[data-page="raw"] [data-page="raw"] { display:block; }
  footer { position:fixed; left:0; right:0; bottom:0; background:rgba(11,18,32,.95);
           backdrop-filter:blur(8px); border-top:1px solid var(--line); padding:9px 12px;
           display:flex; gap:8px; max-width:900px; margin:0 auto; }
  footer .sp { flex:1; }
  #toast { position:fixed; left:50%; bottom:74px; transform:translateX(-50%); background:#111a2e;
           border:1px solid var(--line); color:var(--txt); padding:9px 14px; border-radius:999px;
           font-size:12.5px; display:none; z-index:50; max-width:92vw; }
</style></head>
<body>
<header>
  <h1>🐋 大肥鱼</h1>
  <span id="svc" class="pill">…</span>
  <span id="build" class="pill" style="background:#1e3a8a;color:#bfdbfe">v?</span>
  <span id="upd" class="pill">…</span>
</header>
<div id="offbar"></div>
<div id="errbar"></div>
<main>
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

  <details data-page="raw">
    <summary>🔍 原始日志（排查用，平时不用看）</summary>
    <div style="margin-top:8px"><pre id="log">加载中…</pre></div>
  </details>
</main>
<nav id="tabs">
  <a href="?p=" + encodeURIComponent(P) + "&page=overview" data-tab="overview">📊 概览</a>
  <a href="?p=" + encodeURIComponent(P) + "&page=chat" data-tab="chat">💬 对话</a>
  <a href="?p=" + encodeURIComponent(P) + "&page=settings" data-tab="settings">⚙️ 设置</a>
  <a href="?p=" + encodeURIComponent(P) + "&page=raw" data-tab="raw">🔍 日志</a>
</nav>
<footer>
  <button onclick="load(true)">刷新</button>
  <button id="autoBtn" onclick="toggleAuto()">自动刷新 5s</button>
  <span class="sp"></span>
  <span id="fnote" class="hint" style="margin:0"></span>
</footer>
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
  const order = ['aiApiKey','budgetDaily','budgetTotal','budgetAnchor','dailyCalls'];
  const rows = order.filter(k => s[k]).map(k => {
    const it = s[k];
    const val = it.value == null ? '' : it.value;
    const id = 'set_' + k;
    return '<div class="frow"><label for="' + id + '">' + esc(it.label) + '</label>' +
      '<input id="' + id + '" data-key="' + k + '" ' +
      (it.secret ? 'type="password" placeholder="留空=不改；粘贴新的会覆盖" value="">' :
        'type="number" step="0.01" value="' + esc(val) + '">') +
      '<button class="sm" data-save="' + k + '">保存</button></div>';
  }).join('');
  el.innerHTML = rows + (s.aiApiKey ? '<p class="hint">当前密钥：' + esc(s.aiApiKey.value || '（未设置）') + '</p>' : '');
}

async function saveOne(key){
  const inp = document.querySelector('#settings input[data-key="' + key + '"]');
  if (!inp) return;
  const v = (inp.value || '').trim();
  const patch = {};
  if (v) patch[key] = v;
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
// 🔴 分页面（2026-10-06 用户要求「做几个分页面，别全挤在一起」）：
//    同一份 HTML 里给每个区块打了 data-page，这里按 body[data-page] 显隐 + 高亮标签栏。
//    ⚠️ 用 CSS 显隐而不是"多套模板" —— 保证**只有一份模板**（避免又踩"两份拷贝"的坑）。
(function initPages(){
  document.body.setAttribute("data-page", CUR);
  var tabs = document.querySelectorAll("#tabs a");
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute("data-tab") === CUR) tabs[i].className = "on";
  }
  var note = document.getElementById("fnote");
  if (note) {
    note.textContent = CUR === "chat" ? "可用下面的搜索框筛消息"
      : CUR === "settings" ? "改完点它自己的「保存」"
      : CUR === "raw" ? "技术日志，排查时才看" : "";
  }
})();
</script>
</body></html>`;

module.exports = { PAGE };
