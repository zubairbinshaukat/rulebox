# Phase 5 - VM results (Steps 21 and 22)

You run this on the test VM `rulebox-test-pro` (Windows 11 Pro, Hyper-V). Nothing here runs on
the dev laptop. This is the results file named in `phase-5-lockdown.md` Steps 21 and 22 and
Section 11.2. The plan is the spec. This file is the checklist and the record.

Rules for this file (from the plan, rule 8 and Step 22):

- Write **only** pass/fail, the evidence (file name or screenshot name) and any residual risk.
- Do not write down how to get around a control. The checklist stays defensive.
- A **FAIL** is a bug in the control. Fix it, then run the row again.
- Rows E-70..E-74 (the way back) must all pass. One fail there **stops the run**.

Result values for the Result column:

| Value | Meaning |
|---|---|
| PASS | Did what the Expected column says. |
| FAIL | Did not. Put the evidence in Notes and read "If something fails" at the bottom. |
| PILOT | Cannot be tested on Hyper-V. Moves to the first real-laptop pilot (Phase 6). Not a fail. |
| SKIP | Optional row, not run. Say why. |
| N/A | Does not apply to this build or edition. Say why. |

Rows marked **real laptop - skip on Hyper-V** need hardware the VM does not have (Wi-Fi, a USB
device, a second monitor, a real printer, sleep, touch, media keys). Record them as `PILOT`.

Windows edition, version and build tested (run 1): ______

Windows edition, version and build tested (run 2): ______

---

## 0. Prerequisites and how to work (both runs)

