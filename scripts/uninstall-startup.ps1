$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'Workbuddy.lnk'

if (Test-Path $shortcutPath) {
  Remove-Item -Force $shortcutPath
  Write-Host "Removed Startup shortcut: $shortcutPath"
} else {
  Write-Host "No Startup shortcut found at: $shortcutPath"
}
