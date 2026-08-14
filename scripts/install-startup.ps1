$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'Scrappy.lnk'

$electronExe = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) {
  throw "Electron not found at $electronExe. Run 'npm install' in the scrappy folder first."
}

$wshell = New-Object -ComObject WScript.Shell
$shortcut = $wshell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronExe
$shortcut.Arguments = '.'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Start Scrappy on login'
$shortcut.Save()

Write-Host "Installed Startup shortcut:"
Write-Host "  $shortcutPath"
Write-Host "Scrappy will launch when you sign in to Windows."
