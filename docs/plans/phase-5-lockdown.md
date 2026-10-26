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

## 4. Architecture and contracts

### 4.1 Layers, components and data flow

```
 Dashboard (admin) ──edit──▶ Convex (one shared deployment, many orgs)
   group lockdown, exceptions,        │  groupLockdown / wifiProfiles / printers / ... (live tables)
   Wi-Fi, printers, rings, lock,      │  snapshotGroupConfig ─▶ groupConfigs v1..vN (Section 4.14)
   broadcasts, permissions            │  publisher: device doc = ring's group config + live directory
                                      │  sealer (action): Wi-Fi passphrase ─▶ per-device sealed box
                                      ▼
                     desiredStates (signed with the ORG's key, 4.18)
                                      │  the agent's ONE subscription (unchanged)
                                      ▼
 Agent (SYSTEM) ── verify ─▶ validate (4.6 invariants) ─▶ apply transaction (4.11)
   │  journal v2 first (4.4) ─▶ Platform seam (4.5, guarded) ─▶ L1 … L7
   │  procwatch (L5) + event-log readers ─▶ findings / counts (local files)
   │  change-driven, batched reports ─▶ deviceApplyReports, lockdownFindings,
   │                                    deviceSecurityDaily, auditLog (4.19)
   ▼ IPC 1.3 (4.12)
 Staff App (standard user): Windows-key combinations, device lock screen,
   broadcasts, permission-denial counts ─▶ agent (aggregated)
```

| Layer | Scope | Mechanism | Modes | Undo on Disable | Editions |
|---|---|---|---|---|---|
| L1 Staff policies | Staff hive only | per-user policy values (4.7) | on/off per item | journal | all |
| L2 Machine policies | machine | HKLM policy values, account policy, printer security (4.8) | on/off per item | journal | all (Home: some items **(unverified)**) |
| L3 AppLocker | Staff SID only (rules for others are allow-all) | AppLocker policy, EXE/MSI/Script/Packaged collections (4.9) | off/audit/enforce | journal (policy removed) | Pro yes; Home **(unverified)** |
| L4 App Control | device-wide, kernel | unsigned base policies, multiple-policy format (4.9) | off/audit/enforce, level `recommendedBlocks`/`allowlist` | journal (policy removed) | Pro yes; Home **(unverified)** |
| L5 procwatch | Staff session processes | ETW process-start events + allow-list (4.10) | off/audit/enforce | nothing to undo (in-memory) | all |
| L6 Staff App | Staff session | keyboard hook, lock screen, broadcasts (4.12) | from the document | n/a | all |
| L7 Boot and tamper | machine | Safe Mode registration, BCD auto-recovery, service DACL, privileges (4.16) | on/off per item | journal | all |

Rules that hold for every layer:

- **One allow-list model, compiled three times.** The agent compiles the
  same `AllowList` (4.9) into AppLocker XML, into the procwatch matcher and
  into the "would be blocked" classifier for findings. The server never
  sends XML; it sends compact rules, so the document stays small (4.19).
- **The App Control policies are static.** They are built from XML in the
  repository, converted to binary at build time, embedded in the agent and
  versioned with it. Per-app exceptions never go into App Control (they go
  to L3 and L5), so a bad exception can never stop a PC from booting.
- **Nothing is enforced that was not audited** (rule 4): a layer moves
  from `audit` to `enforce` only by an administrator action, through rings.

### 4.2 Data model (Convex additions)

Same legend as Phase 4 Section 4.2 (**grows** = never `.collect()`;
**tiny** = read with `.take(LIMIT)` through an index). Every new table has
`orgId` and every query filters on it through an index. All timestamps are
server Unix ms.

| Table | Size | Fields | Indexes |
|---|---|---|---|
| `orgKeys` | tiny (≤ 6 per org) | `orgId`, `purpose: "signing"\|"sealing"`, `keyId: string` (16 hex), `wrapped: string` (base64 of `nonce ‖ ciphertext`, 4.18), `masterKeyId: string`, `status: "active"\|"next"\|"retired"`, `createdAt` | `by_org_purpose_status [orgId, purpose, status]`, `by_master_key [masterKeyId]` (re-wrap job) |
| `groupLockdown` | tiny (1 per group) | `orgId`, `groupId`, `settings: lockdownSettings` (4.3), `revision: number` | `by_group [groupId]` |
| `lockdownExceptions` | grows slowly (≤ 200 per group, `MAX_GROUP_EXCEPTIONS`) | `orgId`, `groupId: v.optional(id)` (missing = whole organization), `appId: v.optional(id)`, `rule: exceptionRule` (4.3), `reason: string` (≤ 200), `findingId: v.optional(id)`, `createdBy`, `createdAt` | `by_org_group [orgId, groupId]`, `by_finding [findingId]`, `by_app [appId]` |
| `lockdownFindings` | **grows** | `orgId`, `fingerprint: string` (64 hex, 4.10), `layer: "appLocker"\|"appControl"\|"procWatch"`, `fileName: string` (≤ 100), `folderClass` (4.10), `signer: v.optional(string)` (≤ 200), `product: v.optional(string)` (≤ 100), `sha256: v.optional(string)`, `firstSeenAt`, `lastSeenAt`, `deviceCount: number`, `sampleDeviceId: id`, `status: "new"\|"allowed"\|"ignored"`, `decidedBy: v.optional(id)`, `decidedAt: v.optional(number)` | `by_org_fingerprint [orgId, fingerprint]`, `by_org_status_seen [orgId, status, lastSeenAt]` |
| `lockdownFindingDevices` | **grows** | `orgId`, `findingId`, `deviceId`, `firstSeenAt` | `by_finding_device [findingId, deviceId]`, `by_device [deviceId]` (device removal cleanup, `.take(100)` batches) |
| `deviceApplyReports` | grows (1 per device) | `orgId`, `deviceId`, `appliedVersion: number`, `config: { groupId, version, ring }`, `state: "applied"\|"partial"\|"refused"\|"failed"\|"rolledBack"`, `refusal: v.optional(string)` (code from 4.6), `layers: layerStates` (4.11), `wifi: v.array({ profileId, revision, state, detail? })` (≤ 50), `printers: v.array({ printerId, revision, state, detail? })` (≤ 50), `lkgVersion: v.optional(number)`, `capabilities: v.array(string)`, `updatedAt` | `by_device [deviceId]`, `by_org_config [orgId, config.groupId, config.version]` (ring health) |
| `deviceSecurityDaily` | **grows** (≤ 1 per device per day, only non-zero days; 14-day retention) | `orgId`, `deviceId`, `day: string` (`YYYY-MM-DD`, server UTC), `blocked: { appLocker, appControl, procWatch, elevation }` (numbers), `permissionDenials: v.array({ appId, kind, count })` (≤ 100), `drift: number`, `tamper: number` | `by_device_day [deviceId, day]`, `by_org_day [orgId, day]` |
| `orgSecurityDaily` | grows (1 per org per day; 90-day retention) | `orgId`, `day`, `blocked` (sums), `permissionDenials: v.array({ appId, kind, count })` (≤ 500, summed), `devicesReporting: number` | `by_org_day [orgId, day]` |
| `wifiProfiles` | tiny (≤ 50 per org, `MAX_WIFI_PROFILES`) | `orgId`, `name` (≤ 60), `ssid` (1–32 bytes UTF-8), `hidden: boolean`, `security: "open"\|"wpa2Personal"\|"wpa3Personal"\|"wpa2Wpa3Personal"`, `autoConnect: boolean`, `passphrase: v.optional({ keyId, sealed })` (4.18; **never returned by any query**), `groupIds: v.array(id)` (≤ 100), `revision`, `createdAt` | `by_org [orgId]` |
| `deviceSealedSecrets` | **grows** (devices × profiles) | `orgId`, `deviceId`, `purpose: "wifi"`, `targetId: string`, `targetRevision: number`, `sealKeyId: string` (device seal key id), `sealed: string` (base64), `createdAt` | `by_device_target [deviceId, purpose, targetId]`, `by_target [purpose, targetId]` (cleanup) |
| `printers` | tiny (≤ 100 per org) | `orgId`, `name` (≤ 60), `kind: "ipp"\|"raw"\|"lpr"\|"share"`, `address: string` (≤ 255), `port: v.optional(number)`, `queue: v.optional(string)` (≤ 64), `driver: string` (from the approved list, 4.15), `groupIds: v.array(id)`, `defaultForGroupIds: v.array(id)`, `revision`, `createdAt` | `by_org [orgId]` |
| `groupConfigs` | grows (pruned to 20 per group) | `orgId`, `groupId`, `version: number`, `config: string` (JSON, ≤ 262,144 bytes, 4.14), `contentHash: string`, `createdBy: v.optional(id)`, `createdAt`, `reason: string` (≤ 120) | `by_group_version [groupId, version]` |
| `groupRollouts` | tiny (1 per group) | `orgId`, `groupId`, `enabled: boolean`, `pointers: { pilot: number, early: number, everyone: number }`, `autoPromote: { enabled: boolean, bakeHours: number, maxFailurePct: number }`, `autoRollback: boolean` (default true; pilot only), `state: "idle"\|"rolling"\|"halted"`, `haltReason: v.optional(string)`, `stageStartedAt: v.optional(number)`, `revision` | `by_group [groupId]`, `by_state_stage [state, stageStartedAt]` (promotion cron) |
| `deviceLocks` | grows (1 per locked device) | `orgId`, `deviceId`, `lockId: string`, `message` (≤ 300), `contact: v.optional(string)` (≤ 100), `lockedAt`, `lockedBy` | `by_device [deviceId]`, `by_org [orgId]` |
| `broadcasts` | **grows** | `orgId`, `target: { kind: "group"\|"device", id }`, `style: "banner"\|"fullscreen"`, `title` (≤ 80), `body` (≤ 500), `expiresAt: v.optional(number)`, `ackRequired: boolean`, `createdBy`, `createdAt`, `cancelledAt: v.optional(number)` | `by_org_created [orgId, createdAt]`, `by_target_created [target.kind, target.id, createdAt]` |
| `broadcastAcks` | **grows** | `orgId`, `broadcastId`, `deviceId`, `at` | `by_broadcast [broadcastId]`, `by_broadcast_device [broadcastId, deviceId]` |

Changes to existing tables (widen first, Phase 4 Section 11):

- `devices`: `ring: v.optional("pilot"|"early"|"everyone")` (missing =
  `everyone`), `sealPublicKey: v.optional(string)` (X25519, base64),
  `sealKeyId: v.optional(string)`.
- `deviceReports`: `security: v.optional(securityPosture)` (4.16) and
  `capabilities: v.optional(v.array(string))`; the strict
  `statusValidator` gets both keys **before** an agent sends them.
- `apps.web.permissions`: unchanged shape; new web apps get
  `printing: true` (Section 19, PRD 24.1).
- `orgSettings`: `approvedPrinterDrivers: v.optional(v.array(string))`
  (≤ 20; missing = the inbox list of 4.15), `newGroupDefaults:
  v.optional(lockdownSettings)`.

New audit actions (exact strings, Phase 4 Section 4.11 rules apply):
`lockdown.settingsChanged`, `lockdown.layerModeChanged`,
`lockdown.exceptionAdded`, `lockdown.exceptionRemoved`,
`lockdown.findingIgnored`, `app.permissionsChanged`, `wifi.created`,
`wifi.updated`, `wifi.passphraseSet`, `wifi.deleted`, `printer.created`,
`printer.updated`, `printer.deleted`, `rollout.enabled`,
`rollout.disabled`, `rollout.promoted`, `rollout.autoPromoted`,
`rollout.halted`, `rollout.resumed`, `rollout.rolledBack`,
`device.ringChanged`, `device.locked`, `device.unlocked`,
`broadcast.sent`, `broadcast.cancelled`, `org.keysCreated`,
`org.keysRewrapped`; from devices: `device.lockdownRefused`,
`device.lockdownRolledBack`, `device.tamperDetected`,
`device.driftReasserted` (first per item per day only),
`device.safeModeBlocked`, `device.clockJump`.

### 4.3 Desired-state additions (agent-only keys, format stays `rulebox.desired/2`)

The payload format string stays `rulebox.desired/2`: every addition is a
new **agent-only** key after `offlineDays`, in this order. A Phase 4 agent
ignores unknown keys (serde without `deny_unknown_fields`; Step 1 adds a
test that pins this) and reports no `lockdown/1` capability, so the
dashboard shows "Agent too old for lockdown" instead of pretending.
`rulebox_policy::DesiredState` (the Staff-visible part) **does not
change**; nothing below is copied into it or into the IPC snapshot except
the non-secret views named in 4.12.

```jsonc
"doc": {
  /* … Phase 2 / Phase 4 keys unchanged, ending with "offlineDays": 3 … */
  "lockdown": {                                   // LockdownPolicy; absent = all layers off (restore)
    "staff": { "taskManager": true, "run": true, "commandPrompt": true, "registryTools": true,
               "settings": true, "signOut": true, "changePassword": true, "hideDrives": true,
               "accessibilityHotkeys": true, "officeMacros": true },        // true = restricted (4.7)
    "machine": { "hideSwitchUser": true, "hideSignInPower": true, "denyElevationRequests": true,
                 "hideAdminTiles": true, "noWakePassword": true, "restrictPrinterDrivers": true,
                 "fileOutputPrinters": true,
                 "accountLockout": { "threshold": 10, "durationMin": 15, "windowMin": 15 } },  // null = leave (4.8)
    "appLocker":  { "mode": "audit" },                                  // off | audit | enforce
    "appControl": { "mode": "audit", "level": "recommendedBlocks" },    // level: recommendedBlocks | allowlist
    "procWatch":  { "mode": "audit" },
    "exceptions": [ /* ExceptionRule, sorted by id, ≤ 200 */ ],
    "keyboard":   { "winCombos": "swallow" },                           // pass | swallow (Q7)
    "usbStorage": "allow",                                              // allow | readOnly | block (Q4)
    "accessibilityTools": false,                                        // true = Narrator, magnifier, OSK allowed for Staff
    "boot":       { "autoRecovery": "off", "safeModeGuard": true },      // autoRecovery: leave | off
    "performance": { "staffTuning": true, "kioskProfile": true, "noPrinting": false }
  },
  "wifi": [ { "id": "k9…", "ssid": "Acme-Staff", "hidden": false, "security": "wpa2Personal",
              "autoConnect": true, "revision": 3,
              "sealed": { "v": 1, "keyId": "a1b2…", "epk": "<b64>", "nonce": "<b64>", "ct": "<b64>" } } ],
  "wifiManagedOnly": false,
  "printers": [ { "id": "k7…", "name": "Front desk", "kind": "ipp", "address": "https://10.0.0.20:631/ipp/print",
                  "port": null, "queue": null, "driver": "Microsoft IPP Class Driver", "isDefault": true, "revision": 2 } ],
  "deviceLock": null,                             // or { "lockId", "message", "contact", "lockedAtMs" }
  "broadcasts": [ { "id": "k5…", "style": "banner", "title": "Maintenance", "body": "…",
                    "expiresAtMs": 1761000000000, "ackRequired": true, "issuedAtMs": 1760990000000 } ],
  "config": { "groupId": "k1…", "version": 14, "ring": "pilot" }
}
```

Rust types (`crates/rulebox-policy/src/lockdown.rs`, `network.rs`,
`notice.rs`; exported with ts-rs to `packages/types`; every enum uses the
`unknown_on_new_values!` macro):

```rust
pub enum LayerMode { Off, Audit, Enforce, Unknown }
pub enum AppControlLevel { RecommendedBlocks, Allowlist, Unknown }
pub enum ExceptionKind { Publisher, Hash, Path, Unknown }
pub struct ExceptionRule {
    pub id: String,                       // Convex lockdownExceptions id
    pub app_id: Option<String>,           // catalogue id it belongs to (None = group-wide)
    pub kind: ExceptionKind,
    pub publisher: Option<PublisherMatch>,// { subject: String (≤ 200), product: Option<String>, file_name: Option<String> }
    pub sha256: Option<String>,           // 64 lower-case hex
    pub path: Option<String>,             // path TEMPLATE only ({ProgramFiles}\…, {RuleboxApps}\…), never a user folder
    pub layers: Vec<ExceptionLayer>,      // appLocker | procWatch (never appControl)
}
pub struct WifiProfile { pub id: String, pub ssid: String, pub hidden: bool, pub security: WifiSecurity,
    pub auto_connect: bool, #[ts(type = "number")] pub revision: u64, pub sealed: Option<SealedBox> }
pub struct PrinterSpec { pub id: String, pub name: String, pub kind: PrinterKind, pub address: String,
    pub port: Option<u16>, pub queue: Option<String>, pub driver: String, pub is_default: bool,
    #[ts(type = "number")] pub revision: u64 }
pub struct DeviceLock { pub lock_id: String, pub message: String, pub contact: Option<String>,
    #[ts(type = "number")] pub locked_at_ms: u64 }
pub struct Broadcast { pub id: String, pub style: BroadcastStyle, pub title: String, pub body: String,
    #[ts(type = "number | null")] pub expires_at_ms: Option<u64>, pub ack_required: bool,
    #[ts(type = "number")] pub issued_at_ms: u64 }
pub struct ConfigRef { pub group_id: String, #[ts(type = "number")] pub version: u64, pub ring: Ring }
```

**Defaults** (used by `lockdownSettings` for a new group, and by the agent
when a sub-key is missing): every `staff` and `machine` boolean `true`;
`accountLockout` `{10, 15, 15}`; all three layer modes `audit`;
`appControl.level` `recommendedBlocks`; `exceptions` `[]`;
`keyboard.winCombos` `swallow`; `usbStorage` `allow`;
`accessibilityTools` `false`; `boot.autoRecovery` `off` (the agent uses
`leave` while BitLocker protects the OS volume, 4.16); `safeModeGuard`
`true`; `performance` `{ true, true, false }`; `wifi` / `printers` /
`broadcasts` `[]`; `wifiManagedOnly` `false`; `deviceLock` `null`.

**Compatibility rules:**

1. **Absent key = off.** The builder always writes `lockdown` once Step 10
   lands; a document without it means "restore every Phase 5 change"
   (Disable kiosk keeps meaning `kioskEnabled: false`, which restores
   everything regardless of `lockdown`).
2. **Unknown enum value = keep the last applied value of that section** and
   report `section_unknown_value` (never "treat as off": a newer server
   asking for something stricter must not make an old agent looser).
3. **New sub-keys are optional with the defaults above.** A field is never
   renamed or reused; removal follows widen-then-narrow.
4. **Limits** (server and agent both check; the agent refuses the whole
   document with `policy_rejected` above them): `exceptions` ≤ 200, `wifi`
   ≤ 20 per device, `printers` ≤ 20, `broadcasts` ≤ 5 active,
   `deviceLock.message` ≤ 300, strings in the sizes of 4.2. A lockdown
   section typically adds 2–4 KB to the payload; the worst case (200
   exceptions, 20 profiles, 20 printers) stays under 64 KB.
5. **Builder order and determinism** follow Phase 4 4.4 rule 1: the key
   order shown, arrays sorted by `id`, integers only.
6. **What is ring-gated** (taken from the ring's `groupConfigs` version,
   4.14): `apps`, `catalog`, `fileHandlers`, `allowedSites`, `lockdown`,
   `wifi` (without the sealed boxes), `wifiManagedOnly`, `printers`.
   **Not** ring-gated (always live): `employees`, `adminExit`, `power`,
   `kioskEnabled`, `deviceLock`, `broadcasts`, keys, `offlineDays`.
   Locks, broadcasts and the directory must never wait for a pilot.

### 4.4 Journal v2 and the apply transaction

`AgentState.schema` becomes **2** (`STATE_SCHEMA = 2`). The journal stops
being "registry values only" and becomes a list of typed targets.

```rust
// apps/agent/src/journal.rs (new; state.rs keeps the store and re-exports)
pub struct JournalEntry {
    pub id: String,                 // stable key, e.g. "hklm:SOFTWARE\\…\\System|HideFastUserSwitching",
                                    // "staff:Software\\…\\Explorer|NoRun", "svc:SysMain|start", "wlan:Acme-Staff",
                                    // "printer:k7…", "printerSd:<port>|<driver>", "ci:{GUID}", "applocker",
                                    // "bcd:{current}|recoveryenabled", "netmodals:lockout", "safeboot:Minimal"
    pub owner: JournalOwner,        // Kiosk | L1 | L2 | L3 | L4 | L7 | Wifi | Printer | Perf
    pub target: JournalTarget,
    pub original: OriginalValue,
    pub phase: EntryPhase,          // Pending | Applied | Restoring
    pub since_version: u64,         // document version that first wrote it (LKG restores by this, 4.11)
    pub recorded_at_ms: u64,
}
pub enum JournalTarget {
    MachineValue(RegValueRef),               // HKLM, only under machinereg::ALLOWED_ROOTS
    StaffValue { path: String, name: String },// Staff hive, only under staffreg::ALLOWED_ROOTS
    ServiceStart { name: String },
    CiPolicy { policy_id: String },
    AppLockerPolicy,
    WlanProfile { name: String }, WlanFilters,
    Printer { name: String }, PrinterPort { name: String }, PrinterSecurity { printer_key: String },
    BcdElement { object: String, element: String },
    AccountLockoutPolicy, SafeBootEntry { mode: String },
    ServiceSecurity { name: String }, ServicePrivileges { name: String },
}
pub enum OriginalValue {            // v1 variants kept, new ones added
    Absent, Dword(u32), String(String), InSecrets,
    Qword(u64), MultiString(Vec<String>), Binary(String /* base64 */),
    Sddl(String), ServiceStart(u32), LockoutPolicy { threshold: u32, duration_s: u32, window_s: u32 },
    BcdValue(Option<String>), NotPresent, // NotPresent = the object did not exist: restore deletes it
}
```

