'use strict';
// ============================================================
//  独立小服务：只干一件事 —— 对外提供「打开 QQ 名片」落地页
//
//  🔴 为什么单独起一个服务、还占 80 端口：
//    QQ 的 markdown 只接受 https/http 链接，而面板跑在 **8080**。
//    消息里带 :8080 的链接不体面、也可能被客户端当成"可疑地址"，
//    所以单独起一个**只读、只回一页 HTML** 的极小服务占 80。
//
//  🔴 安全边界（这块必须写清楚，别以后忘了）：
//    · 只接受 `n` = 5~12 位纯数字（**不允许 0 开头**）；不合法直接 400
//    · 不读文件、不连数据库、不代理任何请求（**不是开放代理/开放重定向**）
//    · 不做任何跳转响应头（Location）—— 跳转是页面里点按钮才发生的
//    · 没有 POST 路由，没有别的路径（除 /qr 与 /healthz 一律 404）
//
//  用法：PORT=80 node tools/qrserve.js
// ============================================================
const http = require('http');
const qrpage = require('../qr');

const PORT = Number(process.env.QR_PORT || process.env.PORT || 80);
const HOST = process.env.QR_HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { url = null; }

  const path = url ? url.pathname : '/';
  const t0 = Date.now();

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (path === '/qr' && (req.method === 'GET' || req.method === 'HEAD')) {
    const n = String(url.searchParams.get('n') || '').trim();
    const isGroup = url.searchParams.get('t') === 'g';
    if (!qrpage.validNum(n)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('号码不合法：n 需要是 5~12 位数字（且不以 0 开头）');
      console.log(`[qrserve] 400 ${path} n=${n.slice(0, 20)} ${Date.now() - t0}ms`);
      return;
    }
    let html;
    try { html = qrpage.page(n, isGroup); } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('生成失败：' + (e.message || e));
      console.log(`[qrserve] 500 ${path} ${e.message}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? '' : html);
    console.log(`[qrserve] 200 ${path} n=${n}${isGroup ? ' group' : ''} ${Date.now() - t0}ms`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[qrserve] 已监听 http://${HOST}:${PORT}/qr?n=<号码>（只回一张落地页，不碰任何数据）`);
});

// 别让一个未捕获异常把服务打死（systemd 有 Restart=always，但能不出事最好）
process.on('uncaughtException', (e) => console.error('[qrserve] uncaught:', e.message));
process.on('unhandledRejection', (e) => console.error('[qrserve] unhandled:', e && e.message));
