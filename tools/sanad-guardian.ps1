# Sanad-Guardian - keeps sanad-bot alive on port 4600 forever.
# Health = real HTTP response from /api/stats (not just "process exists").
# Runs every 2 minutes via schtasks. Singleton via global mutex.
# NOTE: keep this file pure ASCII (PS 5.1 misparses BOM-less UTF-8).
$ErrorActionPreference = 'SilentlyContinue'
# Project root: SANAD_ROOT if set, otherwise the parent of this script's folder.
$root = $env:SANAD_ROOT
if (-not $root) { $root = Split-Path -Parent $PSScriptRoot }
$port = 4600
if ($env:PORT) { $port = [int]$env:PORT }
$logFile = Join-Path $root 'data\guardian.log'
$alertStamp = Join-Path $root 'data\guardian-lastalert.txt'

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line -Encoding utf8
  $lines = Get-Content $logFile
  if ($lines.Count -gt 600) { $lines | Select-Object -Last 500 | Set-Content $logFile -Encoding utf8 }
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/stats" -UseBasicParsing -TimeoutSec 8
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# Telegram alert with 6h dedupe (token/admin from user env; token never logged)
function Send-Alert($text) {
  $token = $env:SANAD_TG_TOKEN
  $admin = $env:SANAD_TG_ADMIN
  if (-not $token -or -not $admin) { return }
  $now = [int][double]::Parse((Get-Date -UFormat %s))
  $last = 0
  if (Test-Path $alertStamp) { $last = [int](Get-Content $alertStamp -TotalCount 1) }
  if (($now - $last) -lt 21600) { return }
  try {
    $body = @{ chat_id = $admin; text = $text } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/sendMessage" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null
    Set-Content $alertStamp $now
  } catch { Log 'alert send failed' }
}

# Singleton: never run two guardians at once
$mutex = New-Object System.Threading.Mutex($false, 'Global\SanadGuardian')
if (-not $mutex.WaitOne(0)) { exit 0 }

try {
  if (Test-Health) { exit 0 }

  Log "health FAILED on port $port - restarting"

  # Kill ONLY the process bound to our port (never blanket-kill node.exe)
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($conns) {
    foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }

  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 25

  if (Test-Health) {
    Log 'recovered OK'
    Send-Alert "Sanad-Guardian: sanad-bot was down and has been auto-restarted successfully."
  } else {
    Log 'restart attempted, still down (will retry next cycle)'
    Send-Alert "Sanad-Guardian: sanad-bot is DOWN and auto-restart did not recover it yet. Will keep retrying."
  }
} finally {
  $mutex.ReleaseMutex() | Out-Null
}
