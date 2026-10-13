# Phase 2 — VM run results

Run on 2026-10-13 against the Hyper-V VM `rulebox-test-pro`: **Windows 11 Pro,
version 26H2, build 26300.9457**, generation 2, 4 GB RAM, no domain, not Entra
joined. Driven from the host over PowerShell Direct; keyboard-level checks used
the Hyper-V synthetic keyboard and mouse. The backend was the dev Convex
deployment `peaceful-peccary-48` (Step 7 schema deployed to it).

The VM was reverted to the checkpoint `before-phase2-vm-run` afterwards (no
marker, no service, no `RuleboxStaff`). The first checkpoint
`fresh-windows-11-pro` is untouched.

## Verdict

Everything in the checklist that can be driven headlessly passed, after fixing
the defects listed below. Four things are **not** tested (end of this file) and
one decision is open (restart during the exit hold).

## What was verified on real Windows

| Area | Result |
|---|---|
| Data directory, planted non-empty | `service install` refused, named the folder, wrote nothing into it, no service |
| Data directory, planted empty | install succeeded; owner became `BUILTIN\Administrators`; ACL only SYSTEM + Administrators |
| Service | `AUTO_START` (not delayed), LocalSystem, quoted path, 3 restart actions (1 s, 5 s, 30 s), description, failure flag TRUE |
| Service stop | stops in 0.6 s, exit code 0, log flushed |
| Standard user | cannot stop the service, cannot read the data directory, cannot use the admin pipe |
| `compat` | no blockers on the VM (4094 MB → Lite mode) |
| Enrollment | device registered in Convex, `connection: online`; `already_enrolled` on a second try; `token_used_up` on the fourth use of a 3-use code |
| Staff account | standard user, in Users only, comment set, password never expires, user cannot change it |
| Winlogon | `AutoAdminLogon 1`, `DefaultUserName RuleboxStaff`, no plaintext `DefaultPassword`, `Shell` and `Userinit` untouched |
| Machine values | `DisableAutomaticRestartSignOn 1`, `EnableFirstLogonAnimation 0`, `DisablePrivacyExperience 1` |
| Staff hive | `Policies\System\Shell` = launcher, `DisableLockWorkstation 1` |
| Automatic sign-in | Staff signs in by itself ~30 s after a restart; launcher + Staff App run; **no Explorer** |
| Shell mechanism | **`policyShell` works on Windows 11 Pro 26300**; `winlogonShell` was not needed |
| Watchdog | Staff App crash → relaunched in 565 ms; hang → ended after 30 s without a heartbeat; launcher killed → relaunched by the agent in 7.1 s; agent killed → back in 1.1 s with the shell untouched |
| Crash loop | 5 quick crashes → "Rulebox can't start" screen; 30 s auto-retry makes one launch; restoring `current.json` recovers |
| IPC security | as the real Staff user: owner `S-1-5-18`, server session `0`, **`create-instance: DENIED (error 5)`**, generic-write open `ACCEPTED`; a copy of the client outside `versions\` is refused (`image_not_allowed`) |
| Backend control | `setKiosk false` → `ShuttingDown { KioskDisabled }`, sign-out, original owner values restored, no auto sign-in on restart; `setKiosk true` → back after restart |
| Offline | boot with no network: auto sign-in and shell work, `offline`, cached policy and exit enabled; reconnect → `online` in ~20 s |
| Hidden exit | `wrongPin` with 4 then 3 attempts left; failures and audit queue survive a restart; fifth wrong PIN → `lockedOut` 60 000 ms; right PIN during the lock refused; right PIN after → `signingOut`, `ShuttingDown { AdminExit }`, sign-in screen, no auto sign-in; hold ends after 5 minutes; re-armed at agent restart; backend `enabled:false` → `disabled` |
| Fallback-screen exit | `Ctrl+Shift+F12` opens the PIN panel; wrong PIN shows "That PIN is not right. 4 tries left."; right PIN signs out (real keystrokes) |
| Employee session (fixture) | `maya demo` → `ok`, `filesRoot` under the Staff profile, 4 apps, `verifyPassword ok`, sign-out; the agent did not create the folder |
| Recover | offline `recover --yes` restored every journaled value, deleted the LSA secrets, cleared the Staff hive values, kept the account, wrote `recovered.flag`; restart shows the normal sign-in screen; the restarted agent shows "kiosk held off" and re-applies nothing; refused from a non-elevated prompt |
| Uninstall | refused while the kiosk is applied; `unenroll --remove-staff-account` removed account and profile and restored Winlogon; `service uninstall` removed the service |
| Rust VM tests | `account_lifecycle`, `administrator_accounts_are_refused`, `lsa_secret_round_trip` pass in the VM; `dpapi_round_trip_as_system` passes as SYSTEM |
| Secrets | no PIN, wrong PIN, demo password, owner password, enrollment code or PIN hash in any log or state file |
| Shift bypass | restart holding Shift: Staff is **not** signed in; the sign-in screen stays |
| Safe Mode (minimal) | auto sign-in fires and the custom shell runs (launcher + Staff App); the agent service does not run |
| PIN check time | well under the 3 s limit in the debug build (each check finished inside the 3 s pause of the test harness; not timed more finely) |
| LSA-autologon owner | enroll over an owner with LSA auto sign-in, then `unenroll`: the owner's secret and Winlogon values come back exactly |

## Defects the VM run found, and what was done

| # | Finding | Status |
|---|---|---|
| 1 | `CreateProfile` fails with error 1783 when given a 520-character buffer; 260 works | **Fixed** (`accounts.rs`), re-verified on the VM |
| 2 | `vm-deploy.ps1` resolved its folder too early on Windows PowerShell 5.1, and failed mid-copy on a binary in use | **Fixed**, re-verified |
| 3 | The debug binaries need `vcruntime140.dll`, which a clean Windows does not have: the agent exits with `0xC0000135` | **Worked around** in the deploy script (app-local copy). **Open for the release build**, see below |
| 4 | `RULEBOX_LOG=debug` made the Convex client crate write call arguments (device secret, enrollment token) and documents (exit PIN hash) into the log | **Fixed** (other crates capped at `warn`), unit-tested |
| 5 | A Microsoft-account administrator was not counted as "another administrator", so `compat` blocked a normal PC | **Fixed** (local account enumeration), re-verified |
| 6 | `recover` restored `AutoAdminLogon 1` for an owner whose auto sign-in password was the LSA secret, leaving Windows trying an empty password | **Fixed** (set to `0` and explain), unit-tested; not re-run on the VM |
| 7 | A standard user running `status` was told "the service is not running" | **Fixed** (access-denied message), unit-tested |
| 8 | When the launcher is killed, its Staff App survives and the new launcher starts a second one | **Fixed** (kill-on-close job object), unit-tested on the host; **not re-verified on the VM** (the marker was created once and the VM is reverted) |
| 9 | After a first `unenroll` that followed a `recover` and re-enable, the Staff password was still in the LSA `DefaultPassword` | **Not reproduced** in a clean run of the same sequence; the normal path deletes it. Watch for it |

## Open decisions

1. **Restart within the exit hold.** After the correct exit PIN the agent holds
   `AutoAdminLogon = 0` for up to 5 minutes. If the PC is restarted inside that
   window, Windows decides at boot (value `0`) to show the sign-in screen; the
   agent re-arms the value only after it has started, which is too late for that
   boot, and the PC sits at the sign-in screen until the next restart. Observed
   for 10 minutes. Windows decides about automatic sign-in once per sign-in
   screen, so re-arming as soon as the Staff session has ended (about 10 s)
   would avoid it. This changes a design rule you approved (README, 1.1 rows),
   so it was not changed.
2. **Visual C++ runtime in release builds.** Either link the C runtime
   statically for `rulebox-agent` and `rulebox-shell` (the agent runs as SYSTEM
   before anything else; fewer dependencies is better), or have the installer
   bundle the redistributable. A static link means `-C target-feature=+crt-static`
   for those two crates (a `.cargo` setting affects the whole workspace, so
   the cleanest route is a build-script crate or a per-target override).
3. **PIN hash portability.** The PIN hash sits in plaintext JSON in
   `desired-state.json` and travels in the desired-state document. It is
   Argon2id (m=19 MiB), but a 4 to 6 digit PIN falls to offline guessing in
   minutes for anyone who can read the file. Options: require a longer PIN, or
   bind the check to a device-held key. The state directory is SYSTEM and
   Administrators only.

## Smaller findings left as they are

- `*.corrupt-*` copies of state files are not removed on unenroll.
- A password typed into the employee username field is persisted in
  `lockouts.json` and can appear in a warning log after five failures.
- `rulebox-agent hash-pin` echoes the PIN and the enrollment code is a command
  line argument (visible to local users while the command runs).
- `AdminEnrollParams` and the `clap` command derive plain `Debug` (no print site
  today).
- No `zeroize`: passwords and PINs live in ordinary `String`s while handled.
- The orphan fix and the VC++ runtime need a second VM run to confirm.

## Not tested

- **A Home edition VM** (none available).
- **Administrator signs in at the console, then signs out**: whether the agent
  re-arms on an admin sign-in and whether Windows then signs Staff in by itself.
  Driving the sign-in screen with the synthetic mouse and keyboard did not work
  reliably (two attempts), so this needs doing by hand.
- **Win+L in the Staff session** (only `DisableLockWorkstation = 1` was
  confirmed in the hive) and the **Disconnected Staff session** (Switch user).
- **Shift while signing out of Staff** (only Shift at startup was tested).
