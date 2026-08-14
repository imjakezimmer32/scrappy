# Records when a Cursor agent session/generation starts so Scrappy can measure duration.
$ErrorActionPreference = "Continue"

try {
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw) { exit 0 }
  $payload = $raw | ConvertFrom-Json
  $id = $payload.conversation_id
  if (-not $id) { $id = $payload.generation_id }
  if (-not $id) { exit 0 }

  $dir = Join-Path $env:LOCALAPPDATA "Scrappy\sessions"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $path = Join-Path $dir "$id.json"
  $record = @{
    conversation_id = $payload.conversation_id
    generation_id   = $payload.generation_id
    startedAt       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    hook_event_name = $payload.hook_event_name
  } | ConvertTo-Json -Compress
  Set-Content -Path $path -Value $record -Encoding UTF8
} catch {
  # Fail open — never block Cursor
}
exit 0
