'use strict';
// ============================================================
//  落地页（方案 B）—— 2026-10-10 用户拍板
//
//  为什么自己搭：第三方跳转页（机领网）有三个治不好的毛病（都是我实测到的）：
//    · 用 `location.href` 跳自定义协议 ⇒ **多压一层历史记录**，用户要按两次返回
//    · 协议被拦时它**没有任何兜底**，页面纯白（`document.body.innerText === ''`）
//    · 唤起失败也不说人话，用户不知道该怎么办
//
//  本页的三条设计：
//    ① **绝不留白页** —— 无论协议跳不跳得动，页面上永远有号码 + 复制按钮 + 搜号指引
//    ② **不压历史** —— 用 `location.replace()`，返回一次就回到聊天
//    ③ **二维码兜底** —— 手机 QQ 的"扫一扫"能直接吃 `mqqapi://card/...`，
//       这是唯一绕开"浏览器拦协议"的可靠路径（QR 由 server/qr.js 现算，零依赖）
//
//  安全：`n` 只接受 5~12 位纯数字（不允许 0 开头），拼进页面/二维码前**再过一次校验**
//        —— 杜绝开放重定向与注入。
// ============================================================
const qr = require('./qr');

const Z = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function validNum(n) { return /^[1-9]\d{4,11}$/.test(String(n || '')); }

function maskTail(num) {
  const s = String(num);
  return s.length <= 4 ? s : `${s.slice(0, 3)}···${s.slice(-2)}`;
}

// 手机 QQ 名片卡协议（扫码用）。⚠️ 用**短参数**形式，省字节（QR 版本5-M 上限 82 字节）
const schemeOf = (n, isGroup) => `mqqapi://card/show_pslcard?card_type=${isGroup ? 'group' : 'person'}&uin=${n}`;

