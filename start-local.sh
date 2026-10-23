#!/usr/bin/env bash
# ============================================================
#  start-local.sh —— 在 macOS / Linux 本地跑机器人（不用 systemd）
#
#  用法：
#    bash start-local.sh          # 启动
#    bash start-local.sh --check  # 只自检
#    bash start-local.sh --stop   # 停止
# ============================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$ROOT/server"
ENVFILE="$ROOT/.env"
DATA="$SERVER/data"
PIDFILE="$DATA/local-pids"

say() { printf '%s\n' "$*"; }

if [ "${1:-}" = "--stop" ]; then
  if [ ! -f "$PIDFILE" ]; then say "没有在运行的实例"; exit 0; fi
  # shellcheck disable=SC1090
  . "$PIDFILE"
  for name in bot panel; do
    pid="${!name:-}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null && say "已停止 $name (PID $pid)"; fi
  done
  rm -f "$PIDFILE"
  exit 0
fi

command -v node >/dev/null 2>&1 || { say "❌ 没找到 node，请先装 Node.js 22+： https://nodejs.org"; exit 1; }
NODE_VER="$(node -v)"
MAJOR="$(printf '%s' "$NODE_VER" | sed 's/^v//' | cut -d. -f1)"
say "Node $NODE_VER"
[ "$MAJOR" -ge 22 ] || { say "❌ 需要 Node 22 或更高"; exit 1; }

if [ ! -f "$ENVFILE" ]; then
  if [ -f "$ROOT/.env.example" ]; then
    cp "$ROOT/.env.example" "$ENVFILE"
    say "已生成 .env（从 .env.example 复制），请先填 4 项再重跑："
    say "  QQ_BOT_APPID / QQ_BOT_SECRET / AI_API_KEY / LOG_PASSWORD"
  else
    say "❌ 找不到 .env"; 
  fi
  exit 1
fi

say "环境自检…"
node "$ROOT/scripts/check-env.cjs" "$ENVFILE" || { say "❌ 自检没过"; exit 1; }
[ "${1:-}" = "--check" ] && exit 0

mkdir -p "$DATA"
LOGBOT="$DATA/local-bot.log"; LOGPANEL="$DATA/local-panel.log"

say "启动机器人…"
( cd "$SERVER" && nohup node --env-file="$ENVFILE" index.js >"$LOGBOT" 2>&1 & echo $! > "$DATA/local-bot.pid" )
say "启动网页控制台…"
( cd "$SERVER" && nohup node --env-file="$ENVFILE" tools/logweb.js >"$LOGPANEL" 2>&1 & echo $! > "$DATA/local-panel.pid" )

BOT_PID="$(cat "$DATA/local-bot.pid" 2>/dev/null || true)"
PANEL_PID="$(cat "$DATA/local-panel.pid" 2>/dev/null || true)"
printf 'bot=%s\npanel=%s\n' "$BOT_PID" "$PANEL_PID" > "$PIDFILE"

sleep 2
for pair in "bot:$BOT_PID" "panel:$PANEL_PID"; do
  name="${pair%%:*}"; pid="${pair##*:}"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then say "✅ $name PID $pid"; else say "❌ $name 没起来，看日志"; fi
done
say ""
say "控制台： http://127.0.0.1:8080/?p=你的LOG_PASSWORD"
say "日志：   server/data/local-bot.log / local-panel.log"
say "停止：   bash start-local.sh --stop"
