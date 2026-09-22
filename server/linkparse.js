// ============================================================
//  链接解析：从群消息里找出 GitHub / B站 链接，抓元信息，渲染成 Markdown 卡片
//
//  ⚠️ 零依赖铁律：只用 Node 内置的 fetch / URL，不引任何 npm 包。
//
//  三种来源都要认（2026-09-21 用户明确要求）：
//    ① 转发的卡片（message_type=3）—— 链接在 ark_data.fields 里（字段名不固定，递归扫）
//    ② 带 bilibili.com 的普通链接
//    ③ b23.tv 短链 —— 要先跟随跳转拿到真实地址
//
//  🔴 安全设计（必读，别绕过）：
//    · 域名白名单 —— 绝不抓白名单外的 URL（防 SSRF：让它去读内网 / 元数据服务）
//    · b23.tv 跳转后要**再校验一次最终域名**，否则短链可以被指到任意地方
//    · 抓回来的标题/简介是**用户可控文本**，本模块**只做模板拼接、绝不喂给模型**
//      → 天然免疫提示注入
// ============================================================
const cfg = require('./config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------- 平台识别 ----------
// 只用"域名后缀"判断，不用 includes —— 防止 evil.com/?x=bilibili.com 这种绕过
const PLATFORM_RULES = [
  ['github', /(^|\.)github\.com$/],
  ['bilibili', /(^|\.)bilibili\.com$/],
  ['bilibili', /(^|\.)b23\.tv$/],
  ['douyin', /(^|\.)douyin\.com$/],
  ['douyin', /(^|\.)iesdouyin\.com$/],
  ['kuaishou', /(^|\.)kuaishou\.com$/],
  // 快手短链的**中转域**：v.kuaishou.com → v.m.chenzhongtech.com → www.kuaishou.com
  // 不认它的话，resolveShort 的每一跳白名单校验会在中间那跳就把自己拦下来
  ['kuaishou', /(^|\.)chenzhongtech\.com$/],
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function platformOf(host) {
  for (const [name, re] of PLATFORM_RULES) if (re.test(host)) return name;
  return null;
}

// 域名是否在白名单内（白名单是"根域"，子域自动放行：www./m./api. 都行）
function hostAllowed(host) {
  if (!host) return false;
  const list = cfg.policy.linkParse?.hosts || [];
  return list.some((h) => host === h || host.endsWith('.' + h));
}

// ---------- 从各种来源里抠出 URL ----------
// ⚠️ 中文标点也要当分隔符 —— 群里常见「看看这个 https://b23.tv/xxx 挺好笑」
const URL_RE = /https?:\/\/[^\s"'<>()[\]{}，。；！？、“”‘’]+/gi;

function extractUrls(text) {
  const out = [];
  const seen = new Set();
  const s = String(text || '');
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    // 去掉尾部可能粘上的英文标点
    const u = m[0].replace(/[.,;:!?）)】」"']+$/, '');
    // 去重 —— 同一条消息里链接常出现两次（正文一次、引用/卡片里一次），
    // 不去重的话上游会以为是两个链接
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length > 30) break;
  }
  return out;
}

// 递归收集一个对象里所有字符串值。
// 为什么不用固定字段名：卡片的 ark_type 有多种（feed / tuwen / news / contact_card…），
// 每种 fields 的键都不一样。扫"值"比猜"键"稳得多。
function deepStrings(obj, out = [], depth = 0) {
  if (depth > 6 || out.length > 300) return out;
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const v of obj) deepStrings(v, out, depth + 1); return out; }
  if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) deepStrings(v, out, depth + 1); }
  return out;
}

// ---------- 主入口：从一条消息里找出第一个"我们认得的"链接 ----------
function findLink(msg) {
  const lp = cfg.policy.linkParse;
  if (!lp?.enabled || !msg) return null;

  const sources = [];

  // ① 正文
  sources.push(String(msg.content || ''));

  // ② 被引用的原文（引用消息时，链接常在引用里）
  for (const el of (Array.isArray(msg.msg_elements) ? msg.msg_elements : [])) {
    sources.push(String(el?.content || ''));
  }

  // ③ 卡片：ark_data 里所有字符串值
  if (msg.ark_data) sources.push(...deepStrings(msg.ark_data));

  // ④ 卡片/富媒体的其他可能位置
  for (const k of ['ark_data_raw', 'attachments', 'msg_elements']) {
    if (msg[k]) sources.push(...deepStrings(msg[k]));
  }

  const blob = sources.join('\n').slice(0, lp.maxTextLen || 2000);

  for (const url of extractUrls(blob)) {
    const host = hostOf(url);
    if (!hostAllowed(host)) continue;               // 🔒 SSRF 第一道闸
    const platform = platformOf(host);
    if (!platform) continue;
    if (lp.platforms && lp.platforms[platform] === false) continue;   // 平台开关
    return { url, host, platform };
  }
  return null;
}