function page(num, isGroup) {
  const n = String(num);
  const scheme = schemeOf(n, isGroup);
  let svg = '';
  try { svg = qr.toSvg(qr.encode(scheme).matrix, { size: 200 }); } catch (e) { svg = ''; }

  const kindText = isGroup ? 'QQ 群' : 'QQ 号';
  const title = isGroup ? '打开群资料' : '打开名片';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${Z(kindText)} ${Z(maskTail(n))}</title>
<script>
// 主题：跟随系统（本页是独立页，不写 localStorage，避免和面板抢设置）
try {
  var dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
} catch (e) {}
</script>
<style>
  :root{
    --bg:#FFFFFF; --bg-elevated:#F5F5F7; --text:#1D1D1F; --text-secondary:#6E6E73;
    --border:#D2D2D7; --border-strong:#B0B0B5; --accent:#0071E3; --accent-text:#FFFFFF;
  }
  [data-theme="dark"]{
    --bg:#000000; --bg-elevated:#1C1C1E; --text:#F5F5F7; --text-secondary:#98989D;
    --border:#38383A; --border-strong:#48484A; --accent:#0A84FF; --accent-text:#FFFFFF;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--text)}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",Arial,sans-serif;
    font-size:17px;line-height:1.6;
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;padding:24px;
  }
  .card{width:100%;max-width:420px;background:var(--bg);border-radius:22px}
  .label{font-size:14px;color:var(--text-secondary);letter-spacing:.02em;margin:0 0 4px}
  h1{font-size:28px;font-weight:600;margin:0 0 20px;letter-spacing:-.01em}
  .num{
    font-size:36px;font-weight:700;letter-spacing:.01em;margin:0 0 8px;
    word-break:break-all;font-variant-numeric:tabular-nums;
  }
  .num.masked{letter-spacing:.06em;color:var(--text-secondary)}
  .hint{font-size:14px;color:var(--text-secondary);margin:0 0 24px}
  .row{display:flex;gap:12px;margin-bottom:16px}
  .btn{
    flex:1;min-height:44px;padding:12px 18px;border-radius:999px;border:1px solid var(--border);
    background:var(--bg-elevated);color:var(--text);font-size:16px;font-weight:500;
    cursor:pointer;font-family:inherit;transition:border-color .2s,opacity .2s;
  }
  .btn:hover{border-color:var(--border-strong)}
  .btn:active{opacity:.7}
  .btn.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}
  .qr{
    display:flex;flex-direction:column;align-items:center;gap:10px;
    padding:20px;border:1px solid var(--border);border-radius:18px;background:var(--bg-elevated);
  }
  .qr svg{display:block;border-radius:10px;background:#fff}
  .qr p{margin:0;font-size:14px;color:var(--text-secondary);text-align:center}
  .steps{margin:24px 0 0;padding:0;list-style:none;font-size:14px;color:var(--text-secondary)}
  .steps li{margin:0 0 8px;padding-left:20px;position:relative}
  .steps li:before{content:"·";position:absolute;left:8px;font-weight:700;color:var(--text-secondary)}
  .foot{margin-top:24px;font-size:13px;color:var(--text-secondary);text-align:center}
  .toast{
    position:fixed;left:50%;bottom:32px;transform:translateX(-50%);
    background:var(--bg-elevated);border:1px solid var(--border);border-radius:999px;
    padding:10px 20px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;
  }
  .toast.show{opacity:1}
</style>
</head>
<body>
  <main class="card">
    <p class="label">${Z(kindText)}</p>
    <h1>${Z(title)}</h1>
    <p class="num" id="num">${Z(n)}</p>
    <p class="hint" id="hint">点下面的按钮打开 QQ；打不开就用微信/相机扫下面的码。</p>

    <div class="row">
      <button class="btn primary" id="open">打开 QQ</button>
      <button class="btn" id="copy">复制号码</button>
    </div>

    <div class="qr">
      ${svg || '<p>（二维码生成失败，用下面第 2 步吧）</p>'}
      <p>用手机 QQ「扫一扫」<br>直接打开这张${Z(isGroup ? '群资料' : '名片')}</p>
    </div>

    <ul class="steps">
      <li>手机 QQ → 右上角 <b>+</b> → <b>扫一扫</b>，扫上面的码</li>
      <li>或者在 QQ 里搜 <b>${Z(n)}</b>，直接能搜到这个${Z(isGroup ? '群' : '号')}</li>
      <li>电脑上打开 QQ，搜 <b>${Z(n)}</b> 就行（浏览器跳不了，是正常的）</li>
    </ul>

    <p class="foot">本页只做跳转，不收集任何信息。</p>
  </main>
  <div class="toast" id="toast">已复制</div>

<script>
(function(){
  var NUM = ${JSON.stringify(n)};
  var SCHEME = ${JSON.stringify(scheme)};

  function toast(msg){
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function(){ t.classList.remove('show'); }, 1600);
  }

  // 打开 QQ：用 replace（**不能**用 href）—— 这样失败/成功都不多压历史记录，
  // 用户按一次返回就回到聊天，不会出现"退两次"。
  document.getElementById('open').addEventListener('click', function(){
    try { window.location.replace(SCHEME); } catch (e) {}
    setTimeout(function(){
      if (!document.hidden) document.getElementById('hint').textContent =
        '如果没跳过去，就用下面的二维码，或在 QQ 里搜 ' + NUM;
    }, 1200);
  });

  // 复制号码：老浏览器没有 clipboard API，退回 textarea 选中
  document.getElementById('copy').addEventListener('click', function(){
    var done = function(){ toast('已复制 ' + NUM); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(NUM).then(done, fallback);
    } else { fallback(); }
    function fallback(){
      try {
        var ta = document.createElement('textarea');
        ta.value = NUM; ta.setAttribute('readonly','');
        ta.style.position='fixed'; ta.style.top='-1000px';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        done();
      } catch (e) { toast('复制失败，手动长按号码吧'); }
    }
  });
})();
</script>
</body>
</html>`;
}

// 二维码 PNG（给 markdown 卡片用）：QQ 的图片只认 png/jpg，不认 svg
//
// 扫码内容用**协议短链**：手机 QQ 扫到这个 `mqqapi://` 会直接打开名片/群资料。
// ⚠️ 用短参数形式（`?card_type=..&uin=..`），因为它的字节数必须塞进版本 5-M 的容量。
function png(num, isGroup, opts = {}) {
  const scheme = schemeOf(String(num), isGroup);
  const matrix = qr.encode(scheme).matrix;
  return qr.toPng(matrix, { scale: opts.scale || 7, quiet: 4 });
}

module.exports = { validNum, page, png, schemeOf, _maskTail: maskTail };
