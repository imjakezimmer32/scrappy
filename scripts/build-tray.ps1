$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
  throw "Could not find csc.exe. .NET Framework 4 is required to build the tray helper."
}

$outDir = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir 'Scrappy.exe'
$src = Join-Path $PSScriptRoot 'scrappy-tray.cs'
$icon = Join-Path $root 'assets\scrappy.ico'

$args = @(
  '/nologo',
  '/target:winexe',
  "/out:$out",
  '/r:System.Windows.Forms.dll',
  '/r:System.Drawing.dll',
  '/r:System.Management.dll'
)
if (Test-Path $icon) { $args += "/win32icon:$icon" }
$args += $src

& $csc @args
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit $LASTEXITCODE" }
Write-Host "Built $out"
