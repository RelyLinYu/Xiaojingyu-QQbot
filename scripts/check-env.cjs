// ============================================================
//  scripts/check-env.cjs —— 部署前环境自检（零依赖）
//
//  用法：
//    node scripts/check-env.cjs              # 读 ./.env
//    node scripts/check-env.cjs path/to/.env # 读指定文件
//
//  退出码：0 = 可以启动（可能有警告）；1 = 有致命缺项
//  设计：只读不写；不打印任何密钥的值（只打印长度/前缀）
// ============================================================
const fs = require('fs');
const path = require('path');

const file = path.resolve(process.argv[2] || '.env');
const REQUIRED = ['QQ_BOT_APPID', 'QQ_BOT_SECRET', 'AI_API_KEY', 'LOG_PASSWORD'];

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

if (!fs.existsSync(file)) {
  console.error(`❌ 找不到 ${file}`);
  console.error('   先在项目根目录执行：cp .env.example .env，再把下面这些填进去：');
  console.error('   ' + REQUIRED.join(' / '));
  process.exit(1);
}

const env = parseEnv(fs.readFileSync(file, 'utf8'));
const problems = [];
const warnings = [];
const lines = [];

function mark(ok) { return ok ? '✅' : '❌'; }

// ---- 必填 ----
for (const k of ['QQ_BOT_APPID', 'QQ_BOT_SECRET', 'LOG_PASSWORD']) {
  const v = env[k];
  const ok = !!v && v.trim().length > 0;
  lines.push(`${mark(ok)} ${k}${ok ? '' : '（必填，空着）'}`);
  if (!ok) problems.push(k);
}

// ---- 逐项合理性 ----
if (env.QQ_BOT_APPID && !/^\d{5,12}$/.test(env.QQ_BOT_APPID)) {
  warnings.push('QQ_BOT_APPID 一般是一串纯数字（5~12 位），你填的看起来不像');
}
if (env.QQ_BOT_SECRET && env.QQ_BOT_SECRET.length < 16) {
  warnings.push('QQ_BOT_SECRET 太短，AppSecret 通常 ≥16 位');
}
if (env.QQ_BOT_SECRET && env.QQ_BOT_SECRET === env.QQ_BOT_APPID) {
  warnings.push('QQ_BOT_SECRET 和 AppID 一样，可能填错了');
}
if (env.AI_API_KEY) {
  if (!/^sk-/.test(env.AI_API_KEY)) warnings.push('AI_API_KEY 一般以 sk- 开头（DeepSeek）');
  lines.push(`✅ AI_API_KEY（${env.AI_API_KEY.slice(0, 3)}…，${env.AI_API_KEY.length} 位）`);
} else {
  lines.push('❌ AI_API_KEY（必填，空着）');
  problems.push('AI_API_KEY');
}
if (env.LOG_PASSWORD && env.LOG_PASSWORD.length < 6) {
  warnings.push('LOG_PASSWORD 建议至少 6 位（控制台口令）');
}
if (env.AI_BASE_URL && !/^https:\/\//.test(env.AI_BASE_URL)) {
  warnings.push('AI_BASE_URL 建议用 https:// …');
}
for (const k of ['BUDGET_DAILY_YUAN', 'BUDGET_TOTAL_YUAN']) {
  if (env[k] && !(Number(env[k]) > 0)) warnings.push(`${k} 应该是正数（当前 ${env[k]}）`);
}
if (!env.BOT_OWNER_OPENID) {
  warnings.push('BOT_OWNER_OPENID 空着：能用，但"主人专属"功能（关机/开机、记账、面板显示主人名）不会生效。拿法见 AGENT.md 第 4 节');
}

// ---- 输出 ----
console.log('环境自检：' + file);
console.log('—'.repeat(46));
for (const l of lines) console.log('  ' + l);
console.log('—'.repeat(46));

if (warnings.length) {
  console.log('提醒（不影响启动）：');
  for (const w of warnings) console.log('  ⚠️ ' + w);
}

if (problems.length) {
  console.error('\n❌ 还差必填项：' + problems.join(', '));
  console.error('   填进 ' + file + ' 后重跑本脚本。');
  process.exit(1);
}

console.log('\n✅ 必填项齐全，可以启动。');
process.exit(0);
