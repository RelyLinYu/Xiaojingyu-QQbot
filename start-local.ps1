# ============================================================
#  start-local.ps1 —— 在 Windows 本地跑机器人（不装成服务）
#
#  用法：
#    powershell -ExecutionPolicy Bypass -File start-local.ps1
#    powershell -ExecutionPolicy Bypass -File start-local.ps1 -Check   # 只自检
#    powershell -ExecutionPolicy Bypass -File start-local.ps1 -Stop    # 停止
#
#  设计：两个后台进程（机器人 + 网页控制台），PID 存 data/local-pids.json，
#        日志写 data/local-bot.log / data/local-panel.log。
# ============================================================
param(
  [switch]$Stop,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root 'server'
$envFile = Join-Path $root '.env'
$dataDir = Join-Path $server 'data'   # 机器人数据都在 server/data（模块默认 __dirname/data）
$pidFile = Join-Path $dataDir 'local-pids.json'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# ---------- 停止 ----------
if ($Stop) {
  if (-not (Test-Path $pidFile)) { Say '没有在运行的实例（找不到 data/local-pids.json）' 'Yellow'; exit 0 }
  $pids = Get-Content $pidFile -Raw | ConvertFrom-Json
  foreach ($name in @('bot', 'panel')) {
    $p = $pids.$name
    if ($p) {
      try { Stop-Process -Id $p -Force -ErrorAction Stop; Say "已停止 $name (PID $p)" 'Green' }
      catch { Say "$name (PID $p) 已经不在了" 'Yellow' }
    }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

# ---------- Node 版本 ----------
try { $nodeVer = (& node -v).Trim() } catch { Say '❌ 没找到 node，请先装 Node.js 22+： https://nodejs.org' 'Red'; exit 1 }
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
Say "Node $nodeVer"
if ($major -lt 22) { Say '❌ 需要 Node 22 或更高（当前太低），请升级后重试' 'Red'; exit 1 }

# ---------- .env ----------
if (-not (Test-Path $envFile)) {
  if (Test-Path (Join-Path $root '.env.example')) {
    Copy-Item (Join-Path $root '.env.example') $envFile
    Say '已生成 .env（从 .env.example 复制），请先填写这 4 项再重跑：' 'Yellow'
    Say '  QQ_BOT_APPID / QQ_BOT_SECRET / AI_API_KEY / LOG_PASSWORD' 'Yellow'
  } else {
    Say '❌ 找不到 .env，也没有 .env.example' 'Red'
  }
  exit 1
}

# ---------- 环境自检 ----------
Say '环境自检…'
& node (Join-Path $root 'scripts\check-env.cjs') $envFile
if ($LASTEXITCODE -ne 0) { Say '❌ 自检没过，先按上面的提示补齐 .env' 'Red'; exit 1 }
if ($Check) { exit 0 }

# ---------- 启动 ----------
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$logBot   = Join-Path $dataDir 'local-bot.log'
$logPanel = Join-Path $dataDir 'local-panel.log'
# ⚠️ PS 5.1 的 Start-Process 不允许 stdout/stderr 指向同一个文件 ⇒ 分开写
$errBot   = Join-Path $dataDir 'local-bot.err.log'
$errPanel = Join-Path $dataDir 'local-panel.err.log'

Say '启动机器人…'
$bot = Start-Process -FilePath 'node' `
  -ArgumentList @("--env-file=$envFile", 'index.js') `
  -WorkingDirectory $server `
  -RedirectStandardOutput $logBot -RedirectStandardError $errBot `
  -WindowStyle Hidden -PassThru

Say '启动网页控制台…'
$panel = Start-Process -FilePath 'node' `
  -ArgumentList @("--env-file=$envFile", 'tools/logweb.js') `
  -WorkingDirectory $server `
  -RedirectStandardOutput $logPanel -RedirectStandardError $errPanel `
  -WindowStyle Hidden -PassThru

@{ bot = $bot.Id; panel = $panel.Id } | ConvertTo-Json | Set-Content $pidFile -Encoding utf8

Start-Sleep -Seconds 2
$botOk   = (Get-Process -Id $bot.Id -ErrorAction SilentlyContinue) -ne $null
$panelOk = (Get-Process -Id $panel.Id -ErrorAction SilentlyContinue) -ne $null

Say ''
Say "机器人    PID $($bot.Id)   $([bool]$botOk)" $(if ($botOk) { 'Green' } else { 'Red' })
Say "控制台    PID $($panel.Id) $([bool]$panelOk)" $(if ($panelOk) { 'Green' } else { 'Red' })
Say ''
Say '控制台地址： http://127.0.0.1:8080/?p=你的LOG_PASSWORD' 'Cyan'
Say '日志：      server/data/local-bot.log / local-panel.log' 'Cyan'
Say '停止：      powershell -ExecutionPolicy Bypass -File start-local.ps1 -Stop' 'Cyan'

if (-not $botOk -or -not $panelOk) {
  Say ''
  Say '有进程没起来，看日志最后 20 行：' 'Red'
  foreach ($f in @($logBot, $errBot, $logPanel, $errPanel)) {
    if (Test-Path $f) { Say "--- $f ---" 'Yellow'; Get-Content $f -Tail 20 }
  }
  exit 1
}
