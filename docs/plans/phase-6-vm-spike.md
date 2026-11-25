# Phase 6 - VM spike (Step 2)

You run this on the test VM `rulebox-test-pro` (Windows 11 Pro, Hyper-V). Nothing here runs on the
dev laptop and nothing here is Rulebox code. This is the result file named in
`phase-6-installer-pilot.md` Step 2. The plan is the spec. This file is the checklist and the record.

Rules for this file:

- Every row is an **observation**, not an attack. Write down what you see, the evidence file name
  and the plan section that changes. Do not write down how to get around a control.
- Install nothing on the dev laptop. Everything installs inside the VM.
- A row that cannot be observed gets `NOT OBSERVED` and the reason. That is allowed (plan Step 2).
- Do not keep the VM state. Revert to a checkpoint at the end ("After" below).

Result values:

| Value | Meaning |
|---|---|
| PASS | What the plan assumed is true. The plan text stays. |
| DIFFERS | What the plan assumed is wrong or incomplete. Put the observed value in Notes and change the plan section named in the row. |
| NOT OBSERVED | Could not run. Say why. The "Decides" section then keeps its plan default and stays marked "unverified". |

Windows edition, version and build tested: ______

Chrome version: ______   Edge version: ______   Date of run: ______

---

## 0. Before you start

### 0.1 What to copy in

Put these on the host first (any folder). They are copied into the VM in 0.3.

| File | Used by |
|---|---|
| Chrome per-machine installer: `GoogleChromeStandaloneEnterprise64.msi` (the enterprise MSI; per machine, like the catalogue app) | S-7, S-5, S-1 to S-4 |
| Edge per-machine installer: `MicrosoftEdgeEnterpriseX64.msi` (Windows 11 already has Edge; this brings it to the current build) | S-7, S-5, S-1 to S-4 |
| Zahras POS NSIS build, **per machine** (file name: ______) | S-8 |
| Zahras POS NSIS build, **per user** (file name: ______) | S-9 |
| `TPCL-drv_11.10.0_E.exe` and any vendor readme or install guide for it | S-10, S-11 |

Costs: the VM needs the host to have about 4.6 GB RAM free. Copying the files and the checkpoints
use host disk (D: is tight, about 22 GB free). Check before you start. The VM needs internet through
the Default Switch (the browsers load `example.org` and `example.com`).

A Windows 10 VM is **not** needed. S-7 is run on Windows 11 only and the Windows 10 half is
`NOT OBSERVED` unless you already have a Windows 10 22H2 (build 19045) machine. A new Windows 10 VM
means a multi-GB ISO and disk, so only do it if the pilot has Windows 10 PCs.

### 0.2 Plan for checkpoints

Several rows install software and change state. Use one base checkpoint `spike-base` and revert to
it before each group:

| Group | Rows | Order inside the group |
|---|---|---|
| A | S-7, S-5, S-3, S-4, S-1, S-2 | In this order (S-7 is the Chrome and Edge install itself; S-1 and S-2 come last because they write policy values) |
| B | S-6 | alone |
| C1 | S-8 | alone |
| C2 | S-9 | alone |
| D1 | S-10 | alone |
| D2 | S-11 | alone |
| E | S-12 | alone |

Revert command (VM off, host elevated PowerShell):
`Restore-VMSnapshot -VMName rulebox-test-pro -Name 'spike-base' -Confirm:$false`, then `Start-VM rulebox-test-pro`.
Always shut the VM down **gracefully** from inside (`Invoke-Command -Session $s { Stop-Computer }`). A forced
restart once zeroed copied files (Phase 3 and Phase 5).

### 0.3 Build the base (once)

Host, elevated PowerShell:

```powershell
$vm   = 'rulebox-test-pro'
$cred = Import-Clixml 'D:\work\hypervisor\rbtest.cred.xml'     # rbtest, local admin
Get-PSDrive C, D                                               # D: more than 10 GB free
Stop-VM $vm -ErrorAction SilentlyContinue                      # only if it is running
Restore-VMSnapshot -VMName $vm -Name 'fresh-windows-11-pro' -Confirm:$false
Start-VM $vm
# wait about a minute for the sign-in screen, then:
$s = New-PSSession -VMName $vm -Credential $cred
Invoke-Command -Session $s { whoami; Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' | Select-Object ProductName, DisplayVersion, CurrentBuild, UBR }
```

Write the build at the top of this file. Then make the folders, the test standard account
`spikestaff` (stands in for the Staff account; it only exists in this VM) and the helper script:

```powershell
Invoke-Command -Session $s { New-Item -ItemType Directory -Force C:\rb-spike\in, C:\rb-spike\out | Out-Null }
$pw = Read-Host 'Password for the VM test account spikestaff' -AsSecureString
Invoke-Command -Session $s -ArgumentList $pw {
  param($p)
  New-LocalUser -Name spikestaff -Password $p -PasswordNeverExpires -AccountNeverExpires | Out-Null
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member spikestaff        # Users, a standard account
  icacls C:\rb-spike /grant 'spikestaff:(OI)(CI)M' | Out-Null
}

# Wrapper that runs one program, waits for it, and writes the result file (used for SYSTEM runs).
$runWait = @'
param([string]$Tag)
$job = Get-Content -Raw "C:\rb-spike\in\$Tag.json" | ConvertFrom-Json
$t0  = Get-Date
$sp  = @{ FilePath = $job.exe; PassThru = $true }
if ($job.args) { $sp.ArgumentList = $job.args }
$p = Start-Process @sp
$null = $p.Handle
$p.WaitForExit()
Start-Sleep 10
$left = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID -and $_.StartTime -ge $t0 } |
        Select-Object Name, Id, SessionId, StartTime | Format-Table -AutoSize | Out-String
@(
  "tag=$Tag", "who=$(whoami)", "session=$([Diagnostics.Process]::GetCurrentProcess().SessionId)",
  "exe=$($job.exe)", "args=$($job.args)",
  "start=$($t0.ToString('o'))", "end=$((Get-Date).ToString('o'))", "exit=$($p.ExitCode)",
  "processes started since start (10 s after exit):", $left
) | Set-Content "C:\rb-spike\out\$Tag.txt"
'@
Invoke-Command -Session $s -ArgumentList $runWait { param($t) Set-Content C:\rb-spike\run-wait.ps1 $t }
```

Copy the files in and compare hashes (change the names to yours):

```powershell
$files = 'D:\path\GoogleChromeStandaloneEnterprise64.msi', 'D:\path\MicrosoftEdgeEnterpriseX64.msi',
         'D:\path\<zahras-machine>.exe', 'D:\path\<zahras-user>.exe', 'D:\path\TPCL-drv_11.10.0_E.exe'
Copy-Item $files -Destination C:\rb-spike\in -ToSession $s
Get-FileHash $files | Select-Object Hash, Path
Invoke-Command -Session $s { Get-FileHash C:\rb-spike\in\* | Select-Object Hash, Path }
```

Hashes must match. Now, **in the VM window**, sign in once as `spikestaff` (use "Other user"; type the
password by hand, there is no clipboard), wait for the desktop, then sign out. This creates the profile.
Then power off cleanly and take the checkpoint:

```powershell
Invoke-Command -Session $s { Stop-Computer }
# wait until (Get-VM $vm).State is Off
Checkpoint-VM -Name $vm -SnapshotName 'spike-base'
```

