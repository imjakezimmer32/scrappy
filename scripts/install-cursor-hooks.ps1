# Installs / updates the user-level Cursor hooks that ping Workbuddy.
$ErrorActionPreference = 'Stop'

$hooksDir = Join-Path $env:USERPROFILE '.cursor\hooks'
$hooksJsonPath = Join-Path $env:USERPROFILE '.cursor\hooks.json'
$tokenPath = Join-Path $hooksDir 'workbuddy-token.txt'
$sessionStartPath = Join-Path $hooksDir 'workbuddy-session-start.txt'
$subagentStartPath = Join-Path $hooksDir 'workbuddy-subagent-start.txt'

New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null

# Prefer a live token from the running app; fall back to existing file.
$token = $null
try {
  $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/token' -TimeoutSec 2
  if ($resp.token) { $token = [string]$resp.token }
} catch {}

if (-not $token -and (Test-Path $tokenPath)) {
  $token = (Get-Content -Raw $tokenPath).Trim()
}

if (-not $token) {
  throw 'Could not get Workbuddy token. Start Workbuddy (npm start) once, then re-run this script.'
}

Set-Content -Path $tokenPath -Value $token -NoNewline -Encoding UTF8

# --- session start ---
@'
$ErrorActionPreference = "SilentlyContinue"
$startPath = Join-Path $env:USERPROFILE ".cursor\hooks\workbuddy-session-start.txt"
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() | Set-Content -Path $startPath -NoNewline -Encoding UTF8
exit 0
'@ | Set-Content -Path (Join-Path $hooksDir 'workbuddy-session-start.ps1') -Encoding UTF8

# --- subagent start ---
@'
$ErrorActionPreference = "SilentlyContinue"
$startPath = Join-Path $env:USERPROFILE ".cursor\hooks\workbuddy-subagent-start.txt"
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() | Set-Content -Path $startPath -NoNewline -Encoding UTF8
exit 0
'@ | Set-Content -Path (Join-Path $hooksDir 'workbuddy-subagent-start.ps1') -Encoding UTF8

# --- agent done (stop / subagentStop) — copy canonical script from repo ---
$srcDone = Join-Path $PSScriptRoot 'workbuddy-agent-done.ps1'
$destDone = Join-Path $hooksDir 'workbuddy-agent-done.ps1'
if (-not (Test-Path $srcDone)) {
  throw "Missing $srcDone"
}
Copy-Item -Force $srcDone $destDone

# Merge hooks.json
$hookCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "./hooks/workbuddy-agent-done.ps1"'
$sessionCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "./hooks/workbuddy-session-start.ps1"'
$subStartCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "./hooks/workbuddy-subagent-start.ps1"'

$config = @{ version = 1; hooks = @{} }
if (Test-Path $hooksJsonPath) {
  try {
    $existing = Get-Content -Raw $hooksJsonPath | ConvertFrom-Json
    if ($existing.version) { $config.version = $existing.version }
    if ($existing.hooks) {
      $config.hooks = @{}
      $existing.hooks.PSObject.Properties | ForEach-Object {
        $config.hooks[$_.Name] = @($_.Value)
      }
    }
  } catch {}
}

function Set-HookList([string]$name, [string]$command) {
  $list = @()
  if ($config.hooks.ContainsKey($name)) {
    foreach ($item in @($config.hooks[$name])) {
      $cmd = $null
      if ($item -is [string]) { $cmd = $item }
      elseif ($item.command) { $cmd = [string]$item.command }
      if ($cmd -and ($cmd -notmatch 'workbuddy-')) {
        $list += $item
      }
    }
  }
  $list += @{ command = $command }
  $config.hooks[$name] = $list
}

Set-HookList 'sessionStart' $sessionCmd
Set-HookList 'subagentStart' $subStartCmd
Set-HookList 'stop' $hookCmd
Set-HookList 'subagentStop' $hookCmd

# Write JSON carefully
$hooksObj = [ordered]@{}
foreach ($key in $config.hooks.Keys) {
  $arr = @()
  foreach ($item in @($config.hooks[$key])) {
    if ($item -is [hashtable] -or $item -is [System.Collections.IDictionary]) {
      $arr += [ordered]@{ command = [string]$item.command }
    } elseif ($item.command) {
      $arr += [ordered]@{ command = [string]$item.command }
    }
  }
  $hooksObj[$key] = $arr
}
$out = [ordered]@{
  version = [int]$config.version
  hooks = $hooksObj
}
($out | ConvertTo-Json -Depth 8) | Set-Content -Path $hooksJsonPath -Encoding UTF8

Write-Host "Installed Cursor Workbuddy hooks:"
Write-Host "  $hooksJsonPath"
Write-Host "  token saved to $tokenPath"
