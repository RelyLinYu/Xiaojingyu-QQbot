// ============================================================
//  二维码编码器的**往返自检**（纯函数，本地跑）
//
//  跑法：node devtools/test-qr.cjs
//
//  它不是"跑一遍不报错"那种假测试 —— 会**把生成的矩阵反解回来**：
//    ① 从矩阵里读回格式信息，验证 = BCH(15,5) 算出来的值
//    ② 按格式信息里的掩码号**去掩码**
//    ③ 逆 ZigZag 取回码字 → 剥掉补齐 → 校验 **RS 余式全零**（数学上证明码字合法）
//    ④ 按字节模式解回原文，和输入**逐字节比对**
//  任一步不符即失败。
// ============================================================
const qr = require('../server/qr');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++; else fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !extra ? '' : `（${extra}）`}`);
}

const SIZE = qr._SIZE;

// ---------- 反解 ----------
function readFormatBits(m) {
  // 与 placeFormat 对称取回第一份（左上角那份）
  const b = [];
  for (let i = 0; i <= 5; i++) b[i] = m[8][i];
  b[6] = m[8][7];
  b[7] = m[8][8];
  b[8] = m[7][8];
  for (let i = 9; i <= 14; i++) b[i] = m[14 - i][8];
  let v = 0;
  for (let i = 14; i >= 0; i--) v = (v << 1) | (b[i] ? 1 : 0);   // b[0] 是最低位
  return v;
}

function unmask(m, maskId) {
  const fns = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const out = m.map((r) => r.slice());
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (qr._isFunctionModule(x, y)) continue;
      if (fns[maskId](x, y)) out[y][x] ^= 1;
    }
  }
  return out;
}

function readCodewords(m) {
  const bits = [];
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const rows = upward
      ? Array.from({ length: SIZE }, (_, i) => SIZE - 1 - i)
      : Array.from({ length: SIZE }, (_, i) => i);
    for (const y of rows) {
      for (const x of [right, right - 1]) {
        if (qr._isFunctionModule(x, y)) continue;
        bits.push(m[y][x]);
      }
    }
    upward = !upward;
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    words.push(b);
  }
  return words;
}

// RS 余式全零 = 这串码字是合法 RS 码字（数学证明，不是"看着像"）
function rsSyndromeZero(words, ecLen) {
  const gen = [];
  // 用 qr 模块内部的原理复算：把整串码字当多项式，除以生成多项式应整除
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
  let poly = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= mul(poly[j], EXP[i]); }
    poly = next;
  }
  const buf = words.slice();
  for (let i = 0; i < buf.length - ecLen; i++) {
    const coef = buf[i];
    if (!coef) continue;
    for (let j = 0; j < poly.length; j++) buf[i + j] ^= mul(poly[j], coef);
  }
  return buf.slice(buf.length - ecLen).every((v) => v === 0);
}

function decode(bytesWords) {
  // 字节模式：4 位模式 + 8 位长度 + 数据
  let bitPos = 0;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = bytesWords[Math.floor(bitPos / 8)];
      v = (v << 1) | ((byte >> (7 - (bitPos % 8))) & 1);
      bitPos++;
    }
    return v;
  };
  const mode = readBits(4);
  if (mode !== 0b0100) return { mode, text: null };
  const len = readBits(8);
  const out = [];
  for (let i = 0; i < len; i++) out.push(readBits(8));
  return { mode, len, text: Buffer.from(out).toString('utf8') };
}

// ---------- 1. 格式信息自检 ----------
console.log('\n=== 1. 格式信息（BCH 15,5）===');
// 官方 Table 25 里能背下来的一条：纠错级 M + 掩码 0 → 格式串 101010000010010
{
  // 直接算 BCH，再和矩阵里实际放的比对
  const f = qr.formatBits(0);
  ok('掩码0 的格式位能被算出', Number.isInteger(f));
  const enc = qr.encode('TEST');
  const back = readFormatBits(enc.matrix);
  const expect = qr.formatBits(enc.maskId);
  ok(`矩阵里读回的格式信息 == 计算值（maskId=${enc.maskId}）`, back === expect,
    `读回 ${back.toString(2).padStart(15, '0')} / 期望 ${expect.toString(2).padStart(15, '0')}`);
  // 低 3 位是掩码号，高 2 位是纠错级 —— 读回后应当能还原
  const maskIn = (back ^ 0b101010000010010) >>> 10 & 0b111;
  ok('从格式信息里能还原出掩码号', maskIn === enc.maskId, `${maskIn} vs ${enc.maskId}`);
}

// ---------- 2. 码字/RS 自检 ----------
console.log('\n=== 2. 码字与 RS 纠错 ===');
{
  const data = qr.encodeData('HELLO-QR');
  ok('数据码字长度 == 86', data.length === 86, `实际 ${data.length}`);
  const ec = qr.rsRemainder(data, 24);
  ok('纠错码字个数 == 24', ec.length === 24);
  ok('整串码字通过 RS 校验（余式全零）', rsSyndromeZero([...data, ...ec], 24));
}

// ---------- 3. 端到端往返 ----------
console.log('\n=== 3. 端到端往返（编码 → 矩阵 → 反解）===');
const CASES = [
  // 生产实际用的短链（不带 src_type/version —— 手机 QQ 只认 card_type + uin）
  'mqqapi://card/show_pslcard?card_type=person&uin=10001',
  'mqqapi://card/show_pslcard?card_type=person&uin=12345678901',
  'mqqapi://card/show_pslcard?card_type=group&uin=12345678901',
  // 长一点的官方写法（81 字节，仍在上限内）
  'mqqapi://card/show_pslcard?src_type=internal&version=1&card_type=person&uin=10001',
  '10001',
  '中文测试-号码 10001',
];
for (const text of CASES) {
  const enc = qr.encode(text);
  const fmt = readFormatBits(enc.matrix);
  const okFmt = fmt === qr.formatBits(enc.maskId);
  const words = readCodewords(unmask(enc.matrix, enc.maskId));
  const rsOk = rsSyndromeZero(words, 24);
  const dec = decode(words);
  const roundTrip = dec.text === text;
  const allOk = okFmt && rsOk && roundTrip;
  ok(`往返「${text.slice(0, 46)}${text.length > 46 ? '…' : ''}」（${Buffer.byteLength(text)} 字节）`,
    allOk, `格式=${okFmt} RS=${rsOk} 原文=${roundTrip}`);
}

// ---------- 4. 边界 ----------
console.log('\n=== 4. 边界与输出 ===');
{
  const enc = qr.encode('10001');
  ok('矩阵尺寸 == 37×37', enc.matrix.length === SIZE && enc.matrix[0].length === SIZE);
  ok('全是 0/1（没有残留 null）', enc.matrix.every((r) => r.every((v) => v === 0 || v === 1)));
  ok('三个定位图形在位', enc.matrix[0][0] === 1 && enc.matrix[0][SIZE - 1] === 1 && enc.matrix[SIZE - 1][0] === 1);
  ok('时序图形交替（行 6 与列 6）',
    (() => {
      const row = [9, 10, 11, 12, 13, 14].map((x) => enc.matrix[6][x]);
      const col = [9, 10, 11, 12, 13, 14].map((y) => enc.matrix[y][6]);
      const alt = (a) => a.every((v, i) => i === 0 || v !== a[i - 1]);
      const same = row.every((v, i) => v === col[i]);
      return alt(row) && alt(col) && same;
    })());
  ok('固定深色模块在位（x=8, y=SIZE-8）', enc.matrix[8][SIZE - 8] === 1);
  ok('两条格式信息带都无残留 null', enc.matrix.every((r) => r.every((v) => v === 0 || v === 1)));
  const svg = qr.toSvg(enc.matrix);
  ok('SVG 输出含 <svg 且无 null', svg.startsWith('<svg') && !/null|undefined/.test(svg));
  ok('SVG 里有实心模块', (svg.match(/h1v1h-1z/g) || []).length > 100);
  let threw = false;
  try { qr.encode('x'.repeat(200)); } catch { threw = true; }
  ok('超长内容会抛错（而不是静默生成坏码）', threw);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
process.exit(fail ? 1 : 0);
