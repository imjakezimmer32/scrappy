# PersonaPlex stack for Scrappy full-duplex voice (NVIDIA GPU).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Plex = Join-Path $Root "personaplex"
$Bridge = Join-Path $Root "personaplex-bridge"
$BridgeVenv = Join-Path $Bridge ".venv"
$PlexVenv = Join-Path $Plex ".venv"

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

if (-not (Test-Path (Join-Path $Plex "moshi"))) {
  Write-Host "==> Cloning NVIDIA PersonaPlex..."
  git clone --depth 1 https://github.com/NVIDIA/personaplex.git $Plex
}

Write-Host "==> PersonaPlex venv + moshi install..."
& $py -m venv $PlexVenv
$pipP = Join-Path $PlexVenv "Scripts\pip.exe"
$pyP = Join-Path $PlexVenv "Scripts\python.exe"
& $pipP install --upgrade pip
& $pipP install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
& $pipP install -e (Join-Path $Plex "moshi")

Write-Host "==> Bridge venv..."
& $py -m venv $BridgeVenv
$pipB = Join-Path $BridgeVenv "Scripts\pip.exe"
& $pipB install --upgrade pip
& $pipB install -r (Join-Path $Bridge "requirements.txt")

Write-Host ""
Write-Host "Done. Next:"
Write-Host "  1. Accept the model license at https://huggingface.co/nvidia/personaplex-7b-v1"
Write-Host "  2. Set HF_TOKEN in Scrappy setup"
Write-Host "  3. Voice backend: PersonaPlex"
Write-Host "  4. Tray -> Talk to Scrappy"
Write-Host ""
Write-Host "GPU required for real-time duplex. See docs/personaplex.md"
