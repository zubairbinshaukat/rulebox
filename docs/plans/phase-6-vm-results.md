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
  - `a-*-msi-log.txt`: verbose MSI logs. `a-1-silent-msi-log.txt` contains the fake code.
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
