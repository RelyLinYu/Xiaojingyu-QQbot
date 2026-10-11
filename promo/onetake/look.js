/* ============================================================
 *  look.js — 「deepwater」这个 look 是**为这支片子做的**（不是 looks/ 里的预设）。
 *
 *  为什么自己写而不用 look.py apply：
 *    片子 95% 的字是中文，looks/looks.json 里六个预设的三套 face 全是拉丁字体，
 *    中文只能靠系统回退；与其子集化一套西文字体再让中文回退（两套节奏打架），
 *    不如整套都用系统中文栈——渲染机就是这台 Windows，headless Chromium 的中文
 *    回退实测正常（_fonttest.png 验过），而且和机器人面板在用户浏览器里的观感一致。
 *
 *  颜色来自产品自己的面板配色，并遵守用户给的全局规范：
 *    深色底一律中性灰黑（#0B0B0D / #050506），禁止深蓝底；
 *    强调色只有一个（#0A84FF），accent2 只用于「踩雷」这一个语义。
 * ============================================================ */
(function () {
  var C = {
    ground:  '#0B0B0D',   // 画布的 70%
    deep:    '#050506',   // 井底、远处
    card:    '#1C1C1E',   // 浮在 ground 上的面
    line:    '#2E2E31',   // 发丝线
    mute:    '#8A8A90',   // 次级文字
    ink:     '#F5F5F7',   // 正文
    accent:  '#0A84FF',   // 唯一强调色
    accent2: '#FF453A'    // 只给「踩雷」
  };
  var STACK = '"Microsoft YaHei UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif';
  var MONO  = '"Cascadia Mono",Consolas,"Microsoft YaHei",monospace';
  var F = { display: STACK, text: STACK, mono: MONO };
  var T = {
    display: { weight: 700, tracking: '-0.02em' },
    text:    { weight: 450, tracking: '0' },
    mono:    { weight: 500, tracking: '0.01em' }
  };
  var s = document.documentElement.style;
  Object.keys(C).forEach(function (k) { s.setProperty('--' + k, C[k]); });
  s.setProperty('--display', F.display);
  s.setProperty('--text', F.text);
  s.setProperty('--mono', F.mono);
  s.setProperty('--display-weight', String(T.display.weight));
  s.setProperty('--display-tracking', T.display.tracking);

  window.LOOK = {
    name: 'deepwater',
    color: C,
    faces: F,
    /* canvas: ctx.font = LOOK.font('display', 96) */
    font: function (role, size) { return T[role].weight + ' ' + size + 'px ' + F[role]; },
    track: function (role) { return T[role].tracking; },
    ready: (document.fonts && document.fonts.ready) || Promise.resolve()
  };
})();
