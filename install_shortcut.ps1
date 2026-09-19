<#
Creates (or recreates) the "Caption Editor.lnk" desktop shortcut that
launches tray_launcher.ps1 with no visible console window — just the
tray icon. Run this once, or again after moving the repo.
#>

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherScript = Join-Path $repoDir "tray_launcher.ps1"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Caption Editor.lnk"

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherScript`""
$shortcut.WorkingDirectory = $repoDir
$shortcut.WindowStyle = 7  # minimized, belt-and-suspenders on top of -WindowStyle Hidden
$shortcut.IconLocation = "$env:WINDIR\System32\shell32.dll,220"  # generic tray/monitor-ish icon
$shortcut.Description = "Start the caption editor server (runs in the system tray)"
$shortcut.Save()

Write-Host "Created shortcut: $shortcutPath"