**Write order for every change** (one function, `journal::change`, used
by every layer — no layer writes to the system any other way):

1. If an entry with this `id` exists, keep its `original` (never record a
   value Rulebox wrote as "original"); else read the current value through
   the read-only seam, append `{ phase: Pending }`, `write_atomic`.
2. Call the mutating `Platform` method.
3. Set `phase: Applied`, `write_atomic`.

`write_atomic` writes a temp file, `FlushFileBuffers`, renames with
`MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`; Step 2 checks the
Phase 2 implementation does this and adds the flush if it is missing.

**Restore** (Disable kiosk, `unenroll`, `recover`, LKG rollback of one
owner) walks the journal in **reverse** order: set `Restoring`, write the
original back (or delete when `Absent` / `NotPresent`), remove the entry,
save. A failed restore leaves the entry in `Restoring`, records
`lastError`, continues with the next entry and retries failed ones every
reconcile; the device report says `restore_incomplete` with the ids.

**Start-up recovery:** an entry in `Pending` after a crash or power loss
is compared with the system: current value equals `original` → drop the
entry; otherwise treat it as `Applied` (restore will put the original
back). An entry in `Restoring` is restored again (restores are
idempotent).

**Migration v1 → v2** (`state::migrate`, on load, before anything else):
each v1 `JournalEntry { key, original }` becomes `{ id: "hklm:"+key,
owner: Kiosk, target: MachineValue(key), original, phase: Applied,
since_version: last_applied_version }`;
`schema = 2`; the old file is kept once as `state.v1.json`. A v2 agent
reading a v2 file with an unknown `JournalTarget` (from a newer agent
that was rolled back) **refuses to apply** and keeps the kiosk as it is
(`journal_unknown_target`), because it could not restore that entry.

**Size:** the journal is bounded by the catalogues of 4.7/4.8 plus
≤ 20 Wi-Fi profiles and ≤ 20 printers: about 120 entries, < 64 KB.

### 4.5 Platform seam and the test-machine guard

New `Platform` methods. **Mutating** ones are marked M; each calls
`guard::require_test_machine()` as its **first statement** in
`WindowsPlatform`, and the `rulebox-win32` function it calls does the
same. Read-only ones (R) need no guard. `SimPlatform` implements all of
them in memory and records calls for tests.

| Method | M/R | `rulebox-win32` module |
|---|---|---|
| `read_machine_value(&RegValueRef) -> OriginalValue` | R | `registry` |
| `write_machine_value` (exists) — now refuses keys outside `machinereg::ALLOWED_ROOTS` | M | `registry`, `machinereg` (new) |
| `read_staff_value(path, name)` / `write_staff_value(path, name, RegData)` / `delete_staff_value` | R / M / M | `staffreg` (new; replaces `set_staff_user_policy`, which stays as a thin wrapper) |
| `deploy_ci_policy(policy_id, &[u8])`, `remove_ci_policy(policy_id)`, `list_ci_policies()` | M, M, R | `codeintegrity` (new) |
| `set_applocker_policy(&str /* XML */, mechanism)`, `clear_applocker_policy(mechanism)`, `get_applocker_policy()` | M, M, R | `applocker` (new) |
| `set_service_start(name, start)`, `query_service(name)` | M, R | `service` (new, wraps SCM) |
| `set_service_security(name, sddl)`, `set_service_required_privileges(name, &[&str])` | M | `service` |
| `set_account_lockout(policy)`, `get_account_lockout()` | M, R | `accounts` |
| `wlan_set_profile(xml_with_key)`, `wlan_delete_profile(name)`, `wlan_set_filters(&[ssid])`, `wlan_list()` | M, M, M, R | `wlan` (new) |
| `printer_add(spec)`, `printer_delete(name)`, `printer_set_security(name, sddl)`, `printer_list()` | M, M, M, R | `printing` (new) |
| `bcd_set(object, element, value)`, `bcd_get(...)` | M, R | `bcd` (new, WMI BCD provider) |
| `start_process_trace(sink) -> TraceHandle`, `stop_process_trace` | M | `etw` (new) |
| `read_event_log(channel, after_record_id, max)` | R | `eventlog` (new) |
| `read_security_posture()` | R | `posture` (new) |
| `set_path_acl(path, sddl)`, `get_path_acl(path)` | M, R | `security` (exists, extended) |
| `terminate_process` (exists) | M | `process` |

**Guard rules** (Section 4.5 is the contract; Step 3 adds the tests):

1. `apps/agent/tests/guard_coverage.rs` reads `platform/windows.rs` as
   text and checks that every method in the list `MUTATING_METHODS`
   (a `const` in `platform/mod.rs`) has `guard::require_test_machine()?`
   as its first statement. The same test runs over
   `crates/rulebox-win32/src/{machinereg,staffreg,codeintegrity,applocker,service,wlan,printing,bcd,etw}.rs`
   for every `pub fn` not in a read-only allow-list.
2. `machinereg::ALLOWED_ROOTS` and `staffreg::ALLOWED_ROOTS` are fixed
   lists (4.7, 4.8). A write outside them returns
   `Win32Error::Forbidden` before the guard, and a test proves it.
   `autologon::FORBIDDEN_WINLOGON_VALUES` (`Shell`, `Userinit`,
   `IgnoreShiftOverride`, `ForceAutoLogon`) is now also checked by
   `machinereg`, so no layer can write them.
3. **There is no bypass:** no cargo feature, environment variable or flag
   skips the guard; release builds keep it until Phase 6 decides.
4. **Never create the marker** (rule 1). No script, test, doc snippet or
   helper in this phase writes `HKLM\SOFTWARE\Rulebox\TestMachine`.
5. Building artifacts is not a system change: Step 6's XML → binary
   conversion writes only under `target\` and runs no `Platform` method.
6. Every unit and integration test in this phase uses `SimPlatform`. A
   test that needs a real Windows effect is a **VM checklist row**, not a
   test.

### 4.6 Safety invariants (the way back)

`apps/agent/src/lockdown/invariants.rs`: `validate(doc, facts) ->
Result<(), Refusal>` runs before any write (4.11 step 2). `facts` are
read-only machine facts (edition, BitLocker state, current network,
local accounts, installed catalogue paths). Each invariant has a unit
test on **generated output** (not on intentions) and a VM row.

| # | Invariant | How it is enforced | Refusal code | Test / VM row |
|---|---|---|---|---|
| I1 | `rulebox-agent.exe`, `rulebox-shell.exe` and the Staff App under `versions\` can always start | Invariant allow rules emitted by the allow-list compiler for every layer and mode; procwatch never-terminate list; exceptions cannot remove them (rules are additive; there is no deny rule for the Rulebox folder) | `would_block_rulebox` | golden-file test over every layer × mode × level; E-70 |
| I2 | The WebView2 runtime can start for Staff | Same as I1, for the runtime folder found at apply time | `would_block_rulebox` | same |
| I3 | The hidden admin exit (key combination + PIN) works | No layer touches the Staff App hook helper or the IPC pipe; `keyboard.winCombos` cannot affect a non-Windows-key hotkey (grammar); `NoLogoff` hides UI only and the agent's `logoff_session` uses the session API | `would_block_exit` | hotkey/winkey test; E-70 |
| I4 | Shift at startup works | `FORBIDDEN_WINLOGON_VALUES` checked by `machinereg`; no layer writes Winlogon values other than Phase 2's | `would_block_exit` | allowed-roots test; E-72 |
| I5 | "Disable kiosk" from the dashboard reaches the device | The agent's network path is never blocked by a layer; `wifiManagedOnly` refused with no managed network or when it would disconnect the current link | `managed_networks_empty`, `would_disconnect` | unit; E-73 |
| I6 | `rulebox-agent recover` run by an administrator works | AppLocker allow-all for Administrators; App Control levels allow Windows and the Rulebox folder; L1 is Staff-only, so the admin's own tools are untouched | `would_block_admin` | golden-file test; E-74 |
| I7 | An administrator can still sign in | `hideAdminTiles` only after E-71 is recorded as passed (agent-config flag set by the user after the VM run); account lockout threshold ≥ 5 | `admin_signin_unverified`, `lockout_threshold_too_low` | unit; E-71 |
| I8 | Restore is always possible | Every write goes through the journal; unknown journal targets stop the apply | `journal_unknown_target` | journal tests |
| I9 | Nothing is enforced without a prior audit period on this device | A layer switched to `enforce` that has never run in `audit` on this device runs 24 h in `audit` first and reports layer state `auditFirst` (the dashboard explains); the admin can skip this per device | `audit_first` (informational, not a refusal) | unit |

A refusal writes nothing, keeps the previous applied state, reports
`refused` with the code and audits `device.lockdownRefused`. The
dashboard maps each code to a sentence.

### 4.7 L1 — Staff policy catalogue (Staff hive only)

Written under the Staff hive through `staffreg`. `staffreg::ALLOWED_ROOTS`
= `Software\Microsoft\Windows\CurrentVersion\Policies\System`,
`…\Policies\Explorer`, `Software\Policies\Microsoft\Windows\System`,
`Software\Policies\Microsoft\Windows\Explorer`,
`Software\Policies\Microsoft\Windows\Control Panel\Desktop`,
`Software\Policies\Microsoft\Windows\RemovableStorageDevices`,
`Software\Policies\Microsoft\Office\16.0`, `Control Panel\Accessibility`,
`Software\Microsoft\Windows NT\CurrentVersion\Windows` (default printer),
`Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced` (Step 18
tuning), `Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications`,
`Software\Microsoft\Windows\CurrentVersion\Run` (read + journalled
removal of Staff entries, Step 18).

| Document key | Values written (DWORD unless noted) | Effect for Staff | Checklist |
|---|---|---|---|
| `taskManager` | `Policies\System\DisableTaskMgr = 1` | Task Manager unavailable (also removed from the Ctrl+Alt+Del screen) | E-01..E-09 |
| `signOut` | `Policies\Explorer\NoLogoff = 1` | Sign out removed from the Ctrl+Alt+Del screen | E-01..E-09 |
| `changePassword` | `Policies\System\DisableChangePassword = 1` | Change password removed | E-01..E-09 |
| (always, Phase 2) | `Policies\System\DisableLockWorkstation = 1` | Windows lock removed (the Staff App has its own lock) | E-01..E-09 |
| `run` | `Policies\Explorer\NoRun = 1` | Run dialog unavailable | E-10..E-19 |
| `commandPrompt` | `Software\Policies\Microsoft\Windows\System\DisableCMD = 1` | Command prompt and batch files refused | E-30..E-39 |
| `registryTools` | `Policies\System\DisableRegistryTools = 1` | Registry editor refused | E-30..E-39 |
| `settings` | `Policies\Explorer\NoControlPanel = 1` | Settings and Control Panel refused | E-20..E-29 |
| `hideDrives` | `Policies\Explorer\NoDrives = 0x03FFFFFF` | Drives hidden in file dialogs' navigation (cosmetic; access control is L3–L5) | E-20..E-29 |
| (with `keyboard`) | `Policies\Explorer\NoWinKeys = 1` | Explorer's Windows-key shortcuts off (effective control is the hook, Q7) | E-10..E-19 |
| `accessibilityHotkeys` | `Control Panel\Accessibility\{StickyKeys,FilterKeys,ToggleKeys,MouseKeys}\Flags` (REG_SZ, hotkey bit cleared from the original value) | Accessibility shortcut keys do not trigger | E-50..E-59 |
| `officeMacros` | `Software\Policies\Microsoft\Office\16.0\{word,excel,powerpoint}\security\VBAWarnings = 4`, `…\blockcontentexecutionfrominternet = 1` | Macros disabled without prompt (PRD 13.1) | E-20..E-29 |
| (always with `noWakePassword`) | `Software\Policies\Microsoft\Windows\Control Panel\Desktop\ScreenSaverIsSecure` (REG_SZ `"0"`) | No password prompt after the screen saver | E-01..E-09 |
| `usbStorage` (`readOnly` / `block`) | `Software\Policies\Microsoft\Windows\RemovableStorageDevices\Deny_Write = 1`, or `…\Deny_All = 1` (user-scope policy) | Removable storage read-only or unavailable for Staff only; admins unaffected | E-60..E-69 |

Each value is journalled with owner `L1`; `false` for a key means "restore
that value". The list is the complete set; adding one is a plan change.

### 4.8 L2 — Machine policy catalogue

Written through `machinereg` (`ALLOWED_ROOTS` =
`SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`,
`SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList`,
`SOFTWARE\Policies\Microsoft\Power\PowerSettings`,
`SOFTWARE\Policies\Microsoft\Windows NT\Printers`,
`SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal`,
`SYSTEM\CurrentControlSet\Control\SafeBoot\Network`, plus the Phase 2
roots). These affect every account on the PC; the dashboard says
so next to each switch.

| Document key | What the agent sets | Effect | Checklist |
|---|---|---|---|
| `hideSwitchUser` | `Policies\System\HideFastUserSwitching = 1` | No Switch user (Phase 2 edge 19) | E-01..E-09 |
| `hideSignInPower` | `Policies\System\ShutdownWithoutLogon = 0` | No power button on the sign-in screen | E-60..E-69 |
| `denyElevationRequests` | `Policies\System\ConsentPromptBehaviorUser = 0` | Standard users' elevation requests are denied without a credential prompt | E-30..E-39 |
| `hideAdminTiles` | `SpecialAccounts\UserList\<name> = 0` for each enabled local administrator (Q5; gated by I7) | Admin tiles hidden; admins use "Other user" | E-01..E-09 |
| `accountLockout` | `NetUserModalsSet` level 3: threshold / duration / window | Repeated wrong passwords lock the account (PRD 13.6 #8) | E-01..E-09 |
| `noWakePassword` | `PowerSettings\0e796bdb-100d-47d6-a2d5-f7d2daa51f51\{ACSettingIndex,DCSettingIndex} = 0` | No password on wake while the kiosk is on | E-01..E-09 |
| `restrictPrinterDrivers` | `Printers\PointAndPrint\RestrictDriverInstallationToAdministrators = 1` | Only administrators install printer drivers | E-20..E-29 |
| `fileOutputPrinters` | `printer_set_security`: deny the Staff SID "Print" on printers whose port is a file-output port (identified by port type, not by localized name) | Print-to-file printers unusable for Staff; admins unaffected | E-20..E-29 |
| `boot.safeModeGuard` | SafeBoot `Minimal` and `Network` keys for `RuleboxAgent` (4.16) | Agent runs in Safe Mode | E-60..E-69 |

Everything is journalled with owner `L2` or `L7` and restored on Disable.

### 4.9 L3 AppLocker and L4 App Control: the allow-list model

**`AllowList`** (`apps/agent/src/lockdown/allowlist.rs`), built by the
agent from the document and machine facts at apply time:

| Part | Content | Source |
|---|---|---|
| Invariant | `%ProgramFiles%\Rulebox\*` (agent, launcher, Staff App `versions\`, `{RuleboxApps}`), the WebView2 runtime folder | 4.6 I1–I2 |
| Windows | `%WINDIR%\*` **minus** (a) writable subfolders found by the ACL scan below, (b) `STAFF_DENY_WINDOWS_BINARIES` | code constant + scan |
| Catalogue | for each desktop app in the device catalogue: the folder of its `exe` template (expanded), as a path rule when the folder is admin-only, else refused | catalogue (Phase 4 4.8) |
| Exceptions | publisher / hash / admin-only path rules from `lockdown.exceptions` | 4.3 |
| Accessibility | Windows accessibility tools, only when `accessibilityTools` is true | 4.3 |

- **`STAFF_DENY_WINDOWS_BINARIES`**: starts from Microsoft's recommended
  block rules list plus Windows' shells, script hosts, registry editors
  and management consoles. It is a reviewed constant with a comment per
  entry; changing it is a plan change. Matching is by original file name
  from the version resource **and** path, so a renamed copy elsewhere
  is still outside the allow-list.
- **Writable-folder scan:** at apply time the agent lists folders under
  `%WINDIR%` and the catalogue folders whose DACL grants write or create
  to the Staff SID, `Users`, `Authenticated Users`, `Everyone` or
  `INTERACTIVE` (well-known SIDs), and adds them as exceptions to the
  path allow rules. The result is cached by folder + DACL hash.
- **Never** a path allow rule under a user-writable folder; exceptions
  there must be publisher or hash rules (validator, edge case 13).

**AppLocker policy** (`lockdown/applocker.rs` → XML, deterministic):

- Collections: EXE, MSI, Script, Packaged app (`Appx`). DLL collection
  **off** (performance on 4 GB laptops; recorded as residual risk in
  Section 6 by the main session).
- Enforcement mode per collection from `appLocker.mode`: `AuditOnly` or
  `Enabled`; `off` = no Rulebox policy (journal removes it).
- Rules: (1) Administrators (`S-1-5-32-544`) allow `*`; (2) each other
  enabled local account SID except Staff allow `*` (re-evaluated every
  reconcile); (3) Everyone allow the invariant folders; (4) Staff SID
  allow the `AllowList` (path rules with exceptions, publisher rules,
  hash rules); (5) Packaged apps: Staff allow only the packages Windows
  needs for the session (measured in audit on the VM, kept in
  `STAFF_ALLOWED_PACKAGES`).
- Rule ids are UUIDv5 of the rule content, so the same input gives the
  same XML (golden files).
- Mechanism: `AppLockerMechanism::{MdmBridge, LocalPolicy}`; both
  implemented; the VM (Step 21) decides the default per edition; the
  agent records which one applied in the journal so restore uses the
  same one. Application Identity service (`AppIDSvc`) start type set to
  automatic and journalled (AppLocker needs it).

**App Control policies** (static, embedded, multiple-policy format):

| Policy | Id | Content | Default |
|---|---|---|---|
| `recommended-blocks.xml` | fixed GUID `RB-BLOCKS` | Microsoft's recommended block rules as a base policy that otherwise allows everything | on (`audit` → `enforce` by admin) |
| `allowlist.xml` | fixed GUID `RB-ALLOW` | Allow Windows-signed code, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%WINDIR%` (App Control's runtime check refuses path rules for folders writable by standard users), and the Rulebox folder; "Enabled:Audit Mode" in the audit build | off; only with `level: allowlist` (Q1) |

- Both are built twice (audit and enforce variants) by
  `scripts/appcontrol-build.ps1` into `target\appcontrol\*.cip`; `build.rs`
  embeds them with their SHA-256. The policy version in each XML
  increases with every content change.
- Deploy: write `{GUID}.cip` into the Code Integrity active-policies
  folder through `codeintegrity::deploy`, then refresh with
  `CiTool --update-policy` on Windows 11 22H2+; on Windows 10 the layer
  reports `restartPending`. Remove: `CiTool --remove-policy` + delete the
  file; `restartPending` when Windows needs it **(unverified)**.
- The agent never edits, merges or removes a policy it did not deploy
  (it lists active policies and touches only its two GUIDs).
- `allowlist` is refused while the catalogue has an app outside the
  allowed folders (`allowlist_level_with_user_install`).

### 4.10 Audit mode, findings and the process watchdog (L5)

**Findings sources** (read-only, `eventlog::read` with a bookmark per
channel saved in `findings-state.json`):

| Source | Events used | Layer |
|---|---|---|
| `Microsoft-Windows-AppLocker/EXE and DLL`, `/MSI and Script`, `/Packaged app-Execution` | "would have been blocked" (audit) and "blocked" (enforce) events, Staff SID only | appLocker |
| `Microsoft-Windows-CodeIntegrity/Operational` | audit-mode and enforce-mode block events for Rulebox's policy GUIDs only | appControl |
| procwatch | own decisions | procWatch |

**Fingerprint** = SHA-256 of `layer | lower(fileName) | folderClass |
signer | sha256?`. **`folderClass`** is one of `windows`, `programFiles`,
`rulebox`, `userProfile`, `userTemp`, `removable`, `network`, `other` —
the full path never leaves the device (rule 6). `signer` is the leaf
certificate subject's CN and O only; `product` from the version
resource. Command lines are never read.

Local store `findings.json` (≤ 500 fingerprints, LRU): first seen, last
seen, count, reported flag. Flush rules: 4.19.

**Procwatch** (`lockdown/procwatch.rs`):

1. Real-time ETW session `RuleboxProcWatch` on the kernel process
   provider, process-start events only, started by the agent (guarded).
   Fallback: 2-second snapshot diff (edge case 44).
2. For each start: if the token user is not the Staff SID → ignore.
   Never-terminate list → allow. Else evaluate the `AllowList` (path +
   cached signature + hash only when a hash rule exists for that file
   name).
3. `audit`: record a finding. `enforce`: `terminate_process(pid,
   expected_image, expected_sid)` (re-checks both at the moment of
   termination; Phase 2), count it in `blocked.procWatch`, record the
   finding; the Staff App shows "This program is not allowed on this PC"
   once per program per session (IPC event `program.blocked`, 4.12).
4. Decisions are made from the image path the kernel reports, never from
   window titles or command lines.
5. In `off`, the session is not started at all.

### 4.11 Apply reports, last-known-good and drift

**Apply order** for a new verified document (`apps/agent/src/lockdown/apply.rs`):

1. Parse and check limits (4.3 rule 4) → `policy_rejected` on failure.
2. `invariants::validate(&doc, &machine_facts)` (4.6) → `refused` with a
   code; nothing is written; the previous state stays.
3. Apply in this order, each through `journal::change`: L7 (Safe Mode
   registration, service hardening) → L2 → L1 → Wi-Fi → printers → L4 →
   L3 → L5 mode → performance profile. Order rationale: the way back and
   tamper protection first; the program-start layers last, so a failure
   in an earlier step leaves the PC less locked, never more.
4. Each layer returns `LayerState { mode, state: "ok"|"partial"|"failed"|"unsupported"|"restartPending"|"auditFirst", detail? }`
   (`detail` is a fixed code, never free text from Windows).
5. Record the result, then send **one** apply report (below).

```ts
export const layerStates = v.object({
  staff: layerState, machine: layerState, appLocker: layerState, appControl: layerState,
  procWatch: layerState, boot: layerState, performance: layerState,
});
// layerState = { mode: "off"|"audit"|"enforce"|"on", state: "ok"|"partial"|"failed"|"unsupported"|"restartPending"|"auditFirst", detail?: string }
```

**Device-local last-known-good (LKG).** `%ProgramData%\Rulebox\state\lkg.json`
holds the last signed payload whose lockdown section was applied **and**
followed by a healthy shell: the Staff App sent `ui_alive` within
`LKG_HEALTH_WINDOW` = 180 s after the apply (or after the next Staff
sign-in to Windows if none was signed in). If, after applying a new
lockdown section, the launcher watchdog records 3 Staff App crashes within
5 minutes, or no `ui_alive` arrives within the window while the Staff
session is active:

1. Restore the journal entries owned by L1–L5 and L7 that changed since
   the LKG version (each entry stores `since_version`).
2. Re-apply the LKG lockdown section (signature re-verified from the
   stored payload).
3. Mark the failed `config.version` as **refused locally**: the agent
   applies nothing from that group configuration version again, but keeps
   applying non-ring-gated changes (locks, broadcasts, employees) from new
   documents that still carry it.
4. Report `state: "rolledBack"` and audit `device.lockdownRolledBack`.
   The ring logic (4.14) counts it as a failure.

LKG never rolls back `kioskEnabled`, keys, employees or the device lock.

**Drift.** The reconcile loop (Phase 2 `REASSERT_INTERVAL` = 10 min, plus
on every agent start and when the reported OS build number changes)
re-reads each `Applied`
journal target. A value that differs is written again **without**
touching `original`; `deviceSecurityDaily.drift` counts it and the first
drift per target per day writes `device.driftReasserted`. A target that
drifts more than 6 times in an hour is left alone for the rest of that
hour and reported as `layer.state = "partial", detail = "fighting"`
(typical cause: domain Group Policy; edge case 23).

**Apply report** (`deviceApi:reportApply`, change-driven): sent when
`appliedVersion`, any `LayerState`, any Wi-Fi/printer state or the LKG
version changes; coalesced for 30 s; never more than once per 60 s; the
server upserts `deviceApplyReports` only when the content hash differs.

### 4.12 IPC protocol 1.3 (agent ↔ Staff App)

Additive (`PROTOCOL_MINOR = 3`). 1.1 and 1.2 clients keep working: they
ignore unknown events and snapshot fields; a 1.2 Staff App on a 1.3 agent
simply does not show the lock screen, so the agent **also** enforces the
lock itself (4.17).

| Addition | Shape | When |
|---|---|---|
| Capability `deviceLock` | in `hello` | always on a 1.3 agent |
| Snapshot `deviceLock: Option<DeviceLockView>` | `{ lockId, message, contact? }` | the document has `deviceLock` |
| Event `device.lockChanged` | `{}` (read the snapshot) | lock set or cleared |
| Capability `broadcasts` | | always |
| Snapshot `broadcasts: Vec<BroadcastView>` | `{ id, style, title, body, ackRequired, acknowledged }` (expired ones removed by the agent) | |
| Event `broadcasts.changed` | `{}` | list changed, at most one per 2 s |
| Request `broadcast.acknowledge` | `{ id }` → `{ ok }` | employee pressed "OK"; agent queues one ack |
| Capability `keyboardPolicy` | | always |
| Snapshot `keyboard: { winCombos: "pass" \| "swallow" }` | enum with `Unknown` (treated as `swallow`) | |
| Capability `permissionReports` | | always |
| Request `webapp.reportDenials` | `{ counts: [{ appId, kind, count }] }` (≤ 100 entries) → `{ ok }` | Staff App flushes its per-app counter at most once per 60 s and at sign-out |
| Event `program.blocked` | `{ displayName }` (product name or file name, ≤ 100) | procwatch ended a Staff process in `enforce`; at most once per program per session; the Staff App shows a short notice |
| Snapshot `printing: { available: bool }` | | `printers` non-empty **and** the Spooler is running |
| Snapshot `network: { managedOnly: bool, ssids: Vec<String> }` | status only (Phase 3 P11) | |

The agent validates every request as untrusted input: `appId` must be in
the device catalogue, `kind` one of the 8 permission names, `count` ≤
10,000 per flush, unknown entries dropped. Nothing secret (sealed boxes,
passphrases, PIN hash) is ever in the snapshot.

### 4.13 Web app permissions (PRD 24.1)

- **Editor** on the app page (`/apps/:id`, tab "Permissions"): the 8
  toggles of `webPermissions`, each with the PRD default shown, saved with
  `apps:setPermissions({ appId, permissions, expectedRevision })` (Admin),
  audit `app.permissionsChanged`. The change is ring-gated like any
  catalogue change (4.14).
- **Printing** is effective only when the app allows it **and** the
  device has at least one printer (`printing.available`); the Staff App
  checks both. New web apps default to `printing: true` (Section 19).
- **Counting.** The Staff App's existing per-app denial counter (Phase 3
  Step 15) is flushed over IPC (`webapp.reportDenials`); the agent sums
  per `(appId, kind)` into `security-today.json` and sends it in the daily
  security summary (4.19). The server's daily rollup (`security:rollup`
  cron) sums them into `orgSecurityDaily`. The app page shows "Blocked in
  the last 30 days: Microphone 41" from the last 30
  `orgSecurityDaily` rows (`.take(30)`), with a one-click "Allow
  microphone" that opens the editor with the toggle highlighted.
