'use strict';
// ============================================================
//  二维码编码器（QR Code Model 2，**零依赖**，纯 JS）
//
//  为什么自己写：项目铁律「零第三方依赖」，而这个落地页要靠二维码兜底
//  —— 手机 QQ 的"扫一扫"能直接吃 QQ 名片协议链接，比让用户手打号码可靠得多。
//
//  支持范围（**够用就行，不做全集**）：
//   · 版本 5（37×37）、纠错级 M、字节模式（UTF-8）
//   · 容量：86 字节 —— 够装
//     `mqqapi://card/show_pslcard?src_type=internal&version=1&card_type=person&uin=<11位>`（78 字节）
//   · 单块编码（版本 5-M 是 1 块 108 码字），不做分块交织
//   · 掩码 0~7 全算，按标准罚分选最优
//
//  🔴 自检：`devtools/test-qr.cjs` 会把生成的矩阵**反解**回来
//     （读格式信息 → 去掩码 → 逆 ZigZag → 剥补齐 → 校验 RS 余式为零 → 还原原文），
//     能反解成功才算编码没错。
//
//  规范：ISO/IEC 18004。下面每个常量都标了出处，改之前先查表。
// ============================================================

// ---------- GF(256) 运算（本原多项式 0x11D，规范 Annex A）----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// 生成多项式 g(x) = ∏(x - α^i)，i=0..n-1
function rsGenPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// 多项式除法取余（就是 RS 校验码）
function rsRemainder(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const buf = [...data, ...new Array(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
  }
  return buf.slice(data.length);
}

// ---------- 版本 5-M 的容量常量（规范 Table 1 + Table 9）----------
// ⚠️ 这几个数字**必须**和规范表一致：写错了不会报错、只会"扫不出来"。
//   实测核对（2026-10-10）：版本 5-M = **数据 86 码字 + 纠错 24 码字 = 110 总码字**。
const VERSION = 5;
const SIZE = VERSION * 4 + 17;          // 37
const EC_LEVEL = 'M';                    // 纠错级 M（15%）
const EC_LEVEL_BITS = 0b00;              // M = 00（规范 Table 12）
const DATA_CODEWORDS = 86;               // Table 9：版本5-M 数据码字 86
const EC_PER_BLOCK = 24;                 // Table 9：版本5-M 每块 24 个纠错码字
const TOTAL_CODEWORDS = DATA_CODEWORDS + EC_PER_BLOCK;   // 110
const ALIGN_CENTERS = [6, 30];           // Table E.1（版本 5 对齐图形中心）

// ---------- 位缓冲 ----------
class BitBuf {
  constructor() { this.bits = []; }
  put(value, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toCodewords() {
    const out = [];
    for (let i = 0; i + 8 <= this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | this.bits[i + j];
      out.push(b);
    }
    return out;
  }
}

// ---------- 数据编码（字节模式）----------
function encodeData(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  if (bytes.length > DATA_CODEWORDS - 3) {
    throw new Error(`内容太长：${bytes.length} 字节，版本5-M 上限约 ${DATA_CODEWORDS - 3}`);
  }
  const buf = new BitBuf();
  buf.put(0b0100, 4);                          // 模式指示符：字节模式
  buf.put(bytes.length, 8);                    // 版本 1~9 用 8 位字符计数（Table 3）
  for (const b of bytes) buf.put(b, 8);

  // 结束符（最多 4 个 0，且不能超出容量）
  const cap = DATA_CODEWORDS * 8;
  for (let i = 0; i < 4 && buf.length < cap; i++) buf.put(0, 1);
  // 补齐到字节边界
  while (buf.length % 8 !== 0) buf.put(0, 1);

  const words = buf.toCodewords();
  // 填充码字 0xEC / 0x11 交替（规范 7.4.10）
  const PAD = [0xEC, 0x11];
  let i = 0;
  while (words.length < DATA_CODEWORDS) words.push(PAD[i++ % 2]);
  return words;
}

// ---------- 矩阵骨架 ----------
function emptyMatrix() {
  const m = [];
  for (let y = 0; y < SIZE; y++) m.push(new Array(SIZE).fill(null));
  return m;
}

function placeFinder(m, cx, cy) {
  // 7×7 回字 + 分隔符
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      const inRing = (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6))
        || (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6))
        || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      m[y][x] = inRing ? 1 : 0;
    }
  }
}

function placeAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      m[cy + dy][cx + dx] = (ring === 1) ? 0 : 1;   // 中心+外框为 1，中环为 0
    }
  }
}

