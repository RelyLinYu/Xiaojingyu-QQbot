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

# 读 .env 里的 PORT（没有就 8080）
function Get-LocalPort() {
  try {
    $line = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -Last 1
    if ($line) { $v = ($line -split '=', 2)[1].Trim(); if ($v -match '^\d+$') { return [int]$v } }
  } catch { }
  return 8080
}

# 谁占着端口？（Get-NetTCPConnection 优先，netstat 兜底）
function Get-ProcCmdLine([int]$procId) {
  try { return (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $procId)).CommandLine } catch { return '' }
}

# 只认"我们的"进程：命令行里带 logweb.js（防止误杀占着 8080 的别的 node 服务）
function Test-OurPanel($proc) {
  if (-not $proc) { return $false }
  if ($proc.ProcessName -ne 'node') { return $false }
  return ((Get-ProcCmdLine $proc.Id) -match 'logweb.js')
}

function Get-PortOwner([int]$port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c) { return (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue) }
  } catch { }
  try {
    $line = (netstat -ano | Select-String (':' + $port + 's') | Select-Object -First 1)
    if ($line) {
      $pidStr = (($line.ToString().Trim()) -split 's+')[-1]
      if ($pidStr -match '^d+$') { return (Get-Process -Id ([int]$pidStr) -ErrorAction SilentlyContinue) }
    }
  } catch { }
  return $null
}

# ---------- 停止 ----------
if ($Stop) {
  $pids = $null
  if (Test-Path $pidFile) { $pids = Get-Content $pidFile -Raw | ConvertFrom-Json }
  else { Say '没有 pid 文件，仍尝试按端口清理我们自己的面板进程…' 'Yellow' }
  foreach ($name in @('bot', 'panel')) {
    $p = if ($pids) { $pids.$name } else { $null }
    if ($p) {
      try { Stop-Process -Id $p -Force -ErrorAction Stop; Say "已停止 $name (PID $p)" 'Green' }
      catch { Say "$name (PID $p) 已经不在了" 'Yellow' }
    }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  # 🆕 2026-10-24：pid 文件之外的孤儿（重复启动会覆盖 pid 文件）也收掉 —— 只杀占着端口的 node
  $port = Get-LocalPort
  $owner = Get-PortOwner $port
  if ((Test-OurPanel $owner)) {
    try { Stop-Process -Id $owner.Id -Force -ErrorAction Stop; Say ("已停止占用 " + $port + " 端口的 node (PID " + $owner.Id + ")") 'Green' } catch { }
  }
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
# 🆕 2026-10-24：先查端口。被占就**一个进程都不拉**（避免"机器人起来了、面板崩了"的半残状态）
$port = Get-LocalPort
$owner = Get-PortOwner $port
if ($owner) {
  $ours = Test-OurPanel $owner
  Say ("❌ 端口 " + $port + " 被占用：PID " + $owner.Id + "（" + $owner.ProcessName + "）") 'Red'
  if ($ours) {
    Say "   这看起来是本项目上一次启动的面板（孤儿进程）。先跑：" 'Yellow'
    Say "   powershell -ExecutionPolicy Bypass -File start-local.ps1 -Stop" 'Yellow'
  } else {
    Say "   它**不是**本项目的进程，别乱杀。换端口更稳：在 .env 里加一行 PORT=9090" 'Yellow'
  }
  Say ("   或直接结束它（确认无害后）：Stop-Process -Id " + $owner.Id + " -Force") 'Yellow'
  exit 1
}
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
    if (Test-Path $f) { Say "--- $f ---" 'Yellow'; Get-Content $f -Tail 20 -Encoding UTF8 }
  }
  exit 1
}
