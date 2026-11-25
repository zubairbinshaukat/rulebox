param([string]$Msi, [string]$Dir, [string[]]$Tables, [switch]$Import)
# Windows PowerShell 5.1. Export MSI tables to .idt text files, or (-Import) import edited .idt files back.
$ErrorActionPreference = 'Stop'
try {
  $i = New-Object -ComObject WindowsInstaller.Installer
  $mode = 0; if ($Import) { $mode = 1 }
  $db = $i.OpenDatabase($Msi, $mode)
  foreach ($t in ($Tables -split ',')) {
    if ($Import) { $db.Import($Dir, "$t.idt"); Write-Output "imported $t" }
    else { $db.Export($t, $Dir, "$t.idt"); Write-Output "exported $t" }
  }
  if ($Import) { $db.Commit() }
} catch { Write-Output "ERROR: $($_.Exception.Message)"; exit 1 }
