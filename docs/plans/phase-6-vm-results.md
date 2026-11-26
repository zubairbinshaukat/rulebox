# Phase 6 — VM results

## Run A (Step 22): the installer — 2026-11-26

**Machine:** `rulebox-test-pro`, Windows 11 Pro 26300.9457, from the `fresh-windows-11-pro` checkpoint.
The network adapter was disconnected and the update services stopped. The owner set the VM to **2.5 GB**
for this run because the host had too little free memory; a checkpoint revert brings it back to 4 GB.
The run used a working checkpoint (`run22-base`, deleted at the end). At the end the VM was reverted to
`fresh-windows-11-pro`: Off, 4 GB, `Default Switch`.

**Driven by:** Claude Code from the host, over PowerShell Direct (as `rbtest`). Programs ran through
scheduled tasks: as SYSTEM (session 0), as `rbtest` elevated, or as `rbtest` not elevated. Clicks were
synthetic mouse input.

**Evidence:** `docs/plans/phase-6-vm-runs/`, with a file list at the end of this section. Helper scripts
are in `phase-6-vm-runs/tools/`.

### The MSIs

| File | SHA-256 | What it is |
|---|---|---|
| `Rulebox-0.1.0-x64-unsigned.msi` | `3f6b717b…7f7d5f` (checked before copying in) | CI release run 45683999619, as given |
| `Rulebox-0.1.0-x64-fixed.msi` | `688f7771…7971a9` | The same MSI with one LaunchCondition row removed: the free-space check (bug 1 below), as in the fixed `Checks.wxs`. It has a new ProductCode and PackageCode. |
| `Rulebox-0.1.1-x64-test.msi` | `629ade4e…0e5093` | The fixed copy with ProductVersion 0.1.1, matching Upgrade rows, and the event-source registry rows (bug 3 below). It contains the same binaries. |
| `Rulebox-0.1.2-x64-test.msi` | `a709e552…10efdf` | The 0.1.1 copy plus a deferred `cmd.exe /c exit 1` just before InstallFinalize, to force a failed upgrade |

The copies were made with Windows' built-in `WindowsInstaller.Installer` COM table export and import
(`tools/make-variant.ps1`, `tools/msiidt.ps1`). Nothing was installed on the dev PC, and no WiX build was
done. The binaries are the CI binaries in every copy, so the agent says `0.0.0` in all of them (bug 2 below).

### Results

