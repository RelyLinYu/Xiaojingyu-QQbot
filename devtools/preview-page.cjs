// ============================================================
//  devtools/preview-page.cjs —— 本地"静态打样"：把 page.js 渲染成**可直接双击打开的 HTML**
//
//  🔴 为什么需要它（2026-10-08）：
//    改完 UI 不能只跑"语法能解析"就以为成了 —— 那只看得到"语法"，看不到"长得对不对"。
//    而线上面板要密码、要接口数据，改一次就得 scp + 重启，看两眼的成本太高。
//    ⇒ 这里把 /api/* 全部**桩住**（mock），产出一份自包含 HTML：
//        · 真实渲染 page.js 的模板（保真度 = 线上页面）；
//        · 数据用假数据（够把每个区块都填满，能看出排版问题）；
//        · 不需要服务器、不需要密码，浏览器直接开。
//    ⚠️ 它**不是**线上服务，也**不进**部署 —— 只在本地用眼睛验收用。
//
//  跑法： node devtools/preview-page.cjs
//  产物： devtools/_preview/preview-overview.html 等四个页面 + index.html（带跳转）
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { PAGE } = require(path.join(ROOT, 'server', 'tools', 'page.js'));
const OUT = path.join(__dirname, '_preview');

// ---------- 假数据（只为把界面填满，看排版；数值本身无意义）----------
const MOCK_DAYS = [];
(function () {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  // 数据区间挑得**有起伏但不极端**：柱子之间看得出高低差，眼睛才验得了"比例"。
  // 🔴 生成 **30 天**（不是 14 天）——因为页面上有 7/14/30 三档，
  //    假数据必须比最大档还多，才验得出"30 天档"是真生效。
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const calls = Math.round(1000 + rnd() * 1400);
    MOCK_DAYS.push({
      date: d.toISOString().slice(0, 10),
      md: (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0'),
      calls: calls,
      spent: Number((calls * 0.0037).toFixed(4)),
    });
  }
  // 🔴 2026-10-08 故意塞一个"新纪录"：最后一天（今天）给一个明显更大的值（3560 = 破了日上限 3000）。
  //    目的：把用户那条硬要求"**有新的最大值进入表格时不会被卡片固定高度挡住**"
  //    变成**每次跑体检都会被执行到**的场景 —— 光靠"今天的真实数据刚好没溢出"不算验证。
  MOCK_DAYS[MOCK_DAYS.length - 1].calls = 3560;
  MOCK_DAYS[MOCK_DAYS.length - 1].spent = 13.17;
})();

const MOCK = {
  '/api/state': {
    service: 'active',
    build: '2026-10-08 18:00',
    log: [
      '[2026-10-08 18:12:03] [群] 摸鱼小分队(123456789) 阿伟: 鱼你今天吃什么了',
      '[2026-10-08 18:12:04] [群] 摸鱼小分队(123456789) 决策: 轮到本次回复（@ 命中）',
      '[2026-10-08 18:12:06] [群] 摸鱼小分队(123456789) 回复: 喵呜~ 才不是吃鱼呢，你才是鱼！',
      '[2026-10-08 18:13:11] [私聊] 主人: 试一下新的人设看看',
      '[2026-10-08 18:13:15] [私聊] 决策: 不回（冷却中，剩 12 秒）',
    ].join('\n'),
    power: { on: true, by: '面板' },
    budget: {
      daySpent: 1.2345, dailyLimit: 3, spentYuan: 12.6789, totalLimit: 30,
      dayCalls: 812, dailyCallLimit: 3000, dayLeft: 1.7655,
    },
    settings: {
      aiApiKey:   { label: 'AI 密钥', value: 'sk-abc…(只显示前后几位)…8f21', secret: true },
      budgetDaily:{ label: '每日金额上限（元）', value: 3 },
      budgetTotal:{ label: '累计金额上限（元）', value: 30 },
      dailyCalls: { label: '每日调用次数上限', value: 3000 },
      personaText:{ label: '人设（system 提示词）', value: '你叫巧克力，是一只甜系傲娇的猫娘……（这行只是打样的占位文本）' },
    },
    convos: [
      { scope: 'group:123456789', kind: 'group', groupName: '摸鱼小分队', groupNo: '998877', realId: 'A1B2C3D4E5',
        who: '阿伟', time: '18:12:03', text: '鱼你今天吃什么了',
        decision: '回了：@ 命中', replies: ['喵呜~ 才不是吃鱼呢，你才是鱼！'], notes: ['收到一张图，已识别成文字'] },
      { scope: 'group:123456789', kind: 'group', groupName: '摸鱼小分队',
        who: '小美', time: '18:11:40', text: '(动图)',
        decision: '回了：命中关键词', replies: ['哼哼~ 又发这种图，阿巴阿巴'], notes: ['GIF 抽了 4 帧拼成网格'] },
      { scope: 'group:123456789', kind: 'group', groupName: '摸鱼小分队',
        who: '路人甲', time: '18:10:02', text: '今天的天气真好啊，适合出去走走',
        decision: '不回：跟鱼无关' },
      { scope: 'private:owner', kind: 'private', groupName: '主人',
        who: '主人', time: '18:13:11', text: '试一下新的人设看看',
        decision: '回了：主人身份', replies: ['喵呜！主人说什么都对~', '哼哼~ 这次就勉为其难夸你一下'] },
    ],
  },
  '/api/usage': { days: MOCK_DAYS },
  '/api/examples': {
    status: {
      fromFile: true,
      items: [
        { u: '鱼鱼在吗', a: '喵呜~ 在的在的，找本喵干嘛？' },
        { u: '你好笨', a: '哼哼！你才笨，杂鱼一个', role: '普通群员' },
        { u: '摸摸头', a: '喵呜~ 主人的话……那就勉强让你摸一下', role: '主人' },
        { u: '今天几号', a: '阿巴阿巴……本喵才不看日历呢', role: '普通群员' },
      ],
    },
  },
  '/api/presets': {
    ok: true,
    items: [
      { id: 'p1', name: '猫娘·傲娇·中二', active: true, usesDefault: false, personaChars: 761,
        personaEffectiveChars: 761, exampleCount: 17, preview: '你叫巧克力，是一只甜系傲娇的猫娘，偶尔中二' },
      { id: 'p2', name: '冷静毒舌', active: false, usesDefault: false, personaChars: 402,
        personaEffectiveChars: 402, exampleCount: 9, preview: '你说话短促、不解释、不哄人' },
      { id: 'p3', name: '默认人设', active: false, usesDefault: true, personaChars: 0,
        personaEffectiveChars: 646, exampleCount: 14, preview: '（用代码里那份默认人设）' },
    ],
  },
};

