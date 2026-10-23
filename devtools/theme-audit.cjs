// ============================================================
//  devtools/theme-audit.cjs —— 「浅色 / 深色」双主题的**渲染端**体检
//
//  🔴 为什么不能靠"读 CSS 源码"下结论：
//     样式是有**级联和优先级**的 —— 我写了一条 .pill.on{background:深绿底}，
//     它本来会被上面 .pill 的 background 盖掉（截图里"运行中"就是灰的）。
//     只看源文件永远看不出这种问题，必须问**浏览器实际算出来的值**。
//     这就是"验证要打交付边界"：交付物 = 浏览器渲染结果，不是服务器上的文本。
//
//  做法：起一个无头 Edge（CDP），把打样页塞进去，
//        在页面内执行 JS 读 getComputedStyle，逐个断言；两套主题各跑一遍。
//
//  跑法： node devtools/theme-audit.cjs
//  退出码：0 = 全部通过；1 = 有断言失败（**用它当闸门**）
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PRE = path.join(__dirname, '_preview');
const PORT = 9223;

if (!fs.existsSync(EDGE)) { console.log('⚠️ 本机没有 Edge，跳过渲染体检'); process.exit(0); }
if (!fs.existsSync(path.join(PRE, 'preview-overview.html'))) {
  console.log('⚠️ 还没有打样页，先跑： node devtools/preview-page.cjs');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error('连不上 CDP（端口 ' + PORT + '）');
}

// ⚠️ sessionId 必须是**消息顶层字段**（不是 params 里的字段）——
//    写进 params 会得到 "'Page.enable' wasn't found" 这种误导性报错（浏览器当成 root 会话的方法找了）。
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
    const msg = { id: n, method: method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
  return { send };
}

