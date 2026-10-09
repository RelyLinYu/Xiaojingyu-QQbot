'use strict';
/**
 * 抖音无水印直链 —— 2026-10-09 新增
 * ============================================================
 * 背景：本文件所在的 linkparse.js 里，2026-09-22 那版的结论是
 *       「抖音拿不到视频直链，决定不做」。2026-10-09 找到了能走通的路径。
 *
 * 【为什么以前拿不到】
 *   · 分享页（iesdouyin 现在的落地页）**不渲染 <video>**，只发
 *     `snssdk1128://aweme/detail/{id}` 唤起 App —— 老办法取 video.src 必然抛异常
 *   · detail 接口要求 URL 带 `a_bogus` 签名（抖音页面 JS 实时生成、绑定参数+时间戳）
 *     ⇒ 纯 fetch 手拼 URL：要么 `403 Blocked by ArgusSecurityPlugin Uifid Not Found`，
 *        要么 200 但正文 0 字节
 *
 * 【现在的做法】
 *   起一个无头浏览器打开 `https://www.douyin.com/video/{id}`，
 *   页面自己会发出带 a_bogus 的 `aweme/v1/web/aweme/detail/` 请求，
 *   用 CDP 监听并取回响应体 → `aweme_detail.video.play_addr.url_list`。
 *
 * 【⚠️ 三件事必须做对，少一件必失败】
 *   1. **先访问一次首页** `https://www.douyin.com/`，让服务端下发 UIFID / ttwid cookie
 *      —— 少了这步，detail 一律 200 但 body 为空（静默失败，最难查）
 *   2. 服务器以 **root** 运行 ⇒ 浏览器必须带 `--no-sandbox`
 *   3. 只有 **2G 内存** ⇒ 必须**串行**，同时开两个必 OOM（下面有锁）
 *
 * 【依赖】
 *   系统装了 chrome-headless-shell（纯二进制，**不是 npm 依赖**）。
 *   路径可用环境变量 DY_BROWSER 覆盖；见 tools/ops/ 下的安装脚本。
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BROWSER = process.env.DY_BROWSER || '/opt/chrome-headless-shell/chrome-headless-shell';
const PROFILE = process.env.DY_PROFILE || path.join(os.tmpdir(), 'dy-profile');
const NAV_TIMEOUT = Number(process.env.DY_NAV_TIMEOUT || 35000);   // 单次导航等 detail 的上限
const BOOT_TIMEOUT = Number(process.env.DY_BOOT_TIMEOUT || 40000); // 等浏览器 CDP 就绪的上限
// ⚠️⚠️ UA 必须与**真实平台**一致！这是本项目最贵的一个坑：
//     服务器是 Linux，若 UA 声称 Windows，抖音请求里的 `pc_libra_divert` 会是 Linux，
//     与 UA 自相矛盾 → 直接命中风控 → `detail` 响应恒为 **0 字节**（静默失败，最难查）。
//     实测（2026-10-09）：Windows UA 下响应 0 字节；换 Linux UA 立刻拿到 61 KB。
const UA = process.platform === 'win32'
  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const UA_PLATFORM = process.platform === 'win32' ? 'Win32' : 'Linux x86_64';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// 串行锁：2G 内存扛不住两个浏览器，宁可排队也不能并发
// ------------------------------------------------------------
let chain = Promise.resolve();
let lastFinishAt = 0;
// ⚠️ 两次解析之间至少隔这么久 —— 抖音对同一 IP 的 detail 请求有**频率限制**，
//    连着跑会出现「响应恒为 0 字节」（2026-10-09 实测：连跑 3 条时后面几条必失败；
//    停 45~60 秒即恢复）。宁可慢几秒，也别让第二条空手而归。
let minGapMs = Number(process.env.DY_MIN_GAP_MS || 8000);

function withLock(fn) {
  const run = chain.then(async () => {
    const wait = lastFinishAt + minGapMs - Date.now();
    if (wait > 0) {
      console.log(`  │  └ 抖音直链：距上次解析不足 ${minGapMs}ms，等 ${wait}ms（避开风控）`);
      await sleep(wait);
    }
    try { return await fn(); } finally { lastFinishAt = Date.now(); }
  }, async () => {
    try { return await fn(); } finally { lastFinishAt = Date.now(); }
  });
  // 无论成败都不让链条断掉
  chain = run.then(() => {}, () => {});
  return run;
}

let portSeq = 9460;
function nextPort() {
  portSeq = portSeq >= 9500 ? 9460 : portSeq + 1;
  return portSeq;
}

/** 起浏览器 + 连 CDP，返回 { send, close } */
async function launch() {
  if (!fs.existsSync(BROWSER)) {
    throw new Error(`找不到浏览器：${BROWSER}（请设置 DY_BROWSER 或先跑安装脚本）`);
  }
  try { fs.mkdirSync(PROFILE, { recursive: true }); } catch { }

  const port = nextPort();
  const child = spawn(BROWSER, [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--mute-audio',
    // 去自动化特征 + 中文环境，都是降低风控命中率的
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1600,900',
    'about:blank',
  ], { stdio: 'ignore' });

  const close = () => { try { child.kill('SIGKILL'); } catch { } };

  let wsUrl = null;
  for (let i = 0; i < Math.floor(BOOT_TIMEOUT / 500); i++) {
    await sleep(500);
    if (child.exitCode !== null) {
      throw new Error(`浏览器提前退出 exitCode=${child.exitCode}（root 下是否漏了 --no-sandbox？）`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch { }
  }
  if (!wsUrl) { close(); throw new Error('浏览器 CDP 未就绪'); }

  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });

  const send = (method, params = {}, sid) => new Promise((res) => {
    const mid = ++seq;
    pending.set(mid, res);
    ws.send(JSON.stringify(sid ? { id: mid, method, params, sessionId: sid } : { id: mid, method, params }));
  });

  return { send, close, events, ws };
}