// ---------- 限流 / 开关（在 index.js 里调用）----------
const lastAt = new Map();      // scope -> ts
let linkDay = '';
let linkCount = 0;

function beijingToday() {
  const d = new Date();
  const bj = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  return `${bj.getFullYear()}-${bj.getMonth() + 1}-${bj.getDate()}`;
}

function inQuietHours() {
  if (cfg.policy.quietHoursEnabled === false) return false;
  const d = new Date();
  const bj = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  const h = bj.getHours();
  const [a, b] = cfg.policy.quietHours;
  return a <= b ? (h >= a && h < b) : (h >= a || h < b);
}

// 能不能解析：返回 { ok, why }
function linkAllowed(scope) {
  const lp = cfg.policy.linkParse || {};
  if (!lp.enabled) return { ok: false, why: '链接解析已关闭' };
  if (inQuietHours()) return { ok: false, why: '静默时段' };

  const today = beijingToday();
  if (today !== linkDay) { linkDay = today; linkCount = 0; }
  if (linkCount >= (lp.dailyLimit || 200)) return { ok: false, why: `今日链接解析已达上限(${lp.dailyLimit})` };

  const gap = lp.cooldownMs ?? 3000;
  const last = lastAt.get(scope) || 0;
  if (Date.now() - last < gap) {
    return { ok: false, why: `同群冷却中(${Math.round((gap - (Date.now() - last)) / 1000)}s)` };
  }
  return { ok: true };
}

function markLink(scope) {
  lastAt.set(scope, Date.now());
  linkCount++;
}

// 每 5 分钟清一次冷却表，防内存涨
setInterval(() => {
  const now = Date.now();
  const max = Math.max(cfg.policy.linkParse?.cooldownMs || 3000, 60 * 1000) * 2;
  for (const [k, t] of lastAt) if (now - t > max) lastAt.delete(k);
}, 5 * 60 * 1000).unref();

// ---------- HTTP 小工具 ----------
function timeout() { return cfg.policy.linkParse?.timeoutMs || 8000; }

async function getJson(url, headers = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(timeout()),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// 取网页文本（可自定义 UA）
async function getText(url, headers = {}) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...headers,
    },
    signal: AbortSignal.timeout(timeout()),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 🔴🔴 抖音必须用**爬虫 UA** —— 这是整条路的关键（2026-09-22 实测，试了 6 种 UA 才找到）：
//      · 普通 UA / 手机 UA → 只返回**空壳**：
//          `_ROUTER_DATA` 里只有页面上下文（ua/webId/itemId/abParams），**没有视频数据**；
//          `iesdouyin.com/web/api/v2/aweme/iteminfo` 和 `douyin.com/aweme/v1/web/aweme/detail`
//          两个接口都是 **HTTP 200 但正文长度为 0**（抖音把数据放在签名请求后面了）。
//      · 爬虫 UA（Googlebot / Baiduspider / bingbot / Sogou，实测都行）→ 返回 **SEO 页面**，
//        里面带 `application/ld+json` 的 **VideoObject**：
//        标题 / 作者 / 发布日期 / 时长 / 封面 / 点赞评论数，**全都有** ✅
//     本质仍是普通 HTTP GET（不是协议破解），但属于「伪装爬虫」，
//     平台哪天改 SEO 策略就可能失效 —— 所以解析失败时要能安静降级，别报错刷屏。
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// 从 s 的 pos 处（必须是 { 或 [）向后配平，返回结束下标（跳过字符串里的括号）
function matchFrom(s, pos) {
  const open = s[pos];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let j = pos; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

// 找「能包住 anchor 的最小 JSON 对象」
//
// 用途：快手的分享页把作品数据内嵌在一个**没有变量名**的 JSON 块里，
//       只能靠"先找到 `"caption"`，再往回找一个能包住它的 `{`"来定位。
// ⚠️ 不能简单地"往前找最近的 `{`" —— 那个可能是个已经闭合的兄弟对象，
//    必须逐个往前试、正向配平，取**第一个结束位置在 anchor 之后**的。
function enclosingJson(s, anchor, win = 400000) {
  const starts = [];
  for (let j = anchor; j > Math.max(0, anchor - win); j--) if (s[j] === '{') starts.push(j);
  for (const st of starts.slice(0, 80)) {
    const end = matchFrom(s, st);
    if (end > anchor) return { start: st, end, raw: s.slice(st, end) };
  }
  return null;
}

// 抽 <script type="application/ld+json"> 里 @type 匹配的那一块
function extractLdJson(html, type) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const o = JSON.parse(m[1]);
      if (o && o['@type'] === type) return o;
    } catch { /* 跳过坏块 */ }
  }
  return null;
}

