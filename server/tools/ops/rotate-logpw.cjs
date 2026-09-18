// 轮换日志页密码：生成新密码 → 写入 .env → 打印
//
// ⚠️ 本脚本刻意**不硬编码任何旧密码** —— 旧值通过环境变量 OLD_LOG_PASSWORD 传入，
//    否则脚本本身就会把作废的密码留在仓库里（踩过这个坑）。
//
// 用法：
//   node rotate-logpw.cjs                       # 只生成并替换
//   OLD_LOG_PASSWORD=旧密码 node rotate-logpw.cjs  # 顺便验证旧值已清除
const fs = require('fs');
const crypto = require('crypto');

const ENV = process.env.XLJ_ENV_FILE || '/opt/xiaolanjing/.env';
const OLD = process.env.OLD_LOG_PASSWORD || '';   // 可选，仅用于校验

// 16 位随机密码，排除容易看混的 0/O、1/l/I
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const bytes = crypto.randomBytes(16);
let NEW = '';
for (let i = 0; i < 16; i++) NEW += ALPHABET[bytes[i] % ALPHABET.length];

const orig = fs.readFileSync(ENV, 'utf8').replace(/\r/g, '');
const lines = orig.split('\n');
const oldInFile = (orig.match(/^LOG_PASSWORD=(.*)$/m) || [])[1] || '';

let changed = 0;
const out = lines.map((l) => {
  if (/^LOG_PASSWORD=/.test(l)) { changed++; return `LOG_PASSWORD=${NEW}`; }
  return l;
});
if (changed === 0) { out.push(`LOG_PASSWORD=${NEW}`); changed = 1; }

fs.writeFileSync(ENV, out.join('\n'), { mode: 0o600 });

const after = fs.readFileSync(ENV, 'utf8');
const v = (after.match(/^LOG_PASSWORD=(.*)$/m) || [])[1] || '';

console.log('NEW_PASSWORD=' + v);
console.log('CHANGED=' + changed);
console.log('LEN=' + v.length);
console.log('MODE=' + (fs.statSync(ENV).mode & 0o777).toString(8));
if (OLD) {
  console.log('OLD_IN_FILE_BEFORE=' + (oldInFile === OLD ? 'yes' : 'no'));
  console.log('OLD_STILL_PRESENT=' + (after.includes(`LOG_PASSWORD=${OLD}`) ? 'yes' : 'no'));
}
