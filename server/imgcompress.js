// ============================================================
//  imgcompress.js —— 发图前把**大图压小**（2026-10-16 用户要求）
//
//  📝 用户原话：「从图库提取出来的图发到群里都好大，占空间，能不能压缩」
//
//  ── 为什么只压 PNG（先量过再定的）──
//  实测（`_ops/lib-size-audit.sh`，49 条 16.38MB）：
//    · PNG  **9 张共 8.09MB**（平均 0.90MB）—— 全部大头都在这里（最大那张 1.41MB）
//    · JPEG 37 张共 8.08MB（平均 0.22MB）—— **已经是压缩格式**，再压要先解码再编码
//    · WEBP  3 张共 0.20MB
//  ⇒ PNG 是**无损**格式，照片类内容在它里面体积虚高得离谱；把长边降到 `maxEdge`（默认 1024）
//    再按 PNG 重编码，实测能砍掉一大半，而且**不用解码 JPEG**（那要写一个 JPEG 解码器，
//    为了 8MB 里已经压过的那一半不值得）。
//
//  ── 三条硬约束 ──
//   ① **零第三方依赖**：只用 node 内置 `zlib` 自己解析/重编码 PNG（项目铁律）。
//   ② **绝不改动原文件**：只压"即将发出去的那份字节"，磁盘上的素材一个字节都不动
//      （红线：验证/清理脚本不许碰用户数据）。
//   ③ **压不小就别压**：重编码后不比原来小 `minGain`（默认 20%）就**原样返回**
//      （宁可发大图，也别白白掉画质）。
//
//  ── 支持到什么程度（够用为止）──
//   ✅ 8 位、非交错的 **color type 2(RGB) / 6(RGBA)**（群里 99% 的图都是这两种）
//   ⏭️ 调色板(3) / 灰度(0) / 灰度+alpha(4) / 16 位 / 交错 —— **一律原样返回**（不冒险）
//   ⏭️ GIF / WebP / JPEG —— 原样返回（GIF 动了就成静帧了，绝不能碰）
// ============================================================
const zlib = require('node:zlib');

// ---------- 只读 PNG 头 ----------
function pngInfo(buf) {
  if (!buf || buf.length < 33) return null;
  if (buf[0] !== 0x89 || buf.slice(1, 4).toString('ascii') !== 'PNG') return null;
  if (buf.readUInt32BE(8) !== 13 || buf.slice(12, 16).toString('ascii') !== 'IHDR') return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return { w, h, depth: buf[24], ctype: buf[25], interlace: buf[28] };
}

// ---------- 分块 ----------
function chunks(buf) {
  const out = [];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8).toString('ascii');
    const body = buf.slice(i + 8, i + 8 + len);
    out.push({ type, body });
    i += 12 + len;
  }
  return out;
}

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
  return Buffer.concat([len, t, body, crc]);
}

// ---------- 解滤波（PNG 的 5 种行滤波）----------
// ⚠️ 必须**按行原地还原**：Up/Average/Paeth 依赖上一行，Sub 依赖同一行左边
function unfilter(raw, w, h, bpp) {
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;             // 左
      const b = prev[x];                                  // 上
      const c = x >= bpp ? prev[x - bpp] : 0;             // 左上
      let v = src[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {                                // Paeth
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) {
        throw new Error(`不认识的滤波类型 ${ft}`);
      }
      cur[x] = v & 0xFF;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return out;
}

// ---------- 盒式降采样（对照片够用；不变形、不掉结构）----------
function downscale(pixels, w, h, bpp, dw, dh) {
  const out = Buffer.alloc(dw * dh * bpp);
  const xr = w / dw, yr = h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yr), y1 = Math.max(y0 + 1, Math.floor((y + 1) * yr));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xr), x1 = Math.max(x0 + 1, Math.floor((x + 1) * xr));
      const acc = new Array(bpp).fill(0);
      let n = 0;
      for (let sy = y0; sy < y1 && sy < h; sy++) {
        for (let sx = x0; sx < x1 && sx < w; sx++) {
          const o = (sy * w + sx) * bpp;
          for (let c = 0; c < bpp; c++) acc[c] += pixels[o + c];
          n++;
        }
      }
      const o2 = (y * dw + x) * bpp;
      for (let c = 0; c < bpp; c++) out[o2 + c] = Math.round(acc[c] / Math.max(1, n));
    }
  }
  return out;
}

