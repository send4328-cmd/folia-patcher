# Prints the full path of Folia.exe, or nothing if it cannot be found.
$ErrorActionPreference = 'SilentlyContinue'

$keys = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($entry in Get-ItemProperty $keys) {
  if ($entry.DisplayName -like 'Folia*' -and $entry.InstallLocation) {
    $exe = Join-Path $entry.InstallLocation 'Folia.exe'
    if (Test-Path -LiteralPath $exe) { $exe; exit }
  }
}

$running = Get-Process Folia | Select-Object -First 1 -ExpandProperty Path
if ($running -and (Test-Path -LiteralPath $running)) { $running; exit }

$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Folia\Folia.exe'),
  (Join-Path $env:ProgramFiles 'Folia\Folia.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Folia\Folia.exe')
)
foreach ($drive in 'C','D','E','F','G') {
  $candidates += "${drive}:\Program Files\Folia\Folia.exe"
  $candidates += "${drive}:\Folia\Folia.exe"
}
foreach ($exe in $candidates) {
  if ($exe -and (Test-Path -LiteralPath $exe)) { $exe; exit }
}
