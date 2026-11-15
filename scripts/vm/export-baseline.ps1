<#
.SYNOPSIS
  Read-only export of everything Rulebox's lockdown may change on a PC, into ONE text file.

.DESCRIPTION
  Phase 5, Step 21 (runs 8 and 9): the user runs this on the test VM before enrollment and again
  after "Disable kiosk" (or `rulebox-agent recover`), then compares the two files. They must be
  equal except for Rulebox's own folders and the Staff account.

  What it reads (and never changes):
    - the HKLM registry roots Rulebox writes (plan 4.8, `machinereg::ALLOWED_ROOTS`)
    - the Staff account's registry roots (plan 4.7, `staffreg::ALLOWED_ROOTS`), only when that
      account's hive is loaded already (it is never mounted here)
    - every service's start type, and the Rulebox agent service's permissions and privileges
    - the active App Control (Code Integrity) policy ids
    - the AppLocker policy XML (local and effective)
    - WLAN profile names and the WLAN filter list
    - printers, printer ports and per-machine printer connections
    - BCD `{current}`
    - the account lockout policy

  It writes exactly one file: the one named with -OutFile. Nothing else is created, changed,
  mounted, started or stopped. Secrets are never exported: the Winlogon `DefaultPassword` value
  is written as `<present>`, and no LSA secret is read.

  The output is sorted and has no timestamps, so two exports of an unchanged PC are identical:
      Compare-Object (Get-Content before.txt) (Get-Content after.txt)

.PARAMETER OutFile
  The file to write. It must not exist (use -Force to replace it).

.PARAMETER StaffUser
  The Staff account's name (default RuleboxStaff). Missing account: that section says so.

.PARAMETER Force
  Replace an existing -OutFile.

.EXAMPLE
  .\export-baseline.ps1 -OutFile C:\Temp\before.txt

.EXAMPLE
  .\export-baseline.ps1 -OutFile C:\Temp\after.txt -WhatIf
  Lists the sections it would export. Reads nothing and writes nothing.

.NOTES
  Run it from an elevated PowerShell on the TEST VM only (`rulebox-test-pro`). Never as part of
  a build or a test on the development PC. Windows PowerShell 5.1 or PowerShell 7.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutFile,
    [string]$StaffUser = 'RuleboxStaff',
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -- what Rulebox writes (keep in step with crates/rulebox-win32/src/{machinereg,staffreg}.rs) --

# HKLM keys exported with everything below them.
$MachineSubtrees = @(
    'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System',
    'SOFTWARE\Policies\Microsoft\Windows\OOBE',
    'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList',
    'SOFTWARE\Policies\Microsoft\Power\PowerSettings',
    'SOFTWARE\Policies\Microsoft\Windows NT\Printers',
    'SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions',
    'SOFTWARE\Policies\Microsoft\Windows\DataCollection',
    'SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization',
    'SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\RuleboxAgent',
    'SYSTEM\CurrentControlSet\Control\SafeBoot\Network\RuleboxAgent'
)
# HKLM keys exported without their subkeys (Rulebox writes single values there).
$MachineFlatKeys = @(
    'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon',
    'SYSTEM\CurrentControlSet\Control\SafeBoot\Option'
)
# Value names whose data is a secret: only "is it there" is exported.
$SecretValueNames = @('DefaultPassword')

# Keys of the Staff account's hive, exported with everything below them.
$StaffSubtrees = @(
    'Software\Microsoft\Windows\CurrentVersion\Policies\System',
    'Software\Microsoft\Windows\CurrentVersion\Policies\Explorer',
    'Software\Policies\Microsoft\Windows\System',
    'Software\Policies\Microsoft\Windows\Explorer',
    'Software\Policies\Microsoft\Windows\Control Panel\Desktop',
    'Software\Policies\Microsoft\Windows\RemovableStorageDevices',
    'Software\Policies\Microsoft\Office\16.0',
    'Control Panel\Accessibility',
    'Software\Microsoft\Windows NT\CurrentVersion\Windows',
    'Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced',
    'Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications',
    'Software\Microsoft\Windows\CurrentVersion\Run',
    'Software\Policies\Microsoft\Windows\WindowsCopilot',
    'Software\Policies\Microsoft\Windows\CloudContent',
    'Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects',
    'Control Panel\Desktop\WindowMetrics'
)

