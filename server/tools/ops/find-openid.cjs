#!/usr/bin/env node
// ============================================================
//  tools/ops/find-openid.cjs —— 从事件落盘里挖出「谁是谁的 openid」
//
//  🔴 为什么必须有这个（新手部署最容易卡住的一步）：
//    QQ **不给 QQ 号**，只给 `member_openid` —— 一串 32 位随机 ID，
//    而且**按机器人应用隔离**（换个机器人，同一个群、同一个人都是另一串）。
//    所以"填主人"这件事有个鸡生蛋：**得先让机器人跑起来收到消息，才知道自己的 ID**。
//
//    而填错的后果是最烦的那种：`isOwner()` 永远 false，
//    「只服从主人」的规则**静默失效** —— 不报错、不提示，你就是查不出为什么。
//
//  用法（在服务器上跑）：
//      node tools/ops/find-openid.cjs            # 默认读本文件的上一级 /data
//      node tools/ops/find-openid.cjs /opt/xxx   # 指定应用根目录
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const DATA_DIR = path.join(APP_DIR, 'data');

let files;
try {
  files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('events-')).sort();
} catch {
  console.log(`❌ 读不到 ${DATA_DIR} —— 目录指错了，还是机器人一次都没收到过消息？`);
  process.exit(1);
}
if (!files.length) {
  console.log(`❌ ${DATA_DIR} 里没有 events-*.jsonl`);
  console.log('   ⇒ 机器人还**一次都没收到过消息**。先去群里发一句话，再回来跑本脚本。');
  process.exit(1);
}

// member_openid -> { names:Set, groups:Set, bot }
const seen = new Map();
let lines = 0;

for (const f of files) {
  let raw;
  try { raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf8'); } catch { continue; }
  // ⚠️ 先剥掉可能的 UTF-8 BOM —— 否则**第一行** JSON.parse 会失败，
  //    于是"出现次数"少算一次（实测：群主发了 2 条却显示 1 条）。
  //    机器人自己写的事件文件没有 BOM，但那个文件可能被人用 Windows 工具编辑过。
  raw = raw.replace(/^\uFEFF/, '');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let a;
    try { a = JSON.parse(line).d?.author; } catch { continue; }
    if (!a || !a.member_openid) continue;
    const key = a.member_openid;
    const rec = seen.get(key) || { names: new Set(), groups: new Set(), bot: false, n: 0 };
    if (a.username) rec.names.add(String(a.username));
    rec.bot = rec.bot || !!a.bot;
    rec.n += 1;
    seen.set(key, rec);
  }

  // 顺手把群 openid 也收一下（群级设置/排查时要用）
  try {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const d = JSON.parse(line).d;
      if (d?.group_openid && d?.author?.member_openid) {
        seen.get(d.author.member_openid)?.groups.add(d.group_openid);
      }
    }
  } catch { /* 这一遍只是兜底，收不到就算了 */ }
}

console.log('==========================================');
console.log(` 从 ${files.length} 个事件文件、${lines} 条记录里找到的人`);
console.log('==========================================\n');

if (!seen.size) {
  console.log('❌ 一条带 openid 的记录都没有 —— 机器人还没收到过消息（或者收到的是私聊）。');
  process.exit(1);
}

// 说话多的排前面（一般"你自己"就是话最多的那个）
const rows = [...seen.entries()].sort((a, b) => b[1].n - a[1].n);
for (const [id, rec] of rows) {
  const name = [...rec.names].join(' / ') || '(无昵称)';
  const tag = rec.bot ? ' [机器人]' : '';
  console.log(`${String(rec.n).padStart(6)} 条   ${name.padEnd(16)}${tag}`);
  console.log(`              ${id}`);
  for (const g of rec.groups) console.log(`              群: ${g}`);
  console.log('');
}

console.log('------------------------------------------');
console.log(' 你是哪一个？找到**你自己那行**，复制那串 32 位 ID，然后：');
console.log('');
// 🆕 2026-10-23 修：原来这里写死服务器命令（sudo / systemctl / /opt 路径），
//    本地版（Windows/macOS）照着抄必然失败。现在按环境和文件是否存在给不同指引。
const fs2 = require('fs');
const envCandidates = [
  path.join(APP_DIR, '.env'),            // 服务器：/opt/xiaolanjing/.env
  path.join(APP_DIR, '..', '.env'),      // 本地：仓库根 .env（APP_DIR 是 server/）
];
const ENV_FILE = envCandidates.find((f) => { try { return fs2.existsSync(f); } catch { return false; } }) || envCandidates[0];
const isWin = process.platform === 'win32';
const hasSystemd = !isWin && (() => { try { return fs2.existsSync('/etc/systemd/system/xiaolanjing.service'); } catch { return false; } })();
console.log(' 把这两行加进这个文件（没有就新建这两行）：');
console.log('   ' + ENV_FILE);
console.log('   BOT_OWNER_OPENID=上面那串ID');
console.log('   BOT_OWNER_NAME=你的昵称');
console.log('');
if (hasSystemd) {
  console.log(' 然后重启机器人（服务器）：');
  console.log('   sudo systemctl restart xiaolanjing');
} else if (isWin) {
  console.log(' 然后重启机器人（Windows 本地版）：');
  console.log('   powershell -ExecutionPolicy Bypass -File start-local.ps1 -Stop');
  console.log('   powershell -ExecutionPolicy Bypass -File start-local.ps1');
} else {
  console.log(' 然后重启机器人（本地版）：');
  console.log('   bash start-local.sh --stop && bash start-local.sh');
}
console.log('');
console.log(' ⚠️ 别用 nano 粘贴（从 Windows 粘会塞进 CRLF，见项目文档「CRLF 污染 .env」）');
console.log(' ⚠️ 别填 QQ 号 —— QQ 只给 openid，填 QQ 号 = 主人规则静默失效');
console.log(' ⚠️ 改完 .env 必须重启机器人才生效（面板改的不算）');
console.log('------------------------------------------');