// ---------- 断言集：全部在**页面里**执行（读 getComputedStyle）----------
// 每一条都写明"在防什么"。
const AUDIT_JS = `(function () {
  // ⚠️ 这个解析器必须**同时吃两种写法**：
  //    getComputedStyle(el).getPropertyValue('color') 给的是 'rgb(29, 29, 31)'，
  //    而我们自己定义的**自定义属性**（--accent）读到的是**原始字面量** '#0071E3'。
  //    只写 rgba() 分支的话，比较"主按钮底色 vs --accent"时会拿 null 去取 .r ⇒ 断言脚本自己崩。
  function parseRGB(s) {
    s = String(s).trim();
    var hx = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (hx) {
      var h = hx[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    var m = s.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) {
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function contrast(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function over(fg, bg) {
    var a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function cs(el, p) { return el ? getComputedStyle(el).getPropertyValue(p).trim() : '(元素不存在)'; }
  function q(sel) { return document.querySelector(sel); }

  var bad = [], pass = [];
  function chk(name, cond, detail) { (cond ? pass : bad).push(name + (detail ? ' :: ' + detail : '')); }

  // (1) 主题确实落在 html 上
  var theme = document.documentElement.getAttribute('data-theme');
  chk('data-theme 已设置', theme === 'light' || theme === 'dark', String(theme));
  var isDark = theme === 'dark';
  var root = getComputedStyle(document.documentElement);

  // (2) 底色必须是"纯黑/灰黑"，**不许深蓝**（旧版 #0b1220 就是深蓝，用户明令禁止）
  var bg = parseRGB(cs(document.body, 'background-color'));
  if (isDark) {
    chk('深色底接近纯黑', bg.r <= 40 && bg.g <= 40 && bg.b <= 40, cs(document.body, 'background-color'));
    chk('深色底是灰黑不是深蓝', (bg.b - bg.r) <= 8, 'b-r=' + (bg.b - bg.r));
  } else {
    chk('浅色底接近纯白', bg.r >= 240 && bg.g >= 240 && bg.b >= 240, cs(document.body, 'background-color'));
  }

  // (3) 变量两套都必须有值（缺一个 ⇒ 深色下会沿用浅色值）
  // ⚠️ 这份名单要跟着 page.js 的令牌表走：删了令牌就得从这儿删，
  //    否则会报"变量缺失"的假失败（--chart-track 就是这么被删掉的）。
  var vars = ['--bg','--bg-subtle','--bg-elevated','--border','--border-strong','--text','--text-secondary',
              '--text-tertiary','--accent','--accent-hover','--accent-ring','--danger','--success','--warning',
              '--shadow-card','--shadow-pop','--control-bg','--code-bg','--chart-bar','--bubble-bot','--divider'];
  var missVar = vars.filter(function (v) { return !root.getPropertyValue(v).trim(); });
  chk('语义变量无缺失（' + vars.length + ' 个）', missVar.length === 0, missVar.join(','));

  // (4) 页面里不许出现"散装色值"的**行内样式**
  var inline = [];
  var all = document.querySelectorAll('[style]');
  for (var i = 0; i < all.length; i++) {
    var st = all[i].getAttribute('style') || '';
    if (/#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(/.test(st)) {
      inline.push(all[i].tagName + '.' + (all[i].className || '') + ' -> ' + st.slice(0, 60));
    }
  }
  chk('没有行内散装色值', inline.length === 0, inline.slice(0, 3).join(' | '));

  // (5) 输入框：必须被自定义（圆角 + 边框 + 字号 ≥16 防移动端缩放）
  var inp = q('#settings input[type=text], #settings input[type=number], #settings input[type=password]')
         || q('input[type=text]') || q('input[type=number]');
  if (inp) {
    chk('输入框有自定义圆角', parseFloat(cs(inp, 'border-top-left-radius')) >= 6, cs(inp, 'border-top-left-radius'));
    chk('输入框有自定义边框', parseFloat(cs(inp, 'border-top-width')) >= 1, cs(inp, 'border-top-width'));
    chk('输入框字号 >=15.5px（移动端防缩放）', parseFloat(cs(inp, 'font-size')) >= 15.5, cs(inp, 'font-size'));
  } else { chk('找得到输入框', false, '页面上没有 input'); }

  // (6) 下拉：必须去掉原生 appearance（否则会出现系统箭头 —— 明令禁止原生外观）
  var sel = q('select');
  if (sel) {
    var app = cs(sel, '-webkit-appearance') || cs(sel, 'appearance');
    chk('下拉去掉了原生外观', app === 'none', app);
    var selBg = parseRGB(cs(sel, 'background-color'));
    var selTx = parseRGB(cs(sel, 'color'));
    chk('下拉文字对比度 >=4.5:1', contrast(over(selTx, selBg), selBg) >= 4.5,
      contrast(over(selTx, selBg), selBg).toFixed(2) + ':1');
  } else { chk('找得到下拉框', false, '页面上没有 select'); }

  // (7) 主按钮：底色必须真的变成 accent（不是"写了但被级联盖掉"）
  // ⚠️ 注意选**可见**的那个：分页面用 display:none 藏着别的页，不可见元素的
  //    getBoundingClientRect 是 0x0 —— 拿它量"触控面积"必然假失败（我自己先栽了一次）。
  function visible(el) { return !!el && el.getBoundingClientRect().width > 0; }
  function firstVisible(sel) {
    var list = document.querySelectorAll(sel);
    for (var z = 0; z < list.length; z++) if (visible(list[z])) return list[z];
    return null;
  }
  var btn = firstVisible('button.primary') || q('button.primary');
  if (btn) {
    var bb = parseRGB(cs(btn, 'background-color'));
    var acc = parseRGB(root.getPropertyValue('--accent'));
    var near = Math.abs(bb.r - acc.r) < 12 && Math.abs(bb.g - acc.g) < 12 && Math.abs(bb.b - acc.b) < 12;
    chk('主按钮底色 = accent（未被级联盖掉）', near, cs(btn, 'background-color') + ' vs ' + root.getPropertyValue('--accent'));
    var bw = btn.getBoundingClientRect().width, bh = btn.getBoundingClientRect().height;
    chk('可见主按钮高 >=32px', bh >= 32, Math.round(bw) + 'x' + Math.round(bh));
    // 手机上（pointer:coarse）要求 44px —— 桌面这里只要求"不难点"，并把实测值打出来
    chk('可见主按钮宽 >=44px', bw >= 44, Math.round(bw) + 'px');
  } else { chk('找得到主按钮', false, '没有 button.primary'); }

  // (8) 状态胶囊：底色必须真的上色（.pill 的 background 会盖掉 .pill.on 的 —— 已栽过）
  var pill = q('#svc');
  if (pill) {
    var pb = parseRGB(cs(pill, 'background-color'));
    var refEl = q('.card') || document.body;
    var cardBg = parseRGB(cs(refEl, 'background-color'));
    var differs = Math.abs(pb.r - cardBg.r) + Math.abs(pb.g - cardBg.g) + Math.abs(pb.b - cardBg.b) > 12;
    chk('状态胶囊底色与卡片不同（说明上色生效）', differs,
      cs(pill, 'background-color') + ' vs ' + cs(refEl, 'background-color'));
  }

  // (9) 趋势图柱子：**宽度必须一致**（每根宽度不同 = 脏，截图抓到过）
  var bars = document.querySelectorAll('.ubar i');
  if (bars.length > 2) {
    var w0 = bars[0].getBoundingClientRect().width;
    var drift = 0;
    for (var k = 1; k < bars.length; k++) drift = Math.max(drift, Math.abs(bars[k].getBoundingClientRect().width - w0));
    chk('柱状图每根柱子等宽', drift < 1.5, '最大偏差 ' + drift.toFixed(2) + 'px');
    // (9b) 柱子(=图形元素)对底面的对比度 >=3:1 —— 靠"柱子压在浅灰轨上"是过不了这条的
    var barBg = parseRGB(cs(bars[0], 'background-color'));
    var chartCard = bars[0].closest('.card') || document.body;
    var surface = parseRGB(cs(chartCard, 'background-color'));
    chk('柱子对卡片底对比 >=3:1', contrast(barBg, surface) >= 3,
      contrast(barBg, surface).toFixed(2) + ':1');

    // (9c) 🔴 用户硬要求一：「所有柱子按比例长度」
    //      验证方式：算出每根的 高度/数值，这些"每单位数值对应多少像素"必须**基本一致**。
    //      这是"比例"这个词真正的含义 —— 比"哪根比哪根高"强得多（后者两根都错也能过）。
    var units = [];
    for (var k3 = 0; k3 < bars.length; k3++) {
      var calls = Number((bars[k3].parentNode.parentNode.querySelector('u') || {}).textContent);
      var hh = bars[k3].getBoundingClientRect().height;
      if (calls > 0 && hh > 0) units.push(hh / calls);
    }
    if (units.length > 2) {
      var mn = Math.min.apply(null, units), mx = Math.max.apply(null, units);
      var spread = (mx - mn) / mn;
      chk('柱高与数值严格等比（每单位数值的像素数一致）', spread < 0.06,
        '离散度 ' + (spread * 100).toFixed(1) + '%（理想 0%）');
    }

    // (9d) 🔴 用户硬要求二：「确保有新的最大值进入表格时不会被卡片固定高度挡住」
    //      必须同时成立两件事：
    //        · 新最大值那根**正好占满绘图区**（top 与绘图区 top 齐平 —— 允许 1px 舍入差）；
    //        · 它**没有超出**绘图区（超出就是被裁掉了）。
    //      ⚠️ 这一条是给"数据变了图就坏"上的保险：我们不靠"现在的数据刚好不溢出"，
    //        而是要**结构上不可能溢出**（固定高度绘图区 + overflow:hidden）并被断言锁住。
    var plot = bars[0].closest('.uplot');
    if (plot) {
      var pr = plot.getBoundingClientRect();
      var maxCall = -1, maxBar = null;
      for (var k4 = 0; k4 < bars.length; k4++) {
        var c4 = Number((bars[k4].parentNode.parentNode.querySelector('u') || {}).textContent) || 0;
        if (c4 > maxCall) { maxCall = c4; maxBar = bars[k4]; }
      }
      var br = maxBar.getBoundingClientRect();
      chk('最大值那根正好占满绘图区（未被压扁）', Math.abs(br.top - pr.top) <= 1.5,
        '柱顶 ' + br.top.toFixed(1) + ' vs 绘图区顶 ' + pr.top.toFixed(1));
      chk('没有柱子被卡片高度裁掉（不溢出绘图区）',
        br.top >= pr.top - 1.5 && br.bottom <= pr.bottom + 1.5,
        '柱 ' + br.top.toFixed(1) + '~' + br.bottom.toFixed(1) + ' / 区 ' + pr.top.toFixed(1) + '~' + pr.bottom.toFixed(1));
      // 绘图区高度必须是**固定像素**（不是 auto）：auto 的话百分比高度就没有基准，
      // 一旦标签长度变化，高柱就会被 flex-shrink 压回剩余空间（这就是"两个数字一样高"的老坑）。
      chk('绘图区高度是固定像素（不是 auto）', pr.height > 40,
        '实测 ' + pr.height.toFixed(1) + 'px');

      // (9e) 🔴 2026-10-08 用户纠正：「能不能别让他倒着来呀，正常不都是从下往上的吗」
      //      柱子必须**站在地上**（底边与绘图区底边齐平），不能"从顶上悬下来"。
      //      这是"从下往上长"这句话唯一能被机器验的形式 —— 光看"有高有低"是看不出来的，
      //      因为倒着长也照样"有高有低"（这正是它躲过前 63 条断言的原因）。
      var maxOffFloor = 0, minOffFloor = 0;
      for (var k5 = 0; k5 < bars.length; k5++) {
        var br5 = bars[k5].getBoundingClientRect();
        var off = Math.abs(pr.bottom - br5.bottom);
        maxOffFloor = Math.max(maxOffFloor, off);
      }
      chk('所有柱子都站在绘图区底边上（不是从顶悬下来）', maxOffFloor <= 1.5,
        '最大离地 ' + maxOffFloor.toFixed(2) + 'px');
      // 反向哨兵：如果柱子倒挂，矮柱的底边会离地很远 —— 明确再验一次"最短那根也贴着地"
      var shortest = bars[0];
      for (var k6 = 1; k6 < bars.length; k6++) {
        if (bars[k6].getBoundingClientRect().height < shortest.getBoundingClientRect().height) shortest = bars[k6];
      }
      minOffFloor = Math.abs(pr.bottom - shortest.getBoundingClientRect().bottom);
      chk('最短那根也贴着地（倒挂时它会离地最高）', minOffFloor <= 1.5,
        '最短柱离地 ' + minOffFloor.toFixed(2) + 'px');

      // (9f) 颜色语义要有说明：红/黄柱子代表"超限/接近上限"，图上必须有文字说清
      //      （用户看到红色问「这个红色的是怎么回事」—— 只做颜色不做图例 = 让人猜）
      var chartText = (chartCard.textContent || '');
      chk('图上写明了柱子颜色的含义', /红/.test(chartText) && /黄/.test(chartText),
        '已找到含"红/黄"的颜色说明');
    }
  }

  // (10) 对比度：正文 / 说明文字 / 深色下的次级字都要过 AA
  var bodyTx = parseRGB(cs(document.body, 'color'));
  chk('正文对比度 >=7:1', contrast(over(bodyTx, bg), bg) >= 7, contrast(over(bodyTx, bg), bg).toFixed(2) + ':1');
  var hint = q('.hint');
  if (hint) {
    var hc = parseRGB(cs(hint, 'color'));
    var hbg = parseRGB(cs(hint.closest('.card') || document.body, 'background-color'));
    chk('说明文字对比度 >=4.5:1', contrast(over(hc, hbg), hbg) >= 4.5,
      contrast(over(hc, hbg), hbg).toFixed(2) + ':1');
  }
  var tab = q('#tabs a:not(.on)');
  if (tab) {
    var tc = parseRGB(cs(tab, 'color'));
    chk('未选中标签对比度 >=4.5:1', contrast(over(tc, bg), bg) >= 4.5, contrast(over(tc, bg), bg).toFixed(2) + ':1');
  }
  var tc2 = parseRGB(cs(q('.grid > .card > span') || document.body, 'color'));
  chk('统计卡说明字对比度 >=4.5:1', contrast(over(tc2, bg), bg) >= 4.5, contrast(over(tc2, bg), bg).toFixed(2) + ':1');

  // (11) 卡片：有描边 + 圆角（深色下不许只靠浅色阴影分层）
  var card = q('.card');
  if (card) {
    chk('卡片有 >=1px 描边', parseFloat(cs(card, 'border-top-width')) >= 1, cs(card, 'border-top-width'));
    chk('卡片圆角 >=14px', parseFloat(cs(card, 'border-top-left-radius')) >= 14, cs(card, 'border-top-left-radius'));
  }

  // (12) 主题开关：三段 + aria 齐全 + 恰好一个被按下
  var segBtns = document.querySelectorAll('#themeSeg button');
  chk('主题开关是 3 段', segBtns.length === 3, String(segBtns.length));
  var ariaOk = true;
  for (var s2 = 0; s2 < segBtns.length; s2++) {
    if (!segBtns[s2].getAttribute('aria-label') || !segBtns[s2].getAttribute('aria-pressed')) ariaOk = false;
  }
  chk('主题开关有 aria-label / aria-pressed', ariaOk);
  var pressed = document.querySelectorAll('#themeSeg button[aria-pressed="true"]');
  chk('恰好一个模式被标记为按下', pressed.length === 1, String(pressed.length));
  if (pressed.length === 1) {
    chk('按下的是当前生效的模式', pressed[0].getAttribute('data-theme-mode') === theme,
      pressed[0].getAttribute('data-theme-mode') + ' vs ' + theme);
  }

  // (13) 导航：当前页那一个高亮；**底部不许再有固定标签栏**（那会和 footer 抢同一条底边）
  var onTab = q('#tabs a.on');
  chk('当前页的标签处于高亮态', !!onTab, onTab ? onTab.textContent.trim() : '(无)');
  var navPos = q('#tabs') ? cs(q('#tabs'), 'position') : '';
  var fixedBottom = false;
  var navs = document.querySelectorAll('nav');
  for (var n2 = 0; n2 < navs.length; n2++) {
    var p = cs(navs[n2], 'position');
    if (p === 'fixed') {
      var r2 = navs[n2].getBoundingClientRect();
      if (r2.bottom > window.innerHeight - 4) fixedBottom = true;
    }
  }
  chk('没有压在底边的固定导航（会吃掉页面底部）', !fixedBottom, 'nav position=' + navPos);

  // (14) 禁用态可见（针对"状态要能被看见"）
  return { theme: theme, bad: bad, pass: pass };
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
    const url = await wsUrl();
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')));
    });
    const { send } = cdp(ws);

    let allPass = 0;
    const allBad = [];

    for (const theme of ['light', 'dark']) {
      const target = await send('Target.createTarget', { url: 'about:blank' });
      const att = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const sid = att.sessionId;

      // 把主题"烤进"打样页：插在防闪烁内联脚本之前，等价于"用户上次选了浅色/深色"
      const raw = fs.readFileSync(path.join(PRE, 'preview-overview.html'), 'utf8');
      const baked = raw.replace('<style>',
        '<script>try{localStorage.setItem("theme","' + theme + '")}catch(e){}</script><style>');
      const tmp = path.join(PRE, '_audit-' + theme + '.html');
      fs.writeFileSync(tmp, baked, 'utf8');

      await send('Page.enable', {}, sid);
      await send('Page.navigate', { url: 'file:///' + tmp.replace(/\\/g, '/') }, sid);
      await sleep(2200);   // 等打样页里的假请求都回来

      const r = await send('Runtime.evaluate', {
        expression: AUDIT_JS,
        returnByValue: true,
        awaitPromise: true,
      }, sid);

      if (r.exceptionDetails) {
        const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        console.log('❌ [' + theme + '] 页面内断言脚本抛错：' + (d || r.exceptionDetails.text));
        allBad.push('[' + theme + '] 断言脚本抛错');
      } else {
        const v = r.result.value;
        console.log('\n══════ ' + (theme === 'dark' ? '深色主题' : '浅色主题') +
          '（html[data-theme] = ' + v.theme + '）══════');
        v.pass.forEach((t) => console.log('  ✅ ' + t));
        allPass += v.pass.length;
        v.bad.forEach((t) => { console.log('  ❌ ' + t); allBad.push('[' + theme + '] ' + t); });
      }
      try { fs.unlinkSync(tmp); } catch (e) {}
    }

    console.log('\n════════════════════════════════════');
    console.log(' 通过 ' + allPass + ' 条，失败 ' + allBad.length + ' 条');
    if (allBad.length) { console.log(' ❌ 渲染体检没过，先修好再部署'); return 1; }
    console.log(' ✅ 浅色 / 深色两套渲染体检全部通过');
    return 0;
  } finally {
    try { proc.kill(); } catch (e) {}
  }
}

main().then((c) => process.exit(c))
      .catch((e) => { console.log('❌ 体检脚本失败：' + e.message); process.exit(1); });