$Sections = @(
    'registry (HKLM roots of plan 4.8)',
    "registry (roots of plan 4.7 in the hive of $StaffUser, only if it is loaded)",
    'services (start types; the agent service''s permissions and privileges)',
    'App Control (active policy ids)',
    'AppLocker (local and effective policy XML)',
    'WLAN (profile names, filter list)',
    'printers (queues, ports, per-machine connections)',
    'BCD {current}',
    'account lockout policy'
)

if (-not $PSCmdlet.ShouldProcess($OutFile, 'write the read-only baseline export')) {
    # -WhatIf: say what would be exported; read nothing, write nothing.
    Write-Output "Would export to: $OutFile"
    $Sections | ForEach-Object { Write-Output "  - $_" }
    return
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated (Run as administrator) PowerShell: BCD and the service settings need it.'
}
if ((Test-Path -LiteralPath $OutFile) -and -not $Force) {
    throw "The file '$OutFile' exists. Name another file or add -Force."
}

$lines = New-Object System.Collections.Generic.List[string]

function Add-Section([string]$Title) {
    $lines.Add('')
    $lines.Add("## $Title")
}

function Format-RegValue($Key, [string]$Name) {
    $kind = $Key.GetValueKind($Name)
    $shown = if ($Name -eq '') { '(default)' } else { $Name }
    if ($SecretValueNames -contains $Name) {
        return "$shown|$kind|<present>"
    }
    $raw = $Key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $text = switch ($kind) {
        'Binary' { ($raw | ForEach-Object { $_.ToString('x2') }) -join '' }
        'MultiString' { ($raw -join ';') }
        default { [string]$raw }
    }
    return "$shown|$kind|$text"
}

# Reads one key (opened read-only) and, with -Recurse, everything below it.
function Export-RegKey($Root, [string]$RootName, [string]$Path, [bool]$Recurse) {
    $key = $Root.OpenSubKey($Path, $false)
    if ($null -eq $key) {
        $lines.Add("$RootName\$Path|<key absent>")
        return
    }
    try {
        $names = @($key.GetValueNames() | Sort-Object)
        if ($names.Count -eq 0) {
            $lines.Add("$RootName\$Path|<no values>")
        }
        foreach ($name in $names) {
            $lines.Add("$RootName\$Path|" + (Format-RegValue $key $name))
        }
        if ($Recurse) {
            foreach ($sub in @($key.GetSubKeyNames() | Sort-Object)) {
                Export-RegKey $Root $RootName "$Path\$sub" $true
            }
        }
    }
    finally {
        $key.Close()
    }
}

# Runs a read-only console tool and returns its lines; a tool that is missing or fails is a note.
function Get-ToolLines([string]$Exe, [string[]]$Arguments) {
    $command = Get-Command $Exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return @("<$Exe is not on this PC>")
    }
    try {
        $output = & $command.Source @Arguments 2>&1 | ForEach-Object { "$_".TrimEnd() } | Where-Object { $_ -ne '' }
        if ($LASTEXITCODE -ne 0) {
            return @("<$Exe $($Arguments -join ' ') ended with code $LASTEXITCODE>") + @($output)
        }
        return @($output)
    }
    catch {
        return @("<$Exe failed: $($_.Exception.Message)>")
    }
}

# -- 1. HKLM ----------------------------------------------------------------------------------
Add-Section 'registry HKLM'
$hklm = [Microsoft.Win32.Registry]::LocalMachine
foreach ($path in $MachineFlatKeys) { Export-RegKey $hklm 'HKLM' $path $false }
foreach ($path in $MachineSubtrees) { Export-RegKey $hklm 'HKLM' $path $true }

# -- 2. The Staff hive (never mounted here) ---------------------------------------------------
Add-Section "registry Staff hive ($StaffUser)"
$staffSid = $null
try {
    $account = New-Object Security.Principal.NTAccount("$env:COMPUTERNAME\$StaffUser")
    $staffSid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
}
catch {
    $lines.Add('<the Staff account does not exist>')
}
if ($null -ne $staffSid) {
    $users = [Microsoft.Win32.Registry]::Users
    $hive = $users.OpenSubKey($staffSid, $false)
    if ($null -eq $hive) {
        $lines.Add('<the Staff account is signed out: its hive is not loaded and is not mounted by this script>')
    }
    else {
        $hive.Close()
        # The SID differs between two VMs, so the lines say HKU\<Staff>.
        foreach ($path in $StaffSubtrees) { Export-RegKey $users 'HKU' "$staffSid\$path" $true }
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $lines[$i] = $lines[$i].Replace("HKU\$staffSid\", 'HKU\<Staff>\')
        }
    }
}

