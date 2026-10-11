/* ============================================================
 *  render.mjs —— 把 bigfish-promo.html 渲染成真正的 MP4
 *
 *  原理：无头 Edge 打开播放器页（?mode=render），通过 CDP 调
 *        window.__promo.renderAt(t) 把画面精确 seek 到第 t 秒，
 *        截图 → ffmpeg 合成。**逐帧可复现**，所以不会掉帧/抽风。
 *
 *  零依赖：只用 Node 22+ 内置（fetch + 全局 WebSocket + child_process）。
 *
 *  用法：
 *    node promo/render.mjs                       # 全片 → bigfish-promo.mp4
 *    node promo/render.mjs --times=2,12,33,50    # 只抽几张图看效果
 *    node promo/render.mjs --fps=25 --crf=20
 *    node promo/render.mjs --browser="C:\\...\\msedge.exe"
 * ============================================================ */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(HERE, 'bigfish-promo.html');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const flag = (k) => argv.includes('--' + k);

const FPS = Number(arg('fps', 30));
const CRF = Number(arg('crf', 18));
const TIMES = arg('times', '');
const KEEP = flag('keep');
const OUT = path.resolve(arg('out', path.join(HERE, 'bigfish-promo.mp4')));
const FRAMES_DIR = path.join(HERE, '_frames');
const PREVIEW_DIR = path.join(HERE, '_preview');

// ---------- 找浏览器 ----------
function findBrowser() {
  const explicit = arg('browser', process.env.PROMO_BROWSER || '');
  if (explicit && fs.existsSync(explicit)) return explicit;
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('没找到 Edge/Chrome，用 --browser=<路径> 指定');
}

// ---------- 找 ffmpeg ----------
function findFfmpeg() {
  const explicit = arg('ffmpeg', process.env.FFMPEG || '');
  if (explicit && fs.existsSync(explicit)) return explicit;
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', shell: true });
  if (r.status === 0) return 'ffmpeg';
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'),
    'C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin',
  ];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.toLowerCase() === 'ffmpeg.exe') return p;
      }
    }
  }
  throw new Error('没找到 ffmpeg，用 --ffmpeg=<路径> 指定，或装一个并加进 PATH');
}

// ---------- 极简 CDP 客户端 ----------
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiters = new Map();
    const listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiters.has(msg.id)) {
        const { res, rej } = waiters.get(msg.id);
        waiters.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        listeners.slice().forEach(fn => fn(msg));
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败: ' + (e.message || e.type))));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const mid = ++id;
        return new Promise((res, rej) => {
          waiters.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      on(fn) { listeners.push(fn); },
      close() { try { ws.close(); } catch {} },
    }));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitHttp(url, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error(`等 ${label} 超时（${timeoutMs}ms）`);
}

// ---------- 主流程 ----------
const browserPath = findBrowser();
const port = 9200 + Math.floor(Math.random() * 600);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-profile-'));

console.log('▸ 浏览器 :', browserPath);
console.log('▸ 播放器 :', HTML);
console.log('▸ 调试端口:', port);

const child = spawn(browserPath, [
  '--headless=new',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile,
  '--window-size=1920,1080',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--mute-audio',
  '--disable-extensions',
  '--allow-file-access-from-files',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

let cdp = null;
let ok = false;
try {
  await waitHttp(`http://127.0.0.1:${port}/json/version`, 20000, '浏览器启动');
  const list = await waitHttp(`http://127.0.0.1:${port}/json/list`, 10000, '调试目标');
  const page = list.find(t => t.type === 'page') || list[0];
  cdp = await connect(page.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };

  const url = 'file:///' + HTML.replace(/\\/g, '/') + '?mode=render';
  await cdp.send('Page.navigate', { url });

  // 等页面自报 ready
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { if (await evalJs('!!(window.__promo && window.__promo.ready)')) break; } catch {}
    await sleep(150);
  }
  if (!(await evalJs('!!(window.__promo && window.__promo.ready)'))) throw new Error('播放器没就绪（__promo.ready 一直 false）');

  const duration = await evalJs('window.__promo.duration');
  console.log('▸ 片长   :', duration, '秒');

  const shot = async (outFile) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(outFile, Buffer.from(r.data, 'base64'));
  };

  // 调试：在指定时刻求值一段表达式
  const PROBE = arg('probe', '');
  if (PROBE) {
    await evalJs(`window.__promo.renderAt(${Number(arg('probe-at', 0))})`);
    console.log(await evalJs(PROBE));
    ok = true;
  } else if (TIMES) {    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    for (const s of TIMES.split(',').map(x => Number(x.trim()))) {
      await evalJs(`window.__promo.renderAt(${s})`);
      await sleep(60);
      const f = path.join(PREVIEW_DIR, `t${String(s).replace('.', '_')}.png`);
      await shot(f);
      console.log('  ✓', path.relative(process.cwd(), f));
    }
    ok = true;
  } else {
    // 模式 B：全片
    if (fs.existsSync(FRAMES_DIR)) fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
    const total = Math.max(2, Math.round(duration * FPS));
    console.log(`▸ 逐帧截图: ${total} 帧 @ ${FPS}fps → ${path.relative(process.cwd(), FRAMES_DIR)}`);
    const t1 = Date.now();
    for (let i = 0; i < total; i++) {
      const t = Math.min(duration - 0.001, i / FPS);
      await evalJs(`window.__promo.renderAt(${t})`);
      await shot(path.join(FRAMES_DIR, 'f' + String(i).padStart(5, '0') + '.png'));
      if (i % 60 === 0 || i === total - 1) {
        const done = i + 1;
        const el = (Date.now() - t1) / 1000;
        const eta = done ? (el / done) * (total - done) : 0;
        process.stdout.write(`\r  截图 ${done}/${total}  已用 ${el.toFixed(0)}s  预计还要 ${eta.toFixed(0)}s   `);
      }
    }
    process.stdout.write('\n');

    const ff = findFfmpeg();
    console.log('▸ ffmpeg :', ff);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const args = [
      '-y', '-framerate', String(FPS),
      '-i', path.join(FRAMES_DIR, 'f%05d.png'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      OUT,
    ];
    const enc = spawnSync(ff, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    if (enc.status !== 0) throw new Error('ffmpeg 合成失败，退出码 ' + enc.status);

    if (!KEEP) fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
    const size = fs.statSync(OUT).size;
    console.log(`\n✅ 成片: ${OUT}  (${(size / 1048576).toFixed(1)} MB)`);
    ok = true;
  }
} finally {
  if (cdp) cdp.close();
  try { child.kill(); } catch {}
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

process.exit(ok ? 0 : 1);
