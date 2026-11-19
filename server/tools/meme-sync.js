// ============================================================
//  tools/meme-sync.js —— 梗库"导入模式"（2026-11-19 用户要求）
//
//  用户原话：「把那个梗库换成astbot那种导入的模式吧，然后沿用我在astrbot里用的梗库仓库」
//  ⇒ 不再靠"从群聊里学"（那是 astrbot 之前的做法，也是我们踩了一堆坑的做法），
//     改成**从公开词库导入**：源就是他在 AstrBot 里用的那个插件同款
//     （astrbot_plugin_memewiki → https://cnmeme.wiki/api/v1/public/memes）。
//
//  并入规则（对齐插件"一键更新"的语义）：
//    · **不覆盖本地已有条目**（他手改过的触发词/释义一个字都不动）；
//    · 新增的标记 origin:'wiki'，只当"背景知识"注入（不带固定台词）；
//    · 原子写 + 写前备份（复用 memes.js 的 save）；写不进去就原样留着。
//
//  用法：
//    node tools/meme-sync.js --max 1200        # 首次导入（默认 1200 条）
//    node tools/meme-sync.js --all             # 拉全量（约 6800 条，慢一点）
//    node tools/meme-sync.js --dry             # 只看会新增多少，不落盘
//  也可以从面板「梗库 → 一键更新词库」触发（logweb 的 /api/memes/sync）。
// ============================================================
const fs = require('fs');
const path = require('path');
const https = require('https');
const memes = require('../memes');

const API = 'https://cnmeme.wiki/api/v1/public/memes';
const META_FILE = path.join(path.dirname(memes.FILE), 'meme-meta.json');
const MAX_TOTAL = 4000;          // 硬上限：别把 2G 小机器撑爆

function metaLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch { return {}; }
}
function metaSave(m) {
  try {
    const tmp = META_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, META_FILE);
  } catch { /* 元信息写失败不影响词条 */ }
}

function getJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'qqbot-meme-sync/1.0', 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('返回的不是 JSON')); }
      });
    });
    req.setTimeout(timeout || 25000, () => { req.destroy(new Error('超时')); });
    req.on('error', reject);
  });
}

// 🆕 2026-11-19：词库站走 Cloudflare，实测同一台服务器两次请求 1.8s / 14.6s ⇒ 必须重试。
//   重试仍失败时**不整体失败**（见 pull：保留已拿到的部分），否则拉了一分钟白干。
async function getJsonRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await getJson(url, 25000); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 600 * (i + 1))); }
  }
  throw last;
}

// 一条 cnmeme 词条 → 我们的梗库条目（只当背景知识：没有固定台词）
function toEntry(it) {
  const title = String(it.title || '').trim();
  if (!title) return null;
  const aliases = Array.isArray(it.aliases) ? it.aliases : [];
  const keywords = Array.isArray(it.keywords) ? it.keywords : [];
  const triggers = [];
  const push = (s) => {
    const v = String(s || '').trim();
    if (v && v.length <= 40 && !triggers.includes(v)) triggers.push(v);
  };
  push(title);
  aliases.slice(0, 3).forEach(push);
  keywords.slice(0, 3).forEach(push);
  const summary = String(it.summary || '').replace(/\s+/g, ' ').trim();
  return {
    id: 'w' + String(it.slug || title).replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '').slice(0, 24),
    triggers: triggers.slice(0, 6),
    reply: '',
    meaning: summary.slice(0, 120),
    when: '',
    fixed: false,
    echo: false,
    enabled: true,
    origin: 'wiki',
    src: 'cnmeme.wiki',
    slug: it.slug || '',
    tags: Array.isArray(it.tags) ? it.tags.slice(0, 6) : [],
    updatedAt: it.updated_at || '',
    ts: Date.now(),
  };
}

// 归一化：判断"这条词库词是否已经在库里"（标题或别名撞上就算）
function keySet(items) {
  const set = new Set();
  for (const it of items) {
    for (const t of (it.triggers || [])) set.add(String(t).toLowerCase());
    if (it.slug) set.add(String(it.slug).toLowerCase());
  }
  return set;
}

// ⚠️ 2026-11-19 实测：该接口 **limit 最大 30**（传 50/100/200 都会被 422 打回：
//    "Input should be less than or equal to 30"），而且不认 updated_after / since 之类的游标参数
//    （传了也静默忽略）⇒ 只能 offset 分页、每页 30 条。全量 6800 多条 = 227 次请求，
//    所以面板按钮只拉几百条，全量走 CLI 一次性导入。
const PAGE_SIZE = 30;

async function pull({ max = 900, pageSize = PAGE_SIZE, onProgress } = {}) {
  const size = Math.min(Number(pageSize) || PAGE_SIZE, PAGE_SIZE);
  const out = [];
  let offset = 0;
  let guard = 0;
  let partial = false;
  while (out.length < max && guard < 400) {
    guard++;
    const url = API + '?limit=' + size + '&offset=' + offset;
    let j;
    try { j = await getJsonRetry(url); }
    catch (e) { partial = out.length > 0; break; }   // 拿到的先留着，别整批丢
    const items = Array.isArray(j.items) ? j.items : [];
    if (!items.length) break;
    out.push(...items);
    if (onProgress) onProgress(out.length);
    if (!j.has_more) break;
    offset += items.length;
  }
  out.partial = partial;
  return out.slice(0, max);
}

async function sync({ max = 1200, all = false, dry = false } = {}) {
  const items = memes.list();
  const have = keySet(items);
  const limit = all ? MAX_TOTAL : Math.min(max, MAX_TOTAL);
  const remote = await pull({ max: Math.max(0, limit - items.length) || limit });
  const added = [];
  const skipped = [];
  for (const raw of remote) {
    const e = toEntry(raw);
    if (!e) continue;
    const keyHit = e.triggers.some((t) => have.has(String(t).toLowerCase()));
    if (keyHit) { skipped.push(e.triggers[0]); continue; }
    e.triggers.forEach((t) => have.add(String(t).toLowerCase()));
    added.push(e);
  }
  const meta = metaLoad();
  const result = {
    ok: true,
    dry: !!dry,
    partial: !!remote.partial,
    fetched: remote.length,
    added: added.length,
    skipped: skipped.length,
    total: items.length + added.length,
  };
  if (!dry && added.length) {
    // 新导入的排在前面（越新越容易被 hint 的"手动优先"之后看到）；总条数守上限
    const next = added.concat(items).slice(0, MAX_TOTAL);
    memes.save(next);
    meta.source = 'cnmeme.wiki /api/v1/public/memes';
    meta.count = next.length;
    meta.lastSync = new Date().toISOString();
    metaSave(meta);
  } else if (!dry) {
    meta.lastSync = new Date().toISOString();
    metaSave(meta);
  }
  return result;
}

module.exports = { API, META_FILE, sync, pull, toEntry, metaLoad, metaSave };

// CLI
if (require.main === module) {
  const argv = process.argv.slice(2);
  const has = (k) => argv.includes(k);
  const num = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 ? Number(argv[i + 1]) || d : d;
  };
  sync({ all: has('--all'), dry: has('--dry'), max: num('--max', 1200) })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error('同步失败：' + e.message); process.exit(1); });
}