// ---------- 把页面脚本里的 fetch 换成"桩数据" ----------
// ⚠️ 只改**渲染产物**里的字符串，不动源文件：把 fetch(...) 包一层。
//    （用 String.replace 作用于渲染后的 HTML，源模板一个字都不动。）
function stubFetch(html) {
  const shim = `
<script>
(function(){
  var MOCK = ${JSON.stringify(MOCK)};
  var MOCK_DAYS = ${JSON.stringify(MOCK_DAYS)};
  var real = window.fetch;
  // 🔴 2026-10-08 修（用户报「切换天数貌似用不了」）：
  //    原来所有 /api/* 都返回同一份**固定**数据，于是 /api/usage 不管你传 days=7 还是 30，
  //    都回同一批 14 天 ⇒ 打样页上"7/14/30 天"按钮**点了没反应**（永远 14 根柱子）。
  //    但**真面板是好的**（logweb.js 里 days = usage.summary(n) 会真切片）——
  //    也就是说：是我的**打样工具在骗人**，让用户以为线上坏了。
  //    ⇒ 这里必须**看懂请求参数**再答，跟真实接口一个行为：按 days 取最后 N 天。
  //    ⚠️ 教训：桩数据不仿真 = 用假象验收，比不验收更坏。
  window.fetch = function (u, o) {
    try {
      var raw = String(u);
      var url = raw.split('?')[0];
      if (url === '/api/usage') {
        var m = /[?&]days=(\\d+)/.exec(raw);
        var n = m ? parseInt(m[1], 10) : 14;
        if (!n || n < 1) n = 14;
        var days = MOCK_DAYS.slice(Math.max(0, MOCK_DAYS.length - n));
        return Promise.resolve({ ok:true, status:200,
          json:function(){ return Promise.resolve({ ok:true, days:days }); },
          text:function(){ return Promise.resolve(JSON.stringify({ ok:true, days:days })); } });
      }
      if (MOCK[url]) {
        return Promise.resolve({ ok:true, status:200, json:function(){ return Promise.resolve(MOCK[url]); },
                                 text:function(){ return Promise.resolve(JSON.stringify(MOCK[url])); } });
      }
      if (real) return real.apply(window, arguments);
    } catch (e) {}
    return Promise.resolve({ ok:true, status:200, json:function(){ return Promise.resolve({ ok:true }); } });
  };
})();
</script>
`;
  // 插在页面主脚本**之前**（主脚本会在最后调 load()）
  return html.replace('</head>', shim + '</head>');
}

const PAGES = [
  { key: 'overview', title: '概览' },
  { key: 'chat', title: '对话' },
  { key: 'settings', title: '设置' },
  { key: 'raw', title: '日志' },
];

fs.mkdirSync(OUT, { recursive: true });
for (const p of PAGES) {
  const html = stubFetch(PAGE({ pwd: 'PREVIEW', page: p.key }));
  fs.writeFileSync(path.join(OUT, 'preview-' + p.key + '.html'), html, 'utf8');
  console.log('  ✅ preview-' + p.key + '.html  (' + html.length + ' 字符)');
}

// 一个中转页，方便一次点开四个
const index = `<!doctype html><meta charset="utf-8"><title>打样索引</title>
<style>
  body { font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; padding:40px; background:#F5F5F7; color:#1D1D1F; }
  h1 { font-size:22px; font-weight:600; letter-spacing:-.01em; }
  a { display:block; max-width:420px; margin:8px 0; padding:14px 18px; background:#fff; border:1px solid #D2D2D7;
      border-radius:14px; color:#0071E3; text-decoration:none; font-weight:500; }
  a:hover { box-shadow:0 8px 24px rgba(0,0,0,.06); }
  p { color:#6E6E73; font-size:14px; max-width:420px; }
</style>
<h1>面板打样（本地静态，数据是假的）</h1>
<p>点开任意一页看排版；右上角三段开关可切浅色 / 深色 / 跟随系统。</p>
${PAGES.map((p) => '<a href="preview-' + p.key + '.html">' + p.title + '</a>').join('\n')}
`;
fs.writeFileSync(path.join(OUT, 'index.html'), index, 'utf8');
console.log('\n产物目录：' + OUT);
console.log('打开：' + path.join(OUT, 'index.html'));
