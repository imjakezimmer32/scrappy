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

# --- agent done (stop / subagentStop) ---
@'
$ErrorActionPreference = "SilentlyContinue"
try {
  $inputJson = [Console]::In.ReadToEnd()
  $hooksDir = Join-Path $env:USERPROFILE ".cursor\hooks"
  $tokenPath = Join-Path $hooksDir "workbuddy-token.txt"
  if (-not (Test-Path $tokenPath)) { exit 0 }
  $token = (Get-Content -Raw $tokenPath).Trim()
  if (-not $token) { exit 0 }

  $eventName = "stop"
  $startPath = Join-Path $hooksDir "workbuddy-session-start.txt"
  try {
    $parsed = $inputJson | ConvertFrom-Json -ErrorAction Stop
    if ($parsed.hook_event_name) { $eventName = [string]$parsed.hook_event_name }
    elseif ($parsed.event) { $eventName = [string]$parsed.event }
    if ($eventName -match "subagent") {
      $startPath = Join-Path $hooksDir "workbuddy-subagent-start.txt"
    }
  } catch {}

  $durationMs = 0
  if (Test-Path $startPath) {
    $started = 0L
    [long]::TryParse((Get-Content -Raw $startPath).Trim(), [ref]$started) | Out-Null
    if ($started -gt 0) {
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $durationMs = [Math]::Max(0, $now - $started)
    }
    Remove-Item -Force $startPath -ErrorAction SilentlyContinue
  }

  $title = if ($eventName -match "subagent") { "Background agent finished" } else { "Agent finished" }
  $body = @{
    durationMs = $durationMs
    source = "cursor-hook"
    event = $eventName
    title = $title
  } | ConvertTo-Json -Compress

  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/agent-done" `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 2 | Out-Null
} catch {}
exit 0
'@ | Set-Content -Path (Join-Path $hooksDir 'workbuddy-agent-done.ps1') -Encoding UTF8

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
