// 轮换前的状态快照
const fs = require('fs');
const { execFileSync } = require('child_process');

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch (e) { return 'ERR'; } };

const ENV = '/opt/xiaolanjing/.env';
const env = {};
for (const line of fs.readFileSync(ENV, 'utf8').replace(/\r/g, '').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

console.log('  ════ 当前 QQ 凭证 ════');
console.log('    AppID        :', env.QQ_BOT_APPID);
console.log('    AppSecret    :', (env.QQ_BOT_SECRET || '').slice(0, 4) + '...(' + (env.QQ_BOT_SECRET || '').length + ' 位)');

console.log('\n  ════ 回退保障 ════');
const baks = fs.readdirSync('/opt/xiaolanjing').filter((f) => f.startsWith('.env.bak'));
for (const b of baks) {
  const c = fs.readFileSync(`/opt/xiaolanjing/${b}`, 'utf8');
  const s = (c.match(/^QQ_BOT_SECRET=(.*)$/m) || [])[1] || '';
  const st = fs.statSync(`/opt/xiaolanjing/${b}`);
  console.log(`    ${b.padEnd(28)} Secret ${s.slice(0, 4)}...(${s.length} 位)  ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}`);
}

console.log('\n  ════ 服务状态 ════');
console.log('    机器人:', sh('systemctl', ['is-active', 'xiaolanjing']));
console.log('    启动于:', sh('systemctl', ['show', '-p', 'ActiveEnterTimestamp', '--value', 'xiaolanjing']));
console.log('    日志页:', sh('systemctl', ['is-active', 'xiaolanjing-logweb']));

console.log('\n  ════ 最近一次鉴权（确认当前 Secret 有效）════');
const logs = sh('journalctl', ['-u', 'xiaolanjing', '--no-pager', '-o', 'cat', '-n', '150']);
const authLines = logs.split('\n').filter((l) => /鉴权成功|错误|401|100007/.test(l));
authLines.slice(-3).forEach((l) => console.log('    ' + l.trim()));

console.log('\n  ════ 轮换工具是否就绪 ════');
console.log('    rotate-qq-secret.cjs:', fs.existsSync('/tmp/rotate-qq.cjs') ? 'ready' : '（尚未上传，稍后传）');
