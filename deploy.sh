#!/usr/bin/env bash
# ============================================================
#  小蓝鲸 QQ 机器人 —— 一键部署脚本
#
#  在服务器上跑（不是你的电脑）：
#     sudo bash deploy.sh
#
#  它会做：
#    1. 检查 / 安装 Node 22+（没有就用官方二进制包，不分发行版）
#    2. 建 $APP_DIR/data
#    3. 把 ./server 下的代码**整目录**复制过去（不再手写文件白名单，见下）
#    4. 传完立刻跑一次**部署自检**：每个 require('./x') 的目标文件都在吗、每个文件能解析吗
#    5. 交互式生成 .env（凭证不落盘到代码里，权限 600）
#    6. 生成两个 systemd 服务（机器人 + 网页控制台）并开机自启
#
#  🔴 为什么第 3 步是"整目录拷"而不是列名单（2026-10-08 改，用户原话
#     「sh 坏的不能重写一个吗，拷贝所有文件」）：
#     原来这里写着一串文件名，靠人记得同步。结果：
#       · 早期只列 6 个 → 漏掉 budget.js → brain.js 里 require('./budget')
#         → `Cannot find module './budget'`，全新部署直接崩；
#       · 后来补到 7 个，**仍然漏着 12 个模块**（vision / linkparse / power / memory /
#         emotion / gif / qqmedia / sendqueue / settings / examples / presets / usage）——
#         也就是说"照 README 跑 deploy.sh"从来就不可能成功过。
#     ⇒ 人的记性靠不住，所以：**整目录拷**，拷完用 `tools/ops/verify-deploy.cjs`
#       **机器对账**（把每个 require 解析一遍）。少一个文件它会红，并且中止部署。
#
#  ⚠️ 可以用环境变量覆盖路径（便于在别的目录试跑）：
#       APP_DIR=/opt/xxx  LOG_PORT=9090  sudo -E bash deploy.sh
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/xiaolanjing}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/server"
LOG_PORT="${LOG_PORT:-8080}"
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
echo "[0/7] 环境探测…"
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "  系统: ${PRETTY_NAME:-未知}"
else
  echo "  系统: 未知（没有 /etc/os-release）"
fi
echo "  架构: $(uname -m)"
echo "  时区: $(date '+%Z %z')"
echo "  装到: $APP_DIR"

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
echo "[1/7] 检查 Node…"
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
echo "[2/7] 建目录 $APP_DIR"
mkdir -p "$APP_DIR/data"

# ---------- 3. 代码 ----------
echo ""
echo "[3/7] 复制代码（整目录，不列名单）…"
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

# 🔴 先确认源目录**看起来是完整的**（不然"拷了 3 个文件"也会被当成成功）
js_count="$(find "$SRC_DIR" -maxdepth 1 -name '*.js' -type f | wc -l | tr -d ' ')"
if [ "$js_count" -lt 10 ] || [ ! -f "$SRC_DIR/index.js" ]; then
  echo "❌ $SRC_DIR 里只有 $js_count 个 .js 文件，看着不完整（至少要 10 个，且必须有 index.js）"
  echo "   多半是仓库没下全，或者你只上传了其中几个文件。"
  ls -la "$SRC_DIR" 2>/dev/null | head -30 || true
  exit 1
fi

