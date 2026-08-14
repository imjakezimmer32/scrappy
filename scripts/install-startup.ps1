$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$startupDir = [Environment]::GetFolderPath('Startup')
$programsDir = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
$iconPath = Join-Path $projectRoot 'assets\scrappy.ico'
$trayExe = Join-Path $projectRoot 'bin\Scrappy.exe'

if (-not (Test-Path $trayExe)) {
  & (Join-Path $PSScriptRoot 'build-tray.ps1')
}

function Write-ScrappyShortcut([string]$shortcutPath) {
  $dir = Split-Path -Parent $shortcutPath
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $wshell = New-Object -ComObject WScript.Shell
  $shortcut = $wshell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $trayExe
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = (Split-Path -Parent $trayExe)
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Start Scrappy'
  if (Test-Path $iconPath) {
    $shortcut.IconLocation = $iconPath
  }
  $shortcut.Save()
}

Write-ScrappyShortcut (Join-Path $startupDir 'Scrappy.lnk')
Write-ScrappyShortcut (Join-Path $programsDir 'Scrappy.lnk')

foreach ($stale in @('Workbuddy.lnk', 'Cog.lnk')) {
  foreach ($dir in @($startupDir, $programsDir)) {
    $p = Join-Path $dir $stale
    if (Test-Path $p) { Remove-Item -Force $p }
  }
}

Write-Host "Scrappy's hidden-icons helper will launch when you sign in."
Write-Host "  Startup: $(Join-Path $startupDir 'Scrappy.lnk')"
Write-Host "Ending Electron in Task Manager will not remove the icon."
Write-Host "Click the ^ arrow by the clock, then click Scrappy's face to start him."
