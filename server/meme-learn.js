// ============================================================
//  meme-learn.js —— 梗库自动采集（2026-10-23 用户要求）
//
//  用户原话：「能不能把梗库面板删掉，让bot自己加？或者仅保留修改而不是新加，
//            一般管员也懒得一天天添加梗这些」
//  ⇒ 面板只保留「改 / 停用 / 删」，新增由机器人自己干。
//
//  两级机制（成本几乎为 0）：
//   ① **频次挖掘（纯代码，0 调用）**：每条群消息切 2~6 字短语，滚动窗口统计
//      「出现次数 + 不同说话人数」；count≥3 且 ≥2 个不同人说过才当候选。
//   ② **批量释义（模型，低频）**：攒够 20 条消息且距上次 ≥5 分钟，把最多 5 个
//      候选 + 各 1 条上下文交给模型判「是不是群里的黑话/梗」，是就一句话释义。
//
//  🔴 2026-10-23 修「梗采集一个没加」：
//     · 根因是**每次重启清零** —— 内存里的窗口与 lastScan 全丢，攒到 40 条前
//       又被部署重启一次就永远攒不满 ⇒ 把「每群最近 60 条 + 上次扫描时间」落盘
//       （data/meme-learn.json），重启后接着攒；门槛 40→20、间隔 10→5 分钟。
//     · 另一个坑：释义调用原先是 forceJson=true，模型偶尔返回空 ⇒ 整轮白跑。
//       现在先普通生成、自己抠 JSON，抠不到再强制 JSON；失败不清进度，下轮重试。
// ============================================================
const fs = require('fs');
const path = require('path');
const memes = require('./memes');

const APP_DIR = process.env.APP_DIR || __dirname;
const STATE_FILE = path.join(APP_DIR, 'data', 'meme-learn.json');
const KEEP = 60;
const SCAN_EVERY_MSGS = 15;             // 攒够多少条才考虑扫描
const SCAN_GAP_MS = 5 * 60 * 1000;      // 两次扫描最小间隔
const MAX_CANDIDATES = 5;               // 一次最多发给模型几个
const MIN_COUNT = 2;                    // 至少出现几次（2 就够了，活跃群很容易命中）
const MIN_SPEAKERS = 2;                 // 至少几个人说过

// 明显不是梗的词（只挡最常见的，宁可漏）
const STOP = new Set([
  '这个', '那个', '什么', '怎么', '为什么', '可以', '没有', '知道', '现在', '今天',
  '明天', '昨天', '一个', '一下', '不是', '就是', '还是', '真的', '感觉', '应该',
  '但是', '因为', '所以', '如果', '然后', '已经', '自己', '我们', '你们', '他们',
  '这样', '那样', '时候', '地方', '东西', '事情', '问题', '图片', '表情',
  '哈哈哈', '嘿嘿', '呵呵', '谢谢', '好的', '收到', '在吗', '有人',
  'the', 'and', 'for', 'you', 'that', 'this', 'with', 'what', 'have',
]);

const win = new Map();   // scope -> [{t, text, who}]
const stats = new Map(); // scope -> Map(phrase -> {count, speakers:Set, last})
const lastScan = new Map();
const scannedUpTo = new Map(); // scope -> 已扫描到的时间戳
let dirty = 0;

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [scope, v] of Object.entries(j.scopes || {})) {
      if (Array.isArray(v.buf)) {
        const buf = v.buf.slice(-KEEP);
        win.set(scope, buf);
        // 🔴 重启后**必须回放**：stats 是内存里的，不回放就等于窗口白攒了
        for (const it of buf) bump(scope, it.text, it.who, it.t);
      }
      lastScan.set(scope, Number(v.lastScan) || 0);
      scannedUpTo.set(scope, Number(v.since) || 0);
    }
  } catch { /* 读不到就从空开始 */ }
}
function saveState() {
  try {
    const scopes = {};
    for (const [scope, buf] of win) {
      scopes[scope] = { buf: buf.slice(-KEEP), lastScan: lastScan.get(scope) || 0, since: scannedUpTo.get(scope) || 0 };
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ scopes }));
    fs.renameSync(tmp, STATE_FILE);
    dirty = 0;
  } catch { /* 落盘失败不影响主流程 */ }
}

// 从一条消息里切出 2~6 字的候选短语：中文按连续汉字切、英文数字按词切
function phrasesOf(text) {
  const s = String(text || '').replace(/\[CQ:[^\]]*\]/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const out = new Set();
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let n = 2; n <= 6; n++) {
      for (let i = 0; i + n <= seg.length; i++) out.add(seg.slice(i, i + n));
    }
  }
  for (const seg of s.match(/[A-Za-z][A-Za-z0-9_]{1,5}/g) || []) out.add(seg.toLowerCase());
  return out;
}

function badPhrase(p) {
  if (!p || p.length < 2 || p.length > 6) return true;
  if (STOP.has(p)) return true;
  if (/^\d+$/.test(p)) return true;
  if (/^(.)\1+$/.test(p)) return true;
  return false;
}

function bump(scope, text, who, ts) {
  const m = stats.get(scope) || new Map();
  for (const p of phrasesOf(text)) {
    if (badPhrase(p)) continue;
    const it = m.get(p) || { count: 0, speakers: new Set(), last: 0 };
    it.count += 1;
    if (who) it.speakers.add(String(who));
    it.last = Number(ts) || Date.now();
    m.set(p, it);
  }
  stats.set(scope, m);
}

