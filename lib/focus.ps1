# dsh-turn-notify -- raise / launch DSH Desktop (invoked by the host half)
#
# Usage: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
#          -WindowStyle Hidden -File focus.ps1 [-Scheme dsh-turn-notify]
#
# Prints one line of JSON: { ok, exe, already?, error? }
#
# How the raise works, and why it is done this way:
#   DSH Desktop takes a single-instance lock. Starting DSH Desktop.exe while an
#   instance is already running therefore does NOT open a second window: the new
#   process hands off to the running one and exits, and the running instance
#   restores, shows and focuses its window. Starting it is also a no-op for page
#   state, because the shell only reloads the harness when the origin differs.
#
#   Measured on this machine: relaunch -> new PIDs appear, the existing window
#   becomes foreground within ~0.4 s, and the page is not reloaded.
#
# NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads a
# BOM-less .ps1 using the system ANSI code page; non-ASCII text gets mangled
# there and can swallow a newline, which corrupts the brace structure and fails
# with a bogus "unexpected token" error far below the real cause.

param(
  [string]$Scheme = 'dsh-turn-notify'
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$result = [ordered]@{ ok = $false; exe = $null; already = $false; error = $null }

function Write-Result {
  param($obj)
  try { [Console]::Out.Write(($obj | ConvertTo-Json -Compress -Depth 4)) } catch { }
}

function Get-DshExe {
  # The Start Menu shortcut is the authoritative mapping: it is what gives DSH
  # Desktop its AUMID, so it is also the most reliable way back to the binary.
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

$exe = Get-DshExe
if (-not $exe) {
  $result.error = 'cannot locate DSH Desktop.exe'
  Write-Result $result
  exit 0
}
$result.exe = $exe

try {
  # Remember whether a window already existed: "launched" and "raised" are
  # different facts and the caller may want to tell them apart.
  $before = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
              Where-Object { $_.MainWindowHandle -ne 0 }).Count
  $result.already = ($before -gt 0)

  Start-Process -FilePath $exe
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
}

Write-Result $result
exit 0
