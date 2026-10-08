// ============================================================
//  devtools/btn-probe.cjs —— 「按钮点了到底有没有用」的渲染端探针
//
//  🔴 为什么需要它（2026-10-08，用户报「切换天数貌似用不了」）：
//    我之前的 theme-audit 只验**静态样式**（列宽、对比度、柱高比例…），
//    **完全没验过"点一下按钮会发生什么"** —— 于是"7/14/30 天"这排按钮有没有生效，
//    在我的验收体系里是个**盲区**（跟"柱子倒挂"同一类：断言只覆盖我想到的维度）。
//    ⇒ 这个探针专门干一件事：**真的去点按钮，再读页面上真正渲染出来的结果**。
//
//  跑法： node devtools/btn-probe.cjs
//  退出码：0 = 全部符合预期；1 = 有按钮没生效
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PRE = path.join(__dirname, '_preview');
const PORT = 9225;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(PRE, 'preview-overview.html'))) {
  console.log('⚠️ 先跑： node devtools/preview-page.cjs');
  process.exit(1);
}

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
  return {
    send: (method, params, sessionId) => new Promise((res, rej) => {
      const n = ++id; waiters.set(n, { res, rej });
      const msg = { id: n, method, method: method, params: params || {} };
      msg.method = method;
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    }),
  };
}

// 在页面里：点某个天数的按钮，等一会儿，数柱子 + 读那行小结
const probe = (label, expectBars) => `(function(){
  var btns = Array.prototype.slice.call(document.querySelectorAll('.exbar button'));
  var btn = btns.filter(function(b){ return b.textContent.indexOf('${label}') >= 0; })[0];
  if (!btn) return { error: '找不到按钮：${label}' };
  btn.click();
  return new Promise(function(resolve){
    setTimeout(function(){
      var bars = document.querySelectorAll('.ubar i');
      var note = document.getElementById('useNote');
      resolve({
        label: '${label}',
        expect: ${expectBars},
        bars: bars.length,
        note: note ? note.textContent : '(无)',
        errbar: (function(){ var e=document.getElementById('errbar'); return (e && e.style.display==='block') ? e.textContent : ''; })()
      });
    }, 1200);
  });
})()`;

// ============================================================
//  探针二：**提示文字里的数字，是否跟着真实数据走**（2026-10-08 用户要求核查）
//  用户原话：「检查一遍，面板中的小文字提示中的数字会不会随着设置面板中的修改而跟着修改」
//  ⇒ 验法不是"读源码看有没有写死"，而是**展开那个折叠块、读渲染后的 DOM**，
//    再跟同一份数据源（示范表格的实际行数 / 接口返回值）对账。
// ============================================================
const hintProbe = `(function(){
  var out = { found: {}, problems: [] };
  // 展开"参数设置"和"语气示范"两个折叠块（默认收起，不展开读不到里面的文字）
  var dets = document.querySelectorAll('details');
  for (var i = 0; i < dets.length; i++) dets[i].open = true;

  var title = document.title || '';
  out.title = title;
  out.h1 = (document.querySelector('h1') || {}).textContent || '';

  // ① 「人设 = ... 示范」那句里的组数，必须等于示范表格里**实际渲染出来的行数**（只数非空行）
  var hintEl = document.getElementById('exHintInSettings');
  var hint = hintEl ? hintEl.textContent : '';
  out.exHint = hint;
  var m = /(\\d+)\\s*组/.exec(hint);
  out.exHintN = m ? parseInt(m[1], 10) : null;

  // 表格实际生效行数：exCollect() 的口径 = 去掉 u/a 全空的行
  var rows = document.querySelectorAll('#exList .exrow');
  var n = 0;
  for (var j = 0; j < rows.length; j++) {
    var u = (rows[j].querySelector('[data-f=u]') || {}).value || '';
    var a = (rows[j].querySelector('[data-f=a]') || {}).value || '';
    if (u.trim() || a.trim()) n++;
  }
  out.exRows = n;
  if (out.exHintN === null) out.problems.push('提示里没找到"N 组"字样：' + hint);
  else if (out.exHintN !== n) out.problems.push('提示写 ' + out.exHintN + ' 组，表格实际 ' + n + ' 行');

  // ② 额度区那个新提示必须在（用户要求加的）
  var body = document.body.textContent || '';
  out.hasPeakNote = body.indexOf('峰值') >= 0;
  out.hasOfficialNote = body.indexOf('官方 API Key 监控') >= 0;
  if (!out.hasPeakNote) out.problems.push('缺少"按峰值计算"的提示');
  if (!out.hasOfficialNote) out.problems.push('缺少"真实值请看官方 API Key 监控"的提示');

  // ③ 标题
  if (title.indexOf('QQbot控制台') < 0) out.problems.push('网页标题不是 QQbot控制台：' + title);

  // ④ 额度区所有数字都不该是空占位（… 或 空）
  var cards = document.querySelectorAll('#budget .card');
  out.budgetCards = [];
  for (var k = 0; k < cards.length; k++) {
    out.budgetCards.push((cards[k].textContent || '').replace(/\\s+/g, ' ').trim());
  }
  for (var q = 0; q < out.budgetCards.length; q++) {
    if (/…/.test(out.budgetCards[q])) out.problems.push('额度卡片还是占位符：' + out.budgetCards[q]);
  }
  return out;
})()`;

