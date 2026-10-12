# Phase 2 — Agent core (Windows service, enrollment, Staff account, shell, watchdog, IPC)

> **For the implementing agent:** follow this plan step by step. Each step
> has a **Done when** check — run it and see it pass before moving on.
> Read `CLAUDE.md` first, then the reading list in "Prerequisites". Do not
> build anything listed under Non-goals.
>
> **Two rules override everything else in this file:**
>
> 1. **Never run a destructive operation on the dev machine.** Destructive
>    means: creating, changing or deleting a Windows account; writing
>    Winlogon, policy or LSA values; loading another user's registry hive;
>    signing a session out; installing or removing the service. All of that
>    runs only on a VM or test PC, and only the **user** runs it. The code
>    enforces this with the test-machine guard (Step 3). **Never create the
>    guard marker yourself, on any machine.**
> 2. **Never remove the admin's way back.** The agent never writes the
>    machine-wide `HKLM\...\Winlogon\Shell` or `Userinit` values, never sets
>    `IgnoreShiftOverride` or `AutoLogonCount`, and never changes an
>    administrator account (password, groups, visibility, registry hive).

Research date for every version and Windows fact in this file: **2026-10-13**.
Items marked **(unverified)** could not be confirmed from a primary source;
the plan says how each one gets confirmed.

---

## Updates since this plan was written (13 October 2026)

Read this first. Where it disagrees with the text below, this section wins.

- **Progress:** Steps 0 to 5 are implemented and committed (contract 1.0
  types and codec, Win32 foundation and guard, named-pipe transport, agent
  skeleton with `SimPlatform`). **The next step is Step 5a.** The order
  from here is 5a, 6, 6a, 6b, 7, 8, … 15.
- **Open questions (Section 14):** the user answered them; see the table in
  `docs/plans/README.md`. Every Phase 2 answer matches this plan's
  recommendation.
- **Ctrl + Alt + Del is not an admin route** (PRD 9.5, 12, 12.4). Phase 5
  empties that screen for the Staff account, including Switch user. The
  routes to an administrator are the hidden exit (key combination + PIN,
  checked by the agent), Disable kiosk from the backend, holding Shift
  during startup, and `rulebox-agent recover` / `unenroll`. In Phase 2
  itself Switch user still physically works, so the "Disconnected
  session" handling and its VM checklist item stay, but nothing shows or
  documents it as the way out.
- **Protocol 1.1 addendum (written; second revision of this plan).** It
  answers Section 15 of `phase-3-staff-shell.md` (R1 to R11). Contract 1.0
  is unchanged; 1.1 is additive (minor 1, new capabilities `session`,
  `apps`, `adminExit`). Where to find it:
  - wire shapes: **Section 6.11**;
  - agent behaviour: **Sections 5.9** (employee session), **5.10** (admin
    exit and PIN), **5.11** (audit queue);
  - steps: new **Step 5a** (contract), amended **Step 6** (servers), new
    **Step 6a** (session and apps) and **Step 6b** (admin exit), and
    amendments marked "(1.1)" in Steps 7 to 15.
- **What else changed in this revision:**
  - The admin exit and its PIN are now Phase 2 work (they were listed as a
    Phase 5 non-goal). The real employee backend, the audit log backend
    and the dashboard settings stay in Phase 4, behind the seams named in
    Sections 5.9 to 5.11.
  - Admin-pipe failures such as `already_enrolled` and `compat_blocked`
    now have a wire form: error code `operation_failed` with
    `data.reason` (Section 6.7).
  - The data-directory startup check of Section 5.1 is now assigned to
    **Step 10** (it was in no step).
  - The Step 4 pipe test showed that a client open asking for bit `0x4`
    was accepted against a descriptor without it (run elevated). Section
    6.2 gains a second server check on the client side, and the VM
    checklist gains a probe run as the real Staff user (Section 10.2,
    "IPC security").
  - R5 to R8 are applied: four places may use the `windows` crate
    (Section 4.2), `gen:types` lists every exporting crate (Step 1 note),
    `vm-deploy.ps1` prefers a real `rulebox-staff.exe` (Step 14), and
    Ctrl + Alt + Del → Switch user is gone from the edge-case rows,
    security notes and checklist wording.
  - `rulebox-shell.exe` now speaks the IPC protocol for one purpose: the
    hidden exit on its fallback screen (Step 12). It therefore depends on
    `rulebox-ipc` and tokio.
- **How the code already differs from older text below** (follow the
  code): the wire enums use the hand-written `unknown_on_new_values!`
  macro in `types.rs` instead of `#[serde(other)]` (ts-rs cannot parse
  it); `TransportError` lives in `codec.rs`; `Deps` has no
  `backend_factory` yet (Step 8 adds it); `agent::run` creates a
  `watch::Sender<AgentSnapshot>` whose receiver is unused until Step 6;
  simulate mode starts no pipe until Step 6; there is no admin-pipe
  client helper until Step 5a.
- **Nothing in the 1.1 addendum has been run.** It was specified from the
  code of Steps 0 to 5 and from the two plans. Items that need a VM or a
  crate check are marked **(unverified)**.

## 1. Goal

At the end of Phase 2, on a **test VM**:

1. `rulebox-agent.exe` runs as a Windows service (`RuleboxAgent`,
   LocalSystem, automatic start, restarts itself after a crash).
2. An admin runs `rulebox-agent enroll <CODE>` from an elevated prompt.
   The agent registers the device in Convex, creates the local standard
   user `RuleboxStaff`, configures automatic sign-in with the password
   held as an LSA secret, and registers `rulebox-shell.exe` as that
   account's shell.
3. After a restart the PC signs in to `RuleboxStaff` by itself and shows
   the shell (a stand-in console program in this phase; the real Staff App
   arrives in Phase 3).
4. If the shell process dies it is back within about 2 seconds. If it
   keeps dying, a native "Contact your administrator" screen appears
   instead of a black screen.
5. The agent holds **one** Convex subscription to its own desired state,
   caches it on disk, and works from the cache when offline.
   `kioskEnabled: false` returns the PC to normal Windows;
   `kioskEnabled: true` locks it again.
6. The Staff App can talk to the agent over the IPC contract in Section 6,
   and that contract is frozen at version 1.0 for Phase 3.
7. `rulebox-agent recover` and `rulebox-agent unenroll` restore normal
   Windows even when the service is stopped or broken.
8. (1.1) The agent answers protocol 1.1: it checks the hidden-exit PIN
   itself and signs the Staff session out to the Windows sign-in screen,
   and it answers employee sign-in and the app catalogue from a fixture
   directory (the real employee backend is Phase 4).

On the **dev machine** everything except the real Win32 side effects is
built, unit-tested and runnable in `--simulate` mode, including a working
IPC endpoint that Phase 3 can develop against.

## 2. Non-goals (do NOT build in Phase 2)

| Not in Phase 2 | Belongs to |
|---|---|
| Staff App UI, Tauri commands, window tracking, the sign-in screen and the PIN dialog | Phase 3 |
| Dashboard screens, Convex Auth, groups/employees/apps UI, merging group and device desired state, rollout rings, **policy signing and verification**, fleet-size-based heartbeat interval | Phase 4 |
| The **real** employee directory (checking employee passwords against Convex), the **real** app catalogue, the audit log table and the mutation that receives audit records, dashboard settings for the exit PIN, key combination and power options. Phase 2 builds the agent side against fixtures and the seams of Sections 5.9 to 5.11 | Phase 4 |
| App install/update/remove, winget, file handlers, session cleanup on employee logout, storage quotas | Phase 4 |
| Lockdown policies for the Staff account (Task Manager, Win keys, Ctrl+Alt+Del options, `NoLogoff`, USB), App Control, the **process allow-list watchdog** (PRD 13.6 #2), hiding the admin tile, account lockout policy, device lock, broadcasts, Wi-Fi and printers, per-user tuning (PRD 22.2), kiosk performance profile (PRD 22.3), restricting the service's privileges | Phase 5 |
| MSI/WiX, installer UI, WebView2 bootstrap, code signing, how release builds satisfy the test-machine guard | Phase 6 |
| Agent self-update, Staff App update flow and version rollback (PRD 23.4, 23.9), Windows Update policy, Windows Event Log output | v1.x / later |
| Periodic rotation of the Staff password | later (the repair path in Step 10 is enough for v1) |

Phase 2 builds **seams** for three of these and nothing more: a
`signature` field carried next to the desired state (always `null` now),
`current.json` with one version entry, and reserved IPC method namespaces.
The 1.1 addendum adds three more seams for Phase 4: `EmployeeDirectory`
(Section 5.9), `AuditSink` (Section 5.11) and the agent-only keys of the
desired-state document (Section 5.10).

---

## 3. Prerequisites

### 3.1 Reading list (read these, in this order)

- `CLAUDE.md` (all of it).
- `docs/plans/phase-1-setup.md`, Steps 3, 4 and 7, to know what exists.
- `docs/prd.md` — only these sections: 3.2, 3.3, 5.1, 9.1, 9.4, 9.5, 10,
  11, 11.1, 12.1–12.3, 13.2, 13.5, 13.6 (rows 3, 4, 5, 8), 14, 15, 21,
  22.4, 22.5, 23.3, 23.7. For the 1.1 steps (5a, 6a, 6b) also 5.2, 5.3,
  12.4 and 13.6 row 6. Section 21 is locked: never re-open a decision.
  Lines 1–1690 of the PRD have escaped markdown (`\#`, doubled blank
  lines); that is cosmetic.
- Sections 4 to 6 of this file before writing any code.

### 3.2 What exists today (from Phase 1)

- Root `Cargo.toml`: workspace members `apps/agent`,
  `apps/staff-app/src-tauri`, `crates/*`; edition 2021; no
  `[workspace.dependencies]`, no lints.
- `crates/rulebox-policy`: `DesiredState`, `StorageConfig`, `Branding`,
  `EXAMPLE_DESIRED_STATE_JSON`; serde camelCase; ts-rs 12 with
  `#[ts(export)]`. The export directory comes from `TS_RS_EXPORT_DIR` in
  `.cargo/config.toml` (the Phase 1 plan text says `export_to`; the code is
  right, follow the code).
- `apps/agent`: a print-only stub (`rulebox-agent`).
- `apps/staff-app/src-tauri`: bare Tauri 2.12 app, crate `rulebox-staff`,
  no commands.
- `convex/`: `schema.ts` (8 tables) and `health.ts` (`ping`). No other
  functions.
- `packages/types/src/index.ts`: a **manual** barrel of generated files.
- Already in `Cargo.lock` through Tauri: `windows` 0.62.2, `tokio` 1.53.2,
  `tracing` 0.1.44. Use the same lines so nothing is compiled twice.

### 3.3 Decisions this plan assumes

Section 14 lists open questions with a recommendation each. The plan is
written for the recommended option. In Step 0 you show that list to the
user and wait. If the user picks a different option for any question,
stop and ask how the affected steps should change; do not improvise.

---

## 4. Architecture

### 4.1 Processes

```
Session 0 (SYSTEM)                      Staff session (standard user RuleboxStaff)
+--------------------------+            +----------------------------------------+
| rulebox-agent.exe        |  shell     | rulebox-shell.exe   (the registered    |
|  service host            |  pipe      |   shell; native, no WebView; stays     |
|  backend (Convex)        |<---------->|   alive; relaunches its child)         |
|  kiosk reconciler        |            |     |                                  |
|  launcher watchdog       |            |     +-- rulebox-staff.exe (Staff App,  |
|  IPC servers             |            |          Phase 3; IPC client)          |
+--------------------------+            +----------------------------------------+
        ^  admin pipe
        |
  rulebox-agent.exe enroll|status|unenroll   (elevated admin prompt)
```

- **Two-tier watchdog.** `rulebox-shell.exe` relaunches the Staff App
  (fast, in-session, works even when the agent is down). The agent makes
  sure `rulebox-shell.exe` itself is running in the Staff session and
  kills a hung Staff App. This is a deliberate change from PRD 23.7,
  recorded in Section 15.
- **The CLI never does privileged work itself** (except `recover`,
  `compat` and `service install|uninstall`). `enroll`, `status` and
  `unenroll` send a request to the running service over the admin pipe.
  Reason: secrets are encrypted with SYSTEM's DPAPI key, which an admin's
  process cannot use.

### 4.2 Crates and files

| Path | Crate | Kind | Responsibility |
|---|---|---|---|
| `crates/rulebox-policy/` | `rulebox-policy` | lib (exists) | `DesiredState`. Add one function only (Step 8) |
| `crates/rulebox-ipc/` | `rulebox-ipc` | lib (new) | The IPC contract: message types, framing codec, error codes, ts-rs export; named-pipe client (feature `client`) and server transport (feature `server`) |
| `crates/rulebox-win32/` | `rulebox-win32` | lib (new) | **Every** `unsafe` Win32 call in the workspace, behind safe functions; the test-machine guard |
| `apps/agent/` | `rulebox-agent` | bin (rewrite stub) | Service host, CLI, state store, backend client, kiosk reconciler, watchdog, IPC servers |
| `apps/shell-launcher/` | `rulebox-shell` | bin (new) | `rulebox-shell.exe`: the registered shell; starts and relaunches the Staff App; native fallback screen; (1.1) the hidden exit on that screen |
| `convex/` | — | TS | Enrollment, device auth, desired-state query, heartbeat, dev helpers |

`apps/shell-launcher` is covered by neither existing workspace glob, so
it is added to `members` explicitly.

Only **four known places** may use the `windows` crate: `rulebox-win32`
and `rulebox-shell` (this phase), and `crates/rulebox-desktop` and
`apps/staff-app/src-tauri/src/webapp/` (Phase 3 owns both; do not create
or edit them here). Reason: `windows` 0.100 will rename every feature
and module (Section 13), so the migration must stay in a short, known
list. `rulebox-agent` and `rulebox-ipc` never import `windows::`
directly; they call `rulebox-win32`.

```
crates/rulebox-ipc/
├─ Cargo.toml
├─ src/
│  ├─ lib.rs          # re-exports; PROTOCOL_MAJOR/MINOR; pipe names; limits
│  ├─ envelope.rs     # Frame, RpcError, ErrorCode
│  ├─ methods.rs      # Method trait + one unit struct per method
│  ├─ types.rs        # Hello*, AgentSnapshot and its parts (ts-rs export)
│  ├─ requests.rs     # (1.1) params/results of session.*, apps.list, adminExit.submit (not exported to TS)
│  ├─ hotkey.rs       # (1.1) the key-combination text format: parse, canonical form (pure)
│  ├─ admin.rs        # admin-pipe params/results, OperationFailure (not exported to TS)
│  ├─ codec.rs        # length-delimited JSON codec, TransportError
│  ├─ client.rs       # feature "client": IpcClient (connect, verify, call, events, reconnect); (1.1) call_once
│  └─ server.rs       # feature "server": PipeListener, Connection, PeerInfo
└─ examples/
   └─ fake_staff.rs   # stand-in Staff App for tests (console program)

crates/rulebox-win32/
├─ Cargo.toml
└─ src/
   ├─ lib.rs          # module list; `#![cfg(windows)]`
   ├─ error.rs        # Win32Error
   ├─ util.rs         # wide strings, OwnedHandle, LocalAllocGuard
   ├─ guard.rs        # test-machine guard
   ├─ sid.rs          # Sid type, well-known SIDs, lookups
   ├─ security.rs     # SDDL -> SECURITY_ATTRIBUTES, protected dirs, privileges
   ├─ pipe.rs         # pipe security attrs, peer verification, client open
   ├─ osinfo.rs       # version, edition, S mode, join state, RAM, disk (read-only)
   ├─ dpapi.rs        # protect / unprotect
   ├─ registry.rs     # typed get/set/delete, hive load/unload
   ├─ accounts.rs     # local users, groups, profiles
   ├─ lsa.rs          # LSA private data
   ├─ autologon.rs    # Winlogon values + LSA secret, journaled
   ├─ shellreg.rs     # per-user shell value in the Staff hive
   ├─ session.rs      # WTS enumeration, session -> SID, logoff
   └─ process.rs      # launch in session, find by image, wait, terminate

apps/agent/
├─ Cargo.toml
└─ src/
   ├─ main.rs         # panic hook, CLI dispatch
   ├─ cli.rs          # clap definitions
   ├─ paths.rs        # install dir, data dir, file names
   ├─ logging.rs      # tracing setup
   ├─ state.rs        # AgentState, Journal, atomic load/save
   ├─ secrets.rs      # Secrets (device secret, journaled passwords)
   ├─ platform/
   │  ├─ mod.rs       # Platform trait + data types
   │  ├─ sim.rs       # SimPlatform (in-memory; tests and --simulate)
   │  └─ windows.rs   # WindowsPlatform (calls rulebox-win32)
   ├─ enroll_code.rs  # enrollment code parsing
   ├─ backend/
   │  ├─ mod.rs       # Backend trait, DesiredFetch, types
   │  ├─ convex.rs    # ConvexBackend
   │  └─ value.rs     # convex::Value <-> serde_json
   ├─ compat.rs       # CompatReport + blocking rules
   ├─ kiosk.rs        # reconciler: enable / disable / repair
   ├─ watchdog.rs     # launcher presence + hang detection
   ├─ agent_policy.rs # (1.1) agent-only keys of the desired-state document (admin exit, power, org name)
   ├─ kdf.rs          # (1.1) Argon2id: hash, verify, parameter limits
   ├─ lockout.rs      # (1.1) rate limiting and lockout for the PIN and employee passwords, persisted
   ├─ audit.rs        # (1.1) audit queue on disk + AuditSink seam
   ├─ directory.rs    # (1.1) EmployeeDirectory seam, UnavailableDirectory, FixtureDirectory
   ├─ employee_cache.rs # (1.1) offline sign-in cache
   ├─ session.rs      # (1.1) SessionManager: session.* and apps.list
   ├─ admin_exit.rs   # (1.1) PIN gate, adminExit.submit, the sign-out flow
   ├─ fixtures.rs     # (1.1) demo document, employees and catalogue for --sim-demo and fixture mode
   ├─ ipc_shell.rs    # shell-pipe server, ShellExtension seam
   ├─ ipc_admin.rs    # admin-pipe server + CLI client helpers
   ├─ agent.rs        # run(): wires tasks, owns the snapshot
   ├─ service.rs      # windows-service host, install/uninstall
   └─ recover.rs      # offline recovery command

apps/shell-launcher/
├─ Cargo.toml
└─ src/
   ├─ main.rs         # single instance, supervise loop
   ├─ current.rs      # current.json parsing + path validation (pure)
   ├─ backoff.rs      # crash-loop logic (pure)
   ├─ fallback.rs     # native "Contact your administrator" window
   └─ exit.rs         # (1.1) hidden exit on the fallback screen: key combination, PIN field, adminExit.submit

convex/
├─ schema.ts          # changed
├─ lib/deviceAuth.ts  # new: sha256Hex, requireDevice
├─ enrollment.ts      # new: enroll
├─ devices.ts         # new: desiredState, heartbeat, unenroll
└─ dev.ts             # new: internal helpers for testing (no dashboard yet)

scripts/vm-deploy.ps1 # new: copies a debug build into Program Files on the VM
```

### 4.3 Paths and names on a kiosk PC

| Thing | Value |
|---|---|
| Install directory | `%ProgramFiles%\Rulebox\` (resolve with `FOLDERID_ProgramFiles`; never hardcode `C:`) |
| Agent binary | `<install>\rulebox-agent.exe` |
| Shell launcher | `<install>\rulebox-shell.exe` |
| Version pointer | `<install>\current.json` |
| Staff App | `<install>\versions\<version>\rulebox-staff.exe` |
| Data directory | `%ProgramData%\Rulebox\` (resolve with `FOLDERID_ProgramData`) |
| State | `<data>\state\agent-state.json`, `secrets.bin`, `desired-state.json`, optional `agent-config.json` |
| State (1.1) | `<data>\state\lockouts.json`, `employee-cache.json`, `audit-queue.json` |
| Employee files root (1.1) | `<Staff profile folder>\RuleboxFiles\<employee folder name>\`. The agent only **names** this path (Section 5.9); the Staff App creates and uses it |
| Agent logs | `<data>\logs\agent.YYYY-MM-DD.log`, 14 files kept |
| Launcher log | `%LOCALAPPDATA%\Rulebox\logs\shell-launcher.log` in the Staff profile, truncated at 1 MB |
| Service | name `RuleboxAgent`, display name `Rulebox Agent`, LocalSystem, automatic (not delayed) |
| Service command line | `"<install>\rulebox-agent.exe" service run` |
| Staff account | user name `RuleboxStaff`, full name `Staff`, comment `Managed by Rulebox. Do not edit or delete.` |
| Shell pipe | `\\.\pipe\dev.rulebox.agent.shell` |
| Admin pipe | `\\.\pipe\dev.rulebox.agent.admin` |
| Simulate-mode pipes | the two names above with `.sim` appended |
| Test-machine marker | `HKLM\SOFTWARE\Rulebox\TestMachine`, value `ComputerName` (REG_SZ) |

The data directory and everything in it gets the protected DACL
`D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` (SYSTEM and Administrators full
control, nobody else, no inheritance from `%ProgramData%`). The Staff
account can read nothing there; everything it needs comes over IPC.

`current.json`:

```json
{ "version": "0.0.0-dev", "exe": "versions\\0.0.0-dev\\rulebox-staff.exe" }
```

`exe` is relative to the install directory. The launcher and the agent
reject an absolute path, any `..` component, and anything that does not
resolve inside `<install>\versions\`.

### 4.4 Dependencies

**Pin by checking, not by guessing** (same rule as Phase 1). Before
writing a version run `cargo search <crate> --limit 1`. The "Found"
column is what research saw on 2026-10-13. If a newer **patch** exists,
use it. If a newer **minor or major** exists for a crate in the first
table, stop and ask.

Put all of these in `[workspace.dependencies]` in the root `Cargo.toml`
and reference them with `workspace = true`.

| Crate | Found | Requirement | Used by | Why |
|---|---|---|---|---|
| `windows` | 0.62.2 (2025-10-06) | `"0.62"` | win32, shell | Win32 bindings. Same line Tauri already compiles. **Do not** add `windows-core`, `windows-result` or `windows-strings` 0.100 directly: they are a newer, incompatible generation |
| `windows-service` | 0.8.1 (2026-05-08) | `"0.8.1"` | agent | Service dispatcher, control handler, typed session-change events, install API |
| `tokio` | 1.53.2 (2026-10-03, LTS line until 2027-09) | `"~1.53"` | ipc, agent | Runtime, named pipes, timers. Features: `rt-multi-thread`, `macros`, `net`, `time`, `sync`, `io-util`, `signal`; dev: `test-util` |
| `tokio-util` | 0.7.20 (2026-10-09) | `"0.7"` | ipc, agent | `LengthDelimitedCodec`, `CancellationToken`, `TaskTracker`. Features: `codec`, `rt` |
| `convex` | 0.10.4 (2026-04-10) | `"0.10.4"` | agent | Convex Rust client. CLAUDE.md requires at least 0.10.3; 0.10.4 also fixes a subscription memory leak (Section 14, Q9) |
| `serde`, `serde_json` | 1.0.229 / 1.0.154 | `"1.0"` | all | Already used |
| `ts-rs` | 12.0.1 | `"12.0"` | ipc | Already used by `rulebox-policy` |
| `tracing` | 0.1.44 | `"0.1.44"` | all Rust | Logging facade |
| `tracing-subscriber` | 0.3.23 | `"0.3.23"` | agent | Formatting layer |
| `tracing-appender` | 0.2.5 | `"0.2.5"` | agent | Daily rolling files with `max_log_files` |
| `thiserror` | 2.0.21 | `"2"` | libs | Typed errors in `rulebox-ipc` and `rulebox-win32` |
| `anyhow` | 1.0.104 | `"1"` | agent | Error context in the binary. The `convex` API also returns `anyhow::Result` |

Small helpers — confirm the current version with `cargo search` and pin
the latest stable:

| Crate | Used by | Why |
|---|---|---|
| `clap` (feature `derive`) | agent | CLI parsing |
| `futures-util` | ipc, agent | `SinkExt`/`StreamExt` for framed pipes and the subscription stream |
| `bytes` | ipc | Buffer type required by the codec |
| `sha2` | agent | SHA-256 of the device secret and enrollment token |
| `base64` | agent | Decoding the enrollment code |
| `getrandom` | agent | Device secret and Staff password from the OS random source |
| `argon2` (RustCrypto; default features, which include the PHC string support) | agent | (1.1) Argon2id for the exit PIN (verify) and the offline sign-in cache (hash and verify). PRD 13.6 #6 names Argon2id |

Notes:

- (1.1) Argon2 is far too slow in an unoptimized build (a debug-build
  check could take longer than the 10-second IPC timeout). Add to the
  root `Cargo.toml`, next to the existing `[profile.dev]`:

  ```toml
  [profile.dev.package.argon2]
  opt-level = 3
  [profile.dev.package.blake2]
  opt-level = 3
  ```

  If `cargo` warns that `blake2` is not in the dependency graph, remove
  that block and say so in the report. **(unverified)**
- (1.1) `rulebox-shell` additionally depends on `rulebox-ipc` with
  feature `client` (which brings tokio). This replaces the earlier "no
  tokio in the launcher" rule; the reason is in Step 12.

- `convex` default feature is `native-tls-vendored`. On Windows native-tls
  uses SChannel and the machine certificate store, so nothing should build
  OpenSSL. **If the build starts compiling `openssl-sys`, stop**: switch
  to `default-features = false, features = ["native-tls"]` and report it.
- Do not add `interprocess`, `tipsy`, `tonic`, `keyring`, `windows-dpapi`,
  `win-custody` or any Event Log crate. Research rejected each one.
- `windows` features to enable in `rulebox-win32` (verified against the
  0.62.2 source): `Win32_Foundation`, `Win32_Security`,
  `Win32_Security_Authorization`,
  `Win32_Security_Authentication_Identity`, `Win32_Security_Cryptography`,
  `Win32_System_Services`, `Win32_System_RemoteDesktop`,
  `Win32_System_Threading`, `Win32_System_Environment`,
  `Win32_System_Registry`, `Win32_System_Pipes`,
  `Win32_Storage_FileSystem`, `Win32_System_IO`,
  `Win32_System_SystemInformation`, `Win32_System_Memory`,
  `Win32_System_Diagnostics_ToolHelp`,
  `Win32_NetworkManagement_NetManagement`, `Win32_UI_Shell`,
  `Win32_System_Com`. `rulebox-shell` additionally needs
  `Win32_UI_WindowsAndMessaging`, `Win32_Graphics_Gdi`,
  `Win32_System_LibraryLoader`. Add a feature only when the compiler asks
  for it; use https://docs.rs/windows/0.62.2 (the pages on
  microsoft.github.io already describe 0.100 and will mislead you).

---

## 5. Agent behaviour

### 5.1 State on disk

```rust
// apps/agent/src/state.rs
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub schema: u32,                         // 1
    pub enrollment: Option<Enrollment>,
    pub pending_enrollment: Option<PendingEnrollment>,
    pub staff: Option<StaffAccount>,
    pub kiosk: KioskRecord,
    pub journal: Vec<JournalEntry>,          // original machine values we replaced
    pub last_applied_version: u64,           // highest desired-state version applied
    pub last_wall_clock_ms: u64,             // for clock-went-backwards detection
}
pub struct Enrollment { pub convex_url: String, pub device_id: String, pub org_id: String,
                        pub device_name: String, pub enrolled_at_ms: u64, pub revoked: bool }
pub struct PendingEnrollment { pub convex_url: String, pub token_sha256: String, pub started_at_ms: u64 }
pub struct StaffAccount { pub sid: String, pub user_name: String }
pub struct KioskRecord { pub applied: KioskApplied, pub last_error: Option<String>, pub failures: u32 }
pub enum KioskApplied { NotApplied, Enabled, Disabled }      // default NotApplied
pub struct JournalEntry { pub key: RegValueRef, pub original: OriginalValue }
pub enum OriginalValue { Absent, Dword(u32), String(String), InSecrets }   // InSecrets: value is sensitive, see Secrets

// apps/agent/src/secrets.rs  (serialized to JSON, then DPAPI-protected, then written)
pub struct Secrets { pub device_secret: Option<String>,          // 64 hex chars
                     pub pending_device_secret: Option<String>,
                     pub original_default_password_registry: Option<String>,
                     pub original_default_password_lsa: Option<String> }
```

- **Atomic writes.** Write `<name>.tmp`, `sync_all`, then rename over the
  target. On load, a missing file is the default value; a file that does
  not parse is renamed to `<name>.corrupt-<unix ms>` and logged as an
  error, then treated as missing.
- **Secrets** are encrypted with `CryptProtectData` **without**
  `CRYPTPROTECT_LOCAL_MACHINE` (so only SYSTEM can decrypt; with that flag
  any local process could). Never log a secret, a password, an enrollment
  code or an enrollment token. `Debug` for `Secrets` prints `<redacted>`.
- **Startup check (built in Step 10; it was missing from every step).**
  Before anything reads or writes the real data directory, the agent
  verifies that it is a real directory (not a reparse point), is owned by
  SYSTEM or Administrators, and has the protected DACL. Reason: standard
  users may create folders under `%ProgramData%` and could plant one
  first. The rules:

  | `verify_protected_dir(<data>)` says | Directory is empty | Action |
  |---|---|---|
  | does not exist | — | `create_protected_dir`, then verify again |
  | is a reparse point | any | **refuse** |
  | `is_ok()` | any | use it |
  | owner is SYSTEM or Administrators, DACL differs | yes | `create_protected_dir` (it replaces the DACL), then verify again |
  | owner is anyone else | yes | `std::fs::remove_dir` (not recursive), `create_protected_dir`, then verify again |
  | not `is_ok()` | no | **refuse** |

  "Verify again" must return `is_ok()`, otherwise refuse (this also
  covers someone re-creating the folder between the two calls). "Refuse"
  means: print the reason to stderr, write **nothing** into the
  directory (no log file either), and exit; in service mode stop with
  `ServiceExitCode::ServiceSpecific(2)`. The check runs **before**
  `logging::init`, because logs live inside the data directory.
  - Only three commands open the real data directory: `service run`,
    `run --console` without `--simulate`, and `recover`. The first two
    run the check (and repair) first; `recover` only verifies and never
    repairs (Step 11). `service install` creates the directory through
    the same function. No other command (`enroll`, `status`, `unenroll`, `compat`,
    `hash-pin`) initialises file logging or opens the state store; they
    talk to the service over the admin pipe or only read.
  - Simulate mode skips the check: its data directory is under
    `target\`.

**Files added by the 1.1 addendum** (same atomic-write and corrupt-file
rules; all inside `<data>\state\`, so the Staff account can read none of
them):

| File | Holds | Defined in |
|---|---|---|
| `lockouts.json` | Failure counters and lock times for the exit PIN (one per device) and for employee passwords (one per username) | Section 5.10, `lockout.rs` |
| `employee-cache.json` | Per employee who signed in online on this PC: profile, app catalogue, Argon2id hash of the password, time of the last online sign-in | Section 5.9, `employee_cache.rs` |
| `audit-queue.json` | Audit records not yet accepted by the backend | Section 5.11, `audit.rs` |

`AgentState` gains one field: `StaffAccount.profile_dir: Option<String>`
(`#[serde(default)]`), the Staff profile folder returned by
`ensure_profile`, saved in Enable step 3 (Section 5.6). The exit PIN's
hash is **not** copied into `AgentState` or `Secrets`: it stays inside
the cached desired-state document (`desired-state.json`), which is in the
same protected directory.

### 5.2 Tasks inside the service

`agent::run(deps, shutdown: CancellationToken, control_rx)` starts these
tokio tasks and is the single entry point for both service mode and
console mode:

| Task | Owns | Triggered by |
|---|---|---|
| `backend` | Convex client, subscription, heartbeat timer | enrollment state, connection state |
| `reconciler` | all kiosk changes (the only task that calls mutating `Platform` methods) | `Trigger` channel: `Startup`, `DesiredChanged`, `Session`, `Power`, `Reassert` (every 10 minutes), `Admin` |
| `watchdog` | launcher presence, hang detection | session events, 5-second tick while kiosk is enabled, shell heartbeats |
| `ipc_shell` | shell pipe; calls the `ShellExtension`s (`SessionManager`, `AdminExit`) for 1.1 methods | Staff SID known |
| `ipc_admin` | admin pipe | always |
| `audit` (1.1) | delivery of the audit queue through `AuditSink` | a new record, or the connection becoming `online` |

The 1.1 request handlers run inside the `ipc_shell` connection tasks.
They never call a mutating `Platform` method themselves: the one
privileged action (signing the Staff session out after a correct PIN) is
sent to the `reconciler` as a request (Section 5.10).

Shared state is one `tokio::sync::watch::Sender<AgentSnapshot>`
(Section 6.6). Tasks never share a mutex over Win32 state.

Runtime: `tokio::runtime::Builder::new_multi_thread().worker_threads(2)`.
Blocking Win32 calls (account creation, hive loading, `LogonUserW`) run
in `spawn_blocking`.

### 5.3 The `Platform` seam

All OS access goes through one trait so the logic is testable without
Win32. `SimPlatform` keeps everything in memory and can inject failures.
`WindowsPlatform` forwards to `rulebox-win32`.

