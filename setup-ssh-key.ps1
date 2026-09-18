# ============================================================
#  One-time authorization: install this machine's public key on the server
#  so later SSH/scp runs need no password.
#
#  Run it yourself (PowerShell 5.1 is fine):
#      cd D:\Dsh_Work\MiniProject\QQBot
#      powershell -ExecutionPolicy Bypass -File .\setup-ssh-key.ps1
#
#  What it does:
#    1. Generates an SSH key here if missing (empty passphrase)
#    2. Uploads the public key and installs it (asks server password ONCE)
#    3. Verifies passwordless login
#
#  NOTE: this file is intentionally ASCII-only.
#  PowerShell 5.1 reads BOM-less .ps1 files as ANSI/GBK, which corrupts
#  non-ASCII text and can even break quote pairing -> parse errors.
#  Keeping it ASCII makes it immune.
# ============================================================

param(
  # ASCII placeholder on purpose -- see the NOTE at the top of this file.
  # Pass your own host instead of editing this line:
  #   .\setup-ssh-key.ps1 -Server root@1.2.3.4
  [string]$Server = 'root@<SERVER_IP>'
)

$ErrorActionPreference = 'Stop'
$keyPath   = "$env:USERPROFILE\.ssh\id_ed25519"
$pubPath   = "$keyPath.pub"
$tmpKey    = Join-Path $env:TEMP 'dsh_pubkey.tmp'
$tmpScript = Join-Path $env:TEMP 'dsh_install_key.sh'

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Setup passwordless SSH to $Server"        -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# ---- 1. key ----
if (Test-Path $pubPath) {
  Write-Host ""
  Write-Host "[1/4] Key already exists, skipping generation." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "[1/4] Generating a new SSH key (empty passphrase)..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null

  # IMPORTANT: use cmd /c to pass an empty passphrase.
  # PowerShell cannot pass a truly empty string argument to a native command:
  #   -N ''    -> "Too many arguments" (the empty arg gets dropped)
  #   -N '""'  -> creates a passphrase consisting of two quote characters (worse)
  # Verified by testing: only cmd /c with "" yields a genuinely empty passphrase.
  cmd /c "ssh-keygen -t ed25519 -f `"$keyPath`" -N `"`" -C dsh-qqbot" | Out-Null

  if (-not (Test-Path $pubPath)) { throw 'ssh-keygen failed' }

  # Verify immediately: -y exports the public key; a passphrase would fail it.
  $verify = & ssh-keygen -y -f $keyPath 2>&1
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $keyPath, $pubPath -Force -ErrorAction SilentlyContinue
    throw 'Generated key has a passphrase (would block passwordless login). Deleted it, please re-run.'
  }
  Write-Host "      created: $keyPath" -ForegroundColor Green
}

$pub = (Get-Content $pubPath -Raw).Trim()
Write-Host ("      public key: " + $pub.Substring(0, [Math]::Min(46, $pub.Length)) + '...') -ForegroundColor DarkGray

# ---- 2. staging files ----
Write-Host ""
Write-Host "[2/4] Preparing files..." -ForegroundColor Yellow

# public key, with a trailing newline so authorized_keys does not glue lines
Set-Content -Path $tmpKey -Value $pub -Encoding ascii
Add-Content -Path $tmpKey -Value ''   -Encoding ascii

# remote installer: deliberately minimal shell (no &&, no braces, no redirects)
$lines = @(
  '#!/bin/bash',
  'set -e',
  'umask 077',
  'mkdir -p ~/.ssh',
  'chmod 700 ~/.ssh',
  'touch ~/.ssh/authorized_keys',
  'KEY=$(cat /tmp/dsh_pubkey.tmp)',
  'if grep -qF "$KEY" ~/.ssh/authorized_keys; then',
  '  echo ALREADY_PRESENT',
  'else',
  '  cat /tmp/dsh_pubkey.tmp >> ~/.ssh/authorized_keys',
  '  echo APPENDED',
  'fi',
  'chmod 600 ~/.ssh/authorized_keys',
  'rm -f /tmp/dsh_pubkey.tmp',
  'echo INSTALLED_OK'
)
Set-Content -Path $tmpScript -Value ($lines -join "`n") -Encoding ascii
Write-Host "      staged in $env:TEMP" -ForegroundColor Green

# ---- 3. upload and install (asks password once) ----
Write-Host ""
Write-Host "[3/4] Uploading and installing" -ForegroundColor Yellow
Write-Host "      You will be asked for the server password (input is hidden)." -ForegroundColor DarkGray
Write-Host ""

& scp -o StrictHostKeyChecking=accept-new $tmpKey "${Server}:/tmp/dsh_pubkey.tmp"
if ($LASTEXITCODE -ne 0) { throw 'scp of public key failed (wrong password, or network blocked)' }

& scp -o StrictHostKeyChecking=accept-new $tmpScript "${Server}:/tmp/dsh_install_key.sh"
if ($LASTEXITCODE -ne 0) { throw 'scp of installer failed' }

Write-Host "      running installer..." -ForegroundColor DarkGray
& ssh -o StrictHostKeyChecking=accept-new $Server 'bash /tmp/dsh_install_key.sh'

# ---- 4. verify ----
Write-Host ""
Write-Host "[4/4] Verifying passwordless login..." -ForegroundColor Yellow
$out = & ssh -o BatchMode=yes -o ConnectTimeout=10 $Server 'echo KEYAUTH_OK; hostname'

Remove-Item $tmpKey, $tmpScript -Force -ErrorAction SilentlyContinue

$joined = ($out | Out-String)
if ($joined -match 'KEYAUTH_OK') {
  $hostName = ($out | Where-Object { $_ -ne 'KEYAUTH_OK' }) -join ''
  Write-Host ""
  Write-Host " SUCCESS - passwordless login works" -ForegroundColor Green
  Write-Host " server hostname: $hostName" -ForegroundColor Green
  Write-Host ""
  Write-Host " The AI can now deploy without asking for a password." -ForegroundColor Cyan
} else {
  Write-Host ""
  Write-Host " WARNING - key installed but verification failed" -ForegroundColor Yellow
  Write-Host " output: $joined" -ForegroundColor DarkGray
  Write-Host " Send this output to the AI." -ForegroundColor Yellow
}
