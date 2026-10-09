// URL 提取修复的验证（纯函数，本地跑）
const lp = require('../server/linkparse');

const CASES = [
  // 🔴 线上翻车的真实原文（测试群 19:01）
  ['翻车原文', 'https://github.com/lyogavin/airllm可以研究一下这个', 'https://github.com/lyogavin/airllm'],
  ['翻车原文2', 'https://github.com/lyogavin/airllm可以研究一下这个', 'https://github.com/lyogavin/airllm'],
  // 常规
  ['抖音短链', '5.82 复制打开抖音 https://v.douyin.com/ZA-bMrnmnh4/ 看看', 'https://v.douyin.com/ZA-bMrnmnh4/'],
  ['B站', 'https://www.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/video/BV1xx411c7mD'],
  ['中文标点分隔', '看看这个 https://b23.tv/xxx 挺好笑', 'https://b23.tv/xxx'],
  ['中文逗号紧贴', '看这个https://b23.tv/xxx，挺好', 'https://b23.tv/xxx'],
  ['带查询参数', 'https://github.com/a/b?w_rid=abc&wts=123', 'https://github.com/a/b?w_rid=abc&wts=123'],
  ['代码仓带#', 'https://github.com/a/b#readme', 'https://github.com/a/b#readme'],
  ['emoji 紧跟', 'https://github.com/a/b🎉', 'https://github.com/a/b'],
  ['日文紧跟', 'https://github.com/a/bこれ見て', 'https://github.com/a/b'],
  ['韩文紧跟', 'https://github.com/a/b이거봐', 'https://github.com/a/b'],
  ['右括号紧跟', '（见 https://github.com/a/b）', 'https://github.com/a/b'],
  ['句号结尾', '详见 https://github.com/a/b.', 'https://github.com/a/b'],
  ['纯链接无尾随', 'https://github.com/lyogavin/airllm', 'https://github.com/lyogavin/airllm'],
  ['中文在前', '地址是https://github.com/a/b吗', 'https://github.com/a/b'],
];

let pass = 0, fail = 0;
for (const [name, input, want] of CASES) {
  const got = lp.extractUrls(input);
  const first = got[0] || '(空)';
  const ok = first === want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(14)} → ${first}`);
  if (!ok) console.log(`     期望: ${want}`);
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${CASES.length}）`);
process.exit(fail ? 1 : 0);
