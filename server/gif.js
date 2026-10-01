// ============================================================
//  GIF 处理（零依赖，纯 JS）—— 2026-10-01
//
//  🔴 为什么要写这个：**视觉 API 只取动图的第一帧。**
//
//     实测（我手工造了一张"第 1 帧纯红、第 2 帧纯蓝"的 GIF）：
//       发给模型「单帧纯红」   → 「① 红色 ② 静态图」
//       发给模型「两帧红→蓝」 → 「① 红色 ② 静态图」   ← 和单帧**一模一样**
//     也就是说整张 GIF 传过去，模型只看到第一帧。
//
//     而 QQ 群里 GIF（动图表情包）占比很高 —— 实测 6193 条图片附件里
//     **1633 条疑似 GIF（约 26%）**，其中一张 256×256 的动图有 **77 帧**。
//     只认第一帧，等于**四分之一的表情包都看不懂**。
//
//  ✅ 而且这个修复是**免费**的：`detail: 'low'` 的图片 token 是**固定的**
//     （实测 210 token，与图片大小/内容无关）。所以把 N 帧拼成**一张**网格图，
//     花掉的 token 和原来发一张完全一样，但模型能看到动作。
//
//  ⚠️ 纯手写、没有任何依赖（项目铁律）：GIF 的 LZW 解压 + PNG 的 zlib 压缩
//     都是自己实现的（zlib 用 Node 内置的 `node:zlib`）。
// ============================================================

const zlib = require('node:zlib');

// ---------- 1. 只走块结构，不解压：拿尺寸/帧数/时长 ----------
//
// 这个很便宜（不解 LZW），用来**判断要不要做网格图**，
// 也能进日志（"动图 77 帧"比"image/gif"有用得多）。
function info(buf) {
  if (buf.length < 13 || buf.slice(0, 3).toString('latin1') !== 'GIF') return null;
  const w = buf.readUInt16LE(6);
  const h = buf.readUInt16LE(8);
  const packed = buf[10];
  let p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));

  let frames = 0;
  let delayMs = 0;
  let loops = null;

  const skipSubBlocks = () => {
    while (p < buf.length) {
      const n = buf[p++];
      if (!n) break;
      p += n;
    }
  };

  while (p < buf.length) {
    const b = buf[p];
    if (b === 0x3B) break;                                  // Trailer
    if (b === 0x21) {                                       // Extension
      const label = buf[p + 1];
      p += 2;
      if (label === 0xF9 && p + 5 <= buf.length) {          // Graphic Control
        delayMs += buf.readUInt16LE(p + 2) * 10;
        p += 6;                                             // size(1)+4+terminator(1)
      } else if (label === 0xFF && p + 1 <= buf.length) {   // Application
        const size = buf[p];
        const app = buf.slice(p + 1, p + 1 + size).toString('latin1');
        p += 1 + size;
        if (/NETSCAPE/i.test(app)) {
          const n = buf[p++];
          if (n >= 3) loops = buf.readUInt16LE(p + 1);
          p += n;
          p += 1;                                           // terminator
        } else skipSubBlocks();
      } else {
        p += 1;
        skipSubBlocks();
      }
      continue;
    }
    if (b === 0x2C) {                                       // Image Descriptor
      if (p + 10 > buf.length) break;
      frames++;
      const ipacked = buf[p + 9];
      p += 10;
      if (ipacked & 0x80) p += 3 * (1 << ((ipacked & 7) + 1));
      p += 1;                                               // LZW min code size
      skipSubBlocks();
      continue;
    }
    break;                                                  // 认不出的字节，停
  }
  return { w, h, frames, delayMs, loops, animated: frames > 1 };
}

