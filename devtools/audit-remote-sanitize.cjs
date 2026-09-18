// ============================================================
//  脱敏审计：确认要发布的内容里没有夹带真实凭证 / 个人标识
//
//  三种模式（在项目根目录跑）：
//    node devtools/audit-remote-sanitize.cjs [仓库路径]             默认：审计 origin/main（远端已有内容）
//    node devtools/audit-remote-sanitize.cjs [仓库路径] --staged    ⭐ 审计暂存区（**推送前该跑这个**）
//    node devtools/audit-remote-sanitize.cjs [仓库路径] --worktree  审计工作区全部文件
//
//  ⚠️ 为什么需要 --staged：
//     默认模式只扫远端，**本地还没推的内容它看不见** ——
//     结果就是"审计通过但推上去才发现带了 IP"。
//     推送前先跑 --staged，才能真正拦住。
//
//  ⚠️ 设计说明（重要）：
//     真实密钥 / 邮箱 / openid / 昵称的**具体值**放在
//     `private/.sanitize-patterns.local`（已被 .gitignore 排除）。
//     本脚本**刻意不硬编码任何真实值** —— 否则脚本自己就成了一份
//     "精确泄漏清单"，别人一看就知道该去找什么。
// ============================================================
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const MODE = args.includes('--staged') ? 'staged'
  : args.includes('--worktree') ? 'worktree'
    : 'remote';
const repo = args.find((a) => !a.startsWith('--')) || process.cwd();
const REF = 'origin/main';