// ISO8601 时长 → 秒（YouTube/抖音 用的是 `PT0H13M4S` 这种）
function parseIsoDuration(s) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(String(s || ''));
  if (!m) return 0;
  const [, d, h, mi, se] = m;
  return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(mi || 0) * 60) + Math.round(Number(se || 0));
}

// ---------- GitHub ----------
// 官方 REST API，未认证 60 次/小时（够个人群用；要更高就配 GITHUB_TOKEN）
async function fetchGithub(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, '');
  if (/^(issues|pull|pulls|releases|actions|blob|tree|commit|commits)$/i.test(owner)) return null;

  const headers = { Accept: 'application/vnd.github+json' };
  if (cfg.policy.linkParse?.githubToken) headers.Authorization = 'Bearer ' + cfg.policy.linkParse.githubToken;

  const j = await getJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, headers);
  if (!j || !j.full_name) return null;
  return {
    platform: 'github',
    fullName: j.full_name,
    desc: j.description || '',
    owner: j.owner?.login || owner,
    language: j.language || '',
    stars: j.stargazers_count || 0,
    forks: j.forks_count || 0,
    issues: j.open_issues_count || 0,
    created: fmtDate(j.created_at),
    pushed: fmtDate(j.pushed_at),
    license: j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : '',
    topics: Array.isArray(j.topics) ? j.topics.slice(0, 5) : [],
    htmlUrl: j.html_url || url,
    // 🆕 仓库预览图：GitHub 自动生成的 OpenGraph 图（实测 1200×600，正好 2:1）
    //
    // ⚠️ 这张图是**给 QQ 去下载的**，我们自己不拉 —— 所以不占我们带宽、也不涉及 SSRF。
    // ⚠️ 路径里的 hash 部分**随便填都行**（实测 `1` 和 `abc123` 返回同一张图），
    //    所以不用为了拿图多调一次 API。
    ogImage: `https://opengraph.githubassets.com/1/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  };
}

// ---------- B站 ----------
// b23.tv 短链 → 手动跟随跳转，**每一跳都校验域名**
//
// 🔴 为什么不能图省事用 redirect:'follow' + 事后检查 r.url：
//    那样内网请求**在校验之前就已经发出去了**。
//    只要白名单域名上挂一个开放重定向（b23.tv/x → http://169.254.169.254/），
//    就能把我们带去读云元数据 —— 这是教科书级 SSRF。
//    ✅ 正解：redirect:'manual'，拿到 Location 后**先校验域名再发下一跳**。
async function resolveShort(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeout()),
    });

    // 不是 3xx → 这里就是终点
    if (r.status < 300 || r.status >= 400) {
      const h = hostOf(current);
      if (!hostAllowed(h) || !platformOf(h)) throw new Error('短链落点在白名单外：' + h);
      return current;
    }

    const loc = r.headers.get('location');
    if (!loc) throw new Error('短链返回了 ' + r.status + ' 但没有 Location');
    const next = new URL(loc, current).href;

    // ⚠️ 关键：**这一跳的目标**先校验，再决定要不要发下一个请求
    const nh = hostOf(next);
    if (!hostAllowed(nh)) {
      throw new Error(`短链跳转到了白名单外的地址：${nh}`);
    }
    current = next;
  }
  throw new Error('短链跳转次数过多（>5 跳）');
}

function extractVideoId(u) {
  const s = String(u);
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { kind: 'bvid', id: bv[0] };
  const av = s.match(/\/av(\d+)/i);
  if (av) return { kind: 'aid', id: av[1] };
  const ep = s.match(/\/ep(\d+)/i);
  if (ep) return { kind: 'ep', id: ep[1] };
  return null;
}

async function fetchBilibili(url) {
  let target = url;
  if (/(^|\.)b23\.tv$/.test(hostOf(url))) target = await resolveShort(url);

  const vid = extractVideoId(target);
  if (!vid) return null;

  const H = { Referer: 'https://www.bilibili.com' };
  let view = null;

  if (vid.kind === 'bvid' || vid.kind === 'aid') {
    const q = vid.kind === 'bvid' ? `bvid=${vid.id}` : `aid=${vid.id}`;
    const j = await getJson(`https://api.bilibili.com/x/web-interface/view?${q}`, H);
    if (j.code !== 0 || !j.data) return null;
    view = j.data;
  } else {
    // 番剧 ep → 先换 bvid
    const j = await getJson(`https://api.bilibili.com/x/web-interface/view?ep_id=${vid.id}`, H);
    if (j.code !== 0 || !j.data) return null;
    view = j.data;
  }

  const d = view;
  return {
    platform: 'bilibili',
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: String(d.title || '').trim(),
    desc: String(d.desc || '').replace(/\s+/g, ' ').trim(),
    up: d.owner?.name || '',
    upMid: d.owner?.mid,
    pubdate: fmtDate(d.pubdate ? new Date(d.pubdate * 1000).toISOString() : ''),
    duration: fmtDuration(d.duration),
    durationSec: d.duration || 0,
    view: d.stat?.view || 0,
    like: d.stat?.like || 0,
    danmaku: d.stat?.danmaku || 0,
    cover: String(d.pic || '').replace(/^http:/, 'https:'),   // ⚠️ API 给的是 http，统一升到 https
    tname: d.tname || '',
    htmlUrl: `https://www.bilibili.com/video/${d.bvid}`,
  };
}

