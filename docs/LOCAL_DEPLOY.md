# 本地版：在你自己的电脑上跑（Windows / macOS / Linux）

> 没有服务器也能用：机器人跑在**你自己的电脑**上，电脑开着它就在线，关机就下线。
> 适合：只给自己一两个群用、不想买服务器。

---

## 0. 需要准备什么

| 需要 | 说明 |
|---|---|
| **Node.js 22 或更高** | <https://nodejs.org> 下载 LTS 安装包，一路下一步。装完在终端跑 `node -v` 应显示 `v22.x` |
| QQ 机器人 | q.qq.com 注册，拿到 **AppID / AppSecret** |
| 模型 API Key | DeepSeek 平台申请，`sk-` 开头 |
| 电脑不关机 | 睡眠/关机 = 机器人下线（可以设置"接通电源时不睡眠"） |

不需要：服务器、域名、公网 IP。

---

## 1. 第一次：填 `.env`

1. 把仓库放到本地任意目录（比如 `D:\qqbot`）；
2. 复制 `.env.example` 为 `.env`；
3. 用记事本打开 `.env`，至少填这 4 项：

```ini
QQ_BOT_APPID=你的AppID
QQ_BOT_SECRET=你的AppSecret
AI_API_KEY=sk-你的key
LOG_PASSWORD=自己定一个至少6位的密码
```

4. 保存。**不要**把 `.env` 上传到任何公开地方。

---

## 2. 启动

### Windows（推荐）

双击 **`start-local.bat`**（或在 PowerShell 里执行 `powershell -ExecutionPolicy Bypass -File start-local.ps1`）。

次选：右键 `start-local.ps1` → 用 PowerShell 运行。

脚本会：
- 检查 Node 版本；
- 跑 `scripts/check-env.cjs` 检查 `.env`；
- 后台启动机器人和网页控制台；
- 把日志写到 `server/data/local-bot.log` / `server/data/local-panel.log`。

### macOS / Linux

```bash
bash start-local.sh
```

### 停止

```powershell
powershell -ExecutionPolicy Bypass -File start-local.ps1 -Stop   # Windows
bash start-local.sh --stop                                       # macOS/Linux
```

---

## 3. 打开控制台

浏览器访问：

```
http://127.0.0.1:8080/?p=你的LOG_PASSWORD
```

能看到概览数字就说明两台都起来了。

> 想从手机访问？同一 Wi-Fi 下用 `http://电脑的局域网IP:8080/?p=密码`，并在系统防火墙放行 8080。
>
> 端口被别的程序占了（报 `EADDRINUSE`）？在 `.env` 里加一行 `PORT=9090`，地址相应改成 `127.0.0.1:9090`。

---

## 4. 绑定主人（可选但建议）

机器人跑起来后：

1. 用要当"主人"的 QQ 号，在群里 @ 机器人说一句话；
2. 在项目目录执行：

```bash
node server/tools/ops/find-openid.cjs
```

3. 把输出的 openid 填进 `.env` 的 `BOT_OWNER_OPENID`，重启（`-Stop` 再启动）。

绑定后才有：@ 它说「关机 / 开机」、私聊记账、面板上显示主人名字。

---

## 5. 本地版和服务器版的差别

| 项 | 本地版 | 服务器版 |
|---|---|---|
| 进程管理 | 脚本起的两个 node 进程 | systemd 两个服务 |
| 开机自启 | 手动（可自己加计划任务） | 自动 |
| 在线时间 | 电脑开着才在线 | 24 小时 |
| 数据位置 | `server/data/` | `/opt/xiaolanjing/data/` |
| 日志 | `server/data/local-*.log` | `journalctl -u xiaolanjing` |

---

## 5.1 本地版不启动的东西（不影响基本使用）

| 东西 | 影响 | 要不要补 |
|---|---|---|
| 名片二维码服务（80 端口） | 「点击打开 QQ 名片」那条链路不可用 | 不需要，属可选功能 |
| 抖音无水印（chrome-headless-shell） | 抖音链接只出卡片、不出视频本体 | 想用就按 README「环境」那节装，或用 `DY_BROWSER` 指向已有浏览器 |
| systemd 自启动 | 电脑重启后要手动再双击一次 | 可在「任务计划程序」里把 start-local.bat 设为登录时运行 |

## 6. 常见问题

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `node -v` 报错或版本低于 22 | 没装 Node / 版本旧 | 去 nodejs.org 装 LTS，装完重开终端 |
| 双击 bat 窗口一闪就没 | `.env` 缺项，自检没过 | 看窗口里的红字，补齐 `.env` |
| 群里 @ 它不回 | 没开「获取群内全部消息」/ 机器人被关机 / 额度用完 | 群主开权限；面板点开机；看日志 `[budget]` |
| 控制台打不开 | 端口被占用或没起 | 看 `server/data/local-panel.log`；换端口 `PORT=9090` |
| 关掉窗口后机器人没了 | 关窗口会结束子进程 | 用脚本启动（它用后台进程），别直接关终端 |
| 电脑睡眠后不回消息 | 系统睡眠 | 电源设置里改为"接通电源时不睡眠" |

---

## 7. 更新到新版本

```bash
git pull
# 停掉 → 重新启动即可（.env 和 data/ 不会被覆盖）
```

---

## 8. 安全提醒（本地版尤其注意）

- 机器人以**你的电脑**为家：`.env` 里的 AppSecret / API Key 不要发给别人；
- 控制台只在 `127.0.0.1` 更安全，别把 8080 直接映射到公网；
- 不需要时用 `-Stop` 停掉，别让它长期裸奔在你日常用的电脑上。
