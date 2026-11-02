# Development only: keeps a Cloudflare quick tunnel to the local server (port 3100) and points
# Meta's webhook at it by itself (scripts/sync-webhook-url.ts), so nobody pastes addresses in the
# App Dashboard. A quick tunnel gets a new random address each time it starts; this script
# notices and tells Meta again. Checks every 30 s; three failed checks restart the tunnel.
#
# Runs hidden at sign-in from a shortcut in the Startup folder (no admin rights needed), made
# once from PowerShell:
#   $s = (New-Object -ComObject WScript.Shell).CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Vortomi tunnel.lnk")
#   $s.TargetPath = "powershell.exe"
#   $s.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File <this file>'
#   $s.WindowStyle = 7; $s.Save()
# Log: %LOCALAPPDATA%\vortomi\tunnel.log
$ErrorActionPreference = 'Continue'

$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$backend = Split-Path -Parent $PSScriptRoot
# Its own metrics port, so a tunnel opened by hand (default 20241) does not get in the way.
$metrics = '127.0.0.1:20291'
$logDir = Join-Path $env:LOCALAPPDATA 'vortomi'
$log = Join-Path $logDir 'tunnel.log'
New-Item -ItemType Directory -Force $logDir | Out-Null

function Write-Log([string]$text) {
  Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text" -Encoding utf8
}

function Get-Hostname {
  try { (Invoke-RestMethod -Uri "http://$metrics/quicktunnel" -TimeoutSec 5).hostname } catch { $null }
}

function Test-Up([string]$hostname) {
  try { (Invoke-WebRequest -Uri "https://$hostname/health" -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200 } catch { $false }
}

function Start-Tunnel {
  Write-Log 'tunnel STARTING'
  Start-Process -FilePath $cloudflared -WindowStyle Hidden -PassThru `
    -ArgumentList @('tunnel', '--no-autoupdate', '--metrics', $metrics, '--url', 'http://127.0.0.1:3100') `
    -RedirectStandardError (Join-Path $logDir 'cloudflared.log') -RedirectStandardOutput (Join-Path $logDir 'cloudflared.out.log')
}

$process = $null
$synced = $null
$fails = 0
while ($true) {
  if (-not $process -or $process.HasExited) {
    $process = Start-Tunnel
    $synced = $null
    $fails = 0
    Start-Sleep -Seconds 10
  }
  $hostname = Get-Hostname
  if ($hostname -and $hostname -ne $synced) {
    # Meta checks the new address at once: this only succeeds while the server answers.
    Push-Location $backend
    $out = & npm.cmd run --silent meta:webhook -- --url "https://$hostname" 2>&1
    $ok = $LASTEXITCODE -eq 0
    Pop-Location
    if ($ok) { $synced = $hostname; Write-Log "webhook SYNCED https://$hostname" } else { Write-Log "webhook NOT SYNCED: $out" }
  } elseif ($hostname) {
    if (Test-Up $hostname) { $fails = 0 } else {
      $fails++
      Write-Log "tunnel DOWN check=$fails"
      if ($fails -ge 3) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue; $process = $null }
    }
  }
  Start-Sleep -Seconds 30
}
