$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'Workbuddy.lnk'

$electronExe = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) {
  throw "Electron not found at $electronExe. Run 'npm install' in the workbuddy folder first."
}

$wshell = New-Object -ComObject WScript.Shell
$shortcut = $wshell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronExe
$shortcut.Arguments = '.'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Start Workbuddy attention buddy on login'
$shortcut.Save()

Write-Host "Installed Startup shortcut:"
Write-Host "  $shortcutPath"
Write-Host "Workbuddy will launch when you sign in to Windows."