// ---------- 2. GIF 版 LZW 解压 ----------
//
// ⚠️ 三个容易写错的点：
//   ① 码长在"字典长度达到 2^n"时**加一**，上限 12 —— 早了/晚了都会错位
//   ② 有个特殊情况：码 == 字典长度时表示"上一个串 + 上一个串的首字符"
//   ③ 数据可能比声明的像素多（某些编码器会补），要按 pixelCount 截断
function lzwDecode(data, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = new Uint8Array(pixelCount);
  let oi = 0;
  let dict = [];
  let codeSize = minCodeSize + 1;

  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict.push([i]);
    dict.push(null, null);            // clear / eoi 占位
    codeSize = minCodeSize + 1;
  };
  reset();

  let prev = null;
  const totalBits = data.length * 8;
  let bitPos = 0;

  while (bitPos + codeSize <= totalBits) {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const bit = (data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1;
      code |= bit << i;
    }
    bitPos += codeSize;

    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;

    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat(prev[0]);   // 特例 ②
    else break;

    for (let i = 0; i < entry.length && oi < pixelCount; i++) out[oi++] = entry[i];

    if (prev) {
      dict.push(prev.concat(entry[0]));
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
    if (oi >= pixelCount) break;                    // 特例 ③
  }
  return out;
}

// ---------- 3. 逐帧解码 + 按 disposal 合成 ----------
//
// 返回**请求的那几帧**的完整画布（RGBA，已经合成好）。
// ⚠️ 必须从第 0 帧一路合成到最大那一帧 —— GIF 帧之间常常只存"变化的部分"，
//    单独解一帧会得到一张残缺的图。
function renderFrames(buf, wantIndices, opts = {}) {
  const g = info(buf);
  if (!g) return null;
  const maxPixels = opts.maxPixels || 4096 * 4096;
  if (g.w * g.h > maxPixels) return null;

  const { w: W, h: H } = g;
  const want = new Set(wantIndices.filter((i) => i >= 0 && i < g.frames));
  const maxWant = want.size ? Math.max(...want) : -1;
  if (maxWant < 0) return null;

  let canvas = new Uint8Array(W * H * 4);          // 全透明起手
  let snapshot = null;                             // disposal=3 用
  const out = [];

  let p = 13;
  const packed = buf[10];
  let gct = null;
  if (packed & 0x80) {
    const n = 1 << ((packed & 7) + 1);
    gct = buf.slice(p, p + n * 3);
    p += n * 3;
  }

  const readSubBlocks = () => {
    const parts = [];
    while (p < buf.length) {
      const n = buf[p++];
      if (!n) break;                              // ⚠️ 0 是终止符，且 p 已经越过它
      parts.push(buf.slice(p, p + n));
      p += n;
    }
    return Buffer.concat(parts);
  };

  let gce = { disposal: 0, delay: 0, transparent: -1 };
  let index = -1;

  while (p < buf.length && index < maxWant) {
    const b = buf[p];
    if (b === 0x3B) break;

    if (b === 0x21) {
      const label = buf[p + 1];
      p += 2;
      if (label === 0xF9) {
        const gp = buf[p + 1];                    // packed（p 指向 size 字节）
        const tIdx = buf[p + 4];
        gce = {
          disposal: (gp >> 2) & 7,
          delay: buf.readUInt16LE(p + 2) * 10,
          transparent: (gp & 0x01) ? tIdx : -1,
        };
        p += 6;
      } else if (label === 0xFF) {
        const size = buf[p];
        p += 1 + size;                            // 跳过"块大小 + 应用名"
        readSubBlocks();                          // ⚠️ 它已经把终止符一起吃掉了
      } else {
        readSubBlocks();                          // 通用扩展：本身就是一组子块
      }
      continue;
    }

    if (b === 0x2C) {
      const left = buf.readUInt16LE(p + 1);
      const top = buf.readUInt16LE(p + 3);
      const fw = buf.readUInt16LE(p + 5);
      const fh = buf.readUInt16LE(p + 7);
      const ipacked = buf[p + 9];
      p += 10;

      let ct = gct;
      if (ipacked & 0x80) {
        const n = 1 << ((ipacked & 7) + 1);
        ct = buf.slice(p, p + n * 3);
        p += n * 3;
      }
      const interlaced = !!(ipacked & 0x40);
      const minCodeSize = buf[p++];
      const data = readSubBlocks();               // ⚠️ 同上：终止符已被吃掉，别再 +1

      index++;

      // 💡 先处理"上一帧的 disposal"，再画当前帧
      if (index > 0) {
        const prev = out.__prevFrame;
        if (prev) {
          if (prev.disposal === 2) clearRect(canvas, W, H, prev.left, prev.top, prev.w, prev.h);
          else if (prev.disposal === 3 && snapshot) canvas = Uint8Array.from(snapshot);
        }
      }
      if (gce.disposal === 3) snapshot = Uint8Array.from(canvas);

      const need = want.has(index);
      if (need || index < maxWant) {
        const idx = lzwDecode(data, minCodeSize, fw * fh);
        drawFrame(canvas, W, H, left, top, fw, fh, idx, ct, gce.transparent, interlaced);
        out.__prevFrame = { disposal: gce.disposal, left, top, w: fw, h: fh };
      }
      if (need) out.push({ index, w: W, h: H, rgba: Uint8Array.from(canvas), delay: gce.delay });
      continue;
    }
    break;
  }

  // out 上挂了个内部字段会干扰调用方，清掉
  const clean = out.slice();
  return { info: g, frames: clean };
}