// ---------- 格式化 ----------
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  // ⚠️ 用 2 位小数（原来 1 位）—— 249732 显示成「25.0 万」太糊了，Star 数要看得出量级差
  if (v >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
  return String(v);
}

// Markdown 转义：**只转义真正会影响"行内渲染"的字符**。
//
// ⚠️ 别图省事把 `- . + ! # >` 也一起转义（第一版就这么干的，实测卡片里出现了
//    `Xiaojingyu\-QQbot`、`正则规则 \+ L1` 这种）。它们在正文里毫无副作用；
//    而且 QQ 的 markdown 是**自研方言**，多出来的反斜杠有被**原样显示**的风险。
//
// ⚠️ `#` 和 `>` 也**不用**转义 —— 它们只在"行首"才起作用，而我们在上面
//    已经把换行压成空格了，行首语义根本不会出现。
const MD_ESC = /[\\`*_[\]|~]/g;

function mdEsc(s) {
  return String(s || '').replace(MD_ESC, '\\$&').replace(/[\r\n]+/g, ' ').trim();
}

// 截断 + 省略号（直接 slice 会像"说了一半"）
function cut(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ---------- 抖音（2026-09-22 新增）----------
//
// 链路：v.douyin.com/IbTyOLmZyDY/ → www.iesdouyin.com/share/video/{id}/ → www.douyin.com/video/{id}
// 🔴 取数据必须停在 **share 页**、并且用 **爬虫 UA**（原因见上面 BOT_UA 的注释）。
// ⚠️ 抖音**拿不到视频直链** —— SEO 页面里没有 contentUrl、没有 .mp4、没有 douyinvod。
//    所以抖音只发卡片、发不了视频（用户已知晓）。想发视频得逆向签名参数，那条路
//    又脆又容易触发风控，**不做**。
async function fetchDouyin(url) {
  let target = url;
  if (/^v\.douyin\.com$/i.test(hostOf(url))) target = await resolveShort(url);

  const id = (target.match(/\/video\/(\d{6,})/) || [])[1]
    || (target.match(/\/share\/video\/(\d{6,})/) || [])[1]
    || (target.match(/[?&]modal_id=(\d{6,})/) || [])[1];
  if (!id) return null;

  const html = await getText(`https://www.iesdouyin.com/share/video/${id}/`, { 'User-Agent': BOT_UA });
  const ld = extractLdJson(html, 'VideoObject');
  if (!ld) return null;

  // interactionStatistic 是个数组，每项形如 { interactionType: {'@type':'LikeAction'}, userInteractionCount: 34146 }
  const stat = (kind) => {
    for (const it of (ld.creator?.interactionStatistic || [])) {
      const t = String(it.interactionType?.['@type'] || it.interactionType || '');
      if (t.toLowerCase().includes(kind.toLowerCase())) return Number(it.userInteractionCount) || 0;
    }
    return 0;
  };

  const sec = parseIsoDuration(ld.duration);
  return {
    platform: 'douyin',
    id,
    // ⚠️ 抖音的 name 结尾自带「 - 抖音」，得剪掉，否则卡片标题很脏
    title: String(ld.name || '').replace(/\s*[-–]\s*抖音\s*$/, '').trim(),
    author: ld.creator?.name || '',
    authorUrl: ld.creator?.url || '',
    pubdate: fmtDate(ld.uploadDate),
    durationSec: sec,
    duration: fmtDuration(sec),
    cover: (Array.isArray(ld.thumbnailUrl) ? ld.thumbnailUrl[0] : ld.thumbnailUrl) || '',
    like: stat('Like'),
    comment: stat('Comment'),
    view: stat('View') || stat('Watch'),
    htmlUrl: `https://www.douyin.com/video/${id}`,
  };
}