// ---------- 编码：全用 filter 0（Sub 更小但收益有限，先求稳）----------
function encodePng(pixels, w, h, ctype) {
  const bpp = ctype === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                            // filter: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = ctype;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 🆕 PNG-8：调色板量化（2026-10-16 加，**这条才是真省钱的那一半**）----------
//
// 🔴 为什么需要它（实测数据逼出来的）：真实图库里那些 PNG **长边大多没超 1024**
//    （648/960/867/648…），只是文件大（0.65~1.44MB）—— 那种图**降采样根本不生效**，
//    而单纯重编码 PNG 只能省 7~19%。真正的办法是**把它变成调色板图**：
//    项目自己就吃过这个甜头 —— 一张 3.8MB 的长图 → **PNG-8 1.12MB**，
//    而且"中文小字一点没糊，只有彩色小 logo 略抖动"。
//
// 做法：中位切分（median cut）到 ≤256 色 → 写 **color type 3 + PLTE (+tRNS)**。
// ⚠️ 只对"本来像插画/表情包"的图收益最大；照片类会有点带状 —— 所以**仍然守住 minGain**：
//    省不到就原样发（宁可大，也别为一点点收益换来可见的色带）。
function quantize(px, w, h, bpp, maxColors) {
  const n = w * h;
  const hist = new Map();
  const key = (r, g, b, a) => (r << 24) | (g << 16) | (b << 8) | a;
  for (let i = 0; i < n; i++) {
    const o = i * bpp;
    const k = key(px[o], px[o + 1], px[o + 2], bpp === 4 ? px[o + 3] : 255);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let cols = [...hist.entries()].map(([k, c]) => ({
    r: (k >>> 24) & 0xFF, g: (k >>> 16) & 0xFF, b: (k >>> 8) & 0xFF, a: k & 0xFF, c,
  }));
  cols.sort((x, y) => y.c - x.c);
  // 🔴 本来就没超上限（这张图的颜色本来就不足 maxColors 种）⇒ **照样要出调色板版**。
  //    第一版这里直接 `return { palette: null }`，结果"颜色少但文件大"的图一分钱没省
  //    （实测 `gmv6j8s5a46d` 1.24MB → 0%，就是这个 bug）。用现有颜色当调色板即可。
  if (cols.length <= maxColors) return { colors: cols };

  // ⚠️⚠️ 别用 `Math.max(...arr)` / `Math.min(...arr)`：**参数表有上限**，
  //    一张插图能有 **12 万种颜色** ⇒ 直接 `Maximum call stack size exceeded`，
  //    而它被外层的 try/catch 吞掉、表现为"压了也只省 0%"（两张图就是这么"省不动"的）。
  //    一律改成显式循环。
  const span = (bx, ch) => {
    let mn = 255, mx = 0;
    for (const p of bx) { const v = p[ch]; if (v < mn) mn = v; if (v > mx) mx = v; }
    return mx - mn;
  };
  const boxPixels = (bx) => { let s = 0; for (const p of bx) s += p.c; return s; };

  // 中位切分：每次挑"色域跨度大的桶"切成两半，直到桶数够
  let boxes = [cols];
  while (boxes.length < maxColors) {
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.length < 2) continue;
      const sp = Math.max(span(bx, 'r'), span(bx, 'g'), span(bx, 'b'));
      // 用"色域跨度 × 像素数"挑，避免把大票仓晾着
      const score = sp * Math.log2(2 + boxPixels(bx));
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0) break;
    const bx = boxes[bi];
    const dr = span(bx, 'r'), dg = span(bx, 'g'), db = span(bx, 'b');
    const ch = dr >= dg && dr >= db ? 'r' : (dg >= db ? 'g' : 'b');
    bx.sort((a, b) => a[ch] - b[ch]);
    const mid = Math.floor(bx.length / 2);
    boxes.splice(bi, 1, bx.slice(0, mid), bx.slice(mid));
  }
  // 每个桶取"加权平均色"当调色板项
  const pal = boxes.filter((b) => b.length).map((bx) => {
    let r = 0, g = 0, b = 0, a = 0, tot = 0;
    for (const p of bx) { r += p.r * p.c; g += p.g * p.c; b += p.b * p.c; a += p.a * p.c; tot += p.c; }
    return { r: Math.round(r / tot), g: Math.round(g / tot), b: Math.round(b / tot), a: Math.round(a / tot), c: tot };
  });
  return { colors: pal, palette: boxes };
}