| # | Step 22 item | Result | Evidence |
|---|---|---|---|
| 1a | Unsigned MSI, UI install (as given) | **FAIL → fixed** | Every install (UI and silent) stops with "Rulebox needs 2 GB of free disk space". The disk had 39 GB free, but `PrimaryVolumeSpaceAvailable = 0` at LaunchConditions, with or without `PrimaryFolder`. The S-7 Chrome and Edge MSI logs show the same 0. See `a-1-ui-0.1.0-original-msi-log.txt`, `a-1-ui-primaryfolder-probe-msi-log.txt`, `a-1-qn-primaryfolder-probe-msi-log.txt` and `a-1-ui-01-original-msi-disk-error.jpg`. |
| 1b | UI install, elevated (fixed copy) | **PASS** | Licence page, Install, then the finish page with "Start Rulebox Setup" ticked. Execute phase about 7 s. See `a-1-ui-11..16*.jpg`, `a-1-ui-install-msi-log.txt` and `a-1-ui-checks.txt`. |
| 1c | UI install started without elevation (as a double-click does) | **PASS** | UAC for the MSI at Install ("unknown publisher"). Finish then starts Setup without elevation, Setup asks UAC itself and relaunches as `setup --relaunched`. See `a-1-ui-21..24*.jpg` and `a-1-ui-unelevated-*`. |
| 1d | Silent install with `ENROLLCODE` | **PASS, one part DIFFERS** | Exit 0 in 4.1 s. The `Install\Pending` key SDDL is `D:P(A;OICI;KA;;;SY)(A;OICI;KA;;;BA)`, set without a custom action. The property lines show `**********`. **Differs:** the verbose log prints the whole code in `RegAddValue(Name=Code,Value=RBX1.…)`. Windows Installer cannot hide a Registry-table value. The code used was a fake, well-formed one (`https://example.invalid`). See `a-1-silent-msi-log.txt`. |
| 1e | Agent uses the pending code | **PASS** | Network off: 3 tries (`backend_unreachable`), then the value `Code` was deleted and Error event 1002 was written with clear next steps. The code is not in the agent log. The empty `Pending` key stays until uninstall. See `a-agent-log.txt` and `a-1-silent-checks.txt`. |
| 1f | Signed MSI | not run | No signed build exists yet (SignPath is off). |
| 2a | Launch condition: not an administrator | **PASS** | A silent install from `rbtest` without elevation exits 1603 with "Rulebox must be installed by an administrator…". See `a-2-nonadmin-msi-log.txt`. |
| 2b | Launch condition: low disk (small VHD) | not run | The condition was removed (bug 1). Windows Installer's own out-of-disk check and the compat `low_disk` warning remain; neither was tried with a full disk. |
| 2c | Windows 10 22H2 VM | not run | No Windows 10 VM. |
| 3 | Production guard | **PASS** | `guard-status` on the installed exe: open through the production door (all 6 lines ok, no test marker). The same exe copied to `C:\rb-run\copy`: closed (`install_dir_is_exe_folder` and `install_folder_admin_only` fail), exit 1. See `a-3-guard.txt`. |
| 4 | Setup window: compat report, WebView2 | **PASS** | Shows "Protection: full", "WebView2 Runtime: version 155.0.4283.45" and the low-RAM warning (2.5 GB VM). A bad code gives "That is not a valid enrollment code…". The Windows 10 / no-WebView2 case was not run. See `a-1-ui-15*.jpg`, `a-1-ui-16*.jpg` and `a-3-guard.txt` (`compat`). |
| 5 | Enroll, kiosk on, E-70..E-74 | not run | Needs an enrollment code from the dashboard and the network. Left for run A2 or run B. |
| 6a | Upgrade to a higher version | **PASS** | 0.1.0 → 0.1.1 silent, exit 0 in 6.3 s. The service restarted (PID 4308 → 3136). `ProgramData\Rulebox` was kept (a file written before the upgrade was still there). The marker shows `Version` 0.1.1, and `ComputerName` and `KioskOn` were written again by the agent. One ARP entry (0.1.1). See `a-6-before-upgrade.txt`, `a-6-upgrade-*`. |
| 6b | A forced failing upgrade | **PASS** | 0.1.1 → 0.1.2: exit 1603 after the new service had started. The rollback restored 0.1.1, and the service runs. The footprint snapshot before and after is identical (no lines). The two "Error in rollback skipped. Return: 5" lines are the normal end-of-script markers. See `a-6-failing-upgrade-*`, `snap-before/after-failing-upgrade.txt`. |
| 6c | Downgrade (extra) | **PASS** | 0.1.0 over 0.1.1: exit 1603 with the `DowngradeErrorMessage`; 0.1.1 stays. See `a-6-downgrade-msi-log.txt`. |
| 7a | Uninstall with the kiosk on → refused | **PASS (marker set by hand)** | `KioskOn=1` set by hand, because the kiosk cannot be turned on without enrollment. Silent `/x`: 1603, "Turn kiosk mode off first…". Basic UI `/x /qb`: the same message box. After a service restart the agent wrote `KioskOn=0` again. See `a-7-uninstall-kiosk-on*` and `a-7-uninstall-refused.jpg`. |
| 7b | Uninstall → baseline diff empty | **PASS, one part DIFFERS** | Exit 0 in 2.1 s. The `export-baseline.ps1` diff is empty. Service, files, `HKLM\SOFTWARE\Rulebox`, event source, Start menu and ARP are gone. **Left behind:** `C:\ProgramData\Rulebox\` (`logs\`, `state\agent-state.json`, `state\secrets.bin`); see Q-A2. The `RetailDemo\CleanupOfflineContent` task line is Windows removing a one-time task. See `snap-after-uninstall-2.txt`, `baseline-after-uninstall-2.txt`. |
| 8 | The three Phase 2 late fixes | not run | They need an enrolled kiosk with a Staff session. |
| 9 | Agent-driven upgrade (Step 20) | not run; **blocked by bug 2, now fixed** | Needs enrollment and a `ruleboxRelease` document. As built, every attempt would have ended `did_not_take` (the agent said 0.0.0). |
| — | Install-time budget (≤ 60 s) | **PASS** | UI execute phase about 7 s, silent 4.1 s, upgrade 6.3 s, uninstall 2.1 s. |
| — | Service and folder (extra) | **PASS, one note** | `RuleboxAgent`: own process, auto start, LocalSystem, `"…\rulebox-agent.exe" service run`, restart after 5 s three times, reset after 1 day. The folder SDDL is exactly `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)` (protected), and the files inherit it. The `Rulebox Setup.lnk` target is `rulebox-agent.exe setup`. **Note:** the service DACL is Windows' default and the required-privileges list is empty, because the agent sets them only while a lockdown is applied (L7). The plan and `Service.wxs` said "at every start"; the text is corrected. See `a-1-ui-checks.txt`. |

### Bugs found and fixed

1. **The free-space launch condition refused every install** (`Checks.wxs`). `PrimaryVolumeSpaceAvailable`
   is 0 at LaunchConditions in this package, in the UI and in silent installs, even with `PrimaryFolder`
   set. The condition was removed. Windows Installer's costing still refuses files that do not fit, and
   the 2 GB headroom is the compat report's `low_disk` warning. The static test now checks that no
   free-space condition is present. Tested on the VM with the same change made to the table.
2. **The release agent reported version 0.0.0** (`CARGO_PKG_VERSION`), so self-update would record every
   upgrade as `did_not_take`, and the dashboard and the IPC hello would show 0.0.0. The fix:
   - `apps/agent/build.rs` turns `RULEBOX_VERSION` (x.y.z, checked) into `RULEBOX_AGENT_VERSION`.
   - `crate::AGENT_VERSION` replaces every `CARGO_PKG_VERSION` use in the agent, including `--version`.
   - `release.yml` sets `RULEBOX_VERSION` from the tag for the agent build.
   - `build.ps1` refuses an agent whose `--version` is not the MSI version.
   - A unit test checks the value.
   - The Staff App (`rulebox-staff.exe` file version 0.0.0) and the launcher carry no release version yet. The agent does not compare their versions.
3. **The event source was not registered**, so Event Viewer showed "the description cannot be found"
   instead of the agent's text. `Package.wxs` now registers `Rulebox Agent` with the .NET Framework 4
   `EventLogMessages.dll`. EventCreate.exe was not used because it covers ids 1–1000 only, and the agent
   uses 1001 and up. Tested on the VM: by hand first, then through the 0.1.1 test MSI (the old event
   rendered); uninstall removed the key. A static test was added.

Doc corrections: `Service.wxs` and plan 4.10 (service DACL and privileges), `Package.wxs`, the README
and plan 4.10 (`ENROLLCODE` in verbose logs), and the installer README ("checked on the VM").

### Open questions for the owner

- **Q-A1 — `ENROLLCODE` in a verbose MSI log.**
  - (a) Accept and document it. Already done in the README and plan: never use `/l*v` with `ENROLLCODE`, or delete the log, and prefer short-lived codes for mass installs.
  - (b) Drop the property and enroll in a second step: `rulebox-agent enroll`, reading the code from stdin or a file so it is not on a command line.
  - (c) Add a small hidden custom action. This breaks the "no custom action but the finish page" rule.
  - **Recommendation: (a) for the pilot, (b) before v1 if fleets use multi-use codes.**
- **Q-A2 — what uninstall leaves behind.** After uninstall, `C:\ProgramData\Rulebox\` stays with logs, state and `secrets.bin` (admin-only ACL). PRD 13 says uninstall "fully restores" Windows, but does not mention data.
  - (a) Keep it (a reinstall keeps its history).
  - (b) Remove it at uninstall, through `RemoveFolderEx` from the WiX Util extension, which is not a script.
  - (c) Keep logs and delete `secrets.bin` through the agent's `unenroll`.
  - **Recommendation: (c)**: an uninstalled PC should not keep device credentials.

### Lessons for the next VM run

- Synthetic clicks do not reach a window started by a scheduled task until it is brought to the front: click its taskbar button first. Keys go to the foreground window too.
- A scheduled-task `powershell.exe -WindowStyle Hidden` still opens a Windows Terminal window in the user session. It moves the taskbar buttons, so take a screenshot before clicking.
- A standard checkpoint taken from a running VM can leave synthetic input dead until the VM is restored from it.

### Evidence files (`docs/plans/phase-6-vm-runs/`)

- **Logs:**
  - `a-*-msi-log.txt`: verbose MSI logs. `a-1-silent-msi-log.txt` contains the fake code. The Windows owner's email in the `USERNAME` lines was replaced with `<owner-email>` in run A2.
  - `a-*.txt`: task results, with exit code and times.
  - `a-*-checks.txt`: service, ACL, files, marker, Start menu, ARP, events.
  - `a-3-guard.txt`: guard-status, status, compat.
  - `a-agent-log.txt`: the agent log.
- **Snapshots:**
  - `snap-*.txt`: the install footprint.
  - `baseline-*.txt`: `scripts/vm/export-baseline.ps1`.
- **Screenshots:** `a-1-ui-*.jpg` and `a-7-uninstall-refused.jpg`.
- **Tools** (`tools/`):
  - `host-helpers.ps1`
  - `run-wait.ps1`, `snap.ps1`, `checks.ps1` (inside the VM)
  - `make-variant.ps1`, `msiidt.ps1` (MSI copies)

---

## Run A2 (Step 22): enroll, the way back, Phase 2 fixes, agent-driven upgrade — 2026-11-26

**Machine:** `rulebox-test-pro`, Windows 11 Pro 26H2 (26300), from `fresh-windows-11-pro`, 4 GB, **network on**
(Windows Update and Delivery Optimization disabled inside the VM). A production checkpoint `a2-kiosk-on`
(enrolled, kiosk on) was used for E-73 with the network disconnected, then deleted. At the end the VM was
reverted to `fresh-windows-11-pro`: Off, 4 GB, network adapter **disconnected**.

**Backend:** the dev deployment `peaceful-peccary-48`. It was running old code (no `policyKeys` in the
`enroll` answer, no Phase 5/6 functions), so the current `convex/` was pushed (owner approved), and the owner
registered a signing key, set the exit PIN and made the codes. The owner set and cleared
`phase6Settings.ruleboxRelease` and turned the kiosk off by editing rows and republishing; there is no
dashboard screen for the release yet.

**Driven by:** Claude Code from the host over PowerShell Direct (`rbtest`), with synthetic keys and clicks.

### The MSIs

| File | SHA-256 | What it is |
|---|---|---|
| `Rulebox-0.1.1-x64-unsigned.msi` | `17d89080…b897b88` (checked before copying in) | CI release, as given. The agent says `0.1.1` (run A bug 2 fixed). |
| `Rulebox-0.1.2-x64.msi` | `636df5de…c37d07` | `build.ps1 -Version 0.1.2` over the 0.1.1 files, the agent's version string patched. **Flawed:** only 2 of 9 copies of the version were patched (see lessons), so the running agent still reported 0.1.1. |
| `Rulebox-0.1.4-x64.msi` | `7f4e5c7f…e4983dce` | The same, all 9 copies patched (`tools/stamp-agent-version.ps1`). |
| `Rulebox-0.1.5-x64-forcefail.msi` | `723c0292…89c49c0` | The 0.1.4 MSI plus the forced `cmd.exe /c exit 1` before InstallFinalize (`tools/make-variant.ps1 -BaseVersion 0.1.4 -ForceFail`). |

The test MSIs were served inside the VM only, at `https://localhost:8443/` (self-signed `localhost`
certificate in the VM's Root store, `tools/serve-https.ps1`). Nothing was installed on the dev PC; WiX ran
there only to build the test MSIs.

