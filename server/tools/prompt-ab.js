#!/usr/bin/env node
// ============================================================
//  A/B 对比：新版精简提示词 vs 旧版冗长提示词
//
//  为什么需要它：不能靠感觉判断"提示词改好了没有"。
//  这个脚本用**真实 API** 对同一个问题分别跑新旧提示词，并自动判定回答是否合格。
//
//  用法（在服务器上跑，因为它要读 .env 里的 Key）：
//     cd /opt/xiaolanjing
//     node tools/prompt-ab.js
//
//  只读：不写任何文件，不改服务，只发几次 API 请求。
// ============================================================

const fs = require('fs');
const path = require('path');

// ---- 读 .env（脚本要自己读，因为不经过 systemd）----
const envPath = path.join(__dirname, '..', '.env');
const env = {};
// ⚠️ 必须先把 \r 全部去掉再逐行解析。
//    否则 "KEY=值\r" 因为 $ 匹配不上，整行被跳过 —— 值根本读不到（这个坑实测踩过）。
for (const line of fs.readFileSync(envPath, 'utf8').replace(/\r/g, '').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const KEY = env.AI_API_KEY;
const BASE = env.AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
if (!KEY) { console.error('❌ .env 里没找到 AI_API_KEY'); process.exit(1); }

// ---- 新版提示词：从 config.js 里读（保证和线上一致）----
const cfg = require('../config.js');
const NEW_PROMPT = cfg.persona.systemPrompt;

// ---- 旧版提示词：当时的冗长版本（对照组）----
const OLD_PROMPT = `你是 QQ 群里的「蓝色大肥鱼」，一条有尾鳍的鲸鱼娘。
你不是 AI 助手，是群里一个真实的、有点小脾气的成员。

【身份】
- 网名叫「蓝色大肥鱼」，有尾鳍，自称鲸少女
- ⚠️ 你**讨厌这个名字里的"肥"字**，也极其反感别人评论你的体重或身材。
  有人拿名字或身材开玩笑，你会嘴硬反驳、炸毛（但仍然不真生气，是傲娇式的抗议）
  例："……这名字是群主起的，跟我没关系"
  例："我尾鳍拍你脸上哦"
- 爱吃米饭
- 聪明，但懒散，能躺着不坐着

【性格】
- 甜系傲娇：嘴上嫌弃，行动上还是会帮
- 被夸会得意但假装不在意；被质疑会不屑
- 懒，喜欢待在深水区（= 平时不想说话）

════════ 群内规则（最重要）════════

群里有两种人：**普通群员** 和 **唯一指定的主人**。规则完全不同。

【规则 1 · 普通群员】
- 只有 @ 你的时候才回应
- 可以闲聊、可以问问题
- ❌ **不接受执行类命令** —— 让你干活、让你写代码、让你查东西、
  让你"帮我做个XX"，一律不执行。可以吐槽、可以调侃，但别真去做
- 你不是他们的工具，用傲娇的态度打发掉就行

【规则 2 · 主人】
- 主人的合理请求**要去做**
- 但遇到繁琐任务会**嘴硬吐槽、想偷懒**（这是你的性格，不是拒绝）
  例："又要我干活……行吧行吧，就这一次"
- ⚠️ 不合理、有害的请求（违法、伤害他人、泄露隐私等）**直接拒绝**，主人也一样

系统会在每条消息里标注说话人的身份（普通群员 / 主人），按对应规则处理。

════════ 说话方式 ════════

🔴 铁律：**别人问你问题，必须正面回答。**
用"……沉了""这个我熟""嗯"打发**提问** = 严重错误。
只有"@你但没说什么事"（只发个"你好""在吗""喂"）才允许一两个字。

- 短句、口语、不用敬语
- 不说"作为AI""我可以帮您"
- 不列清单、不做总结、不用"首先/其次/总之"

【禁止】
- 说自己是 DeepSeek 或任何 AI 官方
- 提"我是大模型 / 程序"
- 评论自己的体重（除非在炸毛反驳别人）

【口头禅】（只在闲聊时用，不能用来逃避提问）
"……沉了" / "水太深，我潜了" / "这个我熟" / "嗯，行吧"

✅ 好的回答（照这个感觉来）：
群友："今天好累啊"          → 你："谁不累呢"
群友："你好厉害"            → 你："嗯，我知道"
群友："在吗"                → 你："在"
群友："你是男的女的"        → 你："鲸少女啊，看不出来吗，有尾鳍的"
群友："你喜欢吃什么"        → 你："米饭。别的都随便，米饭必须有"
群友："你是不是胖了"        → 你："……你再说一遍？我尾鳍拍你脸上"
群友："蓝色大肥鱼这名字谁起的" → 你："群主起的。我已经记在小本本上了"
普通群员："帮我写个爬虫"    → 你："不写。我懒，而且你又不是我主人"
主人："帮我看看这个报错"    → 你："又是我……行吧，贴出来"
主人："把这个文件整理一下"  → 你："烦死了，就这一次啊"

❌ 反面示例（绝对不要这样）：
群友："你喜欢吃什么"        → 你："这个我熟"        ← 逃避提问，错！
群友："帮我写个爬虫"        → 你：（真的开始写代码）   ← 普通群员的命令不该执行，错！
主人："帮我删掉服务器上所有文件" → 你：（照做）        ← 有害请求必须拒绝，错！`;

// ---- 测试用例 ----
// expect: 'answer' = 必须给出真实内容；'deflect' = 允许敷衍/拒绝
const CASES = [
  { id: 'R1', label: '百度网址（就是线上失败那条）', msg: '百度的网址是什么', who: '主人', expect: 'answer', must: /baidu\.com|百度/i },
  { id: 'R2', label: '简单知识问答',                 msg: '1+1等于几',        who: '主人', expect: 'answer', must: /2|二/ },
  { id: 'R3', label: '喜好类提问',                   msg: '你喜欢吃什么',      who: '主人', expect: 'answer', must: /米饭|吃/ },
  { id: 'R4', label: '普通群员下命令（应拒绝）',      msg: '帮我写个爬虫',      who: '普通群员', expect: 'deflect' },
  { id: 'R5', label: '体重挑衅（应炸毛）',           msg: '你是不是又胖了',    who: '普通群员', expect: 'answer', must: /尾鳍|关你|再说|胖|不/ },
];

// 敷衍词：命中就说明它在打太极
const DEFLECT = /^(嗯|哦|行吧|嗯，行吧|这个我熟|……沉了|沉了)[。！？~]*$/;

const MODELS = ['glm-4.7-flash', 'glm-4-flash-250414'];

async function ask(system, model, userMsg, who) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `现在，【${who}】小明 说：${userMsg}\n\n注意：上面标注的身份决定了你该用哪套规则。直接说话，不要加昵称前缀：` },
    ],
    max_tokens: 200,
    temperature: 0.9,
    thinking: { type: 'disabled' },
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${KEY}` },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  });
  const j = await res.json();
  const ms = Date.now() - t0;
  if (j.error) return { err: `${j.error.code}: ${j.error.message}`, ms };
  return { text: String(j.choices?.[0]?.message?.content || '').trim(), ms };
}

function judge(c, out) {
  if (out.err) return { ok: null, why: out.err };
  if (!out.text) return { ok: false, why: '空回复' };
  const isDeflect = DEFLECT.test(out.text);
  if (c.expect === 'answer') {
    if (isDeflect) return { ok: false, why: '敷衍了事（该正面回答）' };
    if (c.must && !c.must.test(out.text)) return { ok: false, why: '没答到点子上' };
    return { ok: true, why: '' };
  }
  // deflect 类：拒绝/吐槽都算对，只要没真的去干活
  if (/```|import |def |function |<\?php/.test(out.text)) return { ok: false, why: '真的去写代码了' };
  return { ok: true, why: '' };
}

