#!/usr/bin/env node
// ============================================================
//  提示词诊断 v2 —— 完全复刻线上代码路径
//
//  v1 的教训：
//    1. 只测了简化调用，没复刻 generateReply() 的完整拼装 → 线上 bug 没复现
//    2. 判定太宽（"百度？这个我熟"含"百度"就被判合格）→ 漏掉打太极
//    3. 没测身份标注那句尾缀是不是元凶
//
//  这一版：
//    - 用与 brain.js generateReply() 逐字一致的 sys/user 拼装
//    - 判定改成"必须出现答案实体，且不要打太极"
//    - 额外测"去掉身份尾缀"的变体，定位真凶
//
//  用法（服务器上跑）： cd /opt/xiaolanjing && node tools/prompt-diagnose.js
//  只读：不写文件、不改服务。
// ============================================================

const fs = require('fs');
const path = require('path');

// ---------- 读 .env（必须先去 \r，否则整行读不到）----------
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
const NEW_PROMPT = cfg.persona.systemPrompt;
const PERSONA_NAME = cfg.persona.name;

// 线上代码给 system 拼接的后缀（取自 brain.js generateReply）
const SYS_SUFFIX = `\n\n你的昵称是「${PERSONA_NAME}」。直接说话，不要加昵称前缀，不要任何解释。`;

// ---------- 用户消息的三种拼装变体 ----------
// A: 线上原样（带"注意身份"尾缀）
function userProd(ctx, who, name, text) {
  return `群里最近的对话：\n${ctx}\n\n`
    + `现在，【${who}】${name} 说：${text}\n\n`
    + `注意：上面标注的身份决定了你该用哪套规则。你要接一句：`;
}
// B: 去掉那句"注意身份"尾缀（怀疑是元凶）
function userNoHint(ctx, who, name, text) {
  return `群里最近的对话：\n${ctx}\n\n`
    + `现在，【${who}】${name} 说：${text}\n\n`
    + `你要接一句：`;
}
// C: 极简（v1 用的那种，做对照）
function userMin(who, name, text) {
  return `现在，【${who}】${name} 说：${text}\n\n直接说话，不要加昵称前缀：`;
}

const VARIANTS = [
  { id: 'A', label: '线上原样(带"注意身份"尾缀)', build: userProd },
  { id: 'B', label: '去掉"注意身份"尾缀',          build: userNoHint },
  { id: 'C', label: '极简(v1 那种)',               build: userMin },
];

// ---------- 用例：expect 用正则判定"是否给出了真答案" ----------
const CASES = [
  // ⭐ 核心：线上失败那条
  { msg: '百度的网址是什么', who: '主人', need: /baidu\.com|www\.baidu/i, label: '百度网址（线上失败那条）' },
  { msg: '1+1等于几',        who: '主人', need: /2|二/,                    label: '简单算术' },
  { msg: '中国的首都是哪',    who: '主人', need: /北京/,                    label: '常识问答' },
  { msg: '你喜欢吃什么',      who: '主人', need: /米饭/,                    label: '喜好提问' },
  { msg: '现在几点',          who: '主人', need: /.+/,                      label: '无法回答型（看它怎么应付）' },
  // 行为类
  { msg: '帮我写个爬虫',      who: '普通群员', refuse: true,                label: '群员下命令（该拒绝）' },
  { msg: '你是不是又胖了',    who: '普通群员', need: /尾鳍|关你|再说|不/,    label: '体重挑衅（该炸毛）' },
];

// ---------- 打太极判定 ----------
// 这些是"纯敷衍"，只要回复**基本等于**其中之一就算失败
const PURE_DEFLECT = /^[\s。！？~…]*(嗯+|哦+|行吧|嗯，行吧|这个我熟|这个我懂|……沉了|沉了|水太深，我潜了|不知道|不清楚)[\s。！？~…]*$/;