### Results

| # | Item | Result | Evidence |
|---|---|---|---|
| 1d/1e | Silent install with `ENROLLCODE`, network on | **FAIL → fixed (backend), one logging bug fixed** | Exit 0 in 6.5 s, agent `0.1.1`. The agent used the code once: `backend_rejected`, code deleted, event 1002. Cause: the dev backend was old (its answer had no `policyKeys`). The agent logged no reason at all for this protocol error (fixed below). No verbose log was used. See `a2-05-install-011-msi-log.txt`. |
| 5 | Enroll, kiosk on | **PASS** | `rulebox-agent enroll`: enrolled, kiosk applied, admin exit on. After a restart RuleboxStaff (standard user) signs in by itself into the Staff App sign-in screen; shell healthy. See `a2-05-enrolled-checks.txt`, `a2-05-lockdown-status.txt`, `a2-05-staff-after-restart.jpg`. |
| E-70 | Hidden administrator exit (first and last) | **PASS, PASS** | Ctrl+Shift+F12 opens "Administrator exit"; the right PIN signs Staff out to the Windows sign-in screen; audit `device.adminExitSuccess`. Last pass at 0.1.4 after the upgrades. See `a2-E70-*.jpg`, `a2-E70-last.txt`. |
| E-71 | "Other user" / another account can sign in | **PASS (default settings)** | The sign-in screen lists `rbtest` and the owner's account. `hideAdminTiles` was not on, so this does not prove the hidden-tiles case (Phase 5 X-13). See `a2-E71-signin-tiles.jpg`. |
| E-72 | Shift at startup | **PILOT** | Shift held through Hyper-V's synthetic keyboard during a restart did not stop auto sign-in; a sign-out with Shift held and a control sign-out without it both stayed at the sign-in screen, so the VM cannot tell. `IgnoreShiftOverride` and `AutoLogonCount` are absent (nothing disables the Shift bypass). Needs a real keyboard. See `a2-E72-*`. |
| E-73 | `recover` on the machine (offline) | **PASS** | From `a2-kiosk-on`, network off: `recover --yes` exit 0, every journaled value restored or removed, both LSA secrets deleted, Staff hive shell and policy values removed, `recovered.flag`; after a restart the normal sign-in screen, Staff a standard user, agent "kiosk held off". See `a2-E73-08c-recover.txt`, `a2-E73-after-recover-restart.jpg`. |
| E-74 | Disable kiosk | **PASS (device side); dashboard button not exercised** | The owner turned the kiosk off by a row edit and republish (document v5). The agent: "the kiosk is off: the PC is back to normal Windows", journal 0 entries, `KioskOn=0`, Winlogon back to the owner's `rbtest` auto sign-in. See `a2-E74-disable-kiosk.txt`. |
| 7a | Uninstall with the kiosk **really** on → refused | **PASS** | Silent `/x`: 1603 in 1.3 s with "Turn kiosk mode off first…"; Rulebox stays, shell healthy. See `a2-07a-*`. |
| 7b | Kiosk off → uninstall → baseline diff | **PASS, three parts DIFFER** | Exit 0 in 2.2 s; service, `HKLM\SOFTWARE\Rulebox` and ARP gone; after a restart the owner's LSA auto sign-in works again (the secret came back exactly). **Left behind:** (1) empty `C:\Program Files\Rulebox\versions\0.1.1` and `\0.1.2` (the two agent-driven upgrades replaced files that were in use; Windows deleted the files at restart, not the folders); (2) the RuleboxStaff account and profile (kiosk off keeps them by design; uninstall does not unenroll); (3) an empty `HKLM\SOFTWARE\Policies\Microsoft\Windows\OOBE` key (the value was removed, not the key Rulebox created; no effect). Also `ProgramData\Rulebox` (Q-A2). The other diff lines are Windows' own (last user, per-user services). See `a2-07b-uninstall-diff.txt`, `a2-baseline-*.txt`. |
| 8a | Exit-hold timing (incl. the 15 s rule) | **PASS** | After the PIN `AutoAdminLogon` was 0 and went back to 1 about 17 s after the Staff session ended; a restart 68 s after the exit signed Staff in again. See `a2-08a-exit-hold-poll.txt`, `a2-08a-restart-in-hold.jpg`. |
| 8b | Kill-on-close job | **PASS** | Killing `rulebox-shell.exe` ended its Staff App at once; the agent started one new launcher 4 s later and exactly one Staff App (2 processes, as before). See `a2-08b-kill-on-close.txt`. |
| 8c | `recover` for an owner with LSA auto sign-in | **PASS** | Owner set up like Sysinternals Autologon (`tools/set-lsa-autologon.ps1`: password only as the LSA secret). `recover` restored `DefaultUserName=rbtest`, left `AutoAdminLogon=0` and said why ("the original automatic sign-in password could not be restored"); no empty-password sign-in loop. The normal path (kiosk off) restores the secret exactly (7b). See `a2-E73-08c-recover.txt`. |
| 9a | Agent-driven upgrade 0.1.1 → 0.1.2, no employee signed in, Staff App at its sign-in screen | **Install PASS; kiosk FAIL → fixed** | Release seen 05:47:26; download, hash, detached `msiexec` (survived the service stop), exit 0 in 4 s; service restarted from the new exe; `selfupdate-msi.log` written; events 1101 and MsiInstaller 1033. **Bug:** the kiosk stayed on "Rulebox is still starting" until a restart (bug 2 below). The update was later recorded `did_not_take` because of the flawed test copy, not a product fault. See `a2-09a-*`, `a2-09-after-selfupdate.jpg`. |
| 9b | Agent-driven upgrade → 0.1.4 (correct copy) | **PASS (install), kiosk bug seen again** | Event 1100 "Rulebox was updated … to 0.1.4"; `status`, `--version` and `Install\Version` 0.1.4; staged MSI kept in `ProgramData\Rulebox\selfupdate\`. The same stuck-shell bug as 9a, healed by a restart. See `a2-09b-*`. |
| 9c | A failing agent-driven upgrade (0.1.5) | **PASS** | MSI 1603 (MsiInstaller 11708), rollback restored 0.1.4, service and kiosk shell healthy; after the 30-minute grace event 1103 and `selfupdate.json` `failed: 0.1.5 did_not_take`; not retried. See `a2-09c-*`. |
| — | Side observation | **note** | After a Windows sign-out of the Staff session (not the admin exit) the PC stays at the sign-in screen until a restart: Windows does not auto sign in after a sign-out. Phase 5 row E-03 expects "after sign-out and auto sign-in the shell is back"; check it in the Phase 5 run. See `a2-E72-control.txt`. |

### Bugs found and fixed

1. **The agent logged nothing when the backend's answer did not fit** (`apps/agent/src/enroll.rs`). A protocol
   error became `backend_rejected` with "an answer this agent does not understand" and no detail anywhere. It now
   logs the detail (a field name, never a value) with a hint that the deployment may be older than the agent.
2. **After an agent-driven upgrade the kiosk stayed on "Rulebox is still starting"** (`apps/agent/src/watchdog.rs`,
   `platform/{mod,windows,sim}.rs`, `crates/rulebox-win32/src/process.rs`). Windows Installer moved the running
   launcher's file to `C:\Config.Msi\*.rbf`, so the new agent's watchdog (which looks for the launcher by its image
   path) did not see it and started a new launcher every 5 s; each one exited at once because the old launcher
   still held `Local\RuleboxShellLauncher`, and the old Staff App was refused on the pipe (`image_not_allowed`,
   correct). Fix: before it starts a launcher, the watchdog ends any `rulebox-shell.exe` in the Staff session,
   owned by the Staff account, whose image is not the installed launcher (new guarded platform method
   `end_stale_launchers`; checks repeated on the same handle before `TerminateProcess`); its Staff App ends with
   it (kill-on-close job, 8b). It works for upgrades **from** versions already in the field, because the new agent
   does it. 4 watchdog tests, 2 win32 tests, guard lists. **Not yet verified on the VM** (needs an MSI built
   with the fix).
3. **The dev backend ran old code** (not a code bug): pushed; the README already says a signing key is needed.

### Open questions for the owner

- **Q-A3 — empty `versions\<old>` folders after agent-driven upgrades.** When the Staff App runs during the
  upgrade its files are replaced in use; Windows deletes them at the next restart but leaves the folders, and the
  final uninstall leaves `C:\Program Files\Rulebox\versions\…` behind.
  - (a) Before `msiexec`, the agent ends the Staff App and launcher (allowed: no employee is signed in), so no file is in use.
  - (b) Remove the `versions` folder at uninstall with `util:RemoveFolderEx` (the Util custom action is already in the MSI).
  - (c) Leave it (empty folders only).
  - **Recommendation: (a)**, with (b) as a safety net: (a) also removes the cause of bug 2 for future upgrades.
- **Q-A2 (extended)** — an uninstall of an enrolled PC also leaves the RuleboxStaff account and profile and the
  device in the dashboard. The answer to Q-A2 should say whether uninstall unenrolls (`unenroll --remove-staff-account`).

### Lessons for the next VM run

- **Patching a version into a release exe:** a short `&str` constant is also inlined as immediates
  (`mov dword [rax],"0.1."` + `mov byte [rax+4],'1'`). Patch all copies (`tools/stamp-agent-version.ps1`
  reports the count: 2 strings + 7 inlined for this agent) or the agent reports two versions.
- An agent-driven upgrade needs an HTTPS URL; a localhost server inside the VM with a VM-only trusted
  certificate works (`tools/serve-https.ps1`), because the agent uses the Windows certificate store.
- The dev backend must run the current `convex/` before a run (check `convex function-spec` for the newest
  functions) and must have a signing key; otherwise enrollment fails as above.
- A republish needs a change that publishes (an exit-PIN change does; a device rename does not).
- Shift at sign-in cannot be tested with Hyper-V's synthetic keyboard.
- An `ENROLLCODE` passed to `msiexec` must never be searched for with a command that echoes it on failure; this
  run printed one code into the session transcript (the owner was told; it had uses left).

### Evidence files (`docs/plans/phase-6-vm-runs/`, run A2)

- `a2-*-checks.txt`, `a2-*.txt`: checks, status, logs and polls per item; `a2-agent-log-full.txt` the agent log.
- `a2-*-msi-log.txt`: MSI logs (install 0.1.1 without a verbose log; uninstall logs; the agent's `selfupdate-msi.log` for 0.1.2 and 0.1.4).
- `a2-baseline-before.txt`, `a2-baseline-after-uninstall.txt`: `export-baseline.ps1`.
- `a2-*.jpg`: screenshots; the owner's account tile is covered.
- New tools: `stamp-agent-version.ps1`, `serve-https.ps1`, `set-lsa-autologon.ps1`; `make-variant.ps1 -BaseVersion`; `checks.ps1` reads every `versions\*` folder.
