// ============================================================
//  emotion.js —— 情绪观察器（只读、零模型、可一键关掉）
//
//  来源：把朋友那套 AstrBot 情感插件（astrbot_plugin_affective）的
//        「情绪解析」这一层**重新实现**成大肥鱼能用的形态。
//
//  🔴 和其他模块最大的不同：**它一个字都不往外发。**
//     第一版只做"观察"：把每条消息被读成什么情绪写进日志，
//     不改人设、不改回复、不改任何发送行为。
//     理由：他那套词典是**裸子串匹配**，实测会把「我想喝牛奶」读成"骄傲"、
//     「今天真爽约了」读成"快乐"、「麻烦你了」读成"愤怒"。
//     在这种误报率下直接拿它驱动人设 = 让鱼开始胡说八道。
//     ⇒ 先用真实群聊量出误报率，再决定要不要让它影响说话。
//
//  🔴 三个「我故意和他不一样」的设计（都是他那版的真 bug）：
//     ① **单字词默认不启用**（`allowSingleChar: false`）：31 个单字词里
//        20 个会被日常用语误触发。他那边是硬编码全开的。
//     ② **不做"危机词旁路"**：他那版命中危机词会**直接掐断对话**，
//        而实测「我不想死，我想好好活着」「我想结束加班」全被判成危机。
//        这里最多打一个 `crisis:true` 的标记，**要不要理、怎么理不归它管**。
//     ③ **不用"轮次"当时间**：他那版 `turn` 不落盘、`crisis.last_turn` 落盘，
//        重启后窗口错乱、可能几天后突然回访。这版一律用**真实时间戳**。
//
//  ⚠️ 本模块**没有任何副作用**：不落盘、不 push 上下文、不改配置、
//     不调用模型、不发送消息。日志写失败也只 warn 一次。
// ============================================================

const fs = require('fs');
const path = require('path');

// ---------- 词表 ----------
// 数据结构：{ emotions: { 情绪名: [词...] }, severe?: {...}, softers?: [...] }
// 位置：server/data/emotion-lexicon.json（由 devtools 从朋友那份 lexicon.py 导出）
const DATA_DIR = path.join(__dirname, 'data');
const LEXICON_FILE = path.join(DATA_DIR, 'emotion-lexicon.json');

// 最低限度的内建词表 —— 只在词表文件缺失/读坏时兜底。
// ⚠️ 故意写得很小：宁可"读不出什么"，也不要"用一个没审查过的表瞎判"。
const FALLBACK = {
  emotions: {
    快乐: ['开心', '高兴', '快乐', '好耶', '太好了'],
    悲伤: ['难过', '伤心', '失落', '想哭', '难受'],
    愤怒: ['生气', '气死', '气炸', '讨厌'],
    焦虑: ['焦虑', '紧张', '不安', '慌'],
    压力: ['压力', '好累', '撑不住', '扛不住'],
    委屈: ['委屈', '冤枉', '受委屈'],
  },
};

let lex = null;          // { emotions, severe, softers, intensifiers }
let lexSource = '';

function loadLexicon() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEXICON_FILE, 'utf8'));
    const emo = raw && raw.emotions && typeof raw.emotions === 'object' ? raw.emotions : null;
    if (!emo || !Object.keys(emo).length) throw new Error('词表为空');
    lex = {
      emotions: emo,
      // 单字词单独一张表（默认**不读**）：它们是误报根源，但留在这里，
      // 打开 `allowSingleChar` 时就能启用 —— 否则那个开关是个假开关
      // （踩过：导出时把单字词整个删了，结果开关打开也没词可用）。
      singleChar: raw.singleChar || {},
      severe: raw.severe || {},
      softers: raw.softers || [],
      intensifiers: raw.intensifiers || [],
    };
    lexSource = LEXICON_FILE;
    const words = Object.values(emo).reduce((a, w) => a + w.length, 0);
    console.log(`[emo] 词表已载入：${Object.keys(emo).length} 类 / ${words} 词（${LEXICON_FILE}）`);
  } catch (e) {
    lex = {
      emotions: FALLBACK.emotions,
      severe: {}, softers: [], intensifiers: [],
    };
    lexSource = '(内建兜底表)';
    console.warn(`[emo] 词表文件不可用（${e.message}）—— 只用内建兜底表，判得出的情绪会很有限`);
  }
}

// ---------- 阈值（全部集中在这里，方便一眼看完）----------
const T = {
  NOISE_FLOOR: 0.3,     // 低于此分的情绪直接丢掉
  HIT_WEIGHT: 0.5,      // 词表里没标权重的词，一次命中给多少
  CONF_BASE: 0.4,       // 置信度基数：命中越多越敢下结论（但封顶 1）
  SOFT_MULT: 0.6,       // 有"有点/稍微"这类软化词 → 整体压一档
  INTENSE_MULT: 1.25,   // 有"好/太/超级"这类程度词 → 整体抬一档
  LEVELS: [0.2, 0.4, 0.6, 0.8],   // 5 档强度分界线（淡/轻/中/高/重）
  LEVEL_NAMES: ['淡', '轻', '中', '高', '重'],
  MAX_HIT_WORDS: 6,     // 日志里最多列几个命中词（防刷屏）
};

