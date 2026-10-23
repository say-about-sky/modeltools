<#
g3d-web-serve.ps1 - idempotent launcher/reuser for g3d-web.

Why: AI agents often start a new server for every skill invocation, which causes
port collisions and "Access is denied (os error 5)" when cargo tries to replace a
running target\release\g3d-web.exe. This script reuses an existing server for the
same model root whenever possible, and only starts a detached process if needed.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\g3d-web-serve.ps1
  ... -Port 8788
  ... -Build          # rebuild first; fall back to target-ai if release is locked
  ... -Dev            # frontend from web/ (live edits, no rebuild)
  ... -Check          # only reuse/probe; print NO_SERVICE instead of starting
  ... -IdleTimeout 300 # seconds without requests before auto-exit (0=off)
  ... -Stop           # stop the server started by this script (tracked PID only)

Output (first token is stable):
  REUSE   http://127.0.0.1:8787/ models=21 root=...
  STARTED http://127.0.0.1:8788/ pid=1234 models=21 root=...
  REUSE-DEV http://127.0.0.1:8789/ pid=1234
  NO_SERVICE
  STOPPED pid=1234 port=8788
  NO_TRACKED_SERVER
  ERROR   ...

This script never kills unknown g3d-web.exe processes. Parallel sessions may own
servers on other ports; use the printed REUSE URL or a free port.
#>
param(
  [int]$Port = 8787,
  [string]$Root = '',
  [switch]$Build,
  [switch]$Dev,
  [switch]$Check,
  [switch]$Stop,
  [int]$IdleTimeout = 300,
  [int]$Scan = 20
)

$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $PSScriptRoot
if (-not $Root) {
  $workspace = Split-Path -Parent $toolDir
  # 直接使用 G3DArmy 资源目录作为根（g3d-web 会扫描 models/main/g3d 并读取 loadSelect/attachments）。
  $army = Join-Path $workspace 'age3mudels\G3DArmy'
  if (Test-Path -LiteralPath $army) { $Root = $army }
  else {
    $legacy = Join-Path $workspace 'age3mudels'
    if (Test-Path -LiteralPath $legacy) { $Root = $legacy }
    else { $Root = $workspace }
  }
}
try { $Root = [IO.Path]::GetFullPath($Root) } catch { }
$Root = $Root.TrimEnd([char[]]@('\', '/'))
$stateFile = Join-Path $toolDir 'target\g3d-web-serve.json'
$exe = Join-Path $toolDir 'target\release\g3d-web.exe'
$buildLog = Join-Path $toolDir 'target\g3d-web-build.log'

function Norm-Root([string]$p) {
  if (-not $p) { return '' }
  try { return ([IO.Path]::GetFullPath($p)).TrimEnd([char[]]@('\', '/')).ToLowerInvariant() } catch { return $p.TrimEnd([char[]]@('\', '/')).ToLowerInvariant() }
}
$targetRoot = Norm-Root $Root

function Get-Health([int]$p) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/health" -TimeoutSec 1 -ErrorAction Stop
    if ($r -and $r.ok) { return $r }
  } catch { }
  return $null
}

function Test-PortFree([int]$p) {
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Loopback), $p
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { try { $listener.Stop() } catch { } }
  }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
  try { return (Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json) } catch { return $null }
}

function Get-TrackedProcess($state) {
  if (-not $state -or -not $state.pid) { return $null }
  try {
    return (Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$state.pid) -ErrorAction SilentlyContinue)
  } catch { return $null }
}

function Stop-Tracked {
  $state = Read-State
  if (-not $state -or -not $state.pid) { Write-Output 'NO_TRACKED_SERVER'; return }
  $proc = Get-TrackedProcess $state
  if ($proc) {
    $cmd = [string]$proc.CommandLine
    if ($cmd -match 'g3d-web\.exe') {
      Stop-Process -Id ([int]$state.pid) -Force -ErrorAction SilentlyContinue
      Write-Output ("STOPPED pid={0} port={1}" -f $state.pid, $state.port)
    } else {
      Write-Output ("SKIP pid={0} (not g3d-web.exe)" -f $state.pid)
    }
  } else {
    Write-Output ("TRACKED_GONE pid={0}" -f $state.pid)
  }
  Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
}

