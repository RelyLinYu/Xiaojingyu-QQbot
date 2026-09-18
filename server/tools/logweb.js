#!/usr/bin/env node
// ============================================================
//  日志监控网页 —— 手机浏览器看机器人日志
//
//  为什么单独一个进程：
//    ① 崩了不影响机器人（各自 systemd 服务）
//    ② 只读，不碰任何业务状态
//    ③ 权限最小：只运行 journalctl / 读 data/ 下的文件
//
//  ⚠️ 安全设计（必须理解，否则等于把群聊记录公开）：
//    · 必须带正确密码才能看，密码走环境变量 LOG_PASSWORD
//    · 只监听 0.0.0.0:PORT，**入站安全组只放行这一个端口**
//    · 全站只读，没有任何"执行命令""改配置"的入口
//    · 不上传任何用户输入到别处，不落盘访问日志
//
//  用法：
//    LOG_PASSWORD=你的密码 PORT=8080 node tools/logweb.js
//  手机访问： http://<你的服务器IP>:8080/?p=你的密码
//  （加到手机主屏幕就像个 App）
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 8080;
const PASSWORD = process.env.LOG_PASSWORD || '';
const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..');
const SERVICE = process.env.SERVICE_NAME || 'xiaolanjing';

if (!PASSWORD) {
  console.error('❌ 必须设置 LOG_PASSWORD（否则谁都能看你的群聊日志）');
  console.error('   例如： LOG_PASSWORD=abc12345 node tools/logweb.js');
  process.exit(1);
}

// ---------- 取数据 ----------
// ⚠️ execFile 在"命令不存在"时会**同步抛异常**，所以必须包 try ——
//    不然整个进程会被未捕获异常干掉（本地测试时踩到过：调一次 /api/state 服务就死了）。
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve({ err, stdout: stdout || '' });
      });
    } catch (e) {
      resolve({ err: e, stdout: '' });
    }
  });
}

async function journalLines(n) {
  const { err, stdout } = await run('journalctl',
    ['-u', SERVICE, '-n', String(n), '--no-pager', '-o', 'short-iso'], 5000);
  if (!stdout) return `(读不到日志${err ? ': ' + err.message : ''})\n（本机没有 journalctl 时属正常）`;
  return stdout;
}

async function serviceState() {
  const { err, stdout } = await run('systemctl', ['is-active', SERVICE], 3000);
  if (err && !stdout) return 'unknown';
  return (stdout || '').trim() || 'unknown';
}

function budgetState() {
  try {
    const f = path.join(APP_DIR, 'data', 'budget.json');
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));

    // 上限优先取文件里保存的；旧文件没有就用 .env / 环境变量兜底，最后给个默认值。
    // （budget.json 早期版本只存花费不存上限，兼容一下）
    const envDaily = Number(process.env.BUDGET_DAILY_YUAN) || 3;
    const envTotal = Number(process.env.BUDGET_TOTAL_YUAN) || 10;
    const dl = Number(j.dailyLimit) || envDaily;
    const tl = Number(j.totalLimit) || envTotal;
    const daySpent = Number(j.daySpent) || 0;
    const spentYuan = Number(j.spentYuan) || 0;

    return {
      day: j.day,
      daySpent,
      dailyLimit: dl,
      dayLeft: Math.max(0, dl - daySpent),
      spentYuan,
      totalLimit: tl,
      totalLeft: Math.max(0, tl - spentYuan),
      calls: Number(j.calls) || 0,
      blocked: Number(j.blocked) || 0,
      byModel: j.byModel || {},
    };
  } catch { return null; }
}

