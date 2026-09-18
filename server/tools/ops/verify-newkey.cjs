// 用服务器 .env 里的新 Key 直连 DeepSeek，确认 Key 有效
const fs = require('fs');

const env = {};
for (const line of fs.readFileSync('/opt/xiaolanjing/.env', 'utf8').replace(/\r/g, '').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

console.log('  baseUrl :', env.AI_BASE_URL);
console.log('  模型    :', env.AI_REPLY_MODEL);
console.log('  Key 前缀:', (env.AI_API_KEY || '').slice(0, 9) + '...');
console.log('  Key 长度:', (env.AI_API_KEY || '').length);
console.log('');

(async () => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${env.AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: Buffer.from(JSON.stringify({
        model: env.AI_REPLY_MODEL || 'deepseek-flash',
        messages: [{ role: 'user', content: '回复两个字：正常' }],
        max_tokens: 20,
        thinking: { type: 'disabled' },
      }), 'utf8'),
    });
    const ms = Date.now() - t0;
    const j = await r.json();

    if (j.error) {
      console.log(`  ❌ 新 Key 不可用  HTTP ${r.status}  (${ms}ms)`);
      console.log(`     ${j.error.type || ''} ${j.error.code || ''} ${j.error.message || ''}`);
      process.exit(1);
    }

    const txt = j.choices?.[0]?.message?.content ?? '';
    console.log(`  ✅ 新 Key 可用  HTTP ${r.status}  (${ms}ms)`);
    console.log(`     模型回复: ${JSON.stringify(txt)}`);
    console.log(`     token 用量: 输入 ${j.usage?.prompt_tokens} / 输出 ${j.usage?.completion_tokens}`);
    process.exit(0);
  } catch (e) {
    console.log(`  ❌ 请求异常: ${e.message}`);
    process.exit(1);
  }
})();
