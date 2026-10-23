# AGENT.md —— 给 AI agent 的部署说明书

> **如果你是 AI agent，请先读完这一页，再动手。**
> 这个仓库是一个 QQ 群聊机器人（Node.js，零 npm 依赖）。你要做的是：**先向用户收集下面 4 类信息，缺一项就停下来问，绝对不要自己编造。**
> 用户不需要懂技术；你问的时候要一句话说清"这个东西在哪拿"。

---

## 0. 一句话流程

```
读本文件 → 问用户要 4 类信息（缺就停） → 判断有服务器还是本地
  ├─ 有服务器：bash deploy.sh（Linux / systemd）
  └─ 没有服务器：Windows/macOS 本地跑 → 读 docs/LOCAL_DEPLOY.md
→ 跑 scripts/check-env.cjs 自检 → 启动 → 按第 6 节验证 → 把"怎么用"教给用户
```

---

## 1. 必须先问用户拿到的信息（缺一项就停下问）

| # | 变量 | 是什么 | 从哪拿 | 缺失后果 |
|---|---|---|---|---|
| 1 | `QQ_BOT_APPID` | QQ 机器人 AppID（纯数字） | 手机/电脑打开 <https://q.qq.com> → 你的机器人 → 开发设置 | 机器人连不上 QQ |
| 2 | `QQ_BOT_SECRET` | AppSecret（一串字符） | 同上，「开发设置」里点「重置」才看得到明文 | 拿不到 token，启动即失败 |
| 3 | `AI_API_KEY` | 大模型 API Key（DeepSeek，`sk-` 开头） | <https://platform.deepseek.com> → API keys | 机器人不会说话 |
| 4 | `LOG_PASSWORD` | 网页控制台密码（自己定，≥6 位） | 让用户随便想一个，或你生成后告诉用户 | 控制台拒绝启动 |

可选（有就更好）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BOT_OWNER_OPENID` | 空 | **主人的 openid，不是 QQ 号**。拿法见第 4 节；先空着也能跑，但要提醒用户 |
| `BOT_OWNER_NAME` | 空 | 主人昵称，只用于显示 |
| `BUDGET_DAILY_YUAN` | `3` | 每天最多花多少钱 |
| `BUDGET_TOTAL_YUAN` | `50` | 累计最多花多少钱 |
| `AI_REPLY_MODEL` | `deepseek-flash` | 换成 `deepseek-v4-pro` 更贵更聪明 |

如果用户有服务器，再要：**服务器 IP、SSH 用户名、SSH 密码或密钥**（以及是否已装 Node 22）。

> 🔴 **红线**：AppSecret 和 API Key 等同于"机器人身份"和"钱包"，只能写进服务器上的 `.env`，**不要写进聊天记录、不要提交进 Git、不要贴进 README**。

---

## 2. 必须由**用户本人**做的事（agent 做不了）

务必提前告诉用户，否则部署完也用不了：

1. **注册机器人 / 实名认证**：q.qq.com 注册，需要手机号 + 实名。
2. **把机器人拉进群**：在 QQ 群里添加机器人；或在 QQ 开放平台配置沙箱群。
3. 🔴 **群主在手机 QQ 里开启「获取群内全部消息」**（群设置 → 机器人 → 该机器人）。
   - 不开的话：**不 @ 它就不响应**，链接解析/自动配图/梗采集这些"无需 @"的功能全部失效，而且**不会报错**——最难排查的一种。
4. **（可选）发布机器人**：只给自己群用，用沙箱环境即可，不用上架。

---

## 3. 有服务器：标准部署

要求：Linux（Ubuntu 20.04+ / Debian 11+ / 同类）、root 或 sudo、能出网。

```bash
git clone <仓库地址> qqbot && cd qqbot
sudo bash deploy.sh
```

`deploy.sh` 会做：

1. 检查/安装 Node 22+（用官方二进制包，不依赖发行版）；
2. 建数据目录、整目录拷贝 `server/` 到 `/opt/xiaolanjing`；
3. **逐文件自检**（每个 `require('./x')` 必须能解析，少一个就中止）；
4. 交互式生成 `.env`（权限 600）；
5. 装两个 systemd 服务并开机自启：`xiaolanjing`（机器人）、`xiaolanjing-logweb`（控制台 :8080）。

装完检查：

```bash
systemctl is-active xiaolanjing xiaolanjing-logweb
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/   # 期望 200
```

> 其他目录/端口：`APP_DIR=/opt/xxx LOG_PORT=9090 sudo -E bash deploy.sh`

---

## 4. 主人 openid 怎么拿（**不是 QQ 号**）

openid 由"机器人应用 + 用户"共同决定，**必须机器人跑起来、收到过这个人的消息之后**才能拿到。步骤：

1. 先按第 3 节（或第 5 节本地版）把机器人跑起来；
2. 主人用要当"主人"的那个 QQ 号，在群里 @ 机器人说一句话（或私聊发一句）；
3. 在服务器项目目录执行：

```bash
cd /opt/xiaolanjing
node tools/ops/find-openid.cjs
```

它会从 `data/events-*.jsonl` 里列出最近发过消息的人（昵称 + openid + 群号）；
4. 把主人的 openid 填进 `.env` 的 `BOT_OWNER_OPENID`，再重启机器人：

```bash
sudo systemctl restart xiaolanjing
```

> 拿不到时的兜底：`grep -o '"member_openid":"[^"]*"' data/events-*.jsonl | sort -u | tail`。

---

## 5. 没有服务器：本地版

读 **[docs/LOCAL_DEPLOY.md](docs/LOCAL_DEPLOY.md)**。要点：

- Windows 双击 `start-local.ps1`（PowerShell）或 `start-local.bat`；
- macOS / Linux：`bash start-local.sh`；
- 电脑要开机、联网、QQ 机器人在线；关机 = 机器人下线；
- 网页控制台在 `http://127.0.0.1:8080/?p=你的密码`。