// ---------- 快手（2026-09-22 新增）----------
//
// 链路：v.kuaishou.com/JJYSn5HT → v.m.chenzhongtech.com/fw/photo/3x2qw55sgce69uq
//                                → www.kuaishou.com/short-video/3x2qw55sgce69uq
// 🔴 必须用 **手机 UA** 抓最终的 www.kuaishou.com 页面（163KB）：
//    作品数据是一个**没有变量名**的 8.6KB JSON 内嵌在 HTML 里，
//    靠「先找 `"caption"`，再先后找一个能包住它的 `{`」定位（见 enclosingJson）。
// ✅ 快手**有视频直链** —— 同一个 JSON 里的 `mainMvUrls[].url`，
//    实测能下（HTTP 206 / video/mp4 / 2.1MB）。
async function fetchKuaishou(url) {
  let target = url;
  if (/^v\.kuaishou\.com$/i.test(hostOf(url))) target = await resolveShort(url);

  const html = await getText(target, { 'User-Agent': MOBILE_UA });
  const at = html.indexOf('"caption"');
  if (at < 0) return null;

  const box = enclosingJson(html, at + 5);
  if (!box) return null;

  let o;
  try { o = JSON.parse(box.raw); } catch { return null; }
  if (!o || (!o.caption && !o.photoId)) return null;

  const firstUrl = (v) => {
    const arr = Array.isArray(v) ? v : [v];
    for (const x of arr) {
      const u = typeof x === 'string' ? x : (x && (x.url || x.cdn)) || '';
      if (/^https?:/.test(u)) return u;
    }
    return '';
  };

  // ⚠️ 直链带签名参数（pkey），**有时效**，拿到就得马上下载，别缓存
  const mv = (Array.isArray(o.mainMvUrls) ? o.mainMvUrls : []).map((x) => x && (x.url || x.cdn)).filter(Boolean);
  // 优先非 hd 档（hd 体积大，容易撞 30MB 上限）
  const videoUrl = mv.find((u) => !/\/hd\d*\.mp4/.test(u)) || mv[0] || '';

  const sec = Math.round((Number(o.duration) || 0) / 1000);
  return {
    platform: 'kuaishou',
    id: String(o.photoId || ''),
    title: String(o.caption || '').trim(),
    author: o.userName || '',
    pubdate: fmtDate(o.timestamp ? new Date(Number(o.timestamp)).toISOString() : ''),
    durationSec: sec,
    duration: fmtDuration(sec),
    cover: firstUrl(o.coverUrls) || firstUrl(o.webpCoverUrls),
    like: Number(o.likeCount) || 0,
    view: Number(o.viewCount) || 0,
    comment: Number(o.commentCount) || 0,
    htmlUrl: o.photoId ? `https://www.kuaishou.com/short-video/${o.photoId}` : target,
    _mvUrl: videoUrl,      // 仅供 getKuaishouVideoUrl 用，不进卡片
  };
}