# ⭐ 整目录拷：server/ 下所有 .js 一把拷过去，**不维护任何名单**
cp -f "$SRC_DIR"/*.js "$APP_DIR/"
echo "  ✅ $js_count 个 .js 已就位"

# tools/ 也要一起（logweb.js = 网页控制台本体，page.js/convo.js/ogcache.js 是它的依赖，
# ops/ 下是运维脚本）—— 覆盖式**合并**，不先 rm：别把别人留在那儿的 page.js.bak-* 删掉
#
# 🔴 2026-10-09 修：这里原来写的是  cp -rf "$SRC_DIR/tools" "$APP_DIR/tools"
#    当 $APP_DIR/tools **已经存在**（也就是"第二次以后的任何一次部署"）时，
#    cp 的语义是"把源目录整个搬进目标目录里面"⇒ 结果变成 $APP_DIR/tools/tools/，
#    而真正的 tools/*.js **一个都没被覆盖**（旧的 page.js 原地不动，修复根本没生效）；
#    那份嵌套副本里的 require('../settings') 又全都解析不到 ⇒
#    部署自检会报 10 个 require 找不到文件并**中止部署**。
#    ⇒ 正确写法是源路径末尾带 /.：拷的是"目录里的内容"，合并进已存在的目标目录。
if [ -d "$SRC_DIR/tools" ]; then
  mkdir -p "$APP_DIR/tools"
  cp -rf "$SRC_DIR/tools/." "$APP_DIR/tools/"
  echo "  ✅ tools/ 已就位（$(find "$SRC_DIR/tools" -name '*.js' -o -name '*.cjs' | wc -l | tr -d ' ') 个脚本）"
else
  echo "❌ 缺少 tools/ 目录 —— 网页控制台会起不来"
  exit 1
fi

# 🔴 部署自检闸门：把每个 require('./x') 解析一遍。
#    这就是"整目录拷"之外的第二道保险 —— 万一哪天源码里 require 了仓库里没有的东西，
#    也会在这里被拦下来，而不是等 systemd 反复重启、日志刷 Cannot find module。
echo ""
echo "  —— 部署自检（模块是否齐全 + 语法能否解析）——"
if ! "$NODE_BIN" "$APP_DIR/tools/ops/verify-deploy.cjs" "$APP_DIR"; then
  echo ""
  echo "❌ 部署自检没过，**已中止**（别启动，否则就是 systemd 每 5 秒重启一次刷屏）"
  echo "   先把上面列出的缺文件补齐再重跑本脚本。"
  exit 1
fi

# ---------- 4. 凭证 ----------
echo ""
echo "[4/7] 配置凭证（只会写进 $APP_DIR/.env，权限 600）"
if [ -f "$APP_DIR/.env" ]; then
  echo "  ⚠️  .env 已存在，保留原有配置不覆盖"
  echo "      想改就编辑： sudo nano $APP_DIR/.env"
  echo "      ⚠️ 别用 nano 粘贴！从 Windows 粘会塞进 \\r（见项目文档「CRLF 污染 .env」）"
else
  read -rp "  QQ 机器人 AppID          : " in_appid
  read -rp "  QQ 机器人 AppSecret      : " in_secret
  read -rp "  DeepSeek API Key         : " in_aikey
  read -rp "  主人 openid（可留空，稍后补）: " in_owner
  read -rp "  日志网页密码（手机看用） : " in_logpw
  read -rp "  AI 模型 [deepseek-flash] : " in_model
  in_model="${in_model:-deepseek-flash}"

  # ⚠️ 这里必须和线上实际在用的服务商一致（项目只用 DeepSeek）。
  #    ⚠️ 换服务商时**连默认值一起改**（config.js 的 ai.baseUrl / 模型名），
  #       别只改这里 —— 默认值不一致会在 .env 丢失时静默打到错的服务商。
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
BUDGET_TOTAL_YUAN=30
EOF
  chmod 600 "$APP_DIR/.env"
  echo "  ✅ 已写入并设为 600（只有 root 能读）"
fi
chown -R root:root "$APP_DIR"

# 面板要用的密码：从 .env 里读出来（已存在时不会再问一遍）
LOG_PW_VAL="$(grep -E '^LOG_PASSWORD=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"

# ---------- 5. systemd ----------
echo ""
echo "[5/7] 生成 systemd 服务…"
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
echo "  ✅ xiaolanjing.service（机器人本体）"

# 网页控制台是**第二个服务**：它有独立端口，和机器人进程互不影响 ——
# 机器人崩了面板还能看日志，这是排查时最关键的一点。
if [ -n "$LOG_PW_VAL" ]; then
  cat > /etc/systemd/system/xiaolanjing-logweb.service <<EOF
[Unit]
Description=QQ Bot Log Web Viewer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=PORT=${LOG_PORT}
Environment=APP_DIR=${APP_DIR}
Environment=SERVICE_NAME=xiaolanjing
ExecStart=${NODE_BIN} ${APP_DIR}/tools/logweb.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  echo "  ✅ xiaolanjing-logweb.service（网页控制台，端口 ${LOG_PORT}）"
else
  echo "  ⚠️ .env 里 LOG_PASSWORD 是空的 → **不装**网页控制台服务"
  echo "      （它没密码会拒绝启动，装了就是每 5 秒重启一次的刷屏）"
  echo "      想用面板：往 .env 加一行 LOG_PASSWORD=你的密码，然后重跑本脚本"
fi

systemctl daemon-reload
systemctl enable xiaolanjing >/dev/null 2>&1
[ -n "$LOG_PW_VAL" ] && systemctl enable xiaolanjing-logweb >/dev/null 2>&1 || true
echo "  ✅ 已设置开机自启"

# ---------- 6. 启动 ----------
echo ""
echo "[6/7] 启动…"
systemctl restart xiaolanjing
[ -n "$LOG_PW_VAL" ] && systemctl restart xiaolanjing-logweb || true
sleep 3
systemctl status xiaolanjing --no-pager -l | head -12 || true

# ---------- 7. 收尾 ----------
echo ""
echo "[7/7] 交付边界：确认「机器人在跑」和「面板出得来」"
FAILED=0
if systemctl is-active --quiet xiaolanjing; then
  echo "  ✅ 机器人服务 active"
else
  echo "  ❌ 机器人服务没起来 → journalctl -u xiaolanjing -n 50 --no-pager"
  FAILED=1
fi
if [ -n "$LOG_PW_VAL" ]; then
  if systemctl is-active --quiet xiaolanjing-logweb; then
    echo "  ✅ 面板服务 active"
  else
    echo "  ❌ 面板服务没起来 → journalctl -u xiaolanjing-logweb -n 50 --no-pager"
    FAILED=1
  fi
fi
# ⚠️ 别只信 systemctl —— 进程活着不等于连上了 QQ 网关
if journalctl -u xiaolanjing --since "2 min ago" --no-pager 2>/dev/null | grep -q '鉴权成功'; then
  echo "  ✅ 日志里已经出现「[ws] 鉴权成功」——机器人真的连上 QQ 了"
else
  echo "  ⚠️ 还没看到「[ws] 鉴权成功」（刚启动可能要等几秒）"
  echo "     查： journalctl -u xiaolanjing -n 30 --no-pager"
fi

cat <<TIP

==========================================
 部署完成。剩下**两件事只能你本人做**（脚本代替不了）：

 ① 【群主】手机 QQ → 群设置 → 机器人 → 打开「获取群内全部消息」
    不开的话：机器人**只能看到 @ 它的消息** —— 链接解析 / 识图 / B站卡片
    这些"不用 @ 也能干活"的功能**全部失效**，而且不会报错。
    ⚠️ 只有群主能改这一项。

 ② 把自己设成"主人"（不设的话「只服从主人」是**静默失效**的）
    a. 先在群里发一句话
    b. sudo node ${APP_DIR}/tools/ops/find-openid.cjs
       → 输出里找到你自己那行，复制那串 32 位 ID
    c. printf 'BOT_OWNER_OPENID=你的ID\nBOT_OWNER_NAME=你的昵称\n' | sudo tee -a ${APP_DIR}/.env
       ⚠️ 别用 nano 粘贴（会塞进 \\r）
       ⚠️ 不能填 QQ 号！QQ 只给 openid，不给 QQ 号
    d. sudo systemctl restart xiaolanjing

 常用命令：
   看实时日志： journalctl -u xiaolanjing -f
   重启：       sudo systemctl restart xiaolanjing
   跑自测：     cd ${APP_DIR} && node test-brain.js
   部署自检：   node ${APP_DIR}/tools/ops/verify-deploy.cjs ${APP_DIR}
$( [ -n "$LOG_PW_VAL" ] && echo "
 网页控制台： http://<你的服务器IP>:${LOG_PORT}/?p=<你设的密码>
   ⚠️ 记得去云控制台把 ${LOG_PORT} 端口**入方向放行**（机器人本体不需要任何入站端口）
   ⚠️ 别把域名解析到这台机器开网站 —— 那才要备案" )
==========================================
TIP

exit "$FAILED"