---

## 6. 部署完怎么验证（agent 必须逐条做）

| # | 检查 | 期望 |
|---|---|---|
| 1 | `node scripts/check-env.cjs .env` | 全部 ✅（缺项会红并告诉你缺什么） |
| 2 | 机器人进程活着 | `systemctl is-active xiaolanjing` = `active`，或本地窗口里一直有日志 |
| 3 | 群里 @ 机器人说「你好」 | 10 秒内回一句话 |
| 4 | 面板打开 | `http://IP:8080/?p=密码` 能进，概览有数字 |
| 5 | 主人绑定 | 用主人号 @ 它说「关机」→ 它回"已关机"；再说「开机」→ 恢复 |
| 6 | 日志无红 | `journalctl -u xiaolanjing -n 50` 无 `Error / Cannot find module / 401` |

> 第 3 条不回时，先看第 2 步的日志；最常见原因是 **AppSecret 错** 或 **没开「获取群内全部消息」**（见第 2 节）。

---

## 7. 常见故障对照表

| 现象 | 最可能的原因 | 怎么修 |
|---|---|---|
| 启动即退，日志 `401 / invalid appid` | AppID/Secret 错，或 Secret 被重置过 | 去 q.qq.com 重新拿 Secret |
| 群里有消息、它完全不回 | ① 没开「获取群内全部消息」；② 机器人被关（面板全局关机）；③ 额度用完 | 逐条查：群主开权限 / 面板点「开机」 / 看 `journalctl` 里 `[budget]` |
| 私聊能回、群里不回 | 同上，或机器人不在该群 | 把机器人拉进群 |
| 控制台打不开 | 端口没放行 / 进程没起 / 密码错 | 云厂商安全组放行 8080；`systemctl status xiaolanjing-logweb` |
| 报 `Cannot find module './xxx'` | 部署时文件没拷全 | 重新跑 `bash deploy.sh`（自带对账，会中止并指出缺文件） |
| 说话很贵 / 一天就超额度 | 模型选错 / 思考常开 | 面板设置里选 `deepseek-flash`；`AI_EFFORT=off` |

---

## 8. 装完要教用户的三件事

1. 网页控制台地址 + 密码（`http://IP:8080/?p=密码`）；
2. 群里怎么用：@ 它聊天、发链接自动解析、`#cd` 看功能菜单、`#tg` 投稿图片；
3. 主人专属：@ 它说「关机 / 开机」；面板里能改人设、额度、概率。

---

## 9. 给 agent 的硬性纪律

- **不要编造任何密钥/ID**；缺就让用户去拿，并给出上面表格里的链接。
- **不要**把 `.env` 内容回显到聊天、日志或 Git 提交里。
- 部署前先 `git status`，部署后按第 6 节逐条验证；**没验证就不能说"已完成"**。
- 用户只给了一个群/一个人时，不要擅自发布机器人、不要改仓库可见性。
- 遇到"不 @ 就不回"：先查「获取群内全部消息」，这是本项目的头号坑。