function clearRect(canvas, W, H, left, top, w, h) {
  for (let y = top; y < Math.min(top + h, H); y++) {
    const row = y * W * 4;
    for (let x = left; x < Math.min(left + w, W); x++) {
      const o = row + x * 4;
      canvas[o] = canvas[o + 1] = canvas[o + 2] = canvas[o + 3] = 0;
    }
  }
}

// 把一帧的调色板索引画到画布上（处理透明色 + 交错）
function drawFrame(canvas, W, H, left, top, fw, fh, idx, ct, transparent, interlaced) {
  // 交错：行序是 0,8,16… 然后 4,12,20… 然后 2,6,10… 然后 1,3,5…
  let srcRowOf = null;
  if (interlaced) {
    srcRowOf = new Int32Array(fh);
    let k = 0;
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
      for (let y = start; y < fh; y += step) srcRowOf[k++] = y;
    }
  }
  for (let ry = 0; ry < fh; ry++) {
    const y = top + ry;
    if (y >= H) continue;
    const srcRow = srcRowOf ? srcRowOf[ry] : ry;
    if (srcRow >= fh) continue;
    for (let rx = 0; rx < fw; rx++) {
      const x = left + rx;
      if (x >= W) continue;
      const ci = idx[srcRow * fw + rx];
      if (transparent >= 0 && ci === transparent) continue;
      if (!ct || ci * 3 + 2 >= ct.length) continue;
      const o = (y * W + x) * 4;
      canvas[o] = ct[ci * 3];
      canvas[o + 1] = ct[ci * 3 + 1];
      canvas[o + 2] = ct[ci * 3 + 2];
      canvas[o + 3] = 255;
    }
  }
}

// ---------- 4. PNG 编码（zlib + CRC32，全部自己来）----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function pngEncode(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: RGBA
  // 10/11/12 = compression/filter/interlace = 0

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                                  // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 5. 采样 + 拼网格 ----------
//
// 默认 4 帧拼成 2×2。
// ⚠️ 尺寸是**算着 512 来的**：`detail: 'low'` 会把图缩到 **512×512** 再算 token，
//    超过 512 会多花一个 tile 的钱。实测 514×514 花了 221 token，
//    正好 512×512 只要 197 —— 和"只发一帧"**完全一样**。
//    所以 2 列时：255*2 + 2(缝) = 512 ✅
const CELL = 255;
const GAP = 2;          // 单元格之间的缝（帮模型分清"这是几帧"）

function sampleIndices(frames, n) {
  if (frames <= n) return Array.from({ length: frames }, (_, i) => i);
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round((i * (frames - 1)) / (n - 1)));
  return [...new Set(out)];
}