// ---------- 解析 ----------
// 返回 { emotions: {名:分}, primary, intensity, level, label, hits, hitWords }
// ⚠️ 纯函数：同样输入同样输出，不依赖时间、不依赖随机数（自测才好写）
function parseText(text, opts = {}) {
  const allowSingle = opts.allowSingleChar === true;
  const s = String(text || '');
  if (!s || !lex) return null;

  const raw = {};               // 情绪名 -> 命中累计分
  const hitWords = {};          // 情绪名 -> [命中的词]
  let hits = 0;

  // 🔴 单字词单独走一张表：默认**不读**（它们是误报根源：牛奶→骄傲、爽约→快乐、
  //    麻烦→愤怒、积累经验→压力），只有 `allowSingleChar` 打开时才读。
  //
  // ⚠️ 踩过：原来按"出现次数"累加（`indexOf` 循环），结果同一条消息里
  //    「喜欢…喜欢」被记两次 → 情绪分虚高（实测日志里出现 `词=喜欢,喜欢`，
  //    把一句普通的话顶成「爱（重）1.00」）。
  //    ⇒ 改成**每个词每条消息最多算一次**。多词命中同一情绪仍然累加
  //      （那是不同证据，该累加；同一个词重复只是啰嗦，不该加权）。
  const scan = (table) => {
    for (const [emo, words] of Object.entries(table || {})) {
      for (const w of words) {
        if (!w || !s.includes(w)) continue;
        raw[emo] = (raw[emo] || 0) + T.HIT_WEIGHT;
        (hitWords[emo] = hitWords[emo] || []).push(w);
        hits += 1;
      }
    }
  };

  scan(lex.emotions);
  if (allowSingle) scan(lex.singleChar);

  if (!hits) return { emotions: {}, primary: null, intensity: 0, level: 0, label: null, hits: 0, hitWords: {} };

  // 严重词（如「崩溃」「绝望」「气炸」）——直接给到高档。
  // ⚠️ 用 max 合并不是相加：否则同一条消息里"绝望"会遇到两遍，
  //    分数虚高（他那边就是 += 累加，实测一句能顶满）。
  for (const [w, v] of Object.entries(lex.severe || {})) {
    if (!w || !s.includes(w)) continue;
    const emo = v && v.emotion;
    if (!emo) continue;
    raw[emo] = Math.max(raw[emo] || 0, Number(v.score) || 0);
    (hitWords[emo] = hitWords[emo] || []).push(w);
    hits += 1;
  }

  // 程度修正：软化词压一档、程度词抬一档（与他的规则一致，但我们不叠加强度）
  let mult = 1;
  if (lex.softers.some((w) => w && s.includes(w))) mult *= T.SOFT_MULT;
  if (lex.intensifiers.some((w) => w && s.includes(w))) mult *= T.INTENSE_MULT;

  const emotions = {};
  for (const [emo, v] of Object.entries(raw)) {
    const scored = Math.min(1, v * mult);
    if (scored >= T.NOISE_FLOOR) emotions[emo] = Number(scored.toFixed(3));
  }
  // ⚠️ 只加不减：程度修正后可能全部低于噪声底线 —— 那就保留最高的一条，
  //    否则"读到了却报空"更让人困惑（他那边没有这个兜底）。
  if (!Object.keys(emotions).length) {
    const best = Object.entries(raw).sort((a, b) => b[1] - a[1])[0];
    emotions[best[0]] = Number(Math.min(1, best[1]).toFixed(3));
  }

  const ranked = Object.entries(emotions).sort((a, b) => b[1] - a[1]);
  const [primary, intensity] = ranked[0];
  const level = T.LEVELS.filter((x) => intensity >= x).length;   // 0~4

  return {
    emotions,
    primary,
    intensity: Number(intensity.toFixed(3)),
    level,
    label: `${primary}（${T.LEVEL_NAMES[level]}）`,
    hits,
    hitWords,
  };
}

// ---------- 日志（唯一的外部动作）----------
let seen = new Map();          // msgId -> ts，防同一条消息被观察两次
const SEEN_TTL = 10 * 60 * 1000;
let warnedOnce = false;

function mask(id) {
  const s = String(id || '');
  return s ? s.slice(0, 6) + '…' : '?';
}

function gcSeen() {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > SEEN_TTL) seen.delete(k);
}

// 观察一条消息并打日志。**返回值只给自测/日志用，调用方不需要它。**
// opts: { msgId, scope, openid, nick, text, isAt, hitKeyword, rate }
function observe(opts = {}) {
  try {
    const text = String(opts.text || '');
    if (!text) return null;

    // 抽样：默认全观察（观察器不花钱、不发消息），但留个 rate 便于控制日志量
    const rate = Number.isFinite(opts.rate) ? opts.rate : 1;
    if (rate <= 0) return null;

    // 去重：同一条消息只观察一次（日志里同一条出现两遍会污染统计）
    const id = String(opts.msgId || '');
    if (id) {
      gcSeen();
      if (seen.has(id)) return null;
      seen.set(id, Date.now());
    }
    if (rate < 1 && Math.random() > rate) return null;

    const r = parseText(text);
    if (!r || !r.hits) return null;

    const words = Object.values(r.hitWords).flat().slice(0, T.MAX_HIT_WORDS);
    const all = Object.entries(r.emotions).map(([e, v]) => `${e}${v.toFixed(2)}`).join('/');
    // 日志里只放"谁"（掩码）+ "读成了什么" + "因为哪几个词" —— 不放原文，
    // 避免把群友的话原封不动搬进日志（隐私 + 日志体积）
    console.log(`[emo] ${mask(opts.openid)} ${opts.isAt ? '@' : ' '} `
      + `→ ${r.label} ×${Object.keys(r.emotions).length} [${all}] `
      + `词=${words.join(',')}`);

    return r;
  } catch (e) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(`[emo] 观察失败（只提醒一次）：${e.message}`);
    }
    return null;
  }
}

// ---------- 对外 ----------
loadLexicon();

module.exports = {
  parseText,
  observe,
  // 给自测用
  _lexicon: () => lex,
  _lexiconSource: () => lexSource,
  _thresholds: T,
  _resetSeen: () => seen.clear(),
};
