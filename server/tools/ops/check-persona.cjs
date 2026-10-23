// 服务器上的人设配置体检（用 node 直接跑，避免 shell 编码问题）
process.env.XLJ_NO_PERSIST = '1';
const c = require('/opt/xiaolanjing/config.js');
const P = c.persona;
const angry = P.examples.filter((e) => /胖|肥/.test(e.u));

const rows = [
  ['提示词字数', P.systemPrompt.length],
  ['示例对话组数', P.examples.length],
  ['生气类变体数', angry.length],
  ['习惯动作段落', /习惯动作/.test(P.systemPrompt) ? '有' : '无'],
  ['半角括号示例', /\(尾鳍啪地甩过来\)/.test(P.systemPrompt) ? '有' : '无'],
  ['"话少"是否已移除', /话少/.test(P.systemPrompt) ? '否(仍在)' : '是(已移除)'],
  ['反重复机制', c.antiRepeat.enabled ? `开启(${c.antiRepeat.historySize}条)` : '关闭'],
  ['maxSegments', c.splitReply.maxSegments],
  ['scoreThreshold', c.policy.scoreThreshold],
  ['sampleNonKeyword', c.policy.sampleNonKeyword],
];
for (const [k, v] of rows) console.log(`  ${k.padEnd(20, ' ')} : ${v}`);

console.log('');
console.log('  生气类变体明细:');
for (const e of angry) console.log(`    ${e.u}  ->  ${e.a}`);
