#!/usr/bin/env node
// ============================================================
//  生成诊断 —— 看机器人到底"生成了什么内容"
//
//  背景：日志显示 [ai] out=6~9（很短），紧接着发送报 40011000「请求数据异常」。
//  怀疑：模型返回的 content 太短、是空白、或含异常字符，导致 QQ 拒收。
//
//  这个脚本用**和线上完全一样的参数**调用 DeepSeek，把原始返回整个打出来，
//  并用 JSON.stringify 显示真实字符（能看出有没有空白/不可见字符）。
//
//  用法（服务器上）： cd /opt/xiaolanjing && node tools/gen-diagnose.js
//  只读：不往群里发任何东西。
// ============================================================

const fs = require('fs');
const path = require('path');

const env = {};
const envText = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').replace(/\r/g, '');
for (const line of envText.split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const KEY = env.AI_API_KEY;
const BASE = env.AI_BASE_URL || 'https://api.deepseek.com';
const MODEL = env.AI_REPLY_MODEL || 'deepseek-flash';

const cfg = require('../config.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 复刻 brain.js generateReply 的拼装
// 🆕 2026-10-24 同步 brain：删掉硬拼昵称（身份唯一真源 = 人设）
const SYS = cfg.persona.systemPrompt
  + String.fromCharCode(10, 10) + '直接说话，不要加昵称前缀，不要任何解释。';

function buildUser(who, name, text) {
  return `群里最近的对话：\n小明: 大家好\n\n`
    + `现在，【${who}】${name} 说：${text}\n\n`
    + `注意：上面标注的身份决定了你该用哪套规则。你要接一句：`;
}

const CASES = ['你好', '你喜欢吃什么', '你是谁的'];

(async () => {
  console.log('================================================================');
  console.log(' 生成诊断：机器人到底生成了什么');
  console.log('================================================================');
  console.log(`模型     : ${MODEL}`);
  console.log(`max_tokens: ${cfg.ai.replyMaxTokens}`);
  console.log(`thinking : ${cfg.ai.thinking}`);
  console.log(`persona  : ${cfg.persona.name}`);
  console.log('');

  for (const q of CASES) {
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: buildUser('主人', '小明', q) },
      ],
      max_tokens: cfg.ai.replyMaxTokens,
      temperature: 0.9,
      thinking: { type: cfg.ai.thinking },
    };

    console.log('────────────────────────────────────────────────');
    console.log(`问: ${q}`);
    console.log(`请求体: ${JSON.stringify(body).slice(0, 200)}...`);

    try {
      const t0 = Date.now();
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${KEY}` },
        body: Buffer.from(JSON.stringify(body), 'utf8'),
      });
      const text = await res.text();
      console.log(`HTTP ${res.status}  (${Date.now() - t0}ms)`);

      let j;
      try { j = JSON.parse(text); } catch { console.log('返回非 JSON:', text.slice(0, 300)); continue; }
      if (j.error) { console.log('❌ 模型报错:', JSON.stringify(j.error)); continue; }

      const msg = j.choices?.[0]?.message || {};
      const content = msg.content;
      const rc = msg.reasoning_content;

      console.log(`usage: ${JSON.stringify(j.usage)}`);
      console.log(`finish_reason: ${j.choices?.[0]?.finish_reason}`);
      console.log(`content 原始   : ${JSON.stringify(content)}`);
      console.log(`content 长度   : ${content == null ? 'null' : String(content).length}`);
      console.log(`content trim 后: ${JSON.stringify(String(content ?? '').trim())}`);
      console.log(`trim 后长度    : ${String(content ?? '').trim().length}`);
      if (rc) console.log(`⚠️ 有 reasoning_content（长度 ${rc.length}）—— 我们只取 content，这段会被丢弃`);
      console.log(`message 的所有键: ${Object.keys(msg).join(', ')}`);

      // 逐字符检查有没有异常
      const s = String(content ?? '');
      const weird = [...s].filter((ch) => ch.charCodeAt(0) < 32 && ch !== '\n' && ch !== '\t');
      if (weird.length) console.log(`⚠️ 含控制字符: ${weird.map((c) => 'U+' + c.charCodeAt(0).toString(16)).join(' ')}`);
    } catch (e) {
      console.log('❌ 请求异常:', e.message);
    }
    console.log('');
    await sleep(2500);
  }

  console.log('================================================================');
  console.log(' 怎么看');
  console.log('================================================================');
  console.log('  · 如果 content 是 null 或 trim 后为空 → 就是它导致 QQ 报 40011000');
  console.log('  · 如果 content 只有 1~2 个字 → 也算"太短"，QQ 可能当无效数据');
  console.log('  · 如果 content 正常（有实际内容）→ 那问题在发送环节，不是生成');
  console.log('  · 如果 finish_reason=length → max_tokens 不够，内容被截断');
})();