### 0.4 Helpers (define again after every revert)

After each revert: `Start-VM`, wait a minute, then `$s = New-PSSession -VMName $vm -Credential $cred`
and paste the helpers below. Rows that need a browser or a user-session program also need you to sign in
as `spikestaff` **in the VM window** and leave the desktop open (passwords typed by hand).

```powershell
# Run a program in the spikestaff desktop (needs spikestaff signed in at the VM console).
function Start-SpikeUser {
  param([string]$Exe, [string]$ArgText = '')
  Invoke-Command -Session $s -ArgumentList $Exe, $ArgText {
    param($e, $a)
    $act = if ($a) { New-ScheduledTaskAction -Execute $e -Argument $a } else { New-ScheduledTaskAction -Execute $e }
    $pri = New-ScheduledTaskPrincipal -UserId 'spikestaff' -LogonType Interactive
    $name = 'rb-spike-user-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    Register-ScheduledTask -TaskName $name -Action $act -Principal $pri -Force | Out-Null
    Start-ScheduledTask -TaskName $name
  }
}

# Run a program as SYSTEM, wait for it to end, write C:\rb-spike\out\<Tag>.txt (exit code, user, session).
function Start-SpikeSystem {
  param([string]$Tag, [string]$Exe, [string]$ArgText = '')
  $json = [pscustomobject]@{ exe = $Exe; args = $ArgText } | ConvertTo-Json
  Invoke-Command -Session $s -ArgumentList $Tag, $json {
    param($t, $j)
    Remove-Item "C:\rb-spike\out\$t.txt" -ErrorAction SilentlyContinue
    Set-Content "C:\rb-spike\in\$t.json" $j
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\rb-spike\run-wait.ps1 -Tag $t"
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
    $r = Invoke-Command -Session $s -ArgumentList $Tag { param($t) if (Test-Path "C:\rb-spike\out\$t.txt") { Get-Content "C:\rb-spike\out\$t.txt" } }
    if ($r) { return $r }
    Start-Sleep 5
  }
  'timed out: see "If a SYSTEM run hangs" at the end of section 0'
}

# Before/after list of folders, exes, shortcuts, uninstall entries and process names.
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
    $out | Set-Content "C:\rb-spike\out\snap-$n.txt"
  }
}
function Compare-SpikeSnapshot {          # shows only what was added
  param([string]$A, [string]$B)
  Invoke-Command -Session $s -ArgumentList $A, $B {
    param($a, $b)
    Compare-Object (Get-Content "C:\rb-spike\out\snap-$a.txt") (Get-Content "C:\rb-spike\out\snap-$b.txt") |
      Where-Object SideIndicator -eq '=>' | ForEach-Object InputObject
  }
}
```

Paths used below:

```powershell
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$edge   = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$prof   = 'C:\Users\spikestaff\AppData\Local\rb-spike'      # browser profiles for the spike
```

Screenshots: Snipping Tool inside the VM window, saved as `C:\rb-spike\out\<row>-<what>.png`
(`spikestaff` can write there).

### 0.5 If a SYSTEM run hangs

`Stop-ScheduledTask -TaskName rb-spike-sys-<tag>` inside `Invoke-Command -Session $s { ... }`, then
`Get-Process <name> | Stop-Process -Force` in the same way. Write "needs interaction" in Notes, with the
CPU numbers you took. Revert before the next attempt.

---

## Group A - browsers (S-7, S-5, S-3, S-4, S-1, S-2)

Start: revert to `spike-base`, helpers defined, then sign in as `spikestaff` in the VM window and leave
the desktop open for the whole group.

## S-7. MSI log on Windows 11: `VersionNT`, `WindowsBuild`, `CurrentBuildNumber`

**Decides:** 4.10 launch conditions (`CurrentBuildNumber` RegistrySearch, build >= 19045).

Without WiX or any Rulebox MSI, this row uses the Chrome and Edge MSIs you copied in. They are real MSIs;
their verbose log lists the Windows Installer properties. This is the Chrome and Edge install for the
rest of Group A.

1. Install Chrome and Edge per machine, with verbose logs:

   ```powershell
   Invoke-Command -Session $s {
     $c = Start-Process msiexec.exe '/i C:\rb-spike\in\GoogleChromeStandaloneEnterprise64.msi /qn /norestart /l*v C:\rb-spike\out\s7-chrome.log' -Wait -PassThru
     $e = Start-Process msiexec.exe '/i C:\rb-spike\in\MicrosoftEdgeEnterpriseX64.msi /qn /norestart /l*v C:\rb-spike\out\s7-edge.log' -Wait -PassThru
     "chrome exit $($c.ExitCode), edge exit $($e.ExitCode)"      # 0 or 3010 is fine
   }
   ```

2. Read the properties from the logs:

   ```powershell
   Invoke-Command -Session $s {
     Select-String -Path C:\rb-spike\out\s7-chrome.log -Pattern 'Property\(S\): (VersionNT|VersionNT64|WindowsBuild|MsiNTProductType|Privileged|ALLUSERS) =' |
       Select-Object -Unique -ExpandProperty Line
     $k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
     Get-ItemProperty $k | Select-Object CurrentBuildNumber, CurrentBuild, UBR, CurrentMajorVersionNumber
     (Get-Item $k).GetValueKind('CurrentBuildNumber')
     reg query 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion' /v CurrentBuildNumber /reg:64
     reg query 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion' /v CurrentBuildNumber /reg:32
   }
   ```

3. Write down the browser versions (top of this file):
   `(Get-Item $chrome).VersionInfo.FileVersion` and the same for `$edge`, inside `Invoke-Command`.

4. Windows 10 half: only if you have a Windows 10 22H2 machine. Install Chrome's MSI there the same way
   and run step 2. Otherwise `NOT OBSERVED (no Windows 10 machine)`.

**Pass:**
- Log shows `VersionNT = 603` (and `VersionNT64 = 603`) on Windows 11 and `WindowsBuild` equal to
  `CurrentBuildNumber`.
- `CurrentBuildNumber` is a REG_SZ made of digits only, and the 32-bit and 64-bit views agree.

**Differs:** `VersionNT` is 1000 or higher, or `WindowsBuild` is missing or different from the registry,
or the value is not plain digits.

**Plan change on DIFFERS:** 4.10 "Launch conditions": use whatever is reliable (`WindowsBuild`
property, or the registry value as string-to-number) and drop the wrong one. On PASS 4.10 stays as written.
Note in Notes: the RegistrySearch **inside a WiX-built MSI** is not observable here; Step 7 repeats it with
the real MSI.

## S-5. Signers, paths and accounts of the Chrome and Edge updaters

**Decides:** 4.4.3 publisher values (`subject`, `publisherProduct`) and the line "the updater itself runs as SYSTEM".

