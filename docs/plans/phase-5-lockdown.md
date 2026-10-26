# Phase 5 — Lockdown hardening and Section 24 features

> **For the implementing agent:** follow this plan step by step. Each step
> has a **Done when** check — run it and see it pass before moving on.
> Read `CLAUDE.md` first, then the reading list in Section 3. Do not build
> anything listed under Non-goals. One step = one commit
> (`Phase 5 step N: <what>`), made only when the user says so.
>
> This is a plan for **hardening and testing** a kiosk. It names each
> route out of the Staff session only by a short label, the control that
> closes it and the observation that proves it is closed. It never
> describes how to perform an escape; keep it that way when you edit it.
>
> **Eight rules override everything else in this file:**
>
> 1. **Nothing system-altering runs on the dev machine.** Writing policy
>    values into any hive, deploying an App Control or AppLocker policy,
>    starting an ETW session, adding Wi-Fi profiles or printers, changing a
>    service, the boot configuration or the account policy: all of that runs
>    only on the Hyper-V VM, and only the **user** runs it. Every new
>    mutating `Platform` method calls `guard::require_test_machine()` first
>    (in `WindowsPlatform`, and again inside the `rulebox-win32` function).
>    **Never create the test-machine marker, on any machine.** Converting a
>    policy XML into a binary only writes a file under `target\` and is
>    allowed on the dev machine (Step 6).
> 2. **The way back always works.** No lockdown item may block, on any
>    edition: `rulebox-agent.exe`, `rulebox-shell.exe`, the Staff App under
>    `versions\`, the hidden admin exit (key combination + PIN), Shift at
>    startup, "Disable kiosk" from the dashboard, and `rulebox-agent recover`
>    run by an administrator. Each is an invariant with a test (Section 4.6).
>    A document that would break one is refused by the agent before anything
>    is written.
> 3. **Journal first, undo on Disable.** The Phase 2 rule (original value
>    saved to disk before it is overwritten) applies to every machine value,
>    Staff-hive value, policy file, service setting, boot setting, printer and
>    Wi-Fi profile Phase 5 touches. "Disable kiosk", `unenroll` and `recover`
>    restore all of it (Phase 2 Q5: Staff gets normal Windows back).
> 4. **Audit before enforce.** App Control, AppLocker and the process
>    watchdog each have `off | audit | enforce`. A new organization starts in
>    `audit`. An administrator switches a layer to `enforce` after reviewing
>    the findings (Section 4.10), through rollout rings (Section 4.14).
> 5. **Secrets have one writer and one reader** (Phase 4 rule 2). New secrets
>    (Wi-Fi passphrases, organization sealing keys, device sealing keys, the
>    deployment master key) are listed in Section 4.18. Nothing secret goes
>    into `rulebox_policy::DesiredState`, the IPC snapshot, a log line or an
>    audit summary.
> 6. **Security events only, no usage tracking.** Phase 5 reports *that* a
>    program was stopped (file name, folder class, signer, layer, count).
>    Never command lines, window titles, document names, URLs, key strokes or
>    screenshots (Decisions 7 and 8).
> 7. **Database I/O is the scarce resource** (one shared Convex deployment,
>    free plan). Every device report in this phase is **change-driven and
>    batched**, never periodic; each one has a writes-per-device-per-day
>    estimate in Section 4.19. No new subscription for the agent (it keeps its
>    one), no counter row written per event.
> 8. **Nothing here is "unescapable".** Every route in Section 6 names its
>    residual risk. Physical access with boot media, a BIOS without a
>    password, or a disk without BitLocker defeats software controls; the
>    plan documents this and shows it on the dashboard instead of pretending.

Research date for every version and API fact in this file:
**2026-10-27**. Items marked **(unverified)** could not be confirmed from a
primary source; each says how it gets confirmed (almost always the VM runs
of Steps 21 and 22).

---

## Updates since this plan was written

None yet. When the user answers Section 20, record the answers here and in
`docs/plans/README.md`, and change the affected steps before starting.

---

## 1. Goal

At the end of Phase 5:

1. **The Staff account is locked down in layers** (Section 4.1), each
   journalled and fully undone by Disable kiosk:
   - **L1 Staff policies** — per-user policy values in the Staff hive
     (Section 4.7).
   - **L2 Machine policies** — the few values that exist only machine-wide
     (hide Switch user, hide the sign-in-screen power button, deny elevation
     requests from standard users, hide admin tiles, account lockout, no
     password on wake, printer-driver restrictions, file printers removed).
   - **L3 AppLocker rules for the Staff SID only** — the main allow-list.
     Microsoft documents that AppLocker policies are supported on all
     editions of Windows 10 2004+ and Windows 11 since KB 5024351; Home is
     **(unverified on a real Home VM)**. Administrators are not affected.
   - **L4 App Control for Business (device-wide)** — by default Microsoft's
     recommended block rules as their own base policy; optionally (level
     `allowlist`) a second base policy that allows Windows, `Program Files`
     and Rulebox only. The only layer the kernel enforces and the only one
     still active in Safe Mode.
   - **L5 Process watchdog** in the agent — every process that starts in the
     Staff session is checked against the same allow-list; in `enforce` a
     process outside it is ended and reported. The catch-all on every edition.
   - **L6 Staff App** — Windows-key combinations swallowed by the existing
     hook (Q7), device lock screen, broadcasts.
   - **L7 Boot and recovery** — the agent also runs in Safe Mode and keeps
     the Staff session out of it; automatic failover to WinRE off; sign-in
     screen power button hidden; Secure Boot, BitLocker and TPM state shown
     on the dashboard.
2. **Audit mode first, reviewed on the dashboard:** a "Would be blocked"
   list grouped by program; the administrator allows a program for an app
   (an exception rule) or ignores it, then switches the layer to `enforce`.
3. **Web app permissions** (PRD 24.1) edited per app; blocked requests
   counted per app.
4. **Wi-Fi profiles** (WPA2/WPA3-Personal, open) pushed per group, installed
   machine-wide; passphrases sealed per device and encrypted at rest with a
   per-organization key; optional "managed networks only".
5. **Printers** (IPP, TCP/IP raw, LPR, per-machine share connections) with a
   driver from the approved list.
6. **Rollout rings** (Pilot, Early, Everyone) with promotion, optional
   automatic promotion after a bake time, **automatic halt**, one-click and
   automatic **rollback** to an earlier configuration version, and a
   **device-local last-known-good** for lockdown changes that break the shell.
7. **Lost-device lock and broadcast messages** (PRD 24.4).
8. **Tamper protection:** service security descriptor, restricted service
   privileges, Safe Mode registration, ACL self-checks, clock rules; drift is
   re-asserted and reported.
9. **Per-user tuning and the kiosk performance profile** (PRD 22.2, 22.3).
10. **The escape checklist** of Section 6 passes on the Windows 11 Pro VM,
    every residual risk written down; the Home result is recorded if a Home
    VM is available.

On the **dev machine** everything is built and tested against `SimPlatform`,
convex-test, Vitest and the dashboard's demo fixtures. Real Windows changes
happen only in the two VM runs the user performs (Steps 21 and 22).

## 2. Non-goals (do NOT build in Phase 5)

| Not in Phase 5 | Belongs to |
|---|---|
| Any kernel driver (process callbacks, filters, keyboard filter). ETW and user-mode APIs only | never in v1 |
| **Signed** App Control policies. Rulebox's App Control policies are unsigned; the administrator is trusted (PRD 9.5) and a signed-policy mistake can stop a PC from booting | v2, if ever |
| Protected Process Light for the agent (needs an ELAM driver and Microsoft signing) | never |
| Turning on BitLocker, BIOS/UEFI passwords, Secure Boot, boot order. The agent **reports** their state | documentation only |
| Keyboard Filter, Shell Launcher v2, Assigned Access (Enterprise/Education only, or conflicting with the Phase 2 shell) | not planned |
| 802.1X / EAP Wi-Fi and certificate distribution (Q3) | v1.x |
| Printer drivers fetched by Point and Print; unsigned driver packages | never |
| Windows Update policy controls (active hours, deferrals) | v1.x (PRD 17) |
| Multi-monitor shell, tray host | v1.x |
| Shift hours (PRD 24.5) | v2 |
| Remote screen view, usage tracking, keystroke or URL logging | not in v1 |
| Agent self-update (PRD 23.9). Phase 5 only keeps `Program Files\Rulebox` writable by SYSTEM and allowed by every layer | v1.x |
| MSI installer, code signing, installer compatibility UI (PRD 14) | Phase 6 |
| Hidden Windows account per employee (Decision 13 B) | v2 |
| Making file-dialog *browsing* private between employees (PRD 5.3 known limitation). Phase 5 stops dialogs from *starting programs*; it does not separate the shared Staff account's files | v2 (Decision 13) |
| The I/O budget pass for the whole backend (live subscriptions, heartbeats, rate limiter). Phase 5 only keeps its own writes minimal and estimates them | post-Phase-5 planning pass |

---

## 3. Prerequisites

### 3.1 Reading list (in this order)

- `CLAUDE.md` (all).
- This file, Sections 1 to 6, before Step 1.
- `docs/prd.md` — 3.2, 4.7, 5.3, 7.3, 9.5, 10, 11.1, 12 (all), 13.1–13.6,
  14, 21 (locked), 22.2–22.4, 23.7, 24.1–24.4, 25.
- `docs/plans/phase-2-agent-core.md` — 5.6 (kiosk enable/disable, journal),
  5.7 (watchdog), 5.10 (admin exit, exit hold), 12 ("Phase 5 owns"), 13, 14
  (Q5, Q6, Q11).
- `docs/plans/phase-2-vm-results.md` (all; "Safe Mode (minimal)", "Not tested").
- `docs/plans/phase-3-staff-shell.md` — 9 ("Escape routes that remain after
  Phase 3"), Step 15 (web app hooks), Step 16 (Windows-key hook), 16, 18.
- `docs/plans/phase-3-step17-results.md`.
- `docs/plans/phase-4-dashboard-state.md` — 4.2–4.5, 4.7, 4.8, 4.11, 4.13,
  5, 11, 17.
- `docs/plans/tenant-admin-panel-recommendation.md`, last section
  ("pooled first"): one shared deployment, per-organization keys under a
  deployment master key, I/O is scarce.
- Code: `apps/agent/src/{kiosk.rs,state.rs,recover.rs,watchdog.rs,agent_policy.rs,service.rs,compat.rs,paths.rs}`,
  `apps/agent/src/platform/{mod.rs,sim.rs,windows.rs}`,
  `crates/rulebox-win32/src/{guard.rs,registry.rs,shellreg.rs,autologon.rs,process.rs,security.rs,osinfo.rs}`,
  `crates/rulebox-policy/src/lib.rs` (+ `catalog.rs` after Phase 4),
  `crates/rulebox-ipc/src/{lib.rs,types.rs,requests.rs}`,
  `crates/rulebox-desktop/src/{winkey.rs,launch.rs}`,
  `apps/staff-app/src-tauri/src/webapp/{hooks.rs,permissions.rs}`,
  `apps/dashboard/src/data/{README.md,api.ts,types.ts}`, `convex/schema.ts`,
  `convex/lib/*.ts`.

### 3.2 What exists today (verified against the code on 2026-10-27)

**Agent** (`apps/agent`, Phase 2, VM-verified on Windows 11 Pro 26300):

- `kiosk.rs` — the reconciler (`Kiosk::enable`, `disable`, `restore_machine`;
  idempotent; journal saved before each overwrite). Machine values today
  (`wanted_machine_values`): Winlogon `AutoAdminLogon`, `DefaultUserName`,
  `DefaultDomainName`, delete `DefaultPassword` and `AutoLogonCount`;
  `Policies\System\DisableAutomaticRestartSignOn=1`,
  `EnableFirstLogonAnimation=0`; `Policies\Microsoft\Windows\OOBE\DisablePrivacyExperience=1`.
  Staff hive: the shell value and `DisableLockWorkstation=1`.
  `REASSERT_INTERVAL` = 10 minutes.
- `state.rs` — `AgentState { schema: 1, journal: Vec<JournalEntry>, kiosk:
  KioskRecord { staff_hive, lsa_taken_over, .. }, last_applied_version,
  last_wall_clock_ms, .. }`; `OriginalValue { Absent, Dword, String, InSecrets }`;
  `write_atomic`, `read_json`.
- `platform/mod.rs` — the `Platform` trait. Mutating today:
  `create_staff_user`, `set_user_password`, `test_logon`, `ensure_profile`,
  `delete_staff_user`, `write_machine_value`, `lsa_secret_get/set`,
  `set_staff_shell`, `set_staff_user_policy` (DWORD under the Staff hive's
  `Policies\System` only), `logoff_session`, `launch_in_session`,
  `terminate_process(pid, expected_image, expected_sid)`, `secrets_save`.
- `watchdog.rs` — the **launcher** watchdog (keeps `rulebox-shell.exe`
  running, ends a hung Staff App). It is not a process allow-list; Phase 5
  adds `procwatch` beside it and leaves it alone.
- `service.rs` — `RuleboxAgent`, automatic start, LocalSystem, recovery
  1 s / 5 s / 30 s. No custom service security descriptor, no
  required-privileges list, no Safe Mode registration.
- `recover.rs` — offline restore of every journalled value.
- `compat.rs` — blockers `os_too_old` (< 19045), `s_mode`, `managed_device`,
  `no_other_admin`, `legal_notice`, `shell_binary_missing`.
- Data directory `%ProgramData%\Rulebox\state\` with DACL
  `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`.

**rulebox-win32** — `guard` (read-only marker check), `registry`
(`get_hklm`, `set_hklm`, `with_user_hive`: opens `HKU\<SID>` when loaded,
else mounts `NTUSER.DAT` as `HKU\RuleboxStaffTmp`), `shellreg` (never names
HKLM, test-enforced), `autologon` (`FORBIDDEN_WINLOGON_VALUES = Shell,
Userinit, IgnoreShiftOverride, ForceAutoLogon`), `process`, `security`,
`osinfo`, `pipe`, `lsa`, `dpapi`, `accounts`.

**Staff App** (Phase 3) — `webapp/hooks.rs` answers `PermissionRequested`
per requesting origin with `SavesInProfile(false)`, cancels external URI
schemes and out-of-list frames; `webapp/permissions.rs` denies unknown kinds
and keeps a per-app denial counter (not reported yet). `rulebox-desktop`
`winkey.rs`: low-level hook in a helper process, acts on a lone Windows key
only, never swallows an event. `launch.rs`: each app in a Staff-owned job.

**Shared types** — `DesiredState { kioskEnabled, apps, allowedSites,
fileHandlers, storage, branding, version }`; IPC protocol 1.1 today
(`PROTOCOL_MINOR = 1`), 1.2 in Phase 4; `WebPermissions` with the PRD
defaults (`printing: false`).

**Backend / dashboard** — Phase 4 in progress (Step 1 committed; another
session is building Steps 2–3 now — do not touch its uncommitted files).
Every Phase 4 screen exists against demo fixtures behind
`apps/dashboard/src/data/` hooks.

### 3.3 Hand-off: what Phases 2, 3 and 4 left, and what Phase 5 does with it

| Left by | Item | Phase 5 action | Step |
|---|---|---|---|
| Phase 2 §12 | Staff lockdown policies (Task Manager, sign-out, Ctrl+Alt+Del options) | L1 catalogue (4.7) | 4 |
| Phase 2 §12 | Windows-key shortcuts | Staff App hook swallows combinations (Q7); the Explorer policy is set too but Explorer is not running | 4, 12 |
| Phase 2 §12 | Hide the admin tile | `SpecialAccounts\UserList` per enabled local admin, journalled (Q5) | 5 |
| Phase 2 §12 | Wake-password and sleep | No password on wake while kiosk is on; Staff screen saver not secure | 5 |
| Phase 2 §12 | Restrict service privileges | Required-privileges list, measured on the VM | 17 |
| Phase 2 §12 | Process allow-list watchdog | `procwatch` (4.10) | 8 |
| Phase 2 §12 | Keep hidden exit and Shift-at-startup; re-run the exit checklist after the policies | Safety invariants (4.6) + checklist E-70..E-74 | 4, 22 |
| Phase 2 table | Per-user tuning (22.2), performance profile (22.3) | Step 18 (Q11) | 18 |
| Phase 2 edge 19/46 | Switch user / sign-out from Ctrl+Alt+Del | `HideFastUserSwitching`, `NoLogoff` | 4, 5 |
| Phase 2 VM | Safe Mode (minimal): auto sign-in and shell run, **agent does not** | Agent registered for Safe Mode; holds auto sign-in off there (4.16) | 5 |
| Phase 2 VM "Not tested" | Win+L, Disconnected session, Shift while signing out, admin sign-in then sign-out | Checklist rows | 22 |
| Phase 3 §9 | Open routes: Ctrl+Alt+Del, Win combos, dialogs, browser links, accessibility, `explorer.exe` | Section 6 | 4–8, 12 |
| Phase 3 §16/§18 | Hiding Switch user for Staff only on Home unverified | Accept machine-wide; record Home result | 5, 22 |
| Phase 3 P7 | Hook passes combinations through | Hook swallows them when policy says so (Q7) | 12 |
| Phase 3 Step 15 | Denial counter not reported | IPC 1.3 → agent aggregates → `permissionDenials` | 11, 12 |
| Phase 3 Step 15 | File pickers and print dialogs not interceptable in WebView2 | Closed one level down: the dialogs cannot start programs (L1, L3–L5); file printers removed (L2) | 4, 7 |
| Phase 4 §17 | Room for agent-only keys | `lockdown`, `wifi`, `wifiManagedOnly`, `printers`, `deviceLock`, `broadcasts`, `config` (4.3) | 1, 10 |
| Phase 4 §17 | Rings: history, rollback = old content under a new version | Group configuration versions + per-device ring (4.14) | 16 |
| Phase 4 §17 | Web permissions stored in the catalogue | Editor + counts | 11 |
| Phase 4 §17 | `installResults` as model | `deviceApplyReports`, `lockdownFindings` | 9, 10 |
| Phase 4 §4.5/§4.6 | One env seed signs for every org; per-org seeds open | Per-organization signing and sealing keys wrapped by a deployment master key (4.18) — **must land before the first outside tenant** | 10 |

### 3.4 Ordering against Phases 3 and 4

- Steps 1–9, 17, 18 and 20 touch only `crates/` and `apps/agent`. They start
  after **Phase 4 Step 9** (agent verifies signed documents) and **Step 13**
  (agent catalogue, protocol 1.2) are committed.
- Steps 10, 11 (server), 13–16 and 19 need **Phase 4 Steps 2, 8, 10, 12**
  and the dashboard live hooks for the screens they extend.
- Step 12 (Staff App) needs **Phase 3 Step 19** and **Phase 4 Step 15**.
- Step 0 checks this and records blocked steps.

### 3.5 Decisions this plan assumes

Section 20 lists the user's questions with recommendations; the plan is
written for the recommended options. Step 0 shows Sections 19 and 20 and
waits. If the user picks differently, stop and ask how the steps change.
Section 18 lists this plan's own decisions.

---

<!-- APPEND -->
