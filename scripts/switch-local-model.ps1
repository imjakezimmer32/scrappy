# Switch Cog's local Ollama brain and restart Workbuddy.
# Usage:
#   powershell -File scripts/switch-local-model.ps1 qwen2.5:14b
#   powershell -File scripts/switch-local-model.ps1 gemma2:9b
#   powershell -File scripts/switch-local-model.ps1 deepseek-r1:14b

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$model = $args[0]
if (-not $model) {
  Write-Host "Usage: switch-local-model.ps1 <ollama-model>"
  Write-Host "Examples:"
  Write-Host "  qwen2.5:14b"
  Write-Host "  gemma2:9b"
  Write-Host "  deepseek-r1:14b"
  exit 1
}

$ollama = $null
foreach ($c in @(
  "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
  "C:\Program Files\Ollama\ollama.exe"
)) {
  if (Test-Path $c) { $ollama = $c; break }
}
if (-not $ollama) { $ollama = "ollama" }

Write-Host "==> Ensuring model is available: $model"
& $ollama pull $model

$envFile = Join-Path $Root ".env.local"
$lines = @()
if (Test-Path $envFile) { $lines = Get-Content $envFile }
$lines = @($lines | Where-Object {
  $_ -notmatch '^\s*VOICE_BACKEND\s*=' -and
  $_ -notmatch '^\s*OLLAMA_MODEL\s*='
})
$lines += "VOICE_BACKEND=local"
$lines += "OLLAMA_MODEL=$model"
# UTF8 no BOM so env keys stay clean
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($envFile, $lines, $utf8)
Write-Host "Updated .env.local -> OLLAMA_MODEL=$model"

Write-Host "==> Restarting Workbuddy..."
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
  Where-Object { $_.CommandLine -match 'workbuddy' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'local-voice\\server.py' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory $Root -WindowStyle Hidden
Write-Host "Done. Cog is coming back with $model."