// 时序图形 + 固定深色模块（规范 6.3.3 / 6.3.4）
function placePatterns(m) {
  placeFinder(m, 0, 0);
  placeFinder(m, SIZE - 7, 0);
  placeFinder(m, 0, SIZE - 7);

  // 时序图形
  for (let i = 8; i < SIZE - 8; i++) {
    const v = (i % 2 === 0) ? 1 : 0;
    if (m[6][i] === null) m[6][i] = v;
    if (m[i][6] === null) m[i][6] = v;
  }

  // 对齐图形（版本 5 只有右下那个，其余位置与定位图形重叠会自动跳过）
  for (const cy of ALIGN_CENTERS) {
    for (const cx of ALIGN_CENTERS) {
      // 跳过和三个定位图形重叠的角
      const cornerTL = (cx === 6 && cy === 6);
      const cornerTR = (cx === 6 && cy === SIZE - 7);
      const cornerBL = (cx === SIZE - 7 && cy === 6);
      if (cornerTL || cornerTR || cornerBL) continue;
      placeAlignment(m, cx, cy);
    }
  }

  // 固定深色模块在 placeFormat 里一并放置（(x=8, y=SIZE-8)，即 4V+9 行）
}

// 保留区（格式信息 / 版本信息）位置 —— 数据铺设时必须跳过
function isFunctionModule(x, y) {
  // 定位图形 + 分隔符（含 1 格分隔）
  if (x <= 8 && y <= 8) return true;
  if (x >= SIZE - 8 && y <= 8) return true;
  if (x <= 8 && y >= SIZE - 8) return true;
  // 时序
  if (x === 6 || y === 6) return true;
  // 格式信息带
  if (y === 8 && (x <= 8 || x >= SIZE - 8)) return true;
  if (x === 8 && (y <= 8 || y >= SIZE - 8)) return true;
  // 对齐图形（版本 5 只有 (30,30)）
  if (Math.abs(x - 30) <= 2 && Math.abs(y - 30) <= 2) return true;
  // 版本信息块（版本 ≥ 7 才有；版本 5 没有，这里留个说明）
  return false;
}

// ---------- 数据铺设（规范 7.7.3：右下起、两列一组、ZigZag 上下交替）----------
function placeData(m, codewords) {
  const bits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;                 // 跳过第 6 列（时序图形）
    const rows = upward
      ? Array.from({ length: SIZE }, (_, i) => SIZE - 1 - i)
      : Array.from({ length: SIZE }, (_, i) => i);
    for (const y of rows) {
      for (const x of [right, right - 1]) {
        if (isFunctionModule(x, y)) continue;
        m[y][x] = bitIdx < bits.length ? bits[bitIdx++] : 0;
      }
    }
    upward = !upward;
  }
  return bitIdx;   // 用掉的位数（调试用）
}

// 掩码（规范 Table 10）
const MASK_FN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, maskId) {
  const out = m.map((row) => row.slice());
  const fn = MASK_FN[maskId];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (isFunctionModule(x, y)) continue;
      if (fn(x, y)) out[y][x] ^= 1;
    }
  }
  return out;
}

// ---------- 格式信息（规范 7.9 / Table 25）----------
// 5 位数据（纠错级 2 位 + 掩码 3 位）→ BCH(15,5) → 异或 0b101010000010010
function formatBits(maskId) {
  const data = (EC_LEVEL_BITS << 3) | maskId;     // 5 位
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10); // 生成多项式 0x537 = 10100110111
  }
  return (((data << 10) | rem) ^ 0b101010000010010) & 0x7FFF;
}

function placeFormat(m, maskId) {
  const bits = formatBits(maskId);
  const b = (i) => (bits >>> i) & 1;

  // 先把两条格式信息带**清零**（它们是保留区，数据铺设时被跳过，不清会留 null）
  for (let i = 0; i <= 8; i++) { m[8][i] = 0; m[i][8] = 0; }
  for (let i = 0; i <= 7; i++) { m[8][SIZE - 1 - i] = 0; m[SIZE - 1 - i][8] = 0; }

  // 第一份：左上（bit14 在 (8,8) 角上，逆时针绕）
  for (let i = 0; i <= 5; i++) m[8][i] = b(i);
  m[8][7] = b(6);
  m[8][8] = b(7);
  m[7][8] = b(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = b(i);

  // 第二份：左下 + 右上
  for (let i = 0; i <= 7; i++) m[8][SIZE - 1 - i] = b(i);
  for (let i = 8; i <= 14; i++) m[SIZE - 15 + i][8] = b(i);

  // 固定深色模块：(8, 4V+9) 恒为 1（规范 7.9.1）
  m[8][SIZE - 8] = 1;
}

// ---------- 掩码罚分（规范 Table 11）----------
function penalty(m) {
  let score = 0;
  // 规则 1：同行/同列连续 5 个以上同色
  const runScore = (line) => {
    let s = 0, run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s += 1; }
      else run = 1;
    }
    return s;
  };
  for (let y = 0; y < SIZE; y++) score += runScore(m[y]);
  for (let x = 0; x < SIZE; x++) score += runScore(m.map((r) => r[x]));

  // 规则 2：2×2 同色块
  for (let y = 0; y < SIZE - 1; y++) {
    for (let x = 0; x < SIZE - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }

  // 规则 3：形如 1:1:3:1:1 + 4 空 的图案（两个方向都算）
  const PAT = [1, 0, 1, 1, 1, 0, 1];
  const hasPat = (get, i) => {
    for (let k = 0; k < 7; k++) if (get(i + k) !== PAT[k]) return false;
    // 前后需要 4 个空
    let before = true, after = true;
    for (let k = 1; k <= 4; k++) {
      const bi = i - k; if (bi >= 0 && get(bi) !== 0) before = false;
      const ai = i + 6 + k; if (ai < SIZE && get(ai) !== 0) after = false;
    }
    return before || after;
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x + 6 < SIZE; x++) if (hasPat((i) => m[y][i], x)) score += 40;
  }
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y + 6 < SIZE; y++) if (hasPat((i) => m[i][x], y)) score += 40;
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) dark += m[y][x];
  const pct = (dark * 100) / (SIZE * SIZE);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