// ---------- 快手视频直链（P2 用）----------
// 和 B站不同：快手的直链**就在解析时已经拿到了**，不用再发一次请求。
// 但签名有时效，所以必须在解析完的**几秒内**下载完。
async function getKuaishouVideoUrl(info, maxBytes) {
  const v = cfg.policy.linkParse?.video;
  if (!v?.enabled) return null;
  if (!info?._mvUrl) return null;
  return {
    url: info._mvUrl,
    size: 0,                       // 快手不给 size，只能边下边卡
    headers: { 'User-Agent': MOBILE_UA, Referer: 'https://www.kuaishou.com/' },
  };
}

// ---------- 渲染成 QQ Markdown 卡片 ----------
// 语法来自官方文档（实测确认）：# 标题 / **加粗** / [文字](url) / ![alt #宽px #高px](url)
// ⚠️ 长文本折行要用零宽空格 \u200B，不能用 \n
const ZWSP = '\u200B';

function renderCard(info) {
  if (!info) return null;
  if (info.platform === 'github') return renderGithub(info);
  if (info.platform === 'douyin') return renderDouyin(info);
  if (info.platform === 'kuaishou') return renderKuaishou(info);
  return renderBilibili(info);
}

// 抖音 / 快手 共用一个"短视频"版式（字段完全一样，只有平台名和按钮文字不同）
function renderShortVideo(v, brand, siteName) {
  const lines = [];
  lines.push(`# ${mdEsc(cut(v.title, 40))}`);
  // 封面统一按 16:9 摆（竖屏视频会被裁，但比不显示强）
  if (v.cover) lines.push(`![封面 #480px #270px](${v.cover})`);

  const pub = [
    v.author && `**作者**：${mdEsc(v.author)}`,
    v.duration && `**时长**：${v.duration}`,
  ].filter(Boolean).join('　');
  if (pub) lines.push(pub);
  if (v.pubdate) lines.push(`**发布**：${v.pubdate}`);

  const nums = [];
  if (v.view) nums.push(`播放 ${fmtNum(v.view)}`);
  if (v.like) nums.push(`点赞 ${fmtNum(v.like)}`);
  if (v.comment) nums.push(`评论 ${fmtNum(v.comment)}`);
  if (nums.length) lines.push(nums.join('　·　'));

  lines.push(`[🔗 在 ${brand} 打开](${v.htmlUrl})`);
  return lines.join(ZWSP + '\n');
}

function renderDouyin(v) {
  return renderShortVideo(v, '抖音', '抖音');
}

function renderKuaishou(v) {
  return renderShortVideo(v, '快手', '快手');
}

function renderBilibili(b) {
  const lines = [];
  lines.push(`# ${mdEsc(b.title)}`);
  if (b.cover) lines.push(`![封面 #480px #270px](${b.cover})`);

  // ⚠️ 标签后面用**全角冒号**，不要用半角空格 ——
  //    实测（2026-09-22）QQ 的 markdown 会把 `**加粗**` 后面的半角空格**吃掉**，
  //    于是「**发布** 2020-01-01」渲染成「发布2020-01-01」，挤在一起很难看。
  const pub = [
    b.pubdate && `**发布**：${b.pubdate}`,
    b.duration && `**时长**：${b.duration}`,
  ].filter(Boolean).join('　');
  if (pub) lines.push(pub);

  if (b.up) lines.push(`**UP主**：${mdEsc(b.up)}`);

  const nums = [`播放 ${fmtNum(b.view)}`];
  if (b.like) nums.push(`点赞 ${fmtNum(b.like)}`);
  if (b.danmaku) nums.push(`弹幕 ${fmtNum(b.danmaku)}`);
  lines.push(nums.join('　·　'));

  if (b.desc && b.desc !== '-') lines.push(`> ${mdEsc(cut(b.desc, 80))}`);
  lines.push(`[🔗 在 B站打开](${b.htmlUrl})`);
  return lines.join(ZWSP + '\n');
}

