# Host-side helpers for the Phase 6 VM spike. Dot-source in each call.
$ErrorActionPreference = 'Continue'
$vm   = 'rulebox-test-pro'
$cred = Import-Clixml 'D:\work\hypervisor\rbtest.cred.xml'
$ev   = 'D:\work\personal\rulebox\docs\plans\phase-6-vm-runs'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$edge   = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$prof   = 'C:\Users\spikestaff\AppData\Local\rb-spike'

function Open-Spike {
  param([int]$TimeoutSec = 300)
  $end = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $end) {
    try { $script:s = New-PSSession -VMName $vm -Credential $cred -ErrorAction Stop; return $script:s } catch { Start-Sleep 5 }
  }
  throw 'no PowerShell Direct session'
}

function Restore-Spike {
  param([string]$Name = 'run22-base')
  if ((Get-VM $vm).State -ne 'Off') {
    try { $t = New-PSSession -VMName $vm -Credential $cred -ErrorAction Stop; Invoke-Command -Session $t { Stop-Computer -Force } -ErrorAction SilentlyContinue } catch {}
    $end = (Get-Date).AddMinutes(4)
    while ((Get-VM $vm).State -ne 'Off' -and (Get-Date) -lt $end) { Start-Sleep 3 }
    if ((Get-VM $vm).State -ne 'Off') { Stop-VM $vm -Force }   # only after a graceful attempt
  }
  Restore-VMSnapshot -VMName $vm -Name $Name -Confirm:$false
  Start-VM $vm
  Start-Sleep 30
  Open-Spike | Out-Null
}

