// ============================================================
//  获取 / 刷新 AccessToken
//  官方：https://api.bot.qq.com/app/getAppAccessToken
//  - token 有效期 7200 秒
//  - 有效期内重复获取返回同一个值，不会刷新
//  - 过期前 60 秒内再获取会拿到新的
//  所以：本地缓存 + 提前 5 分钟换新，是官方推荐的做法
// ============================================================

const cfg = require('./config');

let cache = { token: null, expireAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  // 提前 5 分钟换新，留足安全边界
  if (cache.token && now < cache.expireAt - 5 * 60 * 1000) return cache.token;

  const res = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.secret }),
  });

  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`拿 token 返回的不是 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`);
  }

  // ⚠️ 先看 HTTP 状态和错误字段，别直接信 body。
  // 实测（本机用假凭证打过）：token 接口出错时 HTTP 仍是 200，
  // 错误藏在 body 的 code 字段里： {"code":100016,"message":"invalid appid or secret"}
  // 别的接口用 err_code，所以两个都要认。
  const errCode = j.err_code ?? j.code;
  if (!res.ok || errCode || !j.access_token) {
    throw new Error(
      `拿 token 失败 HTTP ${res.status} code=${errCode ?? '-'} msg=${j.message ?? '-'}`
      + '（100016=AppID/Secret 不对；100007=AppID 无效或机器人被封禁/已删除）',
    );
  }

  cache = {
    token: j.access_token,
    // 官方返回的是字符串 "7200"，Number() 转一下
    expireAt: now + Number(j.expires_in || 7200) * 1000,
  };
  console.log('[auth] 新 token，有效期', j.expires_in, '秒');
  return cache.token;
}

module.exports = { getAccessToken };
