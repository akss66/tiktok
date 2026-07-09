param(
    [switch]$StartDesktop
)

$root = Split-Path -Parent (Resolve-Path $PSScriptRoot)
$bridgeCmd = Join-Path $root "bridge-server.cmd"
$desktopDir = Join-Path $root "desktop"
$originalElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = ""

Write-Host "Starting bridge server..."
$backend = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$bridgeCmd`"" -WorkingDirectory $root -PassThru

function Invoke-HealthCheck {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:19522/api/health" -TimeoutSec 2
    return $resp.StatusCode -eq 200
  } catch {
    return $false
  }
}

$deadline = (Get-Date).AddSeconds(60)
while (-not (Invoke-HealthCheck)) {
  if (Get-Date -gt $deadline) {
    Write-Error "Backend startup timeout (60s). Check logs and retry."
    Stop-Process -Id $backend.Id -ErrorAction SilentlyContinue
    exit 1
  }
  Start-Sleep -Milliseconds 800
}

Write-Host "Backend is ready: http://127.0.0.1:19522"

if ($StartDesktop) {
  Write-Host "Starting desktop app: npm run start ..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run start" -WorkingDirectory $desktopDir
  Write-Host "Desktop app launched."
  if ($null -eq $originalElectronRunAsNode) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  } else {
    $env:ELECTRON_RUN_AS_NODE = $originalElectronRunAsNode
  }
  exit 0
}

Write-Host "Done. Continue manually:"
Write-Host "cd desktop"
Write-Host "npm run start"
Write-Host "Backend process PID: $($backend.Id)"
if ($null -eq $originalElectronRunAsNode) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
} else {
  $env:ELECTRON_RUN_AS_NODE = $originalElectronRunAsNode
}
