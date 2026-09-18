// 验证日志页密码：服务在跑、进程加载了新密码、旧密码已失效
//
// ⚠️ 不硬编码任何密码 —— 旧密码通过环境变量 OLD_LOG_PASSWORD 传入（可选）。
// 用法：
//   node verify-logpw.cjs
//   OLD_LOG_PASSWORD=旧密码 node verify-logpw.cjs    # 顺便确认旧值已 401
const fs = require('fs');
const { execFileSync } = require('child_process');

const ENV = process.env.XLJ_ENV_FILE || '/opt/xiaolanjing/.env';
const OLD = process.env.OLD_LOG_PASSWORD || '';

const env = {};
for (const line of fs.readFileSync(ENV, 'utf8').replace(/\r/g, '').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const NEW = env.LOG_PASSWORD || '';
const PORT = process.env.PORT || 8080;

const httpCode = (url) => {
  try {
    return execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', url], { encoding: 'utf8' }).trim();
  } catch { return 'ERR'; }
};

console.log('  ════ 服务状态 ════');
console.log('   ', execFileSync('systemctl', ['show', '-p', 'ActiveEnterTimestamp', '--value', 'xiaolanjing-logweb'], { encoding: 'utf8' }).trim());
console.log('    运行中:', execFileSync('systemctl', ['is-active', 'xiaolanjing-logweb'], { encoding: 'utf8' }).trim());

const pid = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', 'xiaolanjing-logweb'], { encoding: 'utf8' }).trim();
const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
const procPw = (environ.find((kv) => kv.startsWith('LOG_PASSWORD=')) || '').replace('LOG_PASSWORD=', '');
console.log('    进程里的密码:', procPw.slice(0, 4) + '...(' + procPw.length + ' 位)');
console.log('    与 .env 一致:', procPw === NEW ? '✅ 是' : '❌ 不是（服务需重启？）');

console.log('\n  ════ 访问控制验证 ════');
const base = `http://127.0.0.1:${PORT}`;
const cases = [
  ['无密码', `${base}/`, '401'],
  ['错密码', `${base}/?p=definitely-wrong-password`, '401'],
  ['新密码', `${base}/?p=${encodeURIComponent(NEW)}`, '200'],
  ['新密码+API', `${base}/api/summary?p=${encodeURIComponent(NEW)}`, '200'],
];
if (OLD) cases.splice(1, 0, ['旧密码', `${base}/?p=${encodeURIComponent(OLD)}`, '401']);

let allOk = true;
for (const [label, url, want] of cases) {
  const got = httpCode(url);
  const ok = got === want;
  if (!ok) allOk = false;
  console.log(`    ${ok ? '✅' : '❌'} ${label.padEnd(12)} → HTTP ${got}  (期望 ${want})`);
}

console.log('\n  ════ 摘要内容 ════');
try {
  const body = execFileSync('curl', ['-s', '--max-time', '8', `${base}/api/summary?p=${encodeURIComponent(NEW)}`], { encoding: 'utf8' });
  body.trim().split('\n').slice(0, 5).forEach((l) => console.log('    ' + l));
} catch (e) { console.log('    读取失败:', e.message); }

console.log('\n  ' + (allOk ? '✅ 密码轮换成功（旧密码已失效，新密码可用）' : '❌ 有项目未达预期，需要检查'));
process.exit(allOk ? 0 : 1);
