// ============================================================
//  meme-learn.js —— 梗库自动采集（2026-10-23 用户要求）
//
//  用户原话：「能不能把梗库面板删掉，让bot自己加？或者仅保留修改而不是新加，
//            一般管员也懒得一天天添加梗这些」
//  ⇒ 面板只保留「改 / 停用 / 删」，新增由机器人自己干。
//
//  两级机制（成本几乎为 0）：
//   ① **频次挖掘（纯代码，0 调用）**：每条群消息切 2~6 字短语，滚动窗口内统计
//      「出现次数 + 不同说话人数」；只有 count≥3 且 ≥2 个不同人说过才当候选。
//      人名/功能词/纯数字/脏词（停用表）一律排除。
//   ② **批量释义（模型，低频）**：攒够 40 条消息且距上次 ≥10 分钟，才把最多 5 个
//      候选 + 各 1 条上下文交给模型判「这是不是群里的黑话/梗」，是就一句话释义。
//      ⇒ 一天最多几十次候选、几次调用，成本约 ¥0.01/天。
//
//  ⚠️ 采到的条目**不写"接法"**，只写「含义」，注入时按出现次数排序（最多 3 条），
//     提示里写「群里常用，知道就顺着用，别解释」——避免变成固定台词复读。
// ============================================================
const memes = require('./memes');

const WINDOW_MAX = 300;                 // 每群保留最近多少条
const SCAN_EVERY_MSGS = 40;             // 攒够多少条才考虑扫描
const SCAN_GAP_MS = 10 * 60 * 1000;     // 两次扫描最小间隔
const MAX_CANDIDATES = 5;               // 一次最多发给模型几个
const MIN_COUNT = 3;                    // 至少出现几次
const MIN_SPEAKERS = 2;                 // 至少几个人说过

// 明显不是梗的词（只挡最常见的，宁可漏）
const STOP = new Set([
  '这个', '那个', '什么', '怎么', '为什么', '可以', '没有', '知道', '现在', '今天',
  '明天', '昨天', '一个', '一下', '不是', '就是', '还是', '真的', '感觉', '应该',
  '但是', '因为', '所以', '如果', '然后', '已经', '自己', '我们', '你们', '他们',
  '什么', '这样', '那样', '时候', '地方', '东西', '事情', '问题', '图片', '表情',
  '哈哈哈', '哈哈哈', '嘿嘿', '呵呵', '谢谢', '好的', '收到', '在吗', '有人',
  'the', 'and', 'for', 'you', 'that', 'this', 'with', 'what', 'have',
]);

const win = new Map();   // scope -> [{t, text, who}]
const stats = new Map(); // scope -> Map(phrase -> {count, speakers:Set, last})
const lastScan = new Map();
let scannedUpTo = new Map(); // scope -> 已扫描到的时间戳

function isCjk(ch) {
  return /[\u4e00-\u9fa5]/.test(ch);
}

// 从一条消息里切出 2~6 字的候选短语：中文按连续汉字切、英文数字按词切
function phrasesOf(text) {
  const s = String(text || '').replace(/\[CQ:[^\]]*\]/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const out = new Set();
  // 中文连续段
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let n = 2; n <= 6; n++) {
      for (let i = 0; i + n <= seg.length; i++) out.add(seg.slice(i, i + n));
    }
  }
  // 英文/数字（含下划线）2~6
  for (const seg of s.match(/[A-Za-z][A-Za-z0-9_]{1,5}/g) || []) out.add(seg.toLowerCase());
  return out;
}

function badPhrase(p) {
  if (!p || p.length < 2 || p.length > 6) return true;
  if (STOP.has(p)) return true;
  if (/^\d+$/.test(p)) return true;
  if (/^(.)\1+$/.test(p)) return true;         // 叠字（哈哈哈）
  return false;
}