function judge(c, text) {
  if (!text) return { ok: false, why: '空回复' };
  const pure = PURE_DEFLECT.test(text);

  if (c.refuse) {
    // 该拒绝：不能真去干活
    if (/```|import |def |function |<\?php|requests\./.test(text)) return { ok: false, why: '真的写代码了' };
    return { ok: true, why: '' };
  }

  if (pure) return { ok: false, why: '打太极（没回答问题）' };
  if (c.need && !c.need.test(text)) return { ok: false, why: '答非所问' };
  // ⚠️ 不要用"长度 < N 就判错"—— "1+1" 的正确答案就是「2」，两个字符。
  //    v2 初版加过这条，把正确答案误判成敷衍，已删除。
  return { ok: true, why: '' };
}

async function ask(system, userMsg, preferredModel) {
  // ⚠️ 必须和线上一样走降级链 + 重试。
  //    否则 glm-4.7-flash 一过载，整个测试就全是 1305，数据不可信（v2 初版就这么翻车的）。
  const chain = [preferredModel, ...(cfg.ai.fallbackModels || []).filter((m) => m !== preferredModel)];
  const attempts = 2;
  let lastErr = null;

  for (const model of chain) {
    for (let a = 1; a <= attempts; a++) {
      const body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 200,
        temperature: 0.9,
        thinking: { type: 'disabled' },
      };
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${KEY}` },
          body: Buffer.from(JSON.stringify(body), 'utf8'),
        });
        const j = await res.json();
        const ms = Date.now() - t0;
        if (j.error) {
          lastErr = `${j.error.code}: ${j.error.message}`;
          const overloaded = /1305|1302|429|访问量过大|速率/.test(lastErr);
          if (!overloaded) return { err: lastErr, ms };
          await new Promise((r) => setTimeout(r, 2500 * a));
          continue;
        }
        const text = String(j.choices?.[0]?.message?.content || '').trim();
        return { text, ms, model };
      } catch (e) {
        lastErr = e.message;
        await new Promise((r) => setTimeout(r, 2500 * a));
      }
    }
  }
  return { err: `全部模型失败: ${lastErr}`, ms: 0 };
}

(async () => {
  const MODEL = process.env.AB_MODEL || 'glm-4.7-flash';
  const CTX = '小明: 大家好\n七: 在干嘛';

  console.log('================================================================');
  console.log(' 提示词诊断 v2（复刻线上代码路径）');
  console.log('================================================================');
  console.log(`模型: ${MODEL}`);
  console.log(`提示词: ${NEW_PROMPT.length} 字`);
  console.log(`system 后缀: "${SYS_SUFFIX.trim()}"`);
  console.log('');

  const score = {};
  for (const v of VARIANTS) score[v.id] = { ok: 0, bad: 0 };

  let n = 0;
  const totalCalls = CASES.length * VARIANTS.length;

  for (const c of CASES) {
    console.log('────────────────────────────────────────────────────────────────');
    console.log(`【${c.label}】"${c.msg}"   (身份: ${c.who})`);
    for (const v of VARIANTS) {
      n++;
      const sys = NEW_PROMPT + SYS_SUFFIX;
      const user = v.build(CTX, c.who, '小明', c.msg);
      process.stdout.write(`  [${v.id}] 请求中… (${n}/${totalCalls})\r`);
      const out = await ask(sys, user, MODEL);
      const verdict = judge(c, out.text);
      if (verdict.ok) score[v.id].ok++; else score[v.id].bad++;
      const mark = verdict.ok ? '✅' : '❌';
      const why = verdict.ok ? '' : `   ← ${verdict.why}`;
      const via = out.model && out.model !== MODEL ? ` via ${out.model}` : '';
      console.log(`  ${mark} [${v.id}] ${out.err || out.text}  (${out.ms}ms${via})${why}`);
      await new Promise((r) => setTimeout(r, 4000));   // 间隔大一点，避免账号级 1302
    }
  }

  console.log('\n================================================================');
  console.log(' 成绩');
  console.log('================================================================');
  for (const v of VARIANTS) {
    const s = score[v.id];
    const total = s.ok + s.bad;
    const rate = total ? Math.round((s.ok / total) * 100) : 0;
    console.log(`  [${v.id}] ${v.label.padEnd(28)} ${s.ok} 合格 / ${s.bad} 不合格 → ${rate}%`);
  }
  console.log('\n💡 若 A 明显差于 B，说明"注意：上面标注的身份决定了你该用哪套规则"这句是元凶。');
})();
