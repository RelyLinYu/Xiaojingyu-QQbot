// ============================================================
//  发送消息（群聊 / 单聊共用）
//  修好的坑：
//   1. 先看 res.ok 再看 err_code。原来 HTTP 429/500 时 body 里没有 err_code，
//      代码会打印 [send] ✓ —— 消息其实没发出去，日志却报成功（最难查的假成功）
//   2. 把 trace_id 打出来：拿不准时这是找官方查日志的唯一凭据
//   3. msg_seq 每个 msg_id 从 1 开始递增，且失败也占号（官方：相同 msg_id+msg_seq 重复发送会失败）
//   4. msgSeq 会过期清理，不再无限涨
// ============================================================

const cfg = require('./config');
const { getAccessToken } = require('./auth');

const msgSeq = new Map();      // msg_id -> { n, updatedAt }

// ---------- 被动回复序号 ----------
// 官方：相同 msg_id + msg_seq 重复发送会失败（40054005 消息被去重）
// 所以同一 msg_id 一律递增；发送失败也占号，绝不重发同一个序号。
function nextSeq(msgId) {
  const entry = msgSeq.get(msgId) || { n: 0, updatedAt: 0 };
  entry.n += 1;
  entry.updatedAt = Date.now();
  msgSeq.set(msgId, entry);
  return entry.n;
}

// 定期清理过期的 msg_id 记录（被动回复只有 5 分钟有效），防内存无限涨
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of msgSeq) {
    if (now - v.updatedAt > cfg.dedupe.ttlMs) msgSeq.delete(k);
  }
}, cfg.dedupe.sweepMs).unref();

// 把 err_code 翻译成人话（表在 config.js 的 sendErrors）
function explain(code) {
  if (code == null) return '';
  const txt = (cfg.sendErrors || {})[code];
  return txt ? `（${txt}）` : '（未收录的错误码，可把 trace_id 给官方客服查）';
}

async function postOnce(url, body, label) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    // ⚠️ 必须 UTF-8，否则中文变成 ???
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  });

  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, code: null, detail: `返回非 JSON HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  // ⚠️ HTTP 状态和 err_code 都要看
  if (!res.ok || j.err_code) {
    // 失败时把**请求体原文**和**返回原文**都打出来 —— 否则根本猜不出为什么被拒
    // （之前只打 err_code，导致 40011000 完全无法定位）
    console.error(`[send:${label}] 请求体原文: ${JSON.stringify(body)}`);
    console.error(`[send:${label}] 返回原文: ${text.slice(0, 400)}`);
    return {
      ok: false,
      code: j.err_code ?? null,
      detail: `HTTP ${res.status} err_code=${j.err_code ?? '-'} `
        + `msg=${j.message ?? '-'}${explain(j.err_code)} trace=${j.trace_id ?? '-'}`,
    };
  }
  return { ok: true, json: j };
}

async function postMessage(url, body, label) {
  // ⚠️ 空内容直接不发。
  //    QQ 收到空 content 会报 40011000「请求数据异常」，而那个码查不到含义，
  //    白白浪费一次调用还查不出原因。本地的 trim 检查比它清楚得多。
  //
  // ⚠️⚠️ 但**不能一律查 body.content**（2026-09-21 加 Markdown 时发现）：
  //     · msg_type=0 纯文本 → 内容在 content
  //     · msg_type=2 Markdown → 内容在 markdown.content，**没有 content 字段**
  //     · msg_type=7 富媒体   → 内容在 media.file_info
  //    旧写法一律查 body.content，会把 Markdown / 富媒体消息**全部拦掉**。
  const digest = body.msg_type === 2 ? body.markdown?.content
    : body.msg_type === 7 ? body.media?.file_info
      : body.content;
  if (typeof digest !== 'string' || digest.trim() === '') {
    console.error(`[send:${label}] ✗ 内容为空，已阻止发送（msg_type=${body.msg_type}）`);
    return null;
  }

  let last = await postOnce(url, body, label);

  // 偶发失败自动重试一次（只对"临时性"错误码重试，永久错误重试没意义）
  // ⚠️ 重试时 msg_seq 不变 —— 如果错误真是"重复发送"，变了反而更糟。
  if (!last.ok && cfg.sendRetryable.includes(last.code)) {
    console.warn(`[send:${label}] 遇到可重试错误，1.5 秒后重试一次…`);
    await new Promise((r) => setTimeout(r, 1500));
    const again = await postOnce(url, body, label);
    if (again.ok) {
      console.log(`[send:${label}] ✓（重试成功）${describe(body)}`);
      return again.json;
    }
    last = again;
  }

  if (!last.ok) {
    console.error(`[send:${label}] ✗ ${last.detail}`);
    return null;
  }

  console.log(`[send:${label}] ✓${describe(body)}`);
  return last.json;
}

// 日志用的内容摘要（Markdown / 富媒体没有 content，直接打 body.content 会是 undefined）
function describe(body) {
  const t = body.msg_type === 2 ? body.markdown?.content
    : body.msg_type === 7 ? '[富媒体 file_info]'
      : body.content;
  return ' ' + String(t || '').replace(/\n/g, ' / ').slice(0, 120);
}

// ---------- 群聊 ----------
// quoteRefId：要**引用**的消息 ID（REFIDX_...），来自对方消息的 message_scene.ext 里的 msg_idx。
// ⚠️ 它和 msg_id 是两回事：
//    msg_id（形如 ROBOT1.0_...）只用于"被动回复"，本身不显示引用；
//    message_reference 才会在消息下方显示引用块。
async function sendGroupMessage(groupOpenid, content, replyToMsgId, quoteRefId) {
  const body = { msg_type: 0, content };
  if (replyToMsgId) {
    body.msg_id = replyToMsgId;
    body.msg_seq = nextSeq(replyToMsgId);
  }
  if (quoteRefId) {
    body.message_reference = { message_id: quoteRefId };
  }
  return postMessage(`https://api.bot.qq.com/v2/groups/${groupOpenid}/messages`, body, 'group');
}