async function main() {
  const profile = path.join(PRE, '_edge-profile');
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
    await send('Page.navigate', { url: 'file:///' + path.join(PRE, 'preview-overview.html').replace(/\\/g, '/') }, sid);
    await sleep(2500);   // 等首次加载完成

    const cases = [['最近 7 天', 7], ['14 天', 14], ['30 天', 30], ['最近 7 天', 7]];
    let bad = 0;
    console.log('══════ 按钮点击探针（切换用量天数）══════');
    for (const [label, expect] of cases) {
      const r = await send('Runtime.evaluate', {
        expression: probe(label, expect), returnByValue: true, awaitPromise: true,
      }, sid);
      const v = r.result && r.result.value;
      if (!v || v.error) { console.log('  ❌ ' + label + ' → ' + (v && v.error)); bad++; continue; }
      const ok = v.bars === expect;
      console.log('  ' + (ok ? '✅' : '❌') + ' 点「' + v.label + '」→ 渲染出 ' + v.bars +
        ' 根柱子（期望 ' + v.expect + '）｜' + v.note);
      if (!ok) bad++;
      if (v.errbar) { console.log('     ⚠️ 页面上报了错：' + v.errbar); bad++; }
    }
    console.log('\n══════ 提示文字与数字探针（标题 / 峰值提示 / 示范组数）══════');
    const rh = await send('Runtime.evaluate', { expression: hintProbe, returnByValue: true, awaitPromise: true }, sid);
    const hv = rh.result && rh.result.value;
    if (!hv) { console.log('  ❌ 探针没返回结果'); bad++; }
    else {
      console.log('  网页标题      : ' + hv.title);
      console.log('  页内大标题    : ' + hv.h1);
      console.log('  "示范 N 组"提示: ' + (hv.exHint || '(空)'));
      console.log('  示范表格实际行数: ' + hv.exRows);
      console.log('  额度卡片      : ' + hv.budgetCards.join(' | '));
      console.log('  峰值提示存在  : ' + (hv.hasPeakNote ? '✅' : '❌') +
                  ' ｜ 官方监控提示存在: ' + (hv.hasOfficialNote ? '✅' : '❌'));
      if (hv.problems.length) {
        hv.problems.forEach((t) => { console.log('  ❌ ' + t); bad++; });
      } else {
        console.log('  ✅ 提示里的组数与表格实际行数一致、标题和两条提示都在');
      }
    }

    console.log('\n════════════════════════════════════');
    if (bad) { console.log(' ❌ 有 ' + bad + ' 项不符合预期'); return 1; }
    console.log(' ✅ 按钮 + 提示文字全部符合预期');
    return 0;
  } finally {
    try { proc.kill(); } catch (e) {}
  }
}

main().then((c) => process.exit(c)).catch((e) => { console.log('❌ 探针失败：' + e.message); process.exit(1); });
