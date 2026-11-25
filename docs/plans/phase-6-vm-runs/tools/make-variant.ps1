param([string]$Version, [switch]$ForceFail, [switch]$FixDiskCheck, [string]$Base = 'Rulebox-0.1.0-x64-fixed.msi', [string]$Name, [switch]$EventSource)
# Makes Rulebox-<Version>-x64-test.msi from the CI-built 0.1.0 MSI: new ProductCode, PackageCode,
# ProductVersion and Upgrade rows (a real major upgrade of 0.1.0). Same files inside.
# -ForceFail adds a deferred, elevated cmd.exe /c exit 1 just before InstallFinalize, so the
# install fails after the old product was removed and the files and service were put in place.
$ErrorActionPreference = 'Stop'
$sp = $PSScriptRoot
$base = Join-Path $sp $Base
if (-not $Name) { $Name = "Rulebox-$Version-x64-test.msi" }; $out = Join-Path $sp $Name
$dir = Join-Path $sp "idt-$Version"
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item $base $out -Force
$tables = 'Upgrade,Property,_SummaryInformation,CustomAction,InstallExecuteSequence,LaunchCondition,Registry'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $sp 'msiidt.ps1') -Msi $out -Dir $dir -Tables $tables
if ($LASTEXITCODE -ne 0) { throw 'export failed' }
$enc = [Text.Encoding]::GetEncoding(1252)
function Edit-Idt($name, [scriptblock]$change) {
  $p = Join-Path $dir "$name.idt"
  $lines = [IO.File]::ReadAllLines($p, $enc)
  $new = & $change $lines
  [IO.File]::WriteAllLines($p, [string[]]$new, $enc)
}
$productCode = '{' + [guid]::NewGuid().ToString().ToUpper() + '}'
$packageCode = '{' + [guid]::NewGuid().ToString().ToUpper() + '}'
Edit-Idt 'Property' { param($l) $l | ForEach-Object {
  if ($_ -like "ProductVersion`t*") { "ProductVersion`t$Version" }
  elseif ($_ -like "ProductCode`t*") { "ProductCode`t$productCode" }
  else { $_ } } }
Edit-Idt 'Upgrade' { param($l) $l | ForEach-Object { $_ -replace "`t0\.1\.0`t", "`t$Version`t" } }
Edit-Idt '_SummaryInformation' { param($l) $l | ForEach-Object { if ($_ -like "9`t*") { "9`t$packageCode" } else { $_ } } }
if ($FixDiskCheck) {
  Edit-Idt 'LaunchCondition' { param($l) $l | Where-Object { $_ -notlike '*PrimaryVolumeSpaceAvailable*' } }
}
if ($EventSource) {
  $k = 'SYSTEM\CurrentControlSet\Services\EventLog\Application\Rulebox Agent'
  Edit-Idt 'Registry' { param($l) $l; "RbEvtMsg`t2`t$k`tEventMessageFile`t#%%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\EventLogMessages.dll`tInstallMarker"; "RbEvtTypes`t2`t$k`tTypesSupported`t#7`tInstallMarker"; "RbEvtKey`t2`t$k`t-`t`tInstallMarker" }
}
if ($ForceFail) {
  Edit-Idt 'CustomAction' { param($l) $l; "RbForceFailForTest`t3106`tINSTALLFOLDER`t`"[SystemFolder]cmd.exe`" /c exit 1`t" }
  Edit-Idt 'InstallExecuteSequence' { param($l) $l; "RbForceFailForTest`tNOT REMOVE~=`"ALL`"`t6590" }
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $sp 'msiidt.ps1') -Msi $out -Dir $dir -Tables $tables -Import
if ($LASTEXITCODE -ne 0) { throw 'import failed' }
"$out ProductCode=$productCode PackageCode=$packageCode"