function observe(scope, text, who) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return;
  const arr = win.get(scope) || [];
  arr.push({ t: Date.now(), text: t, who: String(who || '') });
  while (arr.length > WINDOW_MAX) arr.shift();
  win.set(scope, arr);

  const m = stats.get(scope) || new Map();
  for (const p of phrasesOf(t)) {
    if (badPhrase(p)) continue;
    const it = m.get(p) || { count: 0, speakers: new Set(), last: 0 };
    it.count += 1;
    if (who) it.speakers.add(String(who));
    it.last = Date.now();
    m.set(p, it);
  }
  stats.set(scope, m);
}

function shouldScan(scope, now = Date.now()) {
  const arr = win.get(scope) || [];
  const since = scannedUpTo.get(scope) || 0;
  const fresh = arr.filter((x) => x.t > since).length;
  if (fresh < SCAN_EVERY_MSGS) return false;
  return now - (lastScan.get(scope) || 0) >= SCAN_GAP_MS;
}

// 纯函数：从统计里挑候选（方便自测）
function pickCandidates(scope, known) {
  const m = stats.get(scope);
  if (!m) return [];
  const knownText = new Set();
  for (const it of known || []) {
    for (const t of it.triggers || []) knownText.add(String(t).toLowerCase());
  }
  const out = [];
  for (const [p, v] of m) {
    if (v.count < MIN_COUNT || v.speakers.size < MIN_SPEAKERS) continue;
    if (knownText.has(p.toLowerCase())) continue;
    // 已经被某条梗的触发词包含（或包含它）就别重复
    if ([...knownText].some((k) => k.includes(p) || p.includes(k))) continue;
    out.push({ phrase: p, count: v.count, speakers: v.speakers.size, last: v.last });
  }
  out.sort((a, b) => b.count - a.count || b.last - a.last);
  return out.slice(0, MAX_CANDIDATES);
}

// 找出含这个短语的最近 2 条消息当语境
function contextsFor(scope, phrase, n = 2) {
  const arr = win.get(scope) || [];
  return arr.filter((x) => x.text.includes(phrase)).slice(-n).map((x) => x.text.slice(0, 80));
}

const SYS = '你是群聊黑话识别器。只判断：这些短语是不是群里特有的网络梗/黑话（缩写、谐音、圈内说法）。'
  + '不是（普通词、人名、地名、商品名、无意义碎片）就返回空解释。'
  + '输出 JSON 数组，元素 {"p":"短语","m":"一句话含义，≤18字"}；不是梗的 m 写空字符串。不要输出多余文字。';

async function scan(scope, callAI) {
  const now = Date.now();
  scannedUpTo.set(scope, now);
  lastScan.set(scope, now);
  if (typeof callAI !== 'function') return [];
  const cands = pickCandidates(scope, memes.list());
  if (!cands.length) return [];

  const lines = cands.map((c, i) => {
    const ctx = contextsFor(scope, c.phrase).map((x) => '「' + x + '」').join(' ');
    return (i + 1) + '. 短语：' + c.phrase + '（出现 ' + c.count + ' 次，' + c.speakers + ' 人说过）语境：' + (ctx || '（无）');
  }).join('\n');

  const out = await callAI(SYS, lines + '\n\n请输出 JSON 数组。', 'deepseek-flash', 400, true);
  const txt = String((out && out.text) || '');
  let arr = [];
  try {
    const m = txt.match(/\[[\s\S]*\]/);
    arr = m ? JSON.parse(m[0]) : [];
  } catch { arr = []; }
  const added = [];
  for (const r of arr) {
    if (!r || !r.p || !r.m) continue;
    const cand = cands.find((c) => c.phrase === String(r.p));
    if (!cand) continue;
    const res = memes.addAuto({
      phrase: cand.phrase,
      meaning: String(r.m).slice(0, 40),
      count: cand.count,
      speakers: cand.speakers,
    });
    if (res.ok) added.push(res.item);
  }
  return added;
}

module.exports = { observe, shouldScan, scan, pickCandidates, phrasesOf, _reset: () => { win.clear(); stats.clear(); lastScan.clear(); scannedUpTo.clear(); } };