- **Never** recorded: the page URL, origin path, time of each request or
  the employee (rule 6). The count is per app per kind per day.

### 4.14 Rollout rings and rollback (PRD 24.3)

**Unit of rollout = a group configuration version.** Every edit that
changes a ring-gated input of a group (4.3 rule 6: app assignments, app
records used by the group, file handlers, lockdown settings, exceptions,
Wi-Fi and printer assignments) calls
`snapshotGroupConfig(ctx, groupId, reason)` (`convex/lib/groupConfig.ts`):

1. Build the group's ring-gated inputs from the live tables (the same
   loaders the Phase 4 publisher uses, moved into this function) into a
   `GroupConfig` JSON object, keys sorted, ≤ 262,144 bytes.
2. `contentHash` equal to the newest version's → write nothing.
3. Insert `groupConfigs { version: newest + 1 }`; prune versions
   `< newest − 19` that no pointer references (`.take(10)` per run).
4. Move pointers: rings **disabled** for the group → all three pointers =
   new version. Rings **enabled** → `pilot` = new version, `state =
   "rolling"`, `stageStartedAt = now`; `early` and `everyone` stay.
5. `requestPublish` for the devices whose ring pointer changed.

The publisher (Phase 4 4.4) builds each device document from
`groupConfigs[pointers[device.ring]]` plus the live non-gated keys, and
writes `config: { groupId, version, ring }`. A burst of edits within the
1.5 s publish delay produces one snapshot per edit but one publish.

**Rings.** `devices.ring` ∈ `pilot | early | everyone` (missing =
everyone), set on the device page or in bulk on the group page (Admin,
audit `device.ringChanged`). A group with rings enabled must have ≥ 1
pilot device, else enabling is refused (`no_pilot_devices`).

**Promotion** (`rollouts:promote({ groupId, to: "early"|"everyone", expectedRevision })`):
`early` = `pilot`, or `everyone` = `early`; the stage clock restarts;
audit `rollout.promoted`. **Promote all** sets both at once (asks for
confirmation in the UI).