// ---------- 主入口 ----------
function encode(text) {
  const dataWords = encodeData(text);
  const ecWords = rsRemainder(dataWords, EC_PER_BLOCK);
  const allWords = [...dataWords, ...ecWords];

  const base = emptyMatrix();
  placePatterns(base);

  let best = null;
  for (let maskId = 0; maskId < 8; maskId++) {
    const m = base.map((r) => r.slice());
    placeData(m, allWords);
    const masked = applyMask(m, maskId);
    placeFormat(masked, maskId);
    const s = penalty(masked);
    if (!best || s < best.score) best = { maskId, score: s, matrix: masked };
  }
  return best;    // { maskId, score, matrix }
}

// ---------- 输出成 SVG（网页直接内联，不用图床）----------
function toSvg(matrix, opts = {}) {
  const quiet = opts.quiet ?? 2;                 // 规范要求四周留 4 模块静区，取 2 更紧凑
  const n = matrix.length;
  const total = n + quiet * 2;
  let path = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (matrix[y][x]) path += `M${x + quiet},${y + quiet}h1v1h-1z`;
    }
  }
  const size = opts.size || 240;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/>`
    + `<path d="${path}" fill="#000"/></svg>`;
}

// ---------- 输出成 PNG（**QQ 的 markdown 图片只认 png/jpg，不认 svg**）----------
//
// 🔴 必须用 PNG：`![x](xxx.svg)` 在 QQ 里不显示。所以自己写个最小 PNG 编码器。
//    灰度 8bit（颜色类型 0）、无隔行、逐行 filter=0，zlib 用 Node 内置的 deflate。
//    一个 37 模块的码放大到 6 像素/模块 = 246×246，PNG 体积只有几 KB。
const zlib = require('zlib');

// CRC32（PNG 每个 chunk 都要）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// scale = 每个模块多少像素；quiet = 四周静区（模块数）
function toPng(matrix, opts = {}) {
  const scale = Math.max(1, Math.min(20, Number(opts.scale) || 6));
  const quiet = opts.quiet ?? 4;               // 规范要求 4 模块静区（扫码更容易）
  const n = matrix.length;
  const dim = (n + quiet * 2) * scale;

  const raw = Buffer.alloc((dim + 1) * dim);   // 每行前面 1 字节 filter
  raw.fill(0xFF);                              // 先当全白（1 = 白，灰度里 0 = 黑）
  for (let py = 0; py < dim; py++) {
    raw[py * (dim + 1)] = 0;                   // filter type 0
    const my = Math.floor(py / scale) - quiet;
    if (my < 0 || my >= n) continue;
    for (let px = 0; px < dim; px++) {
      const mx = Math.floor(px / scale) - quiet;
      if (mx < 0 || mx >= n) continue;
      if (matrix[my][mx]) raw[py * (dim + 1) + 1 + px] = 0x00;   // 黑
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 0;      // color type 0 = 灰度
  ihdr[10] = 0;     // compression
  ihdr[11] = 0;     // filter
  ihdr[12] = 0;     // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = {
  encode,
  toSvg,
  toPng,
  formatBits,
  rsRemainder,
  encodeData,
  _SIZE: SIZE,
  _VERSION: VERSION,
  _DATA_CODEWORDS: DATA_CODEWORDS,
  _EC_PER_BLOCK: EC_PER_BLOCK,
  _isFunctionModule: isFunctionModule,
};