/**
 * 取无水印直链。
 * @param {string} awemeId 视频 id
 * @returns {Promise<{playUrl:string, cover:string, durationMs:number, videoId:string}|null>}
 *          失败一律返回 null（调用方安静跳过，不要刷屏）
 */
async function fetchDirect(awemeId, opts = {}) {
  // 超时与间隔可由调用方覆盖（config.linkParse.douyinDirect 会把值传下来）
  const navTimeout = Number(opts.navTimeoutMs) || NAV_TIMEOUT;
  if (Number(opts.minGapMs) > 0) minGapMs = Number(opts.minGapMs);
  if (!/^\d{6,}$/.test(String(awemeId || ''))) return null;
  return withLock(async () => {
    let ctx = null;
    try {
      ctx = await launch();
      const { send, close, events } = ctx;
      const t = await send('Target.createTarget', { url: 'about:blank' });
      const sid = (await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })).result.sessionId;
      await send('Network.enable', {}, sid);
      await send('Page.enable', {}, sid);
      await send('Emulation.setUserAgentOverride',
        { userAgent: UA, platform: UA_PLATFORM, acceptLanguage: 'zh-CN,zh;q=0.9' }, sid);
      // navigator.webdriver 是最显眼的自动化标志，抹掉
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'Object.defineProperty(navigator,"webdriver",{get:()=>undefined});',
      }, sid);

      // ① 预热：不访问首页就没有 UIFID/ttwid，detail 会静默返回空
      await send('Page.navigate', { url: 'https://www.douyin.com/' }, sid);
      await sleep(6000);

      // ② 打开内容页。
      // ⚠️ 只试 `/video/{id}`：实测它对**视频和图文都有效**（抖音会自行处理）；
      //    而 `/note/{id}` **根本不发 detail 请求** —— 试它等于白等一整个超时
      //    （踩过两次，别再把它加回来）
      let detail = null;
      for (const p of [`video/${awemeId}`]) {
        events.length = 0;
        await send('Page.navigate', { url: `https://www.douyin.com/${p}` }, sid);
        const deadline = Date.now() + navTimeout;
        while (Date.now() < deadline && !detail) {
          await sleep(800);
          for (const e of events) {
            if (e.method !== 'Network.requestWillBeSent' || e.sessionId !== sid) continue;
            if (!/aweme\/v1\/web\/aweme\/detail/.test(e.params.request.url)) continue;
            const b = await send('Network.getResponseBody', { requestId: e.params.requestId }, sid);
            const raw = b?.result?.body || '';
            const txt = b?.result?.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
            if (txt.includes('aweme_detail')) { detail = txt; break; }
          }
        }
        if (detail) break;
      }
      if (!detail) return null;

      const a = (JSON.parse(detail).aweme_detail) || {};
      const v = a.video || {};

      // 挑地址：h264 优先（QQ 侧对 H.265 支持不好），同编码下再比码率
      const cands = [];
      for (const b of (v.bit_rate || [])) {
        const u = b?.play_addr?.url_list?.[0];
        if (u) cands.push({
          url: u,
          bitRate: b.bit_rate || 0,
          key: b.play_addr?.url_key || '',
          dataSize: b.play_addr?.data_size || 0,   // 供上层判断是否超过发送上限
        });
      }
      for (const u of (v.play_addr?.url_list || [])) {
        if (u.includes('/aweme/v1/play/')) continue;   // 跳转接口，优先 CDN 直链
        if (/\.mp3(\?|$)/i.test(u)) continue;          // 图文会混入背景音乐
        cands.push({ url: u, bitRate: 0, key: '' });
      }
      cands.sort((x, y) => {
        const xh = /h264/i.test(x.key) ? 1 : 0;
        const yh = /h264/i.test(y.key) ? 1 : 0;
        if (xh !== yh) return yh - xh;
        return y.bitRate - x.bitRate;
      });
      // 图文作品没有 video，数据在 images[] —— 也要带回去（这类作品"直链"就是图片）
      const images = (a.images || [])
        .map((im) => ({ url: (im.url_list || [])[0] || '', w: im.width, h: im.height }))
        .filter((x) => x.url);
      if (!cands.length && !images.length) return null;

      return {
        playUrl: cands.length ? cands[0].url : null,
        playSize: cands.length ? (cands[0].dataSize || 0) : 0,
        altCount: Math.max(0, cands.length - 1),
        images,
        cover: v.cover?.url_list?.[0] || (images[0]?.url || ''),
        durationMs: v.duration || 0,
        videoId: v.play_addr?.uri || '',
      };
    } catch (e) {
      // 只记一行，不抛 —— 抖音这条链路的失败是常态，不能影响主流程
      console.log(`  │  └ 抖音直链获取失败：${e.message}`);
      return null;
    } finally {
      if (ctx) { try { ctx.ws.close(); } catch { } ctx.close(); }
    }
  });
}

module.exports = { fetchDirect, BROWSER };
