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
// 🆕 2026-10-27 用户截图：「太多了」「看这个」「你叫什么」「x64」这种常识也收进梗库了。
//    根因：上一版把"是不是梗"的判断交给了频率——只要 2 次 + 2 人就收，常识词必然大批涌入。
//    ⇒ 加一层**纯代码的常用词/形状过滤**（0 调用），再把模型当"一票否决"用（见 scan）。
const JUNK_RE = /你|我|他|她|它|这|那|哪|谁|什么|怎么|为什么|是不是|可以|觉得|自己|就是|还是|一直|太多|没有|知道|现在|已经|所以|但是|因为|如果|然后|东西|时候|表情|视频|图片|消息|机器人|系统|框架|大佬|耳朵|块钱|在线/;
const JUNK_TAIL_RE = /[的了吗吧呢啊呀嘛]$/;
const TECH_RE = /^(x64|x86|win32|win64|napcat|snowlu|nonebot|api|http|https|json|qq|vd+)$/i;

function isJunkPhrase(p) {
  const t = String(p || '').trim();
  if (t.length < 3) return true;                 // 2 字几乎全是常用词，直接不要
  if (JUNK_RE.test(t)) return true;              // 含代词/疑问/功能词
  if (t.length <= 4 && JUNK_TAIL_RE.test(t)) return true;   // 短句以"的了吗吧"结尾
  if (TECH_RE.test(t)) return true;              // 纯技术词/型号
  if (/^[a-z0-9_-]+$/i.test(t)) return true;    // 纯字母数字
  return false;
}

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
  + '**只输出你有把握的**：不确定就一条都别输出；不要靠字面拆缩写去猜。'
  + '**禁止**写「疑似」「可能」「也许」「大概」「猜」「或者是」这类含糊措辞——含义必须是确定的。'
  + '优先提取**完整短语**（如「康神开播了」），不要把一句话拆成两个词；含义太普通/看了就懂的不要列。'
  + '普通词、人名、地名、商品名、无意义碎片、已有梗都不要列。最多 3 条，宁缺毋滥。'
  + '输出 JSON 数组，元素 {"p":"短语","m":"一句话含义，不超过18字"}；没有就输出 []。不要输出多余文字。';

async function scan(scope, callAI) {
  const now = Date.now();
  lastScan.set(scope, now);
  if (typeof callAI !== 'function') return [];

  // 🔴 2026-10-27 用户：「梗库不更新，还不如最初的采集机制」。
  //    上一版是"把最近 25 条聊天丢给模型挑梗"，模型返空的比例极高（近 24h 154 次扫描、0 条入库）。
  //    ⇒ 回到**频次采集为准**：代码先按"出现次数 + 说话人数"挑候选（pickCandidates），
  //      只让模型补**含义**；模型给不出确定含义也照样入库（unknown:true，含义留空，
  //      提示里写"具体含义不详"）。代码保证的是"这个词真的被多个人反复说过"，含义只是加分项。
  const cands = pickCandidates(scope, memes.list() || []).filter((c) => !isJunkPhrase(c.phrase)).slice(0, 3);
  if (!cands.length) { scannedUpTo.set(scope, now); saveState(); return []; }
  console.log('  ├ [meme-learn] 候选 ' + cands.length + ' 条：'
    + cands.map((c) => c.phrase + '(' + c.count + '次/' + c.speakers + '人)').join('、'));

  const ask = '下面这些短语是从群聊里频次统计出来的。请逐个判断：它是不是**这个群特有的梗/黑话/缩写/谐音**？'
    + '普通的日常用语（"看这个""你叫什么""大佬""机器人"）一律算 NOT。'
    + '对每个短语输出 {"p":"短语","meme":true/false,"m":"一句话含义（不超过 18 字；不确定就空串）"}。'
    + '只输出 JSON 数组，不要多余文字。';
  const askUser = '【短语】' + cands.map((c) => c.phrase).join('、');

  const parse = (out) => {
    const txt = String((out && out.text) || '');
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  };

  let meanings = null;
  try {
    const out = await callAI(ask, askUser, 'deepseek-flash', 400, false);
    meanings = parse(out);
  } catch (e) {
    console.warn('  ├ [meme-learn] 释义调用异常（按无释义入库）：' + e.message);
  }
  if (!Array.isArray(meanings)) {
    console.warn('  ├ [meme-learn] 没拿到释义 JSON，本次按频次入库（含义留空）');
    meanings = [];
  }
  const mm = new Map();
  for (const r of meanings) {
    if (!r || !r.p) continue;
    mm.set(String(r.p).trim(), { meme: r.meme === true, m: String(r.m || '').trim() });
  }

  const added = [];
  const HEDGE = /疑似|可能|也许|大概|不确定|猜测|猜的|或者是|说不准|不知道|不详|不了解/;
  for (const c of cands) {
    const info = mm.get(c.phrase);
    if (!info || info.meme !== true) { console.log('  ├ [meme-learn] 模型判定不是梗，跳过：' + c.phrase); continue; }
    let mean = info.m || '';
    if (mean && HEDGE.test(mean)) { console.log('  ├ [meme-learn] 释义含糊，按未知处理：' + c.phrase); mean = ''; }
    const res = memes.addAuto({ phrase: c.phrase, meaning: mean, count: c.count, speakers: c.speakers, unknown: !mean });
    if (res.ok) added.push(res.item);
  }
  console.log('  ├ [meme-learn] 频次入库 ' + added.length + ' 条（候选 ' + cands.length + '，带释义 ' + added.filter((x) => x.meaning).length + '）');
  scannedUpTo.set(scope, now);
  saveState();
  return added;
}

loadState();

module.exports = {
  observe, shouldScan, scan, pickCandidates, phrasesOf, saveState,
  _reset: () => { win.clear(); stats.clear(); lastScan.clear(); scannedUpTo.clear(); },
};
