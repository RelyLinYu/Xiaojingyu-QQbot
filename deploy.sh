#!/usr/bin/env bash
# ============================================================
#  小蓝鲸 QQ 机器人 —— Ubuntu 一键部署脚本
#
#  在服务器上跑（不是你的电脑）：
#     sudo bash deploy.sh
#
#  它会做：
#    1. 检查 / 安装 Node 22+（没有就用官方二进制包，国内快）
#    2. 建 /opt/xiaolanjing/data
#    3. 把你的代码从 ./server 复制过去
#    4. 交互式生成 .env（凭证不落盘到代码里，权限 600）
#    5. 生成 systemd 服务并开机自启
# ============================================================
set -euo pipefail

APP_DIR=/opt/xiaolanjing
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/server"
# NODE_BIN 在第 1 步里用 command -v 自动探测后赋值（不要在这里写死路径）

echo "=========================================="
echo " 小蓝鲸部署脚本"
echo "=========================================="

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ 请用 sudo 运行： sudo bash deploy.sh"
  exit 1
fi

# ---------- 0. 环境探测 ----------
echo ""
echo "[0/6] 环境探测…"
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "  系统: ${PRETTY_NAME:-未知}"
else
  echo "  系统: 未知（没有 /etc/os-release）"
fi
echo "  架构: $(uname -m)"
echo "  时区: $(date '+%Z %z')"

# ⚠️ 时区很关键：代码内部按北京时间算静默时段，
#    但服务器若是 UTC，日志时间和"跨天重置"都会差 8 小时。这里兜一层。
if command -v timedatectl >/dev/null 2>&1; then
  # 认 CST 或 +0800 两种表示法，别只认一个字符串
  if date '+%Z %z' | grep -Eq 'CST|\+0800'; then
    echo "  ✅ 时区已经是国内时间 ($(date '+%Z %z'))"
  else
    echo "  时区是 $(date '+%Z %z')，尝试设为 Asia/Shanghai…"
    timedatectl set-timezone Asia/Shanghai 2>/dev/null \
      && echo "  ✅ 时区已设为 $(date '+%Z %z')" \
      || echo "  ⚠️ 设置失败，systemd 里会用 TZ=Asia/Shanghai 兜底"
  fi
else
  echo "  ⚠️ 没有 timedatectl，交给 systemd 的 TZ=Asia/Shanghai 兜底"
fi

# ---------- 1. Node ----------
echo ""
echo "[1/6] 检查 Node…"
need_install=0
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$major" -ge 22 ]; then
    echo "  ✅ 已有 Node $(node -v)"
  else
    echo "  ⚠️  Node $(node -v) 太低（内置 WebSocket 需要 22+）"
    need_install=1
  fi
else
  echo "  ⚠️  没有 Node"
  need_install=1
fi

if [ "$need_install" -eq 1 ]; then
  NODE_VER=v22.14.0
  # ⭐ 用官方二进制：不分发行版，Ubuntu / Alibaba Cloud Linux / CentOS 都能用
  #    不依赖 apt / yum / dnf 源，也不受 NodeSource 是否认这个系统影响
  echo "  下载 Node $NODE_VER（官方二进制，不走系统包管理器）…"
  cd /tmp
  curl -fsSL -o node.tar.xz "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz"
  tar -xJf node.tar.xz -C /usr/local --strip-components=1
  rm -f node.tar.xz
  hash -r 2>/dev/null || true
  echo "  ✅ 装好 $(node -v)"
fi

# ⭐ 关键：查 Node 的【真实路径】再写进 systemd
#    写死 /usr/local/bin/node 是错的 —— apt 装在 /usr/bin/node 时会报 203/EXEC 起不来
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ 找不到 node 可执行文件，安装可能失败了"
  exit 1
fi
echo "  ✅ Node 路径: $NODE_BIN ($(node -v))"

# ---------- 2. 目录 ----------
echo ""
echo "[2/6] 建目录 $APP_DIR"
mkdir -p "$APP_DIR/data"

# ---------- 3. 代码 ----------
echo ""
echo "[3/6] 复制代码…"
if [ ! -d "$SRC_DIR" ]; then
  # ⭐ 找不到就给两个可能的上传位置，别只丢一句报错
  echo "❌ 找不到代码目录：$SRC_DIR"
  echo ""
  echo "   期望的结构是： <你上传的目录>/deploy.sh"
  echo "                  <你上传的目录>/server/*.js"
  echo ""
  echo "   如果你上传到了 ~/xiaolanjing-upload，这样跑："
  echo "     sudo bash /root/xiaolanjing-upload/deploy.sh"
  echo ""
  echo "   先看看上传目录里到底有什么："
  ls -la "$(dirname "$SRC_DIR")" 2>/dev/null || true
  exit 1
