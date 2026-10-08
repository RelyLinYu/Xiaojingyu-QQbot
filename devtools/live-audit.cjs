// ============================================================
//  devtools/live-audit.cjs —— 直接体检**线上真实页面**（打完最后一道交付边界）
//
//  🔴 为什么还要这一层（本地打样已经验过一遍了）：
//    "我改了源文件" ≠ "你在手机上看到的页面是新的"。
//    交付物是**服务器实际吐给浏览器的 HTML + 浏览器渲染出的 DOM**，
//    所以最后必须拿真地址、真密码、真接口数据跑一遍。
//
//  验什么：
//    ① 网页标题 / 页内大标题
//    ② 额度区"按峰值计算"提示在不在
//    ③ 提示里的"示范 N 组"**是否等于** /api/examples 实际返回的组数（对账，不是看有没有写死）
//    ④ 额度四张卡片的数字 是否等于 /api/state 返回值（对账）
//
//  跑法： $env:XLJ_HOST="http://<服务器IP>:8080"; $env:XLJ_PW="<面板密码>"; node devtools/live-audit.cjs
//  退出码：0 = 全部对上；1 = 有对不上的
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// 🔴 真实地址**只能从环境变量来，绝不写进仓库**。
//
// 2026-10-08 抓出来的事故：这个文件（和 live-numbers.cjs）曾把服务器**公网 IP
// 硬编码**在源码里，而仓库是**公开**的 —— 等于把地址挂在网上给人看。
// ⚠️ 而且它是 `--worktree` 档审计抓到的，`--staged` 档**看不见历史遗留** ⇒
//    推送前两道都要跑（见 README「推送前必跑」）。
const HOST = (process.env.XLJ_HOST || '').replace(/\/+$/, '');
const PW = process.env.XLJ_PW || '';
const PORT = 9227;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!HOST) { console.log('⚠️ 未提供地址：请设 $env:XLJ_HOST=\"http://<服务器IP>:8080\" 再跑'); process.exit(0); }
if (!PW) { console.log('⚠️ 未提供密码：请设 $env:XLJ_PW=\"<面板密码>\" 再跑'); process.exit(0); }
if (!fs.existsSync(EDGE)) { console.log('⚠️ 本机没有 Edge，跳过'); process.exit(0); }

async function wsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('连不上 CDP');
}

function cdp(ws) {
  let id = 0;
  const waiters = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && waiters.has(m.id)) {
      const w = waiters.get(m.id); waiters.delete(m.id);
      m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
    }
  });
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const n = ++id; waiters.set(n, { res, rej });
    const msg = { id: n, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
  return { send };
}

// 页面内：展开折叠块，读渲染后的真实文字
const READ_DOM = `(function(){
  var dets = document.querySelectorAll('details');
  for (var i=0;i<dets.length;i++) dets[i].open = true;
  var budget = [];
  var cards = document.querySelectorAll('#budget .card');
  for (var k=0;k<cards.length;k++) budget.push((cards[k].textContent||'').replace(/\\s+/g,' ').trim());
  return {
    title: document.title,
    h1: (document.querySelector('h1')||{}).textContent || '',
    exHint: (document.getElementById('exHintInSettings')||{}).textContent || '',
    peakNote: (document.body.textContent||'').indexOf('峰值') >= 0,
    officialNote: (document.body.textContent||'').indexOf('官方 API Key 监控') >= 0,
    budgetCards: budget,
    errbar: (function(){var e=document.getElementById('errbar');return (e&&e.style.display==='block')?e.textContent:'';})()
  };
})()`;

async function main() {
  // 先拿"真值"（直接问接口）
  const api = async (p) => (await (await fetch(HOST + p)).json());
  const state = await api('/api/state?p=' + encodeURIComponent(PW));
  const exs = await api('/api/examples?p=' + encodeURIComponent(PW));
  const realExCount = ((exs.status && exs.status.items) || []).length;
  console.log('接口真值：日次数上限=' + state.budget.dailyCallLimit +
    ' 每日限额=¥' + state.budget.dailyLimit + ' 示范=' + realExCount + ' 组');

  const profile = path.join(__dirname, '_preview', '_edge-live');
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1280,2000', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    const ws = new WebSocket(await wsUrl());
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
    });
    const { send } = cdp(ws);
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const att = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sid = att.sessionId;

    await send('Page.enable', {}, sid);
    // ⚠️ 页面脚本身也会写 lp cookie；这里先用 ?p= 进一次，让 cookie 落下来
    await send('Page.navigate', { url: HOST + '/?p=' + encodeURIComponent(PW) }, sid);
    await sleep(4000);

    const r = await send('Runtime.evaluate', { expression: READ_DOM, returnByValue: true }, sid);
    const dom = r.result && r.result.value;
    if (!dom) { console.log('❌ 读不到线上 DOM'); return 1; }

    let bad = 0;
    const check = (name, ok, detail) => {
      console.log('  ' + (ok ? '✅' : '❌') + ' ' + name + (detail ? ' :: ' + detail : ''));
      if (!ok) bad++;
    };

    console.log('\n──── 线上页面实测 ────');
    check('① 网页标题 = QQbot控制台', dom.title === 'QQbot控制台', dom.title);
    check('① 页内大标题 = QQbot控制台', (dom.h1 || '').trim() === 'QQbot控制台', dom.h1);
    check('② "按峰值计算"提示已显示', dom.peakNote);
    check('② "官方 API Key 监控"提示已显示', dom.officialNote);

    // ③ 对账：提示里的组数 == 接口实际组数
    const m = /(\d+)\s*组/.exec(dom.exHint || '');
    const shown = m ? Number(m[1]) : null;
    check('③ 提示里的示范组数 == 接口实际组数',
      shown === realExCount, '页面显示 ' + shown + ' ｜ 接口 ' + realExCount + ' ｜ 原文：' + dom.exHint);

    // ④ 对账：额度卡片里的上限数字 == 接口返回值
    const joined = dom.budgetCards.join(' | ');
    check('④ 卡片里的日次数上限 == 接口值',
      joined.indexOf('上限 ' + state.budget.dailyCallLimit) >= 0, joined);
    check('④ 卡片里的每日限额 == 接口值',
      joined.indexOf('/ 上限 ¥' + Number(state.budget.dailyLimit).toFixed(4)) >= 0, joined);
    check('④ 额度卡片没有留占位符（…）', !/…/.test(joined));
    check('页面没有报错横幅', !dom.errbar, dom.errbar);

    console.log('\n════════════════════════════════════');
    if (bad) { console.log(' ❌ 线上有 ' + bad + ' 项对不上'); return 1; }
    console.log(' ✅ 线上页面全部对得上（标题 / 提示 / 数字对账）');
    return 0;
  } finally {
    try { proc.kill(); } catch (e) {}
  }
}

main().then((c) => process.exit(c)).catch((e) => { console.log('❌ 失败：' + e.message); process.exit(1); });
