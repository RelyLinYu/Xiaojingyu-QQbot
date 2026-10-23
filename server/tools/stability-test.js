#!/usr/bin/env node
// ============================================================
//  稳定性测试：免费模型到底稳不稳？
//
//  这是"要不要花钱"的决策依据。在充值前跑它，别盲目充。
//
//  做法：对同一个简单问题连问 N 次，统计成功率、耗时、有没有敷衍。
//  如果连"中国的首都是哪"都答不稳，那付费就是正解；
//  如果 10 次全对，说明问题在别处，充钱也白搭。
//
//  用法（服务器上）： cd /opt/xiaolanjing && node tools/stability-test.js
//  可选：ST_MODEL=glm-4-flash ST_N=15 node tools/stability-test.js
//  只读：不发 QQ 消息、不写文件、不改服务。
// ============================================================

const fs = require('fs');
const path = require('path');

// ---------- 读 .env（必须先去 \r）----------
const env = {};
const envText = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').replace(/\r/g, '');
for (const line of envText.split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const KEY = env.AI_API_KEY;
const BASE = env.AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
if (!KEY) { console.error('❌ .env 里没有 AI_API_KEY'); process.exit(1); }

const cfg = require('../config.js');

// ---------- 配置 ----------
const MODEL = process.env.ST_MODEL || cfg.ai.replyModel || 'glm-4.7-flash';
const N = Number(process.env.ST_N) || 10;
const GAP_MS = Number(process.env.ST_GAP_MS) || 3000;

// ---------- 测试用例 ----------
const PROBE = { q: '中国的首都是哪', need: /北京/, label: '常识问答（应答"北京"）' };
const PROBE2 = { q: '1+1等于几', need: /2|二/, label: '算术（应答"2"）' };

// 人设里那些"敷衍词"—— 命中说明它在打太极
const DEFLECT = /^[\s。！？~…]*(嗯+|哦+|行吧|嗯，行吧|这个我熟|这个我懂|……沉了|沉了|水太深，我潜了|不知道|不清楚|在嘛|在干嘛)[\s。！？~…]*$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(probe) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: cfg.persona.systemPrompt },
      { role: 'user', content: `现在，【主人】小明 说：${probe.q}\n\n你要接一句：` },
    ],
    max_tokens: 120,
    temperature: 0.9,
    thinking: { type: 'disabled' },
  };
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${KEY}` },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));

    const j = await res.json();
    const ms = Date.now() - t0;
    if (j.error) return { ok: false, kind: '限流/过载', detail: `${j.error.code}: ${j.error.message}`, ms };
    const text = String(j.choices?.[0]?.message?.content || '').trim();
    if (!text) return { ok: false, kind: '空回复', detail: '(空)', ms };
    if (DEFLECT.test(text)) return { ok: false, kind: '敷衍', detail: text, ms };
    if (!probe.need.test(text)) return { ok: false, kind: '答非所问', detail: text, ms };
    return { ok: true, kind: '正常', detail: text, ms };
  } catch (e) {
    return { ok: false, kind: e.name === 'AbortError' ? '超时(60s)' : '网络错误', detail: e.message, ms: Date.now() - t0 };
  }
}

(async () => {
  console.log('================================================================');
  console.log(' 稳定性测试：这个模型到底能不能用？');
  console.log('================================================================');
  console.log(`模型   : ${MODEL}`);
  console.log(`次数   : ${N} 次 × 2 个问题 = ${N * 2} 次调用`);
  console.log(`间隔   : ${GAP_MS}ms`);
  console.log(`预计   : 约 ${Math.ceil((N * 2 * (GAP_MS + 3000)) / 60000)} 分钟`);
  console.log('');

  const all = [];
  const t0 = Date.now();

  for (const probe of [PROBE, PROBE2]) {
    console.log(`──── ${probe.label} ────`);
    const rows = [];
    for (let i = 1; i <= N; i++) {
      const r = await once(probe);
      rows.push(r);
      all.push(r);
      const mark = r.ok ? '✅' : '❌';
      console.log(`  ${String(i).padStart(2)}. ${mark} ${r.detail}   (${r.ms}ms${r.ok ? '' : ' · ' + r.kind})`);
      if (i < N) await sleep(GAP_MS);
    }
    const okN = rows.filter((r) => r.ok).length;
    const times = rows.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`  → ${okN}/${N} 成功   中位耗时 ${times[Math.floor(times.length / 2)]}ms   最慢 ${times[times.length - 1]}ms`);
    console.log('');
    if (probe !== PROBE2) await sleep(GAP_MS);
  }

  // ---------- 汇总 ----------
  const total = all.length;
  const ok = all.filter((r) => r.ok).length;
  const byKind = {};
  for (const r of all) if (!r.ok) byKind[r.kind] = (byKind[r.kind] || 0) + 1;

  const times = all.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];

  console.log('================================================================');
  console.log(' 汇总');
  console.log('================================================================');
  console.log(`  总调用     : ${total} 次，耗时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  console.log(`  成功率     : ${ok}/${total} = ${Math.round((ok / total) * 100)}%`);
  console.log(`  耗时 P50/P95: ${p50}ms / ${p95}ms`);
  if (Object.keys(byKind).length) {
    console.log('  失败分布   :');
    for (const [k, v] of Object.entries(byKind)) console.log(`     ${k}: ${v} 次`);
  }

  console.log('');
  console.log('================================================================');
  console.log(' 结论');
  console.log('================================================================');
  const rate = ok / total;
  if (rate >= 0.95) {
    console.log('  ✅ 成功率 ≥95% —— 模型本身没问题。');
    console.log('     "嗯，行吧" 那次可能是偶发，或提示词/上下文问题，');
    console.log('     **不建议马上充钱**，先把提示词方向查透。');
  } else if (rate >= 0.7) {
    console.log('  ⚠️ 成功率 70~95% —— 明显不稳，但不至于不可用。');
    console.log('     充钱换付费模型会有改善，提升幅度中等。');
  } else {
    console.log('  ❌ 成功率 <70% —— 免费额度确实不可靠。');
    console.log('     **充钱换 DeepSeek 是正解**，这个成功率下机器人用着很难受。');
  }
  console.log('');
  console.log(`  （本次测得模型：${MODEL}）`);
})();