// 把像素映射到调色板（用 16 位量化表做近似最近邻：够准、且 O(1) 查表）
function mapToPalette(px, w, h, bpp, pal) {
  const n = w * h;
  const idx = Buffer.alloc(n);
  const cache = new Map();
  // 建一张 32³ 的近似查找表（每轴 5 位）
  const LUT = new Int16Array(32768).fill(-1);
  const near = (r, g, b, a) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const p = pal[i];
      const dr = r - p.r, dg = g - p.g, db = b - p.b, da = a - p.a;
      const d = dr * dr + dg * dg + db * db + (da * da >> 1);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    const o = i * bpp;
    const r = px[o], g = px[o + 1], b = px[o + 2], a = bpp === 4 ? px[o + 3] : 255;
    const lutKey = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let k = LUT[lutKey];
    if (k < 0) {
      if (a < 250) {
        // 带透明度的像素别走 LUT（透明度对观感影响大，单独精确匹配）
        k = near(r, g, b, a);
      } else {
        k = near(r, g, b, 255);
        LUT[lutKey] = k;
      }
    }
    idx[i] = k;
    const p = pal[k];
    const e = Math.abs(r - p.r) + Math.abs(g - p.g) + Math.abs(b - p.b) + Math.abs(a - p.a);
    if (e > maxErr) maxErr = e;
  }
  return { idx, maxErr };
}

