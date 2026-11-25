# Rulebox installer (WiX v7 MSI)

One hand-authored, per-machine, x64 MSI: the agent service, the launcher and the Staff App.
Design: `docs/plans/phase-6-installer-pilot.md` Section 4.10. Not Tauri's MSI target (it is off in
`apps/staff-app/src-tauri/tauri.conf.json`).

| File | What it holds |
|---|---|
| `Package.wxs` | Product, upgrade code, major upgrade, install folder and its ACL, install marker, pending enrollment code, WebView2 bootstrapper, notices, licence |
| `Service.wxs` | `rulebox-agent.exe`, the `RuleboxAgent` service and its restart settings, the "Rulebox Setup" shortcut |
| `StaffApp.wxs` | `rulebox-shell.exe`, `current.json`, `versions\<version>\rulebox-staff.exe` |
| `Checks.wxs` | Launch conditions (administrator, x64, build 19045) and the uninstall guard (no free-space condition: see the file) |
| `UI.wxs` | WixUI_Minimal, the logo bitmaps (`assets/brand/installer/`, from `pnpm gen:brand`) and the finish-page "Start Rulebox Setup" checkbox (the only custom action) |
| `License.rtf` | Text shown on the licence page |
| `build.ps1` | The build script |
| `webview2-bootstrapper.sha256` | Pinned SHA-256 of Microsoft's WebView2 bootstrapper |
| `tests/package.test.ts` | Static checks of the sources (`pnpm test:installer`) |

## Build

The build runs in CI (Step 9) or on the VM. **Do not install WiX on the dev PC for this**; the static
test needs no WiX.

1. Build the workspace in release with the production guard:
   `cargo build --release --features production` (agent, launcher, Staff App).
2. Have WiX v7 on the PATH (`wix --version`). The script never installs it.
3. First time only, pin the WebView2 bootstrapper (needs internet), then review and commit the file:

   ```powershell
   pwsh apps\installer\build.ps1 -BinDir target\release -Version 0.1.0 -PinWebView2
   ```
4. Build:

   ```powershell
   pwsh apps\installer\build.ps1 -BinDir target\release -Version 0.1.0 -AcceptEula
   ```

   The MSI is `target\installer\Rulebox-0.1.0-x64.msi`. `-OutDir` changes the folder.
   Only the first three version fields count for upgrades.

Never run the MSI on the dev PC. Silent install on a test PC or VM:
`msiexec /i Rulebox-0.1.0-x64.msi /qn ENROLLCODE=<code>` (the code is a hidden property and is written to
`HKLM\SOFTWARE\Rulebox\Install\Pending`, readable by SYSTEM and Administrators only). **Do not add `/l*v`:** a verbose
log prints the code in its `RegAddValue` line (Step 22 run A); Windows Installer cannot hide a registry value.
The build also checks that `rulebox-agent.exe --version` is `-Version` (build the agent with `RULEBOX_VERSION`).

## Fixed values

- **Upgrade code** `76E0E816-6BEE-40CB-8BA0-6B32C8A1EB56` never changes (a new one makes the next MSI a second
  product). The static test pins it.
- The service name, its arguments, the install marker and the folder ACL equal the Rust sources
  (`apps/agent/src/service.rs`, `crates/rulebox-win32/src/{guard,security}.rs`); the test compares them.

## WiX v7 EULA (OSMF) record

WiX v7 will not run until its Open Source Maintenance Fee EULA is accepted. CI accepts it in a visible,
commented step (`-acceptEula wix7`, Step 9) and the acceptance is recorded here.

| Accepted by | Date | Version of WiX | Where (CI run or machine) |
|---|---|---|---|
| | | | |

**Fee:** projects that use WiX and have revenue of more than US$10,000 a year must sponsor the
`wixtoolset` GitHub organization (the Open Source Maintenance Fee). Rulebox is MIT and free to use; if the
hosted offer or other revenue passes that line, the owner must start the sponsorship. Re-read the current
terms when updating WiX.

## Checked on the VM (Step 22 run A, 2026-11-26)

The CI-built 0.1.0 MSI on Windows 11 Pro 26300: folder ACL, service and failure actions, install marker,
Pending key ACL, Start menu shortcut, finish page, major upgrade, failed-upgrade rollback, downgrade refusal,
uninstall guard and clean uninstall all as designed. Found and fixed: the free-space condition refused every
install, the agent reported 0.0.0, the event source was not registered. Record: `docs/plans/phase-6-vm-results.md`.
