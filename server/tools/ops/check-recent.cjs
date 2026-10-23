const { execFileSync } = require('child_process');

const logs = execFileSync('journalctl', ['-u', 'xiaolanjing', '--no-pager', '-o', 'cat', '-n', '120'], { encoding: 'utf8' });
const lines = logs.split('\n');

const aiCalls = lines.filter((l) => /\[ai\]/.test(l));
const auth = lines.filter((l) => /鉴权成功/.test(l));
const sends = lines.filter((l) => /\[send:(group|private)\]/.test(l));
const errs = lines.filter((l) => /401|403|Insufficient|invalid_api_key|Authentication/i.test(l));

console.log('  ════ 重启后（13:31:42 起）的运行情况 ════');
console.log(`  鉴权成功    : ${auth.length} 次`);
console.log(`  模型调用    : ${aiCalls.length} 次`);
console.log(`  成功发送    : ${sends.length} 条`);
console.log(`  认证类错误  : ${errs.length} 次  ${errs.length === 0 ? '✅' : '❌'}`);
console.log('');

if (auth.length) console.log('  最近鉴权:', auth[auth.length - 1].trim());
for (const s of sends.slice(-3)) console.log('  发送    :', s.trim());

if (errs.length) {
  console.log('\n  ⚠️ 发现认证相关错误：');
  errs.slice(0, 5).forEach((e) => console.log('   ', e.trim()));
} else if (aiCalls.length === 0) {
  console.log('  （重启后还没有新的模型调用 —— 群里没人说话就是正常的）');
  console.log('   可以自己发一条消息触发，再看这里。');
} else {
  console.log('\n  ✅ 新 Key 已在线上正常工作');
}