fi
# ⚠️ 这个列表必须覆盖 server/ 下所有被 require 到的文件。
#    踩过的坑：早期只列了 6 个，**漏掉 budget.js** —— 而 brain.js 里有
#    `require('./budget')`，于是全新部署一启动就崩（Cannot find module './budget'）。
#    改动 brain.js 的依赖时，记得同步这个列表。
for f in config.js auth.js gateway.js brain.js qqapi.js index.js budget.js; do
  if [ ! -f "$SRC_DIR/$f" ]; then
    echo "❌ 缺少文件：$SRC_DIR/$f（上传不完整）"
    exit 1
  fi
  cp -f "$SRC_DIR/$f" "$APP_DIR/$f"
done
echo "  ✅ 7 个核心文件已就位"

# 自测脚本与工具目录也要一起传：
#   · test-brain.js —— README 里"改完必跑"的那 153 项
#   · tools/        —— logweb.js（日志网页）+ ops/（凭证轮换、体检）
if [ -f "$SRC_DIR/test-brain.js" ]; then
  cp -f "$SRC_DIR/test-brain.js" "$APP_DIR/test-brain.js"
fi
if [ -d "$SRC_DIR/tools" ]; then
  rm -rf "$APP_DIR/tools"
  cp -r "$SRC_DIR/tools" "$APP_DIR/tools"
fi
echo "  ✅ test-brain.js + tools/ 已就位"

# ---------- 4. 凭证 ----------
echo ""
echo "[4/6] 配置凭证（只会写进 $APP_DIR/.env，权限 600）"
if [ -f "$APP_DIR/.env" ]; then
  echo "  ⚠️  .env 已存在，保留原有配置不覆盖"
  echo "      想改就编辑： sudo nano $APP_DIR/.env"
else
  read -rp "  QQ 机器人 AppID          : " in_appid
  read -rp "  QQ 机器人 AppSecret      : " in_secret
  read -rp "  DeepSeek API Key         : " in_aikey
  read -rp "  主人 openid（可留空）    : " in_owner
  read -rp "  日志网页密码（手机看用） : " in_logpw
  read -rp "  AI 模型 [deepseek-flash] : " in_model
  in_model="${in_model:-deepseek-flash}"

  # ⚠️ 这里必须和线上实际在用的服务商一致。
  #    早期模板写的是智谱（open.bigmodel.cn / glm-4.7-flash），
  #    而项目早已切到 DeepSeek —— 照着旧模板填会配出一个跑不起来的机器人。
  cat > "$APP_DIR/.env" <<EOF
QQ_BOT_APPID=${in_appid}
QQ_BOT_SECRET=${in_secret}
BOT_OWNER_OPENID=${in_owner}
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=${in_aikey}
AI_REPLY_MODEL=${in_model}
AI_JUDGE_MODEL=${in_model}
LOG_PASSWORD=${in_logpw}
BUDGET_DAILY_YUAN=3
BUDGET_TOTAL_YUAN=10
EOF
  chmod 600 "$APP_DIR/.env"
  echo "  ✅ 已写入并设为 600（只有 root 能读）"
fi
chown -R root:root "$APP_DIR"

# ---------- 5. systemd ----------
echo ""
echo "[5/6] 生成 systemd 服务…"
cat > /etc/systemd/system/xiaolanjing.service <<EOF
[Unit]
Description=QQ Bot XiaoLanJing
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${NODE_BIN} ${APP_DIR}/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
# 时区兜底：代码内部已按北京时间算，这里再兜一层
Environment=TZ=Asia/Shanghai

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable xiaolanjing >/dev/null 2>&1
echo "  ✅ 已设置开机自启"

# ---------- 6. 启动 ----------
echo ""
echo "[6/6] 启动…"
systemctl restart xiaolanjing
sleep 3
systemctl status xiaolanjing --no-pager -l | head -20 || true

cat <<'TIP'

==========================================
 部署完成！看到下面这行就成功了：
   [ws] 鉴权成功: 小蓝鲸

 看实时日志： journalctl -u xiaolanjing -f
 重启：       sudo systemctl restart xiaolanjing
 停止：       sudo systemctl stop xiaolanjing

 下一步：去群里 @ 它 或 直接说一句话，看日志有没有 [群] 输出。
==========================================
TIP