function observe(scope, text, who) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return;
  const arr = win.get(scope) || [];
  arr.push({ t: Date.now(), text: t, who: String(who || '') });
  while (arr.length > KEEP) arr.shift();
  win.set(scope, arr);
  bump(scope, t, who, Date.now());
  // ⚠️ 每条都落盘：文件只有几 KB，换来"重启绝不丢窗口"
  saveState();
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
  const raw = [];
  for (const [p, v] of m) {
    // 🔴 2026-10-23 加严：2 字词太容易是普通词（"现在/感觉"），要 4 次 + 2 人；
    //    3~6 字保持 2 次 + 2 人。宁可少而准，别把一堆普通词喂给模型。
    const minCount = p.length <= 2 ? 4 : MIN_COUNT;
    if (v.count < minCount || v.speakers.size < MIN_SPEAKERS) continue;
    if (knownText.has(p.toLowerCase())) continue;
    if ([...knownText].some((k) => k.includes(p) || p.includes(k))) continue;
    raw.push({ phrase: p, count: v.count, speakers: v.speakers.size, last: v.last });
  }
  // 长的优先（更像梗），同长度按次数；再剔掉"是已选短语的子串"的碎片
  raw.sort((a, b) => (b.phrase.length - a.phrase.length) || (b.count - a.count));
  const out = [];
  for (const c of raw) {
    if (out.some((o) => o.phrase.includes(c.phrase))) continue;
    out.push(c);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

// 找出含这个短语的最近 2 条消息当语境
function contextsFor(scope, phrase, n = 2) {
  const arr = win.get(scope) || [];
  return arr.filter((x) => x.text.includes(phrase)).slice(-n).map((x) => x.text.slice(0, 80));
}

const SYS = '你是群聊黑话识别器。给你最近的群聊记录，找出其中**像群内梗/黑话/缩写/谐音**的短语（2~8 字，必须是聊天里真实出现过的）。'
  + '优先提取**完整短语**（如「康神开播了」），不要把一句话拆成两个词；含义太普通/看了就懂的（如「开播了」「今天吃啥」）不要列。'
  + '普通词、人名、地名、商品名、无意义碎片、已有梗都不要列。最多 3 条，宁缺毋滥。'
  + '输出 JSON 数组，元素 {"p":"短语","m":"一句话含义，不超过18字"}；没有就输出 []。不要输出多余文字。';

async function scan(scope, callAI) {
  const now = Date.now();
  lastScan.set(scope, now);
  if (typeof callAI !== 'function') return [];

  // 🔴 2026-10-23 改法（用户：一个没加）：
  //    频次挖出来的 2~6 字片段大多是普通词（"大肥鱼""有感觉吗"），模型全判"不是梗"。
  //    ⇒ 改成把**最近 25 条聊天**直接交给模型，让它像人一样挑梗；代码只负责
  //      "这句话确实出现过 ≥2 次" 的去伪，再入库。
  const buf = (win.get(scope) || []).slice(-25);
  if (buf.length < 5) { scannedUpTo.set(scope, now); saveState(); return []; }

  const known = (memes.list() || []).map((x) => (x.triggers || [])[0]).filter(Boolean).slice(0, 30);
  const chat = buf.map((m) => (m.who ? m.who.slice(0, 4) + ': ' : '') + String(m.text).slice(0, 100)).join('\n');
  const user = '【已有梗】' + (known.join('、') || '（无）')
    + '\n【最近聊天】\n' + chat
    + '\n\n请输出 JSON 数组，最多 3 条。';

  console.log(`  ├ [meme-learn] 开始找梗（窗口 ${buf.length} 条）`);

  const parse = (out) => {
    const txt = String((out && out.text) || '');
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try { return JSON.parse(m[0]); } catch { return []; }
  };

  let arr = null;
  try {
    // ⚠️ 2026-10-23：不要再用 forceJson=true 兜底 —— brain 那边强制 JSON 期待的是**对象**，
    //    而我们返回的是数组 "[]"，它会抛「没返回 JSON」，把"模型说没有梗"误报成失败。
    //    ⇒ 只调一次；解析失败（不是空数组）才算失败，下轮再试。
    const out = await callAI(SYS, user, 'deepseek-flash', 500, false);
    arr = parse(out);
    if (arr === null) {
      console.warn('  ├ [meme-learn] 模型没给 JSON（下次再试）：' + String((out && out.text) || '').slice(0, 60));
      return [];
    }
    scannedUpTo.set(scope, now);
  } catch (e) {
    console.warn(`  ├ [meme-learn] 模型返回异常（下次再试）：${e.message}`);
    return [];
  }

  const added = [];
  for (const r of arr) {
    if (!r || !r.p || !r.m) continue;
    const phrase = String(r.p).trim().slice(0, 12);
    if (phrase.length < 2) continue;
    // 去伪：这句话必须在窗口里**真实出现 ≥2 次**（一条消息里重复也算一次）
    const hits = buf.filter((m) => String(m.text).includes(phrase));
    if (hits.length < 2) continue;
    const speakers = new Set(hits.map((m) => m.who).filter(Boolean)).size;
    const res = memes.addAuto({
      phrase,
      meaning: String(r.m).slice(0, 40),
      count: hits.length,
      speakers: Math.max(1, speakers),
    });
    if (res.ok) added.push(res.item);
  }
  saveState();
  return added;
}

loadState();

module.exports = {
  observe, shouldScan, scan, pickCandidates, phrasesOf, saveState,
  _reset: () => { win.clear(); stats.clear(); lastScan.clear(); scannedUpTo.clear(); },
};