1. Signers and products of every exe under the browser and updater folders:

   ```powershell
   Invoke-Command -Session $s {
     $roots = @('C:\Program Files\Google', 'C:\Program Files (x86)\Google') +
              (Get-ChildItem 'C:\Program Files (x86)\Microsoft' -Directory -Filter 'Edge*' | ForEach-Object FullName)
     Get-ChildItem $roots -Recurse -Include *.exe -ErrorAction SilentlyContinue | ForEach-Object {
       $sig = Get-AuthenticodeSignature $_.FullName
       [pscustomobject]@{ File = $_.FullName; Status = $sig.Status; Subject = $sig.SignerCertificate.Subject
                          Product = $_.VersionInfo.ProductName; Company = $_.VersionInfo.CompanyName; Version = $_.VersionInfo.FileVersion }
     } | Export-Csv C:\rb-spike\out\s5-signers.csv -NoTypeInformation
     Import-Csv C:\rb-spike\out\s5-signers.csv | Group-Object Status, Subject, Product | Format-Table Count, Name -Wrap
   }
   ```

   Write down, for `chrome.exe`, `msedge.exe` and each updater exe (`GoogleUpdate.exe` or `updater.exe`,
   `MicrosoftEdgeUpdate.exe`): the full subject, the `O=` part, `ProductName`, and the folder.

2. Which account the updaters run as:

   ```powershell
   Invoke-Command -Session $s {
     Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'gupdate|GoogleUpdater|edgeupdate|Elevation' -or $_.PathName -match 'Google|EdgeUpdate' } |
       Select-Object Name, StartName, StartMode, State, PathName | Format-List
     Get-ScheduledTask | Where-Object { $_.TaskName -match 'Google|MicrosoftEdge' } |
       Select-Object TaskName, @{n='RunAs';e={$_.Principal.UserId}}, @{n='Logon';e={$_.Principal.LogonType}}, @{n='Run';e={$_.Actions[0].Execute}} |
       Format-Table -AutoSize -Wrap
   }
   ```

3. Watch an update check run (this only asks the vendor's own updater to look for updates):

   ```powershell
   Invoke-Command -Session $s {
     Get-ScheduledTask | Where-Object { $_.TaskName -match 'Google.*(UA|System)|MicrosoftEdgeUpdateTask.*(Core|UA)' } | Start-ScheduledTask
     1..12 | ForEach-Object {
       Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'Update|updater' } | ForEach-Object {
         [pscustomobject]@{ Name = $_.Name; Pid = $_.ProcessId; Session = $_.SessionId; Path = $_.ExecutablePath
                            Owner = (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User }
       }
       Start-Sleep 2
     } | Sort-Object Name, Owner -Unique | Format-Table -AutoSize
   }
   ```

**Pass:**
- Every browser and updater exe has Status `Valid`.
- Chrome's signer subject and Edge's signer subject are written down, with `ProductName` for each.
- The updaters run as `SYSTEM` (service or task), session 0, and nothing starts in the `spikestaff`
  session.

**Differs:** an exe is `NotSigned` or `HashMismatch`; a different subject on the updater than on the
browser; an updater process owned by `spikestaff`; Edge's updater or exes use a platform subject.

**Plan change:** 4.4.3 gets the real values for the catalogue entries. Edge is signed by
"Microsoft Corporation", which the validator calls too broad (`publisher_too_broad`), so write the exact
`ProductName` strings that Edge's exes use; the Edge catalogue entry needs a `publisherProduct`. If an
updater runs in the Staff session, 4.4.3 must say so (the publisher rule covers it) and 4.9.7 changes.

## S-3. AppUserModelID of two `--app` windows of one profile

**Decides:** 4.9.5 primary (map by AppUserModelID) or fallback (one profile per employee **and app**).

1. Save the helper source in the VM (once). It reads the window property store and changes nothing.
   Paste the whole block, with the closing `'@` at the start of its line:

```powershell
$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinAumid
{
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, out IPropertyStore ps);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pv);

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Explicit)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr p;
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint c);
        [PreserveSig] int GetAt(uint i, out PropertyKey k);
        [PreserveSig] int GetValue(ref PropertyKey k, out PropVariant v);
        [PreserveSig] int SetValue(ref PropertyKey k, ref PropVariant v);
        [PreserveSig] int Commit();
    }

    public static List<string> Dump()
    {
        var rows = new List<string>();
        Guid iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
        PropertyKey key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var cls = new StringBuilder(256); GetClassName(h, cls, 256);
            if (cls.ToString() != "Chrome_WidgetWin_1") return true;
            var title = new StringBuilder(256); GetWindowText(h, title, 256);
            uint pid; GetWindowThreadProcessId(h, out pid);
            string aumid = "(none)";
            IPropertyStore ps;
            if (SHGetPropertyStoreForWindow(h, ref iid, out ps) == 0 && ps != null)
            {
                PropVariant pv;
                if (ps.GetValue(ref key, out pv) == 0)
                {
                    if (pv.vt == 31 && pv.p != IntPtr.Zero) aumid = Marshal.PtrToStringUni(pv.p);
                    PropVariantClear(ref pv);
                }
            }
            rows.Add("hwnd=" + h.ToInt64() + " pid=" + pid + " title=[" + title + "] aumid=[" + aumid + "]");
            return true;
        }, IntPtr.Zero);
        return rows;
    }
}
'@
Invoke-Command -Session $s -ArgumentList $cs { param($t) Set-Content C:\rb-spike\WinAumid.cs $t }
function Read-SpikeAumid {
  param([string]$Tag)
  Start-SpikeUser 'powershell.exe' "-NoProfile -Command `"Add-Type -TypeDefinition (Get-Content -Raw C:\rb-spike\WinAumid.cs); [WinAumid]::Dump() | Set-Content C:\rb-spike\out\$Tag.txt`""
  Start-Sleep 8
  Invoke-Command -Session $s -ArgumentList $Tag { param($t) Get-Content "C:\rb-spike\out\$t.txt" }
}
```

2. Chrome, one profile, two `--app` windows (same command line shape as 4.9.2):

   ```powershell
   $a = "--user-data-dir=$prof\chrome\e1 --no-first-run --no-default-browser-check --disk-cache-size=52428800"
   Start-SpikeUser $chrome "--app=https://example.org $a"
   Start-Sleep 8
   Start-SpikeUser $chrome "--app=https://example.com $a"
   Start-Sleep 10
   Read-SpikeAumid s3-chrome-1
   ```

3. Close both windows (X in the VM window), open the same two URLs again, run `Read-SpikeAumid s3-chrome-2`.
4. Repeat 2 and 3 with `$edge` and profile `$prof\edge\e1` (tags `s3-edge-1`, `s3-edge-2`).
5. Look at the taskbar in the VM: one button per window, or grouped? Write it down.

**Pass:** each browser shows two different AUMIDs (one per window), the two values differ in a part that
depends on the app (URL or app name), and the same URL gives the same AUMID after the reopen.

**Differs:** both windows report the same AUMID, `(none)`, or the value changes at each launch.

**Plan change on DIFFERS:** 4.9.5 uses the **fallback** (profile per employee and app: `...\browser\<chrome|edge>\<employeeId>\<appId>`).
Then also update 4.9.2 (profile path), 4.9.6 (keep 10 profiles per browser must count per app) and
Section 14 (more memory per app). Re-run S-4 with three separate profiles. Pass: 4.9.5 stays.
If only one browser passes, write both results in Notes and ask the owner before changing 4.9.5.

## S-4. Working set of Chrome and Edge with one and three `--app` windows

**Decides:** Section 14 rows "One browser `--app` window" and "Lite: web windows".

The Staff App does not exist in this spike (no Rulebox code), so this measures the browser alone. The
sign-in desktop of `spikestaff` is the "beside". The Staff App's own share is in Step 24.

1. Helper:

   ```powershell
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
   ```

2. With `spikestaff` signed in and nothing open: wait 2 minutes, run
   `Get-SpikeBrowserMemory chrome` and `Get-SpikeBrowserMemory msedge` (baseline; Edge may already have
   a background process).
3. Chrome, **one** window (command line of 4.9.2, a new profile `$prof\chrome\m1`):

   ```powershell
   $a = "--user-data-dir=$prof\chrome\m1 --no-first-run --no-default-browser-check --disk-cache-size=52428800"
   Start-SpikeUser $chrome "--app=https://example.org $a"
   ```

   Wait until the page is drawn, then 60 s. Run `Get-SpikeBrowserMemory chrome`. Do it three times, 20 s apart.
4. Add two more windows to the same profile (`https://example.com`, `https://www.wikipedia.org`). Wait 60 s.
   Run the helper three times, 20 s apart.
