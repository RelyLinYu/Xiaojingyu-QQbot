// ============================================================
//  GitHub 仓库预览图 · 自建中转缓存
//
//  ── 为什么需要它（2026-09-22 用户反馈「GitHub 卡片的图读取不到的情况还是太多」）──
//
//  官方文档（https://bot.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html）
//  原话：「对于 markdown 消息内的图片资源，请使用可在公网访问的资源 url，
//        **开放平台会下载转存该资源**。」
//
//  也就是说：图片**不是**每个群友各自去 GitHub 抓，而是
//  **QQ 在发卡片那一刻去抓一次、转存到它自己的 CDN**。
//  抓那一下如果失败，**它不重试 → 这张卡片的图就永远没了**。
//
//  而 `opengraph.githubassets.com` 会**间歇性限流**（实测）：
//     · 密集请求 20%~50% 返回 429
//     · 间隔 500ms 仍有 40%、间隔 1 秒仍有 20%
//     · 但也有连着 20 次全过的时候 —— 间歇性的，最难排查
//
//  ⇒ 所以：**别让 QQ 直接去 GitHub 抓**，让它抓我们。
//     我们抓的时候可以**重试 + 缓存**，成功率比"QQ 抓一次就放弃"高得多。
//
//  ── 实测验证（2026-09-22，证明这条路走得通）──
//
//  在公网端口上放了一个测试路由，发了一张对比卡片，服务器日志：
//    19:50:10  /ogtest.png 抓到 156931 字节，from=49.234.25.245
//    19:50:10  /ogtest.png 抓到 156931 字节，from=49.234.25.245
//  `49.234.25.245` 是**腾讯的机器（QQ 平台）**，不是我们。一次拿到三个答案：
//    ✅ 端口公网可达  ✅ **QQ 接受 http://**  ✅ 它真的会来抓
//
//  ── 设计取舍（都是被"QQ 只抓一次"这个事实简化掉的）──
//
//  · **内存缓存就够，不落盘** —— QQ 抓完就转存到它自己的 CDN 了，
//    我们这份只是"抓的那一秒钟能提供一个 URL"，用完即弃。没有磁盘/清理问题。
//  · **不需要高可用** —— 只在**发卡片那一刻**被访问，而那一刻机器人本来就在运行。
//  · **带宽几乎为零** —— 一张图 ~150KB，且**一个卡片只被抓一次**（不是每个群友一次）。
//  · 缓存 key 用 `owner/repo` → 天然去重（同一个仓库的卡片只抓一次上游）。
//
//  ── 🔒 安全（这个路由是**公开**的，QQ 不会带密码，所以要自己防）──
//
//  · 只认 `/og/<owner>/<repo>.png` 这种**结构化路径**，
//    🔴 **绝不接受 `?url=` 之类的任意地址** —— 否则我们就是一台开放代理/SSRF 跳板。
//  · owner / repo 用**严格白名单字符集**校验，顺带挡掉 `..` 路径穿越。
//  · 上游地址是**拼出来的**（固定 host），不是用户给的。
//  · 缓存 + 每 IP 限流 + **单飞（single-flight）**：别人狂刷也不会把压力放大到 GitHub。
// ============================================================
const UPSTREAM = 'https://opengraph.githubassets.com/1';

// GitHub 用户名/仓库名的合法字符（涵盖 `-` `_` `.`，并挡掉 `/` `..` 等）
const SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// 只放内存：QQ 抓完就转存了，我们这份没有长期价值
const cache = new Map();          // key -> { buf, type, ts }
const inflight = new Map();       // key -> Promise（单飞，防同一张图并发抓多次）
const hits = new Map();           // ip -> { n, ts }

function cfgOf(opts) {
  return {
    ttlMs: opts?.ttlMs ?? 60 * 60 * 1000,     // 1 小时（仓库信息变了就重新抓）
    maxEntries: opts?.maxEntries ?? 100,      // 最多 100 张 ≈ 15MB，2G 内存绰绰有余
    ratePerMin: opts?.ratePerMin ?? 60,       // 每 IP 每分钟
    upstreamTimeoutMs: opts?.timeoutMs ?? 8000,
    retries: opts?.retries ?? 4,
  };
}

// 解析 `/og/<owner>/<repo>.png`；不合法一律返回 null
function parsePath(pathname) {
  const m = /^\/og\/([^/]+)\/([^/]+)\.png$/.exec(String(pathname || ''));
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (!SEG_RE.test(owner) || !SEG_RE.test(repo)) return null;
  if (owner.includes('..') || repo.includes('..')) return null;
  return { owner, repo, key: `${owner}/${repo}`.toLowerCase() };
}

function evict(c) {
  while (cache.size > c.maxEntries) {
    // Map 保持插入顺序 → 丢最早的那个
    const k = cache.keys().next().value;
    cache.delete(k);
  }
}

