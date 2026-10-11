// 视频"太长/太大"反馈提示的本地校验（纯配置 + 文案拼接，不发消息）
const cfg = require('../server/config');
const v = cfg.policy.linkParse.video;

console.log('=== 配置读取 ===');
console.log('skipTooLongTexts :', Array.isArray(v.skipTooLongTexts) ? v.skipTooLongTexts.length + ' 条' : '❌ 缺失');
console.log('skipTooBigTexts  :', Array.isArray(v.skipTooBigTexts) ? v.skipTooBigTexts.length + ' 条' : '❌ 缺失');
console.log('skipTipWithDirect:', v.skipTipWithDirect);
console.log('skipTipNoDirect  :', v.skipTipNoDirect);

const render = (tpl, vars) => {
  let s = String(tpl);
  for (const [k, val] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(val));
  return s;
};

console.log('\n=== 文案渲染样例 ===');
console.log('[抖音长视频 + 有直链]', render(v.skipTooLongTexts[0], { dur: '589 秒', limit: '60 秒', tip: v.skipTipWithDirect }));
console.log('[B站长视频 + 无直链]  ', render(v.skipTooLongTexts[1], { dur: '10 分钟', limit: '10 分钟', tip: v.skipTipNoDirect }));
console.log('[体积超限 + 有直链]    ', render(v.skipTooBigTexts[0], { mb: '79.2', limit: 30, tip: v.skipTipWithDirect }));
console.log('[体积超限 + 无直链]    ', render(v.skipTooBigTexts[1], { mb: '45.0', limit: 30, tip: v.skipTipNoDirect }));

console.log('\n=== 渲染后残留占位符检查（必须全为 0）===');
// ⚠️ 查的是**渲染结果**，不是模板原文 —— 模板里本来就该有 {dur}/{limit}/{tip}
//    （第一版这里写成查模板，4 条全红，属于断言本身写错）
const all = [...v.skipTooLongTexts, ...v.skipTooBigTexts];
let bad = 0;
for (const t of all) {
  const rendered = render(t, { dur: '1 分钟', limit: '1 分钟', mb: '1.0', tip: '（示例）' });
  const left = rendered.match(/\{[a-z]+\}/g);
  if (left) { console.log('❌ 渲染后仍有未替换占位符:', rendered, left); bad++; }
}
console.log(bad ? `❌ ${bad} 条有问题` : `✅ ${all.length} 条模板渲染后都没有残留占位符`);

// 确认 index.js 里两处都调用了
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'index.js'), 'utf8');
console.log('\n=== index.js 接线检查 ===');
console.log('noticeVideoSkip 已定义 :', src.includes('async function noticeVideoSkip'));
console.log('时长分支已调用         :', (src.match(/noticeVideoSkip\(d, groupOpenid, v, 'skipTooLongTexts'/g) || []).length, '处');
console.log('体积分支已调用         :', (src.match(/noticeVideoSkip\(d, groupOpenid, v, 'skipTooBigTexts'/g) || []).length, '处');
