# Notifies local Workbuddy when a Cursor agent stops. Fail-open always.
$ErrorActionPreference = "Continue"

function Get-WorkbuddyToken {
  $candidates = @(
    (Join-Path $env:APPDATA "workbuddy\local-token.txt"),
    (Join-Path $env:LOCALAPPDATA "workbuddy\local-token.txt"),
    "C:\Users\hella\OneDrive\Desktop\Projects\workbuddy\local-token.txt"
  )
  # Electron userData on Windows is typically %APPDATA%\workbuddy
  foreach ($p in $candidates) {
    if (Test-Path $p) {
      $t = (Get-Content $p -Raw -ErrorAction SilentlyContinue).Trim()
      if ($t) { return $t }
    }
  }
  return $null
}

function Get-DurationMs($payload) {
  $id = $payload.conversation_id
  if (-not $id) { $id = $payload.generation_id }
  $dir = Join-Path $env:LOCALAPPDATA "Workbuddy\sessions"
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

  # Fallback: transcript file age
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

try {
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw) { exit 0 }
  $payload = $raw | ConvertFrom-Json

  # Only nudge on real completions (not abort mid-thought spam)
  $status = [string]$payload.status
  if ($status -and ($status -ne "completed") -and ($status -ne "error")) {
    exit 0
  }

  $token = Get-WorkbuddyToken
  if (-not $token) { exit 0 }

  $durationMs = Get-DurationMs $payload
  $bodyObj = @{
    source     = "cursor-hook"
    event      = [string]$payload.hook_event_name
    status     = $status
    durationMs = $durationMs
    title      = $null
  }
  if ($null -eq $durationMs) {
    # Unknown duration: skip server-side filter by not forcing; server will skip
    $bodyObj.Remove("durationMs")
  }

  $body = $bodyObj | ConvertTo-Json -Compress
  $headers = @{ Authorization = "Bearer $token" }

  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/agent-done" -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 2 | Out-Null
} catch {
  # Workbuddy not running or network blip — ignore
}
exit 0