function recentEvents(n) {
  try {
    const dir = path.join(APP_DIR, 'data');
    const files = fs.readdirSync(dir).filter((x) => x.startsWith('events-')).sort();
    if (!files.length) return [];
    const lines = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')
      .trim().split('\n').filter(Boolean).slice(-n);
    return lines.map((l) => {
      try {
        const e = JSON.parse(l);
        const d = e.d || {};
        return {
          t: e.t,
          time: (d.timestamp || '').slice(11, 19),
          who: d.author?.username || '?',
          text: typeof d.content === 'string' ? d.content.trim() : '',
          type: d.message_type,
          quoted: (d.msg_elements || []).map((x) => (x.content || '').trim()).filter(Boolean).join(' '),
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// ---------- 认证 ----------
// 简单但够用：每次请求都要带对密码（?p=xxx 或 cookie）。
// 不做 session 是为了减少状态；密码走 URL 会被浏览器记住，手机加到桌面很方便。
function authed(req, url) {
  const q = url.searchParams.get('p');
  if (q === PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `lp=${PASSWORD}`);
}

const PAGE = (pwd) => `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f172a">
<title>肥鱼日志</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:#0f172a; color:#e2e8f0;
         font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header { position:sticky; top:0; background:#111c33; padding:10px 12px;
           border-bottom:1px solid #24334f; display:flex; gap:10px;
           align-items:center; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; }
  .pill { font-size:12px; padding:2px 8px; border-radius:999px; background:#1e293b; }
  .on { background:#065f46; color:#a7f3d0; }
  .off { background:#7f1d1d; color:#fecaca; }
  main { padding:10px 12px 60px; }
  section { margin-bottom:16px; }
  h2 { font-size:13px; color:#94a3b8; margin:0 0 6px; font-weight:600;
       text-transform:uppercase; letter-spacing:.06em; }
  pre { margin:0; padding:10px; background:#0b1225; border:1px solid #1e293b;
        border-radius:8px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;
        font-size:12px; line-height:1.6; }
  .ev { padding:6px 8px; border-bottom:1px solid #16213a; font-size:12px; }
  .ev:last-child { border-bottom:0; }
  .ev .m { color:#94a3b8; }
  .ev .q { color:#7dd3fc; }
  .ev .c { color:#e2e8f0; }
  .bar { display:flex; gap:8px; }
  a.btn, button { font:inherit; color:#cbd5e1; background:#1e293b; border:1px solid #334155;
          border-radius:8px; padding:7px 12px; cursor:pointer; text-decoration:none; }
  a.btn:active, button:active { background:#334155; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .card { background:#0b1225; border:1px solid #1e293b; border-radius:8px; padding:8px 10px; }
  .card b { color:#f8fafc; font-size:16px; display:block; }
  .card span { color:#94a3b8; font-size:11px; }
  .warn { color:#fbbf24; }
  footer { position:fixed; bottom:0; left:0; right:0; background:#111c33;
           border-top:1px solid #24334f; padding:8px 12px; display:flex; gap:8px; }
  footer .bar { flex:1; }
</style></head>
<body>
<header>
  <h1>🐋 肥鱼日志</h1>
  <span id="svc" class="pill">…</span>
  <span id="upd" class="pill">…</span>
</header>
<main>
  <section>
    <h2>额度</h2>
    <div class="grid" id="budget"></div>
  </section>
  <section>
    <h2>最近消息</h2>
    <div id="events" style="background:#0b1225;border:1px solid #1e293b;border-radius:8px"></div>
  </section>
  <section>
    <h2>日志（最近 200 行）</h2>
    <pre id="log">加载中…</pre>
  </section>
</main>
<footer>
  <div class="bar">
    <button onclick="load(true)">刷新</button>
    <button id="autoBtn" onclick="toggleAuto()">自动 5s</button>
  </div>
</footer>
<script>
const P = ${JSON.stringify(pwd)};
document.cookie = 'lp=' + encodeURIComponent(P) + ';path=/;max-age=31536000';
let auto = null;

function yuan(v){ return '¥' + (Number(v)||0).toFixed(4); }

async function load(manual){
  try {
    const r = await fetch('/api/state?p=' + encodeURIComponent(P));
    const j = await r.json();

    const svc = document.getElementById('svc');
    svc.textContent = j.service;
    svc.className = 'pill ' + (j.service === 'active' ? 'on' : 'off');
    document.getElementById('upd').textContent = new Date().toLocaleTimeString('zh-CN');

    const b = j.budget;
    document.getElementById('budget').innerHTML = b ? (
      '<div class="card"><b>' + yuan(b.daySpent) + '</b><span>今日已花 / 上限 ¥' + b.dailyLimit + '</span></div>' +
      '<div class="card"><b>' + yuan(b.spentYuan) + '</b><span>累计已花 / 上限 ¥' + b.totalLimit + '</span></div>' +
      '<div class="card"><b>' + (b.calls||0) + '</b><span>今日调用次数</span></div>' +
      '<div class="card"><b class="' + ((b.dayLeft!=null&&b.dayLeft<1)?'warn':'') + '">' + (b.dayLeft==null?'—':yuan(b.dayLeft)) + '</b><span>今日剩余</span></div>'
    ) : '<div class="card"><span>暂无花费数据</span></div>';

    document.getElementById('events').innerHTML = (j.events||[]).slice().reverse().map(e =>
      '<div class="ev"><span class="m">' + (e.time||'') + '</span> ' +
      '<span class="m">' + esc(e.who) + '</span>' +
      (e.type && e.type !== 0 ? ' <span class="m">[type' + e.type + ']</span>' : '') +
      (e.quoted ? '<div class="q">↩ ' + esc(e.quoted) + '</div>' : '') +
      '<div class="c">' + esc(e.text || '(无文本)') + '</div></div>'
    ).join('') || '<div class="ev m">暂无事件</div>';

    document.getElementById('log').textContent = j.log || '(空)';
  } catch (err) {
    document.getElementById('log').textContent = '连接失败: ' + err.message;
  }
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function toggleAuto(){
  if (auto) { clearInterval(auto); auto = null; document.getElementById('autoBtn').textContent = '自动 5s'; }
  else { auto = setInterval(()=>load(false), 5000); document.getElementById('autoBtn').textContent = '停止自动'; }
}
load(true);
</script>
</body></html>`;

// ---------- 服务器 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (!authed(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('需要密码。用法： http://<你的IP>:8080/?p=你的密码');
    return;
  }

  if (url.pathname === '/api/state') {
    const [log, service] = await Promise.all([journalLines(200), serviceState()]);
    const budget = budgetState();
    const events = recentEvents(30);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ log, service, budget, events }));
    return;
  }

  // 精简摘要：给命令行排查用（不用在 shell 里拼 JSON 解析）
  if (url.pathname === '/api/summary') {
    const [log, service] = await Promise.all([journalLines(50), serviceState()]);
    const b = budgetState();
    const events = recentEvents(10);
    const last = events[events.length - 1];
    const lines = [
      `服务状态 : ${service}`,
      `今日花费 : ¥${(b?.daySpent ?? 0).toFixed(4)} / ¥${b?.dailyLimit ?? '?'}   （剩 ¥${(b?.dayLeft ?? 0).toFixed(4)}）`,
      `累计花费 : ¥${(b?.spentYuan ?? 0).toFixed(4)} / ¥${b?.totalLimit ?? '?'}   （剩 ¥${(b?.totalLeft ?? 0).toFixed(4)}）`,
      `调用次数 : ${b?.calls ?? 0}`,
      `最近事件 : ${events.length} 条`,
      last ? `最新一条 : ${last.time} ${last.who} -> ${(last.text || '').slice(0, 40)}` : '最新一条 : （无）',
      `日志行数 : ${log.split('\n').length}`,
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(lines.join('\n') + '\n');
    return;
  }

  // 最近 N 行日志的纯文本版（手机上想快速看就用它）
  if (url.pathname === '/api/log') {
    const n = Math.min(2000, Math.max(10, Number(url.searchParams.get('n')) || 200));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(await journalLines(n));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE(url.searchParams.get('p') || ''));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[logweb] 已启动，监听 0.0.0.0:${PORT}`);
  console.log(`[logweb] 手机访问： http://<服务器公网IP>:${PORT}/?p=<密码>`);
  console.log(`[logweb] 看的是 ${SERVICE} 服务的日志；数据目录 ${path.join(APP_DIR, 'data')}`);
});
