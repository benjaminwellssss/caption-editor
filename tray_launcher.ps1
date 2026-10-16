<#
Runs the Cabtions server as a hidden background process with a system tray icon, and opens the editor as
soon as it starts. Meant to be launched by the "Cabtions" desktop shortcut (see install_shortcut.ps1).

The editor opens as its own app window (Chrome or Edge "app" mode: no tabs, address bar or toolbar). If
neither browser is installed it falls back to the default browser. Opening files needs Chrome or Edge either way.

Tray menu: Open Cabtions (app window), Open in browser (default browser), Restart server, Quit.
Double-clicking the tray icon opens the app window.
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $env:USERPROFILE ".cache\video-editor\whisperx-venv\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) { $pythonExe = "python" }  # any Python 3 works; the server is stdlib-only
$serverScript = Join-Path $repoDir "server.py"
$iconPath = Join-Path $repoDir "assets\cabtions.ico"
$port = 8765
$url = "http://127.0.0.1:$port"

function Find-AppBrowser {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

function Open-AppWindow {
    $browser = Find-AppBrowser
    if ($browser) { Start-Process $browser -ArgumentList "--app=$url", "--window-size=1600,1000" }
    else { Start-Process $url }
}

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

function Wait-ForServer {
    for ($i = 0; $i -lt 40; $i++) {
        try { Invoke-WebRequest -Uri "$url/settings" -UseBasicParsing -TimeoutSec 1 | Out-Null; return $true }
        catch { Start-Sleep -Milliseconds 150 }
    }
    return $false
}

$script:serverProc = Start-CaptionServer

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = if (Test-Path $iconPath) { New-Object System.Drawing.Icon $iconPath } else { [System.Drawing.SystemIcons]::Application }
$notifyIcon.Text = "Cabtions (port $port)"
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add("Open Cabtions").Add_Click({ Open-AppWindow })
$menu.Items.Add("Open in browser").Add_Click({ Start-Process $url })
$menu.Items.Add("Restart server").Add_Click({
    if ($script:serverProc -and -not $script:serverProc.HasExited) {
        $script:serverProc.Kill()
        $script:serverProc.WaitForExit(2000) | Out-Null
    }
    $script:serverProc = Start-CaptionServer
    $notifyIcon.ShowBalloonTip(1500, "Cabtions", "Server restarted", [System.Windows.Forms.ToolTipIcon]::Info)
})
$menu.Items.Add("-") | Out-Null
$menu.Items.Add("Quit").Add_Click({
    if ($script:serverProc -and -not $script:serverProc.HasExited) { $script:serverProc.Kill() }
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Add_DoubleClick({ Open-AppWindow })

# Clean up the server if this tray app itself gets killed/closed.
[System.Windows.Forms.Application]::add_ApplicationExit({
    if ($script:serverProc -and -not $script:serverProc.HasExited) { $script:serverProc.Kill() }
})

if (Wait-ForServer) { Open-AppWindow }
else { $notifyIcon.ShowBalloonTip(3000, "Cabtions", "The server didn't start - try Restart server", [System.Windows.Forms.ToolTipIcon]::Warning) }

[System.Windows.Forms.Application]::Run()
