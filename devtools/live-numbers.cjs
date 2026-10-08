// ============================================================
//  devtools/live-numbers.cjs —— 把线上页面里**所有含数字的文字**都列出来，
//  并标注它是不是"活的"（== 接口返回值）。
//
//  🔴 为什么要这么查（用户 2026-10-08：「再检查一遍，面板中的小文字提示中的数字
//     会不会随着设置面板中的修改而跟着修改」）：
//    只盯着我"记得"的那几处不算检查 —— 得把页面上**每一处**数字都摊开看，
//    否则漏掉的恰好是写死的那一处（我上次就漏了"14 组示范"）。
//
//  跑法： $env:XLJ_HOST="http://<服务器IP>:8080"; $env:XLJ_PW="<密码>"; node devtools/live-numbers.cjs
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// 🔴 真实地址只能从环境变量来（同 live-audit.cjs 的说明：曾把公网 IP 硬编码进公开仓库）
const HOST = (process.env.XLJ_HOST || '').replace(/\/+$/, '');
const PW = process.env.XLJ_PW || '';
const PORT = 9229;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!HOST) { console.log('⚠️ 请设 $env:XLJ_HOST="http://<服务器IP>:8080"'); process.exit(0); }
if (!PW) { console.log('⚠️ 请设 $env:XLJ_PW="<面板密码>"'); process.exit(0); }
if (!fs.existsSync(EDGE)) { console.log('⚠️ 本机没有 Edge，跳过'); process.exit(0); }

async function wsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('连不上 CDP');
}
function cdp(ws) {
  let id = 0; const w = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
  });
  return { send: (method, params, sid) => new Promise((res, rej) => {
    const n = ++id; w.set(n, { res, rej });
    const msg = { id: n, method, params: params || {} }; if (sid) msg.sessionId = sid;
    ws.send(JSON.stringify(msg));
  }) };
}

// 抓所有「叶子元素」里的数字文字（跳过 script/style，避免把 CSS 数字也抓进来）
const GRAB = `(function(){
  var out = [], seen = {};
  function push(txt, where){
    txt = (txt||'').replace(/\\s+/g,' ').trim();
    if (!txt) return;
    if (!/[0-9]/.test(txt)) return;
    if (seen[txt]) return;                    // 同一个提示出现两次只记一次
    seen[txt] = 1;
    out.push({ text: txt.slice(0,120), where: where });
  }
  // 只遍历可见页面区域（排除 script/style），取"没有元素子节点"的叶子
  var all = document.querySelectorAll('main *, header *');
  for (var i=0;i<all.length;i++){
    var el = all[i];
    if (el.children.length === 0) {
      push(el.textContent, (el.tagName + (el.id?('#'+el.id):'') + (el.className && typeof el.className==='string'?('.'+el.className.split(' ')[0]):'')));
    }
  }
  // 顶部状态条（服务/构建/更新时间）也算
  var header = document.querySelector('header');
  if (header) {
    var hls = header.querySelectorAll('*');
    for (var k=0;k<hls.length;k++){ if (hls[k].children.length===0) push(hls[k].textContent, 'header'); }
  }
  return out;
})()`;

async function main() {
  const api = async (p) => await (await fetch(HOST + p)).json();
  const state = await api('/api/state?p=' + encodeURIComponent(PW));
  const exs = await api('/api/examples?p=' + encodeURIComponent(PW));
  const presets = await api('/api/presets?p=' + encodeURIComponent(PW));
  const usage = await api('/api/usage?days=14&p=' + encodeURIComponent(PW));
  const exCount = ((exs.status && exs.status.items) || []).length;

  // 真值字典：页面上的数字应该能对上这些
  const truth = {
    '日次数上限': state.budget.dailyCallLimit,
    '每日限额¥': state.budget.dailyLimit,
    '总额¥': state.budget.totalLimit,
    '今日调用': state.budget.dayCalls,
    '示范组数': exCount,
    '预设数': (presets.items || []).length,
    '趋势天数': (usage.days || []).length,
    '构建': state.build,
  };
  console.log('接口真值：' + JSON.stringify(truth, null, 0));

  const profile = path.join(__dirname, '_preview', '_edge-live');
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1400,2600', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    const ws = new WebSocket(await wsUrl());
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws fail'))); });
    const { send } = cdp(ws);
    const t = await send('Target.createTarget', { url: 'about:blank' });
    const att = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = att.sessionId;
    await send('Page.enable', {}, sid);
    await send('Page.navigate', { url: HOST + '/?p=' + encodeURIComponent(PW) }, sid);
    await sleep(4000);
    // 展开所有折叠块，否则读不到里面的文字
    await send('Runtime.evaluate', { expression: 'document.querySelectorAll("details").forEach(function(d){d.open=true})' }, sid);
    await sleep(600);

    const r = await send('Runtime.evaluate', { expression: GRAB, returnByValue: true }, sid);
    const items = (r.result && r.result.value) || [];
    console.log('\n页面上含数字的文字共 ' + items.length + ' 处：\n');
    for (const it of items) {
      console.log('  [' + it.where + '] ' + it.text);
    }
    console.log('\n（以上每一处都请对照上面的"接口真值"看：凡是数字与真值一致 = 活值；' +
      '若出现真值里没有的固定数字，就可能还是写死的）');
    return 0;
  } finally { try { proc.kill(); } catch (e) {} }
}

main().then((c) => process.exit(c)).catch((e) => { console.log('❌ ' + e.message); process.exit(1); });