### 0.1 Prerequisite rows

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| P-01 | Host: start an **elevated** PowerShell. Check free space and RAM: `Get-PSDrive C, D` and `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory`. | D: has more than 10 GB free. About 4.6 GB RAM free to start the VM. | | |
| P-02 | Host: VM off. Revert to the clean checkpoint: `Restore-VMSnapshot -VMName rulebox-test-pro -Name 'fresh-windows-11-pro' -Confirm:$false`. Start it: `Start-VM rulebox-test-pro`. | VM boots to the sign-in screen. Windows is not updated and not activated (as when the checkpoint was taken). | | |
| P-03 | In the VM, elevated PowerShell: `Get-ItemProperty 'HKLM:\SOFTWARE\Rulebox\TestMachine' -Name ComputerName`. If it is missing, **you** create it by hand (never Claude): the two lines in `phase-2-vm-checklist.md` section 0. | The value equals `$env:COMPUTERNAME`. | | |
| P-04 | Write down the build: `winver` or `(Get-ComputerInfo).WindowsProductName, OsVersion`. Put it at the top of this file. | Edition, version, build recorded. | | |
| P-05 | Dev laptop, repo root. Build the App Control binaries, then the debug build (about 1 to 2 GB in `target\`). Run: `powershell -NoProfile -File scripts\appcontrol-build.ps1` then `cargo build -p rulebox-agent -p rulebox-shell` then `pnpm --filter @rulebox/staff-app tauri build --debug --no-bundle`. Optional: `cargo build -p rulebox-ipc --example fake_staff --features client`. `appcontrol-build.ps1` only writes under `target\appcontrol\` and needs the ConfigCI module (present on the dev laptop at Step 0). | All three finish with exit code 0. `target\debug\rulebox-agent.exe`, `rulebox-shell.exe` and `rulebox-staff.exe` exist. | | |
| P-06 | Copy the files into the VM through PowerShell Direct (commands in 0.2). Files: the three exes above, `scripts\vm-deploy.ps1`, `scripts\vm\export-baseline.ps1`. Compare SHA-256 on both sides. | Hashes equal. A forced `Restart-VM -Force` after a copy once zeroed files (Phase 3). Always restart the VM **gracefully** from inside (`Restart-Computer`). | | |
| P-07 | Dev Convex deployment: one org migrated to per-org keys (`keys:migrateFromEnv`, Owner, once), one group with rings **enabled** and this VM as its only **pilot** device (a second VM, if you have one, as `early`), one enrollment code ready, an exit PIN set in the dashboard. | You can sign in to the dashboard as Owner. The group has rings enabled and one pilot device. | | |
| P-08 | In the VM, **before enrolling**: `.\export-baseline.ps1 -OutFile C:\rb-evidence\before.txt -WhatIf` then without `-WhatIf`. | `-WhatIf` lists sections and writes nothing. The real run writes one file. `DefaultPassword` shows only as `<present>`. | | |
| P-09 | In the VM: `rulebox-agent compat`. | No blockers. | | |
| P-10 | Take a checkpoint with the VM **off**, after copying files and **before** enrolling: `Checkpoint-VM -Name 'before-phase5-run1'`. | Checkpoint exists. | | |
| P-11 | Copy `before.txt` to the host (`Copy-Item -FromSession`). Keep it. | File on the host. | | |
| P-12 | Dashboard: confirm the dev deployment shows the Phase 5 screens (group Lockdown tab, Findings, Rollout tab, Messages, Networks). | All open without errors. | | |

### 0.2 Commands you will use many times

On the host, elevated PowerShell:

```powershell
$vm   = 'rulebox-test-pro'
$cred = Import-Clixml 'D:\work\hypervisor\rbtest.cred.xml'     # rbtest, local admin
$s    = New-PSSession -VMName $vm -Credential $cred
Invoke-Command -Session $s { New-Item -ItemType Directory -Force C:\rb-deploy, C:\rb-evidence | Out-Null }
$t = 'D:\work\personal\rulebox\target\debug'
Copy-Item "$t\rulebox-agent.exe","$t\rulebox-shell.exe","$t\rulebox-staff.exe",
          'D:\work\personal\rulebox\scripts\vm-deploy.ps1',
          'D:\work\personal\rulebox\scripts\vm\export-baseline.ps1' -Destination C:\rb-deploy -ToSession $s
Get-FileHash $t\rulebox-agent.exe,$t\rulebox-shell.exe,$t\rulebox-staff.exe
Invoke-Command -Session $s { Get-FileHash C:\rb-deploy\*.exe }
```

In the VM, elevated PowerShell (the "VM shell"). Run `logoff` of the Staff session first on a
re-deploy, because the old shell locks the files:

```powershell
cd C:\rb-deploy
.\vm-deploy.ps1                                  # installs the service; refuses without the marker
$ra = "$env:ProgramFiles\Rulebox\rulebox-agent.exe"
& $ra enroll <code> --name "rulebox-test-pro"    # code from the dashboard Enrollment screen
& $ra status
& $ra lockdown-status                            # human text; exit code 1 means "something needs a look"
& $ra lockdown-status --json | Out-File C:\rb-evidence\<row>-status.json -Encoding utf8
Get-Content C:\ProgramData\Rulebox\logs\* -Tail 200
Restart-Computer                                 # graceful only
```

Handy places in the VM: logs `C:\ProgramData\Rulebox\logs`, state `C:\ProgramData\Rulebox\state`
(`desired-state.json`, `lockdown-last.json`, `findings.json`, `lkg.json`, `agent-config.json`,
`recovered.flag`).

Tips for the VM window:

- Ctrl+Alt+Del in the VM window is **Ctrl+Alt+End** (the host catches Ctrl+Alt+Del).
- If the host swallows a Windows-key combination, set the VM window option for Windows key
  combinations to "on the virtual machine".
- Screenshots: from the host with the Hyper-V thumbnail call, or the Snipping Tool inside the VM
  (as an administrator, never in the Staff session). Name files `<row>-what.png` and keep them in
  `C:\rb-evidence`.
- Copy evidence out at the end: `Copy-Item -FromSession $s C:\rb-evidence\* D:\work\personal\rulebox\.tmp\phase5\ -Recurse`.

### 0.3 Dashboard login while you test

Major actions in the dashboard (enforce changes, rollback, lock, Disable kiosk) ask for a fresh
step-up (action PIN or passkey). Have it ready.

---

# Run 1 - Step 21: apply, audit, enforce, rings, rollback, restore

Start: VM reverted to `fresh-windows-11-pro` (or `before-phase5-run1`), marker present, `before.txt`
taken, nothing enrolled yet. Default lockdown settings (every layer in `audit`).
**Done when:** every row has a result, failures are written up with evidence, and you revert the VM
to its checkpoint afterwards.

## 1. Apply in audit (plan item 1)

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 1-01 | Enroll with the code (command in 0.2). Restart the VM gracefully. | Device appears in the dashboard. `net user RuleboxStaff` shows a standard user. After restart the PC signs in to the Staff App by itself. | | |
| 1-02 | Device page: look at every layer (staff, machine, AppLocker, App Control, process watch, boot, performance). Screenshot `1-02-layers.png`. | Every layer shows `ok` in mode `audit` (App Control and AppLocker in `audit`, process watch in `audit`). Write down any `partial`, `failed`, `unsupported` or `restartPending` and its detail code. | | |
| 1-03 | `& $ra lockdown-status` and `--json`. Save both. | All green, exit code 0. Invariant self-check passes. | | |
| 1-04 | From `lockdown-status`: write down the journal entry count. | Number recorded. Journal is 64 KB or less (`(Get-Item C:\ProgramData\Rulebox\state\state.v1.json).Length`). | | |
| 1-05 | Payload size: `(Get-Item C:\ProgramData\Rulebox\state\desired-state.json).Length`. | Bytes recorded. Typical 12 KB or less, worst case 64 KB or less for the Phase 5 keys. | | |
| 1-06 | Time of one full apply (cold): read apply start and end in the agent log after the first apply. | 30 s or less, not counting an App Control restart. Seconds recorded. | | |
| 1-07 | Time of one reconcile pass with no drift (agent log). Wait for the 10 minute reassert. | 500 ms or less, reads only. Also record the cost of one pass on this 4 GB VM (the Windows folder scan and four event-log reads run each pass). | | |
| 1-08 | Which AppLocker mechanism applied (MDM bridge or local policy)? Read the journal summary in `lockdown-status`. Check `Get-Service AppIDSvc` start type. | Mechanism recorded. `AppIDSvc` start type is `Automatic`. Settles plan item: "AppLocker management path on Pro". | | |
| 1-09 | AppLocker and the SYSTEM service: after apply in audit, restart the service and the Staff session. Look in Event Viewer, `Microsoft-Windows-AppLocker/EXE and DLL`, for events naming the agent or launcher. | Agent and launcher start normally. No block or would-block event for `%ProgramFiles%\Rulebox`. Records whether AppLocker applies to SYSTEM-started processes (edge case 8). | | |
| 1-10 | App Control in audit: `CiTool --list-policies` (read only). | Only Rulebox's own policies were added next to what Windows already had. Record whether `CiTool --update-policy` refreshed without a restart or the layer shows `restartPending` (Windows 11 22H2 and later should refresh). | | |
| 1-11 | Process watch: record whether the layer detail says `snapshot_fallback`. Check the ETW session: `logman query -ets`. Look for `RuleboxProcWatch`. | Session `RuleboxProcWatch` exists, no `snapshot_fallback`. Settles "ETW Kernel-Process event fields on build 26300" (Windows 10 22H2 is not tested here). | | |
| 1-12 | Staff App, a WebView2 web app and a catalogue app all start as the employee. | All three start in audit mode. | | |
| 1-13 | Safe Mode registration present: `reg query HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\RuleboxAgent` and `...\Network\RuleboxAgent`. | Both keys exist (default value `Service`). | | |
| 1-14 | Applied ACLs: `sc.exe sdshow RuleboxAgent`, `icacls "$env:ProgramFiles\Rulebox"`, `icacls C:\ProgramData\Rulebox\state`. | Service: SYSTEM and Administrators full control; Interactive and Authenticated Users query only. Install folder: SYSTEM and Administrators full, Users read/execute. State folder: SYSTEM and Administrators only. No layer note `acl_readback_differs`. If Windows spells the DACL differently, paste it in Notes (Step 17 open item). | | |
| 1-15 | Service privileges: `sc.exe qprivs RuleboxAgent`. Write down the list. Check the agent log for any "privilege missing" line during an apply, a driver job and a `recover` run. | Service starts and works. Final measured list written here (Step 17 constant and the plan 4.16 list get updated from it). Note whether `SeLoadDriverPrivilege` is needed. | | |
| 1-16 | Staff tuning (Step 18): after apply, as the Staff user check the Staff `Run` key has no startup entries Rulebox removed, and widgets, Copilot and tips are off. Admin: `reg query` the Staff hive roots listed in `export-baseline.ps1` (hive loaded only while Staff is signed in). | Values present. Write down what each of the 15 tuning values does on this build, and whether `TaskbarDa` accepts the write (Step 18 unverified items). | | |
| 1-17 | Kiosk profile (Step 18): `Get-Service WSearch, SysMain, XblAuthManager, XblGameSave, XboxNetApiSvc, XboxGipSvc \| Select Name, StartType`; `reg query` `AllowTelemetry` and `DODownloadMode`; check `WinDefend` and `wuauserv` start types. | Listed services are `Disabled` (a missing one is skipped). `AllowTelemetry` is 1 on Pro. `DODownloadMode` is 0. Defender and Windows Update untouched. Layer shows `restartPending` until Windows restarts, then `ok`. | | |
| 1-18 | Spooler rule: with printers assigned (see 6-03), `Get-Service Spooler`. | Spooler stays on. `performance.noPrinting` ignored with the dashboard note `no_printing_ignored`. | | |

## 2. Findings (plan item 2)

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 2-01 | Use the allowed apps for 15 minutes as an employee would. Then open Findings in the dashboard. Screenshot `2-01-findings.png`. | Findings list shows program name, folder class, signer, layer, count. Write down how many and which. | | |
| 2-02 | Look for paths, command lines or window titles anywhere in Findings and on the device page. | None. Only file name, folder class, signer. | | |
| 2-03 | Allow **one** finding by publisher rule (Allow for app). Note what the dialog proposes first. | Publisher rule is proposed first, hash second. A hash rule shows "breaks on update". The finding turns `allowed`. A new document is published and applied. | | |
| 2-04 | Use that program again after the apply. | No new finding for it. | | |
| 2-05 | **Ignore** one finding. | It turns `ignored` and does not come back. | | |
| 2-06 | Write down the writable-folder scan result and the Windows packaged apps seen in audit (read from the agent log and findings). | List recorded. It feeds `STAFF_ALLOWED_PACKAGES` and the writable-folder exceptions. | | |
| 2-07 | An app whose stub starts another program (hand-off launcher), if one is in the catalogue. | Shows as a finding with the real program's signer. Allow by publisher covers it (edge case 10). | | |

## 3. Enforce through rings (plan item 3)

Use the pilot ring. The VM is the only pilot device.

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 3-01 | Group Lockdown tab: edit one setting. Look at the Rollout tab. | The change goes to the **pilot** ring only. State `rolling`. Other rings keep the old version. Screenshot `3-01-rollout.png`. | | |
| 3-02 | Switch **L3 AppLocker** to `enforce` in pilot. Read the confirmation dialog. | Dialog shows the open findings count. A fresh step-up is asked. Applies. Layer `ok`, mode `enforce`. | | |
| 3-03 | Switch **L4 App Control** to `enforce` (level `recommendedBlocks`). Read the dialog. Run `CiTool --list-policies` after. | Dialog has the "applies to administrators" sentence. Write down: refreshed at once, or `restartPending` and a restart was needed (edition and build). Policy removal behaviour is checked in 8-04. | | |
| 3-04 | Switch **L5 process watch** to `enforce`. Start one program that is not allowed, as the Staff user. | The program is ended. The Staff App says "This program is not allowed on this PC" once per program per session. A finding is recorded. Time to end the program recorded. | | |
| 3-05 | After all three are `enforce`: the Staff App, a WebView2 web app and a catalogue app still start. Restart the VM, sign in. | All start. Agent, launcher and Staff App start in enforce mode (E-87). | | |
| 3-06 | Start `rulebox-agent.exe` and the launcher while enforcing (restart the service). | Both start. No block event for the Rulebox folder. | | |
| 3-07 | Reboot and run `CiTool --list-policies` again. | Rulebox policies are still active (Active-folder policies survive a restart). Feature-update survival is checked in X-14. | | |
| 3-08 | `restartPending`: if any layer showed it, note which and when it cleared. | The agent never restarted the PC by itself. Dashboard showed "Restart needed". | | |
| 3-09 | Optional: App Control level `allowlist` in `audit` on the pilot. | Refused with `allowlist_level_with_user_install` if a catalogue app lives in a per-user folder. Otherwise applies in audit. Record findings. Leave it off afterwards. | | |
| 3-10 | **Promote** pilot to early, then to everyone (dashboard). | Audit rows `rollout.promoted`. Health shows applied counts. With one device the later rings have no devices (record how the page reads). | | |
| 3-11 | Edit an **app** (for example its name) on the group with rings on. | The app change reaches the pilot only until promoted (ring-gated catalogue, Step 16b). With one VM: record that the pilot got it. Second VM in `early`, if you have one: it does not get it until promoted. | | |

## 4. Last-known-good (plan item 4)

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 4-01 | Publish the prepared exception set that removes the WebView2 runtime from the Staff allow list (pilot only). | The validator **refuses** it: `would_block_rulebox`. The device keeps its old state. Dashboard shows the refusal in plain words. Audit `device.lockdownRefused`. | | |
| 4-02 | Make the Staff App crash on every start, then publish a config the validator accepts. The debug launcher (`rulebox-shell.exe`, the debug build from P-05) passes the Staff App's debug flag `--simulate-crash-loop` (it ends itself 5 s after `shell.ready`, exit code 0xC0000005) only when **both** the flag file and the test-machine marker (P-03) are present. Steps, in the VM as admin: **(a)** create the empty flag file next to the launcher: `New-Item -ItemType File 'C:\Program Files\Rulebox\simulate-crash-loop.flag'`. **(b)** Sign in as the Staff user and let the Staff App run. The launcher reads the file at every Staff App start, so end the running Staff App once to restart it with the flag: `Stop-Process -Name rulebox-staff -Force` (the launcher starts it again by itself). Check the Staff user's `%LOCALAPPDATA%\Rulebox\logs\shell-launcher.log` for "found on a marked test machine" and for exit code `0xC0000005` about 5 s after each start. **(c)** Publish the config from the dashboard and note the time. **(d)** After 4-03 and 4-04, **delete the file**: `Remove-Item 'C:\Program Files\Rulebox\simulate-crash-loop.flag'`, and end the Staff App once more so it starts without the flag. Do not leave the file in place for rows 4-05 to 4-08 unless a row needs the crash again. A release build never reads the file; a missing marker makes the launcher log "ignored" and start the Staff App as normal. | The launcher watchdog sees 3 crashes in 5 minutes, or no `ui_alive` within 180 s. Seconds from apply to rollback recorded. | | |
| 4-03 | Read the result: device page, agent log, Convex audit. | Agent restores the last-known-good lockdown by itself. Apply report `rolledBack`. Audit `device.lockdownRolledBack` (detail `crash_loop`). The Staff App runs again. | | |
| 4-04 | Dashboard group page after 4-03. | Rollout is `halted` with a red banner and a reason. Pilot returns to the early version when auto-rollback is on. Screenshot `4-04-halted.png`. | | |
| 4-05 | Publish the same bad config version again, and also send a broadcast. | The refused version is not applied again (reported `rolledBack`). The broadcast still arrives (non-gated keys keep working). | | |
| 4-06 | Sign the Staff user out, then publish a lockdown change. Wait 4 minutes. | No rollback: no `ui_alive` is expected while no Staff session exists. | | |
| 4-07 | Use the hidden exit, then Disable kiosk, and watch the first 90 seconds. | Not counted as a Staff App crash. No `rolledBack`. | | |
| 4-08 | Resume the halted rollout from the dashboard once the cause is fixed. | `resume` works. Audit row written. | | |

## 5. Rollback (plan item 5)

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 5-01 | Dashboard, group Rollout tab: roll back to an earlier version (a major action: step-up). Write down the version before and after. | Old content goes out under a **new, higher** document version. New version number recorded. Audit `rollout.rolledBack`. | | |
| 5-02 | `& $ra lockdown-status` after it applies. | Restored state equals the earlier version (layer modes match). Save the output. | | |
| 5-03 | Look at the rollback picker. | Lists the last 20 versions only. Pointers protect the ones in use. | | |
| 5-04 | With rings on, read the rollout state after a rollback. | Rollout is `halted` with reason `rolled_back` unless every pointer is equal. | | |

## 6. Wi-Fi, printers and drivers (plan item 6, Steps 13, 14, 14b)

Hyper-V has no Wi-Fi adapter. WLAN must say `unsupported` cleanly.

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 6-01 | Assign a test Wi-Fi profile to the group. Device page. | Wi-Fi state `unsupported`, no error banner, "managed networks only" not applied (edge case 33). | | |
| 6-02 | Device sealing key: look in the dashboard or log for the device registering its sealing key. Search the logs for the test passphrase: `Select-String -Path C:\ProgramData\Rulebox\logs\* -Pattern '<passphrase>'`. | Key registered once. Passphrase found **nowhere** in the logs. | | |
| 6-03 | Printers: assign a **raw TCP** printer pointing at an IP that does not exist (for example 192.0.2.50). `Get-Printer`, `Get-PrinterPort`. | State `ok`. Printer exists with the `(Rulebox)` suffix and a stored id in the comment field. Port created (settles `XcvData("AddPort")`). | | |
| 6-04 | Remove that printer in the dashboard. | Printer and port are gone. Other printers untouched. | | |
| 6-05 | Assign an **IPP** printer (to a URL that does not exist). | Created `ok`, port is the printer URL (settles the IPP queue point). | | |
| 6-06 | A printer name that already exists, created by hand before the assignment. | State `name_taken`. The existing printer is untouched. | | |
| 6-07 | A printer whose driver is not on the PC. | State `driver_missing`. Dashboard says which PC needs the driver. | | |
| 6-08 | Default printer for the Staff user (journalled). | Set for the Staff hive. Removed on restore (see 8-03). | | |
| 6-09 | Per-machine share connection (`PrintUIEntry /ga`) to a print server. Needs a second machine sharing a printer. | State recorded. Note whether it pulls a driver from the server (it must not). | | |
| 6-10 | **real laptop - skip on Hyper-V.** Wi-Fi profile installs as `Rulebox-<id>`: `netsh wlan show profiles`. | Profile exists, name matches, nothing for other profiles touched. | | |
| 6-11 | **real laptop - skip on Hyper-V.** Wrong passphrase with the network in range. | Profile installs, connection fails, item `connect_failed` reported (settles `WlanQueryInterface` and the connection notifications). | | |
| 6-12 | **real laptop - skip on Hyper-V.** Managed networks only while connected to another network. | Refused `would_disconnect` unless confirmed. After confirmation the PC goes offline until a managed network is in range. Dashboard warned. | | |
| 6-13 | **real laptop - skip on Hyper-V.** WPA3 transition mode on an old adapter. | Behaviour recorded (Phase 6 pilot item). | | |
| 6-14 | **real laptop - skip on Hyper-V.** A real printer on the network: print a test page as the employee. | Prints. Only assigned printers listed (E-22). | | |
| 6-15 | Drivers (Step 14b): deliver a small **signed** INF package from the dashboard (a Microsoft inbox class driver INF is fine). Check `pnputil /enum-drivers`. | Install result `installed`. Write down the real `pnputil` exit code. Check whether every add makes a **new** `oemN.inf`. No window appears in the Staff session. | | |
| 6-16 | Drivers: a package whose catalog is not validly signed. | Refused with `unsigned_driver`. No Windows prompt in the Staff session. | | |
| 6-17 | Drivers: a package with the wrong SHA-256. | Refused. Nothing installed. | | |
| 6-18 | Drivers: a package that returns 3010 or 1641. | Dashboard shows "restart needed". After the next boot the state clears and is re-reported. | | |
| 6-19 | Drivers: reopen the zip while it is locked, and verify a `.cat` through WinVerifyTrust (these were unverified). | Both work. Record anything odd. | | |
| 6-20 | Drivers: remove the assignment. Then try to remove a driver Rulebox did not install. | Only `oemN.inf` packages Rulebox installed are removed, and only while the file still has the recorded SHA-256. Vendor exe/msi drivers are never removed. | | |
| 6-21 | A printer that uses a driver delivered later (install the driver after the printer shows `driver_missing`). | The reconciler retries and the printer turns `ok` (Step 14b open point). If it stays `driver_missing`, write FAIL and name Step 20. | | |
| 6-22 | **real laptop - skip on Hyper-V.** A scanner or USB device driver delivered through Drivers. | Installs. No tile appears. Record the model. | | |

## 7. Safe Mode (plan item 7)

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 7-01 | Boot to Safe Mode (Minimal): run `msconfig`, Boot tab, Safe boot, restart. Revert the setting after the test. | Agent service is running (`sc query RuleboxAgent`). The Staff account is **not** signed in automatically (auto sign-in held off for this boot only). | | |
| 7-02 | Look at the audit log and `status`. | Audit row `device.safeModeBlocked` when a Staff sign-in is attempted. A Staff session that appears is signed out and audited. | | |
| 7-03 | Repeat for Safe Mode with Networking. | Same result (edge case 60). | | |
| 7-04 | Restart normally. | `AutoAdminLogon` is back to 1. The kiosk is back. | | |

## 8. Restore: Disable kiosk (plan item 8)

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 8-01 | Dashboard: **Disable kiosk** (major action: step-up). Watch the device. | Every journal entry restored, each owner in reverse order. No `restore_incomplete` on the device page. Screenshot `8-01-disabled.png`. | | |
| 8-02 | `& $ra lockdown-status`. | Journal clean. Layers off. Save the output. | | |
| 8-03 | Check each target type by hand: `CiTool --list-policies`, AppLocker (`Get-AppLockerPolicy -Local -Xml`), `Get-Service` start types, `Get-Printer`, `netsh wlan show profiles`, `net accounts`, `reg query` for the SafeBoot keys and Winlogon. | Rulebox App Control policies gone, AppLocker policy empty, services back to their original start types (including the delayed-start flag), printers and ports gone, WLAN profiles gone, account lockout policy back, SafeBoot keys gone, Winlogon original, Staff tuning gone. | | |
| 8-04 | App Control removal behaviour: record whether removal needed a restart and what the dashboard said. | Written down per edition and build. Settles "removing an unsigned base policy". | | |
| 8-05 | USB: the policy deny keys are removed after Disable. | Deny keys gone. Devices stay installed (they would return on replug). | | |
| 8-06 | Restart. | Normal Windows sign-in screen. The Staff account is kept. No kiosk policies and no allow-list rules (E-74). | | |
| 8-07 | Export again: `.\export-baseline.ps1 -OutFile C:\rb-evidence\after-disable.txt`. Compare: `Compare-Object (Get-Content C:\rb-evidence\before.txt) (Get-Content C:\rb-evidence\after-disable.txt)`. Paste every difference line in Notes. | **No differences** except Rulebox's own folders and the Staff account. One known difference: the BCD `recoveryenabled` line (a value that was absent comes back as `Yes`, Step 20a deviation). Anything else is a FAIL. | | |
| 8-08 | `unenroll --remove-staff-account` on a freshly enabled kiosk (later, after 9-01) to check the order. | Restore runs first, then the enrollment is removed. Account and profile gone (edge case 53). | | |

## 9. Recover, offline (plan item 9)

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 9-01 | Re-enable the kiosk from the dashboard. Wait for the apply. | All layers come back (`ok`). `lockdown-status` green. | | |
| 9-02 | Network off: `Disconnect-VMNetworkAdapter -VMName rulebox-test-pro` on the host. Sign in as an administrator (use "Other user" if the Staff session is up). | Agent shows `offline`. You can still reach an admin shell. | | |
| 9-03 | Stop and disable the service. Run `& $ra recover --yes` from an elevated prompt. | Prints the result of **each** journal entry, last written first. Works with no Convex. No entry fails. | | |
| 9-04 | Restart. Export: `.\export-baseline.ps1 -OutFile C:\rb-evidence\after-recover.txt`. Compare with `before.txt`. | Same rule as 8-07: no differences except Rulebox folders, the Staff account and the known `recoveryenabled` line. | | |
| 9-05 | Check `state\recovered.flag`, restart, then re-enable the service. | Flag exists. Normal sign-in screen. Staff cannot sign in. Status shows "recovered: kiosk held off" and nothing re-applies. Deleting the flag (or unenroll then enroll) lets it re-enable. | | |
| 9-06 | Reconnect the network: `Connect-VMNetworkAdapter ...`. | Agent online again. | | |

## 10. Budgets (plan item 10, Section 14)

Run these in the VM with everything on (`enforce`). Record the numbers.

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 10-01 | Idle working set: `(Get-Process rulebox-agent).WorkingSet64 / 1MB` after 10 minutes idle. | 20 MB or less. | | |
| 10-02 | Working set during an apply (sample every second while publishing a change). | Peak recorded. Within about 8 MB of idle. | | |
| 10-03 | Idle CPU over 10 minutes: `Get-Counter '\Process(rulebox-agent)\% Processor Time' -SampleInterval 5 -MaxSamples 120`. | Average under 0.5 %. | | |
| 10-04 | 100-process start burst as the Staff user (run `1..100 \| ForEach-Object { Start-Process cmd.exe -ArgumentList '/c','exit' }` in the Staff session, for example through a scheduled task for `RuleboxStaff`). Record agent CPU. | Procwatch decision about 2 ms each. CPU peak recorded. No hang. | | |
| 10-05 | ETW buffer losses during the burst (agent log, counter each minute). | 0. If more than 0, the catch-up snapshot ran once (edge case 45). | | |
| 10-06 | ETW trace under the live reconciler: run a full apply while the burst runs. | No stall, no crash. | | |
| 10-07 | Document sizes: `desired-state.json` for the default group and for a group with 50 or more exceptions. | Typical 12 KB or less, worst 64 KB or less. Bytes recorded. | | |
| 10-08 | Convex dashboard, Logs: apply report with an **unchanged** hash. | Writes 0 documents. | | |
| 10-09 | Convex dashboard, Logs: apply report after a real change; findings flush; daily summary. | Writes match the 4.19 table. One daily row per device per server day. At most 4 findings flushes per day. Write counts recorded. | | |
| 10-10 | Writes per report observed over one hour of normal use. | Number recorded and compared with plan 4.19. | | |

## 11. Phase 2 re-checks still open (plan item 11)

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 11-01 | **Exit-hold timing.** Use the hidden exit (Ctrl+Shift+F12 and the PIN). Sign in as an administrator. Time how long until `AutoAdminLogon` is `1` again. Then use the exit and do **not** sign in; wait 6 minutes; restart. | Value is back to `1` within a minute of the admin signing in. After 6 minutes with no sign-in the kiosk comes back at restart. PIN check time recorded (must be far below 10 s, never above 3 s). | | |
| 11-02 | **Kill-on-close job.** Start a catalogue app from the Staff App. Then end the Staff App process from an admin session. | The app's child processes end with it (job object closes). Result recorded. | | |
| 11-03 | **`recover` for LSA owners.** Before enrolling on a fresh checkpoint, set up Sysinternals Autologon for the account. Enroll, then `recover --yes`. | Write down what `AutoAdminLogon` is afterwards and what the sign-in screen does. Known gap: it may stay `1` with no password. | | |
| 11-04 | After the exit, sign out of the admin session. | Write down whether Windows signs Staff in by itself or stays at the sign-in screen: ______ | | |

## 12. USB per device class (plan item 12, Section 4.7a, E-66..E-69)

Hyper-V passes a USB device to a guest only through enhanced-session redirection or a vendor tool.
Enhanced session is off on this host. Try the VM first. Anything it cannot test is `PILOT`.
**E-67 is mandatory on the real laptop pilot.**

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| 12-01 | Set all five USB switches (storage, printers, imaging, phones, other) to `block` in the group. Read the effective keys: `reg query "HKLM\SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions" /s`, and the Staff hive `RemovableStorageDevices` key. | Key names and class GUIDs match plan 4.7a. Write down any key or GUID that differs (plan fix). | | |
| 12-02 | With every switch on `block`: use the VM's own virtual keyboard and mouse. Restart and use them again. | Keyboard and mouse keep working (E-67, VM part). The line "Keyboards, mice and touch screens always work." is on the dashboard Lockdown tab. | | |
| 12-03 | Check that no deny table lists HID, keyboard, mouse, USB hub or root-hub classes: read the `DenyDeviceClasses` list. | None of those classes are in the list (invariant I10). | | |
| 12-04 | Step 14 network printers with `usb.printers` set to `block`: run 6-03 again. | The raw TCP printer still creates `ok` and prints (it is a print queue, not a USB device). | | |
| 12-05 | Passing a USB device to the VM: record whether a way exists on this host (vendor tool, enhanced session, USB over network). | Yes or no, with the method. If no, rows 12-06 to 12-13 are `PILOT`. | | |
| 12-06 | **real laptop - skip on Hyper-V.** USB stick with storage `allow`. | Reads and writes work. | | |
| 12-07 | **real laptop - skip on Hyper-V.** Storage `readOnly`: new stick. | Reads work. Writes denied. (E-39 too: nothing runs from the stick.) | | |
| 12-08 | **real laptop - skip on Hyper-V.** Storage `block`: new stick. | Not usable by the Staff user. Admin unaffected (storage is Staff scope). | | |
| 12-09 | **real laptop - skip on Hyper-V.** A stick already plugged in when the policy arrives. | Keeps working until replug (unless retroactive is on). Retroactive removal is **not built** (no seam lists devices): record that nothing is removed. | | |
| 12-10 | **real laptop - skip on Hyper-V.** USB printer and a camera with their switches on `block` and on `allow`. | Blocked class is not usable after replug. Allowed class works. Other classes unaffected (storage blocked: printer still prints). | | |
| 12-11 | **real laptop - skip on Hyper-V.** Composite device: keyboard with a card reader, or a headset. All switches on `block`. | The keyboard or audio part keeps working. Storage part blocked. A combo Windows binds as one function stays allowed and is reported as `usb_combo_unsplit` (settles the composite parent question). | | |
| 12-12 | **real laptop - skip on Hyper-V.** Bluetooth mouse pairs with every switch on `block`. | Pairs and works (E-67). | | |
| 12-13 | **real laptop - skip on Hyper-V.** Does the Staff App show "USB drives are turned off on this PC" when a drive arrives with storage `block`? | Record feasible or not feasible (edge case 67). If not, dashboard text covers it. | | |
| 12-14 | Allow USB for this PC (device page, temporary, max 8 hours): set a short time. Watch the deny keys. | Deny keys relax during the window and come back on their own within the minute after it ends. Audit `device.usbTempAllow`. | | |
| 12-15 | Disable kiosk with USB switches on `block` (after 8-01). | Deny keys removed. Keyboard and mouse still work. `recover` needs no USB keyboard beyond what Windows needs. | | |

## X. Other "unverified until Step 21" items from the Built notes

These came from the Built notes of Steps 14 to 20a, the plan's Section 21 and the edge-case table.
Each is also a way to confirm or disprove a plan item.

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| X-01 | **Drift.** As administrator change one Rulebox-owned policy value in the registry by hand. Wait for the next reconcile (up to 10 minutes) or restart the service. | Value is written back without touching the saved original. `deviceSecurityDaily.drift` counts it. Audit `device.driftReasserted` once per target per day. | | |
| X-02 | **Tamper repair (Step 17).** As administrator, change the permissions on `%ProgramFiles%\Rulebox` (or the service security descriptor) and wait one reconcile. | Repaired. Audit `device.tamperDetected` once per item per day with detail `install_acl` (or `service_acl`). `aclDrift` increases. | | |
| X-03 | **Clock jump.** Move the VM clock forward 20 minutes, then back. | One `device.clockJump` audit per jump (`forward`, `back`). Offline sign-in timer reset as in Phase 2. | | |
| X-04 | **Lock (Step 15).** Dashboard: Lock this PC with a message and contact (major action). | Employee session ends. Lock view covers the screen. Sign-in refused with `deviceLocked`. No sign-in field. Screenshot `X-04-lock.png`. | | |
| X-05 | Restart while locked. Then use the hidden exit and re-arm. | Still locked after restart. Still locked after the admin exit and re-arm. Only Unlock clears it. | | |
| X-06 | **Offline lock.** Network off, lock from the dashboard, network on. | Dashboard says "Lock pending". Lock applies when the PC reconnects. Locked PC unlocks only by a new document. | | |
| X-07 | **Broadcast banner and full-screen (Step 15 and 12).** Send both kinds, one with HTML characters in the text, one already expired. | Banner and full-screen notice show with "OK". HTML text shows literally. The expired one is not shown. Nothing unlocks. | | |
| X-08 | **Acknowledgements.** Press OK on a broadcast. Watch the dashboard count. | Count goes up by 1 for this PC. Note whether it arrived with the next apply report or after 10 minutes (the ack flush was not wired to apply reports in Step 15). | | |
| X-09 | **Web app permission denials (Step 11).** Open a web app that asks for the camera or location. Wait 60 seconds or sign out. | No prompt, request denied. Denial count appears in the app's Permissions tab for 30 days. No origin or URL recorded. | | |
| X-10 | **Windows-key combinations (Step 12).** With the Staff App as shell: lone Windows key and a few Windows-key combinations. | Lone key opens Rulebox Start. Combinations open nothing. | | |
| X-11 | **Foreign AppLocker policy (edge case 9).** Before enabling, create a local AppLocker policy by hand and enable the kiosk. Restore the VM checkpoint afterwards. | Layer shows `applocker_foreign_policy` and is refused. The existing policy is not edited. | | |
| X-12 | **Half-way apply (edge case 2).** Start an apply from the dashboard and turn the VM off hard (`Stop-VM -TurnOff`) a few seconds in. Repeat 3 times with different delays. | After the next start the device ends in the old or the new state, never between. | | |
| X-13 | **Hidden admin tiles.** Before E-71 passes: publish `hideAdminTiles`. | Refused `admin_signin_unverified`. After E-71 passes (run 2): set `adminSigninVerified` to `true` in `C:\ProgramData\Rulebox\state\agent-config.json`, restart the service, publish again. It applies. | | |
| X-14 | **Feature update (edge case 19).** If the VM can take a Windows feature update (it is not updated at the checkpoint): update, then look at the device. | Agent re-applies all layers, reports `featureUpdateReapplied`. App Control policies in the Active folder survive. If the VM cannot update, record `PILOT`. | | |
| X-15 | **BitLocker and BCD.** Optional. BitLocker off: set `boot.autoRecovery` to off. | `recoveryenabled` is `No`. After Disable it is `Yes` (known). With BitLocker **on** (vTPM VM), the agent uses `leave` and Windows asks for no recovery key. Records whether `recoveryenabled` is in the validation set. | | |
| X-16 | **Dashboard screens with real data.** Screenshot each new screen with the live dev deployment: group Lockdown (rules, USB, exceptions), Findings, device Lockdown, Protection and Allow USB cards, Rollout tab, Messages, Wi-Fi and Printers, Drivers, overview warnings. Light, dark, 1280 and 390 wide. | Screens look right and open without errors. Step 19 screenshots were not yet taken. (The overview chunk went 0.5 KB over its budget, needs your OK, not a VM item.) | | |
| X-17 | **Device page Physical protection card.** | Lists Secure Boot, BitLocker, auto-recovery and Safe Mode agent. Shows the sentence "Someone with physical access and boot media can bypass software controls on this PC" while any is missing. | | |
| X-18 | **ARM64 and Windows 10 22H2.** | Not tested here. Record `N/A, no VM`. | | |
| X-19 | **real laptop - skip on Hyper-V.** Sleep and wake. | After wake no password is asked (`noWakePassword`) and the kiosk is still locked down as set. | | |
| X-20 | **real laptop - skip on Hyper-V.** Second monitor. | Lock view and full-screen broadcast cover **every** monitor (edge case 17). | | |

## Run 1 summary (send back)

| Item | Result |
|---|---|
| Edition / build | |
| Layers `ok` in audit (list any not ok) | |
| Journal entry count / payload bytes | |
| AppLocker mechanism that applied | |
| AppLocker applies to SYSTEM-started processes? | |
| App Control refresh or restart (activate and remove) | |
| LKG rollback time / halt shown | |
| Rollback new version number | |
| Baseline diff (before vs after Disable, before vs after recover) | |
| Agent working set idle / peak / CPU idle / burst | |
| Measured privilege list | |
| Rows moved to PILOT | |
| Anything that failed or surprised you | |

---

# Run 2 - Step 22: escape checklist E-01..E-89

Start: VM reverted to `fresh-windows-11-pro`, deployed and enrolled as in Run 1, **all layers in
`enforce`, default group settings**. Do the Staff-user checks **as the Staff user**.
Record only **pass/fail, evidence and residual risk**. Write the build for rows that depend on it.

Run order:

1. The way back (E-70..E-74) **first**.
2. Walk the rows in order. A **fail** in E-70..E-74 stops the run. The step that owns the control
   is reopened before anything else.
3. The way back again **last**.

## S2. Setup for run 2

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| S2-01 | Revert to `fresh-windows-11-pro`, deploy, enroll (section 0.2). Marker present (P-03). | Enrolled, kiosk on. | | |
| S2-02 | Dashboard group Lockdown tab: L3, L4 and L5 on `enforce`; every other layer on. Default group settings otherwise. Rings: you may leave them off for this run. | `lockdown-status` all green. Save `S2-02-status.txt`. | | |
| S2-03 | Build, Windows edition and build number recorded at the top of this file. | Recorded. | | |
| S2-04 | Keep a copy of an early `desired-state.json` for E-79 and E-84: `Copy-Item C:\ProgramData\Rulebox\state\desired-state.json C:\rb-evidence\desired-old.json`, then publish one new change. | Two different versions exist. | | |
| S2-05 | `hideAdminTiles` is needed for E-71 to mean anything, but the agent refuses it until `adminSigninVerified` is set. Set `adminSigninVerified` to `true` in `agent-config.json` **for the test**, restart the service, publish. Set it back to `false` if E-71 fails. | `hideAdminTiles` applies. | | |

## The way back, first pass (must all pass)

| # | Route (short label) | Pass looks like | Result (first) | Result (last) | Evidence / residual risk |
|---|---|---|---|---|---|
| E-70 | Hidden administrator exit | Exit dialog opens with the key combination and accepts the right PIN. | | | |
| E-71 | "Other user" sign-in tile | After all policies the sign-in screen still offers a way to sign in as another account. | | | |
| E-72 | Shift at startup | Holding the key at sign-in starts the fallback instead of the Staff shell. | | | |
| E-73 | `recover` on the machine | After `& $ra recover --yes` the Staff account is a normal account again. (Redeploy and re-enroll after this row, or run it last.) | | | |
| E-74 | Disable kiosk from the dashboard | After the command the machine has no kiosk policies and no allow-list rules. (Re-enable afterwards.) | | | |
| E-70 to E-74 | If any is FAIL | **Stop the run.** Read "If something fails". | | | |

## Session and sign-in screen (E-01..E-09)

| # | Route | Pass looks like | Hardware | Result | Evidence / residual risk |
|---|---|---|---|---|---|
| E-01 | Security screen (Ctrl+Alt+End in the VM window) | No Task Manager item for Staff. | VM | | |
| E-02 | Switch user | Sign-in lists no tile that leads to an admin shell without the "Other user" way. | VM | | |
| E-03 | Windows sign-out | After sign-out and auto sign-in the shell is back. | VM | | |
| E-04 | Windows lock screen | The lock shortcut shows the Rulebox lock screen or nothing. | VM | | |
| E-05 | Disconnected or second sessions | No second Staff session can be created. | VM | | |
| E-06 | Accounts with no password | No sign-in path accepts an empty password. | VM | | |

## Keyboard (E-10..E-19)

| # | Route | Pass looks like | Hardware | Result | Evidence / residual risk |
|---|---|---|---|---|---|
| E-10 | Windows key alone | Rulebox Start opens. Windows Start does not exist. | VM | | |
| E-11 | Windows-key combinations | None of the listed combinations opens a window. | VM (window option for Windows keys) | | |
| E-12 | Task Manager shortcut | The shortcut shows nothing. | VM | | |
| E-13 | Alt+Tab and task view | Switcher shows only Rulebox-listed windows. | VM | | |
| E-14 | Alt+F4 on the shell | The shell stays or returns within the restart time. | VM | | |
| E-15 | Function and media keys that launch programs | Pressing the keys starts nothing. | **real laptop - skip on Hyper-V** | | |
| E-16 | Touch gestures and edge swipes | Swipes from the screen edges open nothing. | **real laptop - skip on Hyper-V** | | |
| E-17 | Sticky, Filter and Toggle keys prompts | Five Shift presses show no dialog. | VM | | |
| E-18 | Voice access and dictation shortcuts | The shortcuts start nothing. | **real laptop - skip on Hyper-V** (needs a microphone) | | |
| E-19 | Screenshot and recording shortcuts | The shortcuts start no capture tool. | VM | | |

## Dialogs inside allowed apps (E-20..E-25)

| # | Route | Pass looks like | Hardware | Result | Evidence / residual risk |
|---|---|---|---|---|---|
| E-20 | Open and Save dialogs | Choosing a program or script file in the dialog cannot start it. | VM | | |
| E-21 | "Open file location" and "Open with" | No entry starts a program that is not in the catalogue. | VM | | |
| E-22 | Print dialog | The printer list shows only assigned printers. (Assign the raw TCP printer of 6-03.) | VM | | |
| E-23 | Help and "Learn more" links | A Help link opens a blocked page or nothing. | VM | | |
| E-24 | Drag and drop onto the shell | Dropping a file on the desktop does nothing. | VM | | |
| E-25 | Clipboard with a program path | Pasting a path starts nothing. | VM | | |

## Program start control (E-30..E-39)

| # | Route | Pass looks like | Hardware | Result | Evidence / residual risk |
|---|---|---|---|---|---|
| E-30 | Program not in the catalogue | Windows "blocked" message and a finding appears. | VM | | |
| E-31 | Scripts and script hosts | A script file in the employee folder does not run. | VM | | |
| E-32 | Installers and installer packages | An installer file in the employee folder does not run. | VM | | |
| E-33 | User-writable folders | A copy of an allowed program in a writable folder does not run. | VM | | |
| E-34 | Elevation prompts (UAC) | No UAC prompt in the Staff session. A program that needs elevation shows the Rulebox notice. | VM | | |
| E-35 | Hand-off launchers | The stub starts only the listed packaged app. | VM | | |
| E-36 | Windows built-in tools | None can be started from any Rulebox path. | VM | | |
| E-37 | Legacy components that run code | The listed components are blocked. | VM | | |
| E-38 | Task Scheduler and services entries | A Staff process cannot create a task or service. | VM | | |
| E-39 | Portable apps from a USB stick | With storage `readOnly`, nothing copies onto the stick and nothing on the stick runs (each storage mode). | **real laptop - skip on Hyper-V** (needs a USB stick) | | |

## Web apps and links (E-40..E-48)

| # | Route | Pass looks like | Hardware | Result | Evidence / residual risk |
|---|---|---|---|---|---|
| E-40 | Link outside the allow list | The blocked page appears. | VM | | |
| E-41 | Pop-up or new window | No extra window opens for an unlisted address. | VM | | |
| E-42 | External protocol links | Clicking such a link starts no program. | VM | | |
| E-43 | Downloads from a site | A downloaded program is blocked by name and by the allow list. | VM | | |
| E-44 | Camera, microphone, location, notifications, clipboard, file requests | No prompt, request denied, denial count increases. | VM | | |
| E-45 | File pickers and print calls from a site | Picker shows only the employee folder. | VM | | |
| E-46 | Developer tools and view-source | Shortcuts do nothing. **This is a debug build on the VM**: record `N/A (debug build)` and run it on a release build in Phase 6. | VM (release build only) | | |
| E-47 | Another employee's saved sign-ins | Second employee sees no first-employee session. | VM | | |
| E-48 | Credential and autofill prompts | No prompt appears. | VM | | |

## Accessibility and sign-in-screen tools (E-50..E-55)

| # | Route | Pass looks like | Hardware | Result | Evidence / residual risk |
|---|---|---|---|---|---|
| E-50 | Narrator, Magnifier, on-screen keyboard from the sign-in screen | Ease of Access button starts only the allowed tools. | VM | | |
| E-51 | Ease of Access tools launching other programs | A tool that offers "open" cannot start an unlisted program. | VM | | |
| E-52 | Sign-in screen network and power menus | Staff cannot change network settings from the sign-in screen. | VM | | |
| E-53 | Windows Hello and sign-in options | No extra sign-in option for Staff. | VM | | |
| E-54 | Notification toasts from other apps | A toast from an unlisted source does not appear. | VM | | |
| E-55 | Windows feature pop-ups | None appear after sign-in. | VM | | |

## Boot, recovery, network, USB (E-60..E-69)

| # | Route | Pass looks like | Hardware | Result | Evidence / residual risk |
|---|---|---|---|---|---|
| E-60 | Safe Mode boot | Staff is not signed in automatically in Safe Mode. (Same as 7-01 to 7-04.) | VM | | |
| E-61 | Recovery environment and boot menu | The documented residual risk is shown in the dashboard (Physical protection card). | VM (dashboard) | | |
| E-62 | Boot from USB or network | The install checklist asks the installer to set a firmware password. The install guide is a Phase 6 item: record `N/A until Phase 6` if it does not exist yet. | VM (document check) | | |
| E-63 | Network shares and remote tools | Staff has no share access to other machines (try the host over the Default Switch). | VM | | |
| E-64 | Second user account created by someone | A new account shows as a finding within the report interval. | VM | | |
| E-65 | Windows Update and restart prompts | No restart prompt interrupts the Staff session. | VM | | |
| E-66 | USB drives, printers, scanners, cameras, phones (per class) | Each class on `block` is unusable for new devices after replug. Each on `allow` works. An unrelated class is unaffected. | **real laptop - skip on Hyper-V** (VM part is run 1 section 12) | | |
| E-67 | Keyboards, mice, touch screens, pens, barcode scanners, hubs, composite parents under every USB setting | **Must pass.** With every USB switch on `block`, USB keyboard and mouse still work after replug and reboot. A Bluetooth mouse still pairs. A composite device keeps its HID or audio part. Record `PILOT` if the VM cannot pass USB through. | **real laptop - skip on Hyper-V** (mandatory on the pilot) | | |
| E-68 | Printer-only group and multifunction printers | The USB printer prints. A card in the printer's reader and a USB stick are not available to Staff. | **real laptop - skip on Hyper-V** (needs a real USB printer) | | |
| E-69 | Devices already plugged in, and the temporary allow | A plugged-in stick keeps working until replug. The temporary allow ends by itself within the minute after its time. HID is never removed. (The temporary-allow part runs in 12-14.) | **real laptop - skip on Hyper-V** (needs a USB stick) | | |

## Tamper (E-75..E-79)

| # | Route | Pass looks like | Hardware | Result | Evidence / residual risk |
|---|---|---|---|---|---|
| E-75 | Stopping or changing the agent service | A Staff process cannot stop it. An administrator stop is reported as a finding when it returns. | VM | | |
| E-76 | Editing the agent's files or config | A Staff process cannot write there. | VM | | |
| E-77 | Editing the policy registry keys | A Staff process cannot write. A change by an administrator is re-applied and reported (same as X-01). | VM | | |
| E-78 | Changing the clock to extend offline sign-in | A changed clock does not extend the allowed offline period (same as X-03). | VM | | |
| E-79 | Replacing the agent with an older version | An older signed document (`desired-old.json` from S2-04) is refused. | VM | | |

## Device lock, broadcasts, offline and replay (E-80..E-89)

| # | Route | Pass looks like | Hardware | Result | Evidence / residual risk |
|---|---|---|---|---|---|
| E-80 | Device lock | While locked, no employee can sign in. After restart it is still locked. Win+L and the hidden exit are tried while locked (the exit works, the lock stays). | VM (every-monitor part: real laptop) | | |
| E-81 | Revoked device | After revoke the device remains locked. Re-enroll needs a new code. | VM | | |
| E-82 | Broadcast message | The message appears and does not unlock anything. | VM | | |
| E-83 | Offline device during a ring rollout | An offline device applies the new version once, and not older ones. (Network off, publish two changes, network on.) | VM | | |
| E-84 | Replay of an older signed policy | The older document is refused and logged. | VM | | |
| E-85 | Policy that would remove the way back | Refused with the matching code (I1 to I10). Device keeps the old one. (Same as 4-01.) | VM | | |
| E-86 | Policy applied half way (power loss) | After a power cut during apply the device ends in the old or new state, never between. (Same as X-12.) | VM | | |
| E-87 | App Control or AppLocker blocking Rulebox itself | In enforce mode the agent, the launcher and the Staff App all start. | VM | | |
| E-88 | Antivirus quarantining a Rulebox file | A removed file is reported and repaired from the version store. | VM | | |
| E-89 | Windows feature update resets settings | After an update the policies are back and a finding is recorded. (Needs a feature update. Same as X-14. `PILOT` if the VM cannot update.) | VM or PILOT | | |

## The way back, last pass

Run E-70..E-74 again now and fill the "Result (last)" column in the first table. Any FAIL stops the
run.

## Home VM (optional, recorded separately)

Skip if you have no Home VM and write `not tested, no Home VM`. Same steps as run 2.

| # | Do this | Expected | Result | Notes |
|---|---|---|---|---|
| H-01 | Edition and build recorded. | Recorded. | | |
| H-02 | Device page: which layers report `unsupported`? List them. | AppLocker and App Control may be `unsupported`. Badge "Reduced protection (Home)". Layers L1, L2, L5, L6, L7 still apply. | | |
| H-03 | Which AppLocker mechanism works on Home (MDM bridge or local policy)? | Recorded. Settles the Home AppLocker item. | | |
| H-04 | Does App Control work on Home? | Recorded. | | |
| H-05 | Walk the E rows that the remaining layers cover. | Each passes or is `N/A` with the reason. | | |
| H-06 | Hide Switch user on Home. | Recorded: it is machine-wide on Home (plan 3.3). | | |
| H-07 | Does "Other user" show with admin tiles hidden (E-71)? | Recorded. | | |
| H-08 | Fill the PRD 13.2 "Verify" cells from H-02 to H-07. | Cells filled. | | |

## Run 2 summary (send back)

| Item | Result |
|---|---|
| Edition / build | |
| E-70..E-74 first pass (all PASS?) | |
| E-70..E-74 last pass (all PASS?) | |
| E-67 result (or PILOT) | |
| Rows FAIL (with the owner step) | |
| Rows PILOT (real laptop) | |
| Rows N/A | |
| Home VM result | |

---

## If something fails

1. **Do not fix it on the spot.** Write the row as FAIL first.
2. **Capture the evidence** (VM shell, before you change anything):
   - `& $ra lockdown-status --json | Out-File C:\rb-evidence\<row>-status.json -Encoding utf8`
   - `& $ra lockdown-status | Out-File C:\rb-evidence\<row>-status.txt`
   - `& $ra status --json | Out-File C:\rb-evidence\<row>-agent.json -Encoding utf8`
   - `Copy-Item C:\ProgramData\Rulebox\logs C:\rb-evidence\<row>-logs -Recurse`
   - A screenshot of the screen, and the device page in the dashboard.
   - Optionally `lockdown-last.json`, `findings.json` and `lkg.json` from the state folder. Send
     `desired-state.json`, `agent-config.json` and the journal only after you have read them.
3. **Copy the evidence to the host**, into `D:\work\personal\rulebox\.tmp\phase5\`.
4. **A way-back row failed (E-70..E-74)?** Stop the run. Try, in this order: hold Shift at sign-in;
   "Other user"; `& $ra recover --yes` as an administrator. If none works, revert to the
   checkpoint.
5. **The VM is stuck or in a bad state?** Revert:
   `Restore-VMSnapshot -VMName rulebox-test-pro -Name 'before-phase5-run1' -Confirm:$false`
   (or `fresh-windows-11-pro` for a fully clean start), then start it again.
6. Put the **owner step** that owns the control in the Notes column (Section 6 of the plan names
   the closing control; the step list says which step built it). The main session reopens that
   step.
7. After the fix: rebuild, re-copy, check hashes, restart the VM gracefully, **run the row again**.

When the whole run is done, revert the VM to its checkpoint so the next run starts clean.

## Open points before you start

- **`--simulate-crash-loop` (row 4-02): settled.** The debug launcher passes the flag when the
  file `simulate-crash-loop.flag` is in its install folder (`C:\Program Files\Rulebox\`) and the
  test-machine marker is present (`apps/shell-launcher/src/crashflag.rs`). Release builds
  compile it out. The exact steps are in row 4-02. Rebuild and re-copy `rulebox-shell.exe`
  (P-05, P-06) so the VM has this change.
- **Escape-row count.** The plan's checklist note says 74 rows are written. Section 6 actually has
  77 rows (E-01..E-06, E-10..E-19, E-20..E-25, E-30..E-39, E-40..E-48, E-50..E-55, E-60..E-69,
  E-70..E-79, E-80..E-89). This file lists all 77.
- **Dashboard size budget.** Step 19 raised the overview route 0.5 KB over its budget (166 / 27 to
  166 / 27.5). It needs your OK. This is not a VM item.