function encodePalettePng(idx, w, h, pal) {
  const plte = Buffer.alloc(pal.length * 3);
  const trns = [];
  let hasAlpha = false;
  pal.forEach((p, i) => { plte[i * 3] = p.r; plte[i * 3 + 1] = p.g; plte[i * 3 + 2] = p.b; trns.push(p.a); if (p.a < 255) hasAlpha = true; });
  // 每行 filter byte = 0
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    idx.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 3;                     // 8 位索引色
  const parts = [
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
  ];
  if (hasAlpha) parts.push(chunk('tRNS', Buffer.from(trns)));
  parts.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------- 压缩结果缓存（按"图库 id + 原字节长度"缓存）----------
//
// 为什么要有：PNG-8 量化对 1MB 级的图是有 CPU 代价的（解滤波 + 中位切分 + 映射），
// 而同一张图会被**反复发**（它就是这个功能的意义）。缓存住"压好的那份字节"，
// 第二次发就是零成本。
// ⚠️ 有上限（别把内存吃满）：默认 40 条；每条就是压缩后的字节（几十~几百 KB）。
// ⚠️ 键里带 `buf.length`：图库文件被换过（同名不同内容）时自然失效，不需要额外逻辑。
const CACHE = new Map();
const CACHE_MAX = 40;

// 签名：`shrink(buf, opt, cacheKey)` —— **前两个参数保持原样**（调用方不用改），
// 第三个是可选缓存键（图库 id）。命中的是"上次压好的那份字节"，不重复算。
function shrink(buf, opt = {}, cacheKey = '') {
  const k = cacheKey ? `${cacheKey}|${buf ? buf.length : 0}` : '';
  if (k && CACHE.has(k)) return CACHE.get(k);
  const r = shrinkUncached(buf, opt);
  if (k && r && r.changed) {
    CACHE.set(k, r);
    if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  }
  return r;
}

// ---------- 对外：压一张图 ----------
//
// 返回 `{ buf, changed, why, from, to }`（**永远不抛**：出任何问题都原样返回）
//   · changed=false 时 `buf` 就是传进来的那份（调用方无需区分）
//   · `from`/`to` 是"降采样前后的长边"，方便日志
function shrinkUncached(buf, opt = {}) {
  const maxEdge = Number(opt.maxEdge) > 0 ? Number(opt.maxEdge) : 1024;
  const minBytes = Number(opt.minBytes) > 0 ? Number(opt.minBytes) : 300 * 1024;
  const minGain = Number(opt.minGain) > 0 ? Number(opt.minGain) : 0.2;
  const maxColors = Number(opt.maxColors) > 0 ? Number(opt.maxColors) : 256;
  const orig = buf;
  const done = (b, changed, why, from, to) => ({ buf: b, changed, why, from, to });
  try {
    if (!buf || !buf.length) return done(orig, false, '空字节');
    const info = pngInfo(buf);
    if (!info) return done(orig, false, '不是 PNG（JPEG/WebP/GIF 一律不动）');
    if (info.interlace !== 0) return done(orig, false, '交错 PNG，不碰');
    if (info.depth !== 8) return done(orig, false, `位深 ${info.depth}，不碰`);
    if (info.ctype !== 2 && info.ctype !== 6) return done(orig, false, `颜色类型 ${info.ctype}，不碰`);
    const longEdge = Math.max(info.w, info.h);
    if (buf.length < minBytes) return done(orig, false, `${(buf.length / 1024).toFixed(0)}KB 已经够小`);

    const bpp = info.ctype === 6 ? 4 : 3;
    const idat = Buffer.concat(chunks(buf).filter((c) => c.type === 'IDAT').map((c) => c.body));
    const raw = zlib.inflateSync(idat);
    const px = unfilter(raw, info.w, info.h, bpp);

    // ① 长边超了先降采样（这是"尺寸"那条路）
    let cur = px, cw = info.w, chh = info.h;
    let worked = false;
    if (longEdge > maxEdge) {
      const scale = maxEdge / longEdge;
      cw = Math.max(1, Math.round(info.w * scale));
      chh = Math.max(1, Math.round(info.h * scale));
      cur = downscale(px, info.w, info.h, bpp, cw, chh);
      worked = true;
    }
    const base = worked ? encodePng(cur, cw, chh, info.ctype) : buf;

    // ② 调色板量化（"体积"那条路 —— 尺寸没超的图，就靠这一步省）
    let best = base, bestWhy = worked
      ? `${info.w}x${info.h} → ${cw}x${chh}（只用降采样）`
      : '长边没超，不降采样';
    try {
      const q = quantize(cur, cw, chh, bpp, maxColors);
      // ⚠️ 别再判 `q.palette`（那个字段已经没有意义了）：只要"调色板版更小"就用它
      if (q && q.colors && q.colors.length) {
        const { idx } = mapToPalette(cur, cw, chh, bpp, q.colors);
        const pal = encodePalettePng(idx, cw, chh, q.colors);
        if (pal.length < best.length) {
          best = pal;
          bestWhy = `${info.w}x${info.h} → ${cw}x${chh} · PNG-8 ${q.colors.length} 色`
            + `${worked ? '（降采样 + 量化）' : '（只量化）'}`;
        }
      }
    } catch { /* 量化失败就用降采样那版 */ }

    const gain = 1 - best.length / buf.length;
    if (gain < minGain) {
      return done(orig, false,
        `压了也只省 ${(gain * 100).toFixed(0)}%（< ${(minGain * 100).toFixed(0)}%）`);
    }
    return done(best, true,
      `${bestWhy} · ${(buf.length / 1024).toFixed(0)}KB → ${(best.length / 1024).toFixed(0)}KB`
      + `（省 ${(gain * 100).toFixed(0)}%）`,
      longEdge, Math.max(cw, chh));
  } catch (e) {
    return done(orig, false, `解析/编码失败：${e.message}`);
  }
}

module.exports = { shrink, shrinkUncached, _cacheClear: () => CACHE.clear(), pngInfo, _unfilter: unfilter, _downscale: downscale, _encodePng: encodePng, _quantize: quantize, _mapToPalette: mapToPalette, _encodePalettePng: encodePalettePng };
