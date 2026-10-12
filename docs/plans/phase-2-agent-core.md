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

- **Open questions (Section 14):** the user answered them; see the table in
  `docs/plans/README.md`. Every Phase 2 answer matches this plan's
  recommendation, so no step changes.
- **Ctrl + Alt + Del is no longer an admin route** (PRD 9.5, 12, 12.4).
  Phase 5 will empty that screen for the Staff account, including Switch
  user. The routes to admin are the hidden exit (Staff App, Phase 3) and
  holding Shift during startup. In Phase 2 itself Switch user still works,
  so the "Disconnected session" handling and VM checklist item stay, but
  never show or document it as the way out: edge-case rows 26 and 27 should
  list Shift at startup, `recover`, `unenroll` and Disable kiosk only. The
  launcher fallback text in Step 12 is already corrected.
- **Protocol 1.1 addendum (not written yet):** Phase 3 needs extra agent
  requests (`session.*`, `apps.list`, `adminExit.submit`), PIN checking in
  the agent, and the hidden exit offered on the launcher fallback screen.
  They are listed in Section 15 of `phase-3-staff-shell.md` (R1 to R11).
  They are additive: build contract 1.0 exactly as written in Steps 0 to 5.
  The addendum must be written before Step 6 is started.

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

On the **dev machine** everything except the real Win32 side effects is
built, unit-tested and runnable in `--simulate` mode, including a working
IPC endpoint that Phase 3 can develop against.

## 2. Non-goals (do NOT build in Phase 2)