5. Close all windows. Then `Invoke-Command -Session $s { Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force }`
   and wait 30 s.
6. Repeat 3 to 5 for Edge (`$edge`, name `msedge`, profile `$prof\edge\m1`).

Record in the table below (WS = working set, PWS = private working set, sum of all processes of that
browser; use the median of the three samples):

| Browser | Windows | Processes | WS (MB) | PWS (MB) | Free RAM (MB) |
|---|---|---|---|---|---|
| Chrome | baseline | | | | |
| Chrome | 1 | | | | |
| Chrome | 3 | | | | |
| Edge | baseline | | | | |
| Edge | 1 | | | | |
| Edge | 3 | | | | |

**Result rule (Section 14):** apply it to the **working set** of the first window, minus baseline.
- First window <= 350 MB: PASS. Write the figure in the Section 14 row, replacing "no budget yet".
- First window > 350 MB, for either browser: DIFFERS. Section 14 and 4.9.1: browsers are off by default
  below 8 GB RAM (the Staff App picks built-in).
- Three-window figure: no threshold in the plan. Copy it into the "Lite: web windows" row and tell the
  owner whether "<= 3 open" still looks right.

## S-1. Are Staff-hive browser policies applied on a workgroup PC?

**Decides:** 4.9.3 "Where": Staff hive (default, `guard_coverage` 12 -> 14) or machine keys (9 -> 11).

Do this **after** S-3 and S-4 so earlier rows ran without policies. Close all browser windows first
(and stop leftover processes: `Get-Process chrome, msedge | Stop-Process -Force` inside `Invoke-Command`).

1. Confirm the PC is a workgroup PC with no management:

   ```powershell
   Invoke-Command -Session $s {
     (Get-CimInstance Win32_ComputerSystem) | Select-Object Name, PartOfDomain, Workgroup
     dsregcmd /status | Select-String 'AzureAdJoined|DomainJoined|EnterpriseJoined|MdmUrl'
   }
   ```

   Expect `PartOfDomain False`, `AzureAdJoined NO`, `DomainJoined NO`, no `MdmUrl`.

2. Helper to write one policy value into the Staff hive (or the machine key):

   ```powershell
   function Set-SpikePolicy {
     param([ValidateSet('chrome', 'edge')][string]$Browser, [string]$Name, $Value,
           [string]$List = '', [ValidateSet('hive', 'machine')][string]$Where = 'hive')
     Invoke-Command -Session $s -ArgumentList $Browser, $Name, $Value, $List, $Where {
       param($b, $n, $v, $l, $w)
       $sid  = (New-Object Security.Principal.NTAccount('spikestaff')).Translate([Security.Principal.SecurityIdentifier]).Value
       $root = if ($w -eq 'hive') { "Registry::HKEY_USERS\$sid\Software\Policies" } else { 'HKLM:\SOFTWARE\Policies' }
       $key  = if ($b -eq 'chrome') { "$root\Google\Chrome" } else { "$root\Microsoft\Edge" }
       if ($l) { $key = "$key\$l" }
       New-Item $key -Force | Out-Null
       $type = if ($v -is [int]) { 'DWord' } else { 'String' }
       New-ItemProperty -Path $key -Name $n -Value $v -PropertyType $type -Force | Out-Null
       "$key  $n = $v"
     }
   }
   ```

3. Write the test values (names from 4.9.3) for both browsers, **before** opening any browser:

   ```powershell
   foreach ($b in 'chrome', 'edge') {
     Set-SpikePolicy $b DeveloperToolsAvailability 2
     Set-SpikePolicy $b DownloadRestrictions 3
     Set-SpikePolicy $b BackgroundModeEnabled 0
     Set-SpikePolicy $b BrowserSignin 0
     Set-SpikePolicy $b 1 'example.org' -List URLBlocklist
   }
   Set-SpikePolicy chrome IncognitoModeAvailability 1
   Set-SpikePolicy edge   InPrivateModeAvailability 1
   ```

4. Read-only: who can write those keys? (4.9.3 says a standard user cannot write `HKCU\Software\Policies`.)

   ```powershell
   Invoke-Command -Session $s {
     $sid = (New-Object Security.Principal.NTAccount('spikestaff')).Translate([Security.Principal.SecurityIdentifier]).Value
     foreach ($k in 'Policies', 'Policies\Google\Chrome', 'Policies\Microsoft\Edge') {
       "== $k"
       (Get-Acl "Registry::HKEY_USERS\$sid\Software\$k").Access |
         Format-Table IdentityReference, RegistryRights, AccessControlType, IsInherited -AutoSize
     }
   }
   ```

5. Open each browser as `spikestaff` on its policy page (same command line shape as 4.9.2, ordinary window):

   ```powershell
   $a = "--user-data-dir=$prof\chrome\p1 --no-first-run --no-default-browser-check"
   Start-SpikeUser $chrome "$a chrome://policy"
   $b = "--user-data-dir=$prof\edge\p1 --no-first-run --no-default-browser-check"
   Start-SpikeUser $edge "$b edge://policy"
   ```

   In each: do **not** press "Reload policies" yet. Look at the table: name, value, **Source**, **Applies to**,
   **Level**, **Status**. Also open `chrome://management` / `edge://management` and write down what it
   says. Then try `https://example.org` in a new tab (expect the browser's "blocked by administrator"
   page) and press F12 (expect DevTools not to open). Screenshot both policy pages as
   `s1-chrome-policy.png` and `s1-edge-policy.png`.

6. **Only if** a value is missing or its Status is not OK: test the fallback so the owner knows it works.
   Close the browser. Move the values to the machine keys (`-Where machine` on the same commands, then
   remove the hive values with `Remove-Item` on the hive keys inside `Invoke-Command`), reopen, read the
   policy page again. Write what changes (Applies to: "Current machine").

**Pass:** for **both** browsers: the policy page lists the Staff-hive values with Status `OK`
(Source `Platform`, Applies to the current user), `example.org` is blocked, and `spikestaff` has no write
right on the policy keys (only read, or none).

**Differs:** any value shown as ignored, missing, or "not set" while the registry has it; or the page
shows nothing from the hive.

