const { execSync } = require('child_process');
const fs = require('fs');

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

console.log('════════ 1. 成功登录记录（谁进来了） ════════');
const w = sh('last -a -n 25');
console.log(w || '(无记录)');

console.log('════════ 2. 当前在线的连接 ════════');
console.log(sh('who -a') || '(无)');

console.log('════════ 3. 按来源 IP 统计成功登录次数 ════════');
const lines = sh('last -a -n 200').split('\n').filter(Boolean);
const ipCount = {};
for (const l of lines) {
  const m = l.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (m) ipCount[m[1]] = (ipCount[m[1]] || 0) + 1;
}
const sorted = Object.entries(ipCount).sort((a, b) => b[1] - a[1]);
for (const [ip, n] of sorted) console.log(`  ${ip.padEnd(18)} ${n} 次`);
if (!sorted.length) console.log('  (无)');

console.log('');
console.log('════════ 4. ⚠️ 暴力破解尝试统计 ════════');
const failed = sh('journalctl -u ssh --no-pager -o cat 2>/dev/null || grep -h "Failed password" /var/log/auth.log 2>/dev/null');
if (failed) {
  const badIps = {};
  for (const l of failed.split('\n')) {
    if (/Failed password|Invalid user/.test(l)) {
      const m = l.match(/from\s+(\d{1,3}(?:\.\d{1,3}){3})/);
      if (m) badIps[m[1]] = (badIps[m[1]] || 0) + 1;
    }
  }
  const bs = Object.entries(badIps).sort((a, b) => b[1] - a[1]);
  console.log(`  失败尝试的独立 IP 数: ${bs.length}`);
  console.log('  尝试最多的前 10 个:');
  for (const [ip, n] of bs.slice(0, 10)) console.log(`    ${ip.padEnd(18)} ${n} 次`);
} else {
  console.log('  (读不到认证日志)');
}

console.log('');
console.log('════════ 5. 可疑账户 / 后门检查 ════════');
// 能动 SSH 的账户
const passwd = fs.readFileSync('/etc/passwd', 'utf8');
const shells = passwd.split('\n').filter((l) => /\/bin\/(ba)?sh$/.test(l)).map((l) => l.split(':')[0]);
console.log('  可登录账户:', shells.join(', '));

// authorized_keys 里有几把钥匙
for (const u of ['root']) {
  const p = `/root/.ssh/authorized_keys`;
  if (fs.existsSync(p)) {
    const keys = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    console.log(`  ${u} 的 authorized_keys: ${keys.length} 把`);
    keys.forEach((k, i) => console.log(`    ${i + 1}. ${k.slice(0, 60)}...  [${(k.match(/(\S+)$/) || [])[1] || ''}]`));
  }
}

// 有没有异常的计划任务
console.log('');
console.log('════════ 6. 计划任务（后门常藏这里）════════');
console.log('  root crontab :', (sh('crontab -l 2>/dev/null') || '').trim() || '(空)');
console.log('  /etc/cron.d  :', (sh('ls /etc/cron.d 2>/dev/null') || '').trim() || '(空)');

console.log('');
console.log('════════ 7. 最近创建的账户（如有入侵会有新号）════════');
console.log(sh('awk -F: \'$3>=1000 && $3<65534 {print $1, $3}\' /etc/passwd').trim() || '(无普通用户)');
