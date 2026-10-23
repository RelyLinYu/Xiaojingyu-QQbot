// 校验本地凭证文档：值是否为当前有效的、有没有残留作废值
const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, '..', 'private', '关键信息速查.md');
const c = fs.readFileSync(DOC, 'utf8');

const BACKTICK = String.fromCharCode(96);   // 反引号，避免被 shell 转义

const show = (label, pattern) => {
  const m = c.match(pattern);
  if (!m) { console.log(`  ❌ ${label.padEnd(18)} 缺失`); return null; }
  const v = m[1];
  console.log(`  ✅ ${label.padEnd(18)} ${v.slice(0, 7)}...  (${v.length} 位)`);
  return v;
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (field) => new RegExp('\\| \\*\\*' + esc(field) + '\\*\\* \\| ' + BACKTICK + '([^' + BACKTICK + ']+)' + BACKTICK);

console.log('  ════ 文档里的凭证 ════');
const ds = show('DeepSeek Key', row('API Key'));
const qq = show('QQ AppSecret', row('AppSecret'));
const pw = show('日志页密码', row('密码'));
const ow = show('主人 openid', row('主人 openid'));
const ip = show('服务器 IP', /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);

console.log('');
console.log('  ════ 是否残留已作废的值 ════');
//
// ⚠️ 作废值的**具体字面量不写在这个文件里** —— 本脚本要上传，
//    写进去等于把作废凭证又发布一遍（审计会报，也是踩过的坑）。
//    改从 .sanitize-patterns.local 读"作废/敏感特征"，那里已被 gitignore。
const PATTERN_FILE = path.join(__dirname, '..', 'private', '.sanitize-patterns.local');
let dead = [];
if (fs.existsSync(PATTERN_FILE)) {
  const raw = fs.readFileSync(PATTERN_FILE, 'utf8').replace(/\r/g, '');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [re, label = ''] = t.split('\t');
    // 只取"已作废但继续扫"这类（说明里带"旧"字）
    if (/旧/.test(label)) dead.push([label, new RegExp(re)]);
  }
}
if (!dead.length) {
  console.log('  ℹ️  .sanitize-patterns.local 里没有标记「旧」的特征，跳过');
} else {
  let bad = 0;
  for (const [n, re] of dead) {
    if (re.test(c)) { console.log(`  ⚠️  文档里仍含 ${n}`); bad++; }
  }
  if (bad === 0) console.log(`  ✅ 没有残留已作废的凭证（检查了 ${dead.length} 条）`);
}

console.log('');
console.log('  ════ 与服务器核对（前 9 位）════');
// ⚠️ 服务器地址不硬编码（本脚本要上传，写死 IP 会让审计报警）
const { execFileSync } = require('child_process');
const HOST = process.env.XLJ_HOST || '';
if (!HOST) {
  console.log('  ⏭️  未设 XLJ_HOST，跳过与服务器核对');
  console.log('     要核对请先：$env:XLJ_HOST="root@你的服务器IP"');
  process.exit(0);
}
try {
  const remote = execFileSync('ssh', [HOST,
    `grep -E '^(AI_API_KEY|QQ_BOT_SECRET|LOG_PASSWORD|BOT_OWNER_OPENID)=' /opt/xiaolanjing/.env | cut -c1-30`],
    { encoding: 'utf8' });
  const map = {};
  for (const l of remote.replace(/\r/g, '').split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) map[l.slice(0, i)] = l.slice(i + 1).trim();
  }
  const cmp = (label, localKey, remoteKey) => {
    const rv = map[remoteKey] || '';
    const ok = localKey && rv && localKey.slice(0, 9) === rv.slice(0, 9);
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(18)} ${ok ? '一致' : '不一致！'}  (服务器: ${rv.slice(0, 9)}...)`);
  };
  cmp('DeepSeek Key', ds, 'AI_API_KEY');
  cmp('QQ AppSecret', qq, 'QQ_BOT_SECRET');
  cmp('日志页密码', pw, 'LOG_PASSWORD');
  cmp('主人 openid', ow, 'BOT_OWNER_OPENID');
} catch (e) {
  console.log('  （无法连接服务器核对:', e.message.slice(0, 50), '）');
}