# -- 3. Services ------------------------------------------------------------------------------
Add-Section 'services (name|start mode|delayed)'
Get-CimInstance -ClassName Win32_Service -Property Name, StartMode, DelayedAutoStart |
    Sort-Object Name |
    ForEach-Object { $lines.Add("$($_.Name)|$($_.StartMode)|$($_.DelayedAutoStart)") }
Add-Section 'service RuleboxAgent (permissions, privileges)'
Get-ToolLines 'sc.exe' @('sdshow', 'RuleboxAgent') | ForEach-Object { $lines.Add("sdshow|$_") }
Get-ToolLines 'sc.exe' @('qprivs', 'RuleboxAgent') | ForEach-Object { $lines.Add("qprivs|$_") }

# -- 4. App Control ---------------------------------------------------------------------------
Add-Section 'App Control (active policy files)'
$active = Join-Path $env:windir 'System32\CodeIntegrity\CiPolicies\Active'
if (Test-Path -LiteralPath $active) {
    $files = @(Get-ChildItem -LiteralPath $active -Filter '*.cip' -File | Sort-Object Name)
    if ($files.Count -eq 0) { $lines.Add('<no policy file>') }
    foreach ($file in $files) { $lines.Add("$($file.Name)|$($file.Length) bytes") }
}
else {
    $lines.Add('<the active policy folder does not exist>')
}

# -- 5. AppLocker -----------------------------------------------------------------------------
foreach ($scope in @('Local', 'Effective')) {
    Add-Section "AppLocker ($scope)"
    try {
        $xml = if ($scope -eq 'Local') { Get-AppLockerPolicy -Local -Xml } else { Get-AppLockerPolicy -Effective -Xml }
        $lines.Add($xml)
    }
    catch {
        $lines.Add("<Get-AppLockerPolicy failed: $($_.Exception.Message)>")
    }
}

# -- 6. WLAN ----------------------------------------------------------------------------------
Add-Section 'WLAN profiles'
Get-ToolLines 'netsh.exe' @('wlan', 'show', 'profiles') | ForEach-Object { $lines.Add($_) }
Add-Section 'WLAN filters'
Get-ToolLines 'netsh.exe' @('wlan', 'show', 'filters') | ForEach-Object { $lines.Add($_) }

# -- 7. Printers ------------------------------------------------------------------------------
Add-Section 'printers (name|driver|port|comment|shared)'
try {
    Get-Printer | Sort-Object Name | ForEach-Object {
        $lines.Add("$($_.Name)|$($_.DriverName)|$($_.PortName)|$($_.Comment)|$($_.Shared)")
    }
}
catch { $lines.Add("<Get-Printer failed: $($_.Exception.Message)>") }
Add-Section 'printer ports'
try {
    Get-PrinterPort | Sort-Object Name | ForEach-Object { $lines.Add("$($_.Name)|$($_.Description)") }
}
catch { $lines.Add("<Get-PrinterPort failed: $($_.Exception.Message)>") }
Add-Section 'printer connections (per machine)'
Export-RegKey $hklm 'HKLM' 'SYSTEM\CurrentControlSet\Control\Print\Connections' $true

# -- 8. BCD -----------------------------------------------------------------------------------
Add-Section 'BCD {current}'
Get-ToolLines 'bcdedit.exe' @('/enum', '{current}') | ForEach-Object { $lines.Add($_) }

# -- 9. Account lockout -----------------------------------------------------------------------
Add-Section 'account lockout policy'
Get-ToolLines 'net.exe' @('accounts') | ForEach-Object { $lines.Add($_) }

# -- the one write ----------------------------------------------------------------------------
$header = @(
    '# Rulebox baseline export (read-only). Compare two of these with Compare-Object.',
    "# Sections: $($Sections.Count). No timestamps, no secrets."
)
[System.IO.File]::WriteAllLines($OutFile, [string[]]($header + $lines), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "Wrote $($lines.Count) lines to $OutFile"