**Plan change on DIFFERS:** 4.9.3 "Where": machine keys (two new `machinereg` roots, count 9 -> 11),
4.9.4 and 4.9.8 text (the administrator's own browser is restricted too), Step 17 file list, and tell
the owner. If `spikestaff` **can** write the policy keys, 4.9.3 also needs "created with an admin-only
ACL" (Step 17). Pass: 4.9.3 stays.

## S-2. How long does a changed value take to show without a browser restart?

**Decides:** 4.9.3 "Reload" rule (15 minutes worst case; some values only after restart).

Same VM state as S-1 (policies written, both browsers can be opened on `chrome://policy` and
`edge://policy`). Run it once for Chrome and once for Edge, with the browser already open and idle.

```powershell
function Measure-PolicyChange {
  param([string]$Browser, [string]$Name, $Value, [string]$List = '')
  Set-SpikePolicy $Browser $Name $Value -List $List | Out-Null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $null = Read-Host 'Press Enter the moment the VM page shows the new value (Ctrl+C to give up at 20 minutes)'
  [math]::Round($sw.Elapsed.TotalSeconds)
}
```

Tests (keep the VM window next to the host window; do not press "Reload policies"):

| # | Change | What you wait for | Seconds, Chrome | Seconds, Edge |
|---|---|---|---|---|
| a | `Measure-PolicyChange chrome DeveloperToolsAvailability 1` (and `edge`) | New value on the policy page | | |
| b | `Measure-PolicyChange chrome 2 'example.com' -List URLBlocklist` | `https://example.com` blocked in a new tab of the same open window | | |
| c | `Measure-PolicyChange chrome IncognitoModeAvailability 0` (Edge: `InPrivateModeAvailability 0`) | New value on the policy page. Then: does Ctrl+Shift+N open a private window **before** you restart the browser? | | |

Also write: does the policy page itself change with no click (live update), or only after reload or
restart? After the three tests close the browser fully, open it again, and write which values changed
only after the restart.

**Pass:** values (a) and (b) take effect in 15 minutes or less; any value that needs a restart is
already listed in 4.9.3 (Incognito / InPrivate, `BrowserSignin`).

**Differs:** (a) or (b) take longer than 15 minutes or never show without a restart; or a value the plan
treats as live needs a restart.

**Plan change:** 4.9.3 "Reload": write the measured times, add "needs a restart" to the values that
need it. If (a) or (b) never apply without a restart, the rule becomes "policy changes apply at the
next browser start" and the agent must not mark a browser app `ready` while that employee's browser is
running (4.9.3 and Step 18).

---

## Group B - S-6 AppLocker and SYSTEM-started programs

## S-6. Is a program started by SYSTEM checked against the Staff AppLocker rules?

**Decides:** 4.4.3 (vendor updater runs as SYSTEM) and 4.8 (the agent starts installers and `pnputil`
as SYSTEM). Same question as Phase 5 Section 21 and row 1-09 of `phase-5-vm-results.md`.
If row 1-09 is already filled in and used a policy with Staff-only rules, copy that answer here and
note "from Phase 5 1-09"; otherwise run this.

Start: revert to `spike-base`, helpers defined. Sign in as `spikestaff` in the VM window.
This uses a **hand-made local AppLocker policy** that stands in for the Phase 5 shape (rules for the
Staff SID only, administrators allowed). No Rulebox code.

1. Helper (builds the policy, applies it, starts Application Identity):

   ```powershell
   function Set-SpikeAppLocker {
     param([ValidateSet('AuditOnly', 'Enabled')][string]$Mode, [bool]$AdminRule)
     Invoke-Command -Session $s -ArgumentList $Mode, $AdminRule {
       param($mode, $admin)
       $sid = (New-Object Security.Principal.NTAccount('spikestaff')).Translate([Security.Principal.SecurityIdentifier]).Value
       function New-SpikeRule($n, $u, $p) {
         "<FilePathRule Id=`"$([guid]::NewGuid())`" Name=`"$n`" Description=`"`" UserOrGroupSid=`"$u`" Action=`"Allow`"><Conditions><FilePathCondition Path=`"$p`"/></Conditions></FilePathRule>"
       }
       $rules = (New-SpikeRule 'spike user Windows' $sid '%WINDIR%\*') + (New-SpikeRule 'spike user Program Files' $sid '%PROGRAMFILES%\*')
       if ($admin) { $rules += New-SpikeRule 'Administrators all' 'S-1-5-32-544' '*' }
       Set-Content C:\rb-spike\applocker.xml "<AppLockerPolicy Version=`"1`"><RuleCollection Type=`"Exe`" EnforcementMode=`"$mode`">$rules</RuleCollection></AppLockerPolicy>"
       Set-AppLockerPolicy -XmlPolicy C:\rb-spike\applocker.xml
       sc.exe config appidsvc start= auto
       sc.exe stop appidsvc | Out-Null; Start-Sleep 3
       sc.exe start appidsvc
       Get-Service appidsvc | Select-Object Status, StartType
     }
   }
   ```

   If `sc.exe config appidsvc` is denied on this build, set `Start` to 2 under
   `HKLM\SYSTEM\CurrentControlSet\Services\AppIDSvc` and start the service; write in Notes how you got it
   running. If rules still do not apply, restart the VM gracefully once and re-run step 3.

2. A harmless probe in a writable folder (a copy of `whoami.exe`) and the log query:

   ```powershell
   Invoke-Command -Session $s { Copy-Item C:\Windows\System32\whoami.exe C:\rb-spike\probe.exe }
   function Get-SpikeAppLockerEvents {
     Invoke-Command -Session $s {
       Get-WinEvent -LogName 'Microsoft-Windows-AppLocker/EXE and DLL' -MaxEvents 100 -ErrorAction SilentlyContinue |
         Where-Object { $_.Message -match 'probe\.exe' } |
         Select-Object TimeCreated, Id, @{n='User';e={$_.UserId.Value}}, @{n='Text';e={$_.Message.Split("`n")[0]}} | Format-Table -AutoSize -Wrap
     }
   }
   ```

   Event ids: 8002 allowed, 8003 would be blocked (audit), 8004 blocked.

3. **Variant 1: administrators allowed, enforced** (the Phase 5 shape; safe for the VM):

   ```powershell
   Set-SpikeAppLocker -Mode Enabled -AdminRule $true
   Start-SpikeUser 'cmd.exe' '/c C:\rb-spike\probe.exe > C:\rb-spike\out\s6-v1-user.txt 2>&1'
   Start-SpikeSystem -Tag s6-v1-system -Exe 'C:\rb-spike\probe.exe'
   Wait-SpikeSystem -Tag s6-v1-system
   Invoke-Command -Session $s { Get-Content C:\rb-spike\out\s6-v1-user.txt }
   Get-SpikeAppLockerEvents
   ```

   Expected if the policy is working: the `spikestaff` run is blocked ("blocked by group policy" text,
   event 8004) and the SYSTEM run ends with `exit=0`. If the user run is **not** blocked, AppLocker is not
   enforcing here: fix that first (service, restart), or the row is `NOT OBSERVED`.

4. **Variant 2: Staff-only rules, audit only** (no administrator rule, so it tells whether SYSTEM is
   evaluated at all; audit mode cannot block anything):

   ```powershell
   Set-SpikeAppLocker -Mode AuditOnly -AdminRule $false
   Start-SpikeSystem -Tag s6-v2-system -Exe 'C:\rb-spike\probe.exe'
   Wait-SpikeSystem -Tag s6-v2-system
   Get-SpikeAppLockerEvents
   ```

   Look at the `User` column: `S-1-5-18` is SYSTEM, the `spikestaff` SID is the other one.

**Result:**
- **A (not checked):** variant 1: SYSTEM run works, no 8004; variant 2: **no** event for `probe.exe` from
  `S-1-5-18`. Then AppLocker does not evaluate SYSTEM-started programs. PASS.
- **B (checked):** variant 2 shows 8002 or 8003 for `S-1-5-18`. Then SYSTEM is evaluated and only the
  administrator (or another non-Staff) rule lets it through. DIFFERS.

**Plan change on DIFFERS:** 4.4.3 "the updater itself runs as SYSTEM": remove "unverified", and add that
the Staff-scoped policy must keep an allow rule for administrators and SYSTEM (Phase 5 invariants) so
the agent's own installer and `pnputil` runs from `<data>\downloads` and `System32` are allowed; tell
the owner that Phase 5 Section 21 item is now settled. On PASS: delete "unverified, Step 2" in 4.4.3 and
note that Phase 5's item is settled.

---

## Group C - Tauri NSIS installers as SYSTEM (S-8, S-9)

For both rows, the agent runs the installer as SYSTEM with `/S` (4.4.4, 4.6). Do not sign in as
`spikestaff`. Start: revert to `spike-base`, `$s` open, helpers defined.

Common inspection of the installer file (put the results in Notes of S-8 / S-9):

```powershell
$z = 'C:\rb-spike\in\<zahras build file name>.exe'
Invoke-Command -Session $s -ArgumentList $z {
  param($f)
  (Get-FileHash $f).Hash
  (Get-Item $f).VersionInfo | Format-List ProductName, FileVersion, ProductVersion, CompanyName
  Get-AuthenticodeSignature $f | Format-List Status, @{n='Subject';e={$_.SignerCertificate.Subject}}
  Select-String -Path $f -Pattern 'requestedExecutionLevel[^/]*' -AllMatches | ForEach-Object { $_.Matches.Value } | Select-Object -Unique
  foreach ($m in 'Nullsoft.NSIS.exehead', 'Inno Setup', 'InstallShield') { if (Select-String -Path $f -Pattern $m -SimpleMatch -Quiet) { "marker: $m" } }
}
```

## S-8. Zahras POS, per-machine NSIS build, run as SYSTEM with `/S`

**Decides:** 4.4.4 (installed per machine in Program Files; no window; exit code), 4.7 NSIS heuristic.

```powershell
Save-SpikeSnapshot s8-before
Start-SpikeSystem -Tag s8 -Exe $z -ArgText '/S'
Wait-SpikeSystem -Tag s8
Save-SpikeSnapshot s8-after
Compare-SpikeSnapshot s8-before s8-after
```

Then look at what the diff found:

```powershell
Invoke-Command -Session $s {
  $exe = Get-ChildItem 'C:\Program Files', 'C:\Program Files (x86)' -Recurse -Depth 3 -Filter '<app>.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  $exe.FullName
  $exe.VersionInfo | Format-List ProductName, FileVersion, ProductVersion
}
```

Write down: exit code and duration (from `s8.txt`), the install folder, whether the uninstall entry is
under HKLM (`UNINST` lines), where the shortcuts went, whether the app process is running after the
installer ended (and as which user and session, from the "processes started" list), any leftover
installer process, whether any window or prompt appeared (VM window), the `requestedExecutionLevel`
of the installer, and the exe's `FileVersion` and `ProductVersion` (feeds 4.4.1 "installed version" =
file version).

**Pass:** exit code 0; files under `C:\Program Files\<name>` (or `(x86)`); uninstall entry under HKLM;
the installer ended by itself in about a minute; `requestedExecutionLevel` is `requireAdministrator`
(the 4.7 heuristic holds when a per-user build, S-9, shows `asInvoker`).

**Differs:** other exit code; the app installed to a user path; the app was started as SYSTEM; the
installer hangs or shows a window; the exe has no file version.

**Plan change on DIFFERS:** 4.4.4 first bullet; 4.6 "Per-user installer" and "Detection" if the exe has
no file version; a started app means Step 14 must treat "app left running after install" (add it as a
detail or a stop step). Pass: 4.4.4 stays. Also write in Notes the build settings you used (NSIS, per machine,
in-app updater off): that is the owner's Q13 confirmation.

## S-9. Zahras POS, per-user NSIS build, run as SYSTEM with `/S`

**Decides:** 4.6 "Per-user installer" detection (path under `systemprofile\AppData`, depth <= 4).
Revert to `spike-base` first (S-8 left files behind).

Same commands as S-8 with `$z` set to the per-user build and tags `s9`, `s9-before`, `s9-after`.

Find the installed exe and measure its depth **relative to**
`C:\Windows\System32\config\systemprofile\AppData`:

```powershell
Invoke-Command -Session $s {
  $base = 'C:\Windows\System32\config\systemprofile\AppData'
  Get-ChildItem $base -Recurse -Depth 6 -Filter '<app>.exe' -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length + 1)
    [pscustomobject]@{ Path = $_.FullName; Relative = $rel; Depth = ($rel -split '\\').Count }
  }
}
```

Write down: the full path, the relative path and its depth (counting every folder and the file name),
the uninstall entry location (the snapshot shows `HKEY_USERS\.DEFAULT` for a SYSTEM per-user install),
exit code, and whether the exe could be found in `Program Files` at all.

**Pass:** exit code 0 and the exe is under `systemprofile\AppData` at depth 4 or less, so the
`installed_per_user` search in 4.6 would find it.

**Differs:** the exe is deeper than 4, or outside `systemprofile\AppData`, or the installer fails as SYSTEM.

**Plan change on DIFFERS:** 4.6 "Per-user installer" row (depth and search root) and risk 78 in Section 12
(update the "S-9 behaviour"). Pass: unchanged.

---

## Group D - TPCL driver (S-10, S-11)

## S-10. `TPCL-drv_11.10.0_E.exe`: unpack, catalogs, `pnputil`

**Decides:** 4.8 source choice: `inf_zip` only, or also `vendor_exe_extract` (built only if this row proves a windowless extract).

Start: revert to `spike-base`, `$s` open, helpers defined (no `spikestaff` sign-in needed).

```powershell
$tp = 'C:\rb-spike\in\TPCL-drv_11.10.0_E.exe'
```

1. Inspect the package (also a fixture for Step 13's detector):

   ```powershell
   Invoke-Command -Session $s -ArgumentList $tp {
     param($f)
     Get-FileHash $f -Algorithm SHA256
     (Get-Item $f).VersionInfo | Format-List *
     Get-AuthenticodeSignature $f | Format-List Status, @{n='Subject';e={$_.SignerCertificate.Subject}}
     foreach ($m in 'InstallShield', 'Nullsoft', 'Inno Setup', 'Advanced Installer', 'wixburn', '7-Zip', 'WinRAR', 'WinZip', 'IExpress') {
       if (Select-String -Path $f -Pattern $m -SimpleMatch -Quiet) { "marker: $m" }
     }
     pnputil /enum-drivers > C:\rb-spike\out\s10-drivers-before.txt
     Get-PrinterDriver | Select-Object Name, Manufacturer | Export-Csv C:\rb-spike\out\s10-printerdrivers-before.csv -NoTypeInformation
   }
   ```

   Write down any Seagull or Toshiba printer driver already present (4.8 warning `seagull_driver_present`;
   a fresh VM should have none).

2. Find the **documented** extract switch: read the vendor readme or install guide, and the help dialog
   the package shows when run from an elevated console **in the VM window** (as the admin you use there,
   not through Claude): `& 'C:\rb-spike\in\TPCL-drv_11.10.0_E.exe' /?` (close the dialog with Cancel).
   Write the switch string in Notes. If no extract switch is documented, write "none documented" and
   go to step 4.

3. Try the documented switch **as SYSTEM** (that is how the agent would run it), with a target folder that
   has no spaces. Replace `<switch>` with the vendor's text:

   ```powershell
   Save-SpikeSnapshot s10-before
   Start-SpikeSystem -Tag s10-extract -Exe $tp -ArgText '<switch with C:\rb-spike\tpcl-extract>'
   Wait-SpikeSystem -Tag s10-extract -TimeoutSec 600
   Save-SpikeSnapshot s10-after-extract
   Compare-SpikeSnapshot s10-before s10-after-extract
   ```

   Write down: exit code, time, whether a window or prompt showed on the VM screen, whether the wrapper
   file lists leftover processes, and what appeared under `C:\rb-spike\tpcl-extract`.

4. If no windowless extract worked: run the package once interactively in the VM window, as admin, stop
   at the first wizard page (do **not** click Next), and look for the unpacked files in `%TEMP%` (newest
   folders) or under `C:\Program Files (x86)\InstallShield Installation Information`. Copy that tree to
   `C:\rb-spike\tpcl-extract` (`Copy-Item -Recurse`) and cancel the wizard. This is the "admin extracts
   it once on a test PC" route of 4.8. Write down where the files were.

5. List the driver files and their catalogs:

   ```powershell
   Invoke-Command -Session $s {
     $d = 'C:\rb-spike\tpcl-extract'
     Get-ChildItem $d -Recurse -Include *.inf, *.cat | ForEach-Object { [pscustomobject]@{ File = $_.FullName.Substring($d.Length); Bytes = $_.Length } } | Format-Table -AutoSize
     Get-ChildItem $d -Recurse -Include *.cat | ForEach-Object {
       $x = Get-AuthenticodeSignature $_.FullName
       [pscustomobject]@{ Cat = $_.Name; Status = $x.Status; Subject = $x.SignerCertificate.Subject }
     } | Format-Table -AutoSize -Wrap
     Get-ChildItem $d -Recurse -Filter *.inf | ForEach-Object { "== $($_.Name)"; Select-String -Path $_.FullName -Pattern '^\s*CatalogFile' | ForEach-Object Line; Get-Content $_.FullName -TotalCount 80 }
   }
   ```

   Write down the `.inf` names, the `CatalogFile=` entries, whether every `.cat` listed exists, the
   status and signer of each, and the printer model and driver names in the `[Manufacturer]` section.

6. Add the driver the way 4.8 would, as SYSTEM, with the output captured:

   ```powershell
   Start-SpikeSystem -Tag s10-pnputil -Exe 'cmd.exe' -ArgText '/c C:\Windows\System32\pnputil.exe /add-driver "C:\rb-spike\tpcl-extract\*.inf" /subdirs /install > C:\rb-spike\out\s10-pnputil.txt 2>&1'
   Wait-SpikeSystem -Tag s10-pnputil
   Invoke-Command -Session $s { Get-Content C:\rb-spike\out\s10-pnputil.txt }
   ```

7. Is it a usable printer driver?

   ```powershell
   Invoke-Command -Session $s {
     pnputil /enum-drivers > C:\rb-spike\out\s10-drivers-after.txt
     Compare-Object (Get-Content C:\rb-spike\out\s10-drivers-before.txt) (Get-Content C:\rb-spike\out\s10-drivers-after.txt) | Where-Object SideIndicator -eq '=>' | ForEach-Object InputObject
     Get-PrinterDriver | Select-Object Name, Manufacturer | Sort-Object Name | Format-Table -AutoSize
   }
   ```

   If the new model is not in `Get-PrinterDriver`, try
   `Add-PrinterDriver -Name '<model name from the .inf>'` inside `Invoke-Command`. Then create a throw-away
   printer on a file port to see the driver loads, and remove it:

   ```powershell
   Invoke-Command -Session $s {
     Add-Printer -Name 'spike-tpcl' -DriverName '<model name from the .inf>' -PortName 'FILE:'
     Get-Printer -Name 'spike-tpcl' | Format-List Name, DriverName, PortName, PrinterStatus
     Remove-Printer -Name 'spike-tpcl'
   }
   ```

8. Removal, with the 4.8 shape (use the `oemN.inf` that step 7 showed):

   ```powershell
   Invoke-Command -Session $s { pnputil /delete-driver oemN.inf /uninstall; "exit $LASTEXITCODE" }
   ```

   Write the exit code (3010 means restart needed) and whether the driver left `Get-PrinterDriver`.

**Result and plan change:**

| Observation | Plan change (4.8, Step 15, Section 12 risk rows) |
|---|---|
| Documented switch extracts with no window, as SYSTEM, to a folder with `.inf` and valid `.cat`, and step 7 gives a usable driver | Build `vendor_exe_extract`; write the exact fixed arguments into the 4.8 table |
| No windowless extract, but the wizard route (step 4) gives `.inf` + valid `.cat`, and step 7 works | Keep only `inf_zip` (preferred); `vendor_exe_extract` not built; the dashboard help tells the admin to extract once on a test PC |
| `.cat` missing or not `Valid`, or `pnputil` refuses it | The `driver_unsigned` check fires for this package; write the observed message; `inf_zip` cannot be used for it; see S-11 |
| `pnputil` adds it but no usable printer driver appears | 4.8 "INF-only installs may miss the vendor's port or status monitor": now observed; route this package through `vendor_exe` (S-11) |
| Nothing works silently | Section 12 line 1834 "the TPCL driver has no silent route at all" applies; no `vendor_exe_extract` |

## S-11. The same package with InstallShield silent switches and a recorded answer file

**Decides:** 4.7 InstallShield rows (`/s /v/qn` for Basic MSI, `/s /f1{AnswerFile}` for InstallScript).
Revert to `spike-base` first (S-10 added a driver).

1. From S-10 step 1 you already have the marker list. Write down whether the package is InstallShield,
   and from the files it unpacks (or the wizard) whether it is Basic MSI (an embedded `.msi`) or
   InstallScript (no `.msi`).

2. Record an answer file once, **in the VM window as an admin**, by hand (never through Claude):

   ```
   "C:\rb-spike\in\TPCL-drv_11.10.0_E.exe" /r /f1"C:\rb-spike\in\setup.iss"
   ```

   Click through the wizard to the end with no printer attached (choose the same options you would
   want on a customer PC) so it installs and writes `setup.iss`. Copy `setup.iss` to the host
   (`Copy-Item -FromSession $s C:\rb-spike\in\setup.iss <host folder>`). **Revert to `spike-base` again**, open
   a new `$s`, and copy `setup.iss` back with `Copy-Item <host path> C:\rb-spike\in -ToSession $s` (the install
   must start from clean). If the package is a Basic
   MSI package the recorder may not apply: write that and skip step 4.

3. Silent attempt 1, as SYSTEM, Basic MSI style, with CPU samples. Write down the exit code from
   `s11-a.txt`:

   ```powershell
   Save-SpikeSnapshot s11-before
   Start-SpikeSystem -Tag s11-a -Exe $tp -ArgText '/s /v"/qn /norestart"'
   1..6 | ForEach-Object {
     Start-Sleep 10
     Invoke-Command -Session $s { Get-Process | Where-Object { $_.Path -like 'C:\rb-spike\*' -or $_.Name -match 'setup|TPCL|msiexec' } | Select-Object Name, Id, CPU, SessionId | Format-Table -AutoSize }
   }
   Wait-SpikeSystem -Tag s11-a -TimeoutSec 600
   Save-SpikeSnapshot s11-after-a
   Compare-SpikeSnapshot s11-before s11-after-a
   ```

   If it never ends (no CPU change in the samples, no files): that is "needs interaction". Write the CPU
   numbers, stop it (section 0.5), and revert before attempt 2.

4. Silent attempt 2, as SYSTEM, with the answer file (revert first if attempt 1 changed anything):

   ```powershell
   Start-SpikeSystem -Tag s11-b -Exe $tp -ArgText '/s /f1"C:\rb-spike\in\setup.iss" /f2"C:\rb-spike\out\s11-setup.log"'
   Wait-SpikeSystem -Tag s11-b -TimeoutSec 600
   Invoke-Command -Session $s { Get-Content C:\rb-spike\out\s11-setup.log -ErrorAction SilentlyContinue }
   ```

   In the InstallShield log, `ResultCode=0` is success (write any other value).

5. For each attempt that finished: is the printer driver present (`Get-PrinterDriver`, `pnputil /enum-drivers`),
   did a window show in the VM window, which exit codes appeared, how long it took.

**Pass:** at least one form finishes with no window and no prompt, exit code (and log result code) 0 or
3010, and the driver is present afterwards.

**Differs:** both hang, show a window, or return an error.

**Plan change:** DIFFERS: 4.7 InstallShield rows: write the exact working switch string (including how
`/v` is quoted: record the text that worked), or "no silent route", and the answer-file note
(the `.iss` must come from the same version of the package). Also 4.8: the TPCL driver then has no
`vendor_exe` route and Step 23 item 7 uses only the route S-10 chose. PASS: confirm the matching 4.7
row and note which of the two worked.

---

## Group E - S-12 Windows Protected Print Mode

## S-12. Which registry value shows Windows Protected Print Mode on and off?

**Decides:** 4.8 warning `protected_print_on` ("the exact policy value to read").

Start: revert to `spike-base`, `$s` open, helpers defined. Turning the mode on removes third-party
printer drivers from the PC. That is fine here (no printers yet).

1. Dump the candidate keys with the mode off:

   ```powershell
   function Export-SpikePrintKeys {
     param([string]$Tag)
     Invoke-Command -Session $s -ArgumentList $Tag {
       param($t)
       $keys = 'HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Printers', 'HKLM\SYSTEM\CurrentControlSet\Control\Print', 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Print'
       $i = 0
       foreach ($k in $keys) { $i++; reg export $k "C:\rb-spike\out\s12-$t-$i.reg" /y 2>&1 | Out-Null }
     }
   }
   Export-SpikePrintKeys off
   ```

   (A missing key just gives no file.)

2. In the VM window, as an admin, look at the setting: Settings > Bluetooth & devices > Printers &
   scanners > Windows protected print mode (the label and place can differ on this build; write
   what you see, with a screenshot `s12-settings-off.png`). Turn it **on** there. If the build has
   no such switch, use the policy instead: `gpedit.msc` > Computer Configuration > Administrative
   Templates > Printers > "Configure Windows protected print mode" > Enabled.

3. Wait a minute (the spooler may restart), then:

   ```powershell
   Export-SpikePrintKeys on
   Invoke-Command -Session $s {
     1..3 | ForEach-Object {
       "== key $_"
       Compare-Object (Get-Content "C:\rb-spike\out\s12-off-$_.reg" -ErrorAction SilentlyContinue) (Get-Content "C:\rb-spike\out\s12-on-$_.reg" -ErrorAction SilentlyContinue)
     }
   }
   ```

   The expected candidate (unverified) is `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Printers\WPP`,
   value `EnableWindowsProtectedPrint` = 1. Write the keys and values that **actually** changed, and ignore
   unrelated lines.

4. Do it again through the **other** route (if you used Settings, now use the policy; if you used the
   policy, check what Settings shows). Write down which route changes which value, and whether the
   Settings page shows "on" for the policy route.

5. Turn it **off** again (same route), run `Export-SpikePrintKeys off2` and compare with `off`: is the value
   deleted or set to 0?

**Pass:** one registry value (or a pair) changes with the mode, and it is the same whichever route you
use, or you can name the route that always writes it.

**Differs:** only some routes write a value; Settings shows "on" with no registry difference; or the
effective state is not in the registry at all.

**Plan change:** 4.8 "Warnings": replace "(unverified: the exact policy value to read; Step 2.)" with the
exact key, value name, type, and the meaning of absent / 0 / 1. On DIFFERS write which routes the agent
can see; if the effective state cannot be read, `protected_print_on` is dropped from 4.8 and 4.6
"New details" and the dashboard help warns the admin by text only.

---

## After

1. Copy the evidence to the host (before reverting):

   ```powershell
   New-Item -ItemType Directory -Force 'D:\work\personal\rulebox\.tmp\phase6-spike' | Out-Null
   Copy-Item -FromSession $s C:\rb-spike\out\* 'D:\work\personal\rulebox\.tmp\phase6-spike' -Recurse
   ```

   Do this at the end of each group, because a revert erases `C:\rb-spike\out`. Keep file names
   `<row>-<what>.<ext>`.
2. Shut the VM down gracefully: `Invoke-Command -Session $s { Stop-Computer }`.
3. Revert to the clean checkpoint when all rows are done:
   `Restore-VMSnapshot -VMName rulebox-test-pro -Name 'fresh-windows-11-pro' -Confirm:$false`.
4. Delete the working checkpoint to give the disk back: `Remove-VMSnapshot -VMName rulebox-test-pro -Name 'spike-base'`.
5. Fill in the table below, then edit the plan sections named in each row and tell the owner which
   ones changed. Step 2 is done when every row has a result or a reason.

---

## Results

| Row | Decides | Result (PASS / DIFFERS / NOT OBSERVED) | Notes (value seen, evidence file) | Date |
|---|---|---|---|---|
| S-1 | 4.9.3 Staff hive vs machine keys | | | |
| S-2 | 4.9.3 reload rule | | | |
| S-3 | 4.9.5 primary vs fallback | | | |
| S-4 | Section 14 budgets, Lite rule | | | |
| S-5 | 4.4.3 publisher values | | | |
| S-6 | 4.4.3, 4.8 (SYSTEM vs Staff AppLocker rules) | | | |
| S-7 | 4.10 launch conditions | | | |
| S-8 | 4.4.4 | | | |
| S-9 | 4.6 per-user detection | | | |
| S-10 | 4.8 source choice | | | |
| S-11 | 4.7 InstallShield rows | | | |
| S-12 | 4.8 `protected_print_on` warning | | | |

Plan sections changed after the run (list them, with the row that caused each):

- ______
