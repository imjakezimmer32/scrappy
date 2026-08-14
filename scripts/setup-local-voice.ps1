# Sets up Scrappy's free local AMD-friendly voice stack:
# - Python venv + deps
# - Kokoro TTS model files
# - Ollama chat model

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Voice = Join-Path $Root "local-voice"
$Models = Join-Path $Voice "models"
$Venv = Join-Path $Voice ".venv"

Write-Host "==> Locating Python 3.12..."
$py = $null
foreach ($c in @(
  "C:\Users\hella\AppData\Local\Programs\Python\Python312\python.exe",
  "C:\Python312\python.exe"
)) {
  if (Test-Path $c) { $py = $c; break }
}
if (-not $py) {
  $py = (py -3.12 -c "import sys; print(sys.executable)" 2>$null)
}
if (-not $py) { throw "Python 3.12 not found. Install it, then re-run." }
Write-Host "    using $py"

Write-Host "==> Creating venv..."
& $py -m venv $Venv
$pip = Join-Path $Venv "Scripts\pip.exe"
$python = Join-Path $Venv "Scripts\python.exe"
& $pip install --upgrade pip
& $pip install -r (Join-Path $Voice "requirements.txt")

Write-Host "==> Downloading Kokoro models..."
New-Item -ItemType Directory -Force -Path $Models | Out-Null
$modelUrl = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
$voicesUrl = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
$modelPath = Join-Path $Models "kokoro-v1.0.onnx"
$voicesPath = Join-Path $Models "voices-v1.0.bin"
if (-not (Test-Path $modelPath)) {
  Write-Host "    kokoro-v1.0.onnx..."
  Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath
}
if (-not (Test-Path $voicesPath)) {
  Write-Host "    voices-v1.0.bin..."
  Invoke-WebRequest -Uri $voicesUrl -OutFile $voicesPath
}

Write-Host "==> Ensuring Ollama is running and pulling model..."
$ollama = $null
foreach ($c in @(
  "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
  "C:\Program Files\Ollama\ollama.exe"
)) {
  if (Test-Path $c) { $ollama = $c; break }
}
if (-not $ollama) { $ollama = "ollama" }

try {
  & $ollama list | Out-Null
} catch {
  Write-Host "    starting Ollama app..."
  Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
}

$model = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { "qwen2.5:7b" }
Write-Host "    ollama pull $model (this can take a few minutes)..."
& $ollama pull $model

# Flip Scrappy to local voice by default in .env.local (keep ElevenLabs keys for fallback).
$envFile = Join-Path $Root ".env.local"
$lines = @()
if (Test-Path $envFile) {
  $lines = Get-Content $envFile
}
$lines = $lines | Where-Object { $_ -notmatch '^\s*VOICE_BACKEND\s*=' -and $_ -notmatch '^\s*OLLAMA_MODEL\s*=' }
$lines += "VOICE_BACKEND=local"
$lines += "OLLAMA_MODEL=$model"
Set-Content -Path $envFile -Value $lines -Encoding UTF8

Write-Host ""
Write-Host "Done. Start Scrappy with npm start - local voice will boot automatically."
Write-Host "Test server alone with:"
$serverPy = Join-Path $Voice "server.py"
Write-Host ("  " + $python + " " + $serverPy)
