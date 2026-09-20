# dsh-turn-notify -- native Windows notification (invoked by the host half)
#
# Usage: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
#          -WindowStyle Hidden -File toast.ps1 -PayloadFile <payload.json>
#
# payload.json (UTF-8, BOM recommended): { "title": "...", "body": "..." }
#
# Two channels are tried in order; the first success prints one line of JSON
# to stdout and exits:
#   1) WinRT ToastNotification -- a real Windows notification-center toast
#   2) System.Windows.Forms.NotifyIcon balloon -- tray fallback
# Nothing is ever thrown at the caller: failures land in the result JSON.
#
# Click to focus: a toast click only raises the app when Windows can resolve
# what to launch. DSH Desktop ships a Start Menu shortcut with the AUMID
# io.dsh.desktop but registers no ToastActivatorCLSID COM server, so an ordinary
# toast click does nothing at all (measured: no process spawn, window stays
# behind). Pointing the toast at a per-user URI scheme instead makes the click
# launch DSH Desktop.exe, whose single-instance lock then asks the already
# running window to restore and focus itself.
#
# NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads a
# BOM-less .ps1 using the system ANSI code page; non-ASCII comment text gets
# mangled there and can swallow a newline, which corrupts the brace structure
# and fails with a bogus "unexpected token" error far below the real cause.

param(
  [Parameter(Mandatory = $true)][string]$PayloadFile,
  [string]$Scheme = 'dsh-turn-notify',
  [switch]$NoProtocol,
  [switch]$Diagnose
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$attempts = New-Object System.Collections.ArrayList
$result = [ordered]@{ ok = $false; via = $null; error = $null; attempts = $attempts }

function Write-Result {
  param($obj)
  try { [Console]::Out.Write(($obj | ConvertTo-Json -Compress -Depth 4)) } catch { }
}

$title = 'DSH Desktop'
$body = ''

try {
  $raw = Get-Content -LiteralPath $PayloadFile -Raw -Encoding UTF8
  $p = $raw | ConvertFrom-Json
  if ($p.title) { $title = [string]$p.title }
  if ($p.body) { $body = [string]$p.body }
} catch {
  $result.error = "payload: $($_.Exception.Message)"
  Write-Result $result
  exit 0
}

# -- Click to focus: locate the app and register the per-user URI scheme ------
function Get-DshExe {
  # The Start Menu shortcut is the authoritative mapping: the same shortcut is
  # what gives DSH Desktop its AUMID in the first place.
  $links = @(
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\DSH Desktop.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DSH Desktop.lnk')
  )
  foreach ($link in $links) {
    try {
      if (Test-Path -LiteralPath $link) {
        $target = (New-Object -ComObject WScript.Shell).CreateShortcut($link).TargetPath
        if ($target -and (Test-Path -LiteralPath $target)) { return $target }
      }
    } catch { }
  }
  # Fallback: ask a running instance where it lives.
  try {
    $proc = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path } | Select-Object -First 1
    if ($proc -and (Test-Path -LiteralPath $proc.Path)) { return $proc.Path }
  } catch { }
  return $null
}

function Enable-FocusProtocol {
  param([string]$Name)
  $cmdKey = "HKCU:\Software\Classes\$Name\shell\open\command"
  # Fast path: already registered and the target still exists. This keeps the
  # steady-state cost at one registry read instead of a shortcut COM lookup.
  try {
    if (Test-Path $cmdKey) {
      $current = (Get-ItemProperty -Path $cmdKey).'(default)'
      if ($current) {
        $exe = $current.Trim('"')
        if (Test-Path -LiteralPath $exe) { return @{ ok = $true; exe = $exe; created = $false } }
      }
    }
  } catch { }

  $exe = Get-DshExe
  if (-not $exe) { return @{ ok = $false; error = 'cannot locate DSH Desktop.exe' } }
  try {
    $root = "HKCU:\Software\Classes\$Name"
    New-Item -Path $root -Force | Out-Null
    Set-ItemProperty -Path $root -Name '(Default)' -Value 'URL:DSH Turn Notify focus'
    Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''
    New-Item -Path "$root\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path "$root\shell\open\command" -Name '(Default)' -Value ('"' + $exe + '"')
    return @{ ok = $true; exe = $exe; created = $true }
  } catch {
    return @{ ok = $false; error = $_.Exception.Message }
  }
}

