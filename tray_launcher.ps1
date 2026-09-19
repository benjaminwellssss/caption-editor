<#
Runs the caption-editor server as a hidden background process and shows a
system tray icon to control it — no console window, nothing to minimize
by hand. Meant to be launched via the "Caption Editor.lnk" desktop
shortcut (see install_shortcut.ps1), not run directly in a visible shell.

Tray menu: Open Caption Editor (browser), Restart server, Quit (stops the
server and removes the tray icon). Double-clicking the tray icon opens
the browser too.
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $env:USERPROFILE ".cache\video-editor\whisperx-venv\Scripts\python.exe"
$serverScript = Join-Path $repoDir "server.py"
$port = 8765
$url = "http://127.0.0.1:$port"

function Start-CaptionServer {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $pythonExe
    $psi.Arguments = "`"$serverScript`" --port $port"
    $psi.WorkingDirectory = $repoDir
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    return [System.Diagnostics.Process]::Start($psi)
}

$script:serverProc = Start-CaptionServer

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Text = "Caption Editor Server (port $port)"
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = $menu.Items.Add("Open Caption Editor")
$openItem.Add_Click({ Start-Process $url })

$restartItem = $menu.Items.Add("Restart server")
$restartItem.Add_Click({
    if ($script:serverProc -and -not $script:serverProc.HasExited) {
        $script:serverProc.Kill()
        $script:serverProc.WaitForExit(2000) | Out-Null
    }
    $script:serverProc = Start-CaptionServer
    $notifyIcon.ShowBalloonTip(1500, "Caption Editor", "Server restarted", [System.Windows.Forms.ToolTipIcon]::Info)
})

$menu.Items.Add("-") | Out-Null

$quitItem = $menu.Items.Add("Quit")
$quitItem.Add_Click({
    if ($script:serverProc -and -not $script:serverProc.HasExited) {
        $script:serverProc.Kill()
    }
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Add_DoubleClick({ Start-Process $url })
$notifyIcon.ShowBalloonTip(1500, "Caption Editor", "Server running at $url", [System.Windows.Forms.ToolTipIcon]::Info)

# Clean up the child process if this tray app itself gets killed/closed.
[System.Windows.Forms.Application]::add_ApplicationExit({
    if ($script:serverProc -and -not $script:serverProc.HasExited) {
        $script:serverProc.Kill()
    }
})

[System.Windows.Forms.Application]::Run()