function Save-VMShot {
  param([string]$Name)
  $ms = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemManagementService
  $vs = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemSettingData |
        Where-Object { $_.ElementName -eq $vm -and $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' }
  $w = 1024; $h = 768
  $r = Invoke-CimMethod -InputObject $ms -MethodName GetVirtualSystemThumbnailImage -Arguments @{ TargetSystem = $vs; WidthPixels = [uint16]$w; HeightPixels = [uint16]$h }
  if ($r.ReturnValue -ne 0) { return "thumbnail failed $($r.ReturnValue)" }
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
  [byte[]]$img = $r.ImageData
  $n = [math]::Min($img.Length, $bd.Stride * $h)
  [Runtime.InteropServices.Marshal]::Copy($img, 0, $bd.Scan0, [int]$n)
  $bmp.UnlockBits($bd)
  $p = Join-Path $ev "$Name.png"
  $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  $p
}

function Get-VMKeyboard { Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_Keyboard | Where-Object SystemName -eq (Get-VM $vm).Id.Guid.ToUpper() }
function Send-VMKey { param([int]$Vk) $k = Get-VMKeyboard; Invoke-CimMethod -InputObject $k -MethodName TypeKey -Arguments @{ keyCode = $Vk } | Out-Null }
function Send-VMCombo { param([int[]]$Hold, [int]$Vk)
  $k = Get-VMKeyboard
  foreach ($h in $Hold) { Invoke-CimMethod -InputObject $k -MethodName PressKey -Arguments @{ keyCode = $h } | Out-Null }
  Invoke-CimMethod -InputObject $k -MethodName TypeKey -Arguments @{ keyCode = $Vk } | Out-Null
  foreach ($h in $Hold) { Invoke-CimMethod -InputObject $k -MethodName ReleaseKey -Arguments @{ keyCode = $h } | Out-Null }
}
function Send-VMText { param([string]$Text)   # a-z 0-9 . : / - only
  foreach ($ch in $Text.ToCharArray()) {
    switch -CaseSensitive ($ch) {
      ':' { Send-VMCombo -Hold 0x10 -Vk 0xBA }
      '/' { Send-VMKey 0xBF }
      '.' { Send-VMKey 0xBE }
      '-' { Send-VMKey 0xBD }
      default { Send-VMKey ([int][char]([string]$ch).ToUpper()) }
    }
  }
}
function Send-VMClick { param([int]$X, [int]$Y)   # guest pixels 1024x768
  $m = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_SyntheticMouse | Where-Object SystemName -eq (Get-VM $vm).Id.Guid.ToUpper()
  Invoke-CimMethod -InputObject $m -MethodName SetAbsolutePosition -Arguments @{ horizontalPosition = $X; verticalPosition = $Y } | Out-Null
  Start-Sleep -Milliseconds 300
  Invoke-CimMethod -InputObject $m -MethodName ClickButton -Arguments @{ buttonIndex = 1 } | Out-Null
}

# ---- plan section 0.4 helpers (use $script:s) ----
function Start-SpikeUser {
  param([string]$Exe, [string]$ArgText = '', [string]$User = 'spikestaff')
  Invoke-Command -Session $s -ArgumentList $Exe, $ArgText, $User {
    param($e, $a, $u)
    $act = if ($a) { New-ScheduledTaskAction -Execute $e -Argument $a } else { New-ScheduledTaskAction -Execute $e }
    $pri = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive
    $name = 'rb-spike-user-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    Register-ScheduledTask -TaskName $name -Action $act -Principal $pri -Force | Out-Null
    Start-ScheduledTask -TaskName $name
  }
}
function Start-SpikeSystem {
  param([string]$Tag, [string]$Exe, [string]$ArgText = '')
  $json = [pscustomobject]@{ exe = $Exe; args = $ArgText } | ConvertTo-Json
  Invoke-Command -Session $s -ArgumentList $Tag, $json {
    param($t, $j)
    Remove-Item "C:\rb-run\out\$t.txt" -ErrorAction SilentlyContinue
    Set-Content "C:\rb-run\in\$t.json" $j
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\rb-run\run-wait.ps1 -Tag $t"
    $pri = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName "rb-spike-sys-$t" -Action $act -Principal $pri -Settings $set -Force | Out-Null
    Start-ScheduledTask -TaskName "rb-spike-sys-$t"
  }
}
function Wait-SpikeSystem {
  param([string]$Tag, [int]$TimeoutSec = 900)
  $end = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $end) {
    $r = Invoke-Command -Session $s -ArgumentList $Tag { param($t) if (Test-Path "C:\rb-run\out\$t.txt") { Get-Content "C:\rb-run\out\$t.txt" } }
    if ($r) { return $r }
    Start-Sleep 5
  }
  'timed out'
}
function Save-SpikeSnapshot {
  param([string]$Name)
  Invoke-Command -Session $s -ArgumentList $Name {
    param($n)
    $roots = 'C:\Program Files', 'C:\Program Files (x86)', 'C:\ProgramData',
             'C:\Windows\System32\config\systemprofile\AppData', 'C:\Users\spikestaff\AppData'
    $out = foreach ($r in $roots) {
      Get-ChildItem $r -Directory -Recurse -Depth 3 -Force -ErrorAction SilentlyContinue | ForEach-Object { 'DIR  ' + $_.FullName }
      Get-ChildItem $r -File -Recurse -Depth 5 -Force -Include *.exe, *.lnk -ErrorAction SilentlyContinue | ForEach-Object { 'FILE ' + $_.FullName }
    }
    $uk = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
          'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
          'Registry::HKEY_USERS\.DEFAULT\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    $out += foreach ($k in $uk) {
      Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath
        "UNINST $($_.Name) | $($p.DisplayName) | $($p.DisplayVersion) | $($p.InstallLocation) | $($p.UninstallString)"
      }
    }
    $out += Get-Process | ForEach-Object { 'PROC ' + $_.ProcessName } | Sort-Object -Unique
    $out | Set-Content "C:\rb-run\out\snap-$n.txt"
  }
}
function Compare-SpikeSnapshot {
  param([string]$A, [string]$B)
  Invoke-Command -Session $s -ArgumentList $A, $B {
    param($a, $b)
    Compare-Object (Get-Content "C:\rb-run\out\snap-$a.txt") (Get-Content "C:\rb-run\out\snap-$b.txt") |
      Where-Object SideIndicator -eq '=>' | ForEach-Object InputObject
  }
}
function Set-SpikePolicy {
  param([ValidateSet('chrome', 'edge')][string]$Browser, [string]$Name, $Value,
        [string]$List = '', [ValidateSet('hive', 'machine')][string]$Where = 'hive')
  Invoke-Command -Session $s -ArgumentList $Browser, $Name, $Value, $List, $Where {
    param($b, $n, $v, $l, $w)
    $sid  = (New-Object Security.Principal.NTAccount('spikestaff')).Translate([Security.Principal.SecurityIdentifier]).Value
    $root = if ($w -eq 'hive') { "Registry::HKEY_USERS\$sid\Software\Policies" } else { 'HKLM:\SOFTWARE\Policies' }
    $key  = if ($b -eq 'chrome') { "$root\Google\Chrome" } else { "$root\Microsoft\Edge" }
    if ($l) { $key = "$key\$l" }
    if (-not (Test-Path $key)) { New-Item $key -Force | Out-Null }   # -Force on an existing key wipes its values
    $type = if ($v -is [int]) { 'DWord' } else { 'String' }
    New-ItemProperty -Path $key -Name $n -Value $v -PropertyType $type -Force | Out-Null
    "$key  $n = $v"
  }
}
function Get-SpikeBrowserMemory {
  param([ValidateSet('chrome', 'msedge')][string]$Name)
  Invoke-Command -Session $s -ArgumentList $Name {
    param($n)
    $p  = Get-Process -Name $n -ErrorAction SilentlyContinue
    $pw = (Get-Counter "\Process($n)\Working Set - Private", "\Process($n#*)\Working Set - Private" -ErrorAction SilentlyContinue).CounterSamples |
          Measure-Object CookedValue -Sum
    [pscustomobject]@{
      Browser = $n; Processes = @($p).Count
      WorkingSetMB        = [math]::Round(($p | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
      PrivateWorkingSetMB = [math]::Round($pw.Sum / 1MB)
      FreeRamMB           = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB)
    }
  }
}
function Read-SpikeAumid {
  param([string]$Tag)
  Start-SpikeUser 'powershell.exe' "-NoProfile -WindowStyle Hidden -Command `"Add-Type -TypeDefinition (Get-Content -Raw C:\rb-run\WinAumid.cs); [WinAumid]::Dump() | Set-Content C:\rb-run\out\$Tag.txt`""
  Start-Sleep 10
  Invoke-Command -Session $s -ArgumentList $Tag { param($t) Get-Content "C:\rb-run\out\$t.txt" }
}
function Save-SpikeOut {
  param([string]$Pattern = '*')
  New-Item -ItemType Directory -Force $ev | Out-Null
  Copy-Item -FromSession $s "C:\rb-run\out\$Pattern" $ev -Recurse -Force
}

function Invoke-VM { param([scriptblock]$Block, [object[]]$Args2 = @()) Invoke-Command -Session $script:s -ScriptBlock $Block -ArgumentList $Args2 }
# Runs a command line as SYSTEM (session 0) or as rbtest (interactive, elevated or not) through a
# scheduled task; the wrapper writes C:\rb-run\out\<tag>.txt with exit code and times when it ends.
function Start-RunTask {
  param([string]$Tag, [string]$Exe, [string]$ArgText = '', [ValidateSet('system','rbtest-high','rbtest-limited')][string]$As = 'system')
  $json = [pscustomobject]@{ exe = $Exe; args = $ArgText } | ConvertTo-Json
  Invoke-Command -Session $s -ArgumentList $Tag, $json, $As {
    param($t, $j, $as)
    Remove-Item "C:\rb-run\out\$t.txt" -ErrorAction SilentlyContinue
    Set-Content "C:\rb-run\in\$t.json" $j
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\rb-run\run-wait.ps1 -Tag $t"
    $pri = switch ($as) {
      'system' { New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest }
      'rbtest-high' { New-ScheduledTaskPrincipal -UserId 'rbtest' -LogonType Interactive -RunLevel Highest }
      'rbtest-limited' { New-ScheduledTaskPrincipal -UserId 'rbtest' -LogonType Interactive -RunLevel Limited }
    }
    $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries
    Register-ScheduledTask -TaskName "rb-run-$t" -Action $act -Principal $pri -Settings $set -Force | Out-Null
    Start-ScheduledTask -TaskName "rb-run-$t"
  }
}
function Wait-RunTask {
  param([string]$Tag, [int]$TimeoutSec = 900)
  $end = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $end) {
    $r = Invoke-Command -Session $s -ArgumentList $Tag { param($t) if (Test-Path "C:\rb-run\out\$t.txt") { Get-Content "C:\rb-run\out\$t.txt" } }
    if ($r) { return $r }
    Start-Sleep 3
  }
  'timed out'
}
