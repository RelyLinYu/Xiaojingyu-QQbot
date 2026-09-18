// 验证 QQ Secret 轮换：进程环境 + 鉴权结果
const fs = require('fs');
const { execFileSync } = require('child_process');

const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8' }); } catch (e) { return (e.stdout || ''); } };

const ENV = '/opt/xiaolanjing/.env';
const env = {};
for (const line of fs.readFileSync(ENV, 'utf8').replace(/\r/g, '').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const fileSecret = env.QQ_BOT_SECRET || '';

const pid = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'xiaolanjing']).trim();
const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
const procSecret = (environ.find((kv) => kv.startsWith('QQ_BOT_SECRET=')) || '').replace('QQ_BOT_SECRET=', '');

console.log('  ════ 密钥一致性 ════');
console.log('    .env 里    :', fileSecret.slice(0, 4) + '...(' + fileSecret.length + ' 位)');
console.log('    进程中     :', procSecret.slice(0, 4) + '...(' + procSecret.length + ' 位)');
console.log('    一致       :', procSecret === fileSecret ? '✅ 是' : '❌ 否（服务可能没重启成功）');
console.log('    是新 Secret:', fileSecret.startsWith('X1W1') ? '✅ 是' : '❌ 不是');
console.log('    旧 Secret 残留:', fileSecret.startsWith('gwCT') ? '❌ 还在' : '✅ 已清除');

console.log('\n  ════ 服务状态 ════');
console.log('    机器人:', sh('systemctl', ['is-active', 'xiaolanjing']).trim());
console.log('    启动于:', sh('systemctl', ['show', '-p', 'ActiveEnterTimestamp', '--value', 'xiaolanjing']).trim());

console.log('\n  ════ 鉴权日志（关键）════');
const logs = sh('journalctl', ['-u', 'xiaolanjing', '--no-pager', '-o', 'cat', '-n', '200']);
const lines = logs.split('\n').filter(Boolean);
const interesting = lines.filter((l) => /鉴权成功|鉴权失败|token|错误|error|100007|11244|401|403|4014|4914|重连|网关/.test(l));
interesting.slice(-12).forEach((l) => console.log('    ' + l.trim()));

const okAuth = lines.filter((l) => /鉴权成功/.test(l)).length;
const badAuth = lines.filter((l) => /鉴权失败|100007|11244/.test(l)).length;
console.log('\n  ════ 结论 ════');
console.log('    鉴权成功次数:', okAuth);
console.log('    鉴权失败次数:', badAuth);
if (badAuth === 0 && okAuth > 0) console.log('    ✅ QQ Secret 轮换成功，机器人已用新 Secret 连上');
else if (badAuth > 0) console.log('    ❌ 有鉴权失败，需要检查');
else console.log('    ⚠️ 还没看到鉴权结果，再等几秒或看日志');