const git = (a) => {
  try { return execFileSync('git', a, { encoding: 'utf8', cwd: repo, maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

// ⚠️⚠️ git 不可用时必须**立刻退出**，绝不能静默"通过"。
//
//    踩过的坑（2026-09 实测）：在受限沙箱里 execFileSync 直接抛 EPERM，
//    而上面那个 catch 会把错误吞成空字符串。后果是：
//      · 【A】打印"检查 0 个文件"然后 ✅（空集当然通过）
//      · 【B】22 条特征**全部**报 ✅ —— 实际一条都没扫，包括明明存在的真实 IP
//      · 只有【F】因为读不到 .gitignore 才碰巧报错，退出码才非 0
//    一个安全工具 fail-open 是最坏的性质：看起来在保护你，其实全程在睡觉。
//    所以这里先做一次"git 到底能不能用"的探针，不能用就退出码 2 明确报错。
const gitUsable = (() => {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8', cwd: repo });
    return true;
  } catch { return false; }
})();
if (!gitUsable) {
  console.error('\n❌ 无法执行 git（工作目录: ' + repo + '）—— 审计无法进行。');
  console.error('');
  console.error('   ⚠️ 注意：这不是"检查通过"，这是"根本没检查"。');
  console.error('   常见原因：');
  console.error('     ① 这个路径不是 git 仓库');
  console.error('     ② 运行环境禁止子进程管道（报 EPERM 的就是这种）');
  console.error('   对策：换到普通终端跑；或在受限环境里用 git grep 手工核对。');
  console.error('');
  process.exit(2);
}

let problems = 0;
const flag = (m) => { console.log('  ❌ ' + m); problems++; };
const ok = (m) => console.log('  ✅ ' + m);
const warn = (m) => console.log('  ⚠️  ' + m);

console.log('════════════════════════════════════════════════════════');
console.log(MODE === 'staged' ? ' 脱敏审计 · 暂存区（推送前检查）'
  : MODE === 'worktree' ? ' 脱敏审计 · 工作区全部文件'
    : ' 脱敏审计 · 远端 origin/main');
console.log('════════════════════════════════════════════════════════');

// ---------- A. 文件名（通用规则，不需外部清单）----------
console.log('\n【A】文件名检查');
const names = MODE === 'remote'
  ? git(['ls-tree', '-r', '--name-only', REF]).trim().split('\n').filter(Boolean)
  : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).trim().split('\n').filter(Boolean);
console.log(`  检查 ${names.length} 个文件`);

const forbiddenNames = [
  [/^关键信息速查\.md$/, '真实凭证文件'],
  [/关键信息速查/, '真实凭证文件（任何路径）'],
  [/^\.env$/, '.env 真实配置'],
  [/^data\//, 'data 运行数据目录'],
  [/\.bak-/, '配置备份'],
  [/\.jsonl$/, '事件日志（含聊天记录）'],
  [/^budget\.json$/, '花费状态文件'],
  [/known_hosts/, 'SSH known_hosts'],
  [/id_(rsa|ed25519)/, 'SSH 私钥'],
  [/\.pem$|\.key$/, '密钥文件'],
  [/\.local$/, '本地私有清单'],
  // private/ 整个目录是本地私有的，任何文件都不该出现在提交里
  [/^private\//, 'private/ 私有目录（凭证与特征清单）'],
  // 项目文档 = 交接文档的后继，同样含服务器 IP 与运维细节
  [/项目交接文档|项目文档/, '项目/交接文档（含服务器 IP 与运维细节）'],
  [/^docs\//, 'docs/ 本地文档目录'],
];
const nameProblemsBefore = problems;
for (const [re, label] of forbiddenNames) {
  const hit = names.filter((n) => re.test(n));
  if (hit.length) flag(`${label}: ${hit.join(', ')}`);
}
if (problems === nameProblemsBefore) ok('没有危险文件名');

// ---------- B/C. 内容扫描（需要外部清单）----------
// 特征清单在 private/ 下（本地私有）。旧的根目录位置也认，兼容没搬过的仓库。
const patternFile = [
  path.join(repo, 'private', '.sanitize-patterns.local'),
  path.join(repo, '.sanitize-patterns.local'),
].find((p) => fs.existsSync(p)) || path.join(repo, 'private', '.sanitize-patterns.local');
let patterns = [];
if (fs.existsSync(patternFile)) {
  const lines = fs.readFileSync(patternFile, 'utf8').replace(/\r/g, '').split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const [re, label] = t.split('\t');
    if (re) patterns.push([label || re, new RegExp(re)]);
  }
  console.log(`\n【B】内容扫描 — 载入 ${patterns.length} 条真实特征  (模式: ${MODE})`);
} else {
  warn('未找到 .sanitize-patterns.local，跳过真实值扫描');
  console.log('      （该文件含真实特征，本就不该提交。部署到你自己的机器时请自建一份）');
}

// 按模式取"要扫描的文本"
//
// ⚠️ staged 模式必须只取 **新增行（`+` 开头）**：
//    如果直接拿整个 diff 去匹配，`-` 开头的"被删除行"也会命中 ——
//    结果是"删掉一个旧密钥"反而报泄漏，全是假阳性（踩过这个坑）。
function contentFor(re) {
  if (MODE === 'staged') {
    // 只保留新增行，去掉 diff 头部
    const diff = git(['diff', '--cached', '-U0', '--no-color']);
    return diff.split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
  }
  if (MODE === 'worktree') return git(['grep', '-I', '-n', '-e', re.source, '--', '.']);
  return git(['grep', '-I', '-n', '-e', re.source, REF]);
}

// staged 模式的"新增内容"对所有特征都一样，只算一次
const stagedAdded = MODE === 'staged' ? contentFor(null) : null;

for (const [label, re] of patterns) {
  if (MODE === 'staged') {
    if (re.test(stagedAdded)) {
      flag(`${label} 在暂存的新增内容里`);
      // 给出具体行，便于定位
      stagedAdded.split('\n')
        .filter((l) => re.test(l))
        .slice(0, 3)
        .forEach((l) => console.log('       + ' + l.trim().slice(0, 130)));
    } else {
      ok(`${label} — 无`);
    }
  } else {
    const out = contentFor(re);
    if (out.trim()) {
      flag(`${label} 仍存在:`);
      out.trim().split('\n').slice(0, 3).forEach((l) => console.log('       ' + l.slice(0, 140)));
    } else {
      ok(`${label} — 无`);
    }
  }
}
if (patterns.length) ok(`（以上共检查 ${patterns.length} 条）`);

// ---------- D. 提交信息 ----------
if (MODE !== 'remote') {
  console.log('\n【D】提交信息 — 仅远端模式检查（暂存区还没有 commit message）');
} else {
  console.log('\n【D】提交信息（commit message）');
  const logBody = git(['log', '--format=%B', REF]);
  let logBad = false;
  for (const [label, re] of patterns) {
    if (re.test(logBody)) { flag(`提交信息含：${label}`); logBad = true; }
  }
  if (!logBad) ok('提交信息干净');
}

// ---------- E. 提交作者 ----------
if (MODE !== 'remote') {
  console.log('\n【E】提交作者 — 仅远端模式检查');
} else {
  console.log('\n【E】提交作者（含邮箱）');
  const authors = [...new Set(git(['log', '--format=%an <%ae>', REF]).trim().split('\n'))];
  for (const a of authors) {
    let risky = false;
    for (const [, re] of patterns) if (re.test(a)) risky = true;
    // 通用规则：noreply 是安全的
    const isNoreply = /@users\.noreply\.github\.com$/.test(a);
    console.log(`  ${risky ? '❌' : '✅'} ${a}${risky ? '  ← 命中真实特征！' : (isNoreply ? '  （noreply，已隐藏真实邮箱）' : '')}`);
    if (risky) problems++;
  }
}

// ---------- F. .gitignore 覆盖 ----------
console.log('\n【F】.gitignore 覆盖检查');
const required = ['关键信息速查.md', '.env', 'data/', '.bak-', '.jsonl', 'budget.json', '.local'];
const gi = git(['show', `${REF}:.gitignore`]);
for (const r of required) {
  const covered = gi.includes(r.replace(/\/$/, '')) || gi.includes(r);
  console.log(`  ${covered ? '✅' : '❌'} 含忽略规则 ${r}`);
  if (!covered) problems++;
}

// ---------- G. 通用可疑模式（不需清单）----------
console.log('\n【G】通用可疑模式');
const loose = [
  ['GitHub Token', /(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}/],
  ['私钥文件头', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['非空的环境变量赋值', /^(AI_API_KEY|QQ_BOT_SECRET|LOG_PASSWORD)=[^\s$'"]+/m],
];
for (const [label, re] of loose) {
  const out = git(['grep', '-I', '-n', '-e', re.source, REF]);
  if (out.trim()) {
    // 变量名出现在文档/脚本里是正常的（不是真值），只提示
    warn(`${label}:`);
    out.trim().split('\n').slice(0, 3).forEach((l) => console.log('       ' + l.slice(0, 140)));
    console.log('       ↑ 若右侧为空值或占位符则无害；若真是密钥要立刻处理');
  } else {
    ok(`${label} — 无`);
  }
}

console.log('\n════════════════════════════════════════════════════════');
if (problems === 0) console.log(' ✅✅ 复查结论：脱敏彻底，远端仓库无不安全内容');
else console.log(` ❌ 复查结论：发现 ${problems} 处问题，需要处理`);
console.log('════════════════════════════════════════════════════════');
process.exit(problems ? 1 : 0);