| Not in Phase 2 | Belongs to |
|---|---|
| Staff App UI, Tauri commands, window tracking, employee sign-in | Phase 3 |
| Dashboard screens, Convex Auth, groups/employees/apps UI, merging group and device desired state, rollout rings, **policy signing and verification**, audit log, fleet-size-based heartbeat interval | Phase 4 |
| App install/update/remove, winget, file handlers, session cleanup on employee logout, storage quotas | Phase 4 |
| Lockdown policies for the Staff account (Task Manager, Win keys, Ctrl+Alt+Del options, `NoLogoff`, USB), App Control, the **process allow-list watchdog** (PRD 13.6 #2), hidden admin exit + PIN (PRD 12.4), hiding the admin tile, account lockout policy, device lock, broadcasts, Wi-Fi and printers, per-user tuning (PRD 22.2), kiosk performance profile (PRD 22.3), restricting the service's privileges | Phase 5 |
| MSI/WiX, installer UI, WebView2 bootstrap, code signing, how release builds satisfy the test-machine guard | Phase 6 |
| Agent self-update, Staff App update flow and version rollback (PRD 23.4, 23.9), Windows Update policy, Windows Event Log output | v1.x / later |
| Periodic rotation of the Staff password | later (the repair path in Step 10 is enough for v1) |

Phase 2 builds **seams** for three of these and nothing more: a
`signature` field carried next to the desired state (always `null` now),
`current.json` with one version entry, and reserved IPC method namespaces.

---

## 3. Prerequisites

### 3.1 Reading list (read these, in this order)

- `CLAUDE.md` (all of it).
- `docs/plans/phase-1-setup.md`, Steps 3, 4 and 7, to know what exists.
- `docs/prd.md` — only these sections: 3.2, 3.3, 5.1, 9.1, 9.4, 9.5, 10,
  11, 11.1, 12.1–12.3, 13.2, 13.5, 13.6 (rows 3, 4, 5, 8), 14, 15, 21,
  22.4, 22.5, 23.3, 23.7. Section 21 is locked: never re-open a decision.
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
| `apps/shell-launcher/` | `rulebox-shell` | bin (new) | `rulebox-shell.exe`: the registered shell; starts and relaunches the Staff App; native fallback screen |
| `convex/` | — | TS | Enrollment, device auth, desired-state query, heartbeat, dev helpers |

`apps/shell-launcher` is covered by neither existing workspace glob, so
it is added to `members` explicitly.

Only `rulebox-win32` and `rulebox-shell` may depend on the `windows`
crate. Reason: `windows` 0.100 will rename every feature and module
(Section 13), so the migration must stay in one place.

```
crates/rulebox-ipc/
├─ Cargo.toml
├─ src/
│  ├─ lib.rs          # re-exports; PROTOCOL_MAJOR/MINOR; pipe names; limits
│  ├─ envelope.rs     # Frame, RpcError, ErrorCode
│  ├─ methods.rs      # Method trait + one unit struct per method
│  ├─ types.rs        # Hello*, AgentSnapshot and its parts (ts-rs export)
│  ├─ admin.rs        # admin-pipe params/results (not exported to TS)
│  ├─ codec.rs        # length-delimited JSON codec
│  ├─ client.rs       # feature "client": IpcClient (connect, verify, call, events, reconnect)
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
   ├─ ipc_shell.rs    # shell-pipe server
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
   └─ fallback.rs     # native "Contact your administrator" window

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

Notes:

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
- **Startup check.** Before reading or writing, the agent verifies the
  data directory is a real directory (not a reparse point), is owned by
  SYSTEM or Administrators, and has the protected DACL. If not, it fixes
  the DACL when the directory is empty and otherwise refuses to start with
  a clear log line. Reason: standard users may create folders under
  `%ProgramData%` and could plant one first.

### 5.2 Tasks inside the service

`agent::run(deps, shutdown: CancellationToken, control_rx)` starts these
tokio tasks and is the single entry point for both service mode and
console mode:

| Task | Owns | Triggered by |
|---|---|---|
| `backend` | Convex client, subscription, heartbeat timer | enrollment state, connection state |
| `reconciler` | all kiosk changes (the only task that calls mutating `Platform` methods) | `Trigger` channel: `Startup`, `DesiredChanged`, `Session`, `Power`, `Reassert` (every 10 minutes), `Admin` |
| `watchdog` | launcher presence, hang detection | session events, 5-second tick while kiosk is enabled, shell heartbeats |
| `ipc_shell` | shell pipe | Staff SID known |
| `ipc_admin` | admin pipe | always |

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
it so nothing else mutates the machine at the same time):

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
   path; never assume `C:\Users\RuleboxStaff`.
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
`Disconnected` (the admin used Switch user), leave it alone. This covers
Automatic Restart Sign-On locking the session after an update restart.

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

---

## 6. The agent↔shell IPC contract (version 1.0)

This section is the **only** interface between Phase 2 and Phase 3. The
Rust types live in `crates/rulebox-ipc`; the TypeScript types are
generated into `packages/types/src/generated/`. Changing anything here
after Step 6 is done requires telling the user, because Phase 3 builds
against it in parallel.

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
   image must be inside `<install>\versions\`. This is defence in depth
   only: any process running as Staff could inject into the Staff App.
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

`rulebox-ipc`'s `IpcClient` does both. Phase 3 must use `IpcClient` and
not open the pipe itself.

**Simulate mode** (development only): the agent started with
`--simulate` serves `\\.\pipe\dev.rulebox.agent.shell.sim`, grants the
**current user** instead of the Staff SID, skips checks 2 and 3, and the
client accepts the current user as pipe owner. `IpcClient` uses the
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
  `session.*` (employee logout cleanup), `apps.*`, `files.*`,
  `adminExit.*`, `update.*`, `net.*`, `power.*`, `device.*`. Adding a
  namespace is a minor bump plus a new capability string.

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

`ErrorCode` serializes as the snake_case strings above and has
`#[serde(other)] Internal`.

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

---

## 7. Steps

General rules for every step:

- Verification uses the touched crate only, for example
  `cargo clippy -p rulebox-ipc --all-targets -- -D warnings` and
  `cargo test -p rulebox-ipc`. Run the workspace-wide commands only in
  Step 15.
- **Never** run `cargo build --release`, `tauri build`, a test marked
  `#[ignore]`, or any `rulebox-agent` subcommand other than `compat`,
  `status --simulate` and `run --console --simulate` on the dev machine.
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

### Step 6 — IPC servers in the agent (unblocks Phase 3)

Files: `ipc_shell.rs`, `ipc_admin.rs`, and wiring in `agent.rs`.

- `ipc_shell::serve(listener_factory, snapshot_rx, health_tx, shutdown)`:
  accept loop; one task per connection; enforces the `hello` deadline,
  peer verification (Section 6.2; in simulate mode only the SID check,
  against the current user), `MAX_IN_FLIGHT`, and the outbound queue with
  coalescing. Dispatch table by method name; unknown names return
  `unknown_method`. `shell.ready` and `shell.heartbeat` send
  `ShellSignal::{Ready, Heartbeat}(connection id, pid)` to the watchdog
  channel. Every change of the `watch` snapshot becomes a `state.changed`
  event.
- The shell listener is (re)created whenever the Staff SID becomes known
  or changes, and dropped when it becomes unknown.
- `ipc_admin::serve(...)`: same framing and envelope on the admin pipe.
  Verification: `token_is_elevated_admin` must be true (the pipe DACL
  already excludes everyone else; this is the second check). Methods:
  `admin.status`, `admin.enroll`, `admin.unenroll`. `admin.enroll` and
  `admin.unenroll` return `not_implemented`-style `internal` errors with
  message "available after Step 8/9" until those steps land. Only one
  `admin.enroll` or `admin.unenroll` runs at a time; a second gets `busy`.
- CLI side: `status`, `enroll`, `unenroll` connect with a small
  synchronous-looking client (a current-thread tokio runtime), 150-second
  timeout for `enroll`, 10 seconds otherwise. Pipe not found → print
  "The Rulebox Agent service is not running." and exit with code 2.
  `status` prints the snapshot as text, or JSON with `--json`.

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

Manual check on the dev machine (two terminals):

```powershell
cargo run -p rulebox-agent -- run --console --simulate
$env:RULEBOX_AGENT_SIM = "1"; cargo run -p rulebox-ipc --example fake_staff --features client
cargo run -p rulebox-agent -- status --simulate
```

**Done when:** tests pass; `fake_staff` prints `Linked`, a snapshot with
`"enrollment":"notEnrolled"` and `"displayMode"`, and the agent log shows
heartbeats; `status --simulate` prints the same snapshot. **Tell the user
that the IPC contract is ready for Phase 3.**

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
prints `already_enrolled`; a second device enrolling with the same
single-use code gets `token_used_up`.

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
2. In `service_main`: create the `CancellationToken` and an unbounded
   channel; `service_control_handler::register` with a closure that only
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
- Create the data directory with the protected DACL, then start the
  service.
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
   unless `--yes`.
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
journal.

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
(for `to_wide`, `OwnedHandle`), `serde`, `serde_json`. **No tokio, no
WebView, no network.** Add `#![windows_subsystem = "windows"]`.

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

The launcher needs no IPC: the agent learns the shell's health from the
Staff App's `shell.ready` and heartbeats.

Unit tests: `resolve` for a good file, an absolute path, `..`, a path
outside `versions\`, bad JSON, a missing exe (use a temp directory);
`CrashTracker` sequences: `0,0,0` → always `RestartNow`; five `1`s in
10 s → `Fallback` on the fifth; four `1`s, 61 s pause, one `1` → not
`Fallback`; delays are 500 ms, 1 s, 2 s, 5 s.

**Verify:** `cargo clippy -p rulebox-shell --all-targets -- -D warnings`,
`cargo test -p rulebox-shell`.

Optional look at the fallback window on the dev machine (harmless: it is
only a window): build, then run `target\debug\rulebox-shell.exe` from a
folder with **no** `current.json`. The fallback window must appear; close
it with Alt+F4 (add that for debug builds only) and take a screenshot for
the report. Kill the process afterwards.

**Done when:** tests pass and the fallback window has been seen.

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
   `%ProgramFiles%\Rulebox\`, and `fake_staff.exe` to
   `versions\0.0.0-dev\rulebox-staff.exe`.
4. Writes `current.json` (Section 4.3).
5. Runs `rulebox-agent.exe service install`.

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
   `apps/shell-launcher`; no `windows::` import outside those two; no
   `.filter(` or `.collect()` in `convex/`; every `DESTRUCTIVE` function
   calls the guard on its first line.
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
- Open questions for the user.

## Stop and ask the user if

- a prerequisite is missing, or free disk space is below 8 GB;
- `guard::is_test_machine()` is true on the machine you are working on,
  or a `RuleboxStaff` account exists there;
- a step's **Done when** check still fails after 2 honest fix attempts;
- you want to add a dependency not named in Section 4.4, or a newer
  minor/major of one of the pinned crates exists;
- the build starts compiling OpenSSL;
- you need to change anything in Section 6 after Step 6 is done;
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
| 19 | Admin uses Ctrl+Alt+Del → Switch user | Staff session becomes `Disconnected`; the agent leaves it alone; watchdog pauses for that session | 9, 13 |
| 20 | Service starts **after** automatic sign-in (boot race, Fast Startup resume) | Never rely on logon events; enumerate sessions at start and after each event; the launcher was started by Winlogon and needs no agent | 11, 13 |
| 21 | Staff App crashes | Launcher relaunches after 500 ms (within the PRD's ~2 s) | 12 |
| 22 | Staff App crash loop (5 in 60 s), or `current.json` / exe missing or invalid | Native fallback screen with "Try again"; retry every 30 s; agent reports `shell.health` `unhealthy`/`failed` in the next heartbeat | 12, 13 |
| 23 | Staff App hangs (no heartbeat for 30 s after being ready) | Agent terminates the verified process once per 60 s; launcher relaunches it | 13 |
| 24 | Launcher itself dies | Agent relaunches it in the Staff session after 3 s; 5 failures → `failed`, retry every 30 s | 13 |
| 25 | Agent crashes or panics | Process ends without a clean stop; service manager restarts it after 1 s, 5 s, 30 s; the shell keeps running; the restarted agent finds it again | 5, 11 |
| 26 | Agent permanently broken or deleted | PC still works: launcher and Staff App run without it (Staff App shows "agent unavailable"); admin signs in through Switch user or Shift at sign-in and runs `recover` | 11, 12 |
| 27 | Admin needs normal Windows now | Any of: Ctrl+Alt+Del → Switch user; hold Shift during sign-out/boot to skip auto sign-in; `kioskEnabled: false` from the backend; `rulebox-agent unenroll`; `rulebox-agent recover` | 9, 11 |
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
| 38 | Data directory was pre-created by a standard user, or is a reparse point | Agent refuses to start and logs why | 5 |
| 39 | State file corrupt | Renamed aside, treated as missing; the kiosk settings already on the machine stay; `recover` handles the no-state case | 5, 11 |
| 40 | Service removed while kiosk is on | `service uninstall` refuses unless `--force`, which runs `recover` first | 11 |
| 41 | "Service marked for deletion" on reinstall | Reinstall updates the existing service instead of recreating; error 1072 gives a clear instruction | 11 |
| 42 | Antivirus or SmartScreen blocks the unsigned agent, or flags account creation and Winlogon edits | Not solvable in Phase 2 (signing is Phase 6). Record it in the VM run; report `Access denied`-style failures clearly | 14 |
| 43 | Convex one-shot call never returns while offline | Every call has a 30 s timeout | 8 |
| 44 | Network requires an explicit proxy | The Convex Rust client has no proxy support: the device stays `offline`. Documented limitation | 8 |
| 45 | First sign-in of the new account shows Windows first-run or privacy screens | `EnableFirstLogonAnimation = 0`, `DisablePrivacyExperience = 1`; verify on the VM (**unverified** on Home) | 9, 14 |
| 46 | Employee signs out of Windows from Ctrl+Alt+Del | Automatic sign-in signs Staff back in. Removing that option is Phase 5 | 9 |

---

## 9. Security notes

- **Least privilege by placement.** The Staff App and the launcher run as
  the standard user and never elevate. Everything privileged is in the
  service. The Phase 2 IPC surface is read-only state plus health
  signals; it contains no method that performs a privileged action on
  request.
- **Never trust the Staff session.** Any process running as Staff can
  open the shell pipe, and could inject into the Staff App. Therefore:
  every method must be safe when called by a hostile Staff-session
  process; all parameters are validated on the agent; the agent never
  executes a path, command line or registry location supplied over IPC.
  The image-path check is defence in depth, never the authorisation.
- **Pipe ACLs.** Explicit security descriptor on every instance; SYSTEM
  as owner; no create-instance right for Staff; network logons denied;
  first-instance flag; remote clients rejected; client connects at
  identification level and checks the owner.
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
  three HKLM keys.
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
      password is known.
- [ ] Marker created by hand (Step 3 commands).
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

**Admin way back**

- [ ] Ctrl+Alt+Del → Switch user → admin signs in normally and sees
      Explorer. Sign out: the Staff session is still there.
- [ ] Hold Shift while signing out of Staff (or at boot): the sign-in
      screen appears instead of automatic sign-in.
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
- **Phase 4** owns: signature verification (the `signature` field and
  the startup warning mark the seam), merging group and device desired
  state, heartbeat interval scaling, the dashboard for enrollment codes
  (replacing `convex/dev.ts`), the audit log, and a decision on moving
  device auth to JWT (Q1).
- **Phase 5** owns: Staff lockdown policies (`NoLogoff`, Task Manager,
  Win keys), hiding the admin tile, the admin exit and PIN, wake-password
  and sleep behaviour, restricting service privileges, the process
  allow-list watchdog.
- **Phase 6** owns: the MSI (registering the service the same way as
  Step 11), the release answer to the test-machine guard, code signing,
  and reusing `compat.rs` for the installer check.

---

## 13. Known risks from research

| Risk | Detail | Handling |
|---|---|---|
| `windows` crate 0.100 migration | `windows-core` and related crates are already 0.100 (2026-09-03); the `windows` and `windows-sys` crates are still 0.62.2 / 0.61.2. When 0.100 lands, every `Win32_*` feature and module path is renamed and signatures change | All `windows` usage is confined to two crates. Stay on 0.62. Do not add 0.100 sub-crates |
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