```rust
// apps/agent/src/platform/mod.rs
pub trait Platform: Send + Sync + 'static {
    // read-only
    fn os_info(&self) -> Result<OsInfo, PlatformError>;
    fn computer_name(&self) -> Result<String, PlatformError>;
    fn other_enabled_local_admins(&self, exclude_sid: Option<&str>) -> Result<Vec<String>, PlatformError>;
    fn legal_notice_present(&self) -> Result<bool, PlatformError>;
    fn find_local_user(&self, user_name: &str) -> Result<Option<LocalUser>, PlatformError>;
    fn read_machine_value(&self, key: &RegValueRef) -> Result<Option<RegData>, PlatformError>;
    fn sessions(&self) -> Result<Vec<SessionInfo>, PlatformError>;
    fn find_processes(&self, session_id: u32, image_path: &Path) -> Result<Vec<u32>, PlatformError>;
    fn shell_binaries_ok(&self) -> Result<ShellBinaries, PlatformError>;   // launcher + current.json target exist

    // mutating — every WindowsPlatform implementation calls guard::require_test_machine() first
    fn create_staff_user(&self, spec: &StaffUserSpec, password: &str) -> Result<String /*sid*/, PlatformError>;
    fn set_user_password(&self, user_name: &str, password: &str) -> Result<(), PlatformError>;
    fn test_logon(&self, user_name: &str, password: &str) -> Result<bool, PlatformError>;
    fn ensure_profile(&self, sid: &str, user_name: &str) -> Result<PathBuf, PlatformError>;
    fn delete_staff_user(&self, sid: &str, user_name: &str) -> Result<(), PlatformError>;
    fn write_machine_value(&self, key: &RegValueRef, data: Option<&RegData>) -> Result<(), PlatformError>; // None = delete
    fn lsa_secret_get(&self, name: &str) -> Result<Option<String>, PlatformError>;
    fn lsa_secret_set(&self, name: &str, value: Option<&str>) -> Result<(), PlatformError>;
    fn set_staff_shell(&self, sid: &str, mechanism: ShellMechanism, command: Option<&str>) -> Result<(), PlatformError>;
    fn set_staff_user_policy(&self, sid: &str, name: &str, value: Option<u32>) -> Result<(), PlatformError>;
    fn logoff_session(&self, session_id: u32) -> Result<(), PlatformError>;
    fn launch_in_session(&self, session_id: u32, expected_sid: &str, exe: &Path) -> Result<u32 /*pid*/, PlatformError>;
    fn terminate_process(&self, pid: u32, expected_image: &Path, expected_sid: &str) -> Result<(), PlatformError>;
    fn secrets_load(&self) -> Result<Option<Vec<u8>>, PlatformError>;   // already unprotected
    fn secrets_save(&self, plaintext: &[u8]) -> Result<(), PlatformError>;
}

pub struct OsInfo { pub build: u32, pub ubr: u32, pub display_version: String, pub edition_id: String,
                    pub product_type: u32, pub arch: String, pub s_mode: bool,
                    pub domain_joined: bool, pub entra_joined: bool,
                    pub ram_mb: u64, pub system_disk_free_gb: u64 }
pub struct SessionInfo { pub id: u32, pub state: SessionState, pub user_sid: Option<String>, pub is_console: bool }
pub enum SessionState { Active, Connected, Disconnected, Other }
pub struct LocalUser { pub sid: String, pub comment: String, pub disabled: bool }
pub enum ShellMechanism { PolicyShell, WinlogonShell }       // default PolicyShell
pub struct RegValueRef { pub path: String, pub name: String }   // always under HKLM
pub enum RegData { Dword(u32), String(String) }
#[derive(thiserror::Error, Debug)]
pub enum PlatformError { #[error("blocked by the test-machine guard: {0}")] Guard(String),
                         #[error("already exists")] AlreadyExists,
                         #[error("not found")] NotFound,
                         #[error("access denied")] AccessDenied,
                         #[error("password rejected by local policy")] PasswordPolicy,
                         #[error("win32 error {code} in {api}")] Win32 { api: &'static str, code: u32 },
                         #[error("{0}")] Other(String) }
```

### 5.4 Enrollment

**Enrollment code format** (PRD 15: the code contains the Convex URL and
an enrollment token):

```
RBX1.<base64url, no padding, of the UTF-8 string "<convexUrl>#<token>">
```

- `<convexUrl>` is the deployment URL, for example
  `https://happy-animal-123.convex.cloud`. The agent accepts only
  `https://` URLs with a host and no path, query or user-info.