// 面积平均缩放 + source-over 合成到目标网格
function blitScaled(dst, dstW, dstH, cellX, cellY, cellW, cellH, src, srcW, srcH) {
  const scale = Math.min(cellW / srcW, cellH / srcH);
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));
  const offX = cellX + Math.floor((cellW - dw) / 2);
  const offY = cellY + Math.floor((cellH - dh) / 2);

  for (let y = 0; y < dh; y++) {
    const y0 = (y * srcH) / dh;
    const y1 = ((y + 1) * srcH) / dh;
    const iy0 = Math.floor(y0);
    const iy1 = Math.max(iy0 + 1, Math.min(srcH, Math.ceil(y1)));
    const ty = offY + y;
    if (ty < 0 || ty >= dstH) continue;
    for (let x = 0; x < dw; x++) {
      const x0 = (x * srcW) / dw;
      const x1 = ((x + 1) * srcW) / dw;
      const ix0 = Math.floor(x0);
      const ix1 = Math.max(ix0 + 1, Math.min(srcW, Math.ceil(x1)));
      const tx = offX + x;
      if (tx < 0 || tx >= dstW) continue;

      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = iy0; sy < iy1; sy++) {
        for (let sx = ix0; sx < ix1; sx++) {
          const so = (sy * srcW + sx) * 4;
          const sa = src[so + 3] / 255;
          r += src[so] * sa; g += src[so + 1] * sa; b += src[so + 2] * sa;
          a += sa; n++;
        }
      }
      if (!n) continue;
      // 预乘还原：按 alpha 加权平均
      const avgA = a / n;
      if (avgA <= 0) continue;
      const o = (ty * dstW + tx) * 4;
      const sr = r / a; const sg = g / a; const sb = b / a;
      // source-over 到已有背景
      const da = dst[o + 3] / 255;
      const oa = avgA + da * (1 - avgA);
      dst[o] = Math.round((sr * avgA + dst[o] * da * (1 - avgA)) / oa);
      dst[o + 1] = Math.round((sg * avgA + dst[o + 1] * da * (1 - avgA)) / oa);
      dst[o + 2] = Math.round((sb * avgA + dst[o + 2] * da * (1 - avgA)) / oa);
      dst[o + 3] = Math.round(oa * 255);
    }
  }
}

/**
 * 把动图采样成一张网格 PNG。
 * @returns {{png:Buffer, frames:number[], info:object, w:number, h:number}|null}
 */
function montage(buf, opts = {}) {
  const g = info(buf);
  if (!g || !g.animated) return null;

  const maxFrames = Math.max(2, Math.min(9, opts.maxFrames || 4));
  const use = sampleIndices(g.frames, maxFrames);
  const r = renderFrames(buf, use, opts);
  if (!r || !r.frames.length) return null;

  const cols = use.length <= 1 ? 1 : (use.length <= 2 ? 2 : (use.length <= 4 ? 2 : 3));
  const rows = Math.ceil(use.length / cols);
  const W = cols * CELL + (cols - 1) * GAP;
  const H = rows * CELL + (rows - 1) * GAP;

  const dst = new Uint8Array(W * H * 4);
  // 底色：中性灰（比纯白/纯黑更不容易和表情包内容混起来）
  for (let i = 0; i < dst.length; i += 4) { dst[i] = 0x30; dst[i + 1] = 0x30; dst[i + 2] = 0x34; dst[i + 3] = 255; }

  r.frames.forEach((f, i) => {
    const cx = (i % cols) * (CELL + GAP);
    const cy = Math.floor(i / cols) * (CELL + GAP);
    blitScaled(dst, W, H, cx, cy, CELL, CELL, f.rgba, f.w, f.h);
  });

  return { png: pngEncode(W, H, dst), frames: use, info: g, w: W, h: H };
}

module.exports = { info, lzwDecode, renderFrames, pngEncode, montage, sampleIndices, CELL, GAP };