// 去上游抓（带重试 —— 这一条就是治间歇性 429 的关键）
async function fetchUpstream(key, c, log) {
  const url = `${UPSTREAM}/${key}`;
  let lastStatus = 0;
  for (let i = 0; i < c.retries; i++) {
    try {
      const r = await fetch(url, {
        // ⚠️ 用一个**自己的** UA，不伪装浏览器 ——
        //    实测伪装浏览器的 UA 更容易被 429（20%~50% vs 空 UA 的 0%）
        headers: { 'User-Agent': 'xiaolanjing-og-proxy/1.0 (+qq-bot)', Accept: 'image/*' },
        signal: AbortSignal.timeout(c.upstreamTimeoutMs),
      });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 100) throw new Error(`上游返回太小(${buf.length}B)`);
        const type = r.headers.get('content-type') || 'image/png';
        cache.set(key, { buf, type, ts: Date.now() });
        evict(c);
        log(`抓取成功 ${buf.length}B ${type}（第 ${i + 1} 次尝试）`);
        return { buf, type, fromCache: false };
      }
      lastStatus = r.status;
      log(`上游 HTTP ${r.status}（第 ${i + 1}/${c.retries} 次）`);
    } catch (e) {
      log(`上游异常 ${e.name}: ${e.message}（第 ${i + 1}/${c.retries} 次）`);
    }
    // 指数退避 + 抖动（429 就是"你太快了"，等一下就好）
    if (i < c.retries - 1) {
      await new Promise((s) => setTimeout(s, 250 * (2 ** i) + Math.floor(Math.random() * 200)));
    }
  }
  return { buf: null, type: '', fromCache: false, lastStatus };
}

// 供 logweb 调用。返回 true 表示"这个请求我处理了"，false 表示"不归我管，继续走后面的路由"
async function handle(req, res, pathname, log = () => {}, opts) {
  if (!String(pathname).startsWith('/og/')) return false;

  const parsed = parsePath(pathname);
  if (!parsed) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('用法： /og/<owner>/<repo>.png');
    return true;
  }

  const c = cfgOf(opts);
  const now = Date.now();

  // 每 IP 限流（正常情况 QQ 一张卡片只要 1 次）
  const ip = req.socket?.remoteAddress || '?';
  const h = hits.get(ip) || { n: 0, ts: now };
  if (now - h.ts > 60000) { h.n = 0; h.ts = now; }
  h.n++;
  hits.set(ip, h);
  if (h.n > c.ratePerMin) {
    log(`限流：${ip} 一分钟内第 ${h.n} 次`);
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('too many requests');
    return true;
  }

  // 缓存命中（新鲜）
  const hit = cache.get(parsed.key);
  if (hit && now - hit.ts < c.ttlMs) {
    log(`缓存命中 ${parsed.key}（${hit.buf.length}B）`);
    send(res, hit.buf, hit.type, Math.round((c.ttlMs - (now - hit.ts)) / 1000));
    return true;
  }

  // 单飞：同一张图并发只抓一次
  let task = inflight.get(parsed.key);
  if (!task) {
    task = fetchUpstream(parsed.key, c, (m) => log(`[${parsed.key}] ${m}`))
      .finally(() => inflight.delete(parsed.key));
    inflight.set(parsed.key, task);
  }
  const out = await task;

  if (out.buf) {
    send(res, out.buf, out.type, Math.round(c.ttlMs / 1000));
    return true;
  }

  // 🔴 抓不到时的两级兜底：
  //
  //  ① **有旧的就发旧的**（stale-while-error）——
  //     仓库预览图过时一点完全无所谓，总比"没有图"强。
  //     ⚠️ 这一条很关键：它把"每次都可能失败"变成"失败过一次之后基本不再失败"。
  if (hit && hit.buf) {
    log(`[${parsed.key}] 上游失败(最后 ${out.lastStatus})，**发旧缓存**（${hit.buf.length}B）`);
    send(res, hit.buf, hit.type, 300);
    return true;
  }

  //  ② 连旧的都没有 → 302 跳回 GitHub 原地址，
  //     让 QQ 自己去试一次 —— **最坏情况也不比改造前差**（以前就是直接给 GitHub 地址）。
  log(`[${parsed.key}] 无缓存且上游彻底失败(最后状态 ${out.lastStatus})，302 跳回 GitHub`);
  res.writeHead(302, { Location: `${UPSTREAM}/${parsed.key}` });
  res.end();
  return true;
}

function send(res, buf, type, maxAge) {
  res.writeHead(200, {
    'Content-Type': type || 'image/png',
    'Content-Length': buf.length,
    // 让 QQ 侧也缓存；QQ 反正会转存，这里只是礼貌
    'Cache-Control': `public, max-age=${Math.max(60, maxAge || 3600)}`,
  });
  res.end(buf);
}

module.exports = {
  handle,
  parsePath,
  // 给自测用（不要在生产代码里依赖这些）
  _cache: cache,
  _hits: hits,
  _inflight: inflight,
  _cfgOf: cfgOf,
  _UPSTREAM: UPSTREAM,
};