# -- Channel 1: WinRT toast -------------------------------------------------
# The AUMID must be registered or CreateToastNotifier throws. DSH Desktop's own
# Start Menu shortcut carries the AUMID io.dsh.desktop, so listing it first
# makes the toast genuinely attributed to DSH Desktop (its name and icon)
# instead of to Windows PowerShell.
#
# The AUMID alone does NOT make the click work: attributing a toast to an app
# and telling Windows what to launch on click are separate things. See the
# click-to-focus block above.
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02
  )
  # Assign through text nodes + CreateTextNode so the XML DOM does the escaping;
  # hand-built XML would break on & < > or quotes inside the reply text.
  $nodes = $template.GetElementsByTagName('text')
  [void]$nodes.Item(0).AppendChild($template.CreateTextNode($title))
  [void]$nodes.Item(1).AppendChild($template.CreateTextNode($body))

  # Wire the click before the toast is constructed. If the scheme cannot be
  # registered we still send the toast, just without an activation type -- a
  # notification that cannot be clicked beats no notification at all.
  $focus = @{ ok = $false }
  if (-not $NoProtocol) { $focus = Enable-FocusProtocol -Name $Scheme }
  $result.clickToFocus = [bool]$focus.ok
  if ($focus.exe) { $result.focusExe = $focus.exe }
  if ($focus.error) { [void]$attempts.Add("protocol=$($focus.error)") }
  if ($focus.ok) {
    $template.DocumentElement.SetAttribute('activationType', 'protocol')
    $template.DocumentElement.SetAttribute('launch', "$($Scheme):")
  }
  # -Diagnose returns the XML that is actually sent. A toast's click behaviour
  # is decided entirely by this XML, so "the script thinks it set it" and "it
  # really got set" must be separable -- otherwise debugging is guesswork.
  if ($Diagnose) { $result.xml = $template.GetXml() }

  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)

  $appIds = @(
    'io.dsh.desktop',
    'DSH Desktop',
    'com.dsh.desktop',
    '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  )
  foreach ($appId in $appIds) {
    try {
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
      $notifier.Show($toast)
      [void]$attempts.Add("winrt[$appId]=ok")
      $result.ok = $true
      $result.via = "winrt:$appId"
      Write-Result $result
      exit 0
    } catch {
      [void]$attempts.Add("winrt[$appId]=$($_.Exception.Message)")
      if (-not $result.error) { $result.error = "winrt[$appId]: $($_.Exception.Message)" }
    }
  }
} catch {
  [void]$attempts.Add("winrt-load=$($_.Exception.Message)")
  $result.error = "winrt: $($_.Exception.Message)"
}

if ($Diagnose) {
  Write-Result $result
  exit 0
}

# -- Channel 2: tray balloon (fallback) ------------------------------------
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $ni = New-Object System.Windows.Forms.NotifyIcon
  $ni.Icon = [System.Drawing.SystemIcons]::Information
  $ni.BalloonTipTitle = $title
  $ni.BalloonTipText = $body
  $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $ni.Visible = $true
  $ni.ShowBalloonTip(8000)
  # The balloon is drawn asynchronously: the process must outlive it or the
  # balloon disappears immediately.
  Start-Sleep -Seconds 9
  $ni.Visible = $false
  $ni.Dispose()

  [void]$attempts.Add('notifyicon=ok')
  $result.ok = $true
  $result.via = 'notifyicon'
} catch {
  [void]$attempts.Add("notifyicon=$($_.Exception.Message)")
  if ($result.error) { $result.error = "$($result.error) | notifyicon: $($_.Exception.Message)" }
  else { $result.error = "notifyicon: $($_.Exception.Message)" }
}

Write-Result $result
exit 0
