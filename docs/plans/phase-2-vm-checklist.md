# Phase 2 — VM checklist

Run this on the test VM (`rulebox-test-pro`, Windows 11 Pro, Hyper-V). It is
Section 10.2 of `phase-2-agent-core.md` plus the VM-only checks collected while
building Steps 10 to 13. **You** run it; nothing here runs on the dev laptop.

Record the Windows edition, version and build you tested: ______

## 0. Before you start

- [ ] On the dev machine, build (debug only, about 1 to 2 GB of `target\`):

  ```powershell
  cargo build -p rulebox-agent -p rulebox-shell
  cargo build -p rulebox-ipc --example fake_staff --features client
  ```

- [ ] Copy these four files into one folder on the VM (any folder, for
      example `C:\rbx-drop`):
  - `target\debug\rulebox-agent.exe`
  - `target\debug\rulebox-shell.exe`
  - `target\debug\examples\fake_staff.exe`
  - `scripts\vm-deploy.ps1`
- [ ] **Snapshot the VM** (the clean checkpoint `fresh-windows-11-pro` exists;
      take another one after Windows setup if you changed anything).
- [ ] A second local administrator (`rbtest`) and a second **standard** user
      exist, and you know their passwords.
- [ ] A Convex deployment with the Step 7 functions is deployed, and you can
      run `npx convex run dev:seedOrg` and `dev:createEnrollmentCode` against
      it (see "Open decisions" in the Phase 2 report). Without it, skip
      "Enrollment" and everything that needs the backend.
- [ ] **Marker created by hand, inside the VM only** (elevated PowerShell):

  ```powershell
  New-Item -Path 'HKLM:\SOFTWARE\Rulebox\TestMachine' -Force | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Rulebox\TestMachine' -Name ComputerName -Value $env:COMPUTERNAME
  ```

## 1. Data directory and install

- [ ] **Planted, not empty.** Before the first deploy, signed in as the
      standard user: `mkdir C:\ProgramData\Rulebox` and
      `echo x > C:\ProgramData\Rulebox\x.txt`. Run `vm-deploy.ps1` as the
      administrator: `service install` **refuses** and names the data
      directory; nothing else is written into that folder; no service exists.
- [ ] **Planted, empty.** Delete `x.txt` only, run `vm-deploy.ps1` again: it
      succeeds, and `(Get-Acl C:\ProgramData\Rulebox).Owner` is SYSTEM or
      Administrators, not the standard user.
- [ ] `sc.exe qc RuleboxAgent`: `AUTO_START` (not delayed), `LocalSystem`,
      quoted path ending in `service run`, display name "Rulebox Agent".
- [ ] `sc.exe qfailure RuleboxAgent`: reset 86400 s, RESTART at 1000, 5000 and
      30000 ms; `sc.exe qfailureflag RuleboxAgent` is TRUE.
- [ ] `icacls "$env:ProgramData\Rulebox"` shows only SYSTEM and Administrators.
- [ ] `rulebox-agent status` (elevated) prints `notEnrolled`.
- [ ] A standard user cannot stop the service (`sc.exe stop RuleboxAgent`
      from a non-elevated prompt fails).
- [ ] Running `service install` from outside `%ProgramFiles%\Rulebox` is
      refused with a message naming that folder.
- [ ] Running `vm-deploy.ps1` a second time says the service was updated.
- [ ] `sc.exe stop RuleboxAgent`: STOP_PENDING then STOPPED within about
      10 s, exit code 0, and the log ends with "service stopped". Start it again.

## 2. Enrollment

- [ ] `rulebox-agent compat` shows no blockers on the VM.
- [ ] `rulebox-agent enroll <code>` succeeds; the device appears in Convex;
      `net user RuleboxStaff` shows a standard user in Users only.
- [ ] `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"`:
      `AutoAdminLogon 1`, `DefaultUserName RuleboxStaff`, **no**
      `DefaultPassword` value, and `Shell` still `explorer.exe`.
- [ ] `rulebox-agent status` shows the password and the exit hash nowhere.
- [ ] Enrolling again says `already_enrolled`. The same code on a second VM
      says `token_used_up`.

## 3. Sign-in and shell

- [ ] Restart: the PC signs in to `RuleboxStaff` by itself and shows the
      `fake_staff` console, not Explorer. Note any first-run or privacy screen:
      ______
- [ ] `fake_staff` shows `Linked` and a snapshot with `enrolled`,
      `kiosk.phase applied`, `shell.health healthy`.
- [ ] Shell mechanism that worked: ______ (default `policyShell`). If Explorer
      appeared, set `"shellMechanism": "winlogonShell"` in
      `C:\ProgramData\Rulebox\state\agent-config.json`, restart the service,
      restart the PC, and record the result.
- [ ] Staff's launcher log exists: `%LOCALAPPDATA%\Rulebox\logs\shell-launcher.log`
      in the Staff profile.

## 4. Watchdog

- [ ] `c` in `fake_staff`: back in under 2 s (the launcher relaunches it; the
      agent does nothing).
- [ ] `c` five times quickly: the "Rulebox can't start" screen; **Try again**
      brings `fake_staff` back. The agent neither kills nor starts anything.
- [ ] `h`: about 30 to 35 s later the agent ends it and it comes back. With
      `"killHungShell": false` the health only goes `unhealthy`.
- [ ] From the admin session, kill `rulebox-shell.exe` in the Staff session:
      relaunched by the agent in about 3 to 8 s, then the launcher starts the
      Staff App.
- [ ] `taskkill /f /im rulebox-agent.exe` (elevated): the shell stays up; the
      service is back within a few seconds (restarts after 1 s, 5 s, then 30 s);
      the restarted agent starts nothing extra.
- [ ] Rename `rulebox-shell.exe` and kill it: the agent logs failed launches, a
      retry about every 30 s, health `failed`; restoring the file recovers in
      30 s.
- [ ] Rename `current.json`: after the next shell exit the fallback screen
      appears; restore it and **Try again** works.
- [ ] Staff session `Disconnected` (Ctrl+Alt+Del, Switch user): no relaunch;
      the watchdog resumes on reconnect.

## 5. IPC security

- [ ] From the second standard user, `fake_staff.exe` never reaches `Linked`.
- [ ] From the Staff session, a copy of `fake_staff.exe` outside
      `Program Files\Rulebox\versions\` gets `unauthorized`.
- [ ] From an elevated prompt `rulebox-agent status` works; from a
      non-elevated prompt it fails with an access error.
- [ ] **Pipe probe as the real Staff user, not elevated** (Task Manager →
      Run new task → `C:\Program Files\Rulebox\versions\0.0.0-dev\fake_staff.exe`,
      press `p`). Write down the lines:
  - owner (expect `S-1-5-18`): ______
  - server session (expect `0`): ______
  - create-instance (expect `DENIED (error 5)`): ______
  - generic-write open (either is fine): ______

  **If create-instance is `ALLOWED`, or the server session is not 0, or
  `fake_staff` says the server is not trusted: stop and tell me.** Do not
  carry on; plan Section 10.2 says what changes.
- [ ] As the Staff user (`cmd` from Run new task), `type
      "%ProgramData%\Rulebox\state\desired-state.json"` and `dir
      "%ProgramData%\Rulebox"` both fail with "Access is denied".

## 6. Offline and desired state (needs Convex)

- [ ] Network off, restart: auto sign-in and the shell still work; the
      snapshot says `offline`.
- [ ] Network on: `online` within a minute; `deviceStatus.lastSeenAt` updates.
- [ ] `npx convex run dev:setKiosk '{"deviceId":"…","enabled":false}'`: within
      seconds `fake_staff` prints `ShuttingDown kioskDisabled`; 10 s later the
      Windows sign-in screen; Winlogon values are back to their originals; a
      restart does **not** sign in automatically.
- [ ] `setKiosk … true`: after a restart the kiosk is back.

## 7. Hidden admin exit

- [ ] On the dev machine: `rulebox-agent hash-pin` with a 6-digit PIN, then
      `npx convex run dev:setAdminExit '{"deviceId":"…","pinHash":"<line>"}'`.
      On the VM `status` shows the exit on with `Ctrl+Shift+F12`, no hash.
- [ ] `x` in `fake_staff`, wrong PIN twice: `wrongPin` with `attemptsLeft` 4
      then 3. Restart the PC: `status` still shows 2 failures.
- [ ] `x` with the right PIN: `signingOut`, then the Windows sign-in screen in
      about 2 s, and Staff is **not** signed back in. PIN check took: ______
      (agent log; must be far below 10 s, and never above 3 s).
- [ ] Sign in as the administrator. Within a minute `reg query
      "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v
      AutoAdminLogon` shows `1`. Sign out and **write down** whether Windows
      signs Staff in by itself or stays at the sign-in screen: ______.
      Restart: the kiosk is back.
- [ ] Use the exit again, do **not** sign in, wait 6 minutes, restart: the
      kiosk is back.
- [ ] Five wrong PINs: the fifth answers `lockedOut` near 60 s; the right PIN
      during the lock is refused; after the lock it works.
- [ ] Network off: the right PIN still works.
- [ ] `dev:setAdminExit` with `"enabled": false`: `x` answers `disabled`. Set
      it back.
- [ ] `c` five times (fallback screen), then Ctrl+Shift+F12: the PIN panel
      appears; a wrong PIN shows its text; the right PIN leads to the Windows
      sign-in screen.
- [ ] `status` shows a non-zero "audit queued" count (nothing is delivered
      before Phase 4).
- [ ] Optional, with `vm-deploy.ps1 -FixtureDirectory`: `i` → `maya demo` is
      `ok` with a `filesRoot` under the Staff profile's `RuleboxFiles`; that
      folder does **not** exist afterwards; `a` lists four apps. Without the
      switch `i` is not offered.

## 8. Admin way back and recovery

- [ ] Hold Shift during startup (and separately while signing out of Staff):
      the sign-in screen appears instead of automatic sign-in.
- [ ] Win+L in the Staff session does nothing.
- [ ] Stop and disable the service, then `rulebox-agent recover --yes` (from a
      non-elevated prompt it must say "run from an elevated prompt"):
  - [ ] it prints what it restored; Winlogon journaled values are back; the
        LSA `DefaultPassword` is gone; the Staff hive has no shell and no
        `DisableLockWorkstation`; the `RuleboxStaff` account is kept;
  - [ ] `state\recovered.flag` exists; a restart shows the normal sign-in
        screen; signing in as `RuleboxStaff` is impossible;
  - [ ] re-enable and start the service: `status` shows "recovered: kiosk
        held off", and nothing is re-applied; deleting the flag (or
        unenroll then enroll) lets it re-enable.
- [ ] `recover` with a junction at `C:\ProgramData\Rulebox` (or an unreadable
      state file): a note says it was not used, no flag is written, and
      `AutoAdminLogon` becomes `0` only if `DefaultUserName` is `RuleboxStaff`.
- [ ] `service uninstall` while the kiosk is applied is refused with the
      unenroll hint; `--force` runs `recover` first, then removes the service.
- [ ] Safe Mode boot: record what happens (does auto sign-in fire? does the
      custom shell run?): ______
- [ ] **Owner already used LSA auto sign-in** (set up Sysinternals Autologon
      before enrollment), then enroll and `recover`: write down what
      `AutoAdminLogon` is afterwards and what the sign-in screen does.
      Expected gap: it may stay `1` with no password.

## 9. The `#[ignore]`d Rust tests (only if a Rust toolchain is on the VM)

Elevated, with the marker present:

```powershell
cargo test -p rulebox-win32 --test vm_lifecycle -- --ignored --test-threads=1
```

- [ ] `account_lifecycle`, `administrator_accounts_are_refused`,
      `lsa_secret_round_trip` pass.
- [ ] `dpapi_round_trip_as_system` passes when run as SYSTEM (for example with
      `psexec -s`).
- [ ] After `account_lifecycle`, `reg query HKU\RuleboxStaffTmp` finds nothing.

If there is no toolchain, sections 2 to 8 cover the same functions end to end.

## 10. Cleanup

- [ ] `rulebox-agent unenroll --remove-staff-account`: account and profile
      gone, Winlogon values original, device marked revoked in Convex.
- [ ] `rulebox-agent service uninstall`: service gone.
- [ ] Revert to the snapshot.

## Home VM (if you have one)

The whole list, with attention to section 3 (try both shell mechanisms) and
the first-run screens. Record "not tested, no Home VM" otherwise.

## Results to send back

| Item | Result |
|---|---|
| Edition / build | |
| Shell mechanism that worked | |
| Pipe probe (4 lines) | |
| PIN check time | |
| After an admin signs out following the exit: Staff signed in by itself? | |
| Safe Mode behaviour | |
| LSA-autologon owner case | |
| Anything that failed or surprised you | |
