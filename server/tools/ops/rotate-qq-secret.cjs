// 替换 .env 里的 QQ_BOT_SECRET
//
// ⚠️ 不硬编码任何真实凭证 —— 新值通过命令行参数传入。
// 用法：node rotate-qq-secret.cjs <新Secret>
const fs = require('fs');

const ENV = process.env.XLJ_ENV_FILE || '/opt/xiaolanjing/.env';
const KEY = 'QQ_BOT_SECRET';
const NEW = process.argv[2];

if (!NEW) { console.error('用法: node rotate-qq-secret.cjs <新的AppSecret>'); process.exit(1); }
if (NEW.length < 16) { console.error('❌ Secret 看起来太短（' + NEW.length + ' 位），不确定是有效值'); process.exit(1); }

const orig = fs.readFileSync(ENV, 'utf8').replace(/\r/g, '');
const oldVal = (orig.match(new RegExp(`^${KEY}=(.*)$`, 'm')) || [])[1] || '';

const lines = orig.split('\n');
let changed = 0;
const out = lines.map((l) => {
  if (new RegExp(`^${KEY}=`).test(l)) { changed++; return `${KEY}=${NEW}`; }
  return l;
});
if (changed === 0) { out.push(`${KEY}=${NEW}`); changed = 1; }

fs.writeFileSync(ENV, out.join('\n'), { mode: 0o600 });

const after = fs.readFileSync(ENV, 'utf8');
const v = (after.match(new RegExp(`^${KEY}=(.*)$`, 'm')) || [])[1] || '';

console.log('  ✅ 已替换 ' + changed + ' 处');
console.log(`     ${KEY} 新值前 4 位: ${v.slice(0, 4)}`);
console.log(`     长度            : ${v.length}`);
console.log(`     旧值与新值相同吗: ${oldVal === NEW ? '是（没变？）' : '否（已更新）'}`);
console.log(`     文件权限        : ${(fs.statSync(ENV).mode & 0o777).toString(8)}`);