// ---------- 单聊 ----------
async function sendPrivateMessage(userOpenid, content, replyToMsgId, quoteRefId) {
  const body = { msg_type: 0, content };
  if (replyToMsgId) {
    body.msg_id = replyToMsgId;
    body.msg_seq = nextSeq(replyToMsgId);
  }
  if (quoteRefId) {
    body.message_reference = { message_id: quoteRefId };
  }
  return postMessage(`https://api.bot.qq.com/v2/users/${userOpenid}/messages`, body, 'private');
}

// ---------- 群聊：Markdown 卡片 ----------
// ⚠️ 官方明确（2026/04/23 起）：**单聊/群聊的自定义 Markdown 对所有机器人开放，无需申请模板**。
//    别和"markdown 模版消息"（要 custom_template_id）搞混 —— 那个才要申请。
// 语法是 QQ 自己的方言，见 docs/项目文档.md；长文本折行要用零宽空格，不能用 \n。
async function sendGroupMarkdown(groupOpenid, markdown, replyToMsgId) {
  const body = { msg_type: 2, markdown: { content: markdown } };
  if (replyToMsgId) {
    body.msg_id = replyToMsgId;
    body.msg_seq = nextSeq(replyToMsgId);
  }
  return postMessage(`https://api.bot.qq.com/v2/groups/${groupOpenid}/messages`, body, 'group-md');
}

async function sendPrivateMarkdown(userOpenid, markdown, replyToMsgId) {
  const body = { msg_type: 2, markdown: { content: markdown } };
  if (replyToMsgId) {
    body.msg_id = replyToMsgId;
    body.msg_seq = nextSeq(replyToMsgId);
  }
  return postMessage(`https://api.bot.qq.com/v2/users/${userOpenid}/messages`, body, 'private-md');
}

// ---------- 富媒体消息（msg_type=7）----------
// ⚠️ file_info 来自 qqmedia.js 的上传接口，**直接透传** ——
//    官方原话："内部为序列化的二进制数据，开发者无需解析"。
// ⚠️ file_info 有 ttl（有效期），过期就废了 → 流程必须是「上传完立刻发」。
async function sendGroupMedia(groupOpenid, fileInfo, replyToMsgId) {
  const body = { msg_type: 7, media: { file_info: fileInfo } };
  if (replyToMsgId) {
    body.msg_id = replyToMsgId;
    body.msg_seq = nextSeq(replyToMsgId);
  }
  return postMessage(`https://api.bot.qq.com/v2/groups/${groupOpenid}/messages`, body, 'group-media');
}

async function sendPrivateMedia(userOpenid, fileInfo, replyToMsgId) {
  const body = { msg_type: 7, media: { file_info: fileInfo } };
  if (replyToMsgId) {
    body.msg_id = replyToMsgId;
    body.msg_seq = nextSeq(replyToMsgId);
  }
  return postMessage(`https://api.bot.qq.com/v2/users/${userOpenid}/messages`, body, 'private-media');
}

module.exports = {
  sendGroupMessage,
  sendPrivateMessage,
  sendGroupMarkdown,
  sendPrivateMarkdown,
  sendGroupMedia,
  sendPrivateMedia,
};
