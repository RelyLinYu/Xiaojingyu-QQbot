#!/usr/bin/env node
// ============================================================
//  发送消息诊断 —— 定位 err_code=40011000「请求数据异常」
//
//  背景：日志里 [send:group] ✗ HTTP 400 err_code=40011000，
//        但这个错误码**不在 QQ 官方错误码表里**，只能靠实际请求定位。
//
//  做法：
//    1. 从 data/events-*.jsonl 里取最近一条群消息
//    2. 用它的 msg_id 走**和线上完全一样**的发送路径，但内容换成一句安全的测试文本
//    3. 依次做 4 组对照实验，精确定位是哪一项导致的
//
//  用法（服务器上）： cd /opt/xiaolanjing && node tools/send-diagnose.js
//  ⚠️ 会真的往群里发 1~4 条测试消息（内容是无害的测试文本）
// ============================================================

const fs = require('fs');
const path = require('path');

const env = {};
const envText = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').replace(/\r/g, '');
for (const line of envText.split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const APPID = env.QQ_BOT_APPID;
const SECRET = env.QQ_BOT_SECRET;

async function token() {
  const r = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APPID, clientSecret: SECRET }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('拿 token 失败: ' + JSON.stringify(j));
  return j.access_token;
}

// ---------- 找出最近一条群消息 ----------
function latestGroupMsg() {
  const dir = path.join(__dirname, '..', 'data');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('events-')).sort();
  const lines = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) lines.push(line);
    }
  }
  // 从最后往前找，取第一条带 group_openid 和 id 的
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      const d = e.d;
      if (d && d.group_openid && d.id && d.author) return { type: e.t, d };
    } catch {}
  }
  return null;
}

async function trySend(tk, label, groupOpenid, body) {
  const res = await fetch(`https://api.bot.qq.com/v2/groups/${groupOpenid}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `QQBot ${tk}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  });
  const text = await res.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch {}
  const ok = res.ok && !j.err_code;
  const mark = ok ? '✅ 成功' : '❌ 失败';
  console.log(`\n[${label}] ${mark}  HTTP ${res.status}`);
  console.log('  请求体: ' + JSON.stringify(body));
  if (!ok) console.log(`  返回: err_code=${j.err_code ?? '-'} msg=${j.message ?? '-'} trace=${j.trace_id ?? '-'}`);
  else console.log(`  返回: id=${j.id ?? '-'}`);
  return { ok, j, body };
}

(async () => {
  const found = latestGroupMsg();
  if (!found) { console.error('❌ data/ 里找不到群消息事件，先在群里发一条消息再跑'); process.exit(1); }
  const { type, d } = found;

  console.log('================================================================');
  console.log(' 发送消息诊断');
  console.log('================================================================');
  console.log(`最近事件类型 : ${type}`);
  console.log(`群 openid    : ${d.group_openid}`);
  console.log(`消息 id      : ${String(d.id).slice(0, 40)}...`);
  console.log(`发送者       : ${d.author?.username} (bot=${d.author?.bot})`);
  console.log(`内容         : ${JSON.stringify(d.content)}`);
  console.log(`mentions     : ${JSON.stringify(d.mentions || [])}`);

  const tk = await token();
  const gid = d.group_openid;
  const results = [];

  // ---- 第 1 组：完整被动回复（线上原样的结构）----
  results.push(await trySend(tk, '1. 被动回复：content+msg_id+msg_seq', gid, {
    msg_type: 0, content: '（测试1）', msg_id: d.id, msg_seq: 1,
  }));

  await new Promise((r) => setTimeout(r, 2000));

  // ---- 第 2 组：只带 content，不带 msg_id（主动消息）----
  //    如果这条成功，说明问题出在 msg_id / 被动回复环节
  results.push(await trySend(tk, '2. 不带 msg_id（主动消息）', gid, {
    msg_type: 0, content: '（测试2）',
  }));

  await new Promise((r) => setTimeout(r, 2000));

  // ---- 第 3 组：带 msg_id 但换一个更大的 msg_seq ----
  results.push(await trySend(tk, '3. 被动回复：msg_seq=2', gid, {
    msg_type: 0, content: '（测试3）', msg_id: d.id, msg_seq: 2,
  }));

  await new Promise((r) => setTimeout(r, 2000));

  // ---- 第 4 组：模拟真实回复内容（含中文标点，15 字左右）----
  results.push(await trySend(tk, '4. 被动回复：较长的中文内容', gid, {
    msg_type: 0, content: '说话弟弟，今天怎么这么有空啊', msg_id: d.id, msg_seq: 3,
  }));

  // ---------- 结论 ----------
  console.log('\n================================================================');
  console.log(' 结论');
  console.log('================================================================');
  const [r1, r2, r3, r4] = results;
  console.log(`  1. 带 msg_id + msg_seq=1 : ${r1.ok ? '成功' : '失败'}`);
  console.log(`  2. 不带 msg_id（主动）    : ${r2.ok ? '成功' : '失败'}`);
  console.log(`  3. 带 msg_id + msg_seq=2 : ${r3.ok ? '成功' : '失败'}`);
  console.log(`  4. 带 msg_id + 长中文     : ${r4.ok ? '成功' : '失败'}`);

  console.log('');
  if (!r1.ok && r2.ok) {
    console.log('  👉 问题在【被动回复】环节（msg_id / msg_seq）');
    console.log('     主动消息能发 → 可能这条消息的被动回复窗口已过（超 5 分钟），或 msg_id 不被接受');
  } else if (!r1.ok && !r2.ok) {
    console.log('  👉 连主动消息都失败 → 大概率是【权限/频控/群状态】问题，不是消息格式');
    console.log('     检查：机器人是否还在群里（40034101/40054003）、是否被禁言（40054002）');
  } else if (r1.ok && !r2.ok) {
    console.log('  👉 被动回复能发、主动不能 → 正常现象（未认证主体主动消息受限）');
  } else {
    console.log('  👉 第 1 组就成功了 —— 说明刚才那次失败是**偶发**（可能是时间窗口或频控）');
  }
  console.log('');
  console.log('  把以上完整输出发给 AI 分析。');
})().catch((e) => { console.error('脚本出错:', e); process.exit(1); });
