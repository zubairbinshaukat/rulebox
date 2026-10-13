<#
.SYNOPSIS
  Installs the Rulebox agent from a folder of debug binaries onto a TEST VM.

.DESCRIPTION
  Run this INSIDE the test VM, in an elevated PowerShell, from a folder that
  contains rulebox-agent.exe, rulebox-shell.exe and fake_staff.exe (and
  optionally rulebox-staff.exe). Phase 2 plan, Step 14.

  What it does:
    1. Refuses to run unless the test-machine marker is present and matches this
       computer's name. It NEVER creates the marker; you do that by hand.
    2. Creates %ProgramFiles%\Rulebox\versions\0.0.0-dev\.
    3. Copies rulebox-agent.exe and rulebox-shell.exe to %ProgramFiles%\Rulebox\.
    4. Copies rulebox-staff.exe (if present) or else fake_staff.exe to
       versions\0.0.0-dev\rulebox-staff.exe, and always fake_staff.exe next to it
       (for the pipe probe).
    5. Writes current.json.
    6. Runs `rulebox-agent.exe service install`.
    7. With -FixtureDirectory: stops the service, writes
       %ProgramData%\Rulebox\state\agent-config.json with
       { "fixtureDirectory": true } (other keys kept), starts the service again.

  It changes this machine. Take a VM snapshot first.

.PARAMETER SourceDir
  Folder with the binaries. Defaults to the folder this script is in.

.PARAMETER FixtureDirectory
  Turn on the demo employee directory (honoured only on a marked machine).
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$SourceDir = '',
    [switch]$FixtureDirectory
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 leaves $PSScriptRoot empty inside a parameter default
# in some hosts, so the default is resolved here instead.
if (-not $SourceDir) {
    $SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$markerKey = 'HKLM:\SOFTWARE\Rulebox\TestMachine'
$version = '0.0.0-dev'

function Fail([string]$message) {
    Write-Host ''
    Write-Host "STOPPED: $message" -ForegroundColor Red
    exit 1
}

# 1. The test-machine marker (created by the user, by hand; never by this script).
$marker = $null
try { $marker = (Get-ItemProperty -Path $markerKey -Name ComputerName -ErrorAction Stop).ComputerName } catch { }
if ($marker -ne $env:COMPUTERNAME) {
    Write-Host 'This machine is not marked as a Rulebox test machine.' -ForegroundColor Yellow
    Write-Host 'If (and only if) this is a throwaway VM, mark it yourself by running:'
    Write-Host ''
    Write-Host "  New-Item -Path 'HKLM:\SOFTWARE\Rulebox\TestMachine' -Force | Out-Null"
    Write-Host "  Set-ItemProperty 'HKLM:\SOFTWARE\Rulebox\TestMachine' -Name ComputerName -Value `$env:COMPUTERNAME"
    Write-Host ''
    Write-Host 'Then run this script again. The script will never do this for you.'
    Fail 'test-machine marker missing or for another computer name.'
}

# Inputs.
$agent = Join-Path $SourceDir 'rulebox-agent.exe'
$shell = Join-Path $SourceDir 'rulebox-shell.exe'
$fake = Join-Path $SourceDir 'fake_staff.exe'
$staff = Join-Path $SourceDir 'rulebox-staff.exe'
foreach ($required in @($agent, $shell)) {
    if (-not (Test-Path -LiteralPath $required)) { Fail "missing $required" }
}
if (-not (Test-Path -LiteralPath $staff) -and -not (Test-Path -LiteralPath $fake)) {
    Fail "need rulebox-staff.exe or fake_staff.exe in $SourceDir"
}

# 2. and 3. Install folder and binaries.
$install = Join-Path $env:ProgramFiles 'Rulebox'
$versionDir = Join-Path $install "versions\$version"
New-Item -ItemType Directory -Path $versionDir -Force | Out-Null

$service = Get-Service -Name RuleboxAgent -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Stopped') {
    Write-Host 'Stopping the running RuleboxAgent service to replace its binary...'
    Stop-Service -Name RuleboxAgent -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}

Copy-Item -LiteralPath $agent -Destination (Join-Path $install 'rulebox-agent.exe') -Force
Copy-Item -LiteralPath $shell -Destination (Join-Path $install 'rulebox-shell.exe') -Force

# 4. The Staff App: the real one if it is here, otherwise the stand-in.
$staffTarget = Join-Path $versionDir 'rulebox-staff.exe'
if (Test-Path -LiteralPath $staff) {
    Copy-Item -LiteralPath $staff -Destination $staffTarget -Force
    $staffUsed = 'rulebox-staff.exe (the real Staff App)'
} else {
    Copy-Item -LiteralPath $fake -Destination $staffTarget -Force
    $staffUsed = 'fake_staff.exe (the stand-in console program)'
}
if (Test-Path -LiteralPath $fake) {
    Copy-Item -LiteralPath $fake -Destination (Join-Path $versionDir 'fake_staff.exe') -Force
}

# The debug binaries link the Visual C++ runtime dynamically, and a fresh Windows
# does not have it (the program fails with 0xC0000135). If the runtime DLLs are in
# the source folder, put them next to every binary (app-local deployment).
$runtimeDlls = @(Get-ChildItem -LiteralPath $SourceDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(vcruntime140(_1)?|msvcp140(_1|_2)?|concrt140)\.dll$' })
foreach ($dll in $runtimeDlls) {
    Copy-Item -LiteralPath $dll.FullName -Destination $install -Force
    Copy-Item -LiteralPath $dll.FullName -Destination $versionDir -Force
}
if ($runtimeDlls.Count -gt 0) {
    Write-Host ("Copied the Visual C++ runtime next to the binaries: " + (($runtimeDlls | ForEach-Object Name) -join ', '))
}

# 5. current.json (UTF-8 without a byte-order mark).
$currentJson = '{ "version": "' + $version + '", "exe": "versions\\' + $version + '\\rulebox-staff.exe" }'
[System.IO.File]::WriteAllText((Join-Path $install 'current.json'), $currentJson, (New-Object System.Text.UTF8Encoding($false)))

# 6. Install (or update) the service.
Write-Host "Installing the service from $install ..."
& (Join-Path $install 'rulebox-agent.exe') service install
if ($LASTEXITCODE -ne 0) {
    Fail "service install failed with exit code $LASTEXITCODE (see the message above)."
}

# 7. Optional: the demo employee directory.
if ($FixtureDirectory) {
    $svc = Get-Service -Name RuleboxAgent
    if ($svc.Status -ne 'Stopped') {
        Stop-Service -Name RuleboxAgent -Force
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    $stateDir = Join-Path $env:ProgramData 'Rulebox\state'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $configPath = Join-Path $stateDir 'agent-config.json'
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    } else {
        $config = New-Object psobject
    }
    $config | Add-Member -NotePropertyName fixtureDirectory -NotePropertyValue $true -Force
    [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    Start-Service -Name RuleboxAgent
    Write-Host 'fixtureDirectory is on (demo employees).'
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Install folder : $install"
Write-Host "  Staff App      : $staffUsed"
Write-Host "  Service        : $((Get-Service -Name RuleboxAgent).Status)"
Write-Host 'Next: follow the checklist in docs\plans\phase-2-vm-checklist.md.'