if ($Stop) {
  Stop-Tracked
  exit 0
}

# -Dev: reuse the dev server previously started by this script, never a release server.
$skipReuse = [bool]$Build
if ($Dev -and -not $Build) {
  $state = Read-State
  if ($state -and $state.dev -and $state.pid -and $state.port) {
    $proc = Get-TrackedProcess $state
    if ($proc) {
      $h = Get-Health ([int]$state.port)
      if ($h -and ((Norm-Root ([string]$h.root)) -eq $targetRoot)) {
        Write-Output ("REUSE-DEV http://127.0.0.1:{0}/ pid={1}" -f $state.port, $state.pid)
        exit 0
      }
    }
  }
  $skipReuse = $true
}

# -Build: stop only the tracked server (so release exe can be replaced), then build.
if ($Build) {
  Stop-Tracked
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $buildLog) | Out-Null
  Push-Location $toolDir
  try {
    $cmdLine = 'cargo build --release --bin g3d-web > "' + $buildLog + '" 2>&1'
    & cmd /C $cmdLine
    $buildCode = $LASTEXITCODE
    Get-Content -LiteralPath $buildLog -Tail 12 -Encoding UTF8 | Write-Output
    if ($buildCode -ne 0) {
      Write-Output 'BUILD release failed (possibly exe locked); retry target-ai'
      $cmdLine = 'cargo build --release --bin g3d-web --target-dir target-ai > "' + $buildLog + '" 2>&1'
      & cmd /C $cmdLine
      $buildCode = $LASTEXITCODE
      Get-Content -LiteralPath $buildLog -Tail 12 -Encoding UTF8 | Write-Output
      if ($buildCode -ne 0) {
        Write-Output 'ERROR build failed (target\release and target-ai)'
        exit 2
      }
      $exe = Join-Path $toolDir 'target-ai\release\g3d-web.exe'
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $exe)) {
  Write-Output ("ERROR exe not found: {0}" -f $exe)
  exit 2
}

# Reuse an existing server for the same root (unless -Build/-Dev asked for a fresh one).
if (-not $skipReuse) {
  for ($i = 0; $i -le $Scan; $i++) {
    $p = $Port + $i
    $h = Get-Health $p
    if ($h -and ((Norm-Root ([string]$h.root)) -eq $targetRoot)) {
      Write-Output ("REUSE http://127.0.0.1:{0}/ models={1} root={2}" -f $p, $h.models, $h.root)
      exit 0
    }
  }
}

# -Check: never start a new process; let callers report that no service exists.
if ($Check) {
  Write-Output 'NO_SERVICE'
  exit 0
}

# Find a free port. Ports used by non-matching servers are skipped, not killed.
$chosen = $null
for ($i = 0; $i -le $Scan; $i++) {
  $p = $Port + $i
  if (Test-PortFree $p) { $chosen = $p; break }
}
if (-not $chosen) {
  Write-Output ("ERROR no free port in {0}..{1}" -f $Port, ($Port + $Scan))
  exit 2
}

$rootArg = '"' + $Root + '"'
$argList = @('--root', $rootArg, '--port', "$chosen", '--idle-timeout', "$IdleTimeout")
if ($Dev) { $argList += '--dev' }
$proc = Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Hidden -PassThru

$health = $null
$deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
  $health = Get-Health $chosen
  if ($health) { break }
  Start-Sleep -Milliseconds 150
}
if (-not $health) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Output ("ERROR server did not become healthy on port {0}" -f $chosen)
  exit 3
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stateFile) | Out-Null
[pscustomobject]@{
  pid = $proc.Id
  port = $chosen
  root = $Root
  exe = $exe
  dev = [bool]$Dev
  idleTimeout = $IdleTimeout
  startedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8

Write-Output ("STARTED http://127.0.0.1:{0}/ pid={1} models={2} root={3}" -f $chosen, $proc.Id, $health.models, $health.root)