**Ring health** (computed by `rollouts:health(groupId)` from
`deviceApplyReports.by_org_config` for the stage's version, `.take(1001)`):

| Count | Meaning |
|---|---|
| `applied` | report for this version with `state: applied` |
| `failed` | `refused`, `failed` or `rolledBack` for this version |
| `waiting` | ring devices without a report for this version (offline, not yet applied) |

**Automatic promotion** (off by default, Q6): a cron every 15 minutes
(`rollouts:tick`, reads `groupRollouts.by_state_stage` for `rolling`,
`.take(50)`) promotes a stage when `now − stageStartedAt ≥ bakeHours`
(default 24, range 1–168), `failed = 0` and `applied ≥ max(1, 50 % of
the ring)`. Waiting devices never block promotion forever (offline
laptops are normal) but do not count as success.

**Automatic halt:** when `failed / (applied + failed) ≥ maxFailurePct`
(default 10 %) **or** any pilot device reports `rolledBack`, the tick sets
`state: "halted"` with `haltReason`, stops promotions, audits
`rollout.halted`, and shows a red banner on the group page. Halting does
not roll back by itself unless the group's `autoRollback` flag is on
(default **on**, applies to the pilot ring only): then the pilot pointer returns to the
`early` version and the devices receive it as a new document version.

**Rollback** (`rollouts:rollback({ groupId, toVersion, rings, expectedRevision })`):
sets the chosen pointers to an older `groupConfigs` version that still
exists (the last 20); the publisher republishes those devices — old
content under a **new, higher** document version (Phase 4 4.4). Audit
`rollout.rolledBack`. "Rollback" on a group without rings sets all three
pointers.

**Devices offline during a rollout** receive whatever their ring's
pointer is when they reconnect; they never see an intermediate version.
**Two admins at once:** every rollout mutation takes `expectedRevision`
on `groupRollouts` → `stale_edit`.

**What rings do not cover:** Staff App and agent releases (PRD 23.6
channels), and non-gated keys (4.3 rule 6).

### 4.15 Wi-Fi and printers (PRD 24.2)

**Wi-Fi profiles**

- Admin enters SSID, security, passphrase (8–63 printable ASCII, or 64
  hex for WPA2), hidden, auto-connect, groups. The passphrase is accepted
  only by the **action** `wifi:setPassphrase` (randomness needed), which
  encrypts it with the organization's sealing key (4.18) and stores
  `{ keyId, sealed }`. No query returns it; the form shows "set on
  12 Oct" and a **Replace** button, never the value.
- **Per-device sealing.** The publisher cannot seal (mutations have no
  secure randomness). When a device's document needs a profile revision
  for which `deviceSealedSecrets` has no row with the device's current
  `sealKeyId`, the publisher schedules `internal.seal.forDevices`
  (action, batches of 25 devices) and publishes the device without that
  profile; the action unwraps the passphrase, seals it to the device's
  X25519 public key, writes the rows and requests a publish of those
  devices again. The second document carries the sealed box inside the
  signed payload.
- **Agent:** opens the sealed box with its device sealing key (DPAPI
  machine scope, `Secrets`), builds the WLAN profile XML (`WLANProfile`
  schema v1, `connectionMode` auto/manual, `nonBroadcast` for hidden,
  `sharedKey` with `keyMaterial` and `protected = false` — Windows encrypts
  it when the profile is stored), calls `wlan_set_profile` **for all
  users** (machine-wide, so it works before any sign-in), then zeroes the
  buffer. Profile name = `Rulebox-<profile id>` so Rulebox only ever
  touches its own profiles. Journal: `NotPresent` → removed on Disable.
- **Managed networks only** (`wifiManagedOnly`): the agent sets the WLAN
  allow/deny filter lists (permit each managed SSID, deny all others) —
  machine-wide, also for administrators, journalled and removed on
  Disable. Refused by the invariant check when `wifi` is empty (4.6,
  `managed_networks_empty`) or when the device's only current connection
  is a Wi-Fi network not in the list (`would_disconnect`); the second
  refusal is overridden only by the admin ticking "I understand this PC
  will go offline until it sees a managed network".
- **WPA3 on old adapters:** if the profile is refused by the driver, the
  state is `failed / detail: "security_unsupported"`; `wpa2Wpa3Personal`
  (transition mode) is the recommended choice and the form says so.
- 802.1X / EAP: not in Phase 5 (Q3).

**Printers**

- Kinds: `ipp` (`ipp://` or `https://…/ipp/print`), `raw` (TCP 9100 by
  default), `lpr` (queue name required), `share` (`\\server\queue`,
  connected per machine). Address validation: host is an IP literal or a
  DNS name (≤ 253), no credentials in the URL, ports 1–65535.
- **Drivers: only from the approved list**, and only drivers already in
  the Windows driver store or Windows Update **inbox** packages. Default
  list: `Microsoft IPP Class Driver`, `Microsoft PCL6 Class Driver`,
  `Microsoft PS Class Driver`, `Generic / Text Only`. An organization can
  add names of drivers the administrator pre-installs on the PCs
  (`orgSettings.approvedPrinterDrivers`); the agent installs a driver
  only with `InstallPrinterDriverFromPackage` from the local driver store,
  never from a print server (Point and Print downloads are a non-goal;
  machine policy `RestrictDriverInstallationToAdministrators = 1` stays on
  via L2). Missing driver → `failed / detail: "driver_missing"`.
- Shares: the agent connects them per machine; a server that offers a
  driver not on the list is refused (`driver_not_approved`).
- Printer name = `<display name> (Rulebox)`; the agent only deletes
  printers it created (journal `NotPresent`). Default printer per group:
  set in the Staff hive (`Software\Microsoft\Windows NT\CurrentVersion\Windows\Device`)
  and `LegacyDefaultPrinterMode = 1` for Staff, both journalled.
- **Spooler:** never disabled while `printers` is non-empty; the kiosk
  performance profile disables it only when `performance.noPrinting` is
  true **and** `printers` is empty (PRD 22.3).

### 4.16 Boot, Safe Mode and tamper protection (L7)

What Rulebox configures, and what it only reports:

| Item | Configured by the agent | Journalled | Report field (`deviceReports.security`) |
|---|---|---|---|
| Agent runs in Safe Mode | `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\{Minimal,Network}\RuleboxAgent` (default value `Service`) | yes (`NotPresent`) | `safeModeAgent: boolean` |
| Staff session kept out of Safe Mode | in Safe Mode the agent sets `AutoAdminLogon = "0"` for that boot only (in-memory flag, restored at the next normal boot) and audits `device.safeModeBlocked` when a Staff sign-in is attempted | Phase 2 Winlogon entries | — |
| Automatic failover to WinRE | BCD `{current}` `recoveryenabled = No` when `boot.autoRecovery = "off"` **and BitLocker does not protect the OS volume**; otherwise left as is | yes | `autoRecovery: "on"\|"off"` |
| Service security descriptor | `RuleboxAgent` DACL: SYSTEM and Administrators full; Interactive/Authenticated Users query-status only (no stop, no config) | yes (`Sddl`) | `serviceAcl: "ok"\|"drift"` |
| Service required privileges | the measured minimal list (Step 17; starting point `SeTcbPrivilege`, `SeAssignPrimaryTokenPrivilege`, `SeIncreaseQuotaPrivilege`, `SeSecurityPrivilege`, `SeBackupPrivilege`, `SeRestorePrivilege`, `SeTakeOwnershipPrivilege`, `SeDebugPrivilege`, `SeShutdownPrivilege`, `SeSystemProfilePrivilege`, `SeImpersonatePrivilege`, `SeChangeNotifyPrivilege`, `SeCreateGlobalPrivilege`, `SeLoadDriverPrivilege` only if CiTool needs it **(unverified)**) | yes | — |
| Folder ACLs | `%ProgramFiles%\Rulebox` (Administrators + SYSTEM full, Users read/execute) and `%ProgramData%\Rulebox\state` (Phase 2 DACL) checked every reconcile, repaired on drift | yes | `aclDrift: number` |
| Secure Boot | report only (`GetFirmwareEnvironmentVariable` / registry `SecureBoot\State`) | — | `secureBoot: "on"\|"off"\|"unsupported"` |
| BitLocker on OS volume | report only (`Win32_EncryptableVolume.ProtectionStatus`) | — | `bitLocker: "on"\|"off"\|"suspended"\|"unknown"` |
| TPM | report only (`Win32_Tpm`) | — | `tpm: "ready"\|"present"\|"absent"` |
| App Control active policies | report only (`list_ci_policies`) | — | `ciPolicies: string[]` (Rulebox ids only) |

`securityPosture` is written to `deviceReports` only when it changes
(rule 7). The device page shows a **Physical protection** card: green
only when Secure Boot on, BitLocker on, auto-recovery off, Safe Mode
agent registered; otherwise it lists what is missing with the sentence
"Someone with physical access and boot media can bypass software
controls on this PC" (rule 8). Rulebox never turns BitLocker on or sets
firmware passwords (non-goal).

**Clock rules.** Nothing security-relevant trusts the device clock:
signatures have no expiry (Phase 4), ring timing is server time,
broadcast expiry uses `issuedAtMs` + the agent's measured server offset.
A wall-clock jump of more than 10 minutes against the monotonic clock is
audited once (`device.clockJump`) and resets the offline-sign-in timer
the Phase 2 way.

### 4.17 Device lock and broadcasts (PRD 24.4)

**Lock.** `devices:lock({ deviceId, message, contact? })` (Admin) inserts
`deviceLocks` (`lockId` = the row's id; an existing lock is replaced),
audits
`device.locked`, publishes the device. `devices:unlock` deletes the row,
audits `device.unlocked`, publishes.

Agent behaviour while `deviceLock` is set (persisted in `AgentState`, so
it survives restarts and offline periods):

1. Ends the current employee session (`session.ended { reason: "revoked" }`
   is reused with the new reason `"deviceLocked"`, enum with `Unknown`).
2. Refuses every `session.signIn` with outcome `deviceLocked` (new
   outcome string; a 1.2 Staff App maps it to `Unknown` and shows the
   generic error).
3. The Staff App (1.3) shows the full-screen lock view on every monitor:
   organization name, logo, message, contact; no sign-in form. The hidden
   admin exit still works (rule 2).
4. After an admin exit and re-arm, the lock is still in force; only
   `devices:unlock` (a new document without `deviceLock`) clears it.
5. A lock never unlocks because the device is offline, revoked or the
   document is older; a revoked device stays locked (Phase 2 Q11).

**Broadcasts.** `broadcasts:send({ target, style, title, body, expiresAt?, ackRequired })`
(Admin; target a group or one device; ≤ 20 active per org), audit
`broadcast.sent`; publishes the target's devices. Each document carries
the **≤ 5 newest active** broadcasts for that device. `cancel` sets
`cancelledAt` and republishes. Expired broadcasts are dropped by the
publisher at the next publish and by the agent at display time.

- **Banner**: a strip at the top of the desktop, dismissible unless
  `ackRequired`. **Full screen**: covers the desktop until "OK".
- **Acknowledgements**: the agent stores acks locally and sends them in
  one `deviceApi:reportAcks({ acks: [{ broadcastId, atMs }] })` call per
  flush (on the next apply report or after 10 minutes, whichever comes
  first); one `broadcastAcks` row per device per broadcast; never the
  employee's identity (rule 6 spirit: the dashboard shows "acknowledged
  on 14 of 20 devices").
- No broadcast text is ever shown at the Windows sign-in screen (legal
  notice stays a compat blocker, Phase 2).

### 4.18 Keys and secrets

Phase 4 had one `RULEBOX_POLICY_KEY` per deployment. Rulebox is now one
shared deployment with many organizations, so **every organization gets
its own keys**, wrapped by a deployment master key. This must land
before the first outside tenant (Section 3.3).

| Secret | Created by | Stored | Only writer | Only reader |
|---|---|---|---|---|
| Deployment master key (32 bytes) | Operator, `scripts/master-key.mjs generate` | Convex env `RULEBOX_MASTER_KEY` (base64), optional `RULEBOX_MASTER_KEY_NEXT` | operator | `convex/lib/keyring.ts` |
| Org signing seed (Ed25519) | action `keys:createOrgKeys` (on org creation and for migration) | `orgKeys.wrapped` (XChaCha20-Poly1305, AAD = `orgId‖purpose‖keyId`) | `keyring.ts` | `keyring.ts` → `signing.ts` |
| Org sealing key (32 bytes, symmetric) | same action | `orgKeys` purpose `sealing` | `keyring.ts` | `keyring.ts` |
| Wi-Fi passphrase at rest | `wifi:setPassphrase` | `wifiProfiles.passphrase.sealed` (XChaCha20-Poly1305 under the org sealing key, AAD = `orgId‖profileId‖revision`) | that action | `seal.forDevices` |
| Device sealing key (X25519) | agent, at enrollment or first Phase 5 start | private: `Secrets` (DPAPI machine); public: `devices.sealPublicKey` | agent | agent |
| Per-device sealed passphrase | `seal.forDevices` | `deviceSealedSecrets.sealed`, then inside the signed document | that action | agent |

**Sealed box format `rulebox.seal/1`:** ephemeral X25519 key pair; shared
secret with the device public key; HKDF-SHA256 (salt = `epk ‖ devicePk`,
info = `"rulebox.seal/1|" + orgId + "|" + deviceId + "|wifi|" + profileId`)
→ 32-byte key; XChaCha20-Poly1305 with a random 24-byte nonce. JSON
`{ v: 1, keyId, epk, nonce, ct }`. Cross-language vectors in
`crates/rulebox-policy/tests/vectors/seal.json`; the binding to
`orgId`/`deviceId` makes a box copied to another device useless.

**Signing with org keys:** the publisher mutation unwraps the org's
signing seed (decryption needs no randomness, so it may run in a
mutation) and signs as in Phase 4. `policyKeys` (public halves, rotation
by endorsement) is unchanged.

**Migration of the existing organization** (`keys:migrateFromEnv`,
Owner, once): wraps the current `RULEBOX_POLICY_KEY` seed as that org's
signing key, so the key id does not change and **no device needs
re-enrollment**. After every organization has `orgKeys`, the env var is
removed and `signing.ts` refuses to read it.

**Master key rotation** (operator, rare): set `RULEBOX_MASTER_KEY_NEXT`;
`keys:rewrapAll` (internal action, 50 rows per run) re-wraps every
`orgKeys` row; then swap the env values. A lost master key means every
org key is lost: recovery is Phase 4's "key lost" path per organization
(new key, re-enroll). The operator keeps an offline copy; the README says
so.

**What this protects and what not:** per-organization keys stop a bug or
a data mix-up in one tenant from producing documents another tenant's
devices accept, and keep Wi-Fi passphrases unreadable in backups and
exports. They do **not** protect against the operator, who holds the
master key (Section 12).

### 4.19 Database I/O budget (writes per device per day)

Rule 7 in numbers. "Write" = one document insert/patch (Convex charges
database I/O for the bytes read and written, indexes included). Size
estimates include index entries. Phase 4's heartbeat is shown only as the
baseline; Phase 5 does not change it.

| Report | Trigger (never a timer alone) | Batching | Writes / device / day, steady | Audit-week (first 7 days of `audit`) | Worst case (cap) | Bytes / write |
|---|---|---|---|---|---|---|
| *Baseline: heartbeat → `deviceStatus` (Phase 4)* | *interval 5–60 min* | — | *24–288* | *same* | *288* | *~0.3 KB* |
| `deviceApplyReports` upsert | applied version / layer state / Wi-Fi or printer state changed | coalesce 30 s, ≤ 1 per 60 s, server skips equal hash | 0.3 | 1 | 24 (1/h cap on re-sends of the same version) | ~2 KB |
| `lockdownFindings` + `lockdownFindingDevices` | a **new** fingerprint on this device | ≤ 4 flushes/day, ≤ 50 fingerprints per flush; already-reported fingerprints are never re-sent | 0.1 | 10–30 | 400 (4 × 50 × 2) | ~0.6 KB |
| `deviceSecurityDaily` | at least one non-zero counter since the last flush | one call per server day, sent at the first apply report or heartbeat after 00:00 UTC | 0.3 (only days with blocks/denials) | 1 | 1 | ~1.5 KB |
| `auditLog` from devices (refused, rolled back, tamper, first drift per item per day, Safe Mode, clock jump) | event | rides the existing Phase 4 audit queue (≤ 50 per call) | 0.05 | 0.2 | 50 (Phase 4 queue cap per flush) | ~0.5 KB |
| `broadcastAcks` | employee pressed OK | with the next apply report or ≤ 10 min | 0.05 | 0.05 | 5 (≤ 5 active broadcasts) | ~0.3 KB |
| `deviceReports.security` / `capabilities` | posture changed | merged into the existing status report | 0.01 | 0.1 | 2 | ~1 KB |
| `devices.sealPublicKey` | once per device (and on seal-key rotation) | — | ~0 | 1 (once) | 1 | ~0.4 KB |
| **Phase 5 total** | | | **≈ 0.8** | **≈ 13–33** | bounded by caps | **≈ 1–2 KB/day steady** |

Server-side work caused by devices (amortized per device per day):
`security:rollup` reads each `deviceSecurityDaily` row once (≈ 0.3 reads)
and writes **one** `orgSecurityDaily` row per org per day; the ring
`tick` reads only `rolling` rollouts. Per-device document reads by the
subscription grow with document size: a typical Phase 5 document is
~6–12 KB; with 0.3 new versions a day that is ≈ 3 KB/device/day read,
plus the same written by the publisher. Rings add no extra publish per
device (each device receives a change once, when its ring gets it);
rollbacks add one.

**Fleet estimate:** 1,000 devices × (≈ 2 KB reports + ≈ 6 KB documents)
× 30 days ≈ **240 MB/month** of Phase 5 I/O on top of Phase 4, of which
the documents are the larger part. The audit week of a new 100-device
organization adds ≈ 100 × 30 × 0.6 KB × 7 ≈ 13 MB once. These are
estimates; Step 21 measures real document sizes on the VM and the
post-Phase-5 I/O pass owns the fleet-wide budget.

**Hard rules that keep it there:** no per-event row; no counter that is
patched on every block; no agent-side timer that writes when nothing
changed; the agent's one subscription is unchanged; dashboard screens
subscribe to aggregates (`orgSecurityDaily`, `deviceApplyReports` of the
listed devices), never to `lockdownFindingDevices`.

### 4.20 Dashboard screens

All screens follow Phase 4 4.13 (one query per screen, Solar `-linear`
icons, light/dark, 390 px layout, Viewers read-only).

| Route | Query (one per screen) | What it shows / does |
|---|---|---|
| `/groups/:id/lockdown` | `lockdown:groupView` | Layer cards L1–L7 with mode switches (`off`/`audit`/`enforce`), the App Control level, staff/machine toggles with plain-language help, USB, accessibility, keyboard; "Audit findings: 12 new" link; save → `lockdown:saveGroup({ expectedRevision })` |
| `/groups/:id/rollout` | `rollouts:groupView` | Rings toggle, pointer per ring with version + reason, health counts (4.14), Promote / Promote all / Rollback (version picker of the last 20), auto-promotion settings, halted banner with Resume |
| `/lockdown/findings` | `lockdown:findings` (paginated, `by_org_status_seen`) | "Would be blocked" grouped by program: file name, signer, folder class, layer, devices, last seen; actions **Allow for app…** (creates an exception, publisher rule preferred, hash fallback, path only for admin-only folders) and **Ignore** |
| `/networks` | `networks:list` | Wi-Fi profiles and printers with group chips; per-item apply status counts (applied / failed / waiting) |
| `/networks/wifi/:id`, `/networks/printers/:id` | `networks:wifiDetail`, `networks:printerDetail` | Forms (4.15); passphrase "Replace" dialog (calls the action); driver picker from the approved list |
| `/broadcasts` | `broadcasts:list` (paginated) | Send dialog (target, style, expiry, ack), active and past broadcasts with ack counts, Cancel |
| `/devices/:id` (extended) | `devices:detail` (extended join) | **Protection** card (posture, 4.16), **Lockdown** card (layer states from `deviceApplyReports`, LKG version, refusal reason in plain words), ring selector, **Lock device** / **Unlock** |
| `/apps/:id` (extended) | `apps:detail` (extended) | Permissions tab and 30-day denial counts (4.13) |
| `/settings/keys` (extended) | `keys:status` | Per-org keys status, "migrated from deployment key" note (Owner) |
| `/` overview (extended) | `overview:get` (extended) | Warnings: layers still in audit > 14 days, halted rollouts, devices with `restore_incomplete`, devices without physical protection, lockdown refused |

Text rules: every mode switch says what it does to employees and to
administrators ("App Control applies to everyone on this PC, including
administrators"); enforce switches open a confirmation that lists the
open findings count.

### 4.21 File layout (new and changed)

```
crates/rulebox-policy/src/{lockdown.rs,network.rs,notice.rs,seal.rs}      new
crates/rulebox-policy/tests/vectors/{lockdown.json,seal.json}             new
crates/rulebox-win32/src/{machinereg,staffreg,codeintegrity,applocker,service,
                          wlan,printing,bcd,etw,eventlog,posture}.rs       new
crates/rulebox-ipc/src/{types.rs,requests.rs,lib.rs}                      1.3 additions
crates/rulebox-desktop/src/winkey.rs                                      combination policy
apps/agent/src/journal.rs                                                 new (4.4)
apps/agent/src/lockdown/{mod,apply,invariants,staff,machine,allowlist,
                         applocker,appcontrol,procwatch,findings,lkg,boot,
                         tamper,perf}.rs                                   new
apps/agent/src/network/{wifi,printers}.rs                                 new
apps/agent/src/notice.rs                                                  device lock + broadcasts
apps/agent/policies/appcontrol/{recommended-blocks.xml,allowlist.xml}     sources (4.9)
apps/agent/build.rs                                                       embeds target\appcontrol\*.cip
scripts/appcontrol-build.ps1                                              XML → binary into target\ (Step 6)
scripts/master-key.mjs                                                    new (4.18)
convex/{lockdown,rollouts,networks,broadcasts,seal,security}.ts           new
convex/lib/{groupConfig,keyring,sealbox,lockdownValidators}.ts            new
convex/{schema,publish,deviceApi,devices,apps,keys,crons}.ts              extended
apps/dashboard/src/routes/{lockdown,rollout,networks,broadcasts}/…        new screens
apps/dashboard/src/data/{api.ts,types.ts,fixtures/*}                      hooks + demo fixtures
apps/staff-app/src/…/{DeviceLock,BroadcastBanner,BroadcastFullscreen}.tsx new views
apps/staff-app/src-tauri/src/webapp/permissions.rs                        flush counts over IPC
docs/plans/phase-5-vm-results.md                                          written in Steps 21–22
```

### 4.22 Dependencies

Checked at Step 1 against crates.io / npm; use the newest release that is
at least 14 days old in the major shown and record the exact versions.

| Package | Use | Note |
|---|---|---|
| `windows` 0.62 (existing) | new features: `Win32_System_Diagnostics_Etw`, `Win32_NetworkManagement_WiFi`, `Win32_Graphics_Printing`, `Win32_System_EventLog`, `Win32_System_Wmi`, `Win32_System_Services`, `Win32_NetworkManagement_NetManagement` | stay on 0.62 (Phase 2 risk table); all calls in `rulebox-win32` with `// SAFETY:` comments |
| `x25519-dalek` 2.x | device sealing key | `static_secrets` feature |
| `chacha20poly1305` 0.10.x | `XChaCha20Poly1305` | |
| `hkdf` 0.12.x | HKDF-SHA256 | `sha2` already in the workspace |
| `zeroize` 1.x | wipe passphrase buffers | probably already transitive |
| `quick-xml` (only if the AppLocker/WLAN XML writer needs escaping help) | XML output | prefer a small hand-written writer with an escaping test; add only if needed |
| `@noble/curves` 2.x, `@noble/ciphers` 2.x | X25519, XChaCha20-Poly1305 in Convex actions and the keyring | same author and audit lineage as `@noble/ed25519` (Phase 4) |

No ETW crate (own thin wrapper), no WMI crate (direct COM through
`windows`), no new dashboard UI library.

---

## 5. Steps

Machine column: **dev** = dev machine, safe (SimPlatform, convex-test,
Vitest, dashboard fixtures, file outputs under `target\` / `.tmp\`);
**VM** = the Hyper-V VM, **the user runs it**; nothing in a **dev** step
calls a mutating `Platform` method on real Windows.

| Step | What | Machine | Depends on | Touches | Checklist rows |
|---|---|---|---|---|---|
| 0 | Preflight, show Sections 19 and 20 | dev | — | nothing | — |
| 1 | Policy types: new agent-only keys, vectors, ts-rs | dev | Phase 4 Steps 9, 13 | `rulebox-policy`, `packages/types` | — |
| 2 | Journal v2, migration, apply transaction skeleton | dev | 1 | agent | — |
| 3 | Platform seam additions, `rulebox-win32` modules, guard coverage tests | dev | 2 | `rulebox-win32`, agent platform | — |
| 4 | L1 Staff policy catalogue + safety invariants validator | dev | 3 | agent, `rulebox-win32` (`staffreg`) | E-01..E-29, E-70..E-74 |
| 5 | L2 machine policies, admin tiles, wake, Safe Mode registration | dev | 4 | agent | E-01..E-09, E-60..E-69 |
| 6 | L4 App Control: policy sources, build-time conversion, deploy code | dev (conversion writes only `target\`) | 3 | agent, `scripts/` | E-30..E-39 |
| 7 | L3 AppLocker for the Staff SID; file-output printers | dev | 4, 6 | agent | E-20..E-39 |
| 8 | L5 procwatch | dev | 7 | agent, `rulebox-win32` (`etw`) | E-30..E-49 |
| 9 | Agent: findings, apply reports, daily summary, LKG | dev | 8 | agent | — |
| 10 | Server: schema, per-org keys, sealing, builder keys, device API | dev | 9, Phase 4 Steps 2, 8, 12 | `convex/`, `scripts/` | — |
| 11 | Web app permissions: editor and counts | dev | 10 | `convex/`, dashboard | E-40..E-49 |
| 12 | Staff App: IPC 1.3, Windows-key combinations, lock screen, broadcasts, denial flush | dev (demo + simulate) | 10, Phase 3 Step 19, Phase 4 Step 15 | `rulebox-ipc`, `rulebox-desktop`, Staff App | E-10..E-19, E-80..E-89 |
| 13 | Wi-Fi profiles (server, dashboard, agent) | dev | 10 | `convex/`, dashboard, agent | E-60..E-69 |
| 14 | Printers (server, dashboard, agent) | dev | 10 | `convex/`, dashboard, agent | E-20..E-29 |
| 15 | Device lock and broadcasts (server, dashboard, agent) | dev | 12 | `convex/`, dashboard, agent | E-80..E-89 |
| 16 | Rollout rings and rollback | dev | 10 | `convex/`, dashboard, agent (config report) | — |
| 17 | Tamper protection: service DACL, privileges, ACL self-check, clock | dev | 5 | agent | E-75..E-79 |
| 18 | Per-user tuning and kiosk performance profile | dev | 4 | agent | — |
| 19 | Dashboard: lockdown, findings, device protection, overview | dev | 11, 13–16 | dashboard, `convex/` queries | — |
| 20 | Agent: full restore (Disable, `unenroll`, `recover` v2), `lockdown-status` self-check | dev | 4–9, 13, 14, 17, 18 | agent | E-70..E-74 |
| 21 | VM run 1: apply, audit, enforce, rings, rollback, restore, budgets | **VM** | 1–20 | nothing new | — |
| 22 | VM run 2: escape checklist (Section 6) on Pro, Home if available | **VM** | 21 | nothing new | all |
| 23 | Wrap-up | dev | 22 | docs | — |

Rules for every step (Phase 4 rules apply, plus):

- Verify only what you touched: `cargo clippy -p <crate> --all-targets -- -D warnings`,
  `cargo test -p <crate>`, `pnpm test:convex`,
  `pnpm --filter @rulebox/dashboard typecheck|lint|test`,
  `pnpm --filter @rulebox/staff-app typecheck|lint|test`. Workspace-wide
  commands run in Step 23.
- **Never** run the agent as a service, deploy a policy, start an ETW
  session or call any mutating `Platform` method on the dev machine. The
  dev machine has no test-machine marker and must never get one.
- Convex: dev deployment only, `npx convex dev --once`; never
  `npx convex deploy`.
- UI steps are not done until you ran the screen and looked at it
  (screenshots of the app's own window or browser tab only, light and
  dark, 1280×800 and 390×844 for the dashboard; into `.tmp/phase5/`).
- No `unwrap()`/`expect()` outside tests; every new `unsafe` lives in
  `rulebox-win32` with a `// SAFETY:` comment and is listed in the report.
- Every new log line, audit summary and report field is checked against
  rule 6 (no command lines, titles, URLs, document names) and rule 5 (no
  secrets) by a test where the text is built.

---

### Step 0 — Preflight (stop if anything fails)

**Machine:** dev (read-only). **PRD:** —.

1. Record `rustc --version`, `node --version`, `pnpm --version`, free
   space on D: and C:, size of `target\`, `git status --short`,
   `git log --oneline -8`.
2. **Disk:** stop below **10 GB** free on D:. Tell the user the new
   crates (~100 MB built) and nothing else will be downloaded.
3. **Phase status:** read `docs/plans/README.md` and
   `git log --oneline --grep "Phase 4 step"` / `--grep "Phase 3 step 19"`.
   Record which of Phase 4 Steps 2, 8, 9, 10, 12, 13, 15 and Phase 3
   Step 19 are committed; write the list of Phase 5 steps that are blocked
   (Section 3.4) into "Updates since this plan was written".
4. Confirm the dev machine has **no** test-machine marker:
   `Test-Path 'HKLM:\SOFTWARE\Rulebox\TestMachine'` must be `False`. If it
   is `True`, stop and tell the user (do not delete it yourself).
5. Show the user Section 20 (open questions) and Section 19 (deviations)
   and wait. Record the answers here and in `docs/plans/README.md`.

**Done when:** all recorded; the user answered Section 20.
**Do NOT:** start any step whose prerequisites are missing; create or
remove the marker.

---

### Step 1 — Policy types: new agent-only keys

**Machine:** dev. **PRD:** 10, 24.1–24.4. **Files:**
`crates/rulebox-policy/src/{lib.rs,lockdown.rs,network.rs,notice.rs,seal.rs}`,
`crates/rulebox-policy/tests/{lockdown.rs,vectors/lockdown.json,vectors/seal.json}`,
`packages/types/src/generated/*` (via `pnpm gen:types`), `Cargo.toml`
(workspace deps of 4.22).

1. Add the types of 4.3 with serde `rename_all = "camelCase"`, defaults
   from 4.3, `unknown_on_new_values!` on every enum, ts-rs exports.
2. `AgentDoc` (the agent-only view, Phase 4) gains
   `lockdown: Option<LockdownPolicy>`, `wifi`, `wifi_managed_only`,
   `printers`, `device_lock`, `broadcasts`, `config`, all `#[serde(default)]`.
3. `LockdownPolicy::check_limits(&self) -> Result<(), LimitError>` with
   the limits of 4.3 rule 4; `ExceptionRule::validate` (exactly one of
   publisher/hash/path set to match `kind`; path templates use the Phase 4
   template grammar **and** must start with `{ProgramFiles}`,
   `{ProgramFilesX86}` or `{RuleboxApps}`; `layers` never contains
   App Control).
4. `seal.rs`: `open_sealed(box, device_secret, org_id, device_id, profile_id) -> Zeroizing<Vec<u8>>`
   and, for tests only, `seal(...)`. Vectors generated once by a Node
   script in `scripts/vectors/seal.mjs` with `@noble/curves` /
   `@noble/ciphers` and checked into `vectors/seal.json`.
5. Tests: defaults round-trip; unknown keys ignored by the Phase 4 parser
   (pins compatibility rule 1); unknown enum → `Unknown`; limits refused;
   vectors open; a box with a different `deviceId` fails.
6. `pnpm gen:types`; the generated TypeScript is committed.

**Verify:** `cargo clippy -p rulebox-policy --all-targets -- -D warnings`;
`cargo test -p rulebox-policy`; `pnpm gen:types`; `pnpm typecheck`.
**Done when:** all pass; `DesiredState` is byte-for-byte unchanged (a test
serializes the Phase 4 vector and compares).
**Do NOT:** add any field to `rulebox_policy::DesiredState`; put a secret
type into anything sent to the Staff App.

---

### Step 2 — Journal v2, migration, apply transaction skeleton

**Machine:** dev. **PRD:** 22.3 ("restore is exact"), 9.5. **Files:**
`apps/agent/src/{journal.rs,state.rs,kiosk.rs,recover.rs}`,
`apps/agent/src/lockdown/{mod.rs,apply.rs}`, `apps/agent/tests/journal.rs`.

1. `journal.rs` with the types of 4.4, `change()`, `restore_owner()`,
   `restore_all()`, `startup_recover()`.
2. `STATE_SCHEMA = 2`; `state::migrate` (v1 → v2, keep `state.v1.json`
   once); refuse unknown targets (`journal_unknown_target`).
3. Check `write_atomic`: temp file + `FlushFileBuffers` + rename with
   write-through. Add what is missing (through `rulebox-win32`).
4. Move `kiosk.rs`'s existing machine/Staff-hive writes onto
   `journal::change` with owner `Kiosk`, without changing behaviour
   (Phase 2 tests must still pass unchanged).
5. `lockdown::apply` skeleton: the order of 4.11 step 3 with every layer
   a no-op returning `LayerState { state: "ok", mode: "off" }`.
6. Tests (SimPlatform): migration of a real Phase 2 VM state file
   (anonymized fixture); crash injection after each of the three write
   steps (SimPlatform fault points) → `startup_recover` restores the
   original; reverse-order restore; failed restore stays `Restoring` and
   is retried; never records a Rulebox-written value as original.

**Verify:** `cargo clippy -p rulebox-agent --all-targets -- -D warnings`;
`cargo test -p rulebox-agent`.
**Done when:** all Phase 2 agent tests pass unchanged plus the new ones.
**Do NOT:** delete `state.v1.json` handling; change the Phase 2 recovery
semantics for `kiosk` entries.

---

### Step 3 — Platform seam additions and guard coverage

**Machine:** dev (compiles Win32 code; calls none of it). **PRD:** 12.2.
**Files:** `apps/agent/src/platform/{mod.rs,sim.rs,windows.rs}`,
`crates/rulebox-win32/src/{lib.rs,machinereg.rs,staffreg.rs,codeintegrity.rs,applocker.rs,service.rs,wlan.rs,printing.rs,bcd.rs,etw.rs,eventlog.rs,posture.rs,security.rs}`,
`apps/agent/tests/guard_coverage.rs`, `crates/rulebox-win32/tests/guard_coverage.rs`.

1. Add the methods of 4.5 to the trait, `SimPlatform` (in-memory, with
   fault injection and a call log) and `WindowsPlatform`.
2. Each new mutating `rulebox-win32` function: guard first, then the
   root allow-list check where one applies, then the Win32 call.
3. `MUTATING_METHODS` constant + the two text-scanning coverage tests of
   4.5 rule 1; an allowed-roots test per registry module (a write outside
   the roots returns `Forbidden` without touching anything; uses a fake
   handle layer, no real registry).
4. Read-only functions that are safe to run on the dev machine
   (`read_security_posture`, `list_ci_policies`, `get_applocker_policy`,
   `wlan_list`, `printer_list`, `read_event_log`) get `#[ignore]`d smoke
   tests that the user may run by hand; they never write.

**Verify:** `cargo clippy -p rulebox-win32 -p rulebox-agent --all-targets -- -D warnings`;
`cargo test -p rulebox-win32 -p rulebox-agent`.
**Done when:** coverage tests pass and fail when a guard line is removed
from a scratch copy (show the failing output, then restore).
**Do NOT:** run any `#[ignore]`d test yourself; add a bypass of any kind.

---

### Step 4 — L1 Staff policy catalogue and the safety invariants

**Machine:** dev. **PRD:** 12.2, 12.4, 13.1, 9.5. **Files:**
`apps/agent/src/lockdown/{staff.rs,invariants.rs}`,
`crates/rulebox-win32/src/staffreg.rs`, `apps/agent/tests/{l1.rs,invariants.rs}`.

1. `staff.rs`: the table of 4.7 as data (`const STAFF_ITEMS: &[StaffItem]`),
   apply/restore through `journal::change` with owner `L1`;
   accessibility flags are computed from the original value (only the
   hotkey bit changes) and the original string is journalled.
2. `invariants.rs`: I1–I9 of 4.6 with `facts` from read-only seam
   methods; refusal codes as in the table.
3. Hook `validate` into `lockdown::apply` before step 3 of 4.11.
4. Tests: each item on/off/on again is idempotent; restore returns the
   exact original (absent, DWORD, string); hive not loaded → mounted
   (SimPlatform); every refusal code reachable; a document that sets
   `hideAdminTiles` without the E-71 flag is refused.

**Verify:** `cargo clippy -p rulebox-agent -p rulebox-win32 --all-targets -- -D warnings`;
`cargo test -p rulebox-agent -p rulebox-win32`.
**Done when:** all pass; the invariant table test covers every catalogue
item × mode.
**Do NOT:** write any value outside `staffreg::ALLOWED_ROOTS`; add an
item not in 4.7. Checklist rows owned: E-01..E-29, E-70..E-74.

---

### Step 5 — L2 machine policies, admin tiles, wake, Safe Mode registration

**Machine:** dev. **PRD:** 12.2, 13.6 #8, 13.1. **Files:**
`apps/agent/src/lockdown/{machine.rs,boot.rs}`,
`crates/rulebox-win32/src/{machinereg.rs,accounts.rs,bcd.rs,posture.rs}`, tests.

1. `machine.rs`: the table of 4.8 as data; account lockout through
   `set_account_lockout` with the original journalled
   (`LockoutPolicy`); admin tiles for each enabled local administrator
   found by SID (`S-1-5-32-544` membership), never by name.
2. `boot.rs`: SafeBoot registration (Minimal + Network), the Safe Mode
   behaviour of 4.16 (detect Safe Mode from
   `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Option\OptionValue`,
   read-only, which works inside a service),
   `autoRecovery` with the BitLocker rule, posture reader.
3. Disconnected Staff sessions: keep the Phase 2 rule.
4. Tests: every item journalled and restored; lockout threshold < 5
   refused; BitLocker on → `autoRecovery` left alone; Safe Mode start →
   auto sign-in held off for that boot only and restored after; posture
   values map to the report enum.

**Verify / Done when:** as Step 4.
**Do NOT:** change BCD when BitLocker protects the OS volume; touch an
account by display name. Rows owned: E-01..E-09, E-60..E-69.

---

### Step 6 — L4 App Control: policy sources, build-time conversion, deploy code

**Machine:** dev — the conversion only writes files under `target\`;
deployment code is compiled and unit-tested against SimPlatform, never
run. **PRD:** 12.2, 13.6 #2. **Files:**
`apps/agent/policies/appcontrol/{recommended-blocks.xml,allowlist.xml}`,
`scripts/appcontrol-build.ps1`, `apps/agent/build.rs`,
`apps/agent/src/lockdown/appcontrol.rs`,
`crates/rulebox-win32/src/codeintegrity.rs`, tests.

1. Policy XML sources (4.9) with fixed GUIDs and a version number;
   copy Microsoft's recommended block rules from the source page into
   `recommended-blocks.xml` with the date and URL in a comment.
2. `appcontrol-build.ps1`: for each XML and each variant (audit /
   enforce), set the audit option, run `ConvertFrom-CIPolicy` to
   `target\appcontrol\<GUID>.<variant>.cip`, print SHA-256. It refuses
   any output path outside `target\`. If `ConfigCI` is missing, stop and
   record (Section 13).
3. `build.rs` embeds the four binaries and their hashes; a build without
   them fails with a message naming the script (no silent fallback).
4. `appcontrol.rs`: decide which policies should be active from
   `appControl.mode`/`level`; deploy/remove through the journal (owner
   `L4`, target `CiPolicy`); detect restart needs; report state.
5. Tests: XML lint (well-formed, expected GUIDs, Rulebox folder allowed
   in the allowlist policy); decision table mode × level × OS build;
   never touches a GUID it did not deploy.

**Verify:** run `scripts/appcontrol-build.ps1` (writes only
`target\appcontrol\`); `cargo test -p rulebox-agent`; clippy.
**Done when:** four `.cip` files exist under `target\appcontrol\`, the
agent embeds them, tests pass.
**Do NOT:** run CiTool or copy a policy anywhere on the dev machine; sign
a policy; add driver rules beyond Microsoft's list. Rows: E-30..E-39.

---

### Step 7 — L3 AppLocker for the Staff SID; file-output printers

**Machine:** dev. **PRD:** 12.2, 13.1, 13.2. **Files:**
`apps/agent/src/lockdown/{allowlist.rs,applocker.rs}`,
`crates/rulebox-win32/src/{applocker.rs,printing.rs}`,
`apps/agent/tests/{allowlist.rs,applocker_golden.rs}`,
`apps/agent/tests/golden/applocker/*.xml`.

1. `allowlist.rs`: the model of 4.9, writable-folder scan (from a
   SimPlatform DACL fixture in tests), `STAFF_DENY_WINDOWS_BINARIES` with
   a comment per entry.
2. `applocker.rs`: deterministic XML (4.9 rules 1–5), both mechanisms,
   AppIDSvc start type journalled, foreign-policy detection
   (`applocker_foreign_policy`).
3. File-output printers: deny Staff "Print" by printer security
   descriptor (4.8), identified by port type; journal the original SDDL.
4. Golden tests: default settings, every mode, with/without exceptions,
   with accessibility on; each golden file is checked by the invariant
   test (Rulebox folders, WebView2, Administrators allow-all present);
   no path rule under a writable folder.

**Verify / Done when:** as Step 4, plus golden files reviewed in the report.
**Do NOT:** enable the DLL collection; target any SID other than Staff
with a restrictive rule. Rows: E-20..E-39.

---

### Step 8 — L5 procwatch

**Machine:** dev (ETW code compiled; tests use recorded synthetic events).
**PRD:** 13.6 #2, 22.4. **Files:** `apps/agent/src/lockdown/procwatch.rs`,
`crates/rulebox-win32/src/etw.rs`, `apps/agent/tests/procwatch.rs`.

1. ETW session wrapper (start, consume on a dedicated thread, stop on
   service stop and on `off`), lost-event counter, snapshot fallback.
2. Matcher over the compiled `AllowList` with the signature cache of
   Section 14; never-terminate list checked first.
3. `audit`/`enforce` behaviour of 4.10; `program.blocked` event.
4. Tests: synthetic start events for Staff/non-Staff SIDs, allowed and
   not allowed paths, renamed copies, never-terminate entries; burst of
   1,000 events within the CPU budget (bench); termination call carries
   the expected image and SID.

**Verify / Done when:** as Step 4, bench numbers in the report.
**Do NOT:** start an ETW session in any test; read command lines.
Rows: E-30..E-49.

---

### Step 9 — Agent: findings, apply reports, daily summary, LKG

**Machine:** dev. **PRD:** 24.3, 11.1. **Files:**
`apps/agent/src/lockdown/{findings.rs,lkg.rs,apply.rs}`,
`apps/agent/src/convex/reports.rs`, tests.

1. Findings collector from event logs (fixtures) and procwatch; local
   store and flush rules (4.19); privacy test (rule 6).
2. Apply report with coalescing and hash-based skip; daily summary with
   server-day bucketing; Phase 4 audit queue for device events.
3. LKG store, health window from `ui_alive`, crash-loop detection from
   the launcher watchdog, owner-scoped restore, refused-config list.
   The Staff App's `--simulate-crash-loop` flag (used by Step 21) exists
   only in debug builds.
4. Drift detection with the "fighting" guard (4.11).
5. Tests: a lockdown change followed by 3 simulated crashes → LKG
   restore, `rolledBack` report; no `ui_alive` while no Staff session →
   no rollback; Convex unreachable → files grow to the caps, then send;
   drift counted once per target per day in the audit.

**Verify / Done when:** as Step 4.
**Do NOT:** send a report on a timer when nothing changed; include a
path, title or command line in any report.

---

### Step 10 — Server: schema, per-org keys, sealing, builder keys, device API

**Machine:** dev. **PRD:** 10, 11.1, 12.3, 24.2. **Files:**
`convex/schema.ts`, `convex/lib/{keyring,sealbox,lockdownValidators,groupConfig,desired,publish,signing}.ts`,
`convex/{keys,lockdown,seal,security,deviceApi,devices,crons}.ts`,
`scripts/master-key.mjs`, `convex/convex.config.ts` (env
`RULEBOX_MASTER_KEY`, `RULEBOX_MASTER_KEY_NEXT`, both optional),
`convex/*.test.ts`.

1. Schema: tables and field changes of 4.2, widen-only (every new field on
   an existing table `v.optional`). `statusValidator` gets `security` and
   `capabilities` first.
2. `keyring.ts`: `unwrapOrgKey(ctx, orgId, purpose)` (mutation-safe),
   `createOrgKeys` (action), `rewrapAll` (internal action, 50 per run);
   `keys:migrateFromEnv` (Owner, once). `signing.ts` signs with the org
   key; it reads `RULEBOX_POLICY_KEY` only inside `migrateFromEnv`.
3. `sealbox.ts`: `sealForDevice` (action-only; vectors from Step 1 run
   in convex-test) and `encryptAtRest` / `decryptAtRest`.
4. `groupConfig.ts`: `snapshotGroupConfig` (4.14 steps 1–3; pointers all
   move until Step 16 adds rings). Every Phase 4 mutation that changed a
   group-level input now calls it before `requestPublish`.
5. Builder (`desired.ts`): new keys in the order of 4.3, from the group
   config + live `deviceLocks` / `broadcasts`; size limits; vectors shared
   with Rust (`vectors/lockdown.json`).
6. Device API: `deviceApi:reportApply`, `reportFindings` (≤ 50
   fingerprints; upserts `lockdownFindings` by `by_org_fingerprint`,
   inserts `lockdownFindingDevices` only when new), `reportSecurityDaily`
   (one row per device per server day; a second call the same day merges
   by adding), `reportAcks`, `registerSealKey({ publicKey })` (accepted
   once, or when the agent proves the old key: Step 13 test). All use
   Phase 4 device auth and rate limits (`deviceReports` bucket: 60/hour
   per device).
7. Crons: `security:rollup` (daily 01:00 UTC, paginates
   `deviceSecurityDaily.by_org_day` for yesterday, 200 rows per run,
   reschedules), retention for `deviceSecurityDaily` (14 d),
   `orgSecurityDaily` (90 d), `lockdownFindingDevices` of removed devices.
8. Tests (convex-test): cross-org isolation for every new function;
   writes-per-call counted with a test helper that wraps `ctx.db` and
   asserts the 4.19 caps (e.g. `reportApply` with an unchanged hash writes
   0 documents); a document signed for org A fails verification with org
   B's key (Rust vector); migration keeps the key id.

**Verify:** `npx convex dev --once`; `pnpm test:convex`; `pnpm typecheck`; `pnpm lint`.
**Done when:** all pass; the write-count tests prove every device report
writes nothing when nothing changed.
**Do NOT:** log or return any `wrapped`, `sealed` or passphrase value;
generate randomness in a query or mutation; touch another session's
uncommitted files.

---

### Step 11 — Web app permissions: editor and counts

**Machine:** dev. **PRD:** 24.1. **Files:** `convex/apps.ts`,
`convex/security.ts`, `apps/dashboard/src/routes/apps/…`,
`apps/dashboard/src/data/*`, tests.

1. `apps:setPermissions` (Admin, `expectedRevision`, audit,
   `snapshotGroupConfig` for each group that has the app, then publish).
2. New web apps default `printing: true`; existing rows unchanged.
3. `apps:detail` adds `denials30d: [{ kind, count }]` from
   `orgSecurityDaily` (`.take(30)`, filtered to the app in memory).
4. Permissions tab (4.13): eight toggles with PRD defaults shown, the
   printing note ("works only on devices with printers"), the 30-day
   counts with "Allow" shortcuts.
5. Tests: Viewer cannot save; stale edit; counts sum correctly across
   days; fixtures for demo mode.

**Verify:** `pnpm test:convex`; dashboard `typecheck|lint|test`; run the
dashboard and screenshot the tab (light/dark, 1280 and 390).
**Done when:** the tab works against fixtures and the dev deployment.
**Do NOT:** record origins, URLs or employees with a denial.

---

### Step 12 — Staff App: IPC 1.3, Windows-key combinations, lock screen, broadcasts

**Machine:** dev (demo mode and the simulated agent). **PRD:** 12.2,
24.1, 24.4, 25. **Files:** `crates/rulebox-ipc/src/{lib.rs,types.rs,requests.rs}`,
`crates/rulebox-desktop/src/winkey.rs`, `apps/agent/src/ipc/*` (1.3
handlers), `apps/staff-app/src-tauri/src/{webapp/permissions.rs,ipc/*}`,
`apps/staff-app/src/…/{DeviceLock,BroadcastBanner,BroadcastFullscreen}.tsx`,
tests.

1. IPC 1.3 per 4.12 (`PROTOCOL_MINOR = 3`); compatibility tests with
   recorded 1.1 and 1.2 client transcripts.
2. `winkey.rs`: when `keyboard.winCombos = swallow`, the helper swallows
   key events that form a Windows-key combination and still opens
   Rulebox's Start on a lone Windows key (P7). The admin exit hotkey can
   never contain the Windows key (Phase 4 grammar), so the two cannot
   collide; a test pins this. `pass` keeps the Phase 3 behaviour.
3. Lock view: full screen on every monitor (P13 blank monitors get the
   same plain lock surface), organization name, message, contact; no
   sign-in field; the hidden exit stays active. Lite mode: no blur;
   reduced motion honoured; GSAP only through `lib/motion.ts`.
4. Broadcast banner and full-screen notice with "OK"
   (`broadcast.acknowledge`); text rendered as plain text, never HTML.
5. Permission denial counter flush (60 s and at sign-out).
6. Tests: snapshot handling for lock on/off while signed in (session
   ends, view appears); a 1.2 agent (simulated) → no lock view, no
   errors; banner text with HTML characters is shown literally; motion
   cleanup on unmount.

**Verify:** `cargo test -p rulebox-ipc -p rulebox-desktop -p rulebox-agent`;
`pnpm --filter @rulebox/staff-app typecheck|lint|test`; run
`pnpm dev:staff` in demo mode and screenshot lock, banner and full-screen
notice (light, dark, Lite).
**Done when:** all pass and the screenshots look right.
**Do NOT:** install the hook system-wide outside the Staff session
helper; add any way to dismiss the lock other than the admin exit and an
unlock document.

---

### Step 13 — Wi-Fi profiles

**Machine:** dev (agent code against SimPlatform; WLAN calls run only in
Step 21). **PRD:** 24.2, 12.3. **Files:** `convex/networks.ts`,
`convex/seal.ts`, `apps/dashboard/src/routes/networks/…`,
`apps/agent/src/network/wifi.rs`, `crates/rulebox-win32/src/wlan.rs`,
tests.

1. Server: `networks:saveWifi` (no passphrase; `expectedRevision`),
   action `wifi:setPassphrase`, `networks:deleteWifi`; group assignment
   triggers `snapshotGroupConfig`; publisher + `seal.forDevices` flow of
   4.15 (second publish carries the box).
2. Agent: device sealing key created on first Phase 5 start
   (`x25519-dalek`, private key in `Secrets`), `registerSealKey` once;
   profile XML writer with an XML-escaping test (SSID with `&`, `<`,
   quotes, non-ASCII); hidden networks; profile name `Rulebox-<id>`;
   journal `NotPresent`; managed-only filters with the 4.6 checks.
3. Passphrase handling: `Zeroizing` buffers; the XML string holding the
   key is built and passed in one function and zeroized after the call;
   nothing logged (a test scans log output of a full apply for the test
   passphrase).
4. Dashboard: list and form (4.20), Replace-passphrase dialog, apply
   counts.
5. Tests: sealing round-trip TS → Rust; device without `sealPublicKey`
   gets no profile and a `waiting_for_key` state; profile revision change
   reseals; deleting a profile removes it from documents and the agent
   deletes it; managed-only with an empty list is refused.

**Verify:** `pnpm test:convex`; `cargo test -p rulebox-agent -p rulebox-win32`;
dashboard checks + screenshots.
**Done when:** all pass; the log-scan test passes.
**Do NOT:** return a passphrase from any query; write a profile for
"current user"; touch profiles not named `Rulebox-*`.

---

### Step 14 — Printers

**Machine:** dev. **PRD:** 24.2, 22.3. **Files:** `convex/networks.ts`,
`apps/dashboard/src/routes/networks/…`, `apps/agent/src/network/printers.rs`,
`crates/rulebox-win32/src/printing.rs`, tests.

1. Server: `networks:savePrinter` / `deletePrinter`, address validation
   (4.15), driver must be in the approved list.
2. Agent: create port + printer (IPP via the IPP class driver, raw TCP,
   LPR), per-machine share connections, driver only from the local store,
   `(Rulebox)` suffix, default printer per Staff hive (journalled),
   identify Rulebox printers by a stored id in the printer comment field
   rather than by name (renamed printers still match).
3. Spooler rule: never disabled while printers exist (Step 18 reads this).
4. Dashboard form with driver picker and the "driver must already be on
   the PC" note.
5. Tests: unknown driver refused on both sides; journal restores; a
   printer that already existed with the same name is left alone
   (`name_taken`).

**Verify / Done when / Do NOT:** as Step 13; never install a driver from
a print server or the network.

---

### Step 15 — Device lock and broadcasts

**Machine:** dev. **PRD:** 24.4. **Files:** `convex/{devices,broadcasts}.ts`,
`apps/dashboard/src/routes/{devices,broadcasts}/…`,
`apps/agent/src/notice.rs`, tests.

1. Server functions of 4.17, audit, publish; ≤ 5 active broadcasts per
   document, newest first; expiry filtered at publish.
2. Agent: persisted lock (`AgentState.device_lock`), session end, sign-in
   refusal `deviceLocked`, lock survives restart/offline/revocation;
   broadcast list with expiry by server-offset time; ack queue and
   `reportAcks`.
3. Dashboard: Lock / Unlock on the device page with message and contact
   fields and a preview; Broadcasts screen.
4. Tests: lock while an employee is signed in (SimPlatform: session ended,
   sign-in refused); unlock clears; admin exit during lock → re-arm →
   still locked; offline device keeps the lock; broadcast expiry with a
   device clock 2 days wrong (server offset used); ack once per device.

**Verify:** `pnpm test:convex`; `cargo test -p rulebox-agent`; dashboard
checks + screenshots.
**Done when:** all pass.
**Do NOT:** add remote wipe, remote screenshots or location (non-goals).

---

### Step 16 — Rollout rings and rollback

**Machine:** dev. **PRD:** 24.3, 10. **Files:** `convex/{rollouts,crons,publish}.ts`,
`convex/lib/groupConfig.ts`, `apps/dashboard/src/routes/groups/…/rollout`,
`apps/agent/src/lockdown/lkg.rs` (config refusal list), tests.

1. `groupRollouts`, ring field, pointer logic, promote / promote all /
   rollback / resume, health query, `rollouts:tick` cron (4.14).
2. Publisher uses the ring pointer; documents carry `config`.
3. Agent: reports `config` in `reportApply`; keeps a local list of
   refused config versions (4.11 step 3) bounded to 20 entries.
4. Dashboard rollout tab (4.20).
5. Tests: change goes to pilot only; promote moves early; auto-promotion
   respects bake time and minimum applied; halt at the failure threshold
   and on a pilot `rolledBack`; auto-rollback of pilot; rollback produces a
   higher document version with old content; offline device receives its
   ring's current pointer on reconnect; two admins → `stale_edit`;
   non-gated keys (lock, broadcast, employees) reach every ring at once.

**Verify:** `pnpm test:convex`; `cargo test -p rulebox-agent`; dashboard
checks + screenshots.
**Done when:** all pass.
**Do NOT:** ring-gate locks, broadcasts, employees or keys; delete a
`groupConfigs` version that a pointer references.

---

### Step 17 — Tamper protection: service DACL, privileges, ACL self-check, clock

**Machine:** dev. **PRD:** 12.1, 12.2 ("Protected agent"), 13.5.
**Files:** `apps/agent/src/lockdown/tamper.rs`, `apps/agent/src/service.rs`,
`crates/rulebox-win32/src/{service.rs,security.rs}`, tests.

1. Service DACL of 4.16 (journalled `Sddl`), required-privileges list as
   a constant with the starting list of 4.16 and a TODO for the Step 21
   measurement; applied at service install (Phase 2 path) and
   re-asserted each reconcile.
2. ACL self-check for `%ProgramFiles%\Rulebox` and the state folder;
   repair on drift; `device.tamperDetected` audit once per item per day.
3. Clock-jump detection (4.16) using the monotonic clock.
4. Tests: DACL string matches the expected SDDL; drift → repair →
   counted; a privilege list missing `SeChangeNotifyPrivilege` is
   refused by a unit check (the service would not start).

**Verify / Done when:** as Step 4.
**Do NOT:** make the service unstoppable for Administrators (they need it
for `recover` and Phase 6 upgrades); claim protection against an
administrator. Rows: E-75..E-79.

---

### Step 18 — Per-user tuning and kiosk performance profile

**Machine:** dev. **PRD:** 22.2, 22.3 (Q11). **Files:**
`apps/agent/src/lockdown/perf.rs`, tests.

1. Staff tuning (22.2), Staff hive only: startup entries for Staff
   removed (journalled), background apps off, widgets/Copilot/tips off
   by user policy, visual effects to "best performance" values.
2. Kiosk profile (22.3), machine-wide while the kiosk is on: Windows
   Search, SysMain, Xbox services start type `disabled`; diagnostic data
   to the minimum the edition allows; Delivery Optimization peer sharing
   off; Spooler only with `noPrinting` and no printers (4.15). Defender
   and Windows Update untouched.
3. All through the journal; restored on Disable.
4. Tests: each service's original start type restored exactly; Spooler
   rule; nothing touches Defender or Windows Update services (a test
   checks the service list).

**Verify / Done when:** as Step 4.
**Do NOT:** stop a service the admin needs for recovery (RPC, event log,
WinRM if enabled, Code Integrity); change Defender or Update settings.

---

### Step 19 — Dashboard: lockdown, findings, device protection, overview

**Machine:** dev. **PRD:** 3.1, 12.2, 24.3. **Files:**
`convex/lockdown.ts` (queries/mutations of the screens),
`apps/dashboard/src/routes/{groups/lockdown,lockdown/findings,devices,overview}/…`,
`apps/dashboard/src/data/{api.ts,types.ts,fixtures/*}`, tests.

1. Screens of 4.20 that earlier steps did not build: group lockdown tab,
   findings review (Allow for app… / Ignore), device Protection and
   Lockdown cards, overview warnings.
2. Allow-for-app dialog: proposes publisher rule first, hash second,
   path only for admin-only folders; shows "breaks on update" for hash
   rules; creates `lockdownExceptions` and marks the finding `allowed`.
3. Enforce confirmation dialogs with open findings count and the "applies
   to administrators" sentence for App Control.
4. Fixtures for demo mode covering every layer state and refusal code.
5. Tests: Viewer read-only; refusal codes mapped to sentences (one test
   per code); findings pagination.

**Verify:** `pnpm test:convex`; dashboard `typecheck|lint|test`;
screenshots of every new screen (light/dark, 1280/390).
**Done when:** all pass and the screenshots look right.
**Do NOT:** show full paths or command lines (they never reach the
server).

---

### Step 20 — Agent: full restore and `lockdown-status`

**Machine:** dev. **PRD:** 9.5, 13.5 ("removing Rulebox fully
restores"). **Files:** `apps/agent/src/{recover.rs,kiosk.rs,cli.rs}`,
`apps/agent/src/lockdown/status.rs`, `scripts/vm/export-baseline.ps1`
(read-only export used in Step 21), tests.

1. Disable kiosk, `unenroll` and `recover` restore every journal target
   type of 4.4 (owner by owner, reverse order), including App Control,
   AppLocker, WLAN, printers, services, BCD, account policy, SafeBoot.
2. `recover` works offline, without Convex, from the state folder alone;
   it prints each entry's result.
3. `rulebox-agent lockdown-status` (administrator, read-only): expected
   vs actual per layer, invariant self-check, journal summary, posture.
4. `export-baseline.ps1`: read-only export of the registry roots of 4.7
   and 4.8, service start types, active CI policy ids, AppLocker policy
   XML, WLAN profile names, printers, BCD `{current}` — to a file the user
   names. It writes nothing else.
5. Tests: SimPlatform full cycle enable → enforce → disable leaves the
   simulated system identical to the start (deep compare); `recover` on a
   journal with entries in every phase.

**Verify / Done when:** as Step 4; the deep-compare test passes.
**Do NOT:** run `export-baseline.ps1` or `lockdown-status` on the dev
machine as part of verification beyond `-WhatIf`-style help output. Rows:
E-70..E-74.

---

### Step 21 — VM run 1: apply, audit, enforce, rings, rollback, restore (the user runs it)

**Machine:** **VM only** (`rulebox-test-pro`, Windows 11 Pro), started
from its clean checkpoint; the marker there was created by the user in
Phase 2. **The user runs every command;** the implementing agent prepares
the checklist file `docs/plans/phase-5-vm-results.md` (sections and empty
result cells) and the build, and reads the results afterwards.

Preparation (dev machine, safe): a debug build of the agent and Staff App
copied to the VM by the user (Phase 2 procedure); the dev Convex
deployment with one org migrated to per-org keys, one group with rings
enabled, two VM-side devices if a second VM exists (else one device in
pilot).

Runs (each records pass/fail, timing, and the screen or log evidence):

1. **Apply in audit.** Enroll, default lockdown (all layers `audit`).
   Record: every layer `ok` on the device page; journal entry count;
   `lockdown-status` output (Step 20) all green; payload size in bytes.
2. **Findings.** Use the allowed apps for 15 minutes as an employee would;
   record the findings list; allow one by publisher rule, ignore one.
3. **Enforce through rings.** Switch L3, L4, L5 to `enforce` in pilot;
   record the CiTool / restart behaviour per edition (4.9); confirm the
   Staff App, WebView2 apps and the catalogue apps still start.
4. **LKG.** Publish a deliberately broken exception set prepared for the
   test (it removes the WebView2 runtime from the Staff allow-list in a
   pilot-only config: the validator must **refuse** it — record
   `would_block_rulebox`); then a config that the validator accepts but
   that makes the shell unhealthy in a way the test prepares (Staff App
   build flag `--simulate-crash-loop`): record rollback within the window
   and the halt on the dashboard.
5. **Rollback** to an earlier version from the dashboard; record the new
   version number and the restored state.
6. **Wi-Fi / printers** (Hyper-V has no Wi-Fi adapter: record WLAN as
   `unsupported` cleanly; printers with a raw TCP printer pointing at a
   non-existent IP: record `ok` creation and removal).
7. **Safe Mode** boot: agent running, Staff sign-in kept out, audit row.
8. **Restore.** Disable kiosk from the dashboard → every journal entry
   restored; compare a registry/services/policy export taken before
   enrollment with one after (the user runs the export script
   `scripts/vm/export-baseline.ps1`, read-only); record differences (must
   be none except Rulebox's own folders and the Staff account).
9. **Recover.** Re-enable, then `rulebox-agent recover` as administrator
   offline (network off); same comparison.
10. **Budgets:** agent working set (idle, during apply), CPU during a
    100-process start burst (procwatch), ETW buffer losses, document sizes,
    writes per report observed in the Convex dashboard's function logs.
11. The Phase 2 re-check items still open (exit-hold timing, kill-on-close
    job, `recover` for LSA owners).

**Done when:** every row has a result; failures are written up with
evidence; the user reverts the VM to its checkpoint afterwards.
**Do NOT:** run anything from this step on the dev machine; skip the
before/after comparison.

---

### Step 22 — VM run 2: escape checklist (the user runs it)

**Machine:** **VM only**, from the clean checkpoint, all layers in
`enforce`, default group settings. Optional second run on a Home VM.

1. Walk Section 6 rows E-01..E-89 in order. Each row: the tester performs
   the check described in the row's "VM check" column as the Staff user,
   records **pass/fail** and evidence (audit row, findings entry, or the
   screen), and notes the residual risk if any.
2. Rows E-70..E-74 (the way back) run **first and last**: hidden exit,
   Shift at startup, Disable kiosk from the dashboard, `recover`, admin
   sign-in through "Other user".
3. Any **fail** in E-70..E-74 stops the run; the step that owns the
   control is reopened before anything else.
4. Home VM (if available): record which layers report `unsupported` and
   whether the remaining layers still pass their rows; this answers the
   PRD 13.2 "Verify" cells.

**Done when:** every row has pass/fail and evidence; every fail has an
owner step and a fix or an accepted residual risk written in Section 6
by the main session.
**Do NOT:** record anything beyond pass/fail, evidence and residual risk
in the results file (the checklist stays defensive, see the note at the
top of this file).

---

### Step 23 — Wrap-up

**Machine:** dev.

1. Workspace checks: `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo test --workspace`, `pnpm typecheck`, `pnpm lint`,
   `pnpm test:convex`, dashboard and Staff App tests.
2. `docs/plans/README.md`: Phase 5 row status; answers to Section 20.
3. Section 19 list handed to the user for the PRD (do not edit the PRD).
4. Every **(unverified)** item in this file marked confirmed or disproved
   from the VM results.
5. `cargo clean` of release artifacts if any were built; nothing left in
   `.tmp/phase5/` except screenshots referenced by the report.

**Done when:** the final report (below) is written.

---

## Final report format (keep it short)

- ✅ / ❌ per step's **Done when**.
- Exact dependency versions (4.22) and deviations.
- Screenshot list (screen × light / dark / narrow / Lite).
- Test counts per suite; write-count test results (4.19).
- VM results summary (Steps 21–22), every **(unverified)** item settled.
- Escape checklist: pass/fail count, open residual risks.
- Open questions for the user.

## Stop and ask the user if

- free disk space on D: is below 10 GB;
- any step would call a mutating `Platform` method on the dev machine, or
  needs the test-machine marker anywhere;
- a lockdown item would block anything in Section 4.6 and you cannot see
  how to keep the invariant;
- App Control or AppLocker cannot be removed cleanly in Step 21 (a policy
  stays active after Disable);
- the AppLocker mechanism (CSP bridge vs local policy) fails on both
  paths on Pro;
- `@noble/curves` / `@noble/ciphers` and the Rust crates disagree on the
  seal vectors;
- per-org key migration would change a key id (devices would need
  re-enrollment);
- a **Done when** check still fails after two honest attempts;
- the PRD and this plan disagree on something not listed in Section 19.

---

## 6. Escape checklist

Each row names a route in a few words, the control that closes it, an
observation that proves it closed (pass = nothing opens, or the stated
screen appears), and what stays open. Controls are configured and audited
by Rulebox (Sections 4 and 5); the checks are run by the tester in the VM
(Steps 21 and 22). Rows E-70..E-74 are the way back and must all pass.

| # | Route | Closing control | VM check (pass/fail) | Residual risk |
|---|---|---|---|---|
| E-01 | Security screen of Ctrl+Alt+Del | Policy values remove Task Manager, Lock, Change password and Sign out items for the Staff account (L1) | Pass: the screen shows no Task Manager item for Staff | The screen itself cannot be removed; it only offers Switch user and Sign out |
| E-02 | Switch user | Tile list shows only allowed accounts; admin tiles hidden only after E-71 passes (Q5) | Pass: the sign-in screen lists no tile that leads to an admin shell without the "Other user" way | Hiding tiles never replaces a strong admin password |
| E-03 | Sign out from the Windows menu | Rulebox log out is the supported path; Windows sign-out returns to the same kiosk shell | Pass: after sign-out and auto sign-in the shell is back | None beyond a brief sign-in screen |
| E-04 | Windows lock screen | Lock handled by the Staff App lock; Windows lock hotkey policy set | Pass: the lock shortcut shows the Rulebox lock screen or nothing | A Windows lock needs the Staff password |
| E-05 | Disconnected or second sessions | Remote sessions and fast user switching policies set for the Staff account | Pass: no second Staff session can be created | Remote access by an administrator is by design |
| E-06 | Accounts with no password | Staff account has a generated password; local policy forbids blank-password network logons | Pass: no sign-in path accepts an empty password | Physical access to the machine, see E-60..E-69 |
| E-10 | Windows key alone | Staff App hook opens Rulebox Start (decision P7) | Pass: Start opens, Windows Start does not exist | None |
| E-11 | Windows key combinations (Run, Explorer, Settings, Search, Task view) | Staff App hook swallows them (Q7); policy values disabled where they exist | Pass: none of the listed combinations opens a window | A key combination handled by firmware or drivers |
| E-12 | Task Manager shortcut | Policy removes Task Manager; process watchdog logs an attempt | Pass: the shortcut shows nothing | An administrator account can still run it |
| E-13 | Alt+Tab and task view | Rulebox switcher lists only allowed windows | Pass: the switcher shows only Rulebox-listed windows | None |
| E-14 | Alt+F4 on the shell | Shell windows refuse close; the agent restarts a dead shell within seconds | Pass: the shell stays or returns within the restart time | A crash loop is reported as a finding |
| E-15 | Function keys and media keys that launch programs | Registry association for hot keys removed; watchdog blocks unlisted launches | Pass: pressing the keys starts nothing | OEM utilities installed by the vendor are listed as findings |
| E-16 | Touch gestures and edge swipes | Edge-swipe policy off for the Staff account | Pass: swipes from screen edges open nothing | Hardware without the policy shows a finding |
| E-17 | Sticky, Filter and Toggle keys prompts | Hot-key prompts disabled for the Staff account | Pass: five Shift presses show no dialog | None |
| E-18 | Voice access and dictation shortcuts | Features off for the Staff account | Pass: the shortcuts start nothing | Tied to Windows build; listed per build |
| E-19 | Screenshot and recording shortcuts | Policy and App Control block the capture tools | Pass: the shortcuts start no capture tool | Camera or phone pointed at the screen |

| E-20 | Open and Save dialogs inside an allowed app | Places pane limited by policy; the dialog is confined to the employee folder where the app supports it; App Control blocks what the dialog could start | Pass: choosing a program or script file in the dialog cannot start it | A dialog may still show folder names the Staff account can read; file permissions limit it |
| E-21 | "Open file location" and "Open with" | Rulebox never uses file associations; Open with lists only the `fileHandlers` table | Pass: no entry starts a program that is not in the catalogue | None |
| E-22 | Print dialog | Printers limited to assigned ones; file printers (PDF, XPS) removed while the kiosk is on (D-decision) | Pass: the printer list shows only assigned printers | A web page can still call the system print dialog |
| E-23 | Help and "Learn more" links in allowed apps | Link handlers go through the web app allow list; external protocols denied | Pass: a Help link opens a blocked page or nothing | App-specific help viewers are listed per app in findings |
| E-24 | Drag and drop of files onto the shell | Shell windows ignore drops; apps drop only into the employee folder | Pass: dropping a file on the desktop does nothing | None |
| E-25 | Clipboard content that is a program path | Clipboard is data only; Rulebox never runs clipboard text | Pass: pasting a path starts nothing | None |
| E-30 | Program not in the catalogue | Allow-list rules for the Staff account (AppLocker; App Control block rules as base) | Pass: a program outside the allow list shows the Windows "blocked" message and a finding appears | In audit mode nothing is blocked, only reported |
| E-31 | Scripts and script hosts | Script rule collection of the allow-list; script hosts not in the allow list | Pass: a script file in the employee folder does not run | Allowed apps with their own macro or plug-in engines |
| E-32 | Installers and installer packages | Installer rule collection; Staff has no right to install | Pass: an installer file in the employee folder does not run | An administrator can install; the catalogue installs run as SYSTEM only after hash checks |
| E-33 | User-writable folders (profile, temp, downloads) | Default rules allow only signed or listed locations; user-writable paths are not allowed paths | Pass: a copy of an allowed program placed in a writable folder does not run | Programs that are allowed and also load code from writable folders: listed as findings |
| E-34 | Elevation prompts (UAC) | Staff account is a standard user; elevation prompts for administrators are denied by policy | Pass: no UAC prompt appears in the Staff session; a program that needs elevation shows the Rulebox notice | A prompt that appears for another reason is a bug to file |
| E-35 | Hand-off launchers (a stub that starts a packaged app) | Launcher adopts the new window within the allowed time; packaged apps are listed by identity | Pass: the stub starts only the listed packaged app | New builds may change the identity: the watchdog reports it |
| E-36 | Windows built-in tools (command line, shells, registry editor, system settings) | Block rules for the tools; policies hide Settings and Control Panel | Pass: none of them can be started from any Rulebox path | An administrator keeps access by design |
| E-37 | Legacy components that run code (help viewers, script engines) | Block rules from Microsoft's recommended list for the tools that are not needed | Pass: the listed components are blocked | New components in later builds; the list is reviewed each Windows feature update |
| E-38 | Task Scheduler and services entries added by a user | Staff has no rights to create them | Pass: a Staff process cannot create a task or service | An administrator process can |
| E-39 | Portable apps copied from a USB stick | USB storage read-only by default (Q4); allow list ignores unknown programs | Pass: a program on a USB stick does not run | If a group allows USB writes, the allow list is the only barrier |

| E-40 | Link to an address outside the allow list | Web window navigation gate shows the blocked page | Pass: the blocked page appears | None |
| E-41 | Pop-up or new window from a site | New-window handler denies or reuses the same window when allowed | Pass: no extra window opens for an unlisted address | None |
| E-42 | External protocol links (mail, file, other app schemes) | WebView2 external-launch handler denies by default | Pass: clicking such a link starts no program | A scheme on the allow list for a catalogue app is by design |
| E-43 | Downloads from a site | Downloads land in the employee's Downloads folder; names checked; executables refused | Pass: a downloaded program is blocked by name and by the allow list | A document with active content is the document app's concern |
| E-44 | Camera, microphone, location, notifications, clipboard read, file access requests | Permission handler denies every kind not in the app's rule; unknown kinds denied | Pass: a request shows no prompt and is denied; the denial count increases | A permitted kind is by design |
| E-45 | Site-provided file pickers and print calls | Pickers confined to the employee folder; print uses the assigned printers | Pass: the picker shows only the employee folder | System print dialog cannot be intercepted (E-22) |
| E-46 | Developer tools and view-source in web windows | Developer tools disabled in release builds; no remote debugging port | Pass: the shortcuts do nothing | Debug builds are for test machines only |
| E-47 | Another employee's saved sign-ins in a web app | Each employee has a separate web profile folder, removed on reset | Pass: signing in as a second employee shows no first-employee session | A shared kiosk account is not a supported setup |
| E-48 | Credential and autofill prompts | Autofill and password-save prompts disabled | Pass: no prompt appears | None |
| E-50 | Narrator, Magnifier, on-screen keyboard from the sign-in screen | Narrator off by default, the on-screen keyboard on (Q13); tools blocked per group switch | Pass: the Ease of Access button on the sign-in screen starts only the allowed tools | Accessibility tools are an accessibility duty: leave one allowed route |
| E-51 | Ease of Access button apps launching other programs | Allow list applies to the programs these tools start | Pass: a tool that offers "open" cannot start an unlisted program | Behaviour depends on Windows build; checked per build |
| E-52 | Sign-in screen network and power menus | Power menu limited by policy; network menu left for administrators | Pass: Staff cannot change network settings from the sign-in screen | A person with the Windows password for an admin account |
| E-53 | Windows Hello and sign-in options | Options not needed are off for the Staff account | Pass: no extra sign-in option appears for Staff | None |
| E-54 | Notification toasts from other apps | Toasts allowed only for Rulebox and catalogue apps | Pass: a toast from an unlisted source does not appear | Toasts from allowed apps may show content |
| E-55 | Windows feature pop-ups (welcome, tips, Copilot, widgets) | Policies disable the features for the Staff account | Pass: none of them appear after sign-in | New features in later builds are checked each feature update |
| E-60 | Safe Mode boot | Agent registered to start in Safe Mode and holds auto sign-in off there (unverified until the VM run) | Pass: in Safe Mode the Staff account is not signed in automatically | Safe Mode needs physical access or boot menu access; BIOS password and BitLocker are the real barrier |
| E-61 | Recovery environment and boot menu | Boot recovery options left unchanged when BitLocker is on; documented as a physical risk | Pass: the documented residual risk is shown in the dashboard | Cannot be closed by software |
| E-62 | Boot from USB or network | Not controllable by software; documented in the install guide as a firmware setting | Pass: the install checklist asks the installer to set a firmware password | Firmware settings differ by vendor |
| E-63 | Network shares and remote tools | Remote tools blocked for Staff; file sharing off for the Staff folder | Pass: the Staff account has no share access to other machines | A managed-network policy can limit it further (Q8) |
| E-64 | Second user account created by someone | Staff cannot create accounts; the agent reports new local accounts as findings | Pass: a new account shows as a finding within the report interval | An administrator can create one |
| E-65 | Windows Update and restart prompts | Update policy set; restarts at configured hours | Pass: no restart prompt interrupts the Staff session | Feature updates can reset settings: the agent re-applies and reports drift |
| E-66 | USB devices that act as keyboards or network cards | Device installation limited to the classes the group allows | Pass: an unlisted class is not installed for Staff | A trusted-looking keyboard device cannot be told apart |

| E-70 | Hidden administrator exit (the owner's way back) | Hotkey and PIN checked by the agent; works with every policy in force; never blocked by App Control or the watchdog | **Must pass:** the exit dialog opens with the key combination and accepts the right PIN | If the PIN is lost, `recover` (E-73) |
| E-71 | "Other user" sign-in tile | Hiding admin tiles is allowed only while this check passes on the build in use | **Must pass:** after all policies the sign-in screen still offers a way to sign in as another account | A Windows update could change the screen: re-checked each feature update |
| E-72 | Shift at startup (skip the kiosk shell) | The agent's fallback path stays available; no policy removes it | **Must pass:** holding the key at sign-in starts the fallback instead of the Staff shell | Documented in the install guide |
| E-73 | `recover` command on the machine | Command restores the original settings; never blocked by App Control for administrators | **Must pass:** after `recover` the Staff account is a normal account again | Needs an administrator |
| E-74 | "Disable kiosk" from the dashboard | Agent restores originals on the next sync, keeps the account and files | **Must pass:** after the command the machine has no kiosk policies and no allow-list rules | Offline machine waits until it syncs |
| E-75 | Stopping or changing the agent service | Service rights limited to SYSTEM and administrators; recovery actions restart it | Pass: a Staff process cannot stop it; an administrator stop is reported as a finding when it returns | An administrator can stop it |
| E-76 | Editing the agent's files or config | Folders writable by SYSTEM and administrators only | Pass: a Staff process cannot write there | An administrator can |
| E-77 | Editing the policy registry keys | Keys owned and writable by SYSTEM and administrators only; drift is detected and re-applied | Pass: a Staff process cannot write; a change by an administrator is re-applied and reported | An administrator can change it between checks |
| E-78 | Changing the clock to extend offline sign-in | Offline window uses a monotonic check and records clock changes as a finding | Pass: a changed clock does not extend the allowed offline period | Large jumps by an administrator are only reported |
| E-79 | Replacing the agent with an older version | Versions only move forward; the policy version must not go backwards | Pass: an older signed document is refused | Replacing the program file needs administrator rights |
| E-80 | Device lock | Lock screen with a message; sign-in refused; survives a restart and an admin exit until unlocked | Pass: while locked no employee can sign in, after restart it is still locked | An administrator at the machine can use E-73 (documented) |
| E-81 | Revoked device | Stays locked and stops syncing; never unlocks by itself | Pass: after revoke the device remains locked | Re-enrollment needs a new code |
| E-82 | Broadcast message | Shown on the lock screen and desktop; cannot be dismissed into a bypass | Pass: the message appears and does not unlock anything | None |
| E-83 | Offline device during a ring rollout | Offline devices keep the last applied version and take new ones when they return | Pass: an offline device applies the new version once and not older ones | A device offline for weeks follows the offline sign-in limits |
| E-84 | Replay of an older signed policy | Version must be higher than the last applied; signature checked | Pass: the older document is refused and logged | None |
| E-85 | Policy that would remove the way back | Safety invariants refuse it before applying (refusal codes I1–I9) | Pass: the policy is refused with the matching code and the device keeps the old one | A rule outside the invariants: reported by the audit step |
| E-86 | Policy applied half way (power loss) | Journal v2 finishes or rolls back at the next start | Pass: after a power cut during apply the device ends in the old or the new state, never between | Disk write failures are reported |
| E-87 | App Control or AppLocker blocking Rulebox itself | Rulebox files are allowed by publisher and path; audit mode first | Pass: in enforce mode the agent, the launcher and the Staff App all start | A new build with a changed signature needs the allow rule updated first |
| E-88 | Antivirus quarantining a Rulebox file | Install guide lists the exclusion request; the agent reports missing files | Pass: a removed file is reported and repaired from the version store | Third-party products differ |
| E-89 | Windows feature update resets settings | The agent compares settings with the desired state after each start and re-applies | Pass: after an update the policies are back and a finding is recorded | A short gap between the update and the next check |


### Checklist notes

- Counts: 74 rows are written; numbers inside a range that are unused are free for new routes. Add a row inside a range when a VM run finds a new route.
- A failed row is a bug in the control, not a note: fix, then re-run the row.
- Rows depending on a Windows build record the build in the VM results file (Step 22).


---

## 7. Edge cases and failure modes

| # | What can go wrong | Required behaviour | Step |
|---|---|---|---|
| 1 | Partial apply (one layer fails, others succeed) | Layers keep the order of 4.11 (way back and tamper first, program-start layers last); `state: "partial"` with per-layer detail; the failed layer is retried every reconcile with backoff 1, 5, 15, 60 min; nothing already applied is rolled back unless LKG triggers | 2, 9 |
| 2 | Power loss mid-apply | Journal entry is `Pending` before the write (4.4); `startup_recover` drops or keeps it by comparing with the system; the apply restarts from the cached signed payload | 2 |
| 3 | Power loss while writing the journal file | `write_atomic` with flush + write-through rename: either the old or the new file exists, never a torn one; a corrupt file (parse error) → agent refuses to change anything, keeps the kiosk as is, reports `journal_unreadable`; `recover` reads `state.v1.json`/`.bak` | 2 |
| 4 | Restore (Disable) fails for one entry | Entry stays `Restoring`, others continue; retried each reconcile; device page shows `restore_incomplete` with the ids; `recover` offline can finish it | 2, 20 |
| 5 | Rollback (LKG) itself fails | Leave the layer in its current state, set `state: "failed"`, set procwatch to `audit` and AppLocker to `audit` for the rest of the boot (both are switchable without a restart), report `lkg_failed`; never loop | 9 |
| 6 | A document would block the exit PIN path or the way back | Refused by `invariants::validate` before any write (`would_block_exit`, `would_block_rulebox`, …); previous state kept; audit `device.lockdownRefused`; dashboard shows the reason in plain words | 4 |
| 7 | App Control blocks the agent or the Staff App | Cannot be produced by Rulebox's own policies (Rulebox folder allowed in both, tested on the generated XML); if a *third-party* policy blocks them, the launcher watchdog fails, LKG cannot help, the hidden exit and Shift at startup still work (they do not run Rulebox code); `recover` removes Rulebox policies only | 6, 20 |
| 8 | AppLocker blocks the agent or the Staff App | Invariant rules (Everyone allow on the Rulebox folder; Staff allow on the Staff App `versions\` folder and the WebView2 runtime) are always emitted; validator refuses exceptions that would shadow them; AppLocker does not apply to the agent's SYSTEM service start **(unverified, VM checks it)** | 4, 7 |
| 9 | A third-party App Control or AppLocker policy already exists | Rulebox adds its own policies (multiple-policy format) and never edits others; AppLocker: if a non-Rulebox local policy exists, refuse L3 with `applocker_foreign_policy` and report; the admin decides | 6, 7 |
| 10 | Hand-off launchers (an app's stub starts the real program elsewhere) | Shows as a finding in audit mode with the real program's signer; the admin allows it by publisher for that app; procwatch and AppLocker share the exception | 8, 9 |
| 11 | App needs elevation | Start fails (Phase 3: error 740, wanted); `denyElevationRequests` stops a credential prompt appearing in the Staff session; the Staff App shows "needs administrator rights"; counted in `blocked.elevation` | 5, 12 |
| 12 | Self-updating app writes a new version to a new folder | Publisher rules survive version changes; hash rules do not, so the findings screen marks hash exceptions "breaks on update" and suggests publisher rules | 9, 19 |
| 13 | Unsigned app the organization needs | Hash exception (per version) or path exception only under an admin-only folder (`{ProgramFiles}`, `{RuleboxApps}`); never a path rule under a user-writable folder (refused by the validator) | 1, 7 |
| 14 | Home edition | L3/L4 report `unsupported` if Windows refuses them; L1, L2, L5, L6, L7 still apply; dashboard badge "Reduced protection (Home)"; Q12 | 6, 7, 22 |
| 15 | ARM64 Windows | The agent runs under x64 emulation; ETW, App Control, AppLocker are OS features and should work **(unverified)**; compat shows a warning `arm64_untested`; `{ProgramFiles}` on ARM64 has a third folder (`Program Files (Arm)`) that the allow-list includes | 3, 7 |
| 16 | Non-English Windows | Never match group, account, printer or folder names by text: well-known SIDs (`S-1-5-32-544`, `S-1-1-0`, `S-1-5-4`), Known Folder IDs, printer ports/driver names, event XML fields instead of message text | 3–8 |
| 17 | Multiple monitors | Lock view and full-screen broadcast cover every monitor; the second monitor stays blank otherwise (P13); procwatch is monitor-agnostic | 12 |
| 18 | Domain-joined (or Intune) device | Compat blocker by default (Phase 2); with `allow_joined`, domain policy may overwrite values → drift "fighting" detection (4.11), report, no endless loop | 4, 5, 9 |
| 19 | Feature update resets settings or service start types | Agent sees the build change, re-applies all layers, compares with the journal, reports `featureUpdateReapplied`; App Control policies in the Active folder survive updates **(unverified)** | 9, 21 |
| 20 | Clock skew on the device | Nothing trusts the device clock (4.16); daily buckets use server days; broadcast expiry uses the server offset | 9, 15 |
| 21 | Replayed or downgraded signed policy | Phase 4: version must increase; rollback is new content under a higher version; LKG uses only payloads that verified when stored and re-verifies them | 9, 16 |
| 22 | Policy signed by another organization's key | Verification fails (per-org trust, 4.18); `policy_rejected` | 10 |
| 23 | Two admins publish at once | `expectedRevision` on `groupLockdown`, `groupRollouts`, app permissions → `stale_edit`; publishes merge in the queue | 10, 16 |
| 24 | Devices offline during a ring rollout | They get their ring's pointer on reconnect; never intermediate versions; health counts them as `waiting`, which never counts as success | 16 |
| 25 | Pilot ring has no online device | Auto-promotion needs `applied ≥ 1`; the rollout stays `rolling` with a "no pilot device has applied this yet" note | 16 |
| 26 | Rollback target version was pruned | Only the last 20 versions are offered; pointers protect referenced versions from pruning | 16 |
| 27 | A device is moved to another group mid-rollout | It immediately follows the new group's pointer for its ring; its old `config` reports stop counting for the old group | 16 |
| 28 | Admin locks a device that is offline | Lock waits in the document; applied on the next connection; dashboard says "Lock pending" until `deviceApplyReports` shows the lock id | 15 |
| 29 | Device lock + admin needs the PC | Hidden exit works during lock; after re-arm the lock is still on (4.17) | 15, 22 |
| 30 | Broadcast with expiry already past when the device comes online | Not shown; the agent drops it | 15 |
| 31 | Broadcast text with HTML or very long words | Plain text, wrapped; limits enforced on the server | 12, 15 |
| 32 | Wi-Fi passphrase wrong | Profile installs; connection fails; the agent reports `connect_failed` only if the profile's SSID is in range and the last attempt failed (read from WLAN notifications, no polling) | 13 |
| 33 | Device has no Wi-Fi adapter (Hyper-V, desktops) | `wifi` states `unsupported`; no error banner; managed-only not applied | 13 |
| 34 | Managed networks only + the device is connected to an unmanaged network | Refused (`would_disconnect`) unless the admin confirmed; then applied and the device goes offline until a managed network is in range (dashboard warns) | 13 |
| 35 | Device sealing key lost (Secrets reset, reinstall) | Agent creates a new key, calls `registerSealKey` with proof of device identity (device secret); server reseals; until then profiles are `waiting_for_key` | 10, 13 |
| 36 | Org sealing key or master key missing in the environment | Passphrase save fails with `keys_not_configured`; publishing continues for everything else; red banner | 10 |
| 37 | Printer driver not in the driver store | `driver_missing`; dashboard says which PCs need the driver pre-installed | 14 |
| 38 | Printer name already used by a non-Rulebox printer | `name_taken`; the existing printer is never touched | 14 |
| 39 | "No printing" requested while printers are assigned | Spooler stays on; `performance.noPrinting` ignored with a dashboard note | 14, 18 |
| 40 | A policy hides Switch user but a second employee session is already disconnected | Phase 2 rule: the agent logs off disconnected Staff sessions; Hide Switch user prevents new ones | 5 |
| 41 | Account lockout locks the organization's admin account | Threshold ≥ 5 enforced (validator); the built-in Administrator (RID 500) stays exempt by Windows default; dashboard explains; `recover` path documented | 4, 5 |
| 42 | Admin tiles hidden and "Other user" does not appear on the sign-in screen | Validator refuses `hideAdminTiles` until the VM confirms "Other user" (E-71); fallback per Q5 | 5, 22 |
| 43 | App Control activation needs a restart (Windows 10, or removal on some builds) | Layer state `restartPending`; the agent never restarts the PC; the dashboard shows "Restart needed" | 6 |
| 44 | ETW session cannot start (64-session limit, permission) | Procwatch falls back to a 2-second process snapshot diff; `procWatch.detail = "snapshot_fallback"`; still terminates in `enforce` | 8 |
| 45 | ETW events lost under a start burst | Lost-event counter read each minute; when > 0 a snapshot diff runs once to catch missed Staff processes | 8 |
| 46 | Procwatch would end a process that is critical to Windows in the Staff session | Only processes whose token user is the Staff SID are considered; images under `%WINDIR%` with a Microsoft signature are matched by the same Staff deny-list as AppLocker, nothing else under `%WINDIR%` is ended; a fixed never-terminate list (Rulebox, WebView2 runtime, `csrss`, `winlogon`, `dwm`, `fontdrvhost`, `ctfmon`, `conhost`, `TextInputHost`) is checked first | 8 |
| 47 | Two Staff App versions during a Phase 3 update | Allow-list covers the whole `versions\` folder (admin-only ACL) | 7 |
| 48 | Catalogue app installed into a per-user folder (AppData) | Phase 4 installs machine-wide only; a `preinstalled` app with a per-user path is refused by the template grammar; App Control `allowlist` level refused while such an app is assigned (`allowlist_level_with_user_install`) | 1, 4 |
| 49 | Antivirus quarantines or blocks part of the agent | Service recovery restarts; the dashboard shows the agent offline; documented for Phase 6 code signing | 17 |
| 50 | Staff profile hive not loaded when L1 applies | `with_user_hive` mounts `NTUSER.DAT` (Phase 2); if the profile is locked by another process, retry next reconcile, report `staff_hive_busy` | 4 |
| 51 | Admin changes something by hand (Group Policy editor, registry) | Treated as drift for Rulebox-owned values (re-asserted, counted); values Rulebox does not own are never touched | 9 |
| 52 | Agent upgraded with a newer journal format, then downgraded | Older agent refuses to apply on unknown targets (4.4) and keeps the kiosk as is; `recover` from the newer binary restores | 2 |
| 53 | `unenroll` while layers are in `enforce` | Restore everything first (journal), then remove the enrollment; the order is tested | 20 |
| 54 | BitLocker on and `autoRecovery: off` requested | Agent uses `leave` (4.16) to avoid a BitLocker recovery prompt after a BCD change **(unverified whether that element is validated)**; dashboard explains | 5 |
| 55 | Accessibility needs of an employee | `accessibilityTools: true` per group allows the Windows accessibility tools for Staff (they stay blocked otherwise); the Staff App's own accessibility features (Phase 3) are always on | 4 |
| 56 | USB storage blocked while an employee needs to hand in files | Policy per group; the dashboard text says the Staff App has no other export path in v1 | 4 |
| 57 | Findings flood (a misbehaving app starts thousands of processes) | Agent dedupes by fingerprint and counts locally; ≤ 50 fingerprints per flush, ≤ 4 flushes/day; counts go only to the daily summary | 9 |
| 58 | Convex down when the device wants to report | Reports stay in local files (findings ≤ 500 fingerprints, daily counters merge); sent later; oldest dropped with a `findingsDropped` count | 9 |
| 59 | Document over the size limit after many exceptions | Server refuses at save time (`too_many_exceptions` at 200); publisher refuses at build (`document too large`) as in Phase 4 | 10 |
| 60 | Safe Mode with Networking vs Minimal | Agent registered for both; in either the Staff session is kept out and audited | 5 |
| 61 | Employee locks the screen (Phase 3 P12 "Lock") while L1 hides Lock in Ctrl+Alt+Del | The Staff App's lock is its own screen (convenience, Phase 3 7.6), not Windows' lock; Windows' lock stays disabled | 4 |

## 8. Observability

- **Audit log** (Phase 4 4.11 rules): every admin action of 4.2 and the
  device events (refused, rolled back, tamper, first drift per item per
  day, Safe Mode blocked, clock jump). Never one row per blocked program.
- **Device page:** per-layer state and detail code, LKG version, applied
  config version and ring, restore status, physical-protection card,
  Wi-Fi/printer states, lock state.
- **Fleet signals** (overview): layers in audit for more than 14 days,
  halted rollouts, `restore_incomplete`, devices without physical
  protection, `fighting` drift, `snapshot_fallback` procwatch, agents too
  old for lockdown.
- **Agent logs** (local, rotated by the Phase 2 logger): apply start/end
  with version and per-layer result codes, journal phases, invariant
  refusals with code, procwatch counters per minute (numbers only),
  ETW lost events, LKG decisions. Never: command lines, window titles,
  document names, URLs, passphrases, sealed boxes, the PIN hash.
- **`rulebox-agent lockdown-status`** (Step 20, administrator, read-only):
  prints each layer's expected vs actual state, journal size, invariant
  self-check results, posture. The VM runs use it as evidence.
- **Convex logs:** one line per failure with code and ids (Phase 4 rule).

## 9. Security checklist

Walked in Step 23; each line ticked or reported.

- [ ] Every new mutating `Platform` method and `rulebox-win32` function
      calls the guard first (coverage tests green).
- [ ] No code path creates the test-machine marker; Step 0 confirmed the
      dev machine has none.
- [ ] Registry writes only under `machinereg` / `staffreg` allowed roots;
      `FORBIDDEN_WINLOGON_VALUES` cannot be written by any layer.
- [ ] Every Section 4.6 invariant has a unit test on generated output
      and a VM row (E-70..E-74).
- [ ] App Control policies are unsigned, static, embedded, and include
      the Rulebox folder; no per-app rule ever reaches App Control.
- [ ] AppLocker rules: allow-all for Administrators and other enabled
      local accounts; Staff allow-list never contains a path rule under a
      user-writable folder; writable-subfolder exceptions generated.
- [ ] Procwatch only ends processes whose token user is the Staff SID,
      re-checks the image path and SID at termination time (Phase 2
      `terminate_process`), and never touches the never-terminate list.
- [ ] Journal records originals before every write; restore tested for
      every target type; `recover` handles every target type offline.
- [ ] Per-org keys: no secret in any query result, log line or audit
      summary; `wrapped` and `sealed` fields excluded from every
      `returns` validator (a test walks all public functions' validators).
- [ ] Wi-Fi passphrases: action-only encryption, zeroized buffers on the
      agent, log-scan test green.
- [ ] Sealed boxes bound to org, device and profile (vector test with a
      wrong device fails).
- [ ] IPC 1.3 inputs validated (app ids from the catalogue, counts
      capped); nothing secret in the snapshot.
- [ ] Rule 6: findings carry file name, folder class, signer, product,
      hash only; no command line; a test feeds an event with a full
      path and command line and checks what leaves the agent.
- [ ] Rule 7: write-count tests of 4.19 green.
- [ ] Service DACL, required privileges and folder ACLs measured and
      re-asserted; tamper events audited.
- [ ] Dashboard: Viewers cannot change lockdown, rings, networks, locks
      or broadcasts (authorization matrix extended).
- [ ] Nothing in this plan, the code comments or the VM results file
      describes how to defeat a control (note at the top of the file).

## 10. Migration and compatibility rules

- **Widen then narrow** (Phase 4 Section 11): new table fields optional;
  `statusValidator` widened before an agent sends new keys.
- **Document:** format stays `rulebox.desired/2`; additions only; 4.3
  rules 1–6.
- **Agent state:** schema 2 with a one-way migration; a v1 agent cannot
  read schema 2 (it refuses and keeps the kiosk, Phase 2 behaviour for an
  unknown schema) — so agent downgrades across this phase need `recover`
  from the newer binary first.
- **IPC:** 1.3 additive; 1.1/1.2 clients keep working (4.12).
- **Keys:** `keys:migrateFromEnv` keeps the existing key id; devices
  enrolled in Phase 4 need nothing.
- **Order of deployment inside the phase:** server widening (Step 10)
  before agents that report new fields (Step 9 code ships with Step 10);
  the builder writes `lockdown` only after Step 10's agent tests pass;
  until then documents carry no Phase 5 keys.
- **Phase 4 groups** get `groupLockdown` rows lazily: missing row =
  `newGroupDefaults` or the 4.3 defaults, in `audit` (rule 4).

## 11. Test strategy

### 11.1 Dev machine (automated, safe)

| Area | How | Where |
|---|---|---|
| Types, limits, vectors (lockdown, seal) | Rust unit tests + the same vectors in convex-test | `rulebox-policy`, `convex/` |
| Journal, migration, crash points | SimPlatform with fault injection after each write step | agent |
| Invariants | Table test: every catalogue item × every layer mode × every level → generated AppLocker XML, App Control selection and procwatch matcher always allow the Rulebox folder, the Staff App `versions\`, WebView2 runtime; the exit and Shift paths untouched | agent |
| Allow-list compiler | Golden files for AppLocker XML (sorted, deterministic) and matcher decisions on a fixture list of 300 paths/signers | agent |
| Procwatch | Recorded ETW event fixtures (synthetic) fed to the matcher; termination calls captured by SimPlatform; never-terminate list test | agent |
| Findings | Event XML fixtures (AppLocker 8003/8004/8006/8007, Code Integrity 3076/3077) → fingerprints; privacy test (rule 6) | agent |
| Guard | Text-scanning coverage tests; allowed-roots tests | agent, `rulebox-win32` |
| Server | convex-test: authorization matrix, cross-org isolation, write counts, rings, sealing, rollups, retention | `convex/` |
| Dashboard | Vitest + fixtures; screenshots per screen | dashboard |
| Staff App | Vitest + demo mode; simulated agent for 1.1/1.2/1.3 | Staff App |

### 11.2 VM only (the user runs it)

Steps 21 and 22. The VM is reverted to its clean checkpoint before each
run. Results go to `docs/plans/phase-5-vm-results.md`. A Home VM run is
optional and recorded separately.

### 11.3 Escape checklist numbering (contract for Section 6)

Section 6 is written by the main session. Steps refer to these ranges;
the rows inside a range are free.

| Range | Area |
|---|---|
| E-01..E-09 | Session and sign-in screen (Ctrl+Alt+Del screen items, Switch user, sign-out, Windows lock, disconnected sessions) |
| E-10..E-19 | Keyboard (Windows-key combinations, other shell shortcuts) |
| E-20..E-29 | Dialogs inside allowed apps (open/save, print, help, "open file location"), file-output printers |
| E-30..E-39 | Program start control (unlisted programs, scripts, installers, user-writable folders, elevation) |
| E-40..E-49 | Web apps and links (external protocols, downloads, browser hand-off, permissions) |
| E-50..E-59 | Accessibility tools and sign-in-screen tools |
| E-60..E-69 | Boot, recovery, Safe Mode, physical access, network |
| E-70..E-74 | **The way back** (must pass): hidden exit, Shift at startup, Disable kiosk, `recover`, admin sign-in |
| E-75..E-79 | Tamper (service, files, registry, clock) |
| E-80..E-89 | Device lock, broadcasts, offline and policy replay |

## 12. Known risks from research

| Risk | Detail | Handling |
|---|---|---|
| AppLocker on Pro/Home | Microsoft documents AppLocker policy support on all editions since KB 5024351 (Windows 10 2004+ / 11); the management path on Home (no Local Group Policy editor) is **(unverified)** | Two mechanisms behind one method (MDM bridge CSP, local policy); VM decides; Home falls back to L4+L5 |
| AppLocker is default-deny for everyone once a collection has rules | Without explicit rules, administrators and other users would be blocked too | Allow-all rules for Administrators and each other enabled local account SID; re-evaluated each reconcile; a new account created by hand is covered within one reconcile (≤ 10 min) |
| App Control is device-wide (PRD 13.6 #2) | Policies affect administrators | Default level `recommendedBlocks` only; `allowlist` is opt-in with a clear warning; per-app rules never go to App Control |
| App Control activation and removal | CiTool refresh exists on Windows 11 22H2+; Windows 10 needs a restart; removal of some policies needs a restart **(unverified)** | `restartPending` state; the agent never restarts the PC |
| A wrong App Control policy can stop a PC from booting | Mostly with signed policies or driver blocks | Unsigned policies only (non-goal: signed), no kernel-driver rules beyond Microsoft's list, audit first, LKG for L3/L5 |
| Recommended block rules list changes | Microsoft updates the list | The XML in the repo is versioned and updated deliberately; the policy version number increases with each update |
| ETW real-time sessions | 64 sessions system-wide; buffers can lose events under load | Snapshot fallback and lost-event catch-up (edge cases 44, 45) |
| BCD change with BitLocker | Some BCD changes trigger BitLocker recovery **(unverified for `recoveryenabled`)** | `leave` when BitLocker protects the OS volume |
| Hidden admin tiles and "Other user" | Whether Windows 11 shows "Other user" when admin tiles are hidden is **(unverified)** | Validator refuses until VM row E-71 passes (edge case 42) |
| Print spooler security | Point and Print driver downloads were a source of serious vulnerabilities | Drivers only from the local store; `RestrictDriverInstallationToAdministrators = 1` |
| WebView2 print and file pickers | Not interceptable inside WebView2 (Phase 3) | Closed one level down (L1, L3–L5, file-output printers denied) |
| Free-plan database I/O | ≈ 1 GB/month shared by all tenants | Section 4.19; post-Phase-5 I/O pass |

## 13. Disk and dev environment

- New Rust crates are small (crypto, no ETW/WMI crates); expect ≤ 150 MB
  more in `target\`. One workspace `target\` only.
- The App Control binary build writes a few KB under
  `target\appcontrol\`. It needs the `ConfigCI` PowerShell module
  (`ConvertFrom-CIPolicy`), which is part of Windows **(unverified on the
  dev machine's build)**; if missing, Step 6 records it and the user runs
  the conversion on the VM instead and copies the `.cip` back.
- No release builds before Step 21; `cargo clean --release` afterwards.
- No new Node tools beyond `@noble/curves` and `@noble/ciphers`.

## 14. Performance, memory and I/O budgets

Target: 4 GB RAM laptops in Lite mode (PRD 22).

| Item | Budget | Measured in |
|---|---|---|
| Agent working set, idle, all layers on | ≤ 20 MB (Phase 2 baseline + ≤ 8 MB) | Step 21 |
| Agent CPU, idle | < 0.5 % average over 10 minutes | Step 21 |
| Procwatch decision per process start | ≤ 2 ms (matcher in memory; signature check only for images not cached, cache 2,000 entries keyed by path + file id + size + time) | unit bench + Step 21 |
| ETW buffers | 4 buffers × 64 KB | code |
| Full apply (all layers, cold) | ≤ 30 s excluding App Control restart | Step 21 |
| Reconcile pass (no drift) | ≤ 500 ms, reads only | Step 21 |
| Staff App extra memory (lock view, banners) | ≤ 5 MB; no new WebView | Step 12 |
| Kiosk performance profile | Services of PRD 22.3 changed only while kiosk is on; restore exact | Step 18 |
| Document size | typical ≤ 12 KB, worst ≤ 64 KB for Phase 5 keys | Step 10 tests, Step 21 |
| Database I/O | 4.19 table | Step 10 tests, Step 21 |
| Disk on the device | journal ≤ 64 KB, findings file ≤ 256 KB, LKG payload ≤ 512 KB, embedded policies ≤ 200 KB | code limits |

## 15. Accessibility

- Lock view and broadcasts: readable at 200 % scaling, contrast ≥ 4.5:1
  in both themes, focus on the "OK" button, screen-reader labels, no
  timed dismissal.
- The Staff App's own accessibility features (Phase 3) stay available
  under every lockdown level; Windows' tools follow `accessibilityTools`.
- Dashboard: mode switches are real switches with labels, the
  confirmation dialogs are focus-trapped `<dialog>`s, tables keep
  keyboard navigation (Phase 4 rules).

## 16. Hand-off to Phase 6

- **Release guard answer:** every mutating method is guarded; Phase 6
  decides how release builds on customer PCs pass (signed installer
  context), without weakening the dev-machine protection.
- **Code signing** lets AppLocker and App Control use publisher rules for
  Rulebox instead of path rules; replace the invariant path rules then.
- **Installer compatibility check** reuses `read_security_posture`,
  edition detection and the AppLocker/App Control capability probes
  (read-only) to show "Full / Reduced protection" before install.
- **Pilot on a real 4 GB laptop:** the Section 14 budgets are re-measured
  there, with real Wi-Fi and a real printer (the VM cannot test either).

## 17. Definition of done for Phase 5

1. Steps 0–23 **Done when** checks pass; the final report is written.
2. On the Windows 11 Pro VM, every layer applies in `audit`, then in
   `enforce` through the pilot ring, and Disable kiosk restores the
   before-enrollment baseline with no differences (Step 21 run 8).
3. `recover` restores everything offline (Step 21 run 9).
4. LKG rolls back a shell-breaking lockdown change by itself and the
   rollout halts (Step 21 run 4).
5. Section 6 has pass/fail and evidence for every row on Pro; E-70..E-74
   all pass; every fail has an owner step or an accepted residual risk.
6. Wi-Fi sealing works end to end in tests; a printer is created and
   removed on the VM; Wi-Fi is recorded `unsupported` on Hyper-V and
   handed to the Phase 6 pilot.
7. Device lock and broadcasts work on the VM, including offline and
   after an admin exit.
8. Per-org keys are in use; the deployment-wide policy key is gone from
   the environment.
9. The 4.19 write counts are proven by tests and the budgets of
   Section 14 are measured.
10. `docs/plans/README.md` updated; Sections 19 and 20 handed to the user.

## 18. Decisions made in this plan

PRD 21.1 decisions are untouched. These are this plan's own:

| # | Decision | Reason |
|---|---|---|
| D1 | Seven layers, each journalled and undone by Disable (4.1) | Defence in depth; no single Windows feature covers Home and Pro |
| D2 | One allow-list model compiled to AppLocker, procwatch and the findings classifier | One truth, one review screen |
| D3 | App Control policies are static, unsigned, embedded in the agent; per-app exceptions never reach App Control | A bad exception cannot affect boot; device-wide layer stays predictable for admins |
| D4 | AppLocker rules for the Staff SID only, with allow-all rules for Administrators and other local accounts | Per-user allow-list on every edition where AppLocker works (Section 19) |
| D5 | Audit first for L3–L5; `enforce` only through rings | Rule 4; avoids breaking real work on day one |
| D6 | Procwatch uses ETW with a snapshot fallback; no driver | Non-goal: kernel drivers |
| D7 | Journal v2 with typed targets and a three-phase write | Exact restore of everything Phase 5 touches (PRD 22.3) |
| D8 | Invariants checked before any write; refusal keeps the previous state | Rule 2 |
| D9 | Format stays `rulebox.desired/2`; new agent-only keys; capability reporting | Old agents refuse nothing they can still do; the dashboard shows what they cannot |
| D10 | Ring unit = group configuration version; locks, broadcasts, employees and keys are not ring-gated | A lock must never wait for a pilot |
| D11 | Device-local LKG for lockdown sections, judged by Staff App health | A broken shell cannot report; the device must heal itself |
| D12 | Auto-promotion off by default; auto-halt always on; auto-rollback for pilot on | Safe defaults (Q6) |
| D13 | Per-organization signing and sealing keys wrapped by a deployment master key in the environment | Shared deployment (tenant decision 2026-10-27); no external KMS on the free plan |
| D14 | Wi-Fi passphrases encrypted at rest with the org sealing key and sealed per device inside the signed document | PRD 24.2 "sent only to devices that need them"; ciphertext only in documents and backups |
| D15 | Printers only with drivers already on the PC; no Point and Print | Spooler vulnerability history |
| D16 | Security reports are counters and new-fingerprint findings, batched; one daily row per device only when non-zero | Rule 7, 4.19 |
| D17 | Physical protection is reported, not configured | Non-goal; honest dashboard (rule 8) |
| D18 | `boot.autoRecovery` left alone when BitLocker protects the OS volume | Avoid recovery-key prompts |
| D19 | Windows-key combinations swallowed by the Staff App's hook helper (Q7) | Explorer is not running, so the Explorer policy alone does nothing |
| D20 | Hide admin tiles per enabled local admin, guarded by the "Other user" check (Q5) | PRD 13.6 #8 without risking the way back |
| D21 | Lost-device lock = message + sign-in refusal; no wipe, no location | PRD 24.4; no usage tracking |
| D22 | Web app printing default `true`, effective only with printers | PRD 24.1 |
| D23 | Every mutating seam method guarded twice; the dev machine never gets the marker | Rule 1 |

## 19. Deviations from the PRD (tell the user)

Do not edit the PRD in this phase; give this list to the user.

| PRD section | Deviation or proposed change | Why |
|---|---|---|
| 13.2 (AppLocker: Home "No", Pro "Verify") | AppLocker per user (Staff SID only) is used on every edition where Windows accepts it; Microsoft documents support on all editions since KB 5024351; Home result recorded in Step 22 | Gives a per-user allow-list without touching administrators |
| 13.6 #2 ("per-user rules are not available") | True for App Control; AppLocker provides them. App Control stays device-wide with a narrow default (recommended block rules) | Same |
| 13.6 #2 ("one App Control policy … watchdog is the main defense on Home") | Two possible App Control base policies (recommended blocks; optional allowlist), AppLocker for Staff, and the watchdog as the catch-all | More layers, same intent |
| 12.2 ("Disable Windows key shortcuts … via policy") | The Explorer policy is set, but the effective control is the Staff App's hook helper swallowing combinations (Q7); a lone Windows key still opens Rulebox Start (Phase 3 P7) | Explorer is not running, so its policy has no effect |
| 12.2 / 13.1 ("Boot into Safe Mode … disable advanced boot options") | Agent runs in Safe Mode and keeps Staff out; automatic WinRE failover off when safe to do so; firmware passwords and BitLocker are reported, not configured | Changing firmware or encryption is out of scope and risky |
| 12.3 ("signed by an organization key") | Per-organization signing keys wrapped by a deployment master key held in the environment | Shared deployment; operator still holds the master key |
| 24.2 ("passwords stored encrypted on the server") | Encrypted at rest with a per-organization key **and** sealed per device | Stronger; documents and backups never hold a usable passphrase |
| 24.2 (printer "driver from an approved list") | Approved list = inbox class drivers + names the org adds; drivers must already be on the PC | No driver downloads |
| 24.3 ("return a group to any previous version") | The last 20 group configuration versions | Bounded storage |
| 24.3 ("every desired-state change can be sent to a ring") | Locks, broadcasts, employees, admin exit and keys are never ring-gated | They must apply at once |
| 24.4 ("only the admin exit or an unlock ends it") | The admin exit ends the Staff session but the lock returns at re-arm; only an unlock ends it | Otherwise an admin exit would silently unlock a lost device |
| 22.3 (Print Spooler disabled for "no printing") | Never disabled while printers are assigned | Avoids a contradictory configuration |
| 22.3 (Defender full scans "outside active hours") | Not configured in Phase 5 | Windows Update / scan scheduling is a v1.x item (non-goal) |
| 22.6 ("memory and CPU with the regular heartbeat") | Still not reported periodically | Rule 7; a "low memory" flag may be added change-driven later |
| 13.5 ("signature checks tolerate small clock differences") | Nothing security-relevant uses the device clock | Phase 4 already chose this |
| 12.1 / 9.5 (way back) | Formalised as invariants checked before any write, with tests and VM rows | Rule 2 |

## 20. Open questions for the user

The plan assumes the **recommended** option for each.

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | App Control default level | (a) Microsoft's recommended block rules only; `allowlist` opt-in per group. (b) `allowlist` by default | **(a).** App Control is device-wide; the allowlist level also restricts administrators and needs per-PC review |
| Q2 | How long a new organization stays in `audit` before the dashboard suggests `enforce` | (a) 7 days. (b) 14 days. (c) No suggestion | **(a)**, and the overview warns after 14 days |
| Q3 | 802.1X / EAP Wi-Fi with certificates | (a) v1.x. (b) Phase 5 | **(a).** Needs certificate distribution and is untestable on Hyper-V |
| Q4 | USB storage default | (a) Allowed, per-group switch to read-only or blocked. (b) Blocked by default | **(a).** Employees often need it; the switch is one click |
| Q5 | Hide administrator tiles on the sign-in screen | (a) Hide every enabled local admin, only after VM row E-71 confirms "Other user" is offered. (b) Hide only the admin chosen at enrollment. (c) Do not hide | **(a)** (PRD 13.6 #8) |
| Q6 | Automatic ring promotion default | (a) Off; auto-halt always on; auto-rollback of pilot on. (b) On with 24 h bake | **(a)** |
| Q7 | Windows-key combinations | (a) Staff App hook swallows them when `keyboard.winCombos = swallow` (default). (b) Policy only | **(a).** Without Explorer the policy alone has no effect |
| Q8 | "Managed networks only" default | (a) Off. (b) On when at least one profile exists | **(a).** It also restricts administrators and can take a PC offline |
| Q9 | Where per-organization keys live | (a) Wrapped by a master key in the Convex environment. (b) External key service (cloud KMS) | **(a)** for the free plan; (b) when a paying tier exists |
| Q10 | Lost-device lock scope | (a) Message + sign-in refusal; admin exit still works. (b) Also block Wi-Fi / USB while locked | **(a).** (b) can strand the device offline so an unlock never arrives |
| Q11 | Per-user tuning (22.2) and kiosk performance profile (22.3) | (a) Phase 5 Step 18. (b) Phase 6 | **(a).** Same journal machinery; measured in Step 21 |
| Q12 | Home edition if AppLocker or App Control is refused | (a) Allow enrollment with "Reduced protection" badge (L1, L2, L5–L7). (b) Block Home | **(a).** Many target laptops run Home; the dashboard is honest about it |
| Q13 | Windows accessibility tools for Staff | (a) Blocked by default, per-group switch. (b) Allowed by default | **(a)**, with the Staff App's own accessibility always on |

## 21. Could not be verified

Each item says how it gets settled. Nothing in this plan was compiled or
run; every signature is a specification.

- AppLocker policy management on Home and the working mechanism on Pro
  (MDM bridge CSP vs local policy) — Step 21, Step 22 (Home).
- Whether AppLocker applies to processes started by the SYSTEM service
  (the agent, the launcher it starts) — Step 21.
- App Control on Home; CiTool refresh vs restart per build; whether
  removing an unsigned base policy needs a restart; Active-folder
  policies surviving feature updates — Step 21, later pilots.
- `ConfigCI` module availability on the dev machine's build (Step 6).
- Whether Windows 11 shows "Other user" when admin tiles are hidden
  (E-71).
- Whether BCD `recoveryenabled` is in BitLocker's validation set (only
  matters when BitLocker is on; plan avoids it).
- ETW `Microsoft-Windows-Kernel-Process` event fields used by procwatch on
  26300 and on Windows 10 22H2 — Step 21.
- WLAN profile behaviour for WPA3 transition mode on old adapters —
  Phase 6 pilot (no Wi-Fi on Hyper-V).
- Required privileges list for the agent service — measured in Step 21.
- Dependency versions of 4.22 — Step 1.
- Convex free-plan I/O figures (Phase 4 verified 1 GB on 2026-10-20; the
  referral figure is not verified) — post-Phase-5 I/O pass.
- ARM64 behaviour of every layer — no ARM64 VM; recorded as untested.

## 22. Sources

Research date for all sources: **2026-10-27**. URLs are the starting
points the implementing agent re-reads at the step that uses them.

App Control and AppLocker
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/feature-availability
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/applications-that-can-bypass-appcontrol
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/deploy-multiple-appcontrol-policies
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/citool-commands
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/deployment/deploy-appcontrol-policies-with-script
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/event-id-explanations
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/requirements-to-use-applocker
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/using-event-viewer-with-applocker
- https://learn.microsoft.com/en-us/windows/client-management/mdm/applocker-csp
- https://learn.microsoft.com/en-us/windows/client-management/mdm/using-powershell-scripting-with-the-wmi-bridge-provider
- https://support.microsoft.com/help/5024351

Policies, accounts, sign-in
- https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-admx-ctrlaltdel
- https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-localpoliciessecurityoptions
- https://learn.microsoft.com/en-us/windows/security/threat-protection/security-policy-settings/account-lockout-policy
- https://learn.microsoft.com/en-us/windows/win32/api/lmaccess/nf-lmaccess-netusermodalsset
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/settings-and-configuration
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-stickykeys

Services, boot, posture
- https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_required_privileges_infow
- https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-setserviceobjectsecurity
- https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--set
- https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/reagentc-command-line-options
- https://learn.microsoft.com/en-us/windows/win32/secprov/win32-encryptablevolume
- https://learn.microsoft.com/en-us/windows/win32/secprov/win32-tpm
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfirmwareenvironmentvariablew

ETW and event logs
- https://learn.microsoft.com/en-us/windows/win32/etw/about-event-tracing
- https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-enabletraceex2
- https://learn.microsoft.com/en-us/windows/win32/wes/windows-event-log

Wi-Fi and printers
- https://learn.microsoft.com/en-us/windows/win32/nativewifi/wlan-profileschema-elements
- https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/nf-wlanapi-wlansetprofile
- https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/nf-wlanapi-wlansetfilterlist
- https://learn.microsoft.com/en-us/windows/win32/printdocs/addprinter
- https://learn.microsoft.com/en-us/windows/win32/printdocs/installprinterdriverfrompackage
- https://support.microsoft.com/help/5005652

WebView2
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2permissionrequestedeventargs

Cryptography
- https://www.rfc-editor.org/rfc/rfc7748 · https://www.rfc-editor.org/rfc/rfc5869 · https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha
- https://github.com/paulmillr/noble-curves · https://github.com/paulmillr/noble-ciphers
- https://docs.rs/x25519-dalek · https://docs.rs/chacha20poly1305 · https://docs.rs/hkdf

Convex
- https://docs.convex.dev/production/state/limits · https://docs.convex.dev/scheduling/cron-jobs · https://docs.convex.dev/production/environment-variables

