# Lightweight bridge on Windows (no CUDA). PersonaPlex runs on your cloud GPU server.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Bridge = Join-Path $Root "personaplex-bridge"
$BridgeVenv = Join-Path $Bridge ".venv"

Write-Host "==> Python 3.12..."
$py = $null
foreach ($probe in @(
  { py -3.12 -c "import sys; print(sys.executable)" },
  { python3.12 -c "import sys; print(sys.executable)" }
)) {
  try {
    $out = & $probe 2>$null
    if ($out -and (Test-Path $out)) { $py = $out.Trim(); break }
  } catch {}
}
if (-not $py) { throw "Python 3.12 required (python.org)." }

Write-Host "==> Bridge venv (Opus + WebSocket proxy)..."
& $py -m venv $BridgeVenv
$pipB = Join-Path $BridgeVenv "Scripts\pip.exe"
& $pipB install --upgrade pip
& $pipB install -r (Join-Path $Bridge "requirements.txt")

Write-Host ""
Write-Host "Done. This PC only runs the bridge."
Write-Host "Set PERSONAPLEX_SERVER_URL in Scrappy setup to your cloud moshi.server URL."
Write-Host "See docs/personaplex-cloud-server.md"