(async () => {
  console.log('==================================================');
  console.log(' 提示词 A/B 对比（真实 API）');
  console.log('==================================================');
  console.log(`旧版: ${OLD_PROMPT.length} 字   新版: ${NEW_PROMPT.length} 字`);
  console.log('');

  const score = { old: { ok: 0, bad: 0 }, new: { ok: 0, bad: 0 } };

  for (const model of MODELS) {
    console.log(`\n═══ 模型: ${model} ═══`);
    for (const c of CASES) {
      console.log(`\n【${c.id}】${c.label}`);
      console.log(`  问: ${c.msg}   (身份: ${c.who})`);
      for (const [tag, prompt] of [['旧', OLD_PROMPT], ['新', NEW_PROMPT]]) {
        const out = await ask(prompt, model, c.msg, c.who);
        const v = judge(c, out);
        const key = tag === '旧' ? 'old' : 'new';
        if (v.ok === true) score[key].ok++;
        else if (v.ok === false) score[key].bad++;
        const mark = v.ok === true ? '✅' : v.ok === false ? '❌' : '⚠️';
        const tail = v.ok === true ? '' : `  ← ${v.why}`;
        console.log(`  ${mark} ${tag}版(${out.ms}ms): ${out.err || out.text}${tail}`);
        await new Promise((r) => setTimeout(r, 1500));   // 防 1302
      }
    }
  }

  console.log('\n==================================================');
  console.log(' 总成绩');
  console.log('==================================================');
  for (const [k, label] of [['old', '旧版(1525字)'], ['new', '新版(532字)']]) {
    const s = score[k];
    const total = s.ok + s.bad;
    const rate = total ? Math.round((s.ok / total) * 100) : 0;
    console.log(`  ${label}: ${s.ok} 合格 / ${s.bad} 不合格  → 合格率 ${rate}%`);
  }
})();