function renderGithub(g) {
  const lines = [];
  lines.push(`# ${mdEsc(g.fullName)}`);
  // 预览图放标题下面（和 B站卡片一致）。GitHub 的 OG 图是 1200×600 = 2:1，所以用 #600px #300px
  if (g.ogImage) lines.push(`![仓库预览 #600px #300px](${g.ogImage})`);
  if (g.desc) lines.push(`> ${mdEsc(cut(g.desc, 100))}`);
  lines.push(`**作者**：${mdEsc(g.owner)}${g.language ? `　**语言**：${mdEsc(g.language)}` : ''}`);
  lines.push(`**Star**：${fmtNum(g.stars)}　**Fork**：${fmtNum(g.forks)}　**Issue**：${g.issues}`);
  lines.push(`**创建**：${g.created}　**最近推送**：${g.pushed}${g.license ? `　**许可**：${g.license}` : ''}`);
  if (g.topics?.length) lines.push(`**标签** ${g.topics.map(mdEsc).join(' / ')}`);
  lines.push(`[🔗 在 GitHub 打开](${g.htmlUrl})`);
  return lines.join(ZWSP + '\n');
}

// ---------- B站视频直链（P2 用）----------
//
// 🔴 必须带 `Referer: https://www.bilibili.com` —— B站直链有防盗链。实测（2026-09-22）：
//     · 我们自己的服务器**带 Referer** 能下（10MB / 10.2s ✅）
//     · 让 QQ 平台去下（URL 转存）**下不到**，报 `40093007 富媒体文件下载失败`
//     · 同一个 URL 不带 Referer 也是 403
//    所以 P2 只能「我们自己下载 → 分片上传」，不能把直链丢给 QQ。
//
// ⚠️ 返回的 url 带签名参数（`?e=...`），**有时效**，拿到就要马上下载。
async function getBilibiliVideoUrl(info, maxBytes) {
  const v = cfg.policy.linkParse?.video;
  if (!v?.enabled) return null;
  const H = { Referer: 'https://www.bilibili.com' };

  const fetchOne = async (qn) => {
    const j = await getJson(
      `https://api.bilibili.com/x/player/playurl?bvid=${info.bvid}&cid=${info.cid}&qn=${qn}&fnval=1`, H);
    if (j.code !== 0 || !j.data || !j.data.durl || !j.data.durl.length) return null;
    const d = j.data.durl[0];
    return {
      url: d.url,
      size: d.size || 0,
      quality: j.data.quality,
      format: j.data.format,
      accept: j.data.accept_quality || [],
      headers: H,          // 下载时带同样的 Referer
    };
  };

  let r = await fetchOne(v.quality || 16);   // 默认 16 = 360P
  if (!r) return null;

  // 首选清晰度就超限 → 试更低档里最小的一档（能省一次就省一次）
  if (maxBytes && r.size && r.size > maxBytes && r.accept.length) {
    const lower = r.accept.filter((q) => q < r.quality).sort((a, b) => a - b);
    if (lower.length) {
      const r2 = await fetchOne(lower[0]);
      if (r2 && r2.size && r2.size < r.size) {
        r2.downgraded = true;
        return r2;
      }
    }
  }
  return r;
}

// ---------- 对外主流程 ----------
// 返回 { platform, info, card } 或 null
async function parse(link) {
  let info = null;
  if (link.platform === 'github') info = await fetchGithub(link.url);
  else if (link.platform === 'bilibili') info = await fetchBilibili(link.url);
  else if (link.platform === 'douyin') info = await fetchDouyin(link.url);
  else if (link.platform === 'kuaishou') info = await fetchKuaishou(link.url);
  if (!info) return null;
  return { platform: link.platform, info, card: renderCard(info) };
}

module.exports = {
  findLink,
  parse,
  linkAllowed,
  markLink,
  renderCard,
  getBilibiliVideoUrl,
  getKuaishouVideoUrl,
  extractUrls,
  hostOf,
  platformOf,
  hostAllowed,
  // 给自测用
  _fmtDuration: fmtDuration,
  _fmtNum: fmtNum,
  _extractVideoId: extractVideoId,
  _mdEsc: mdEsc,
  _enclosingJson: enclosingJson,
  _extractLdJson: extractLdJson,
  _parseIsoDuration: parseIsoDuration,
};
