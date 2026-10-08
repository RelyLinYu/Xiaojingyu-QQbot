#!/usr/bin/env node
// ============================================================
//  tools/ops/verify-deploy.cjs —— 部署后自检（**在服务器上跑**）
//
//  🔴 为什么非要有它（2026-10-08 用户原话：「sh 坏的不能重写一个吗，拷贝所有文件」）：
//    deploy.sh 原来用手写**白名单**列要拷哪些文件，漏一个就"全新部署照样启动即崩"：
//
//      踩过的坑：白名单只列了 6 个 → 漏掉 budget.js → brain.js 里 require('./budget')
//      → `Cannot find module './budget'`，机器人根本起不来。
//      后来补到 7 个，仍然漏着 vision / linkparse / power / memory / emotion / gif /
//      qqmedia / sendqueue / settings / examples / presets / usage 共 12 个模块。
//
//  ⇒ 结论：**"记得同步白名单"这条规矩是假的，没人能一直记得**。
//    所以改成：① 部署时**整目录拷**；② 拷完**自动把每个 require('./x') 解析一遍**，
//    少一个文件就红了 —— 白名单从"人肉维护"变成"机器对账"。
//
//  它做两件事：
//    ① 模块解析：扫每个 .js/.cjs 里**代码里**的 `require('./相对路径')`，确认目标文件存在
//    ② 语法体检：对每个文件跑一次 `node --check`（只报成败；原文请看本机 devtools/syntax-check.cjs）
//
//  用法：
//    node tools/ops/verify-deploy.cjs            # 默认查本文件的上一级（= 应用根目录）
//    node tools/ops/verify-deploy.cjs /opt/xxx   # 指定应用根目录
//  退出码：0 = 全部就位；1 = 有问题（部署脚本会因此中止）
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));

// 不扫的目录：运行时数据、依赖、版本库
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'devtools', 'private', '_preview']);

// 🔴 额外跳过"备份目录"—— 这条是拿**线上真实目录**跑出来的（2026-10-08）：
//    服务器上留着 `.backup-linkparse/`、`.backup-p2/`、`.backup-20260921-quiet/`
//    这些**老代码快照**（里面本来就是"拷了一半"的文件），
//    不跳过的话它们每个都会报 "require('./budget') 不存在" → 自检永久变红 →
//    **会把一次完全正常的部署拦下来**（"闸门太吵 = 等于没有闸门"）。
//    所以：**点开头的目录一律不看**，另外名字里带 bak/backup 的也不看。
function shouldSkipDir(name) {
  if (SKIP_DIRS.has(name)) return true;
  if (name.startsWith('.')) return true;
  if (/bak|backup/i.test(name)) return true;
  return false;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue;
      walk(full, out);
    } else if (/\.(js|cjs)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

// ---------- 只认**代码里**的 require ----------
//
// 🔴 为什么不能直接拿正则去扫全文（第一版连着栽两次，都是自测/实跑里红给我看的）：
//    ① 本文件的注释里就写着 `require('./budget')` 这种**举例** → 被当成真 require，
//       报出 6 个"文件不存在"，全是假的；
//    ② 改成"剥掉注释"之后，输出说明里那句 `require('./…')`（在**字符串**里）又被扫中。
//    （真正的 require 只在**代码区**；注释和字符串里的都是文字。）
//
// ⇒ 所以用一个小状态机：注释直接跳过、字符串内容跳过，**只有代码区**里的
//   `require(` 才去读它后面那个字符串字面量。顺带把转义也处理掉。
function scanRequires(src) {
  const found = [];
  const n = src.length;
  const isIdChar = (c) => !!c && /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  let state = 'code';   // code | line | block | sq | dq | tpl

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; continue; } i++; continue; }
    if (state === 'sq') {
      if (c === '\\') { i += 2; continue; }
      if (c === "'") state = 'code';
      i++; continue;
    }
    if (state === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') state = 'code';
      i++; continue;
    }
    if (state === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') state = 'code';
      i++; continue;
    }

    // ---- state === 'code' ----
    if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
    if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
    if (c === "'") { state = 'sq'; i++; continue; }
    if (c === '"') { state = 'dq'; i++; continue; }
    if (c === '`') { state = 'tpl'; i++; continue; }

    // require 前面不能是标识符字符（挡掉 myrequire(...) 这种）
    if (c === 'r' && src.startsWith('require', i) && !isIdChar(src[i - 1])) {
      let j = i + 'require'.length;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '(') {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === "'" || q === '"') {
          let k = j + 1;
          let lit = '';
          while (k < n && src[k] !== q) {
            if (src[k] === '\\') { k++; lit += src[k] === undefined ? '' : src[k]; k++; continue; }
            lit += src[k];
            k++;
          }
          found.push(lit);
          i = k + 1;
          continue;
        }
      }
    }
    i++;
  }
  return found;
}

function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base + '.js', base + '.cjs', base + '.json', path.join(base, 'index.js')];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

const files = walk(ROOT);
if (!files.length) {
  console.log(`❌ 在 ${ROOT} 下一个 .js 都没找到 —— 目录指错了？`);
  process.exit(1);
}

// ---------- ① 模块解析 ----------
const missing = [];
let reqCount = 0;
let pkgCount = 0;      // 非相对路径（包名/内置模块），不归这里管
for (const f of files) {
  let src;
  try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const spec of scanRequires(src)) {
    if (!spec.startsWith('.')) { pkgCount++; continue; }
    reqCount++;
    if (!resolveRel(f, spec)) {
      missing.push({ from: path.relative(ROOT, f), spec });
    }
  }
}

// ---------- ② 语法体检 ----------
// ⚠️ stdio 用 'ignore'：这样在受限环境里也能 spawn（不需要管道）；
//    代价是拿不到报错原文 —— 想看细节就在本机跑 devtools/syntax-check.cjs。
const badSyntax = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'ignore' });
  if (r.error) { console.log(`⚠️ 没法跑语法体检（${r.error.code || r.error.message}）→ 跳过这一项`); break; }
  if (r.status !== 0) badSyntax.push(path.relative(ROOT, f));
}

// ---------- 报告 ----------
console.log('==========================================');
console.log(` 部署自检 · ${ROOT}`);
console.log('==========================================');
console.log(`  扫到 ${files.length} 个 .js/.cjs ；代码里的 require：相对路径 ${reqCount} 条、`
  + `包名/内置 ${pkgCount} 条（包名不查，本项目零依赖）`);

if (missing.length) {
  console.log(`\n❌ 有 ${missing.length} 个 require 指向**不存在的文件**（这就是"启动即崩"的根源）：`);
  for (const x of missing) console.log(`   · ${x.from}  →  require('${x.spec}')`);
  console.log('\n   ⇒ 说明这次部署**没把 server/ 拷全**。请确认用的是最新 deploy.sh（整目录拷）。');
} else {
  console.log('  ✅ 每个 require 的目标文件都在（不会再 Cannot find module）');
}

if (badSyntax.length) {
  console.log(`\n❌ 有 ${badSyntax.length} 个文件 Node 解析不了：`);
  for (const f of badSyntax) console.log(`   · ${f}`);
  console.log('\n   ⇒ 在本机跑 `node devtools/syntax-check.cjs` 看具体报错，改完再传。');
} else {
  console.log('  ✅ 每个文件都能被 Node 解析');
}

const ok = missing.length === 0 && badSyntax.length === 0;
console.log(ok ? '\n ✅✅ 自检通过：这份部署是完整的' : '\n ❌ 自检没过：先别启动，把上面的问题修掉');
process.exit(ok ? 0 : 1);
