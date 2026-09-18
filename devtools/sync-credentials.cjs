// 从服务器 .env 读真实凭证，同步进本地「关键信息速查.md」
//
// 用途：服务器改了 .env 后，用它把本地文档对齐（避免文档里是过期的旧值）。
// 安全：真值只在内存和本地文件里传递，**不打印到终端**。
//
// 用法（在本机跑）：
//   $env:XLJ_HOST="root@<服务器IP>"; node devtools/sync-credentials.cjs
//
// ⚠️ 服务器地址**不硬编码** —— 本脚本是要上传的，
//    写死 IP 会让每次推送前审计都报警（踩过这个坑）。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, '..', 'private', '关键信息速查.md');
const HOST = process.env.XLJ_HOST || '';
if (!HOST) {
  console.error('❌ 需要指定服务器地址：');
  console.error('     $env:XLJ_HOST="root@你的服务器IP"');
  console.error('     node devtools/sync-credentials.cjs');
  console.error('   （IP 见 private/关键信息速查.md 第 1 节）');
  process.exit(1);
}

// 在服务器上读 .env，只输出需要的键值（每行 KEY=VALUE）
const remoteScript = `
const fs=require('fs');
const e={};
for (const l of fs.readFileSync('/opt/xiaolanjing/.env','utf8').replace(/\\r/g,'').split('\\n')) {
  const m = l.match(/^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)$/);
  if (m) e[m[1]] = m[2].trim();
}
for (const k of ['AI_API_KEY','QQ_BOT_APPID','QQ_BOT_SECRET','LOG_PASSWORD','BOT_OWNER_OPENID','BOT_OWNER_NAME','AI_BASE_URL']) {
  if (e[k]) console.log(k + '=' + e[k]);
}
`;

let raw;
try {
  raw = execFileSync('ssh', [HOST, `node -e "${remoteScript.replace(/"/g, '\\"')}"`], { encoding: 'utf8' });
} catch (e) {
  console.error('❌ 读取服务器 .env 失败:', e.message);
  process.exit(1);
}

const env = {};
for (const line of raw.replace(/\r/g, '').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

if (!env.AI_API_KEY) { console.error('❌ 没读到 AI_API_KEY'); process.exit(1); }

let doc = fs.readFileSync(DOC, 'utf8');
const before = doc;

// 1) DeepSeek API Key 行
doc = doc.replace(/(\| \*\*API Key\*\* \| `)[^`]*(` \|)/, `$1${env.AI_API_KEY}$2`);
// 2) QQ AppSecret 行
doc = doc.replace(/(\| \*\*AppSecret\*\* \| `)[^`]*(` \|)/, `$1${env.QQ_BOT_SECRET}$2`);
// 3) 日志页密码（正文 + 访问地址里的 ?p=）
doc = doc.replace(/(\| \*\*密码\*\* \| `)[^`]*(` \|)/, `$1${env.LOG_PASSWORD}$2`);
doc = doc.replace(/(\?p=)[A-Za-z0-9]+/g, `$1${env.LOG_PASSWORD}`);
// 4) 主人 openid
doc = doc.replace(/(\| \*\*主人 openid\*\* \| `)[^`]*(` \|)/, `$1${env.BOT_OWNER_OPENID}$2`);

const changed = doc !== before;
if (changed) fs.writeFileSync(DOC, doc, { mode: 0o600 });

// 只报告"改没改"，不打印值
console.log('  ' + (changed ? '✅ 已同步' : '（无需改动）'));
const check = (label, val) => {
  const inDoc = doc.includes(val);
  console.log(`  ${inDoc ? '✅' : '❌'} ${label.padEnd(18)} ${inDoc ? '已写入' : '缺失'}  (${val.length} 位)`);
};
check('DeepSeek API Key', env.AI_API_KEY);
check('QQ AppSecret', env.QQ_BOT_SECRET);
check('日志页密码', env.LOG_PASSWORD);
check('主人 openid', env.BOT_OWNER_OPENID);