- `<token>` is 20 characters of Crockford base32 (alphabet
  `0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 100 bits of entropy, generated on
  the server. With that entropy, guessing is not a practical attack, so
  Phase 2 adds no rate-limiter dependency.
- Parsing trims whitespace, is case-sensitive on the prefix `RBX1.`, and
  returns a typed error for: wrong prefix, bad base64, missing `#`, bad
  URL, token of the wrong length or alphabet.
- The server stores only `sha256(token)` as lowercase hex.

**Flow** (`admin.enroll` on the admin pipe; the reconciler task executes
it so nothing else mutates the machine at the same time). Every "fail
with `<name>`" below is reported on the admin pipe as the error code
`operation_failed` with `data.reason = "<name>"` (Section 6.7); these
names are **not** values of `ErrorCode`:

1. If `enrollment` is present and not revoked: fail with
   `already_enrolled`.
2. Parse the code.
3. Build the `CompatReport` (Section 5.5). If it has a blocker: fail with
   `compat_blocked` and the list. Nothing has been changed yet.
4. If `pending_enrollment` exists **and** its URL and `token_sha256`
   match, reuse `pending_device_secret`. Otherwise generate a new device
   secret (32 random bytes, hex). Save secrets first, then save
   `pending_enrollment`. This order makes a retry after a lost response
   idempotent.
5. Call `enrollment:enroll` with a **30-second timeout** (the Convex Rust
   client waits forever when offline; every one-shot call in the agent is
   wrapped in `tokio::time::timeout`).
   - Timeout or network error: keep `pending_enrollment`, return
     `backend_unreachable` (`retryable: true`).
   - Server error code `token_invalid`, `token_expired`, `token_used_up`,
     `token_revoked`: clear `pending_enrollment` and the pending secret,
     return that code.
6. On success: move the pending secret to `device_secret`, write
   `enrollment`, clear `pending_enrollment`, save.
7. Start the backend task, send `Trigger::DesiredChanged`, and wait up to
   120 seconds for the first reconcile to finish. Return
   `{ deviceId, deviceName, kiosk: <KioskStatus> }`. A kiosk failure is
   **not** an enrollment failure: the device stays enrolled, the error is
   returned and reported, and the reconciler retries (Section 5.6).

### 5.5 Compatibility report

`compat.rs` builds a `CompatReport { os: OsInfo, blockers: Vec<Blocker>,
warnings: Vec<Warning> }` from `Platform` read-only methods. It is sent
to the backend at enrollment and printed by `rulebox-agent compat`.

| Condition | Result | Code |
|---|---|---|
| Build below 19045 (Windows 10 22H2) | Block | `os_too_old` |
| Windows in S mode | Block | `s_mode` |
| Domain-joined or Entra-joined, and `--allow-joined` not given | Block | `managed_device` |
| No enabled local administrator account other than the Staff account | Block | `no_other_admin` |
| A sign-in legal notice is configured (`LegalNoticeCaption` or `LegalNoticeText` non-empty in `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon` or `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`) | Block (Windows documents that automatic sign-in does not work with a banner; the agent never deletes someone's banner) | `legal_notice` |
| Launcher or Staff App binary missing | Block | `shell_binary_missing` |
| System drive has less than 2 GB free | Warn | `low_disk` |
| ARM64 | Warn | `arm64_untested` |
| RAM at most 4,352 MB | Info only; sets display mode `lite` | — |

The agent does **not** decide "OS out of support" (PRD 13.6 #4): it
reports `build`, `ubr` and `editionId`, and the backend or dashboard
applies lifecycle dates in Phase 4. Lifecycle dates baked into an agent
would go stale.

### 5.6 Kiosk reconciler

Input: the effective desired state. Rule for "effective":

- Not enrolled: nothing to do.
- Enrolled, a desired state was received or is cached: use it.
- Enrolled, none received and none cached: use
  `DesiredState::enrollment_default()` (`kioskEnabled: true`, everything
  else empty, `version: 0`). Reason: PRD 9.1 step 5 says enrollment itself
  sets up the Staff account, auto sign-in and shell.
- A received document with `version` lower than `last_applied_version` is
  ignored and logged (stale). Equal version with different content is
  applied and logged as a warning.

`kiosk::reconcile(target)` is **idempotent**: it inspects the machine and
changes only what differs. It runs on every trigger, so drift (for
example Windows overwriting `DefaultUserName` after an admin signed in)
is repaired automatically.

**Enable** (in this order; stop at the first failure):

1. `compat` blockers re-checked (`no_other_admin`, `legal_notice`,
   `managed_device`, `shell_binary_missing`). A blocker fails the enable
   with that code.
2. **Staff account.**
   - `state.staff` present and `find_local_user` returns the same SID:
     keep.
   - No account named `RuleboxStaff`: generate a password (32 characters
     from upper, lower, digits and `!#%+-_=`, at least one of each class),
     store it as the LSA secret `L$RuleboxStaffPending`, call
     `create_staff_user` (standard user, member of the built-in Users
     group, flags: password never expires, user cannot change password),
     save `state.staff`.
   - An account named `RuleboxStaff` exists but `state.staff` is empty or
     has a different SID: adopt it **only if** its comment equals the
     Rulebox comment in Section 4.3 exactly; then generate and set a new
     password as above. Otherwise fail with `staff_account_conflict` and
     change nothing. Never adopt or reset an account Rulebox did not
     create.
3. **Profile.** `ensure_profile` (creates the profile if the account has
   never signed in, so its registry hive exists). Returns the real profile
   path; never assume `C:\Users\RuleboxStaff`. (1.1) Save the path as
   `state.staff.profile_dir` and tell the `SessionManager`
   (`set_files_base(<profile>\RuleboxFiles)`, Section 5.9).
4. **Staff hive values** (per user, journal not needed because the whole
   account is ours):
   - shell value = `"<install>\rulebox-shell.exe"` (with the quotes) using
     the configured `ShellMechanism`;
   - `DisableLockWorkstation = 1` (nobody knows the Staff password, so a
     locked Staff session would be a dead end).
5. **Machine values**, each journaled the first time it is changed
   (`journal` keeps the original once and never overwrites it):

   | Key under HKLM | Value | Set to |
   |---|---|---|
   | `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon` | `AutoAdminLogon` (REG_SZ) | `"1"` |
   | same | `DefaultUserName` (REG_SZ) | `RuleboxStaff` |
   | same | `DefaultDomainName` (REG_SZ) | the computer name |
   | same | `DefaultPassword` (REG_SZ) | **deleted** (original kept in `Secrets`, journal `InSecrets`) |
   | same | `AutoLogonCount` | **deleted** (it would switch auto sign-in off after N boots) |
   | `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System` | `DisableAutomaticRestartSignOn` (DWORD) | `1` |
   | same | `EnableFirstLogonAnimation` (DWORD) | `0` |
   | `SOFTWARE\Policies\Microsoft\Windows\OOBE` | `DisablePrivacyExperience` (DWORD) | `1` |

6. **LSA secret `DefaultPassword`** = the Staff password. If a secret of
   that name already existed and is not ours, keep the original in
   `Secrets.original_default_password_lsa` first. Then delete
   `L$RuleboxStaffPending`.
7. **Password check.** At service start and after step 6 (not on every
   trigger), call `test_logon("RuleboxStaff", <LSA password>)` once. If it
   fails, repair: generate a new password, store it as pending, call
   `set_user_password`, store `DefaultPassword`, clear pending. Call
   `test_logon` at most once per repair; repeated failures feed the local
   lockout counter (Windows 11 22H2+ locks an account after 10 bad
   attempts by default).
8. Save `kiosk.applied = Enabled`, clear `last_error` and `failures`.

Kiosk mode takes effect at the next sign-out or restart. The agent does
not sign the current admin out.

**Disable** (also the rollback path; every step runs even if an earlier
one failed, errors are collected):

1. Restore every journaled machine value to its original (delete if the
   original was `Absent`; restore from `Secrets` if `InSecrets`). Clear
   the journal entries that were restored.
2. LSA `DefaultPassword`: restore the original if one was kept, else
   delete. Delete `L$RuleboxStaffPending`.
3. Staff hive: delete the shell value (both mechanisms' locations) and
   `DisableLockWorkstation`, so a Staff sign-in would get Explorer.
4. If a Staff session exists: broadcast the IPC event
   `agent.shuttingDown { reason: "kioskDisabled", graceMs: 10000 }`, wait
   10 seconds, then `logoff_session`. The PC is then at the Windows
   sign-in screen.
5. Keep the account and its profile (employee files live there). Save
   `kiosk.applied = Disabled`.

**Failure handling.** If Enable fails at any step, run Disable
immediately (partial changes are rolled back), set `last_error`,
increment `failures`, and retry on the next trigger or after
1, 5, then 15 minutes (15 is the cap). The current error is visible in
`rulebox-agent status`, in the IPC snapshot and in the next heartbeat.

**Session rule for a locked Staff console.** On a session-lock event for
a session whose user is Staff while kiosk is enabled: wait 10 seconds;
if that session is still `Active` and is the console session, sign it
out (automatic sign-in then brings the shell back). If it became
`Disconnected`, leave it alone (until Phase 5 empties the Ctrl + Alt +
Del screen, Switch user can still produce this state; it is handled, but
it is not a documented admin route). This covers Automatic Restart
Sign-On locking the session after an update restart.

**Exit hold (1.1).** After a correct exit PIN the reconciler treats
`AutoAdminLogon = "0"` as the wanted value instead of drift, so the
Staff account is not signed straight back in. Section 5.10 defines when
the hold starts and ends. While it is active, every other value of
Enable is still re-asserted as usual.

### 5.7 Launcher watchdog

While kiosk is `Enabled`, on every session event and every 5 seconds:

1. Find the session whose user SID equals the Staff SID and whose state
   is `Active`. None: nothing to do.
2. `find_processes(session, <install>\rulebox-shell.exe)`. Found: record
   it and go to step 4.
3. Not found: if this has been true for 3 consecutive seconds (Winlogon
   may still be starting it), call `launch_in_session`. If
   `launch_in_session` fails 5 times in a row, log an error, set the
   snapshot's `shell.health` to `failed`, and keep retrying every
   30 seconds.
4. **Hang detection.** The Staff App must call `shell.heartbeat` every
   10 seconds once it has called `shell.ready`. If a shell connection was
   ready and then 30 seconds pass with no heartbeat on any shell
   connection, terminate the verified client process (the PID recorded at
   connection time, re-checked against image path and SID). The launcher
   relaunches it. Terminate at most once per 60 seconds. Controlled by
   `agent-config.json` → `"killHungShell": true` (default).
5. **Health for PRD 23.4 step 8.** `shell.health` in the snapshot is
   `starting` from launcher start until `shell.ready`, `healthy` while
   heartbeats arrive, `unhealthy` after 30 seconds without `shell.ready`
   or heartbeats, `notRunning` when there is no Staff session.

The agent never ties the shell to its own lifetime: no job object with
kill-on-close. If the agent crashes, the shell keeps running and the
restarted agent finds it again by image path, session and owner.

### 5.8 Backend client

- **Device authentication (Section 14, Q1).** Every device function takes
  `deviceId` and `deviceSecret` as arguments. The server hashes the
  secret and compares it with `devices.secretHash`. There is no JWT and
  no `auth.config.ts` in Phase 2.
- **One subscription:** `devices:desiredState`. No polling of desired
  state anywhere.
- **Offline at boot.** `ConvexClient::new` does not touch the network; it
  fails only on a malformed URL. The client reconnects by itself (100 ms
  to 15 s backoff, 30 s liveness check). The agent loads
  `desired-state.json` first and reconciles from it, then lets the
  subscription update it.
- **Connection state** comes from
  `ConvexClientBuilder::with_on_state_change` (a channel of capacity 16
  that the backend task always drains). It drives `connection` in the
  snapshot.
- **Subscription results:**
  - `{ kind: "ok", desired: null }` → no document yet; effective state per
    Section 5.6.
  - `{ kind: "ok", desired: { version, doc, signature } }` → parse `doc`
    into `DesiredState`. On a parse error keep the previous state and log
    and report `desired_state_invalid`. `signature` is ignored and must be
    `null` in Phase 2; log one warning at startup: "policy signatures are
    not verified until Phase 4".
  - `{ kind: "revoked" }` or `{ kind: "unknownDevice" }` → set
    `enrollment.revoked = true`, stop the backend task, **keep the
    current kiosk state** (a remote revocation must never unlock a PC),
    snapshot `enrollment: "revoked"`.
- **Value conversion.** Convex numbers are 64-bit floats, so `version`
  arrives as `42.0`. `backend/value.rs` converts `convex::Value` to
  `serde_json::Value` and turns every finite float with no fractional
  part and absolute value below 2^53 into a JSON integer; otherwise
  `serde` refuses to read it as `u64`. Check docs.rs for an existing
  export/JSON conversion on `convex::Value` first and reuse it for
  everything except this number rule.
- **Heartbeat.** After each transition to `Connected`, wait a random
  0–10 seconds (PRD 13.6 #5: jitter on reconnect), then call
  `devices:heartbeat`. Send the `status` object only when it differs from
  the last one the server accepted (compare the serialized JSON). The
  result's `nextPingInMs` schedules the next call, with ±10% jitter.
  A failed or timed-out heartbeat is retried at the next scheduled time,
  not in a tight loop.
- **Clock.** The agent never rejects anything because of its own clock:
  token expiry and revocation are decided on the server. It stores
  `serverTimeMs - localNowMs` as `serverTimeOffsetMs`. If the local clock
  is more than 24 hours **behind** `last_wall_clock_ms`, it sets
  `clockSuspect: true` in the snapshot and logs it (a dead CMOS battery
  breaks TLS before any Rulebox logic runs, so the Staff App needs to be
  able to say "fix the date and time").
- **Known client limits to respect:** one-shot calls hang offline (always
  use the timeout); the client has no proxy support (document it, do not
  work around it).

### 5.9 Employee session (protocol 1.1)

Serves `session.signIn`, `session.signOut`, `session.get`,
`session.verifyPassword` and `apps.list` (wire shapes in Section 6.11).
Code: `session.rs` (`SessionManager`), `directory.rs`,
`employee_cache.rs`, `lockout.rs`, `kdf.rs`. Built in Step 6a.

**The seam Phase 4 replaces.** The agent never talks to an employee
backend directly; it asks this trait:

```rust
// apps/agent/src/directory.rs
pub trait EmployeeDirectory: Send + Sync + 'static {
    /// false = this build cannot check employees at all. The agent then does not
    /// list the `session` and `apps` capabilities in `hello`.
    fn available(&self) -> bool;
    /// One online check of one username and password. Never retries, never caches.
    /// The caller applies the timeout and the rate limit.
    fn verify<'a>(&'a self, username: &'a str, password: &'a str)
        -> BoxFuture<'a, Result<DirectoryAnswer, DirectoryError>>;
}
pub enum DirectoryAnswer { Ok(DirectoryEmployee), WrongCredentials, Disabled, LockedOut { retry_after_ms: u64 } }
pub struct DirectoryEmployee { pub employee: Employee,        // rulebox_ipc::requests::Employee
                               pub apps: Vec<AppEntry>,        // rulebox_ipc::requests::AppEntry; the employee's whole catalogue
                               pub offline_days: u32 }         // how long offline sign-in stays allowed; 0 = never
pub enum DirectoryError { Unreachable, Unavailable }
```

| Implementation | Used when | Behaviour |
|---|---|---|
| `UnavailableDirectory` | The real agent, by default, until Phase 4 | `available()` is false; `verify` returns `Unavailable` |
| `FixtureDirectory` | `run --console --simulate --sim-demo`; and the **real** agent only when `agent-config.json` has `"fixtureDirectory": true` **and** `rulebox_win32::guard::is_test_machine()` is true | Answers from `fixtures.rs` (Section 6.11, "Simulated agent"). The real agent logs a warning at every start: "fixture employee directory is ON (test machine only)". Without the marker the setting is ignored and logged |
| `ConvexDirectory` | Phase 4 | One Convex call per sign-in that returns the employee **and** the catalogue (PRD 11.1 rule 1). `apps.list` never calls the backend |

`Deps` gains `directory: Arc<dyn EmployeeDirectory>`. Phase 4 changes
only the value put there; the contract and `SessionManager` stay.

**Session state.** One per device, in memory only:
`Option<ActiveSession { employee, apps, files_root, offline }>`. It is
**not** written to disk. After an agent restart `session.get` returns no
employee and the Staff App must ask for the password again. Reason: a
stored session cannot be tied safely to one Windows logon, and after a
power cut the next person would become the previous employee. The session
is cleared by `session.signOut`, when the Staff Windows session ends
(session event), after a correct exit PIN, and when the device becomes
revoked.

**`session.signIn`, exactly:**

1. Not enrolled → error `not_enrolled`. Enrollment revoked → error
   `denied_by_policy`.
2. Normalize `username`: trim, then Unicode lowercase. Empty or longer
   than 64 characters, or `password` empty or longer than 256 characters
   → error `invalid_params`.
3. A session exists for a **different** username → error
   `denied_by_policy` ("another employee is signed in"). The same
   username is allowed and replaces the session (this is how the Staff
   App recovers after an agent restart).
4. Take the sign-in gate (one `tokio::sync::Mutex` for `signIn` and
   `verifyPassword` together) with `try_lock`. Already taken → error
   `busy`. One check at a time keeps parallel requests from racing the
   failure counter.
5. Ask the device-wide guard and this username's counter in the lockout
   store (both below). Either one locked → outcome `lockedOut` with
   `retryAfterMs`. The password is not checked. Every failure that
   stays counted is also recorded in the device-wide guard.
6. **Count first:** record a failure for this username and save
   `lockouts.json` **before** checking anything. A success in step 7 or 8
   clears it. This way killing the agent in the middle of a check never
   gives a free guess.
7. **Online path**, only when the snapshot's `connection` is `online`:
   `directory.verify` under a 6-second timeout.
   - `Ok(e)` → clear the counter; hash the password with Argon2id in
     `spawn_blocking` and store the cache entry (below); start the
     session with `offline: false`; outcome `ok`.
   - `WrongCredentials` → outcome `wrongCredentials` (or `lockedOut` if
     this failure reached a lock). The offline cache is **not** tried.
   - `Disabled` → remove this username's cache entry; undo the counted
     failure; outcome `disabled`.
   - `LockedOut` → undo the counted failure; outcome `lockedOut` with the
     server's `retryAfterMs`.
   - `Unreachable`, `Unavailable` or the timeout → go to step 8.
8. **Offline path** (`connection` is not `online`, or step 7 fell
   through):
   - no cache entry for this username → undo the counted failure;
     outcome `offlineNeverSignedIn`;
   - entry expired (see below) → undo the counted failure; outcome
     `offlineExpired`;
   - Argon2id check in `spawn_blocking`: no match → outcome
     `wrongCredentials` (or `lockedOut`); match → clear the counter,
     start the session with `offline: true`, outcome `ok`.
9. The whole request has an 8-second budget in the agent. Past it →
   error `timeout` (`retryable: true`); the counted failure is undone.

**`session.verifyPassword`** (the Staff App's employee lock): no session
→ error `not_signed_in`. Otherwise steps 4 to 6 above, then one Argon2id
check against the **current employee's cache entry** (it always exists:
an online sign-in writes it and an offline sign-in used it). It never
calls the directory, so it works offline and is fast.

**`session.signOut`**: clears the session; no session is still a success.
Closing the employee's apps and wiping app data folders (PRD 5.3) is
Phase 4. **`session.get`** returns the session or nulls. **`apps.list`**:
no session → error `not_signed_in`; otherwise the session's `apps`.
Icons: an `iconPngBase64` longer than 43,692 characters (32 KiB decoded)
is replaced by null; if the serialized result is still above 900,000
bytes every icon is set to null and a warning is logged, so the reply
always fits one frame.

**Files root.** `filesRoot` is
`<files base>\<folder name>`, where `<files base>` is
`<Staff profile folder>\RuleboxFiles` (`state.staff.profile_dir`; in
`--sim-demo` it is `<data dir>\sim-files`) and `<folder name>` is the
employee id if it matches `^[A-Za-z0-9_-]{1,64}$`, otherwise the first
32 hex characters of its SHA-256. **The agent only builds this string.
It never creates, opens or lists the folder.** Reason: the folder is in
a place the Staff account can write, and a SYSTEM process that creates
folders there can be tricked with a planted link into writing somewhere
else. The Staff App, running as Staff, creates the folder (this differs
from Phase 3's R1 text; it is on the list for Phase 3 in Section 12). If the files base is not known yet (the Staff account was never
set up) → error `internal`, `retryable: true`, message "the Staff
account is not set up yet".

**Offline cache** (`employee-cache.json`). Entry: `username`,
`employee`, `apps`, `passwordHash` (Argon2id PHC string), `offlineDays`,
`lastOnlineMs`. At most 50 entries; the one with the oldest
`lastOnlineMs` is dropped first. An entry is **expired** when
`offlineDays == 0` or
`max(now, state.last_wall_clock_ms) - lastOnlineMs > offlineDays × 86,400,000`.
Using the larger of the two clocks means setting the clock back never
extends the period. The plain password is never stored and never logged.

**Argon2id** (`kdf.rs`), one set of constants for both the cache and the
PIN: Argon2id, version 19, memory 19,456 KiB, 2 passes, 1 lane, 16-byte
random salt, 32-byte output, PHC string format. A hash that comes from
outside (the PIN) is accepted only if it is `argon2id`, `v=19`, memory
8,192 to 65,536 KiB, passes 1 to 10, lanes 1 to 4; anything else is
"invalid" (a hostile document must not be able to make the agent
allocate gigabytes).

```rust
// apps/agent/src/kdf.rs
pub fn hash_secret(secret: &str) -> Result<String, KdfError>;                 // PHC string, fresh salt
pub fn verify_secret(secret: &str, phc: &str) -> Result<bool, KdfError>;      // Err only for an invalid/out-of-limits hash
pub fn check_hash(phc: &str) -> Result<(), KdfError>;                         // the limits above, without hashing
pub enum KdfError { Invalid(String), Internal(String) }
```

**Lockout engine** (`lockout.rs`; shared with the PIN, Section 5.10).

```rust
pub struct LockPolicy { pub free_failures: u32, pub lock_ms: &'static [u64], pub forget_after_ms: Option<u64> }
pub const PASSWORD_POLICY: LockPolicy = LockPolicy { free_failures: 4, lock_ms: &[30_000, 60_000, 300_000, 900_000], forget_after_ms: Some(1_800_000) };
pub const PIN_POLICY:      LockPolicy = LockPolicy { free_failures: 4, lock_ms: &[60_000, 300_000, 900_000, 1_800_000, 3_600_000], forget_after_ms: None };
#[derive(Serialize, Deserialize, Default, Clone)] #[serde(rename_all = "camelCase", default)]
pub struct Counter { pub failures: u32, pub last_failure_ms: u64, pub locked_at_ms: u64, pub lock_ms: u64 }
pub enum Gate { Open { attempts_left: u32 }, Locked { retry_after_ms: u64 } }
impl Counter {
    pub fn gate(&mut self, policy: &LockPolicy, now_ms: u64) -> Gate;          // also applies forget_after and the clock rule
    pub fn record_failure(&mut self, policy: &LockPolicy, now_ms: u64) -> Gate; // returns the state AFTER this failure
    pub fn undo_failure(&mut self);                                             // for "counted first, then it was not a guess"
    pub fn clear(&mut self);
}
```

- Failure number `n` (consecutive, starting at 1) locks when
  `n > free_failures`; the lock lasts `lock_ms[min(n - free_failures - 1, len - 1)]`.
- **Employee passwords**, per normalized username: failures 1 to 4 are
  answered `wrongCredentials`; the 5th locks for 30 seconds, the 6th for
  1 minute, the 7th for 5 minutes, the 8th and every later one for 15
  minutes. A correct password clears the counter; so do 30 minutes
  without a failed attempt.
- **Device-wide guard for passwords** (memory only): more than 20 failed
  password checks, over all usernames, within any 10 minutes → every
  `signIn` and `verifyPassword` is answered `lockedOut` until the oldest
  of those failures is 10 minutes old (`retryAfterMs` says when). This
  bounds guessing across many usernames. A hostile Staff-session process
  can use it to block sign-in on that PC for a while; that is accepted,
  since such a process can already disturb the session in worse ways.
- **Clock rule.** Times are wall-clock milliseconds (`state::unix_ms`). If
  `now < locked_at_ms` (the clock went back), set `locked_at_ms = now`
  and save: a clock change never shortens a lock. The Staff account
  cannot set the system clock; someone with firmware access can shorten
  a lock by setting it forward. Accepted.
- Stored in `lockouts.json`:
  `{ "schema": 1, "adminExit": Counter, "adminExitPinId": string|null, "employees": { "<username>": Counter } }`.
  Employee entries that are not locked and older than 30 minutes are
  removed on every save.
- Every lock that starts (password or PIN) writes one audit record
  (Section 5.11). PRD 5.2 asks for employee lockouts to be reported.

### 5.10 Hidden admin exit (protocol 1.1)

Serves `adminExit.submit` and the snapshot field `adminExit`. Code:
`admin_exit.rs`, `agent_policy.rs`, `lockout.rs`, `kdf.rs`. Built in
Step 6b; the reconciler part in Step 9. PRD 9.5 and 12.4.

**What a correct PIN gives.** It ends the Staff session and shows the
Windows sign-in screen. It grants **no** administrator right: the person
still has to sign in to Windows with an administrator account. That is
why this method is safe to expose on a pipe any Staff-session process
can open (Section 6.2).

**Where the settings come from (the Phase 4 seam).** The desired-state
document may carry three extra top-level keys that only the agent reads.
They are **not** fields of `rulebox_policy::DesiredState`, so they can
never appear in `AgentSnapshot.desiredState`:

```jsonc
"adminExit": { "enabled": true,                 // optional, default true
               "hotkey": "Ctrl+Shift+F12",      // optional, default DEFAULT_ADMIN_EXIT_HOTKEY
               "pinHash": "$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>" },   // optional
"power":     { "sleep": true, "restart": true, "shutDown": true },            // optional
"orgName":   "Company"                                                         // optional
```

```rust
// apps/agent/src/agent_policy.rs
pub struct AgentPolicy { pub admin_exit: AdminExitPolicy, pub power: Option<PowerOptions>, pub org_name: Option<String> }
pub struct AdminExitPolicy { pub enabled: bool,              // true only when a valid pin_hash is present and "enabled" is not false
                             pub hotkey: String,             // always canonical and valid
                             pub pin_hash: Option<String>,   // Debug prints "<redacted>"
                             pub problem: Option<String> }   // why the settings were not usable, for the log and `status`
impl AgentPolicy { pub fn from_doc(doc: Option<&serde_json::Value>) -> AgentPolicy; }   // pure; never fails
```

- No document, or no `adminExit` key, or no `pinHash` → `enabled: false`
  (there is no default PIN).
- `pinHash` fails `kdf::check_hash` → `enabled: false`,
  `problem: "admin_exit_pin_invalid"`, logged as an error. Failing
  closed is deliberate: the two recovery routes of PRD 9.5 still work,
  and a broken document must not keep an old PIN alive after a rotation.
- `hotkey` fails `rulebox_ipc::hotkey::parse` → the default is used,
  `problem: "admin_exit_hotkey_invalid"`, logged as a warning.
- `orgName` longer than 100 characters, or `power` of the wrong shape →
  `None`.
- The snapshot gets `adminExit: { enabled, hotkey }`, `power`, `orgName`.
  The hash, its salt and the counter never go into the snapshot, any IPC
  result, the admin `status` output or a log line.
- **Until Phase 4** the keys are written by `convex/dev.ts` →
  `setAdminExit` (Step 7) using a hash printed by `rulebox-agent
  hash-pin` (Step 6b). Phase 4 replaces `dev.ts` with dashboard settings
  and must keep the hash write-only for dashboard readers. In
  `--sim-demo` the fixture document has PIN `2468`.
- The hash lives in the cached document (`desired-state.json`) inside the
  protected data directory. It is a salted Argon2id hash of a 4 to
  12 digit number, so anyone who can read that file can guess it
  offline; only SYSTEM and Administrators can read it, and they own the
  machine already. What protects the PIN is that the hash never leaves
  the agent and that guesses are rate-limited.

**`adminExit.submit`, exactly:**

1. `pin` is not 4 to 12 ASCII digits → error `invalid_params`. Not
   counted (it is not a guess the dialog can produce).
2. `AdminExitPolicy.enabled` is false → outcome `disabled`.
3. Take the PIN gate (its own `tokio::sync::Mutex`) with `try_lock`.
   Already taken → error `busy`.
4. If `lockouts.adminExitPinId` differs from the current PIN id (the
   first 16 hex characters of SHA-256 of the `pinHash` string): the PIN
   was rotated; clear the counter and store the new id.
5. Counter says locked → outcome `lockedOut` with `retryAfterMs`. The PIN
   is not checked and nothing is counted. An audit record is written at
   most once per lock, when it starts (step 7), not per refused call.
6. **Count first:** `record_failure`, save `lockouts.json`.
7. `kdf::verify_secret(pin, pin_hash)` in `spawn_blocking`.
   - No match → audit `adminExitWrongPin`. If the counter is now locked:
     audit `adminExitLockedOut`, outcome `lockedOut` with `retryAfterMs`;
     otherwise outcome `wrongPin` with `attemptsLeft`.
   - Match → clear the counter, save, continue.
8. Send `ExitRequest { session_id: <the caller's verified session id> }`
   to the reconciler and wait at most 3 seconds for "prepared". The
   reconciler (Step 9; a small stand-in task until then, Step 6b):
   a. if `kiosk.applied == Enabled`: start the **exit hold** and write
      `AutoAdminLogon = "0"` through `write_machine_value`. A failure
      here ends the hold and is reported back;
   b. replies "prepared".
   Not prepared (error or 3 seconds) → audit `adminExitFailed`, error
   `internal` with `retryable: true`. The PIN was right, so nothing is
   counted.
9. Clear the employee session. Write audit `adminExitSuccess`. Answer
   outcome `signingOut`.
10. The reconciler then broadcasts
    `agent.shuttingDown { reason: "adminExit", graceMs: 2000 }`, waits
    2 seconds (so the answer and the event reach the client), and calls
    `logoff_session(session_id)`. If that fails it retries after 1, 2
    and 4 seconds; if all fail it ends the hold (automatic sign-in is
    re-armed by the next reconcile), logs an error and writes audit
    `adminExitFailed`.

The lock schedule for the PIN (`PIN_POLICY`, one counter per **device**,
persisted, never forgotten with time): consecutive wrong PINs 1 to 4
are answered `wrongPin` with `attemptsLeft` 4, 3, 2, 1 (`attemptsLeft`
is the number of further PINs that will still be checked before a wait;
`Gate::Open.attempts_left` is `free_failures + 1 - failures`, at least
1). The 5th consecutive wrong PIN is answered `lockedOut` and locks for
1 minute, the 6th for 5 minutes, the 7th for 15 minutes, the 8th for
30 minutes, the 9th and every later one for 60 minutes. After a lock
ends exactly one PIN is checked before the next lock. Only a correct
PIN or a rotated PIN clears the counter. With a 4-digit PIN this allows
about 30 guesses on the first day and 24 a day after that (more than a
year to try every value); Phase 4's dashboard should still ask for at
least 6 digits.

**Exit hold: when automatic sign-in comes back.** The hold is kept in
memory by the reconciler (not on disk). It ends, and the next reconcile
writes `AutoAdminLogon = "1"` again, at the **first** of:

- a session of a user other than Staff becomes `Active` (the
  administrator signed in; the sign-in screen is no longer deciding);
- 5 minutes pass (nobody signed in);
- the agent restarts.

After the administrator signs out, the kiosk returns at the next sign-in
decision Windows makes: at the latest at the next restart. Whether
Windows signs Staff in again right after an administrator signs out
(without a restart) is **(unverified)**; the VM checklist records it. A
PC restarted **during** the 5-minute hold starts at the Windows sign-in
screen once; the restart after that is a kiosk again. Both facts go into
the administrator notes in the final report.

**Offline.** Nothing in this section calls the backend. A device whose
enrollment was revoked keeps its last cached document, so its PIN keeps
working (an administrator at a revoked PC still needs the way out).

### 5.11 Audit queue (protocol 1.1)

PRD 12.4: every use of the exit is reported to the dashboard audit log.
The log itself is Phase 4; Phase 2 records and queues.

```rust
// apps/agent/src/audit.rs
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct AuditRecord { pub id: String,                      // 32 hex characters, random; the backend uses it to drop duplicates
                         pub at_ms: u64,                      // device wall clock
                         pub server_time_offset_ms: Option<i64>,   // as known when recorded, so the backend can correct at_ms
                         pub kind: AuditKind,
                         pub username: Option<String>,        // employee lockouts only
                         pub detail: Option<String> }         // short, fixed texts only; never a PIN, password or hash
pub enum AuditKind { AdminExitSuccess, AdminExitWrongPin, AdminExitLockedOut, AdminExitFailed, EmployeeLockedOut }
pub trait AuditSink: Send + Sync + 'static {
    /// Deliver a batch. Ok = the backend has all of them (it must accept a repeated id silently).
    fn deliver<'a>(&'a self, batch: &'a [AuditRecord]) -> BoxFuture<'a, Result<(), AuditSinkError>>;
}
pub enum AuditSinkError { Unavailable, Unreachable }
pub struct AuditQueue { /* path, records, dropped */ }
impl AuditQueue { pub fn open(path: PathBuf) -> std::io::Result<Self>;
                  pub fn push(&mut self, record: AuditRecord) -> std::io::Result<()>;      // appends and saves atomically
                  pub fn peek(&self, max: usize) -> &[AuditRecord];
                  pub fn ack(&mut self, count: usize) -> std::io::Result<()>;              // removes the first `count` and saves
                  pub fn len(&self) -> usize; }
```

- `audit-queue.json`: `{ "schema": 1, "dropped": 0, "records": [...] }`.
  At most 500 records; when full, the oldest is removed and `dropped` is
  increased (the count is sent with the next batch's first record as
  `detail: "dropped:<n>"` and then reset).
- The `audit` task delivers in batches of at most 50, oldest first, when
  a record is pushed and when `connection` becomes `online`. On any
  error it stops and waits for the next trigger; it never loops on a
  timer (CLAUDE.md data rule 6).
- A record is written to disk **before** the IPC answer is sent, so an
  answer is never seen without its record.
- Implementations: `NullAuditSink` (the real agent until Phase 4; always
  `Unavailable`, so records stay queued up to the cap) and
  `LogAuditSink` (simulate mode: logs each record at `info` and returns
  `Ok`). Phase 4 adds the Convex sink and the table. `Deps` gains
  `audit_sink: Arc<dyn AuditSink>`.

---

## 6. The agent↔shell IPC contract (version 1.0)

This section is the **only** interface between Phase 2 and Phase 3. The
Rust types live in `crates/rulebox-ipc`; the TypeScript types are
generated into `packages/types/src/generated/`. Changing anything here
after Step 6 is done requires telling the user, because Phase 3 builds
against it in parallel.

Sections 6.1 to 6.10 describe version 1.0 as built in Steps 2 and 4.
**Section 6.11 is the 1.1 addendum.** It only adds; where it changes a
sentence of 6.1 to 6.10, that sentence carries a "(1.1)" note.

### 6.1 Transport

- **Windows named pipe**, local only: `\\.\pipe\dev.rulebox.agent.shell`.
- The **agent is the server**; the Staff App (its Rust side) is the
  client. The webview never touches the pipe.
- Byte mode (`PIPE_TYPE_BYTE`), duplex, overlapped. In and out buffer
  size hint 65,536 bytes. `max_instances` 4. Remote clients rejected.
  The first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`; if
  that fails with access denied, another process owns the name: the agent
  logs a security error and retries every 5 seconds. It never falls back
  to another name.
- The pipe exists only while the agent knows the Staff account's SID
  (after enrollment). Before that, clients get "not found" and keep
  retrying.

### 6.2 Access control and peer verification

**Pipe security descriptor** (SDDL; `<STAFF_SID>` is the Staff account's
SID):

```
O:SYG:SYD:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;<STAFF_SID>)S:(ML;;NW;;;ME)
```

- Owner SYSTEM (so the client can verify who created the pipe); deny
  network logons; full control for SYSTEM and Administrators; the Staff
  account gets read and write **without** bit `0x4`
  (`FILE_CREATE_PIPE_INSTANCE`), so it can never create its own instance
  of the pipe. Never use the generic write rights `GW` or `FW` in the
  Staff entry: they include bit `0x4`.
- The mandatory label keeps low-integrity processes (for example WebView2
  renderers) from opening the pipe for writing.
- The same security attributes are applied to **every** instance.

**The agent verifies each client** after reading the first frame and
before answering it:

1. `ImpersonateNamedPipeClient` → read the thread token's user SID →
   `RevertToSelf`, all in one synchronous function with no `.await`
   inside. A failing `RevertToSelf` is fatal: the agent exits with a
   non-zero code and the service manager restarts it. The SID must equal
   the Staff SID. This check is race-free and is the one that matters.
2. `GetNamedPipeClientSessionId` must be a session in which the Staff
   account is signed in (never session 0).
3. `GetNamedPipeClientProcessId` → `QueryFullProcessImageNameW`: the
   image must be inside `<install>\versions\`, **or (1.1) be exactly
   `<install>\rulebox-shell.exe`** (the launcher calls `state.get` and
   `adminExit.submit` from its fallback screen, Step 12). Compare
   case-insensitively after resolving both paths. This is defence in
   depth only: any process running as Staff could inject into the Staff
   App. Nothing else is accepted, so a `pnpm dev:staff` build can only
   ever talk to a `--simulate` agent; that is intended (Phase 3 R10), do
   not "fix" it.
4. On any failure: answer the first request with `unauthorized` and
   close.

Because of point 3's limit, **every method on this pipe must be safe for
any process in the Staff session to call.** The agent authorises each
request against policy; it never treats "this is our executable" as
permission. Later phases must keep this rule when they add methods.

**The client verifies the server** before sending anything:

1. It opens the pipe with `CreateFileW`, desired access
   `FILE_GENERIC_READ | FILE_WRITE_DATA | FILE_WRITE_EA |
   FILE_WRITE_ATTRIBUTES` (not `GENERIC_WRITE`, which asks for bit `0x4`
   and may be refused), flags `FILE_FLAG_OVERLAPPED |
   SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`. Identification level
   stops the server from acting as the client.
2. `GetSecurityInfo(handle, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION)`
   must return owner `S-1-5-18` (SYSTEM). Otherwise it closes the handle
   and reports `ServerNotTrusted`.
3. **(1.1, added in Step 5a)** `GetNamedPipeServerSessionId(handle)` must
   return **0**. Otherwise `ServerNotTrusted`. Reason: from 1.1 on the
   client sends passwords and the exit PIN, so it must know the other end
   is a service. The owner check alone cannot tell: every instance of a
   pipe name shares the security descriptor of the first one, so an
   instance created by another process would still show SYSTEM as owner
   **(unverified)**. A process of the Staff account cannot run in
   session 0. Whether this API reports 0 for our service on every
   edition is **(unverified)**; the VM checklist's first `Linked` proves
   it.

`rulebox-ipc`'s `IpcClient` does all three. Phase 3 must use `IpcClient`
and not open the pipe itself.

**What the Step 4 test showed, and what it means.** Run elevated as the
same user, a client open that asked for `GENERIC_WRITE` (which includes
bit `0x4`) was **accepted** against a descriptor whose only entry lacked
that bit, while a request for `DELETE` was refused. So a client-side
open is not where Windows enforces bit `0x4` (probably it is checked
only when an instance is **created**, where it means
`FILE_CREATE_PIPE_INSTANCE`; on an open the same bit is
`FILE_APPEND_DATA`) **(unverified)**. The property the design needs is
narrower and is tested directly on the VM (Section 10.2, "IPC
security"): a process of the Staff account must not be able to call
`CreateNamedPipeW` on the shell pipe's name. Check 3 above is the
second line if that test fails. The client keeps its reduced access
mask; it is harmless.

**Simulate mode** (development only): the agent started with
`--simulate` serves `\\.\pipe\dev.rulebox.agent.shell.sim`, grants the
**current user** instead of the Staff SID, skips checks 2 and 3, and the
client accepts the current user as pipe owner and skips the server
session check. `IpcClient` uses the
`.sim` name only when built with `debug_assertions` **and** the
environment variable `RULEBOX_AGENT_SIM=1` is set. Release builds ignore
the variable.

### 6.3 Framing

- Each message is one frame: a **4-byte big-endian unsigned length**
  followed by that many bytes of **UTF-8 JSON** (one JSON object).
- Maximum frame length **1,048,576 bytes** in both directions. A longer
  frame closes the connection (the agent first tries to send an error
  event with code `frame_too_large`).
- Invalid UTF-8 or invalid JSON closes the connection.

### 6.4 Envelope

```jsonc
// client -> agent
{ "t": "req", "id": 7, "method": "state.get", "params": {} }
// agent -> client
{ "t": "res", "id": 7, "ok": true,  "result": { /* method-specific */ } }
{ "t": "res", "id": 7, "ok": false, "error": { "code": "invalid_params", "message": "…", "retryable": false, "data": null } }
// agent -> client, no reply
{ "t": "evt", "event": "state.changed", "data": { /* event-specific */ } }
```

- `id` is an unsigned 32-bit integer chosen by the client, unique among
  its in-flight requests. Responses may arrive in any order.
- Only the client sends `req`. Only the agent sends `res` and `evt`. In
  version 1 the client never sends `evt`.
- `params` and `data` are always JSON objects (use `{}` when empty).
- All field names are camelCase.

```rust
// crates/rulebox-ipc/src/envelope.rs
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Frame {
    #[serde(rename = "req")] Request  { id: u32, method: String, #[serde(default)] params: serde_json::Value },
    #[serde(rename = "res")] Response { id: u32, ok: bool,
                                        #[serde(default, skip_serializing_if = "Option::is_none")] result: Option<serde_json::Value>,
                                        #[serde(default, skip_serializing_if = "Option::is_none")] error: Option<RpcError> },
    #[serde(rename = "evt")] Event    { event: String, #[serde(default)] data: serde_json::Value },
}
pub struct RpcError { pub code: ErrorCode, pub message: String, pub retryable: bool,
                      #[serde(default)] pub data: Option<serde_json::Value> }

// crates/rulebox-ipc/src/methods.rs
pub trait Method { const NAME: &'static str; type Params: Serialize + DeserializeOwned; type Result: Serialize + DeserializeOwned; }
```

### 6.5 Versioning and compatibility

- Protocol version is `major.minor`. Phase 2 ships **1.0**
  (`PROTOCOL_MAJOR = 1`, `PROTOCOL_MINOR = 0`).
- The first request on every connection **must** be `hello`, sent within
  5 seconds of connecting. Anything else first gets `hello_required` and
  the connection is closed.
- **Major** mismatch: the agent answers `unsupported_protocol` with
  `data: { "supported": { "major": 1, "minor": 0 } }` and closes.
- **Minor** is additive only: new methods, new events, new optional
  fields, new enum values. Both sides must therefore:
  - ignore unknown fields (never use `#[serde(deny_unknown_fields)]` on a
    wire type);
  - ignore unknown events;
  - map unknown string enum values to an `unknown` variant
    (`#[serde(other)]`), and unknown error codes to `internal`;
  - answer an unknown method with `unknown_method`.
- The `hello` result lists `capabilities`. The client feature-detects
  with that list, not with the version number. Phase 2 capabilities:
  `["state", "health"]`.
- Reserved method namespaces for later phases (do not use them now):
  `files.*`, `update.*`, `net.*`, `power.*`, `device.*`. Adding a
  namespace is a minor bump plus a new capability string. (1.1) The
  namespaces `session.*`, `apps.*` and `adminExit.*` are in use from
  version 1.1 (Section 6.11).
- (1.1) The agent built in this phase answers `hello` with
  `{ "major": 1, "minor": 1 }`. A 1.0 client keeps working: it ignores
  the new fields, values and capabilities.

### 6.6 Methods and events (1.0)

| Method | Params | Result | Notes |
|---|---|---|---|
| `hello` | `HelloParams` | `HelloResult` | First request. Triggers peer verification |
| `state.get` | `{}` | `AgentSnapshot` | The whole state the shell needs, in one call |
| `shell.ready` | `{}` | `{}` | The Staff App's first screen is usable. Starts hang detection |
| `shell.heartbeat` | `{}` | `{}` | Every 10 seconds after `shell.ready`. 30 seconds of silence means "hung" (Section 5.7) |

| Event | Data | Sent when |
|---|---|---|
| `state.changed` | `AgentSnapshot` | Any field of the snapshot changed. Coalesced: if several changes are pending for a slow client, only the newest is sent |
| `agent.shuttingDown` | `{ reason: "stop" \| "kioskDisabled" \| "unknown", graceMs: number }` | The service is stopping, or kiosk mode is being disabled and the Staff session will be signed out after `graceMs` |

```rust
// crates/rulebox-ipc/src/types.rs — all derive Serialize, Deserialize, Debug, Clone, PartialEq, TS
// with #[serde(rename_all = "camelCase")] and #[ts(export)]
pub struct ProtocolVersion { pub major: u16, pub minor: u16 }
pub struct HelloParams  { pub protocol: ProtocolVersion, pub client: ClientInfo }
pub struct ClientInfo   { pub role: ClientRole, pub name: String, pub version: String }
pub enum ClientRole     { Shell, #[serde(other)] Unknown }            // "shell"
pub struct HelloResult  { pub protocol: ProtocolVersion, pub agent_version: String, pub capabilities: Vec<String> }

pub struct AgentSnapshot {
    pub agent_version: String,
    pub enrollment: EnrollmentStatus,          // "notEnrolled" | "enrolled" | "revoked"
    pub device: Option<DeviceInfo>,            // { id, name }
    pub convex_url: Option<String>,            // deployment URL from the enrollment code
    pub connection: ConnectionStatus,          // "offline" | "connecting" | "online"
    pub kiosk: KioskStatus,                    // { enabled: bool, phase: "notApplied"|"applying"|"applied"|"failed", errorCode: string|null }
    pub shell: ShellStatus,                    // { health: "notRunning"|"starting"|"healthy"|"unhealthy"|"failed" }
    pub display_mode: DisplayMode,             // "standard" | "lite"  (PRD 22.5; RAM <= 4,352 MB => lite)
    pub desired_state: Option<rulebox_policy::DesiredState>,
    #[ts(type = "number")] pub desired_state_version: u64,
    #[ts(type = "number | null")] pub server_time_offset_ms: Option<i64>,
    pub clock_suspect: bool,
}
```

Every enum above has an `Unknown` variant with `#[serde(other)]`.

What the Staff App does with this (for the Phase 3 planner):

- Pipe not found, `connection` not yet known, or `kiosk.phase` =
  `applying` → show the logo "Loading" animation (PRD 25.5: "agent
  starting, first sync").
- `display_mode` replaces the `?lite=1` query parameter from Phase 1.
- `convex_url` replaces the build-time `VITE_CONVEX_URL` on enrolled
  devices (Section 14, Q13).
- `desired_state` is the rules source; the shell never reads the agent's
  files.

### 6.7 Errors

| Code | Meaning | `retryable` |
|---|---|---|
| `hello_required` | First request was not `hello`, or it came too late | false |
| `unsupported_protocol` | Major version not supported; `data.supported` says which is | false |
| `unauthorized` | Peer verification failed | false |
| `unknown_method` | Method not known to this agent version | false |
| `invalid_params` | Params missing or of the wrong type or value | false |
| `denied_by_policy` | Valid request the current policy forbids (reserved for later phases) | false |
| `not_enrolled` | The method needs an enrolled device | false |
| `busy` | More than 16 requests in flight on this connection | true |
| `timeout` | The agent could not finish in time | true |
| `frame_too_large` | Frame above 1 MiB; the connection is closed | false |
| `internal` | Unexpected agent error. `message` never contains secrets or file paths outside the install directory | true |
| `not_signed_in` (1.1) | The method needs a signed-in employee (`session.verifyPassword`, `apps.list`) | false |
| `operation_failed` (1.1) | The method ran and failed for a reason of its own. `data` is `{ "reason": string, "details": object \| null }`. Used on the **admin pipe** only; shell-pipe methods report expected results as an `outcome` in the result instead | per reason |

`ErrorCode` serializes as the snake_case strings above and has
`#[serde(other)] Internal`. A 1.0 client therefore reads the two new
codes as `internal`.

**Admin-pipe failures (finding from Step 2: these had no code).**
Enrollment failures are open-ended (some names come from the server), so
they are not `ErrorCode` values. They travel as `operation_failed`:

```jsonc
{ "t": "res", "id": 1, "ok": false,
  "error": { "code": "operation_failed", "message": "This PC is already enrolled.", "retryable": false,
             "data": { "reason": "already_enrolled", "details": null } } }
```

```rust
// crates/rulebox-ipc/src/admin.rs
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct OperationFailure { pub reason: String, #[serde(default)] pub details: Option<serde_json::Value> }
pub mod reasons {
    pub const NOT_AVAILABLE_YET: &str = "not_available_yet";      // a method whose step is not built yet
    pub const ALREADY_ENROLLED: &str = "already_enrolled";
    pub const CODE_INVALID: &str = "code_invalid";                // details: { "kind": "badPrefix" | "badEncoding" | "malformed" | "badUrl" | "badToken" }
    pub const COMPAT_BLOCKED: &str = "compat_blocked";            // details: { "blockers": ["no_other_admin", ...] }
    pub const BACKEND_UNREACHABLE: &str = "backend_unreachable";  // retryable: true
    pub const TOKEN_INVALID: &str = "token_invalid";
    pub const TOKEN_EXPIRED: &str = "token_expired";
    pub const TOKEN_USED_UP: &str = "token_used_up";
    pub const TOKEN_REVOKED: &str = "token_revoked";
    pub const BACKEND_REJECTED: &str = "backend_rejected";        // any other server code; details: { "serverCode": "..." }
}
```

| Method | `operation_failed` reasons | Other errors |
|---|---|---|
| `admin.enroll` | all of the above | `busy` (another enroll or unenroll is running), `invalid_params` |
| `admin.unenroll` | `not_available_yet` (until Step 11). An unreachable backend is not an error here; Step 11 only logs it | `not_enrolled`, `busy` |
| `admin.status` | none | — |

A kiosk failure during enrollment is not an error at all: the result's
`kiosk.errorCode` carries it (Section 5.4, step 7). The CLI prints
`error: <reason>: <message>` (for `compat_blocked` one blocker per line
after it), adds "Try again." when `retryable` is true, and exits with
code **3**. Exit code 2 stays "the service is not running"; 1 is any
other error.

### 6.8 Limits and timing

| Item | Value |
|---|---|
| Max frame | 1,048,576 bytes |
| Max in-flight requests per connection | 16 |
| Max concurrent shell connections | 4 (all treated alike; events go to all) |
| `hello` deadline after connect | 5 s |
| Client default request timeout | 10 s |
| Outbound event queue per connection | 64 frames; `state.changed` is coalesced; if the queue is still full the connection is closed |
| Client reconnect backoff | 100 ms, doubling to 2 s, forever |
| Client pipe-busy retry (`ERROR_PIPE_BUSY`, 231) | every 50 ms, up to 5 s per attempt |
| (1.1) Agent budget for `session.signIn` | 8 s (directory call 6 s inside it) |
| (1.1) Agent budget for `adminExit.submit` | answer within 5 s (PIN check, then at most 3 s for the reconciler) |
| (1.1) Checks running at once | 1 password check and 1 PIN check per device; a second one gets `busy` |
| (1.1) Grace between `signingOut` and the sign-out | 2 s |

### 6.9 Process contract between the launcher and the Staff App

- The launcher starts `<install>\<exe from current.json>` with no
  arguments, working directory = the exe's folder, the Staff user's own
  environment.
- **Exit code 0** means "intentional exit, start me again now" (for
  example "Restart Rulebox"). It is not counted as a crash.
- **Any other exit code** is a crash: relaunch after 500 ms, then 1 s,
  2 s, 5 s (cap). Five crashes within 60 seconds show the native fallback
  screen; the launcher then retries every 30 seconds and on the
  "Try again" button.
- The Staff App must be single-instance per session.
- The Staff App must never exit to "close"; in a kiosk there is nothing
  behind it.

### 6.10 What Phase 2 delivers to Phase 3

- `rulebox-ipc` with feature `client`:

  ```rust
  pub struct IpcClient { /* cheap to clone */ }
  impl IpcClient {
      /// Spawns the connection task. Never fails: it keeps reconnecting.
      pub fn spawn(info: ClientInfo) -> (IpcClient, tokio::sync::mpsc::Receiver<ClientEvent>);
      pub async fn call<M: Method>(&self, params: M::Params) -> Result<M::Result, CallError>;
      pub fn connection(&self) -> tokio::sync::watch::Receiver<LinkState>;
  }
  pub enum ClientEvent { Linked(HelloResult), Unlinked, StateChanged(AgentSnapshot),
                         ShuttingDown { reason: ShutdownReason, grace_ms: u64 } }
  pub enum LinkState { Disconnected, Connecting, Linked }
  pub enum CallError { NotLinked, Timeout, Rpc(RpcError), ServerNotTrusted, Protocol(String) }
  ```

  `IpcClient` sends `hello` itself after each (re)connect. It does **not**
  send `shell.ready` or heartbeats; the Staff App decides when it is
  ready and runs the 10-second heartbeat.
- Generated TypeScript types for every struct in Section 6.6, exported
  from `@rulebox/types`.
- A simulated agent for development on any machine:
  `cargo run -p rulebox-agent -- run --console --simulate`.
- (1.1) The method structs and types of Section 6.11, the key-combination
  parser `rulebox_ipc::hotkey`, and a simulated agent that answers the
  1.1 methods from fixtures:
  `cargo run -p rulebox-agent -- run --console --simulate --sim-demo`.

### 6.11 Protocol 1.1 addendum

Version **1.1** (`PROTOCOL_MINOR = 1`). Everything in Sections 6.1 to
6.10 still holds. Nothing of 1.0 is removed or changes meaning. Built in
Steps 5a (types), 6a and 6b (agent).

**Capabilities**

| Capability | Listed by the agent when | Gives |
|---|---|---|
| `state`, `health` | always | the 1.0 methods |
| `adminExit` | always | `adminExit.submit`; the snapshot field `adminExit` |
| `session` | `EmployeeDirectory::available()` is true (Section 5.9) | `session.signIn`, `session.signOut`, `session.get`, `session.verifyPassword` |
| `apps` | same condition as `session` | `apps.list` |

A method whose capability is not listed answers `unknown_method`. The
real agent of Phase 2 lists `session` and `apps` only in fixture mode;
Phase 4 turns them on for good. `lib.rs` gets `CAP_SESSION`, `CAP_APPS`
and `CAP_ADMIN_EXIT`; the existing `CAPABILITIES` constant keeps its two
values and now means "always present".

**Methods**

| Method | Params | Result | Errors beyond the general ones |
|---|---|---|---|
| `session.signIn` | `SignInParams` | `SignInResult` | `not_enrolled`, `denied_by_policy` (revoked, or another employee is signed in), `busy`, `timeout` |
| `session.signOut` | `{}` | `{}` | — |
| `session.get` | `{}` | `SessionGetResult` | — |
| `session.verifyPassword` | `VerifyPasswordParams` | `VerifyPasswordResult` | `not_signed_in`, `busy` |
| `apps.list` | `{}` | `AppsListResult` | `not_signed_in` |
| `adminExit.submit` | `AdminExitSubmitParams` | `AdminExitSubmitResult` | `busy`, `internal` (the PIN was right but the sign-out could not be prepared; `retryable: true`) |

A wrong password, a wrong PIN, a lockout and "disabled" are **outcomes**
inside a successful response (`ok: true`), never RPC errors.

```jsonc
// session.signIn
{ "username": "maya", "password": "…" }
{ "outcome": "ok", "employee": { "id": "emp_maya", "username": "maya", "name": "Maya Chen", "role": "Cashier", "quotaBytes": 10737418240 },
  "filesRoot": "C:\\Users\\RuleboxStaff\\RuleboxFiles\\emp_maya", "offline": false, "retryAfterMs": null }
{ "outcome": "lockedOut", "employee": null, "filesRoot": null, "offline": false, "retryAfterMs": 30000 }
// other outcomes: "wrongCredentials" | "disabled" | "offlineNeverSignedIn" | "offlineExpired" (all other fields null / false)

// session.get
{ "employee": { … } | null, "filesRoot": "…" | null, "offline": false }

// session.verifyPassword
{ "password": "…" }
{ "outcome": "ok" | "wrongCredentials" | "lockedOut", "retryAfterMs": null | 30000 }

// apps.list
{ "apps": [ { "id": "orders-web", "name": "Orders", "description": null, "kind": "web",
              "builtin": null,
              "web": { "url": "https://portal.company.com/orders", "allowedDomains": ["portal.company.com"],
                       "permissions": { "camera": false, "microphone": false, "screenShare": false, "clipboardRead": false,
                                        "notifications": true, "downloads": true, "printing": false, "geolocation": false } },
              "desktop": null,
              "pinnedTaskbar": true, "pinnedDesktop": true, "iconPngBase64": null, "hue": 175 } ] }

// adminExit.submit
{ "pin": "2468" }
{ "outcome": "signingOut", "attemptsLeft": null, "retryAfterMs": null }
{ "outcome": "wrongPin",   "attemptsLeft": 3,    "retryAfterMs": null }
{ "outcome": "lockedOut",  "attemptsLeft": null, "retryAfterMs": 60000 }
{ "outcome": "disabled",   "attemptsLeft": null, "retryAfterMs": null }
```

Result fields that do not apply are sent as `null` (or `false`), the
same way the 1.0 snapshot sends `"device": null`. A reader must treat a
missing field and `null` alike.

```rust
// crates/rulebox-ipc/src/requests.rs — new file. Every type: Serialize, Deserialize, Clone, PartialEq,
// #[serde(rename_all = "camelCase")]. Option and bool fields of RESULT types carry #[serde(default)].
// These types are NOT exported to TypeScript (no TS derive): the Staff App keeps IPC on its Rust side,
// and its own DTOs named Employee and AppEntry are generated into the same folder.
pub struct SignInParams { pub username: String, pub password: String }          // Debug: hand-written, prints "<redacted>" for password
pub struct SignInResult { pub outcome: SignInOutcome, pub employee: Option<Employee>, pub files_root: Option<String>,
                          pub offline: bool, pub retry_after_ms: Option<u64> }
pub enum SignInOutcome { Ok, WrongCredentials, Disabled, LockedOut, OfflineNeverSignedIn, OfflineExpired, Unknown }
pub struct Employee { pub id: String, pub username: String, pub name: String, pub role: Option<String>, pub quota_bytes: u64 }
pub struct SessionGetResult { pub employee: Option<Employee>, pub files_root: Option<String>, pub offline: bool }
pub struct VerifyPasswordParams { pub password: String }                         // Debug redacted
pub struct VerifyPasswordResult { pub outcome: VerifyOutcome, pub retry_after_ms: Option<u64> }
pub enum VerifyOutcome { Ok, WrongCredentials, LockedOut, Unknown }
pub struct AppsListResult { pub apps: Vec<AppEntry> }
pub struct AppEntry { pub id: String, pub name: String, pub description: Option<String>, pub kind: AppKind,
                      pub builtin: Option<BuiltinApp>,    // set when kind = builtin
                      pub web: Option<WebApp>,            // set when kind = web
                      pub desktop: Option<DesktopApp>,    // set when kind = desktop
                      pub pinned_taskbar: bool, pub pinned_desktop: bool,
                      pub icon_png_base64: Option<String>, pub hue: Option<u16> }
pub enum AppKind { Builtin, Web, Desktop, Unknown }                              // "builtin" | "web" | "desktop"
pub struct BuiltinApp { pub tool: String }                                       // "files" is the only tool today
pub struct WebApp { pub url: String, pub allowed_domains: Vec<String>, pub permissions: WebPermissions }
pub struct WebPermissions { pub camera: bool, pub microphone: bool, pub screen_share: bool, pub clipboard_read: bool,
                            pub notifications: bool, pub downloads: bool, pub printing: bool, pub geolocation: bool }
                            // #[serde(default)] on the struct; Default = notifications and downloads true, the rest false (PRD 24.1)
pub struct DesktopApp { pub exe: String, pub args: Vec<String>, pub file_arg_template: Vec<String> }
pub struct AdminExitSubmitParams { pub pin: String }                             // Debug redacted
pub struct AdminExitSubmitResult { pub outcome: AdminExitOutcome, pub attempts_left: Option<u32>, pub retry_after_ms: Option<u64> }
pub enum AdminExitOutcome { SigningOut, WrongPin, LockedOut, Disabled, Unknown }

// crates/rulebox-ipc/src/methods.rs — additions
pub struct SessionSignIn;         // "session.signIn"          SignInParams          -> SignInResult
pub struct SessionSignOut;        // "session.signOut"         Empty                 -> Empty
pub struct SessionGet;            // "session.get"             Empty                 -> SessionGetResult
pub struct SessionVerifyPassword; // "session.verifyPassword"  VerifyPasswordParams  -> VerifyPasswordResult
pub struct AppsList;              // "apps.list"               Empty                 -> AppsListResult
pub struct AdminExitSubmit;       // "adminExit.submit"        AdminExitSubmitParams -> AdminExitSubmitResult
```

The four enums serialize as the camelCase strings shown in the examples
and use `unknown_on_new_values!` (never `#[serde(other)]`), like the 1.0
enums. A client that reads `Unknown` for an outcome treats it as a
failure and shows its generic error. A client that reads `AppKind::Unknown`
skips that app.

**Snapshot additions** (optional fields; a 1.0 agent does not send them
and a 1.1 client then reads `None`):

```rust
// crates/rulebox-ipc/src/types.rs — these two ARE exported to TypeScript, like every part of AgentSnapshot
pub struct AdminExitInfo { pub enabled: bool, pub hotkey: String }               // hotkey: canonical text, grammar below
pub struct PowerOptions  { pub sleep: bool, pub restart: bool, pub shut_down: bool }
// AgentSnapshot gains, each with #[serde(default)] and serialized as null when None:
//   pub admin_exit: Option<AdminExitInfo>,   // "adminExit". The 1.1 agent always sends it
//   pub power: Option<PowerOptions>,         // "power".     null until the document carries it (Phase 4)
//   pub org_name: Option<String>,            // "orgName".   null until the document carries it (Phase 4)
```

```jsonc
"adminExit": { "enabled": true, "hotkey": "Ctrl+Shift+F12" }, "power": null, "orgName": null
```

- `adminExit.enabled` is true only when the organization has not
  disabled the exit **and** a valid PIN is set. When false,
  `adminExit.submit` answers `disabled` and the Staff App ignores the key
  combination.
- `power` null means "all three allowed"; `orgName` null means "use
  `desiredState.branding.name`" (Phase 3 R4).
- The snapshot never contains the PIN hash, the failure counter, or
  anything about the signed-in employee (use `session.get`).

**New enum values** (old clients read them as `unknown`):
`ClientRole` gains `launcher` (`rulebox-shell.exe`) and `admin` (the
CLI on the admin pipe); `ShutdownReason` gains `adminExit`. The role is
only a label for logs and for the watchdog (Step 13); it is never used
to decide what a client may do.

**Event change:** `agent.shuttingDown` is also sent with
`{ reason: "adminExit", graceMs: 2000 }` after a correct PIN (Section
5.10, step 10).

**Key-combination text** (`rulebox_ipc::hotkey`, used by the agent to
validate the document, by the launcher, and offered to Phase 3):

```rust
// crates/rulebox-ipc/src/hotkey.rs  (pure, no Windows types)
pub const DEFAULT_ADMIN_EXIT_HOTKEY: &str = "Ctrl+Shift+F12";
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hotkey { pub ctrl: bool, pub alt: bool, pub shift: bool, pub key: HotkeyKey }
pub enum HotkeyKey { Letter(char /* 'A'..='Z' */), Digit(u8 /* 0..=9 */), Function(u8 /* 1..=12 */) }
pub enum HotkeyError { Empty, UnknownToken(String), NoKey, TwoKeys, DuplicateModifier, NeedsCtrlOrAlt }
pub fn parse(text: &str) -> Result<Hotkey, HotkeyError>;
impl Hotkey { pub fn canonical(&self) -> String;      // "Ctrl+Alt+Shift+<KEY>", modifiers in that order, key upper-case
              pub fn virtual_key(&self) -> u32; }     // 'A'..'Z' = 0x41.., '0'..'9' = 0x30.., F1..F12 = 0x70..0x7B
```

Grammar: tokens separated by `+`; spaces around a token are ignored;
case-insensitive; modifiers `Ctrl`, `Alt`, `Shift`, each at most once;
exactly one key: a letter `A`–`Z`, a digit `0`–`9`, or `F1`–`F12`; at
least one of `Ctrl` or `Alt` must be present. Everything else is an
error (so `Alt+Tab`, `Ctrl+Esc` and `Ctrl+Alt+Del` cannot be expressed).
The snapshot always carries the canonical form of a valid combination.

**Security rules for every 1.1 method** (they restate Section 6.2 for
the new surface; later phases must keep them):

1. Any process in the Staff session can call every method. Each one is
   therefore judged by "what can a hostile Staff process gain?":

   | Method | Worst case for a hostile caller | Why that is acceptable |
   |---|---|---|
   | `session.signIn`, `session.verifyPassword` | Guessing a password | Rate limit and lockout in the agent, per username and per device, persisted (Section 5.9) |
   | `session.signOut` | Ends the employee's Rulebox session | Nuisance only; such a process can already close the Staff App's windows |
   | `session.get`, `apps.list` | Reads who is signed in and their catalogue (including desktop `exe` paths) | The same Windows session already shows this |
   | `adminExit.submit` | Guessing the PIN; with the PIN, ending the Staff session | Rate limit and lockout per device, persisted; a correct PIN grants no administrator right (Section 5.10) |

2. The PIN hash, password hashes and counters never leave the agent: not
   in a result, an event, the snapshot, `status` or a log.
3. `password` and `pin` are never logged. The dispatcher never logs
   request params or whole frames at any level (Step 6). The params
   types have a redacting `Debug`.
4. The agent uses nothing from the caller except the fields above. It
   signs out the **caller's own verified session** and no other. It
   never opens, creates or runs a path because of an IPC request;
   `filesRoot` and `exe` are strings it hands **out**.
5. Limits are counted per device or per username, never per connection
   (a caller can open a new connection at will).

**Simulated agent** (`run --console --simulate`, Phase 3 R9):

| Started with | `hello` capabilities | 1.1 behaviour |
|---|---|---|
| `--simulate` | `state`, `health`, `adminExit` | Not enrolled (unless `enroll --simulate` was run). `adminExit.submit` → `disabled`. `session.*` and `apps.list` → `unknown_method` |
| `--simulate --sim-demo` | all five | The demo world below |
| `--simulate --sim-demo --sim-offline` | all five | The demo world with `connection: "offline"`; the fixture directory answers `Unreachable`, so only cached employees can sign in |

The demo world (`fixtures.rs`; state persists in `target\sim-data\`
between runs, delete that folder to reset caches and lockouts):

- Snapshot: `enrollment: "enrolled"`, device
  `{ id: "sim-device", name: "Simulated PC" }`, `connection: "online"`,
  `kiosk: { enabled: true, phase: "applied", errorCode: null }`,
  `desiredState` = `EXAMPLE_DESIRED_STATE_JSON`,
  `adminExit: { enabled: true, hotkey: "Ctrl+Shift+F12" }`,
  `power: { sleep: true, restart: true, shutDown: true }`,
  `orgName: "Demo Company"`.
- Employees (password `demo` for all): `maya` (Maya Chen, role
  "Cashier", 10 GiB, `offline_days` 7), `sam` (Sam Ortiz, role
  "Manager", 10 GiB, `offline_days` 0, so `sam` is always
  `offlineExpired` when offline), `alex` (answers `disabled`). Any other
  username or password → `wrongCredentials`. These names match Phase 3's
  `DemoAgent`.
- Catalogue (the same for both employees): `files` (builtin, tool
  `files`), `orders-web` (web, the example above), `mail-web` (web,
  `https://mail.example.com`, not pinned to the taskbar), `notepad`
  (desktop, `exe` = `%SystemRoot%\System32\notepad.exe` expanded at
  start, `args` empty, `fileArgTemplate` `["{file}"]`). No icons.
- `filesRoot` = `<data dir>\sim-files\<employee id>`.
- Exit PIN `2468` (hashed with `kdf::hash_secret` when the fixture is
  built). A correct PIN answers `signingOut`, sends the
  `agent.shuttingDown` event, and after the 2 seconds logs "simulate:
  would sign the Staff session out to the Windows sign-in screen". No
  real session is touched. Lockouts are real and persist.
- Audit records go to the log (`LogAuditSink`).

---

## 7. Steps

General rules for every step:

- Verification uses the touched crate only, for example
  `cargo clippy -p rulebox-ipc --all-targets -- -D warnings` and
  `cargo test -p rulebox-ipc`. Run the workspace-wide commands only in
  Step 15.
- **Never** run `cargo build --release`, `tauri build`, a test marked
  `#[ignore]`, or any `rulebox-agent` subcommand other than `compat`,
  `hash-pin`, and the `--simulate` forms of `run --console`, `status`,
  `enroll` and `unenroll` on the dev machine.
- No `unwrap()` or `expect()` outside tests, except on values proven
  constant at compile time. Libraries return `thiserror` enums; the agent
  binary adds context with `anyhow`.
- Every `unsafe` block is in `rulebox-win32` (or the launcher's window
  code), is as small as possible, and has a `// SAFETY:` comment. Every
  handle, token, environment block and `LocalAlloc`/`NetApi`/`WTS`/`Lsa`
  buffer is owned by a type whose `Drop` frees it.
- If an API name in this plan does not match the crate version you
  pinned, use the equivalent, and record it under "Deviations" in the
  final report.

---

### Step 0 — Preflight (stop if anything fails)

1. Run and record:

   ```powershell
   rustc --version; cargo --version; node --version; pnpm --version
   Get-CimInstance Win32_LogicalDisk | % { "{0} {1:N1} GB free" -f $_.DeviceID, ($_.FreeSpace/1GB) }
   "{0:N1} GB" -f ((gci target -r -file -ea 0 | measure Length -sum).Sum/1GB)
   git status --short
   ```

2. **Disk.** Phase 2 adds roughly 1–2 GB to `target\debug` (the Convex
   client, more `windows` features, clap). If D: has less than **8 GB**
   free, stop and tell the user. Tell the user before the first build of
   Step 1 that it will download and compile new crates.
3. Confirm the versions in Section 4.4 with `cargo search`.
4. Show the user the open questions in Section 14 and wait for answers.
5. Ask the user which test VMs exist (Section 14, Q15). At least one
   Windows 11 Pro VM with a snapshot is required before Step 14; a Home
   VM is strongly wanted.
6. Confirm `npx convex dev --once` works from the repo root without a
   login prompt. If it prompts, ask the user to run it.

**Done when:** all of the above is recorded and the user has answered
Section 14.

---

### Step 1 — Workspace plumbing

Change `Cargo.toml` (root): add `"apps/shell-launcher"` to `members`; add
`[workspace.dependencies]` (Section 4.4, plus the three internal crates
as `path` entries); add:

```toml
[workspace.lints.rust]
unsafe_op_in_unsafe_fn = "deny"

[workspace.lints.clippy]
unwrap_used = "warn"
expect_used = "warn"
```

Do not change `[profile.*]`. Keep `debug = "line-tables-only"`.

Create empty crates (each `Cargo.toml` uses `edition.workspace = true`,
`license.workspace = true`, `publish = false`, `version = "0.0.0"`,
`[lints] workspace = true`):

- `crates/rulebox-ipc` — `src/lib.rs` with a doc comment only. Features:
  `client = ["dep:tokio", "dep:tokio-util", "dep:futures-util", "dep:rulebox-win32"]`,
  `server = [same]`, default none. `rulebox-win32` goes under
  `[target.'cfg(windows)'.dependencies]`.
- `crates/rulebox-win32` — `src/lib.rs` starting with `#![cfg(windows)]`.
- `apps/shell-launcher` — package `rulebox-shell`, `src/main.rs` with an
  empty `main`.

Add `[lints] workspace = true` to `crates/rulebox-policy` and
`apps/agent`, and fix whatever the new lints report there (the stub's
`.expect` becomes a proper error in Step 5; for now allow it with a
one-line `#[allow]` and a comment).

Change root `package.json`:

```json
"gen:types": "cargo test -p rulebox-policy -p rulebox-ipc export_bindings"
```

(Done, with exactly this line. Rule from Phase 3 R6: the script must
list **every** crate that exports types. When Phase 3's `rulebox-staff`
has `#[ts(export)]` types the line becomes
`cargo test -p rulebox-policy -p rulebox-ipc -p rulebox-staff export_bindings`.
Both phases edit this line and `packages/types/src/index.ts`; whoever
lands second merges, never overwrites. Step 5a says when to check.)

**Verify:** `cargo check --workspace` → finishes with no errors.
`cargo metadata --no-deps --format-version 1 | Select-String target_directory`
→ the single `target` directory at the repo root.

**Done when:** both pass and there is no `target\` folder anywhere except
the repo root.

---

### Step 2 — `rulebox-ipc`: contract types and codec

Create `envelope.rs`, `methods.rs`, `types.rs`, `codec.rs` and fill
`lib.rs`, exactly as specified in Section 6.

- `lib.rs` constants: `PROTOCOL_MAJOR: u16 = 1`, `PROTOCOL_MINOR: u16 = 0`,
  `SHELL_PIPE`, `ADMIN_PIPE`, `SIM_SUFFIX = ".sim"`,
  `MAX_FRAME_LEN: usize = 1_048_576`, `MAX_IN_FLIGHT: usize = 16`,
  `HELLO_DEADLINE`, `HEARTBEAT_INTERVAL` (10 s), `HEARTBEAT_TIMEOUT`
  (30 s), `CAPABILITIES: &[&str] = &["state", "health"]`.
- `methods.rs`: unit structs `Hello`, `StateGet`, `ShellReady`,
  `ShellHeartbeat` implementing `Method`; `struct Empty {}` for `{}`.
- `codec.rs` (behind `cfg(any(feature = "client", feature = "server"))`):

  ```rust
  pub struct FrameCodec { inner: tokio_util::codec::LengthDelimitedCodec }
  impl FrameCodec { pub fn new() -> Self }       // 4-byte big-endian length, max_frame_length = MAX_FRAME_LEN
  impl Decoder for FrameCodec { type Item = Frame; type Error = CodecError; }
  impl Encoder<Frame> for FrameCodec { type Error = CodecError; }
  pub enum CodecError { Io(std::io::Error), TooLarge, InvalidJson(String) }
  ```

- `rulebox-ipc` depends on `rulebox-policy` (for `DesiredState` inside
  `AgentSnapshot`).
- `admin.rs`: `AdminStatusResult`, `AdminEnrollParams { code, device_name:
  Option<String>, allow_joined: bool }`, `AdminEnrollResult`,
  `AdminUnenrollParams { remove_staff_account: bool }`, and the method
  structs `AdminStatus`, `AdminEnroll`, `AdminUnenroll`. No `#[ts(export)]`
  here.

Unit tests (inline `#[cfg(test)]`, same style as `rulebox-policy`):

1. Each envelope example in Section 6.4 parses and re-serializes to the
   same JSON value.
2. A frame with an unknown extra field parses.
3. `ClientRole`, `EnrollmentStatus` and `ErrorCode` map an unknown string
   to their `Unknown` / `Internal` variant.
4. Codec round trip; two frames in one buffer; a frame split across two
   reads; a length prefix of `MAX_FRAME_LEN + 1` returns `TooLarge`.
5. A golden test: `AgentSnapshot` with every field set serializes to a
   JSON literal written in the test. This pins the wire format.

Then run `pnpm gen:types` and add one `export * from "./generated/<File>"`
line per new generated file to `packages/types/src/index.ts`.

**Verify:**

```powershell
cargo clippy -p rulebox-ipc --all-targets --all-features -- -D warnings
cargo test -p rulebox-ipc --all-features
pnpm gen:types
pnpm --filter @rulebox/types typecheck
```

**Done when:** all four pass and `packages/types/src/generated/` contains
`AgentSnapshot.ts`, `HelloParams.ts`, `HelloResult.ts` and the types they
reference.

---

### Step 3 — `rulebox-win32` foundation and the test-machine guard

Create `error.rs`, `util.rs`, `guard.rs`, `sid.rs`, `security.rs`.

```rust
// error.rs
#[derive(thiserror::Error, Debug)]
pub enum Win32Error {
    #[error("blocked by the test-machine guard: {0}")] Guard(String),
    #[error("{api} failed with Win32 error {code}")] Api { api: &'static str, code: u32 },
    #[error("{api} failed with NTSTATUS {status:#x}")] Nt { api: &'static str, status: i32 },
    #[error("{0}")] Invalid(String),
}
pub type Result<T> = std::result::Result<T, Win32Error>;

// util.rs
pub fn to_wide(s: &str) -> Vec<u16>;                 // NUL-terminated; error-free
pub unsafe fn from_wide_ptr(p: *const u16) -> String;
pub struct OwnedHandle(HANDLE);                      // CloseHandle on Drop; never wraps INVALID/NULL
pub struct LocalAllocGuard(*mut c_void);             // LocalFree on Drop

// sid.rs
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Sid(String);                              // canonical "S-1-…" string, validated
impl Sid { pub fn parse(s: &str) -> Result<Sid>; pub fn as_str(&self) -> &str;
           pub fn system() -> Sid; pub fn builtin_admins() -> Sid; pub fn builtin_users() -> Sid; }
pub fn current_user_sid() -> Result<Sid>;
pub fn lookup_account_name(name: &str) -> Result<Option<Sid>>;
pub fn localized_group_name(sid: &Sid) -> Result<String>;     // e.g. S-1-5-32-545 -> "Users" / "Benutzer"

// security.rs
pub struct SecurityAttributes { /* owns the descriptor */ }
impl SecurityAttributes { pub fn from_sddl(sddl: &str) -> Result<Self>; pub fn as_ptr(&self) -> *mut c_void; }
pub const PROTECTED_DIR_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
pub fn create_protected_dir(path: &Path) -> Result<()>;          // guarded
pub fn verify_protected_dir(path: &Path) -> Result<DirCheck>;    // read-only: exists, not a reparse point, owner, DACL matches
pub fn enable_privileges(names: &[&str]) -> Result<()>;          // AdjustTokenPrivileges on the process token

// guard.rs
pub const MARKER_KEY: &str = r"SOFTWARE\Rulebox\TestMachine";
pub const MARKER_VALUE: &str = "ComputerName";
/// Ok only if HKLM\SOFTWARE\Rulebox\TestMachine\ComputerName (REG_SZ) equals this
/// computer's name (case-insensitive). Read-only. Never creates the marker.
pub fn require_test_machine() -> Result<()>;
pub fn is_test_machine() -> bool;
```

**Guard rules (this is the enforcement the project requires):**

- Every function in `rulebox-win32` that changes the machine starts with
  `guard::require_test_machine()?;`. Mark each such function with the doc
  line `/// DESTRUCTIVE: guarded.` so reviewers can grep for it.
- There is **no** bypass: no environment variable, no cargo feature, no
  CLI flag. Phase 6 decides how release builds satisfy the guard.
- The marker is created **only by the user, by hand, on a VM**:

  ```powershell
  # Run in an elevated PowerShell ON THE TEST VM ONLY
  New-Item -Path 'HKLM:\SOFTWARE\Rulebox\TestMachine' -Force | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Rulebox\TestMachine' -Name ComputerName -Value $env:COMPUTERNAME
  ```

  Binding the marker to the computer name means a copied `.reg` file or
  script does not unlock a different machine.
- You never run these lines. If `is_test_machine()` returns true on the
  machine you are working on, stop and tell the user.

Unit tests (safe on the dev machine, all read-only):

1. `Sid::parse` accepts `S-1-5-18`, rejects `"Staff"` and `""`.
2. `current_user_sid()` returns a SID starting with `S-1-5-21-`.
3. `SecurityAttributes::from_sddl(PROTECTED_DIR_SDDL)` succeeds;
   `from_sddl("garbage")` fails.
4. `localized_group_name(&Sid::builtin_users())` is non-empty.
5. `require_test_machine()` returns `Err(Guard(_))` on the dev machine.
   **If this test fails, stop**: the dev machine is marked as a test
   machine.

**Verify:** `cargo clippy -p rulebox-win32 --all-targets -- -D warnings`
and `cargo test -p rulebox-win32`.

**Done when:** both pass, including test 5.

---

### Step 4 — Named-pipe transport

`crates/rulebox-win32/src/pipe.rs`:

```rust
pub fn shell_pipe_sddl(client: &Sid) -> String;   // Section 6.2, with the SID substituted
pub fn admin_pipe_sddl() -> String;               // "O:SYG:SYD:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)"
pub fn sim_pipe_sddl(current_user: &Sid) -> String; // owner + full control: current user; no SY/BA entries needed
pub struct PeerInfo { pub pid: u32, pub session_id: u32, pub user: Sid, pub image_path: Option<PathBuf> }
/// Must be called after at least one read on the pipe. Impersonates, reads the SID, reverts.
/// A failing RevertToSelf aborts the process (std::process::abort) after logging.
pub fn verify_peer(pipe: RawHandle) -> Result<PeerInfo>;
pub fn token_is_elevated_admin(pipe: RawHandle) -> Result<bool>;   // for the admin pipe
/// CreateFileW with the access mask and flags in Section 6.2. Returns an overlapped handle.
pub fn open_client(name: &str) -> Result<OwnedHandle>;            // maps 2 -> NotFound, 231 -> Busy
pub fn pipe_owner(pipe: RawHandle) -> Result<Sid>;
```

None of these is destructive (creating or opening a pipe changes nothing
persistent), so they are **not** guarded.

`crates/rulebox-ipc/src/server.rs` (feature `server`):

```rust
pub struct PipeListener { /* name, SecurityAttributes, next instance */ }
impl PipeListener {
    pub fn bind(name: &str, sddl: &str) -> Result<Self, TransportError>;   // first instance: first_pipe_instance(true)
    /// Waits for a client, creates the NEXT instance first, then returns the connected one.
    pub async fn accept(&mut self) -> Result<Connection, TransportError>;
}
pub struct Connection { /* Framed<NamedPipeServer, FrameCodec> */ }
impl Connection {
    pub async fn read_frame(&mut self) -> Result<Option<Frame>, TransportError>;
    pub async fn write_frame(&mut self, f: Frame) -> Result<(), TransportError>;
    pub fn verify_peer(&self) -> Result<PeerInfo, TransportError>;         // sync; no await inside
    pub fn split(self) -> (FrameReader, FrameWriter);
}
```

Use `tokio::net::windows::named_pipe::ServerOptions` with
`pipe_mode(PipeMode::Byte)`, `reject_remote_clients(true)`,
`max_instances(4)`, 64 KiB buffers and
`create_with_security_attributes_raw` on **every** instance.
`first_pipe_instance(true)` only on the first.

`crates/rulebox-ipc/src/client.rs` (feature `client`): `IpcClient` as in
Section 6.10. Internals: one task that loops connect → verify owner →
`hello` → pump. Requests wait in a `HashMap<u32, oneshot::Sender>`; on
disconnect every waiter gets `CallError::NotLinked`. Wrap the handle from
`open_client` with `NamedPipeClient::from_raw_handle`.

`crates/rulebox-ipc/examples/fake_staff.rs`: a console program that uses
`IpcClient`, prints every `ClientEvent` and the snapshot from
`state.get`, calls `shell.ready`, then heartbeats every 10 seconds. Keys:
`c` exit with code 1 (crash), `h` stop heartbeating (hang), `q` exit with
code 0. It honours `RULEBOX_AGENT_SIM=1`.

Integration test `crates/rulebox-ipc/tests/pipe_roundtrip.rs` (safe on
the dev machine: unique pipe name
`\\.\pipe\dev.rulebox.test.<pid>.<n>`, `sim_pipe_sddl(current user)`):

1. A client connects, sends `hello`, the server's `verify_peer` returns
   the current user's SID and the test process's PID.
2. A request/response pair with out-of-order replies resolves correctly.
3. A second `PipeListener::bind` on the same name fails (first-instance
   protection).
4. The same test with the Staff ACE shape: an SDDL granting **only**
   `(A;;0x12019b;;;<current user SID>)` plus owner. The client must still
   connect and exchange a frame. This confirms the reduced access mask
   works. Note in the report whether the test process was elevated (an
   elevated run is a weaker proof; the VM checklist repeats it properly).
5. Dropping the server end makes a pending `call` return `NotLinked`.

**Verify:** `cargo clippy -p rulebox-ipc --all-targets --all-features -- -D warnings`,
`cargo test -p rulebox-ipc --all-features`,
`cargo build -p rulebox-ipc --example fake_staff --features client`.

**Done when:** all pass.

---

### Step 5 — Agent skeleton: CLI, logging, state, simulate mode

Rewrite `apps/agent`. Files: `main.rs`, `cli.rs`, `paths.rs`,
`logging.rs`, `state.rs`, `secrets.rs`, `platform/mod.rs`,
`platform/sim.rs`, `agent.rs` (minimal for now).

CLI (clap derive):

```
rulebox-agent service run                      # started by the service manager only
rulebox-agent service install | uninstall      # Step 11 (guarded)
rulebox-agent run --console [--simulate] [--data-dir <path>]
rulebox-agent enroll <CODE> [--name <device name>] [--allow-joined] [--simulate]
rulebox-agent status [--json] [--simulate]
rulebox-agent unenroll [--remove-staff-account] [--simulate]
rulebox-agent recover [--yes]                  # Step 11 (guarded, offline)
rulebox-agent compat [--json]                  # read-only; safe everywhere
```

- `run --console` without `--simulate` uses `WindowsPlatform` and
  therefore needs the guard; it is for VM debugging under SYSTEM only.
  Print a one-line warning saying so.
- `--simulate` uses `SimPlatform`, the `.sim` pipe names, and a data
  directory that defaults to `<repo or cwd>\target\sim-data\` (inside
  `target\`, so it is ignored by git and removed by `cargo clean`).
- `logging.rs`: `init(dir: &Path, also_stderr: bool) -> WorkerGuard`.
  Daily rolling file `agent.<date>.log`, `max_log_files(14)`,
  non-blocking writer; keep the guard alive until just before exit.
  Default level `info`; `RULEBOX_LOG=debug` raises it.
- Panic hook, installed first in `main`: logs message, location and
  `Backtrace::force_capture()` with `tracing::error!`, and also appends
  the same text synchronously to `<logs>\agent-panic.log`. After a panic
  the process must end **without** reporting a clean stop, so the service
  manager restarts it.
- `state.rs` and `secrets.rs` as in Section 5.1. `StateStore::open(dir)`,
  `load() -> AgentState`, `save(&AgentState)`; same for secrets through
  `Platform::secrets_load/save`.
- `platform/sim.rs`: `SimPlatform` holds a `Mutex<SimWorld>` (users,
  machine registry values, LSA secrets, sessions, processes, staff hive
  values) and `fail_next(op: SimOp, err: PlatformError)` for tests. Its
  `os_info` returns a fixed Windows 11 Pro, 8 GB machine unless a test
  changes it. `secrets_*` store plaintext in a file under the data
  directory (simulate mode holds no real secrets).
- `agent.rs`: `pub async fn run(deps: Deps, shutdown: CancellationToken,
  control_rx: mpsc::UnboundedReceiver<ControlEvent>) -> anyhow::Result<()>`
  where `Deps { platform: Arc<dyn Platform>, backend_factory, paths,
  config, simulate: bool }`. For now it loads state, builds the initial
  `AgentSnapshot`, and waits for `shutdown`. Console mode maps Ctrl+C to
  `shutdown.cancel()`.
- `paths.rs` tests: install and data paths are built from the known
  folders, never from a literal drive letter.

Unit tests: state save/load round trip; corrupt file is renamed and the
default returned; atomic write leaves no `.tmp`; `Secrets` `Debug` output
contains no secret; CLI parses each command line above.

**Verify:**

```powershell
cargo clippy -p rulebox-agent --all-targets -- -D warnings
cargo test -p rulebox-agent
cargo run -p rulebox-agent -- run --console --simulate    # then Ctrl+C
```

**Done when:** tests pass; the simulate run logs "agent started
(simulate)" and exits cleanly on Ctrl+C with a log file under
`target\sim-data\logs\`.

---

### Step 5a — Contract 1.1 in `rulebox-ipc` (types and client only; no agent code)

Read Section 6.11 and the "(1.1)" notes in Sections 6.2, 6.5 and 6.7
first. This step changes files written in Steps 2 to 4 and adds two.
Nothing here removes or renames a 1.0 item.

| File | Change |
|---|---|
| `crates/rulebox-ipc/src/lib.rs` | `PROTOCOL_MINOR = 1`. Add `pub mod requests;`, `pub mod hotkey;`, `pub const CAP_SESSION: &str = "session";`, `CAP_APPS = "apps"`, `CAP_ADMIN_EXIT = "adminExit"`. `CAPABILITIES` stays `["state", "health"]`. Move the `unknown_on_new_values!` macro from `types.rs` to the top of `lib.rs` (before the `mod` lines, `macro_rules!` without `#[macro_export]`) so `types.rs` and `requests.rs` both see it. Update the crate doc comment to say "protocol 1.1" |
| `envelope.rs` | `ErrorCode` gains `NotSignedIn` and `OperationFailed` (place them before `Internal`). Extend the existing test: `"not_signed_in"` and `"operation_failed"` round-trip |
| `types.rs` | Add `AdminExitInfo`, `PowerOptions`; the three `AgentSnapshot` fields; `ClientRole::{Launcher, Admin}`; `ShutdownReason::AdminExit`; extend the three macro invocations and the tests `unknown_enum_values_map_to_unknown` / `every_enum_value_round_trips` |
| `requests.rs` (new) | Everything in the `requests.rs` block of Section 6.11 |
| `methods.rs` | The six method structs of Section 6.11; extend `method_names_match_the_contract` |
| `hotkey.rs` (new) | As in Section 6.11 |
| `admin.rs` | `OperationFailure`, `mod reasons` (Section 6.7). `AdminStatusResult` gains `#[serde(default)] pub extra: Option<AdminStatusExtra>` with `pub struct AdminStatusExtra { pub employee: Option<String>, pub admin_exit_failures: u32, pub admin_exit_locked_for_ms: Option<u64>, pub admin_exit_problem: Option<String>, pub audit_queued: u32 }` (camelCase; filled from Step 6a on) |
| `crates/rulebox-win32/src/pipe.rs` | `pub fn server_session_id(pipe: RawHandle) -> Result<u32>` (`GetNamedPipeServerSessionId`). `pub fn probe_create_instance(name: &str) -> Result<Option<u32>>`: tries `CreateNamedPipeW` on an **existing** name with the same mode as `create_server_instance`, no security attributes and no first-instance flag; closes the handle at once; returns `None` if the call **succeeded** and `Some(win32 error)` if it failed. Neither is destructive, so neither is guarded |
| `client.rs` | See below |
| `packages/types/src/index.ts`, `packages/types/src/generated/` | Regenerated: `AgentSnapshot.ts`, `ClientRole.ts`, `ShutdownReason.ts` change; `AdminExitInfo.ts` and `PowerOptions.ts` are new and get one export line each |

`client.rs`:

```rust
pub struct ClientConfig { pub pipe_name: String, pub trusted_owner: Sid, pub request_timeout: Duration,
                          pub require_session_zero: bool }      // new: Section 6.2, client check 3
impl ClientConfig {
    pub fn production() -> Self;            // unchanged, plus require_session_zero = true (false on the .sim branch)
    pub fn admin(simulate: bool) -> Self;   // ADMIN_PIPE (+ SIM_SUFFIX and the current user as owner when simulate); session check on unless simulate
    pub fn with_timeout(self, timeout: Duration) -> Self;
}
/// One connection, `hello`, one request, close. Blocks the calling thread: it builds a
/// current-thread tokio runtime. Never call it from inside a runtime.
/// Pipe missing or connection lost -> NotLinked. Owner or session check failed -> ServerNotTrusted.
pub fn call_once<M: Method>(config: ClientConfig, info: ClientInfo, params: M::Params) -> Result<M::Result, CallError>;
```

- `connect` calls `server_session_id` after the owner check when
  `require_session_zero` is set; a value other than 0 is
  `ConnectError::NotTrusted`.
- `call_once` reuses `connect` and `say_hello`; it does not reconnect and
  waits for the pipe at most `BUSY_GIVE_UP`.
- The client accepts a `hello` result with minor 0 or 1 (it already
  ignores minor). Fix every `ClientConfig { .. }` literal in
  `tests/pipe_roundtrip.rs` and `examples/fake_staff.rs` (set
  `require_session_zero: false` in tests: the test server is not in
  session 0).

Unit tests to add:

1. `types.rs`: update `snapshot_golden_json` (the three new keys, with
   `adminExit` set, `power` set, `orgName` set) and
   `snapshot_with_nothing_set_serializes_nulls` (the three are `null`).
   New: a snapshot JSON **without** the three keys (a 1.0 agent) parses,
   and the three fields are `None`.
2. `requests.rs`: one golden test per JSON example in Section 6.11 (parse
   and re-serialize to the same value); every enum maps an unknown
   string to `Unknown`; a `SignInResult` JSON containing only
   `{ "outcome": "wrongCredentials" }` parses (missing fields default);
   `format!("{:?}", SignInParams { .. })`, the same for
   `VerifyPasswordParams` and `AdminExitSubmitParams`, does not contain
   the secret; `WebPermissions::default()` has only `notifications` and
   `downloads` true.
3. `hotkey.rs`: `"Ctrl+Shift+F12"`, `" ctrl + shift + f12 "` and
   `"shift+CTRL+F12"` parse to the same value and `canonical()` is
   `"Ctrl+Shift+F12"`; `"Ctrl+Alt+Shift+R"` round-trips; errors for `""`,
   `"Shift+A"` (`NeedsCtrlOrAlt`), `"Ctrl"` (`NoKey`), `"Ctrl+A+B"`
   (`TwoKeys`), `"Ctrl+Ctrl+A"`, `"Ctrl+Del"`, `"Alt+Tab"`, `"Ctrl+F13"`;
   `virtual_key` for `A`, `0`, `F1`, `F12` is `0x41`, `0x30`, `0x70`,
   `0x7B`; `parse(DEFAULT_ADMIN_EXIT_HOTKEY)` is `Ok`.
4. `admin.rs`: `OperationFailure` round-trips the JSON in Section 6.7.
5. `tests/pipe_roundtrip.rs`: `call_once` against a test server returns
   the result; against a missing pipe returns `NotLinked` within
   6 seconds; with `require_session_zero: true` against the test server
   (which runs in your session, not session 0) returns
   `ServerNotTrusted`. `probe_create_instance` on the test pipe's name
   returns `None` or `Some(_)`; record which in the report (the test
   server grants the current user everything, so this proves only that
   the function runs).

Then run `pnpm gen:types`. Before you do, search
`apps/staff-app/src-tauri/src` for `ts(export`. If Phase 3 has exported
types there and the `gen:types` line in the root `package.json` does not
list `-p rulebox-staff`, **stop and ask the user** (adding it compiles
the Tauri crate in the test profile, which is several GB; Step 1 note).

**Verify:**

```powershell
cargo clippy -p rulebox-ipc --all-targets --all-features -- -D warnings
cargo test -p rulebox-ipc --all-features
cargo clippy -p rulebox-win32 --all-targets -- -D warnings
cargo test -p rulebox-win32
cargo clippy -p rulebox-agent --all-targets -- -D warnings
cargo test -p rulebox-agent
pnpm gen:types
pnpm --filter @rulebox/types typecheck
```

**Done when:** all pass (the agent crate must still compile:
`initial_snapshot` sets the three new fields to `None` for now);
`packages/types/src/generated/AgentSnapshot.ts` contains `adminExit`,
`power` and `orgName`; no file named `Employee.ts`, `AppEntry.ts` or
`SignInParams.ts` was generated by `rulebox-ipc`.

---

### Step 6 — IPC servers in the agent (unblocks Phase 3)

Files: `ipc_shell.rs`, `ipc_admin.rs`, wiring in `agent.rs`, and the
`status` / `enroll` / `unenroll` arms of `dispatch` in `main.rs`.

```rust
// ipc_shell.rs
pub struct PeerCtx { pub connection_id: u64, pub pid: u32, pub session_id: u32, pub role: ClientRole }
/// How later steps add methods without touching the server (Steps 6a and 6b implement it).
pub trait ShellExtension: Send + Sync + 'static {
    fn capabilities(&self) -> Vec<&'static str>;
    /// None = not my method. The future must not borrow `params`.
    fn handle(&self, peer: &PeerCtx, method: &str, params: serde_json::Value)
        -> Option<BoxFuture<'static, Result<serde_json::Value, RpcError>>>;
}
#[derive(Clone)] pub struct ShellBroadcast { /* tokio::sync::broadcast::Sender<Frame>, capacity 16 */ }
impl ShellBroadcast { pub fn new() -> Self; pub fn shutting_down(&self, reason: ShutdownReason, grace_ms: u64); }
pub enum ShellSignal { Connected { connection_id: u64, pid: u32, role: ClientRole }, Ready { connection_id: u64, pid: u32 },
                       Heartbeat { connection_id: u64, pid: u32 }, Closed { connection_id: u64 } }
pub enum PeerPolicy { Production { staff_sid: Sid, install: InstallPaths }, Simulate { current_user: Sid } }
pub struct ShellServer { pub snapshot_rx: watch::Receiver<AgentSnapshot>, pub signals: mpsc::UnboundedSender<ShellSignal>,
                         pub broadcast: ShellBroadcast, pub extensions: Vec<Arc<dyn ShellExtension>>, pub peers: PeerPolicy }
pub async fn serve(listener: PipeListener, server: ShellServer, shutdown: CancellationToken);
pub fn image_allowed(install: &InstallPaths, image: &Path) -> bool;      // Section 6.2, server check 3 (pure)
```

- `serve`: accept loop; one task per connection; enforces the `hello`
  deadline, peer verification (Section 6.2; with `PeerPolicy::Simulate`
  only the SID check, against the current user), `MAX_IN_FLIGHT`, and
  the outbound queue with coalescing. `shell.ready` and
  `shell.heartbeat` send `ShellSignal`s. Every change of the `watch`
  snapshot becomes a `state.changed` event. Frames sent through
  `ShellBroadcast` go to every connection.
- **Dispatch:** `hello`, `state.get`, `shell.ready`, `shell.heartbeat`
  are built in. Any other method is offered to each extension in order;
  the first `Some` answers. No extension takes it → `unknown_method`.
- **`hello`** answers protocol `{ major: 1, minor: 1 }` and
  `capabilities` = `CAPABILITIES` followed by every extension's list. In
  this step the extension list is empty, so the answer lists `state` and
  `health` only.
- **Never log secrets:** the server logs the method name, request id,
  connection id, peer pid and whether the answer was a result or an
  error code. It never logs `params`, a result, or a whole frame, at any
  log level. From Step 6a on, params carry passwords and PINs.
- `agent::run` now keeps the `watch::Receiver<AgentSnapshot>` it used to
  drop and hands a clone to the shell server and to the admin server.
- The shell listener is (re)created whenever the Staff SID becomes known
  or changes, and dropped when it becomes unknown. **Simulate mode now
  starts both pipes at once** (it started none in Step 5): names with
  `SIM_SUFFIX`, `sim_pipe_sddl(current user)`, `PeerPolicy::Simulate`.
- `ipc_admin::serve(...)`: same framing and envelope on the admin pipe.
  Verification: `peer_is_elevated_admin` must be true (the pipe DACL
  already excludes everyone else; this is the second check; skipped in
  simulate mode). Methods: `admin.status`, `admin.enroll`,
  `admin.unenroll`. Until Steps 8 and 11 land, `admin.enroll` and
  `admin.unenroll` answer `operation_failed` with reason
  `not_available_yet` (Section 6.7). Only one `admin.enroll` or
  `admin.unenroll` runs at a time; a second gets `busy`.
- CLI side (`ipc_admin.rs`, "CLI client helpers"): `status`, `enroll`
  and `unenroll` use `rulebox_ipc::client::call_once` with
  `ClientConfig::admin(simulate)`, `ClientRole::Admin`, a 150-second
  timeout for `enroll` and 10 seconds otherwise. These commands do not
  initialise file logging and do not open the data directory
  (Section 5.1). `CallError::NotLinked` → print "The Rulebox Agent
  service is not running." and exit with code 2. `CallError::Rpc` with
  code `operation_failed` → print as in Section 6.7 and exit with code
  3. `status` prints the snapshot as text, or JSON with `--json`.

Tests (run on the dev machine with `SimPlatform` and `.sim`-style unique
pipe names):

1. A client that sends `state.get` first gets `hello_required` and is
   disconnected.
2. `hello` with major 2 gets `unsupported_protocol` with
   `data.supported`.
3. A client that connects and sends nothing is dropped after 5 seconds
   (use `tokio::time::pause`).
4. Changing the snapshot produces exactly one `state.changed` per client;
   50 rapid changes with a client that does not read produce at most the
   queue limit and end with the newest snapshot.
5. 17 concurrent in-flight requests: the 17th gets `busy`.
6. `agent.shuttingDown` is sent to connected clients when `shutdown` is
   cancelled.
7. A test extension that lists capability `x` and answers `x.echo`:
   `hello` lists `state`, `health`, `x`; `x.echo` returns its params;
   `x.other` gets `unknown_method`.
8. With a capturing `tracing` writer at `trace` level, a request whose
   params contain `"password": "hunter2-do-not-log"` leaves no
   `hunter2-do-not-log` in the captured output.
9. `admin.enroll` answers `operation_failed` with
   `data.reason == "not_available_yet"`, and the CLI helper maps it to
   exit code 3; a missing pipe maps to exit code 2.
10. `image_allowed`: `<install>\versions\1.0\rulebox-staff.exe` → true;
    `<install>\rulebox-shell.exe` → true (also in another letter case);
    `<install>\other.exe`, `<install>\versions\..\x.exe` and
    `C:\Temp\rulebox-shell.exe` → false.

Manual check on the dev machine (two terminals):

```powershell
cargo run -p rulebox-agent -- run --console --simulate
$env:RULEBOX_AGENT_SIM = "1"; cargo run -p rulebox-ipc --example fake_staff --features client
cargo run -p rulebox-agent -- status --simulate
```

**Done when:** tests pass; `fake_staff` prints `Linked` with protocol
1.1, a snapshot with `"enrollment":"notEnrolled"` and `"displayMode"`,
and the agent log shows heartbeats; `status --simulate` prints the same
snapshot. **Tell the user that the 1.0 methods are live on the simulated
agent; the 1.1 methods follow in Steps 6a and 6b.**

---

### Step 6a — Employee session and app catalogue (protocol 1.1)

Read Section 5.9, Section 5.11 and the "Simulated agent" part of Section
6.11. This step builds the agent side of `session.*` and `apps.list`
against `FixtureDirectory`. It makes no Windows call.

New files: `kdf.rs`, `lockout.rs`, `audit.rs`, `directory.rs`,
`employee_cache.rs`, `session.rs`, `fixtures.rs`.

Changed files:

| File | Change |
|---|---|
| root `Cargo.toml` | `argon2` in `[workspace.dependencies]` (check the version with `cargo search argon2 --limit 1`); the two `[profile.dev.package.*]` blocks of Section 4.4 |
| `apps/agent/Cargo.toml` | `argon2 = { workspace = true }` |
| `state.rs` | `StaffAccount.profile_dir: Option<String>` with `#[serde(default)]` |
| `paths.rs` | `DataPaths::lockouts()`, `employee_cache()`, `audit_queue()` (all in `state_dir()`), `sim_files()` (`<root>\sim-files`) |
| `agent.rs` | `Deps` gains `directory: Arc<dyn EmployeeDirectory>`, `audit_sink: Arc<dyn AuditSink>`, `sim: SimOptions { demo: bool, offline: bool }`. `AgentConfig` gains `fixture_directory: bool` (default false; JSON key `fixtureDirectory`). `run` builds the `LockoutStore`, `AuditQueue`, `EmployeeCache` and `SessionManager`, registers the manager as a `ShellExtension`, starts the `audit` task, and in demo mode overlays the demo snapshot (Section 6.11; its `adminExit`, `power` and `orgName` values arrive in Step 6b and are `None` until then) and sets the files base to `paths.sim_files()` |
| `cli.rs`, `main.rs` | `run` gains `--sim-demo` and `--sim-offline` (both require `--simulate`; `--sim-offline` requires `--sim-demo`). `run_simulated` passes `FixtureDirectory` when `--sim-demo` is set and `UnavailableDirectory` otherwise, and always `LogAuditSink` |
| `ipc_admin.rs` | `admin.status` fills `extra.employee` and `extra.audit_queued` |
| `crates/rulebox-ipc/examples/fake_staff.rs` | New keys, shown only when the capability is present: `i` sign in (then reads one line: `username password`), `o` sign out, `g` `session.get`, `a` `apps.list` (prints id, kind and name per app), `v` verify password (reads one line). Each prints the result as JSON. Never print the typed password back |

```rust
// lockout.rs — the types of Section 5.9, plus:
pub struct LockoutStore { /* path, data */ }
impl LockoutStore { pub fn open(path: PathBuf) -> std::io::Result<Self>;            // missing file = empty; corrupt = renamed aside (state::read_json)
                    pub fn employee(&mut self, username: &str) -> &mut Counter;
                    pub fn admin_exit(&mut self) -> &mut Counter;
                    pub fn admin_exit_pin_id(&mut self) -> &mut Option<String>;
                    pub fn save(&mut self, now_ms: u64) -> std::io::Result<()>; }   // prunes, then state::write_atomic
pub struct DeviceGuard { /* VecDeque<u64> of failure times */ }                      // the 20-in-10-minutes rule, memory only
impl DeviceGuard { pub fn check(&mut self, now_ms: u64) -> Option<u64 /* retry_after_ms */>; pub fn record_failure(&mut self, now_ms: u64); }

// employee_cache.rs
pub struct CacheEntry { pub username: String, pub employee: Employee, pub apps: Vec<AppEntry>, pub password_hash: String,
                        pub offline_days: u32, pub last_online_ms: u64 }             // Debug redacts password_hash
pub struct EmployeeCache { /* path, entries */ }
impl EmployeeCache { pub fn open(path: PathBuf) -> std::io::Result<Self>; pub fn get(&self, username: &str) -> Option<&CacheEntry>;
                     pub fn put(&mut self, entry: CacheEntry) -> std::io::Result<()>;   // keeps the newest 50
                     pub fn remove(&mut self, username: &str) -> std::io::Result<()>; }
pub fn is_expired(entry: &CacheEntry, now_ms: u64, last_wall_clock_ms: u64) -> bool;

// session.rs
pub struct SessionDeps { pub directory: Arc<dyn EmployeeDirectory>, pub cache: EmployeeCache, pub lockouts: Arc<Mutex<LockoutStore>>,
                         pub audit: Arc<AuditHandle>, pub snapshot_rx: watch::Receiver<AgentSnapshot>,
                         pub files_base: Option<PathBuf>, pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync> }
pub struct SessionManager { /* … */ }
impl SessionManager { pub fn new(deps: SessionDeps) -> Arc<Self>;
                      pub fn set_files_base(&self, base: Option<PathBuf>);
                      pub fn clear(&self, reason: &'static str);                       // Staff session ended, admin exit, revoked
                      pub fn current_username(&self) -> Option<String>; }
impl ShellExtension for SessionManager { /* capabilities: ["session", "apps"] when directory.available(), else none */ }
pub fn files_folder_name(employee_id: &str) -> String;                                // Section 5.9 "Files root"

// audit.rs — the types of Section 5.11, plus:
pub struct AuditHandle { /* Mutex<AuditQueue>, tokio::sync::Notify */ }
impl AuditHandle { pub fn record(&self, kind: AuditKind, username: Option<String>, detail: Option<String>); }   // push + notify; logs an error if the disk write fails
pub async fn run_audit_task(handle: Arc<AuditHandle>, sink: Arc<dyn AuditSink>, mut snapshot_rx: watch::Receiver<AgentSnapshot>, shutdown: CancellationToken);
```

Rules:

- `std::sync::Mutex` guards are never held across an `.await`. Argon2
  runs in `tokio::task::spawn_blocking`.
- `SessionManager` reads `connection` and `enrollment` from
  `snapshot_rx`. For the expiry rule it also needs
  `state.last_wall_clock_ms`: add
  `pub clock_floor_ms: Arc<dyn Fn() -> u64 + Send + Sync>` to
  `SessionDeps` (in this step it returns the value loaded from the state
  file; Step 8 keeps that value current). Tests pass plain closures for
  both clocks.
- The real agent chooses the directory when `Deps` is built (Steps 10
  and 11): `FixtureDirectory` only if `config.fixture_directory &&
  rulebox_win32::guard::is_test_machine()`; otherwise
  `UnavailableDirectory`. Write that as one function
  `directory::choose(config, is_test_machine: bool, simulate_demo: bool)`
  now and unit-test it.
- `fixtures.rs` holds the employees, catalogue and demo document of
  Section 6.11. Employee ids are `emp_maya` and `emp_sam`.
- If an API of the `argon2` crate differs from what you expect, keep the
  three function signatures of `kdf.rs` and record the difference under
  "Deviations". **(unverified against the pinned version)**

Unit tests (paused time where waiting is involved; a fake clock through
`now_ms`):

1. `kdf`: `verify_secret("2468", &hash_secret("2468")?)` is true and is
   false for `"2469"`; two hashes of the same secret differ; `check_hash`
   rejects `$argon2i$…`, memory 1,048,576 KiB, 11 passes, and garbage.
   Timing: one `hash_secret` plus one `verify_secret` take **under
   2 seconds** in the dev profile (this proves the `opt-level` override
   works; if it fails, stop and report).
2. `lockout`, password policy: failures 1 to 4 → `Open`; 5th → locked
   30 s; after 30 s one more failure → locked 60 s; then 5 min; then
   15 min; then 15 min again. `clear` resets. 30 minutes without a
   failure resets. Clock moved back during a lock → the full lock time
   remains.
3. `lockout`, PIN policy: `attempts_left` is 4, 3, 2, 1 after failures
   1 to 4; the lock times are 1, 5, 15, 30, 60, 60 minutes; no reset
   after 24 hours without a failure.
4. `LockoutStore` survives a reopen (write, drop, open, same counters);
   unlocked employee entries older than 30 minutes are pruned.
5. `DeviceGuard`: the 21st failure within 10 minutes blocks; it opens
   again when the oldest is 10 minutes old.
6. Sign-in online, happy path: outcome `ok`, `offline: false`,
   `filesRoot` ends with `\emp_maya`, a cache entry exists, and the
   cache file does not contain the text `demo`.
7. Wrong password online → `wrongCredentials`; the offline cache is not
   used even when it holds the right password.
8. Offline with a cache entry → `ok` with `offline: true`; unknown user →
   `offlineNeverSignedIn`; `sam` (0 days) → `offlineExpired`; `maya`
   8 days after her last online sign-in → `offlineExpired`; with the
   local clock set back 30 days she is still `offlineExpired`.
9. Directory `Unreachable` while `connection` is `online` → falls to the
   offline path.
10. `alex` → `disabled`, and a previous cache entry for `alex` is gone.
11. Five wrong passwords → the fifth answer is `lockedOut` with
    `retryAfterMs` near 30,000; a correct password during the lock is
    still `lockedOut`; after the lock it is `ok` and the counter is
    cleared.
12. Count-first: a directory that never answers (the 8-second budget
    fires) → error `timeout`, and the counter is back to its old value.
13. A second `signIn` while one is in progress → error `busy`.
14. Signed in as `maya`, `signIn` as `sam` → error `denied_by_policy`;
    `signIn` as `maya` again → `ok`.
15. `verifyPassword`: no session → `not_signed_in`; right → `ok`; wrong
    five times → `lockedOut`; it makes no directory call (assert on a
    call counter).
16. `apps.list`: no session → `not_signed_in`; signed in → the four
    fixture apps; an icon of 50,000 base64 characters comes back as
    null.
17. `session.get` before and after sign-in; `signOut` twice succeeds;
    `clear` empties the session.
18. Not enrolled → `not_enrolled`; revoked → `denied_by_policy`; empty
    username, 65-character username and 257-character password →
    `invalid_params`.
19. `UnavailableDirectory`: the extension lists no capability, and
    `session.signIn` through the server gets `unknown_method`.
20. `files_folder_name`: `emp_maya` stays; `..\evil` and a 70-character
    id become 32 hex characters.
21. `AuditQueue`: push, reopen, the record is there; the 501st push
    drops the oldest and sets `dropped` to 1; `ack` removes from the
    front. `run_audit_task` with a sink that fails once delivers
    everything after the next trigger and does not call the sink in
    between (assert with paused time advanced by an hour).
22. A lock that starts writes exactly one `EmployeeLockedOut` record
    with the username.
23. `directory::choose`: (fixture on, test machine) → fixture; (fixture
    on, not a test machine) → unavailable; simulate demo → fixture.

Manual check on the dev machine (two terminals):

```powershell
cargo run -p rulebox-agent -- run --console --simulate --sim-demo
$env:RULEBOX_AGENT_SIM = "1"; cargo run -p rulebox-ipc --example fake_staff --features client
# in fake_staff: i  ->  "maya demo"  ->  a  ->  g  ->  v  ->  "demo"  ->  o
# stop the agent, start it again with: --simulate --sim-demo --sim-offline
# in fake_staff: i -> "maya demo" (ok, offline true);  i -> "sam demo" (offlineExpired or offlineNeverSignedIn)
```

**Verify:** `cargo clippy -p rulebox-agent --all-targets -- -D warnings`,
`cargo test -p rulebox-agent`,
`cargo clippy -p rulebox-ipc --all-targets --all-features -- -D warnings`.

**Done when:** tests pass; the manual check shows the results in the
comments; `Select-String -Path target\sim-data\logs\*.log -Pattern "demo"`
finds no password (the word may appear in "Demo Company" or
`--sim-demo`; check each hit); `target\sim-data\state\` contains
`employee-cache.json` and `lockouts.json`.

---

### Step 6b — Hidden admin exit: PIN check and sign-out request (protocol 1.1)

Read Section 5.10. This step builds everything of the admin exit that
does not need the reconciler; Step 9 moves the last part into it.

New files: `agent_policy.rs`, `admin_exit.rs`.

Changed files:

| File | Change |
|---|---|
| `agent.rs` | `initial_snapshot` (and every later snapshot update) fills `admin_exit`, `power`, `org_name` from `AgentPolicy`. New `pub struct CachedDesired { pub version: u64, pub doc: serde_json::Value, pub signature: Option<String> }` (camelCase) and `pub fn load_cached_desired(paths: &DataPaths) -> Option<CachedDesired>` reading `desired-state.json`; this is the file format Step 8 writes. `run` builds `AgentPolicy::from_doc` from the cached document (the fixture document in demo mode), registers `AdminExit` as a `ShellExtension`, and starts the **stand-in exit task** below |
| `cli.rs`, `main.rs` | New command `rulebox-agent hash-pin`: prints `PIN (4 to 12 digits): ` to stderr, reads one line from stdin, rejects anything that is not 4 to 12 ASCII digits (exit code 1), prints the `kdf::hash_secret` PHC string to stdout. It touches no file, pipe or registry key, so it is safe on every machine. Add `hash-pin` to the commands the general rules of Section 7 allow on the dev machine |
| `ipc_admin.rs` | `admin.status` fills `extra.admin_exit_failures`, `extra.admin_exit_locked_for_ms`, `extra.admin_exit_problem`; the text form of `status` prints "admin exit: on / off (<problem>)", the key combination and the lock time left. Never the hash |
| `fixtures.rs` | The demo document gains the three agent-only keys with the hash of `2468` |
| `fake_staff.rs` | Key `x`: reads one line (the PIN), calls `adminExit.submit`, prints the result. Key `p` (used by the VM checklist): the pipe probe described in the note below |

Note on `p`: `fake_staff` does not own the client's pipe handle. So `p`
does two things that need no handle from `IpcClient`: it opens its own
second connection with `rulebox_win32::pipe::open_client`, prints
`pipe_owner` and `server_session_id` for it (`owner: <SID>`,
`server session: <n>`), closes it, then prints the result of
`probe_create_instance(<the pipe name in use>)` as
`create-instance: DENIED (error <n>)` or `create-instance: ALLOWED`,
and last the result of
`open_client_with_access(<name>, GENERIC_READ | GENERIC_WRITE)` (the
numeric value `0xC000_0000`, so `rulebox-ipc` needs no `windows`
import) as `generic-write open: ACCEPTED` or `REFUSED (error <n>)`,
closing that handle at once. The connections opened by `p` send no
frame; the agent drops them at the `hello` deadline.

```rust
// admin_exit.rs
pub struct ExitRequest { pub session_id: u32, pub prepared: oneshot::Sender<Result<(), String>> }
pub struct AdminExitDeps { pub policy_rx: watch::Receiver<AgentPolicy>, pub lockouts: Arc<Mutex<LockoutStore>>,
                           pub audit: Arc<AuditHandle>, pub session: Arc<SessionManager>,
                           pub exit_tx: mpsc::Sender<ExitRequest>, pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync> }
pub struct AdminExit { /* … */ }
impl AdminExit { pub fn new(deps: AdminExitDeps) -> Arc<Self>; }
impl ShellExtension for AdminExit { /* capabilities: ["adminExit"]; method "adminExit.submit" as in Section 5.10 */ }
pub fn pin_id(pin_hash: &str) -> String;       // first 16 hex characters of SHA-256
/// Steps 8a to 10 of Section 5.10. Used by the stand-in task now and by the reconciler from Step 9.
pub async fn run_exit(platform: Arc<dyn Platform>, kiosk_enabled: bool, simulate: bool,
                      req: ExitRequest, broadcast: ShellBroadcast) -> Result<(), PlatformError>;
```

- `AgentPolicy` travels in its own `watch` channel (`policy_tx` in
  `agent.rs`), separate from the snapshot, so the hash is never inside
  `AgentSnapshot`.
- **Stand-in exit task** (in `agent.rs`, removed in Step 9): receives
  `ExitRequest`s and calls `run_exit` with `kiosk_enabled` from the
  loaded state. It has no exit hold; that arrives with the reconciler.
- `run_exit` in simulate mode: skips the registry write, replies
  "prepared", broadcasts, waits 2 seconds, logs "simulate: would sign
  the Staff session out to the Windows sign-in screen", and calls
  nothing on `Platform`.
- `run_exit` outside simulate mode writes `AutoAdminLogon = "0"` with
  `write_machine_value` (key
  `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`) only when
  `kiosk_enabled`, then `logoff_session(req.session_id)` with the
  retries of Section 5.10. Both are guarded `Platform` calls; on the dev
  machine they can only ever run against `SimPlatform` in tests.

Unit tests (`SimPlatform`, fake clock, paused time):

1. `AgentPolicy::from_doc`: no document, no `adminExit` key, and no
   `pinHash` → `enabled: false`, no problem; a valid hash →
   `enabled: true`; `"enabled": false` with a valid hash → false; a bad
   hash → false with problem `admin_exit_pin_invalid`; a bad `hotkey` →
   the default with problem `admin_exit_hotkey_invalid`;
   `"ctrl+alt+shift+r"` → `"Ctrl+Alt+Shift+R"`; `power` and `orgName`
   are passed through; a 101-character `orgName` → `None`.
2. **No leak:** build the snapshot from a document with a `pinHash`,
   serialize it, and assert the JSON contains neither `pinHash` nor the
   hash text nor `$argon2`. The same for `AdminStatusResult` and for
   `format!("{:?}", policy)`.
3. Correct PIN → `signingOut`; exactly one `ExitRequest` with the
   caller's `session_id`; the employee session is cleared; one
   `AdminExitSuccess` record; the counter is 0.
4. Wrong PIN four times → `wrongPin` with `attemptsLeft` 4, 3, 2, 1; the
   fifth → `lockedOut` near 60,000 ms; the correct PIN during the lock →
   `lockedOut` and **no** `ExitRequest`; after the lock the correct PIN
   → `signingOut`.
5. The audit queue after test 4 holds five `AdminExitWrongPin`, one
   `AdminExitLockedOut` and one `AdminExitSuccess`, in order, and no
   record or log line contains a PIN.
6. Counter and lock survive dropping and re-creating `AdminExit` and
   `LockoutStore` (an agent restart).
7. Rotation: after three wrong PINs, a document with a different
   `pinHash` → the next wrong PIN answers `attemptsLeft: 4`.
8. Disabled (no hash, or `"enabled": false`) → `disabled`; the counter
   does not change; no audit record.
9. `"12"`, `"12a4"`, a 13-digit PIN and `""` → `invalid_params`; the
   counter does not change.
10. Two submits at once → one of them gets `busy`.
11. Count-first: make the verify step panic or be cancelled after the
    counter was saved → the stored counter is one higher.
12. Reconciler stand-in never replies → error `internal`,
    `retryable: true`, one `AdminExitFailed` record, counter 0.
13. `run_exit` against `SimPlatform` (not simulate mode, kiosk enabled):
    `AutoAdminLogon` is `"0"` before `logoff_session` is called;
    `agent.shuttingDown { reason: adminExit, graceMs: 2000 }` was
    broadcast; `logoff_session` got the requested session id. With
    `fail_next(logoff)` three times it succeeds on the fourth call; with
    four failures it returns the error.
14. `run_exit` with kiosk not enabled does not touch `AutoAdminLogon`.
15. `hash-pin` logic (as a function): `"2468"` gives a string that
    `check_hash` accepts and `verify_secret("2468", …)` confirms; `"12"`
    is rejected.

Manual check on the dev machine:

```powershell
cargo run -p rulebox-agent -- run --console --simulate --sim-demo        # terminal 1
$env:RULEBOX_AGENT_SIM = "1"; cargo run -p rulebox-ipc --example fake_staff --features client   # terminal 2
# in fake_staff: x -> 1111 (wrongPin, attemptsLeft 4) ; x -> 2468 (signingOut, then a ShuttingDown adminExit event)
cargo run -p rulebox-agent -- status --simulate
"2468" | cargo run -p rulebox-agent -- hash-pin
```

**Verify:** `cargo clippy -p rulebox-agent --all-targets -- -D warnings`,
`cargo test -p rulebox-agent`,
`cargo clippy -p rulebox-ipc --all-targets --all-features -- -D warnings`,
`cargo build -p rulebox-ipc --example fake_staff --features client`.

**Done when:** tests pass; the manual check shows the two outcomes and
the agent log line "simulate: would sign the Staff session out to the
Windows sign-in screen"; `hash-pin` prints a line starting with
`$argon2id$v=19$m=19456,t=2,p=1$`; `status --simulate` shows the admin
exit as on with `Ctrl+Shift+F12`. **Tell the user that protocol 1.1 is
ready for Phase 3 on the simulated agent** (`--simulate --sim-demo`),
and give them the list "Changes Phase 3 must pick up" from Section 12.

---

### Step 7 — Convex backend for devices

Read CLAUDE.md "Data access rules" again before writing a query.

`convex/schema.ts` changes:

- `devices`: **remove** `status` and `lastSeen` (Section 14, Q2). Add
  `secretHash: v.string()`, `revoked: v.boolean()`,
  `enrolledAt: v.number()`, `enrollmentTokenId: v.id("enrollmentTokens")`,
  `hardwareIdHash: v.optional(v.string())`,
  `agentVersion: v.optional(v.string())`,
  `osBuild: v.optional(v.string())`, `osEdition: v.optional(v.string())`,
  `kioskPhase: v.optional(v.string())`,
  `kioskError: v.optional(v.string())`,
  `appliedVersion: v.optional(v.number())`,
  `shellHealth: v.optional(v.string())`,
  `compat: v.optional(v.any())`. Keep `os`, `ramMb`, `diskFreeGb`,
  `lockdownLevel`. Add index `by_secret_hash ["secretHash"]`.
- New table `deviceStatus`: `deviceId: v.id("devices")`,
  `lastSeenAt: v.number()`; index `by_device ["deviceId"]`. This is the
  only fast-changing device data (rule 4).
- `enrollmentTokens`: add `revoked: v.optional(v.boolean())`,
  `groupId: v.optional(v.id("groups"))`, `createdAt: v.number()`.

`convex/lib/deviceAuth.ts`:

```ts
export async function sha256Hex(text: string): Promise<string>;   // crypto.subtle.digest, lowercase hex
export async function requireDevice(ctx, args: { deviceId: Id<"devices">; deviceSecret: string })
  : Promise<Doc<"devices"> | null>;   // null when missing, wrong secret or revoked
```

`convex/enrollment.ts` — `enroll` (public `mutation`):

- Args: `token: v.string()`, `deviceSecretHash: v.string()` (64 hex),
  `deviceName: v.string()`, `hardwareIdHash: v.optional(v.string())`,
  `agentVersion: v.string()`, `compat: v.any()`.
- Logic, all in the one mutation (atomic): look up
  `enrollmentTokens.by_token_hash` with `sha256Hex(token)`. Then:
  1. No row → throw `ConvexError({ code: "token_invalid" })`.
  2. **Idempotent retry:** look up `devices.by_secret_hash`. If a device
     with this `deviceSecretHash` exists and its `enrollmentTokenId` is
     this token → return the same result as the first time, without
     consuming a use.
  3. `revoked` → `token_revoked`; `expiresAt <= Date.now()` →
     `token_expired`; `usesLeft <= 0` → `token_used_up`.
  4. Decrement `usesLeft`, insert the device (`orgId` and `groupId` from
     the token, `revoked: false`, `enrolledAt: Date.now()`), insert its
     `deviceStatus` row.
- Returns `{ deviceId, orgId, deviceName, serverTimeMs: Date.now() }`.

`convex/devices.ts`:

- `desiredState` (public `query`), args `{ deviceId, deviceSecret }`.
  Returns `{ kind: "unknownDevice" }` if the id does not exist or the
  secret is wrong, `{ kind: "revoked" }` if revoked, otherwise
  `{ kind: "ok", desired }` where `desired` is the newest `desiredStates`
  row for `scope = deviceId` (index `by_scope_version`, `.order("desc")`,
  `.first()`), else the newest for `scope = groupId` when the device has
  a group, else `null`; shaped `{ version, doc, signature: null }`. Do
  not call `Date.now()` in this query and do not read `deviceStatus` in
  it (it would re-run the subscription on every heartbeat).
- `heartbeat` (public `mutation`), args `{ deviceId, deviceSecret,
  status: v.optional(v.object({...})) }` with the status fields listed
  for `devices` above. Unknown or revoked device → return
  `{ kind: "rejected" }`. Otherwise patch `deviceStatus.lastSeenAt`; if
  `status` is present **and differs** from the stored fields, patch
  `devices` (rule 5). Return
  `{ kind: "ok", nextPingInMs: 300000, serverTimeMs: Date.now() }`. The
  fixed 5 minutes is deliberate; Phase 4 scales it with fleet size.
- `unenroll` (public `mutation`), args `{ deviceId, deviceSecret }`: sets
  `revoked: true`.

`convex/dev.ts` — `internalMutation`s, callable only with
`npx convex run` (there is no dashboard until Phase 4):

- `seedOrg({ name })` → `orgId`.
- `createEnrollmentCode({ orgId, ttlMinutes?: 60, uses?: 1 })` →
  `{ code, expiresAt }`. Generates the 20-character token with
  `crypto.getRandomValues`, stores only its hash, and builds the code
  from `process.env.CONVEX_CLOUD_URL`. If that variable is not defined in
  the Convex runtime, take the URL as an argument instead and say so in
  the report.
- `setKiosk({ deviceId, enabled })` → inserts a new `desiredStates` row
  for `scope = deviceId` with `version = previous + 1` (start at 1) and a
  full valid document (copy the previous `doc`, or the PRD Section 10
  example with empty lists, and set `kioskEnabled`).
- `revokeDevice({ deviceId })`, `revokeEnrollmentToken({ tokenId })`.
- (1.1) `setAdminExit({ deviceId, pinHash?: string, enabled?: boolean,
  hotkey?: string })` → inserts a new `desiredStates` row like
  `setKiosk` does (copy the previous `doc`, `version + 1`) with the
  top-level key `adminExit` replaced by the given fields (Section 5.10).
  `pinHash` is the line printed by `rulebox-agent hash-pin`; the
  mutation only checks that it starts with `$argon2id$`. Passing
  `pinHash: ""` removes the PIN. `setKiosk` must **keep** an existing
  `adminExit`, `power` and `orgName` when it copies the document. If
  `desiredStates.doc` has a strict validator in `schema.ts` that rejects
  these keys, add them as optional fields (`adminExit:
  v.optional(v.object({ enabled: v.optional(v.boolean()), hotkey:
  v.optional(v.string()), pinHash: v.optional(v.string()) }))`, `power:
  v.optional(v.object({ sleep: v.boolean(), restart: v.boolean(),
  shutDown: v.boolean() }))`, `orgName: v.optional(v.string())`). This is
  a test helper; Phase 4 replaces it with dashboard settings and keeps
  `pinHash` unreadable for dashboard users.
- (1.1) No Convex function for employees or for audit records is added
  in Phase 2 (Sections 5.9 and 5.11 name the seams).

Every query uses `.withIndex(...)`; nothing uses `.filter()` or
`.collect()`.

**Verify:**

```powershell
npx convex dev --once
pnpm typecheck
pnpm lint
npx convex run dev:seedOrg '{"name":"Test Org"}'
npx convex run dev:createEnrollmentCode '{"orgId":"<id from above>"}'
```

**Done when:** the deploy succeeds, typecheck and lint pass, and the last
command prints a code starting with `RBX1.`. If the deploy fails because
existing `devices` rows no longer match the schema, stop and ask the user
before deleting any data.

---

### Step 8 — Agent backend client and enrollment

Files: `enroll_code.rs`, `backend/mod.rs`, `backend/convex.rs`,
`backend/value.rs`, `compat.rs`; add to `rulebox-policy`:

```rust
impl DesiredState {
    /// Used when a device is enrolled but the backend has no document yet (PRD 9.1 step 5).
    pub fn enrollment_default() -> Self;   // kiosk_enabled: true, empty lists/maps, default_quota_gb: 0, branding name "Rulebox", version 0
}
```

```rust
// enroll_code.rs
pub struct EnrollmentCode { pub convex_url: String, pub token: String }
pub fn parse(code: &str) -> Result<EnrollmentCode, CodeError>;
pub enum CodeError { BadPrefix, BadEncoding, Malformed, BadUrl, BadToken }

// backend/mod.rs
// Use futures_util::future::BoxFuture for the async methods; do not add the async-trait crate.
pub trait Backend: Send + Sync {
    fn enroll(&self, req: EnrollRequest) -> BoxFuture<'_, Result<EnrollResponse, BackendError>>;
    fn heartbeat(&self, auth: &DeviceAuth, status: Option<StatusReport>) -> BoxFuture<'_, Result<HeartbeatResponse, BackendError>>;
    fn unenroll(&self, auth: &DeviceAuth) -> BoxFuture<'_, Result<(), BackendError>>;
    /// Long-lived. Sends every subscription result and every connection-state change.
    fn subscribe(&self, auth: DeviceAuth, tx: mpsc::Sender<BackendEvent>, shutdown: CancellationToken) -> BoxFuture<'_, ()>;
}
pub struct DeviceAuth { pub device_id: String, pub device_secret: String }   // Debug redacts the secret
pub enum BackendEvent { Connection(ConnectionStatus), Desired(DesiredFetch) }
pub enum DesiredFetch { None, Doc { version: u64, doc: serde_json::Value, signature: Option<String> }, Revoked, UnknownDevice }
pub enum BackendError { Unreachable, Timeout, Rejected { code: String }, Protocol(String) }
```

- `ConvexBackend` builds one `ConvexClient` per enrolled URL with
  `ConvexClientBuilder` and the state-change channel. Function names:
  `"enrollment:enroll"`, `"devices:desiredState"`, `"devices:heartbeat"`,
  `"devices:unenroll"`. `Rejected.code` comes from the `ConvexError`
  data's `code` field.
- Every one-shot call: `tokio::time::timeout(Duration::from_secs(30), …)`
  → `BackendError::Timeout`.
- `FakeBackend` for tests: scripted responses and a handle to push
  `BackendEvent`s.
- The backend task in `agent.rs` implements Section 5.8 (subscription
  handling, cache file `desired-state.json`, heartbeat scheduling with
  jitter, clock offset). The enrollment flow of Section 5.4 lives in the
  reconciler task and is reached through `admin.enroll`.
- `Deps` gains `backend_factory` in this step (it has none yet).
- **Admin-pipe errors.** `admin.enroll` reports every failure of Section
  5.4 as `operation_failed` with the reason from
  `rulebox_ipc::admin::reasons` (Section 6.7): `CodeError` →
  `code_invalid` with `details.kind`; a blocker → `compat_blocked` with
  `details.blockers`; `BackendError::Unreachable` or `Timeout` →
  `backend_unreachable` with `retryable: true`; `Rejected { code }` → the
  code itself when it is one of the four `token_*` names, otherwise
  `backend_rejected` with `details.serverCode`.
- **(1.1) Cache file and agent-only keys.** `desired-state.json` is
  written as `CachedDesired { version, doc, signature }` (Step 6b), with
  `doc` being the **raw** document as received, so the agent-only keys
  survive a restart while offline. Every time a document is accepted
  (and once at start from the cache) the backend task: parses `doc`
  into `DesiredState` for the snapshot as before; sends
  `AgentPolicy::from_doc(Some(&doc))` on `policy_tx`; and sets the
  snapshot's `admin_exit`, `power` and `org_name` from it. A document
  whose `DesiredState` part does not parse keeps the previous state
  **and** the previous `AgentPolicy`.
- **(1.1) Revoked device:** besides the existing handling, call
  `SessionManager::clear("revoked")`. The cached document, and with it
  the exit PIN, stays.
- **(1.1) Audit delivery** needs no code here: the `audit` task already
  watches `connection` in the snapshot (Step 6a). With `NullAuditSink`
  nothing is sent in Phase 2.
- `compat.rs` as in Section 5.5.
- `hardwareIdHash`: SHA-256 of
  `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`. It is a hint for
  the admin only (cloned images share it); never use it for
  authentication.

Unit tests (with `FakeBackend`, `SimPlatform`, paused time):

1. `parse` accepts a code built in the test; each `CodeError` case; an
   `http://` URL is `BadUrl`.
2. Enrollment happy path writes `enrollment`, moves the secret, clears
   pending.
3. Timeout keeps pending; retrying with the **same** code reuses the same
   secret hash; retrying with a **different** code generates a new one.
4. `token_expired` clears pending and returns that code.
5. `compat` blocker stops enrollment before any backend call.
6. `value.rs`: `42.0` becomes integer `42`; `1.5` stays a float; the PRD
   example document converts and parses into `DesiredState`.
7. A lower `version` than `last_applied_version` is ignored; an
   unparseable `doc` keeps the previous state.
8. `Revoked` sets `enrollment.revoked`, stops the backend task, and does
   **not** send a kiosk-disable trigger.
9. With a cache file present and a backend that never connects, the
   snapshot has `desiredState` from the cache and
   `connection: "offline"`.
10. Heartbeat sends `status` only when it changed; the next call is
    scheduled from `nextPingInMs` within ±10%.
11. Each failure of Section 5.4 arrives at an admin-pipe client as
    `operation_failed` with the reason listed above (one case per
    reason), and `backend_unreachable` has `retryable: true`.
12. (1.1) A received document with `adminExit.pinHash` → the snapshot
    shows `adminExit.enabled: true`, `desired-state.json` contains the
    hash, and the serialized snapshot does not. After a restart with a
    backend that never connects, `adminExit.submit` with the right PIN
    still answers `signingOut`.
13. (1.1) A newer document without `adminExit` → `enabled: false` and
    `adminExit.submit` answers `disabled`. A document with a different
    `hotkey` → one `state.changed` with the new canonical text.
14. (1.1) `Revoked` clears the employee session and keeps
    `adminExit.enabled`.

Manual check on the dev machine (network only; simulate mode changes
nothing on the machine):

```powershell
cargo run -p rulebox-agent -- run --console --simulate          # terminal 1
cargo run -p rulebox-agent -- enroll "<RBX1 code>" --simulate   # terminal 2
cargo run -p rulebox-agent -- status --simulate
npx convex run dev:setKiosk '{"deviceId":"<id>","enabled":false}'
```

**Done when:** tests pass; after `enroll` the Convex dashboard shows the
device with a `deviceStatus` row; `status` shows `enrolled` and `online`;
after `setKiosk` the agent log shows the new desired-state version within
a few seconds **without any polling**; running the same `enroll` again
prints `error: already_enrolled: …` and exits with code 3; a second
device enrolling with the same single-use code gets `token_used_up`.
(1.1) After
`npx convex run dev:setAdminExit '{"deviceId":"<id>","pinHash":"<line from hash-pin>"}'`
`status --simulate` shows the admin exit as on within a few seconds, and
`fake_staff` key `x` with that PIN answers `signingOut`.

---

### Step 9 — Kiosk reconciler (logic only, against `SimPlatform`)

File: `kiosk.rs`, plus the `reconciler` task in `agent.rs`.

```rust
pub struct Kiosk<'a> { pub platform: &'a dyn Platform, pub state: &'a mut AgentState,
                       pub secrets: &'a mut Secrets, pub config: &'a AgentConfig, pub install: &'a InstallPaths }
impl Kiosk<'_> {
    pub fn enable(&mut self) -> Result<(), KioskError>;      // Section 5.6 "Enable"
    pub fn disable(&mut self) -> Result<(), KioskError>;     // Section 5.6 "Disable" (collects errors)
    pub fn verify_password(&mut self) -> Result<(), KioskError>;   // step 7
}
pub enum KioskError { Blocked(String /* blocker code */), StaffAccountConflict, Platform(PlatformError), Multiple(Vec<KioskError>) }
pub fn generate_password() -> String;   // 32 chars, all four classes present
```

`enable` and `disable` are synchronous and run inside `spawn_blocking`.
State and secrets are saved after **each** numbered step of Section 5.6,
not only at the end, so a crash mid-way leaves an accurate journal.

**(1.1) The reconciler takes over the admin exit.** Delete the stand-in
exit task of Step 6b. The reconciler task owns the
`mpsc::Receiver<ExitRequest>` and handles a request inside its own loop
(so no kiosk change runs at the same time):

```rust
// kiosk.rs
pub struct ExitHold { pub started: Instant }                 // memory only; None after an agent restart
pub const EXIT_HOLD_MAX: Duration = Duration::from_secs(300);
/// Section 5.10: true when the hold must end now.
pub fn hold_ended(hold: &ExitHold, now: Instant, sessions: &[SessionInfo], staff_sid: &str) -> bool;
```

- On an `ExitRequest`: set the hold (only when `kiosk.applied ==
  Enabled`), then call `admin_exit::run_exit`. If `run_exit` returns an
  error, drop the hold and reconcile.
- While a hold is set, `reconcile` treats `AutoAdminLogon = "0"` as the
  target for that one value and leaves it alone; everything else is
  unchanged. `Kiosk::enable` gets the hold as a parameter
  (`exit_hold: bool`); the journal is not touched by the hold (the
  original value was journaled when kiosk was first enabled).
- On every trigger and on a 30-second tick while a hold is set, call
  `hold_ended`; when true, clear the hold and reconcile (which writes
  `"1"` again).
- **Employee session and the Windows session:** whenever the reconciler
  re-reads the session list and finds no `Active` or `Connected` session
  of the Staff account, it calls `SessionManager::clear("staff session
  ended")`.
- Enable step 3 saves `state.staff.profile_dir` and calls
  `SessionManager::set_files_base(Some(<profile>\RuleboxFiles))`; at
  agent start the base is set from the saved value. Disable does not
  clear it.

Unit tests:

1. Fresh machine: `enable` creates the user, profile, hive values, the
   eight machine values, the LSA secret; journal has one entry per
   changed value.
2. `enable` twice: the second run makes **zero** mutating `Platform`
   calls (assert on a call counter).
3. `enable` then `disable`: every machine value equals its original
   (including "absent"); LSA `DefaultPassword` is gone; the user still
   exists; the journal is empty.
4. Original auto sign-in belonged to the owner (`AutoAdminLogon = "1"`,
   `DefaultUserName = "Owner"`, plaintext `DefaultPassword = "pw"`, and
   an LSA `DefaultPassword`): after `enable` + `disable` all four are
   back exactly, and the plaintext password never appears in
   `agent-state.json` (assert on the serialized state).
5. Failure injected at each mutating step in turn: after the automatic
   rollback the machine equals the starting machine, `last_error` is set,
   `failures` is 1.
6. `RuleboxStaff` exists with a foreign comment → `StaffAccountConflict`,
   no mutating call made.
7. `RuleboxStaff` exists with the Rulebox comment and no stored SID →
   adopted, password reset.
8. No other local admin → `Blocked("no_other_admin")`, no change.
9. `DefaultUserName` changed behind the agent's back → the next
   `reconcile` fixes only that value.
10. `test_logon` fails → exactly one repair, exactly one `test_logon`
    call.
11. Staff session locked: still `Active` after 10 s → `logoff_session`
    called once; `Disconnected` → not called.
12. `disable` with a Staff session: `agent.shuttingDown` is broadcast,
    then after 10 s `logoff_session` is called.
13. Retry schedule after failures is 1, 5, 15, 15 minutes.
14. `generate_password` output is 32 characters with all four classes
    (run 1,000 times).
15. (1.1) `ExitRequest` with kiosk enabled: `AutoAdminLogon` becomes
    `"0"`, the session is signed out, and a `Reassert` trigger one
    minute later leaves `AutoAdminLogon` at `"0"` while fixing a
    changed `DefaultUserName`.
16. (1.1) `hold_ended`: false at 4 minutes with no sessions; true at
    5 minutes; true as soon as a non-Staff session is `Active`; false
    while only the Staff session is listed. After it ends, the next
    reconcile writes `"1"`.
17. (1.1) `run_exit` failing (sign-out fails four times) drops the hold
    and the next reconcile writes `"1"`.
18. (1.1) An `ExitRequest` while kiosk is `Disabled` sets no hold and
    does not write `AutoAdminLogon`.
19. (1.1) Enable saves `profile_dir`; the `SessionManager` then returns
    a `filesRoot` under `<profile>\RuleboxFiles\`. The Staff session
    ending clears the employee session.

**Verify:** `cargo clippy -p rulebox-agent --all-targets -- -D warnings`
and `cargo test -p rulebox-agent`.

**Done when:** all tests pass. Nothing in this step touches the real
machine.

---

### Step 10 — `rulebox-win32`: real implementations

Write the modules below and `apps/agent/src/platform/windows.rs`, which
maps each `Platform` method to them. **You cannot run any of the mutating
functions.** Their tests are `#[ignore]`d and start with
`guard::require_test_machine().expect(...)`; they run on the VM in
Step 14.

Read-only modules (unit-test these on the dev machine):

```rust
// osinfo.rs
pub fn os_version() -> Result<OsVersion>;         // RtlGetVersion + registry UBR, DisplayVersion, EditionID
pub fn product_type() -> Result<u32>;             // GetProductInfo
pub fn s_mode() -> Result<bool>;                  // HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\SkuPolicyRequired == 1
pub fn join_state() -> Result<JoinState>;         // NetGetJoinInformation; NetGetAadJoinInformation (None = not joined)
pub fn memory_mb() -> Result<u64>;                // GlobalMemoryStatusEx
pub fn disk_free_gb(path: &Path) -> Result<u64>;  // GetDiskFreeSpaceExW
pub fn computer_name() -> Result<String>;
pub fn machine_guid() -> Result<String>;
// accounts.rs (read part)
pub fn find_user(name: &str) -> Result<Option<UserInfo>>;                  // NetUserGetInfo level 1 + LookupAccountNameW
pub fn enabled_local_admins() -> Result<Vec<UserInfo>>;                    // NetLocalGroupGetMembers on the localized Administrators name
// session.rs (read part)
pub fn list_sessions() -> Result<Vec<Session>>;                            // WTSEnumerateSessionsW; user SID via WTSQueryUserToken (SYSTEM only; None otherwise)
pub fn active_console_session() -> Option<u32>;                            // 0xFFFFFFFF -> None
// process.rs (read part)
pub fn find_by_image(session_id: u32, image: &Path) -> Result<Vec<u32>>;   // Toolhelp snapshot + ProcessIdToSessionId + QueryFullProcessImageNameW
// registry.rs (read part)
pub fn get_hklm(path: &str, name: &str) -> Result<Option<RegValue>>;
```

Mutating modules (every function `/// DESTRUCTIVE: guarded.`):

```rust
// accounts.rs
pub fn create_standard_user(name: &str, full_name: &str, comment: &str, password: &str) -> Result<Sid>;
//   NetUserAdd level 1: USER_PRIV_USER, flags UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE;
//   then NetUserSetInfo for the full name; then NetLocalGroupAddMembers(<localized Users>, SID).
//   2224 (NERR_UserExists) -> AlreadyExists. 2245 (NERR_PasswordTooShort; also "any policy failure") -> PasswordPolicy.
//   1378 (ERROR_MEMBER_IN_ALIAS) on the group call is success.
//   If the group call fails, delete the user again before returning the error.
pub fn set_password(name: &str, password: &str) -> Result<()>;            // NetUserSetInfo level 1003
pub fn test_logon(name: &str, password: &str) -> Result<bool>;            // LogonUserW(LOGON32_LOGON_NETWORK); handle closed at once
pub fn ensure_profile(sid: &Sid, name: &str) -> Result<PathBuf>;          // CreateProfile; ALREADY_EXISTS -> read ProfileList\<SID>\ProfileImagePath
pub fn delete_user_and_profile(sid: &Sid, name: &str) -> Result<()>;      // DeleteProfileW then NetUserDel; caller signs the session out first
// lsa.rs
pub fn secret_get(name: &str) -> Result<Option<String>>;                  // LsaOpenPolicy + LsaRetrievePrivateData (read-only, but returns secrets: not exposed to tests on dev)
pub fn secret_set(name: &str, value: Option<&str>) -> Result<()>;         // LsaStorePrivateData; None deletes
// registry.rs
pub fn set_hklm(path: &str, name: &str, value: Option<&RegValue>) -> Result<()>;
pub fn with_user_hive<T>(sid: &Sid, profile: &Path, f: impl FnOnce(&HiveKey) -> Result<T>) -> Result<T>;
//   If HKEY_USERS\<SID> is loaded (user signed in), use it. Otherwise enable SeBackupPrivilege and
//   SeRestorePrivilege, RegLoadKeyW(HKEY_USERS, "RuleboxStaffTmp", <profile>\NTUSER.DAT), run f,
//   close every key, RegUnLoadKeyW (retry 5 times, 200 ms apart).
// shellreg.rs
pub const POLICY_SHELL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\System";      // value "Shell"
pub const WINLOGON_SHELL_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\Winlogon";        // value "Shell"
pub fn set_user_shell(sid: &Sid, profile: &Path, mechanism: Mechanism, command: Option<&str>) -> Result<()>;
//   This module contains NO code path that can open HKEY_LOCAL_MACHINE. Add a unit test that the two
//   key constants do not start with "SOFTWARE\\Microsoft\\Windows NT" under HKLM by construction:
//   the function takes a HiveKey that can only come from with_user_hive.
pub fn set_user_policy_dword(sid: &Sid, profile: &Path, name: &str, value: Option<u32>) -> Result<()>;
// session.rs
pub fn logoff(session_id: u32) -> Result<()>;                              // WTSLogoffSession, no wait
// process.rs
pub fn launch_in_session(session_id: u32, expected_user: &Sid, exe: &Path) -> Result<u32>;
pub fn terminate(pid: u32, expected_image: &Path, expected_user: &Sid) -> Result<()>;
// dpapi.rs
pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>>;      // CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, no LOCAL_MACHINE flag
pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>>;
```

`launch_in_session`, exactly:

1. `WTSQueryUserToken(session_id)`. Error 1008 (`ERROR_NO_TOKEN`) is
   retried 5 times, 500 ms apart (the session may not be ready yet).
   Error 1314 means "not running as SYSTEM".
2. Read `TokenUser` from that token; it must equal `expected_user`.
   Otherwise return an error and launch nothing.
3. Read `TokenElevationType`; refuse to launch if the token is elevated.
   Never use the linked token.
4. `DuplicateTokenEx` → primary token.
5. `CreateEnvironmentBlock(token, inherit = false)`.
6. `CreateProcessAsUserW` with `lpApplicationName` = the full exe path,
   `lpCommandLine` = the same path in double quotes in a **mutable**
   buffer, `bInheritHandles = false`, flags `CREATE_UNICODE_ENVIRONMENT`,
   current directory = the exe's folder, `lpDesktop = "winsta0\\default"`.
7. Close the thread handle, the process handle, both tokens; destroy the
   environment block. Return the PID.

The agent treats `autologon` as plain registry values plus LSA calls
through `Platform`, so there is no separate logic to write in
`autologon.rs` beyond these constants and one helper:

```rust
pub const WINLOGON_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
pub const LSA_DEFAULT_PASSWORD: &str = "DefaultPassword";
pub const LSA_PENDING_PASSWORD: &str = "L$RuleboxStaffPending";
/// Refuses any name in FORBIDDEN_WINLOGON_VALUES.
pub fn set_winlogon_value(name: &str, value: Option<&RegValue>) -> Result<()>;
pub const FORBIDDEN_WINLOGON_VALUES: &[&str] = &["Shell", "Userinit", "IgnoreShiftOverride", "ForceAutoLogon"];
```

`WindowsPlatform::write_machine_value` routes every write under
`WINLOGON_KEY` through `set_winlogon_value`, and rejects any key outside
the three HKLM keys listed in Section 5.6.

**Data-directory startup check (Section 5.1; this is the step that owns
it).** Until now only simulate mode could run, so nothing has ever
written to the real `%ProgramData%\Rulebox`. This step makes the real
`run --console` possible, so the check lands here, before that path
exists:

```rust
// paths.rs (pure; unit-tested on the dev machine)
pub enum DataDirAction { Use, Create, FixDacl, Recreate, Refuse(&'static str) }
pub fn data_dir_action(check: &rulebox_win32::security::DirCheck, is_empty: bool) -> DataDirAction;   // the table in Section 5.1

// platform/windows.rs
/// Runs the Section 5.1 check and repair on `root`. Creating or repairing is guarded (test machine only).
/// Err = refuse to start; the message says which rule failed.
pub fn ensure_data_dir(root: &Path) -> anyhow::Result<()>;
```

- `ensure_data_dir`: `verify_protected_dir` → `data_dir_action` → act
  (`create_protected_dir`, or `std::fs::remove_dir` then
  `create_protected_dir`) → `verify_protected_dir` again → must be
  `is_ok()`. "Empty" is decided with `std::fs::read_dir(root)?.next().is_none()`.
- `main.rs`: the non-simulate `run --console` arm (it currently bails
  with "arrives in Step 10") now: `DataPaths::from_known_folders()` →
  **`ensure_data_dir`** → `logging::init` → `load_config` → build `Deps`
  with `WindowsPlatform`, `directory::choose(&config,
  guard::is_test_machine(), false)` and `NullAuditSink` → `agent::run`.
  On `Err` from `ensure_data_dir`: print to stderr, exit with code 1,
  create no file. Step 11 uses the same order for `service run` and
  `recover`.
- `compat` builds a `WindowsPlatform` but never calls `ensure_data_dir`,
  `logging::init` with the real directory, or `StateStore::open`: it
  logs to stderr only.
- On the dev machine `ensure_data_dir` can only ever return
  `Err(Guard)` for the create and repair branches (and you must not run
  the real `run --console` there anyway). The decision function is what
  gets tested.

Unit tests on the dev machine (read-only):

1. `os_version()` returns a build of at least 19045; `memory_mb() > 0`;
   `computer_name()` non-empty.
2. `find_user("RuleboxStaff")` returns `None`. **If it returns `Some`,
   stop and tell the user.**
3. `set_winlogon_value("Shell", …)` returns an error **without touching
   the registry** (it fails on the name check before the guard and before
   any API call). Same for the other three names.
4. `WindowsPlatform::write_machine_value` rejects
   `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`.
5. Every mutating function returns `Err(Guard(_))` on the dev machine.
   Write one test per function. This is the proof that the guard is wired
   everywhere.
6. `dpapi` is **not** tested on the dev machine through the guard-free
   path: `protect`/`unprotect` change nothing, so they are not guarded;
   test a round trip.
7. `data_dir_action`, one case per row of the table in Section 5.1:
   missing → `Create`; reparse point (empty or not) → `Refuse`; ok →
   `Use`; owner SYSTEM with a different DACL and empty → `FixDacl`;
   owner a normal user and empty → `Recreate`; owner a normal user and
   not empty → `Refuse`; DACL differs and not empty → `Refuse`.
8. `verify_protected_dir` on a temp directory you create (owned by you,
   inherited DACL) is not `is_ok()`, and `data_dir_action` for it with
   `is_empty = true` is `Recreate` (this runs the real read-only check
   once on the dev machine).

`#[ignore]` VM tests (`crates/rulebox-win32/tests/vm_*.rs`): create user
→ find → test logon → set password → ensure profile → set and read shell
value in the hive (signed out) → delete user and profile; LSA set/get/
delete on a throwaway name `L$RuleboxVmTest`; DPAPI round trip.

**Verify:** `cargo clippy -p rulebox-win32 --all-targets -- -D warnings`,
`cargo test -p rulebox-win32`, `cargo clippy -p rulebox-agent
--all-targets -- -D warnings`, `cargo test -p rulebox-agent`,
`cargo run -p rulebox-agent -- compat`.

**Done when:** all pass; `compat` prints the dev machine's real build,
edition, RAM and join state and lists its blockers without changing
anything.

---

### Step 11 — Windows service host, install, uninstall, recover

Files: `service.rs`, `recover.rs`.

**Service host** (`service run`):

1. `service_dispatcher::start("RuleboxAgent", ffi_service_main)`. Error
   1063 (`ERROR_FAILED_SERVICE_CONTROLLER_CONNECT`) means it was started
   by hand: print "This command is started by Windows. Use `run
   --console` to debug." and exit with code 2.
2. In `service_main`, **first** call
   `platform::windows::ensure_data_dir` (Step 10), before
   `logging::init`. If it fails, report `Stopped` with
   `ServiceExitCode::ServiceSpecific(2)` and return without writing any
   file (there is no trusted place to log to; `sc.exe query
   RuleboxAgent` then shows the service-specific exit code 2, which
   means "data directory not trusted"). Then create the
   `CancellationToken` and an unbounded channel; `service_control_handler::register` with a closure that only
   does `token.cancel()` for `Stop` and `Shutdown`, forwards
   `SessionChange` and `PowerEvent` into the channel, and returns
   `NoError` immediately. No locks, no I/O in the handler.
3. Report `StartPending`; build the runtime; report `Running` with
   `controls_accepted = STOP | SHUTDOWN | SESSION_CHANGE | POWER_EVENT`.
4. `runtime.block_on(agent::run(...))`.
5. On a requested stop: report `StopPending`, give tasks 10 seconds, flush
   the log guard, report `Stopped` with exit code 0.
6. On a fatal error from `agent::run`: log it and report `Stopped` with
   `ServiceExitCode::ServiceSpecific(1)` so the failure actions restart
   the service.
7. Session events are hints only. At start, and after every event, the
   agent re-reads the session list (the service may start after automatic
   sign-in already happened, and Windows does not replay logon
   notifications; with Fast Startup the service is resumed from
   hibernation rather than started).

**`service install`** (guarded; dev and VM use only — the MSI does this
in Phase 6):

- Refuse unless the running exe is inside `%ProgramFiles%\Rulebox\`
  (anything the service runs must be in a directory standard users cannot
  write).
- `ServiceManager::create_service` with `ServiceType::OWN_PROCESS`,
  `ServiceStartType::AutoStart`, `ServiceErrorControl::Normal`,
  `executable_path` = this exe, `launch_arguments = ["service", "run"]`,
  `account_name: None` (LocalSystem). The crate quotes the path. Open the
  service with `CHANGE_CONFIG | START` (restart actions need `START`).
- `set_description("Enforces Rulebox kiosk settings on this PC.")`.
- `update_failure_actions`: reset period 86,400 s; actions `Restart` after
  1 s, `Restart` after 5 s, `Restart` after 30 s (the last one repeats).
- `set_failure_actions_on_non_crash_failures(true)`.
- Do **not** set delayed auto-start: the agent must be up before
  automatic sign-in.
- Create the data directory through `ensure_data_dir` (Step 10; never
  with a plain `create_dir`), and stop with its message if it refuses.
  Then start the service.
- If the service already exists: update its configuration with
  `change_config` instead of deleting and recreating (avoids the
  "marked for deletion" state).

**`service uninstall`** (guarded): refuse if the device is enrolled and
kiosk is applied, unless `--force` is given, in which case run the
`recover` procedure first. Then stop (poll `query_status` up to 30 s),
`delete()`, drop the handle, poll until `open_service` fails with 1060.
Error 1072 → print "Close services.msc and Task Manager, or restart, then
run this again."

**`recover`** (guarded; offline; run from an elevated prompt; must work
with the service stopped, broken or missing):

1. Check the caller is an elevated administrator. Ask for confirmation
   unless `--yes`. Before reading or writing anything in the data
   directory, run `verify_protected_dir` on it: if it is a reparse
   point, or exists and is not `is_ok()`, do **not** read the state file
   from it or write the flag into it; continue with step 4 (the "state
   file missing" path) and say so in the output. `recover` never creates
   or repairs the directory.
2. Stop the service if it is running (so it does not re-apply), ignoring
   errors.
3. Load `agent-state.json` if readable. Restore every journaled machine
   value whose original is not `InSecrets`. For `InSecrets` entries
   (the owner's original plaintext auto sign-in password, which only
   SYSTEM can decrypt): delete the value and tell the user that their own
   previous auto sign-in must be set up again.
4. If the state file is missing or unreadable: set `AutoAdminLogon` to
   `"0"` **only if** `DefaultUserName` is `RuleboxStaff`; otherwise leave
   Winlogon alone.
5. Delete the LSA secrets `DefaultPassword` (only if `DefaultUserName`
   was `RuleboxStaff`) and `L$RuleboxStaffPending`.
6. If a `RuleboxStaff` account with the Rulebox comment exists: remove
   the shell value (both mechanisms) and `DisableLockWorkstation` from
   its hive.
7. Mark `kiosk.applied = Disabled` in the state file if it was readable,
   and write `<data>\state\recovered.flag`. A service that starts and
   finds this flag does not enable kiosk until the next `enroll` or until
   an admin deletes the flag; `status` shows "recovered: kiosk held off".
8. Print what was changed and what the admin should check.

`unenroll` (through the service): run Disable; if
`--remove-staff-account`, sign the Staff session out, wait for it to end
(up to 30 s), then `delete_staff_user`; call `devices:unenroll` (10 s
timeout, failure is only logged); delete `secrets.bin`,
`desired-state.json`; clear `enrollment`, `staff` (if removed) and the
journal. (1.1) Also clear the employee session and delete
`employee-cache.json`, `lockouts.json` and `audit-queue.json` (log how
many audit records were still undelivered); they belong to the
organization the PC is leaving. With `desired-state.json` gone the exit
PIN is gone too, which is right: kiosk mode is off.

Unit tests: the control handler mapping (pure function from
`ServiceControl` to an action); `recover`'s decision logic as a pure
function over (`state present?`, `DefaultUserName`, journal) → list of
planned actions, covering steps 3–6; `service install` path check.

**Verify:** `cargo clippy -p rulebox-agent --all-targets -- -D warnings`,
`cargo test -p rulebox-agent`, and
`cargo run -p rulebox-agent -- service run` → prints the "started by
Windows" message and exits with code 2.

**Done when:** all pass. Do not run `service install`, `service
uninstall` or `recover` on the dev machine (they would be stopped by the
guard, but do not try).

---

### Step 12 — `rulebox-shell.exe` (the launcher)

Crate `apps/shell-launcher`. Dependencies: `windows`, `rulebox-win32`
(for `to_wide`, `OwnedHandle`), `serde`, `serde_json`, and (1.1)
`rulebox-ipc` with feature `client`. **No WebView, no network.** Add
`#![windows_subsystem = "windows"]`.

(1.1) The earlier rule "no tokio in the launcher" is dropped for one
purpose only: the hidden exit on the fallback screen (Phase 3 R11,
answer P2). The launcher uses `rulebox_ipc::client::call_once`, which
builds a current-thread runtime for the length of one call and drops it.
Reason for reusing it instead of a second, hand-written pipe client:
`call_once` already contains the owner check, the session check, `hello`
and the framing, and those must not exist twice. The supervise loop
itself stays free of async code.

```rust
// current.rs (pure)
pub struct Current { pub version: String, pub exe: PathBuf /* absolute, validated */ }
pub fn resolve(install_dir: &Path, json: &str) -> Result<Current, CurrentError>;
pub enum CurrentError { Parse, AbsolutePath, Escapes, NotUnderVersions, Missing }

// backoff.rs (pure)
pub struct CrashTracker { /* timestamps of recent non-zero exits */ }
impl CrashTracker {
    pub fn record_exit(&mut self, exit_code: u32, now: Instant) -> Next;
}
pub enum Next { RestartNow, RestartAfter(Duration), Fallback }
// exit 0 -> RestartNow and does not count. Non-zero -> 500 ms, 1 s, 2 s, 5 s, 5 s …;
// the 5th non-zero exit within 60 s -> Fallback. A run that lasted 60 s resets the delays.

// fallback.rs
/// Fullscreen, topmost, plain Win32 window (CreateWindowExW + DrawTextW). No images, no fonts to load.
pub fn show(reason: &str) -> FallbackChoice;      // returns when "Try again" is clicked or 30 s pass
```

`main`:

1. Named mutex `Local\RuleboxShellLauncher`; if it already exists, exit
   with code 0 (one launcher per session).
2. Install directory = the folder of the running exe.
3. Loop: read and `resolve` `current.json` each time (so a version switch
   needs no launcher restart) → `CreateProcessW` (application name = full
   path, quoted command line, working directory = the exe's folder) →
   `WaitForSingleObject` → `GetExitCodeProcess` → `CrashTracker`.
4. On `Fallback`, on a `CurrentError`, or when `CreateProcessW` fails:
   `fallback::show`. Text:

   ```
   Rulebox can't start.
   Please contact your administrator.

   <reason, e.g. "The Staff App stopped 5 times (exit code 1).">
   Administrators: restart and hold Shift to reach the Windows sign-in screen.
   ```

   One button: **Try again**. The window also retries by itself every
   30 seconds.
5. Log every start, exit code and fallback to the launcher log
   (Section 4.3). The launcher never exits on its own.

The launcher needs no IPC for supervising: the agent learns the shell's
health from the Staff App's `shell.ready` and heartbeats.

**(1.1) Hidden exit on the fallback screen** (`exit.rs`, used by
`fallback.rs`). When the Staff App cannot start there is no Staff App to
offer the exit, so the launcher offers the same one. The agent still
checks the PIN; the launcher only carries it.

```rust
// exit.rs
pub struct ExitSettings { pub enabled: bool, pub hotkey: rulebox_ipc::hotkey::Hotkey }
/// state.get with a 2-second timeout. Any failure, a missing `adminExit` field, or an unparseable
/// hotkey -> enabled: true with DEFAULT_ADMIN_EXIT_HOTKEY (the agent decides anyway when the PIN is sent).
pub fn load_settings() -> ExitSettings;
/// adminExit.submit with a 10-second timeout, on a worker thread. Never called on the window thread.
pub fn submit(pin: String) -> ExitView;
pub enum ExitView { Ready, Checking, WrongPin { attempts_left: Option<u32> }, LockedOut { retry_after_ms: u64 },
                    SigningOut, Unavailable /* not linked, timeout, not trusted, unknown_method, any RPC error */, Disabled }
pub fn view_for(result: Result<AdminExitSubmitResult, CallError>) -> ExitView;   // pure
pub fn message(view: &ExitView, now_remaining_ms: u64) -> String;               // pure; the texts below
```

- Both calls use `ClientConfig::production()` (so `RULEBOX_AGENT_SIM=1`
  works in a debug build) and `ClientInfo { role: ClientRole::Launcher,
  name: "rulebox-shell", version: env!("CARGO_PKG_VERSION") }`.
- When the fallback window is shown: call `load_settings` on a worker
  thread. While the window is visible, register the combination with
  `RegisterHotKey(hwnd, 1, modifiers | MOD_NOREPEAT, virtual_key)` and
  also match it in the window's `WM_KEYDOWN` / `WM_SYSKEYDOWN` handling
  (`GetKeyState` for the modifiers), so it works whether or not the
  registration succeeded. `UnregisterHotKey` when the window closes, so
  the Staff App can register it later. The combination is **never**
  shown on screen.
- The combination opens a small panel inside the fallback window: the
  title "Administrator exit", one `EDIT` control with `ES_PASSWORD |
  ES_NUMBER` limited to 12 characters (`EM_SETLIMITTEXT`), the buttons
  **Sign out to Windows** (enabled from 4 digits) and **Cancel**. Enter
  submits; Escape cancels. `enabled == false` → the combination does
  nothing.
- Submitting: clear the field at once, show "Checking…", run `submit` on
  a worker thread, post the result back with `PostMessageW(hwnd,
  WM_APP + 1, …)`. The PIN `String` is dropped after the call and never
  logged. While the panel is open, the window's own 30-second "try
  again" timer is paused.
- Texts: `WrongPin` → "That PIN is not right." plus " N tries left."
  when given; `LockedOut` → "Too many tries. Try again in M:SS."
  (counting down once a second; the field stays disabled until zero);
  `SigningOut` → "Signing out to Windows…" (the panel stays until the
  session ends; if the session is still there after 30 seconds, return
  to `Ready` with "Signing out did not work. Try again, or restart this
  PC while holding Shift."); `Unavailable` → "Rulebox can't check the
  PIN right now. Restart this PC while holding Shift, or turn kiosk off
  from the dashboard."; `Disabled` → close the panel.
- The launcher log records "admin exit: opened / wrong / locked /
  signing out / unavailable". Never the PIN.

Unit tests: `resolve` for a good file, an absolute path, `..`, a path
outside `versions\`, bad JSON, a missing exe (use a temp directory);
`CrashTracker` sequences: `0,0,0` → always `RestartNow`; five `1`s in
10 s → `Fallback` on the fifth; four `1`s, 61 s pause, one `1` → not
`Fallback`; delays are 500 ms, 1 s, 2 s, 5 s. (1.1) `view_for`: each
outcome of `AdminExitSubmitResult` maps to its view; an `Unknown`
outcome, `CallError::NotLinked`, `Timeout`, `ServerNotTrusted` and an
RPC error map to `Unavailable`. `message`: the lockout text for
61,000 ms is "Too many tries. Try again in 1:01."; `WrongPin` with and
without a count.

**Verify:** `cargo clippy -p rulebox-shell --all-targets -- -D warnings`,
`cargo test -p rulebox-shell`.

Look at the fallback window on the dev machine (harmless: it is only a
window, and with `RULEBOX_AGENT_SIM=1` it talks to the simulated agent
only): start `cargo run -p rulebox-agent -- run --console --simulate
--sim-demo` in one terminal; in another set `$env:RULEBOX_AGENT_SIM =
"1"`, build, then run `target\debug\rulebox-shell.exe` from a folder
with **no** `current.json`. The fallback window must appear. Press
Ctrl + Shift + F12: the PIN panel appears; `1111` shows the wrong-PIN
text; `2468` shows "Signing out to Windows…" and the agent log shows the
simulate sign-out line. Close the window with Alt+F4 (add that for debug
builds only), take screenshots of the fallback screen and of the panel
for the report, and kill the process afterwards.

**Done when:** tests pass, and the fallback window and its PIN panel
have been seen working against the simulated agent.

---

### Step 13 — Launcher watchdog and hang detection

File: `watchdog.rs`; wire it into `agent.rs`.

```rust
pub struct Watchdog { /* config, last-seen times, counters */ }
pub enum WatchdogAction { None, LaunchLauncher { session_id: u32 }, TerminateShell { pid: u32 } }
impl Watchdog {
    /// Pure decision function: called on every tick, session event and shell signal.
    pub fn decide(&mut self, input: &WatchdogInput, now: Instant) -> (WatchdogAction, ShellHealth);
}
pub struct WatchdogInput { pub kiosk_enabled: bool, pub staff_session: Option<u32>,
                           pub launcher_pids: Vec<u32>, pub shell_clients: Vec<ShellClient> }
pub struct ShellClient { pub pid: u32, pub ready_at: Option<Instant>, pub last_heartbeat: Option<Instant> }
```

The task gathers `WatchdogInput` from `Platform` and the IPC server,
calls `decide`, executes the action through `Platform`, and writes
`shell.health` into the snapshot. Rules are in Section 5.7.

(1.1) `shell_clients` contains only connections whose `hello` role was
`shell` (from `ShellSignal::Connected`). A `launcher` connection (the
fallback screen's short calls, Step 12) is not a Staff App and must not
change `shell.health`. The role is self-declared, so this is only
bookkeeping: a process that lies about it can at most keep itself out
of hang detection, which it could also do by not connecting. While an
exit hold is set (Step 9) there is no Staff session, so rule 1 of
Section 5.7 already makes the watchdog idle.

Unit tests (pure, with a fake clock):

1. Kiosk disabled → `None`, `notRunning`.
2. Staff session, no launcher for 2 s → `None`; for 3 s →
   `LaunchLauncher`.
3. Launcher present, client connected but not ready for 31 s →
   `unhealthy`, no terminate (never-ready is the launcher's crash-loop
   case, not a hang).
4. Client ready, heartbeat 10 s ago → `healthy`.
5. Client ready, last heartbeat 31 s ago → `TerminateShell`; calling
   `decide` again 5 s later → `None` (one per 60 s).
6. `killHungShell: false` → never `TerminateShell`.
7. Five consecutive launch failures → `failed`, next attempt 30 s later.
8. Staff session ends → state resets to `notRunning`.
9. (1.1) A connected client with role `launcher` and no `shell` client:
   health follows the launcher rules only (`starting`, then `unhealthy`
   after 30 s without `shell.ready`), and it is never a `TerminateShell`
   target.

Simulate-mode check: start the simulated agent with a simulated Staff
session (`SimPlatform` option `--sim-staff-session`, add it to `run`),
start `fake_staff`, press `h`, and watch the agent log say it would
terminate the hung shell.

**Verify:** `cargo clippy -p rulebox-agent --all-targets -- -D warnings`,
`cargo test -p rulebox-agent`.

**Done when:** tests pass and the simulate-mode check shows the terminate
decision about 30 seconds after `h`.

---

### Step 14 — VM deployment and the VM checklist (the user runs this)

Write `scripts/vm-deploy.ps1`. It runs **on the VM**, elevated, from a
folder containing the three debug binaries, and:

1. Stops if `HKLM:\SOFTWARE\Rulebox\TestMachine\ComputerName` does not
   equal `$env:COMPUTERNAME`, printing the marker commands from Step 3
   for the user to run by hand. The script never creates the marker.
2. Creates `%ProgramFiles%\Rulebox\versions\0.0.0-dev\`.
3. Copies `rulebox-agent.exe` and `rulebox-shell.exe` to
   `%ProgramFiles%\Rulebox\`. For the Staff App (Phase 3 R7): if a file
   named `rulebox-staff.exe` is in the script's folder, copy **it** to
   `versions\0.0.0-dev\rulebox-staff.exe`; otherwise copy
   `fake_staff.exe` to that name. Print which one was used. Always also
   copy `fake_staff.exe` (when present) to
   `%ProgramFiles%\Rulebox\versions\0.0.0-dev\fake_staff.exe`, so the
   pipe probe of the checklist can run from an allowed folder.
4. Writes `current.json` (Section 4.3).
5. Runs `rulebox-agent.exe service install`.
6. (1.1) Only with the switch `-FixtureDirectory`: after the service is
   installed and stopped, writes
   `%ProgramData%\Rulebox\state\agent-config.json` with
   `{ "fixtureDirectory": true }` (keeping other keys if the file
   exists) and starts the service again. Without the switch it does not
   touch that file. The agent honours the setting only on a machine with
   the test marker (Section 5.9).

Build the binaries on the dev machine (debug only):

```powershell
cargo build -p rulebox-agent -p rulebox-shell
cargo build -p rulebox-ipc --example fake_staff --features client
```

Give the user: `target\debug\rulebox-agent.exe`,
`target\debug\rulebox-shell.exe`,
`target\debug\examples\fake_staff.exe`, `scripts\vm-deploy.ps1`, and the
checklist in Section 10.2. Tell the user to **take a VM snapshot first**.
You do not run any of it. Record the user's results in the final report;
for each failed item, fix, rebuild and ask the user to re-run that item
(2 attempts, then stop and ask).

Also ask the user to run the `#[ignore]` tests on the VM if a Rust
toolchain is available there
(`cargo test -p rulebox-win32 -- --ignored --test-threads=1`); if not,
the checklist covers the same functions end to end.

**Done when:** every item of Section 10.2 is ticked on at least one
Windows 11 Pro VM, and the Home items are either ticked or listed as
"not tested, no Home VM" in the report.

---

### Step 15 — Wrap-up

1. Run and paste the results:

   ```powershell
   pnpm typecheck
   pnpm lint
   cargo clippy --workspace --all-targets --all-features -- -D warnings
   cargo test --workspace --all-features
   "{0:N1} GB" -f ((gci target -r -file | measure Length -sum).Sum/1GB)
   ```

2. Search for leftovers: no `unsafe` outside `crates/rulebox-win32` and
   `apps/shell-launcher`; no `windows::` import outside the four places
   of Section 4.2 (in the code this phase owns: only those two); no
   `.filter(` or `.collect()` in `convex/`; every `DESTRUCTIVE` function
   calls the guard on its first line. (1.1) Also: no `tracing` call or
   `Debug` derive that can print `password`, `pin`, `pin_hash` or
   `password_hash` (search for those four words in `apps/agent/src`,
   `apps/shell-launcher/src` and `crates/rulebox-ipc/src` and read every
   hit); the stand-in exit task of Step 6b is gone.
3. Delete `target\sim-data\` and any copied binaries outside `target\`.
4. Update `docs/plans/README.md`: Phase 2 status → `✅ Done` only after
   the user has reviewed the VM results; until then
   `In progress (awaiting VM run)`.
5. Do not edit `docs/prd.md` or `CLAUDE.md`. Give the user Section 15 of
   this file as the list of PRD changes to consider.
6. Commit only when the user says so; no push; no Claude attribution.

## Final report format (keep it short)

- ✅ / ❌ for each step's **Done when** check.
- Versions actually pinned (every crate in Section 4.4, Rust, Convex npm).
- Size of `target/` before and after.
- VM checklist results per Windows edition and build tested.
- Which `ShellMechanism` worked on which edition.
- Every deviation from this plan, and why. If you found a better way
  (CLAUDE.md rule), say so explicitly.
- Anything marked **(unverified)** in this plan that you confirmed or
  disproved.
- (1.1) The result of the pipe probe as the Staff user (Section 10.2),
  what Windows did after an administrator signed out following a hidden
  exit, and how long one PIN check took on the VM.
- (1.1) The list "Changes Phase 3 must pick up" from Section 12, with
  anything you had to change in it.
- Open questions for the user.

## Stop and ask the user if

- a prerequisite is missing, or free disk space is below 8 GB;
- `guard::is_test_machine()` is true on the machine you are working on,
  or a `RuleboxStaff` account exists there;
- a step's **Done when** check still fails after 2 honest fix attempts;
- you want to add a dependency not named in Section 4.4, or a newer
  minor/major of one of the pinned crates exists;
- the build starts compiling OpenSSL;
- you need to change anything in Section 6 after Step 6 is done (for
  Section 6.11: after Step 6b is done);
- the Argon2 timing test of Step 6a fails, or a PIN check takes more
  than 3 seconds anywhere;
- the VM pipe probe prints `create-instance: ALLOWED`, or the
  server-session check keeps a correct client from linking;
- a secret (password, PIN, hash) shows up in a log, a snapshot or a
  `status` output;
- a Convex deploy would delete or reject existing data;
- the code and the PRD disagree on something not listed in Section 14.

---

## 8. Edge cases and failure modes

| # | What can go wrong | How the agent must behave | Step |
|---|---|---|---|
| 1 | PC boots with no network | Load cached desired state and reconcile from it; Convex client retries forever with backoff; snapshot `connection: "offline"`; Staff App still starts | 8 |
| 2 | Enrolled, never received a desired state, offline | Use `DesiredState::enrollment_default()` (kiosk on) | 8, 9 |
| 3 | Enrollment code reused after its single use | Server returns `token_used_up`; the agent changes nothing locally | 7, 8 |
| 4 | Enrollment code expired or revoked | `token_expired` / `token_revoked`; expiry is judged by server time only | 7, 8 |
| 5 | Response to `enroll` lost (network dropped after the server consumed the code) | The secret was saved before the call; retry with the same code sends the same hash; the server returns the same device without consuming another use | 7, 8 |
| 6 | Malformed or wrong-prefix code | Typed `CodeError`, no network call | 8 |
| 7 | Device already enrolled | `already_enrolled`; admin must `unenroll` first | 8 |
| 8 | `RuleboxStaff` already exists and is ours (stored SID matches) | Reuse it | 9 |
| 9 | `RuleboxStaff` exists, carries the Rulebox comment, no stored SID (state lost or half-finished earlier run) | Adopt it and reset its password | 9 |
| 10 | `RuleboxStaff` exists and is not ours | `staff_account_conflict`; nothing changed; reported to admin and backend | 9 |
| 11 | Local password policy rejects the generated password | `PasswordPolicy` error → enable fails → rollback → retry later; reported | 9, 10 |
| 12 | Stored auto sign-in password no longer matches the account (someone changed it, or a crash between "set password" and "store secret") | Pending secret promoted if it works; otherwise one repair reset; never more than one test logon per repair | 9, 10 |
| 13 | Crash or power loss in the middle of Enable | State and journal are saved after each step; on restart `reconcile` is idempotent and finishes or rolls back | 9 |
| 14 | Enable fails half-way (any step) | Automatic Disable (rollback), `last_error` set, retry after 1, 5, 15 minutes; device stays enrolled | 9 |
| 15 | Windows or an admin sign-in overwrites `DefaultUserName`, or an update resets Winlogon values | Re-asserted on every session event, at service start and every 10 minutes | 9 |
| 16 | The owner already used auto sign-in for their own account | Original values (including the password, kept in `Secrets`) are journaled and restored on Disable | 9 |
| 17 | A sign-in legal notice is configured | Blocker `legal_notice`; kiosk not enabled; the agent never deletes the banner | 5.5, 9 |
| 18 | Update restart signs Staff back in and **locks** the session (Automatic Restart Sign-On), or anything else locks it | `DisableAutomaticRestartSignOn = 1` and `DisableLockWorkstation = 1` prevent it; if it still happens, the agent signs the locked console session out after 10 s and automatic sign-in returns to the shell | 9 |
| 19 | The Staff session becomes `Disconnected` (until Phase 5 empties the Ctrl + Alt + Del screen, Switch user can still cause this; it is not an admin route and nothing documents it as one) | The agent leaves the session alone; watchdog pauses for that session | 9, 13 |
| 20 | Service starts **after** automatic sign-in (boot race, Fast Startup resume) | Never rely on logon events; enumerate sessions at start and after each event; the launcher was started by Winlogon and needs no agent | 11, 13 |
| 21 | Staff App crashes | Launcher relaunches after 500 ms (within the PRD's ~2 s) | 12 |
| 22 | Staff App crash loop (5 in 60 s), or `current.json` / exe missing or invalid | Native fallback screen with "Try again"; retry every 30 s; agent reports `shell.health` `unhealthy`/`failed` in the next heartbeat | 12, 13 |
| 23 | Staff App hangs (no heartbeat for 30 s after being ready) | Agent terminates the verified process once per 60 s; launcher relaunches it | 13 |
| 24 | Launcher itself dies | Agent relaunches it in the Staff session after 3 s; 5 failures → `failed`, retry every 30 s | 13 |
| 25 | Agent crashes or panics | Process ends without a clean stop; service manager restarts it after 1 s, 5 s, 30 s; the shell keeps running; the restarted agent finds it again | 5, 11 |
| 26 | Agent permanently broken or deleted | PC still works: launcher and Staff App run without it (Staff App shows "agent unavailable"; the hidden exit cannot work without the agent and says so); admin restarts while holding Shift to reach the Windows sign-in screen, signs in and runs `recover` | 11, 12 |
| 27 | Admin needs normal Windows now | Any of: the hidden exit (key combination + PIN; in the Staff App, or on the launcher's fallback screen); `kioskEnabled: false` from the backend (Disable kiosk); hold Shift during startup to skip auto sign-in; then, signed in as an administrator, `rulebox-agent unenroll` or `rulebox-agent recover` | 6b, 9, 11, 12 |
| 28 | No other usable local administrator exists | Blocker `no_other_admin`; kiosk never enabled | 5.5, 9 |
| 29 | Device clock is wrong (dead CMOS battery) | Nothing is rejected on local time; `clockSuspect` set when the clock jumps back more than 24 h; TLS failures show as `offline`; cached state keeps the kiosk working | 8 |
| 30 | Unsupported Windows (below build 19045, S mode) | Blocker; enrollment refused before any change | 5.5, 8 |
| 31 | Domain-joined or Entra-joined PC | Blocker `managed_device` unless `--allow-joined` (management policy is known to strip auto sign-in) | 5.5, 8 |
| 32 | Device revoked or deleted on the backend | Stop syncing, snapshot `revoked`, **keep** current kiosk state; admin unenrolls locally | 8 |
| 33 | Desired state document does not parse, or has a lower version than the one applied | Keep the previous state; log and report | 8 |
| 34 | Another process created the pipe name first (squatting) | First-instance creation fails; security log line; retry every 5 s; never use another name | 4, 6 |
| 35 | A non-Staff process, a process in another session, or a low-integrity process connects to the shell pipe | DACL, mandatory label and peer verification reject it (`unauthorized`) | 4, 6 |
| 36 | Client floods the agent or sends a huge frame | `busy` above 16 in flight; frame above 1 MiB closes the connection | 2, 6 |
| 37 | Protocol version mismatch between agent and Staff App | `unsupported_protocol` with the supported version; the Staff App shows a "version mismatch" state | 2, 6 |
| 38 | Data directory was pre-created by a standard user, or is a reparse point | Empty and not a link: removed and created again with the protected DACL. Otherwise the agent refuses to start, writes nothing into it, prints why to stderr and (as a service) stops with service-specific exit code 2 (Section 5.1) | 10, 11 |
| 39 | State file corrupt | Renamed aside, treated as missing; the kiosk settings already on the machine stay; `recover` handles the no-state case | 5, 11 |
| 40 | Service removed while kiosk is on | `service uninstall` refuses unless `--force`, which runs `recover` first | 11 |
| 41 | "Service marked for deletion" on reinstall | Reinstall updates the existing service instead of recreating; error 1072 gives a clear instruction | 11 |
| 42 | Antivirus or SmartScreen blocks the unsigned agent, or flags account creation and Winlogon edits | Not solvable in Phase 2 (signing is Phase 6). Record it in the VM run; report `Access denied`-style failures clearly | 14 |
| 43 | Convex one-shot call never returns while offline | Every call has a 30 s timeout | 8 |
| 44 | Network requires an explicit proxy | The Convex Rust client has no proxy support: the device stays `offline`. Documented limitation | 8 |
| 45 | First sign-in of the new account shows Windows first-run or privacy screens | `EnableFirstLogonAnimation = 0`, `DisablePrivacyExperience = 1`; verify on the VM (**unverified** on Home) | 9, 14 |
| 46 | Employee signs out of Windows from Ctrl+Alt+Del | Automatic sign-in signs Staff back in (**unverified** whether Windows does this without a restart; the VM checklist records it). Removing that option is Phase 5 | 9 |
| 47 | (1.1) Wrong exit PIN, repeatedly, by an employee | `wrongPin` four times, then locks of 1, 5, 15, 30 and 60 minutes; counted per device, saved to disk, kept across agent and PC restarts; every wrong PIN and every lock is an audit record. The administrator can wait, rotate the PIN, or use a recovery route | 6b |
| 48 | (1.1) Many PIN or password requests at the same moment (a hostile process opening several connections) | One check at a time per device; the others get `busy`. The failure is counted and saved **before** the check runs | 6a, 6b |
| 49 | (1.1) Agent killed or PC powered off in the middle of a PIN or password check | The attempt was already counted; no free guess | 6a, 6b |
| 50 | (1.1) Correct PIN, but the sign-out cannot be prepared or fails | Before the answer: error `internal` (retryable), nothing counted. After `signingOut`: three retries, then automatic sign-in is re-armed and an `adminExitFailed` record is written; the client returns to its PIN field after 30 s | 6b, 9, 12 |
| 51 | (1.1) Administrator used the hidden exit and never signed in | Automatic sign-in is re-armed after 5 minutes; the next restart is a kiosk again | 9 |
| 52 | (1.1) PC restarted during the 5-minute exit hold | It starts at the Windows sign-in screen once (the value was still `"0"` at boot); the agent re-arms at start; the restart after that is a kiosk | 9 |
| 53 | (1.1) Exit settings in the document are broken (bad hash, bad key combination) | Bad hash: exit **off**, error logged, shown in `status`. Bad combination: default combination, warning logged | 6b, 8 |
| 54 | (1.1) PIN rotated or exit disabled from the backend while offline | Takes effect when the document arrives; until then the cached settings apply | 8 |
| 55 | (1.1) Exit PIN entered on a PC with no PIN set, not enrolled, or exit disabled | `disabled`; nothing counted; the key combination does nothing in the clients | 6b |
| 56 | (1.1) Employee signs in while the PC is offline | Cache entry present, not expired and the password matches → `ok` with `offline: true`. Otherwise `offlineNeverSignedIn` or `offlineExpired`. Clock set back → still expired | 6a |
| 57 | (1.1) Employee backend unreachable although the device is "online" | 6-second timeout, then the offline path | 6a |
| 58 | (1.1) Agent restarts while an employee is signed in | The session is gone (memory only); `session.get` returns no employee; the Staff App asks for the password again and signs in the same user | 6a |
| 59 | (1.1) Staff session ends while an employee is signed in (restart, crash, hidden exit) | The agent clears the employee session | 6b, 9 |
| 60 | (1.1) Audit records cannot be delivered (offline, or no audit backend before Phase 4) | Kept in `audit-queue.json`, at most 500, oldest dropped and counted; sent in batches of 50 when the connection returns | 6a |
| 61 | (1.1) A Staff-session process creates its own instance of the shell pipe and waits for the Staff App | The DACL should refuse it (VM probe). If it does not: the client's server-session check refuses a server outside session 0 before it sends anything | 5a, 14 |
| 62 | (1.1) A link is planted where the employee's files folder will be | The agent never touches that folder; it only names the path. The Staff App creates and confines it (Phase 3) | 6a |

---

## 9. Security notes

- **Least privilege by placement.** The Staff App and the launcher run as
  the standard user and never elevate. Everything privileged is in the
  service. The 1.0 IPC surface is read-only state plus health signals.
  (1.1) The 1.1 surface adds exactly **one** method that makes the agent
  act with its privileges: `adminExit.submit`. What it can cause is
  fixed (sign the caller's own Staff session out and pause automatic
  sign-in for at most 5 minutes), it takes no path, command or target
  from the caller, it is gated by a PIN the agent checks itself, and a
  correct PIN grants no administrator right. `session.*` and
  `apps.list` change only the agent's own memory and its cache files.
- **Never trust the Staff session.** Any process running as Staff can
  open the shell pipe, and could inject into the Staff App. Therefore:
  every method must be safe when called by a hostile Staff-session
  process; all parameters are validated on the agent; the agent never
  executes a path, command line or registry location supplied over IPC.
  The image-path check is defence in depth, never the authorisation.
- **Pipe ACLs.** Explicit security descriptor on every instance; SYSTEM
  as owner; no create-instance right for Staff; network logons denied;
  first-instance flag; remote clients rejected; client connects at
  identification level and checks the owner. (1.1) The client also
  requires the server to be in session 0, because the "no
  create-instance right for Staff" property is **not yet proven** (the
  Step 4 result in Section 6.2) and the client now sends passwords and
  the PIN. The VM probe decides whether the DACL holds.
- **(1.1) PIN and passwords.**
  - The exit PIN exists on the device only as a salted Argon2id hash
    inside the cached desired-state document, in the directory only
    SYSTEM and Administrators can read. It is never in the snapshot, an
    IPC result, an event, `status` output or a log. The Staff session
    never holds it, so nothing in the Staff session can check a PIN.
  - Employee passwords are checked online by the directory (Phase 4) or
    against a salted Argon2id hash in `employee-cache.json` in the same
    directory. The plain password lives only for the length of one
    request and is never written or logged.
  - Guessing is limited in the agent, per device (PIN) and per username
    plus per device (passwords), saved to disk, counted before the check
    runs, one check at a time. Limits are never per connection.
  - A 4-digit PIN is weak against anyone who can read the hash; the
    design therefore depends on the hash staying inside the agent, not
    on the hash function. Phase 4 should require at least 6 digits.
  - Every exit attempt is an audit record written to disk before the
    answer is sent.
- **(1.1) Fixture employees are a test-only door.** `FixtureDirectory`
  accepts published passwords. Outside simulate mode it is used only
  when the config file asks for it **and** the test-machine marker is
  present; Phase 4 removes the config key when the real directory
  lands, and Phase 6 must confirm a release build cannot enable it.
- **Admin commands** travel over a second pipe that only SYSTEM and
  elevated Administrators can open, and the agent re-checks the caller's
  token.
- **Secrets.**
  - Staff password: generated on the device, 32 random characters, held
    only as the LSA secret `DefaultPassword` (PRD 13.5). Never written to
    the registry in plain text, never logged, never sent to the backend.
    A local administrator or SYSTEM can read LSA secrets; that is
    inherent and acceptable, since they already own the machine.
  - Device secret: 32 random bytes generated on the device; the server
    stores only its SHA-256. Stored locally with DPAPI under SYSTEM's key
    in an administrators-only directory.
  - Enrollment token: the server stores only its SHA-256; single-use and
    60 minutes by default.
  - The device secret travels as a function argument over TLS on every
    call. Whether Convex records function arguments in its own logs is
    **unverified**; the deployment owner is the Rulebox admin either way.
- **Files the service runs or loads** live only under `%ProgramFiles%`
  (not writable by standard users). `service install` refuses any other
  location. The agent never runs anything from `%ProgramData%` or a user
  profile.
- **Service path quoting** is handled by `windows-service`; the launcher
  and `launch_in_session` always pass the full path as the application
  name **and** quote it in the command line.
- **Tokens.** The agent launches into the Staff session only with that
  session's own token, after checking the token's user SID and that it is
  not elevated. Tokens and handles are closed on every path (RAII).
- **Admin way back is protected in code**, not only by convention:
  `set_winlogon_value` refuses `Shell`, `Userinit`, `IgnoreShiftOverride`
  and `ForceAutoLogon`; the shell value can only be written through a
  handle to the Staff user's hive; `write_machine_value` accepts exactly
  three HKLM keys. The routes back are: the hidden exit (key combination
  + PIN), Disable kiosk from the backend, holding Shift during startup,
  and `recover` / `unenroll` from an administrator session. **Holding
  Shift at startup must keep working** (it is one of the two recovery
  routes of PRD 9.5 when the Staff App is broken); no later phase may
  set `IgnoreShiftOverride` or `ForceAutoLogon`. Ctrl + Alt + Del →
  Switch user is **not** a route: it still works on a Phase 2 test VM,
  Phase 5 removes it, and nothing may be designed around it.
- **Not covered in Phase 2** (stated so nobody assumes otherwise): the
  desired state is **not** signature-checked yet (Phase 4); binaries are
  unsigned (Phase 6); the Staff account has no lockdown policies, so an
  employee can still open Task Manager (Phase 5); the service keeps
  LocalSystem's full privilege set (Phase 5 may restrict it once the
  needed list is known from VM runs).

---

## 10. Test strategy

### 10.1 On the dev machine (automated, safe)

| Area | Kind | Where |
|---|---|---|
| Wire format, codec, forward compatibility | unit | `rulebox-ipc` |
| Real named pipes with the current user's SID | integration | `rulebox-ipc/tests` |
| SDDL parsing, SIDs, OS info, guard returns `Err` everywhere | unit, read-only | `rulebox-win32` |
| Enrollment, backend handling, cache, heartbeat | unit with `FakeBackend`, paused time | `rulebox-agent` |
| Kiosk enable/disable/rollback/idempotency | unit with `SimPlatform` | `rulebox-agent` |
| Watchdog decisions | pure unit, fake clock | `rulebox-agent` |
| (1.1) Wire shapes of 1.1, key-combination parser, `call_once` | unit and pipe integration | `rulebox-ipc` |
| (1.1) Lockout schedules, offline cache, sign-in outcomes, PIN gate, audit queue, "no secret in snapshot or log" | unit with `FixtureDirectory`, fake clock | `rulebox-agent` |
| (1.1) Data-directory decision table | pure unit | `rulebox-agent` |
| (1.1) Launcher PIN panel | pure unit for the mapping; by eye against the simulated agent | `rulebox-shell` |
| Launcher path validation and crash logic | pure unit | `rulebox-shell` |
| Convex functions | typecheck, lint, manual `npx convex run` | `convex/` |
| End to end without OS changes | `run --console --simulate` + `fake_staff` + real Convex dev deployment | manual |

The guard makes the dev machine safe even against mistakes: a mutating
`rulebox-win32` function returns `Err(Guard)` there, and Step 10 has one
test per function proving it.

### 10.2 On the VM (manual; the user runs it; snapshot first)

Run once per available VM. Record Windows edition, version and build.

**Setup**

- [ ] Snapshot taken. A second local administrator account exists and its
      password is known. A second **standard** user exists too.
- [ ] Marker created by hand (Step 3 commands).
- [ ] (Data directory, planted and not empty.) **Before** the first
      `vm-deploy.ps1`, signed in as the standard user, run
      `mkdir C:\ProgramData\Rulebox` and
      `echo x > C:\ProgramData\Rulebox\x.txt`. Then run `vm-deploy.ps1`
      as the administrator: `service install` must **refuse** and name
      the data directory; nothing else may be written into that folder.
- [ ] (Data directory, planted and empty.) As the administrator delete
      `x.txt` only, and run `vm-deploy.ps1` again: it succeeds;
      `(Get-Acl C:\ProgramData\Rulebox).Owner` is SYSTEM or
      Administrators, not the standard user.
- [ ] `vm-deploy.ps1` finishes; `sc.exe qc RuleboxAgent` shows
      `AUTO_START`, `LocalSystem`, a quoted path;
      `sc.exe qfailure RuleboxAgent` shows three restart actions.
- [ ] `icacls "$env:ProgramData\Rulebox"` shows only SYSTEM and
      Administrators.
- [ ] `rulebox-agent status` prints `notEnrolled`.
- [ ] A standard user cannot stop the service
      (`sc.exe stop RuleboxAgent` from a non-elevated prompt fails).

**Enrollment**

- [ ] `rulebox-agent compat` shows no blockers.
- [ ] `rulebox-agent enroll <code>` succeeds; the device appears in the
      Convex dashboard; `net user RuleboxStaff` shows a standard user in
      Users only.
- [ ] `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"`
      shows `AutoAdminLogon 1`, `DefaultUserName RuleboxStaff`, and **no**
      `DefaultPassword` value; `Shell` still says `explorer.exe`.
- [ ] Enrolling again says `already_enrolled`. The same code on a second
      VM says `token_used_up`.

**Sign-in and shell**

- [ ] Restart: the PC signs in to `RuleboxStaff` by itself and shows the
      `fake_staff` console, not Explorer. Note any first-run or privacy
      screen.
- [ ] `fake_staff` shows `Linked` and a snapshot with `enrolled`,
      `kiosk.phase applied`, `shell.health healthy`.
- [ ] Which `ShellMechanism` is in use: ______. If the default did not
      work (Explorer appeared), set `"shellMechanism": "winlogonShell"` in
      `agent-config.json`, restart the service, restart the PC, and
      record the result.

**Watchdog**

- [ ] Press `c` in `fake_staff`: it is back in under 2 seconds.
- [ ] Press `c` five times quickly: the "Rulebox can't start" screen
      appears; **Try again** brings `fake_staff` back.
- [ ] Press `h`: about 30 seconds later the agent kills it and it comes
      back.
- [ ] From the admin session, kill `rulebox-shell.exe` in the Staff
      session: it is relaunched within about 5 seconds.
- [ ] `taskkill /f /im rulebox-agent.exe` (elevated): the shell stays up;
      the service is running again within a few seconds
      (`sc.exe query RuleboxAgent`).
- [ ] Rename `current.json`: after the next shell exit the fallback
      screen appears; restore the file and **Try again** works.

**IPC security**

- [ ] From a second standard user (not Staff), run `fake_staff.exe`: it
      never reaches `Linked`.
- [ ] From the Staff session, run a copy of `fake_staff.exe` placed
      outside `Program Files\Rulebox\versions\`: `unauthorized`.
- [ ] From an elevated admin prompt, `rulebox-agent status` works; from a
      non-elevated prompt it fails with an access error.
- [ ] **Pipe probe as the real Staff user (not elevated).** This repeats
      Step 4's test 4 the way it has to be done: on the dev machine it
      ran elevated as the pipe's owner, and there a client open asking
      for bit `0x4` was accepted. In the Staff session press `p` in
      `fake_staff` and write down the three lines. Expected:
      `owner: S-1-5-18`, `server session: 0`,
      `create-instance: DENIED (error 5)`.
  - **`create-instance: ALLOWED`, or an error other than 5** (231 means
    all four instances were busy: close other clients and repeat once):
    the pipe's DACL does **not** stop a Staff process from creating its
    own instance. Stop and tell the user. The fallback design is:
    1. The client's server-session check (Section 6.2, client check 3)
       becomes the thing that authenticates the agent to its clients.
       It is already built (Step 5a); confirm it with the next item.
    2. Rewrite the sentences in Section 6.2 and Section 9 that say the
       Staff entry "can never create its own instance", and report it.
    3. Ask the user whether to add a second client check before
       release: `GetNamedPipeServerProcessId` →
       `QueryFullProcessImageNameW` must be
       `<install>\rulebox-agent.exe`. Do not build it unasked.
    What remains possible for a hostile Staff process in that case is
    taking pipe instances so the Staff App cannot connect (a nuisance,
    visible as `shell.health` never becoming `healthy`).
  - **`server session` is not 0, or `fake_staff` never reaches
    `Linked` and its output says the server is not trusted:** the
    session check does not behave as specified on this edition
    **(unverified)**. Stop and tell the user; the replacement is the
    process-image check of point 3. Never ship with the check simply
    switched off.
- [ ] As the Staff user, a client open that asks for `GENERIC_READ |
      GENERIC_WRITE` (the `p` output prints this as a fourth line,
      `generic-write open: ACCEPTED` or `REFUSED (error n)`). Either
      result is acceptable; record it. It tells us whether the Step 4
      observation came from running elevated.
- [ ] As the Staff user (Task Manager → Run new task → `cmd`),
      `type "%ProgramData%\Rulebox\state\desired-state.json"` and
      `dir "%ProgramData%\Rulebox"` both fail with "Access is denied".

**Offline and desired state**

- [ ] Disconnect the network and restart: automatic sign-in and the shell
      still work; snapshot shows `offline`.
- [ ] Reconnect: `online` within a minute; `deviceStatus.lastSeenAt`
      updates.
- [ ] `npx convex run dev:setKiosk '{"deviceId":"…","enabled":false}'`:
      within seconds `fake_staff` prints `ShuttingDown kioskDisabled`;
      10 seconds later the PC is at the Windows sign-in screen; Winlogon
      values are back to their originals; restart does **not** sign in
      automatically.
- [ ] `setKiosk … true`: after a restart the kiosk is back.

**Hidden admin exit (1.1)**

- [ ] On the dev machine: `rulebox-agent hash-pin` with a 6-digit PIN of
      your choice, then
      `npx convex run dev:setAdminExit '{"deviceId":"…","pinHash":"<line>"}'`.
      On the VM, `rulebox-agent status` shows the admin exit as on with
      `Ctrl+Shift+F12` within seconds, and shows no hash.
- [ ] In `fake_staff` press `x` and enter a wrong PIN twice: `wrongPin`
      with `attemptsLeft` 4, then 3. Restart the PC. `status` still shows
      2 failures.
- [ ] `x` with the right PIN: `signingOut`, about 2 seconds later the
      Windows sign-in screen, and Staff is **not** signed back in.
      Write down how long the answer took (the agent log has the
      duration; it must be far below 10 seconds in this debug build).
- [ ] Sign in as the administrator. Within a minute
      `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon`
      shows `1` again. Sign out: **write down** whether Windows signs
      Staff in by itself or stays at the sign-in screen
      **(unverified)**. Restart: the kiosk is back.
- [ ] Use the exit again, do **not** sign in, wait 6 minutes, restart:
      the kiosk is back.
- [ ] Five wrong PINs: the fifth answers `lockedOut` near 60 seconds; the
      right PIN during the lock is refused; after the lock it works.
- [ ] Network disconnected: the right PIN still works.
- [ ] `dev:setAdminExit` with `"enabled": false`: `x` answers `disabled`.
      Set it back.
- [ ] Press `c` five times quickly (fallback screen), then Ctrl + Shift
      + F12: the PIN panel appears; a wrong PIN shows its text; the right
      PIN leads to the Windows sign-in screen.
- [ ] `rulebox-agent status` shows a non-zero "audit queued" count after
      these tests (nothing is delivered before Phase 4).
- [ ] Optional, with `vm-deploy.ps1 -FixtureDirectory`: in `fake_staff`,
      `i` → `maya demo` answers `ok` with a `filesRoot` under the Staff
      profile's `RuleboxFiles`; that folder does **not** exist afterwards
      (the agent must not create it); `a` lists four apps. Without the
      switch, `i` is not offered (`session` is not in the capabilities).

**Admin way back**

- [ ] Staff session `Disconnected` (still reachable in Phase 2 through
      Ctrl + Alt + Del → Switch user; **this is not an admin route**,
      Phase 5 removes it, and it is tested only because the state can
      occur): the administrator signs in and sees Explorer; the agent log
      shows it left the disconnected Staff session alone; after the
      administrator signs out the Staff session is still there.
- [ ] Hold Shift during startup (and, separately, while signing out of
      Staff): the sign-in screen appears instead of automatic sign-in.
- [ ] Win+L in the Staff session does nothing.
- [ ] Stop and disable the service, then run `rulebox-agent recover
      --yes`: restart shows the normal sign-in screen; signing in as
      `RuleboxStaff` is not possible (unknown password) and nothing else
      is affected. Re-enable and start the service: `status` shows
      "recovered: kiosk held off".
- [ ] Safe Mode boot: record what happens (does automatic sign-in fire?
      does the custom shell run?). **(unverified)**

**Cleanup**

- [ ] `rulebox-agent unenroll --remove-staff-account`: account and
      profile gone; Winlogon values original; device marked revoked in
      Convex.
- [ ] `rulebox-agent service uninstall`: service gone.
- [ ] Revert to the snapshot.

**Extra items for a Home VM:** the whole list, with special attention to
"Sign-in and shell" (both mechanisms) and the first-run screens.

---

## 11. Disk and build guidance

- One Cargo workspace, one `target\` at the repo root. Never set
  `CARGO_TARGET_DIR`, never add a nested `[workspace]`.
- Debug builds only. No `--release`, no `tauri build`.
- Expect `target\debug` to grow by about 1–2 GB in Phase 2. Warn the user
  before the first build in Step 1 and before Step 14's builds if D: has
  less than 8 GB free.
- Use `-p <crate>` for check, clippy and test until Step 15. A
  workspace-wide build also rebuilds the Tauri app.
- Stay on `windows` 0.62 and `tokio` 1.53 so the versions Tauri already
  compiled are reused.
- Simulate-mode data lives in `target\sim-data\`. Do not leave binaries,
  zips or logs anywhere else. If space runs low: `cargo clean -p
  rulebox-agent` first, full `cargo clean` only after telling the user.
- pnpm only. No new npm packages are needed in Phase 2.

---

## 12. Hand-off notes for other phases

- **Phase 3** builds on Section 6 and `rulebox-ipc` (feature `client`).
  It must: use `IpcClient`; call `shell.ready` and send heartbeats; exit
  with code 0 only for an intentional restart; be single-instance; take
  `displayMode`, `convexUrl` and `desiredState` from the snapshot; build
  the real `rulebox-staff.exe` that replaces `fake_staff`.
- **Changes Phase 3 must pick up** (where protocol 1.1 as specified here
  differs from Section 15 of `phase-3-staff-shell.md`; the Phase 3 plan
  was not edited):
  1. **The agent does not create the employee's folder.** `filesRoot`
     is a path only. The Staff App creates it (as Staff) and must refuse
     a reparse point there (Section 5.9, "Files root").
  2. **Result shapes are flat.** `SignInResult`,
     `VerifyPasswordResult` and `AdminExitSubmitResult` are structs with
     an `outcome` string and nullable fields, not tagged unions; fields
     that do not apply are `null`, not absent. Use the types in
     `rulebox_ipc::requests` and map them to the Staff App's own enums.
     An `unknown` outcome must be handled.
  3. **`AppEntry` on the wire** has `kind` as a string plus three
     nullable objects (`builtin`, `web`, `desktop`), and no `iconKey` or
     `badge`. The Staff App maps it to its own `AppEntry`.
  4. **The 1.1 request types are not generated into `@rulebox/types`**
     (the Staff App's DTOs `Employee` and `AppEntry` would collide in
     the same folder). Only `AdminExitInfo` and `PowerOptions` are new
     there.
  5. **The session lives in the agent's memory.** After every relink
     call `session.get`; if it returns no employee while the UI is
     signed in, show the lock screen and unlock with `session.signIn`
     for the same username (`verifyPassword` would answer
     `not_signed_in`). `session.signIn` for a different username while
     someone is signed in is refused with `denied_by_policy`; call
     `session.signOut` first.
  6. **New error codes** `not_signed_in` and `busy` can come back from
     the 1.1 methods; `session.signIn` can also answer `timeout`
     (retryable). `session` and `apps` are missing from the capabilities
     when the agent has no employee directory (every real agent until
     Phase 4, except fixture mode on a test machine).
  7. **Key combination:** the snapshot always carries a canonical, valid
     text. `rulebox_ipc::hotkey::parse` implements the grammar Phase 3
     describes (F1 to F12 only); use it instead of a second parser. The
     default is `Ctrl+Shift+F12` (`DEFAULT_ADMIN_EXIT_HOTKEY`).
  8. **After `signingOut`** the agent sends `agent.shuttingDown` with
     reason `adminExit` and `graceMs: 2000`. Do not show the "save your
     work" banner for this reason. If the session is still alive
     30 seconds later, return the dialog to its ready state with an
     error (the agent re-arms automatic sign-in by itself).
  9. **`attemptsLeft`** counts the PINs that will still be checked
     before a wait (4, 3, 2, 1). The answer to the fifth wrong PIN is
     `lockedOut`, not `wrongPin` with 0.
  10. **Simulated agent:** 1.1 answers need `--simulate --sim-demo`
      (plain `--simulate` is not enrolled and lists only `adminExit`
      beyond 1.0). Add `--sim-offline` for the offline outcomes. Demo
      users: `maya`, `sam` (always `offlineExpired` offline), `alex`
      (`disabled`); password `demo`; PIN `2468`.
  11. **Server check:** `IpcClient` now also requires the pipe server to
      be in session 0 outside simulate mode. No action unless the VM run
      shows a problem.
  12. **`vm-deploy.ps1`** copies `rulebox-staff.exe` when it lies next
      to the script (R7), and `-FixtureDirectory` turns on the fixture
      employees on a marked test VM so Phase 3's VM run can sign in.
- **Phase 4** owns: signature verification (the `signature` field and
  the startup warning mark the seam), merging group and device desired
  state, heartbeat interval scaling, the dashboard for enrollment codes
  (replacing `convex/dev.ts`), the audit log, and a decision on moving
  device auth to JWT (Q1). From the 1.1 addendum it also owns:
  `ConvexDirectory` behind `EmployeeDirectory` (one call that returns
  the employee, the catalogue and `offline_days`; then remove the
  `fixtureDirectory` config key); the Convex sink behind `AuditSink`
  and its table (idempotent on `AuditRecord.id`); writing `adminExit`,
  `power` and `orgName` into the desired-state document from dashboard
  settings (hashing the PIN with Argon2id inside the limits of Section
  5.9, never letting a dashboard reader fetch `pinHash`, asking for at
  least 6 digits); what `session.signOut` cleans up (PRD 5.3); an
  `apps.changed` event if the catalogue must refresh while signed in
  (a 1.2 addition). **Never add a secret field to
  `rulebox_policy::DesiredState`**: that type is sent to the Staff
  session whole.
- **Phase 5** owns: Staff lockdown policies (`NoLogoff`, Task Manager,
  Win keys, emptying the Ctrl + Alt + Del screen), hiding the admin
  tile, wake-password and sleep behaviour, restricting service
  privileges, the process allow-list watchdog. It must keep the hidden
  exit and the Shift-at-startup bypass working, and it must re-run the
  hidden-exit checklist items after `NoLogoff` and the other policies
  are applied (the agent's `logoff_session` must still work).
- **Phase 6** owns: the MSI (registering the service the same way as
  Step 11), the release answer to the test-machine guard, code signing,
  and reusing `compat.rs` for the installer check.

---

## 13. Known risks from research

| Risk | Detail | Handling |
|---|---|---|
| `windows` crate 0.100 migration | `windows-core` and related crates are already 0.100 (2026-09-03); the `windows` and `windows-sys` crates are still 0.62.2 / 0.61.2. When 0.100 lands, every `Win32_*` feature and module path is renamed and signatures change | All `windows` usage is confined to four known places (Section 4.2; two in this phase, two in Phase 3). Stay on 0.62. Do not add 0.100 sub-crates |
| (1.1) Automatic sign-in after a sign-out | This plan assumes Windows signs Staff in again after a sign-out without a restart, and `ForceAutoLogon` (which would force it) is forbidden. Not confirmed **(unverified)** | The hidden exit does not depend on it (it sets `AutoAdminLogon = "0"` first, so it is right either way). The VM checklist records the behaviour; if Windows does not sign in again, edge cases 18 and 46 need a restart to return to the kiosk and the user must be told |
| (1.1) Argon2 in debug builds | Unoptimized Argon2 can exceed the 10-second IPC timeout | `opt-level = 3` for `argon2` and `blake2` in the dev profile; a timing test in Step 6a; the VM checklist records the real duration |
| (1.1) Pipe DACL and bit `0x4` | The Step 4 run (elevated) accepted a client open that asked for the bit | Probe as the real Staff user on the VM; client-side server-session check as the second line (Section 6.2) |
| Per-user custom shell on Home | Neither `Policies\System\Shell` nor per-user `Winlogon\Shell` is documented by Microsoft for Windows 11 Home; evidence is forum-level and old **(unverified)** | Both mechanisms implemented; VM checklist decides; PRD 13.2 "Verify" gets its answer |
| Automatic sign-in removed by management policy | Reports on Windows 11 24H2 of `AutoAdminLogon` being reset on Intune/domain devices | Joined devices are blocked by default; values are re-asserted |
| Automatic Restart Sign-On vs automatic sign-in | Precedence is undocumented **(unverified)** | Machine policy disables it; locked-console rule as the safety net |
| Convex Rust client | One-shot calls hang offline; no proxy; auth callback failure reconnects without auth; next release (0.11) will break the error API | Timeouts on every call; device auth does not use the auth callback; version pinned |
| Convex free tier | 1,000 concurrent sessions, 16 concurrent queries/mutations, 1,000,000 calls a month | One subscription, fixed 5-minute heartbeat, reconnect jitter, write-on-change |
| Unsigned binaries | Smart App Control and S mode block them; antivirus may flag account creation and Winlogon edits | S mode is a blocker; signing is Phase 6; record VM observations |
| Failure-actions flag | Microsoft's page says the non-crash failure flag "takes effect the next time the system is started" **(unverified on current builds)** | VM checklist restarts before the crash tests |
| Windows servicing dates | Windows 11 24H2 Home/Pro reaches end of servicing on 2026-10-13; Windows 10 has been out of support since 2025-10-14 (one unconfirmed report of a consumer ESU extension) | Agent reports build and edition; the judgment is made server-side later |

---

## 14. Open questions for the user

The plan assumes the **recommended** option for each.

| # | Question | Options | Recommendation and reason |
|---|---|---|---|
| Q1 | How does a device authenticate to Convex? | (a) Device secret passed as an argument to each device function, checked against a hash. (b) Short-lived JWT minted by a Convex HTTP action, `customJwt` provider, `set_auth_callback` | **(a) for Phase 2.** It needs no key management and no `auth.config.ts` before Phase 4 designs Convex Auth, and it avoids two things research could not verify: what Convex does when a JWT expires on an open socket, and ES256 signing inside an HTTP action. The seam (`DeviceAuth`, `requireDevice`) keeps a later move to (b) contained |
| Q2 | `convex/schema.ts` keeps `status` and `lastSeen` inside `devices`, which contradicts PRD 11.1 rule 4 and CLAUDE.md | (a) Remove them now and add the `deviceStatus` table. (b) Leave them and defer to Phase 4 | **(a).** Phase 2 writes the first heartbeats, and nothing reads those two fields yet |
| Q3 | Convex `organizations.branding` uses `logoUrl`; Rust `Branding` uses `logo` (PRD Section 10 says `logo`) | (a) Fix in Phase 4 with the dashboard. (b) Fix now | **(a).** Phase 2 does not read branding |
| Q4 | Windows user name of the Staff account (PRD does not name it) | (a) `RuleboxStaff`, shown as "Staff". (b) `Staff` | **(a).** A small business may already have a user called "Staff"; the agent must never adopt an account it did not create |
| Q5 | What does "Disable kiosk" do on Windows? (PRD defines it only for Android) | (a) Stop automatic sign-in, restore original Winlogon values, give Staff the Explorer shell back, sign the Staff session out after a 10-second warning, keep the account and files. (b) Also disable or delete the account | **(a).** It is fully reversible and loses no employee files |
| Q6 | Domain-joined or Entra-joined PCs | (a) Block enrollment unless `--allow-joined`. (b) Allow with a warning | **(a).** Management policy is reported to strip automatic sign-in, and the Staff account would dead-end |
| Q7 | Automatic Restart Sign-On is switched off machine-wide while kiosk is enabled (restored on disable). It also stops the **owner's** account from being signed back in after update restarts | (a) Accept. (b) Rely on the locked-console rule only | **(a).** The documented switch is the reliable one |
| Q8 | Who relaunches a crashed Staff App? PRD 23.7 says the agent | (a) `rulebox-shell.exe` stays alive and relaunches it; the agent supervises the launcher and kills hangs. (b) Agent only, as written | **(a).** Faster, needs no token handling, and the kiosk survives an agent outage or the boot race. Phase 2 therefore owns `rulebox-shell.exe` |
| Q9 | Minimum Convex Rust client | (a) 0.10.4. (b) keep 0.10.3 | **(a).** It fixes a subscription memory leak, which matters for a process that holds one subscription for months |
| Q10 | Minimum supported Windows build (PRD 13.6 #4 asks for one) | (a) Block below Windows 10 22H2 (19045); report "out of support" as a warning decided server-side. (b) Block every out-of-support build | **(a).** Many target 4 GB laptops run Windows 10; the PRD asks for a flag and a badge, not a refusal |
| Q11 | Device revoked on the backend | (a) Stop syncing, keep the current kiosk state. (b) Disable kiosk automatically | **(a).** A remote revocation, or a compromised backend, should never unlock a PC |
| Q12 | Right after enrollment, before any desired state exists | (a) Kiosk on (PRD 9.1 step 5). (b) Kiosk off until the dashboard says on | **(a).** It matches the PRD flow. Note for testing: enrolling a VM locks it at the next restart |
| Q13 | Where does the Staff App get the Convex URL? Phase 1 bakes `VITE_CONVEX_URL` in at build time, but PRD 15 wants one generic installer with the URL in the enrollment code | (a) From the agent snapshot (`convexUrl`). (b) Keep it baked in | **(a).** Phase 2 only exposes the field; Phase 3 decides how to use it |
| Q14 | Crash-loop fallback | (a) Native "Contact your administrator" screen (PRD 13.6 #3). (b) Drop to Explorer | **(a).** (b) would silently un-kiosk the PC |
| Q15 | Which VMs can you provide for Step 14? | Windows 11 Pro (required); Windows 11 Home; Windows 10 22H2 | Pro **and** Home. Home is where the shell mechanism is unverified |
| Q16 | Policy signing is v1 (Decision 15) but the phase index puts it in Phase 4 | (a) Phase 2 carries a `signature` field and accepts unsigned documents with a logged warning. (b) Build verification now | **(a).** The signing side and key distribution do not exist until Phase 4 |

---

## 15. PRD changes to propose

Do not edit the PRD in this phase; give this list to the user.

| PRD section | Proposed change | Reason |
|---|---|---|
| 23.7, 13.6 #3 | The registered shell `rulebox-shell.exe` stays alive and relaunches the Staff App; the agent supervises the launcher and terminates a hung Staff App. The launcher draws the "Contact your administrator" screen | Works when the agent is down or late (boot race, Fast Startup); no token handling for the common case; also settles "agent has no UI" (3.2) versus "native screen" (13.6 #3) |
| 13.5 (automatic sign-in) | Name the mechanism: Winlogon `AutoAdminLogon`/`DefaultUserName`/`DefaultDomainName` plus LSA secret `DefaultPassword`; never `AutoLogonCount`, `IgnoreShiftOverride`, plaintext `DefaultPassword`; the Shift bypass is kept on purpose as an admin escape; password repair uses a reset and accepts the loss of the Staff profile's DPAPI data in that rare case | Fills a gap; records the safety rules |
| 13.2 | Replace "Custom shell per user (registry): Home = Verify" with the VM result, and name the value (`Policies\System\Shell` in the user's hive, fallback per-user `Winlogon\Shell`). Add a row: Assigned Access — Pro and above, UWP/Edge only, not usable for a Win32 shell | Research confirmed Shell Launcher is still Enterprise/Education/IoT only |
| 13.6 (new rows) | Add: Automatic Restart Sign-On locking the kiosk account; sign-in legal notice blocks automatic sign-in; Exchange ActiveSync policy disables it; management policy removes it on joined devices; Smart App Control and S mode block unsigned binaries; Fast Startup means the service is resumed, not started; `windows` crate 0.100 renames everything; Convex Rust client has no proxy support and its one-shot calls hang offline | Found by research; each has a handling in this plan |
| 13.6 #5 | Minimum Convex Rust client 0.10.4 | Subscription memory leak fix |
| 9.5 | Define "Disable kiosk" on Windows (Q5). Add two documented routes: hold Shift at sign-in, and `rulebox-agent recover` | PRD defines this only for Android |
| 15, 12.3 | Define the enrollment code (`RBX1.` + base64url of URL and a 100-bit token; server stores a hash; single-use, 60 minutes by default) and the device credential (device-generated 256-bit secret, hash stored server-side) | Gap |
| 3.3 | State that the Staff App takes the Convex URL from the agent on enrolled devices | Generic installer versus build-time URL |
| 11 | Note that `nextPingIn` is a fixed 5 minutes until Phase 4. Resolve rule 5 ("write only on change") versus 22.6 ("memory and CPU with the regular heartbeat"): report coarse buckets or only threshold crossings | Contradiction |
| 14 | State that the agent (shared code) performs the compatibility detection and sends it at enrollment; the installer reuses it. List the blockers of Section 5.5 | Gap: installer is Phase 6, enrollment is Phase 2 |
| 13.6 #4 | Minimum supported build 19045; "out of support" is judged on the server from the reported build | Lifecycle dates change |
| 16 | "App updates: Tauri updater + GitHub Releases" contradicts 23.2 | Wording only |
| New | Add the account name `RuleboxStaff`, service name `RuleboxAgent`, pipe names and data directory to the PRD | Gap |
| 12.4 (1.1) | State that the **agent** checks the PIN and that the Staff App never holds the hash; PIN is 4 to 12 digits (dashboard asks for at least 6); the lock schedule (5th wrong PIN: 1 minute, then 5, 15, 30, 60 minutes, per device, kept across restarts); a correct PIN grants no admin right, it only leads to the Windows sign-in screen; automatic sign-in is paused for at most 5 minutes and the kiosk returns at the next restart; the exit is also offered on the "Rulebox can't start" screen | Fills in the numbers and the owner PRD 12.4 leaves open |
| 5.2 (1.1) | Name the offline hash (Argon2id), the lock schedule for employee passwords (5th wrong: 30 seconds, then 1, 5, 15 minutes) and that the agent, not the Staff App, checks credentials | Gap |
| 9.5 (1.1) | Add `rulebox-agent recover` and `unenroll` as the administrator-session tools, and note that the hidden exit needs the agent to be running | Recovery routes |

Also note for the Phase 1 plan (historical): it says `#[ts(export,
export_to = …)]` and Geist fonts; the repository uses `TS_RS_EXPORT_DIR`
and Figtree. No action needed.

---

## 16. Sources

Windows service and Rust crates
- https://crates.io/crates/windows · https://docs.rs/windows/0.62.2
- https://github.com/microsoft/windows-rs/releases · https://github.com/microsoft/windows-rs/issues/4867 · https://github.com/microsoft/windows-rs/issues/4850
- https://crates.io/crates/windows-service · https://docs.rs/windows-service/0.8.1 · https://github.com/mullvad/windows-service-rs/blob/main/CHANGELOG.md
- https://github.com/mullvad/windows-service-rs/blob/main/examples/ping_service.rs · https://github.com/mullvad/windows-service-rs/blob/main/examples/uninstall_service.rs
- https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsw
- https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actions_flag
- https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_delayed_auto_start_info
- https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nc-winsvc-lphandler_function_ex
- https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-deleteservice
- https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change
- https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw
- https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createenvironmentblock
- https://crates.io/crates/tokio · https://github.com/tokio-rs/tokio#bug-patching-policy · https://crates.io/crates/tokio-util
- https://docs.rs/tracing-appender/0.2.5 · https://github.com/tokio-rs/tracing/blob/main/tracing-appender/CHANGELOG.md

Accounts, automatic sign-in, shell
- https://learn.microsoft.com/en-us/windows/win32/api/lmaccess/nf-lmaccess-netuseradd
- https://learn.microsoft.com/en-us/windows/win32/api/lmaccess/nf-lmaccess-netlocalgroupaddmembers
- https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createprofile
- https://learn.microsoft.com/en-us/troubleshoot/windows-server/user-profiles-and-logon/turn-on-automatic-logon
- https://learn.microsoft.com/en-us/windows/win32/secauthn/protecting-the-automatic-logon-password
- https://learn.microsoft.com/en-us/windows/win32/secauthn/msgina-dll-features
- https://learn.microsoft.com/en-us/sysinternals/downloads/autologon
- https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/component-updates/winlogon-automatic-restart-sign-on--arso-
- https://learn.microsoft.com/en-us/answers/questions/2287239/ (24H2 automatic sign-in resets; user reports)
- https://learn.microsoft.com/en-us/windows/configuration/shell-launcher/ · https://learn.microsoft.com/en-us/windows/configuration/shell-launcher/configure
- https://learn.microsoft.com/en-us/windows/configuration/assigned-access/overview · https://learn.microsoft.com/en-us/windows/configuration/assigned-access/policy-settings
- https://learn.microsoft.com/en-us/windows/configuration/keyboard-filter/
- https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-admx-winlogon
- https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-privacy
- https://learn.microsoft.com/en-us/archive/msdn-technet-forums/05b5d328-f221-4020-8645-84eb39ab4351 (per-user shell value; forum)
- https://learn.microsoft.com/en-ie/answers/questions/1255667/ (Shell Launcher licence error on Pro)
- https://learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/
- https://learn.microsoft.com/en-us/defender-endpoint/tamper-protection-overview
- https://learn.microsoft.com/en-us/lifecycle/products/windows-11-home-and-pro

IPC and backend
- https://docs.rs/tokio/latest/tokio/net/windows/named_pipe/struct.ServerOptions.html
- https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights
- https://learn.microsoft.com/en-us/windows/win32/secmgmt/private-data-object
- https://crates.io/crates/convex · https://docs.rs/convex/0.10.4/convex/struct.ConvexClient.html · https://docs.rs/convex/0.10.4/convex/struct.ConvexClientBuilder.html
- https://raw.githubusercontent.com/get-convex/convex-rs/main/CHANGELOG.md
- https://github.com/get-convex/convex-rs/issues/9 · /11 · /14
- https://docs.convex.dev/production/state/limits · https://docs.convex.dev/functions/http-actions · https://docs.convex.dev/auth/advanced/custom-jwt
- https://github.com/Aleph-Alpha/ts-rs/releases

### Could not be verified (carried into the plan as such)

- Whether either per-user shell value is honoured on Windows 11 Home, and
  what Winlogon does when the shell value points to a missing file.
- Behaviour of automatic sign-in and a per-user shell in Safe Mode.
- Precedence between Automatic Restart Sign-On and `AutoAdminLogon`.
- Whether `DisablePrivacyExperience` works on Home, and whether first-run
  screens appear at all without Explorer.
- Whether a pipe client opened with `GENERIC_WRITE` is accepted by an
  entry without bit `0x4` (the plan avoids the question by opening with
  explicit rights).
- Whether Convex records function arguments in logs; the definition of a
  "session" in the free-tier limit; whether `CONVEX_CLOUD_URL` is defined
  inside functions; an existing JSON conversion on `convex::Value`.
- Whether the non-crash failure-actions flag needs a restart to take
  effect on current builds.
- The full privilege list the service needs (left unrestricted in
  Phase 2).
- Windows 10 consumer ESU extension and the Windows 11 26H2 release date
  (single secondary sources).
