<#
Creates (or recreates) the "Cabtions" desktop shortcut, which starts tray_launcher.ps1 with no console
window: the tray icon appears and the editor opens in its own app window. Run this once, or again after
moving the repo. Also removes the old "Caption Editor" shortcut if it's there.
#>

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherScript = Join-Path $repoDir "tray_launcher.ps1"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Cabtions.lnk"
$old = Join-Path $desktop "Caption Editor.lnk"
if (Test-Path $old) { Remove-Item $old }

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherScript`""
$shortcut.WorkingDirectory = $repoDir
$shortcut.WindowStyle = 7  # minimized, belt-and-suspenders on top of -WindowStyle Hidden
$shortcut.IconLocation = Join-Path $repoDir "assets\cabtions.ico"
$shortcut.Description = "Cabtions caption editor"
$shortcut.Save()

Write-Host "Created shortcut: $shortcutPath"
