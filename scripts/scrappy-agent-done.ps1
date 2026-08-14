# Notifies local Scrappy when a Cursor agent stops. Fail-open always.
$ErrorActionPreference = "Continue"

function Get-ScrappyToken {
  $candidates = @(
    (Join-Path $env:USERPROFILE ".cursor\hooks\scrappy-token.txt"),
    (Join-Path $env:APPDATA "scrappy\local-token.txt"),
    (Join-Path $env:LOCALAPPDATA "scrappy\local-token.txt")
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) {
      $t = (Get-Content $p -Raw -ErrorAction SilentlyContinue).Trim()
      if ($t) { return $t }
    }
  }
  return $null
}

function Get-SessionDurationMs($payload) {
  $id = $payload.conversation_id
  if (-not $id) { $id = $payload.generation_id }
  $dir = Join-Path $env:LOCALAPPDATA "Scrappy\sessions"
  if ($id) {
    $path = Join-Path $dir "$id.json"
    if (Test-Path $path) {
      try {
        $rec = Get-Content $path -Raw | ConvertFrom-Json
        if ($rec.startedAt) {
          $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          $dur = [int64]($now - [int64]$rec.startedAt)
          Remove-Item $path -Force -ErrorAction SilentlyContinue
          return $dur
        }
      } catch { }
    }
  }

  $tp = $payload.transcript_path
  if ($tp -and (Test-Path $tp)) {
    try {
      $item = Get-Item $tp
      $age = [DateTime]::UtcNow - $item.CreationTimeUtc
      return [int64]$age.TotalMilliseconds
    } catch { }
  }
  return $null
}

function Get-HookDurationMs($payload, $eventName) {
  $hooksDir = Join-Path $env:USERPROFILE ".cursor\hooks"
  $startPath = Join-Path $hooksDir "scrappy-session-start.txt"
  if ($eventName -match "subagent") {
    $startPath = Join-Path $hooksDir "scrappy-subagent-start.txt"
  }

  if (Test-Path $startPath) {
    try {
      $started = 0L
      [long]::TryParse((Get-Content -Raw $startPath).Trim(), [ref]$started) | Out-Null
      if ($started -gt 0) {
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $dur = [Math]::Max(0, $now - $started)
        Remove-Item -Force $startPath -ErrorAction SilentlyContinue
        return $dur
      }
    } catch { }
  }

  return Get-SessionDurationMs $payload
}

try {
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw) { exit 0 }
  $payload = $raw | ConvertFrom-Json

  $status = [string]$payload.status
  if ($status -and ($status -ne "completed") -and ($status -ne "error") -and ($status -ne "finished")) {
    exit 0
  }

  $eventName = "stop"
  if ($payload.hook_event_name) { $eventName = [string]$payload.hook_event_name }
  elseif ($payload.event) { $eventName = [string]$payload.event }

  $token = Get-ScrappyToken
  if (-not $token) { exit 0 }

  $durationMs = Get-HookDurationMs $payload $eventName
  $title = if ($eventName -match "subagent") { "Background agent finished" } else { "Agent finished" }

  $bodyObj = @{
    source     = "cursor-hook"
    event      = $eventName
    status     = if ($status) { $status } else { "completed" }
    title      = $title
    durationMs = $durationMs
  }
  if ($null -eq $durationMs) {
    $bodyObj.Remove("durationMs")
  }

  $body = $bodyObj | ConvertTo-Json -Compress
  $headers = @{ Authorization = "Bearer $token" }

  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/agent-done" -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 2 | Out-Null
} catch {
  # Scrappy not running or network blip — ignore
}
exit 0
