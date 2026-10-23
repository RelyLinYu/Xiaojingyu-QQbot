// ============================================================
//  WebSocket 网关：连上 QQ，收事件
//  修好的坑：
//   1. start() 里任何报错都会重连（原来会静默死亡）
//   2. 重连带指数退避（避免 4008 被频控打回）
//   3. 检查 res.ok 和 url 字段（原来是 new WebSocket(undefined)）
//   4. onEvent 的 Promise 被兜住（原来 unhandledRejection 会杀进程）
//   5. 区分 4013/4014（自己配错，重连没用）和临时故障
// ============================================================

const cfg = require('./config');
const { getAccessToken } = require('./auth');

// INTENTS = 1<<25 = GROUP_AND_C2C_EVENT（群聊全量 + 群@ + 单聊）
// 官方事件文档明确写：GROUP_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE /
// C2C_MESSAGE_CREATE 三个事件的 Intent 都是 GROUP_AND_C2C_EVENT (1<<25)
const INTENTS = Number(process.env.QQ_BOT_INTENTS) || (1 << 25);

// 临时故障 → 值得重连
const RETRYABLE_CLOSE_CODES = new Set([4001, 4002, 4006, 4007, 4008, 4009, 4010, 4011, 4012]);
// 自己配置错了 → 重连一万次也没用
const FATAL_CLOSE_CODES = new Set([4013, 4014, 4914, 4915]);

function connect(onEvent) {
  let ws = null;
  let hb = null;
  let lastSeq = null;
  let alive = true;
  let retryDelay = 3000;          // 退避起点
  let retryTimer = null;

  function scheduleReconnect(reason) {
    if (!alive) return;
    clearTimeout(retryTimer);
    console.log(`[ws] ${reason}，${Math.round(retryDelay / 1000)} 秒后重连`);
    retryTimer = setTimeout(start, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60000);   // 3s → 6s → 12s → … 封顶 60s
  }

  async function start() {
    if (!alive) return;
    try {
      clearInterval(hb);

      const token = await getAccessToken();
      const res = await fetch('https://api.bot.qq.com/gateway', {
        headers: { Authorization: `QQBot ${token}` },
      });

      const text = await res.text();
      let gate;
      try {
        gate = JSON.parse(text);
      } catch {
        throw new Error(`网关接口返回的不是 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`);
      }
      // ⚠️ 没有这个检查，token 失效时会走到 new WebSocket(undefined)
      if (!res.ok || !gate.url) {
        throw new Error(`拿网关地址失败 HTTP ${res.status}: ${JSON.stringify(gate).slice(0, 200)}`);
      }
      console.log('[ws] 网关:', gate.url);

      ws = new WebSocket(gate.url);
      lastSeq = null;

      ws.onopen = () => console.log('[ws] 已连接');

      ws.onmessage = (e) => {
        let p;
        try {
          p = JSON.parse(e.data);
        } catch {
          console.warn('[ws] 收到非 JSON 数据，忽略');
          return;
        }

        if (p.s != null) lastSeq = p.s;

        if (p.op === 10) {
          // Hello：开始鉴权 + 按服务端给的间隔心跳
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS,
              shard: [0, 1],
              properties: { $os: 'linux', $browser: 'node', $device: 'node' },
            },
          }));
          clearInterval(hb);
          hb = setInterval(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: lastSeq }));
          }, p.d.heartbeat_interval);
        } else if (p.op === 0) {
          if (p.t === 'READY') {
            console.log('[ws] 鉴权成功:', p.d?.user?.username || '(已连接)');
            // 📌 实测确认（2026-09）：READY.user 只有 {id, username, bot, status}，
            //    **没有 openid / member_openid**。消息里的 openid 是另一套（形如 F569...），
            //    和这里的数字 id 对不上。所以 @ 判定拿不到"机器人自己的 openid"，
            //    只能依赖 mentions 里的 is_you 标记 —— 实测每条真 @ 都带，够用。
            retryDelay = 3000;      // 连上就把退避重置
          } else {
            // ⚠️ 关键：把 onEvent 的 Promise 兜住。
            // 原来这里直接 onEvent(...)，回调里一抛错就是 unhandledRejection，
            // Node 22/24 默认直接杀进程。
            Promise.resolve()
              .then(() => onEvent(p.t, p.d))
              .catch((err) => console.error('[事件处理异常]', p.t, err?.message || err));
          }
        } else if (p.op === 7) {
          console.log('[ws] 服务端要求重连');
          ws.close();
        } else if (p.op === 9) {
          console.warn('[ws] session 无效，重新鉴权');
          ws.close(4006);
        }
      };

      ws.onclose = (e) => {
        clearInterval(hb);
        const code = e.code;

        if (FATAL_CLOSE_CODES.has(code)) {
          alive = false;
          if (code === 4013) {
            console.error('[ws] ❌ 无效的 intent（4013）——检查 QQ_BOT_INTENTS 配置，重连没用');
          } else if (code === 4014) {
            console.error('[ws] ❌ intent 无权限（4014）——回 QQ 后台打开「接收所有消息」开关');
          } else if (code === 4914) {
            console.error('[ws] ❌ 机器人已下架（4914）——回后台看机器人状态');
          } else if (code === 4915) {
            console.error('[ws] ❌ 机器人已封禁（4915）——需要申请解封');
          }
          return;
        }

        if (RETRYABLE_CLOSE_CODES.has(code)) {
          console.log(`[ws] 断开 ${code}（${e.reason || '临时故障'}）`);
          scheduleReconnect('临时故障');
          return;
        }

        console.log(`[ws] 断开 ${code} ${e.reason || ''}`);
        scheduleReconnect('连接断开');
      };

      ws.onerror = (e) => console.error('[ws] 错误', e?.message || e);
    } catch (err) {
      // ⚠️ 这里是关键修复：原版 start() 抛错就再也没人调用它了 → 静默死亡
      console.error('[ws] 启动失败:', err?.message || err);
      scheduleReconnect('启动失败');
    }
  }

  start();

  return {
    close: () => {
      alive = false;
      clearTimeout(retryTimer);   // 防止关闭后又被定时器拉起来
      clearInterval(hb);
      if (ws) ws.close();
    },
    intents: INTENTS,
  };
}

module.exports = { connect, INTENTS };
