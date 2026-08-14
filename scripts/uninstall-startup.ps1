$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')

# 'Workbuddy.lnk' is the pre-rename name — clean it up too so an old install
# doesn't keep launching on login after the rename.
$shortcutNames = @('Scrappy.lnk', 'Workbuddy.lnk', 'Cog.lnk')
$removed = $false

foreach ($name in $shortcutNames) {
  $shortcutPath = Join-Path $startupDir $name
  if (Test-Path $shortcutPath) {
    Remove-Item -Force $shortcutPath
    Write-Host "Removed Startup shortcut: $shortcutPath"
    $removed = $true
  }
}

if (-not $removed) {
  Write-Host "No Startup shortcut found in: $startupDir"
}
