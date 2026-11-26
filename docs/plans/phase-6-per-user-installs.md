# Phase 6 add-on: per-user installers (Staff-account install mode)

> **Status 2026-11-26 (updated by the implementing agent):** **Tier A is built on the dev PC** (PU-2 Tier A part, PU-3):
> the `{InstallDir}` silent-argument token (NSIS `/D=` last, raw; Inno `/DIR=`), the shape and root rules in
> `rulebox-policy` (`check_install_dir_args`), the same rules on the server and in the dashboard form, the agent expansion
> with a raw NSIS tail, tests (unit and SimPlatform only; **never run on the VM**). Recommended options taken for every
> Section 15 question: Q-PU1 (a) in principle, Q-PU2 (a) **Tier A only now**, Tier B (Staff-account install, PU-4 to PU-8)
> **not built** until S-13 on the VM shows whether `Zahras POS Dev` honours `/D=` and the owner has a per-user-only app that
> does not; Q-PU2b (a), Q-PU3 (a), Q-PU4 (a), Q-PU5 (a), Q-PU6 (a), Q-PU7 (a), Q-PU8 (a), Q-PU9 (a), Q-PU10 (a), Q-PU11
> (a), Q-PU13 (a); Q-PU12 (doc sync of Section 14) is **not done**. Tier A adds no new `detail` value and no Convex function,
> table or index. Left for the VM: PU-0 row S-13 and checks PU-A1, PU-A2 (Section 10).
>
> **Original note:** this is a **plan only**, written 2026-11-25.
> Nothing in it was compiled or run. It adds to `docs/plans/phase-6-installer-pilot.md`
> (the "parent plan") and must not start before the owner answers Section 15.
> Read `CLAUDE.md`, then the parent plan Sections 4.4, 4.6, 4.7, edge cases 30, 31,
> 77, 78 and risk 78, then Phase 5 Sections 4.6, 4.9, 4.10 and edge cases 12, 13, 48.
> One step = one commit (`Phase 6 step PU-n: <what>`), made only when the user says so.
> Everything that changes Windows (accounts, tokens, AppLocker, ACLs, installers) runs
> on the VM or test PC, and only the user runs it.
>
> Items marked **(unverified)** could not be confirmed from the repository or the
> VM results. Each says which spike row settles it.

## 0. Summary and recommendation

**The problem.** Some vendor installers can only install for "the current user"
(NSIS or Inno with `asInvoker`, no machine-wide mode). The agent runs every
installer as SYSTEM, so such an app lands in SYSTEM's own profile and the agent
reports `installed_per_user` (observed 2026-11-25 with `Zahras POS Dev 1.0.2`,
an unsigned 32-bit Tauri NSIS installer: files in
`C:\Windows\SysWOW64\config\systemprofile\AppData\Local\Zahras POS Dev`, uninstall
entry in `HKU\.DEFAULT` with a wrong `system32` path; `/ALLUSERS` is ignored).

**The owner's idea** (`installScope: "perUser"`, the agent runs the installer inside
the Staff account) is **feasible but is the most expensive of four ways** to solve
this, and it **reverses a locked non-goal** of the parent plan (Section 2 row "Per-user
installs or per-user self-update (AppData). Staff can write there: never"). It also
puts a program in a folder the Staff account can write to, which Phase 5 forbids for
path rules (edge case 13) and treats as a residual risk for hash rules (E-33).

**Recommended design, in two tiers (build A first, B behind a spike):**

1. **Tier A: "install folder override" (cheap, keeps every security property).**
   Run the installer exactly as today (SYSTEM, session 0, no window) but pass the
   installer's own install-folder switch, so it writes to an admin-only folder
   (`/D=C:\Program Files\<Product>` for NSIS, `/DIR="..."` for Inno). The program ends
   up under `{ProgramFiles}`, where today's path rule, Pinned/Managed update modes and
   removal already work. A new silent-argument token `{InstallDir}` carries the folder.
   **Spike S-13 decides whether `Zahras POS Dev 1.0.2` honours `/D=`**; if it does, the
   owner's example is solved with about 2-3 days of work and no new risk.
2. **Tier B: "Staff-account install" (the owner's idea, hardened).** `install.scope:
   "staff"`. The agent runs the installer **with the Staff account's own non-elevated
   token, re-homed into session 0** (no window can ever appear in the Staff session, no
   UAC), then **locks the installed folder read-only for Staff**, hashes every `.exe`
   in it, and gives the Staff SID an AppLocker **hash rule** (unsigned apps) or the
   existing **publisher rule** (signed apps). Pinned, Managed (rollback) and Vendor
   modes all work. Removal deletes the tree.
3. **Not recommended: a dedicated "install account"** (install as a third local user
   that Staff may only read/execute). Strong, but it adds an account with an
   allow-everything AppLocker rule and a stored password, and HKCU-based settings
   would not reach Staff. Kept in Section 4.1 for completeness.

> [!IMPORTANT]
> Owner decisions are in Section 15 (14 questions with recommendations). The two that
> block everything: **Q-PU1** (may Phase 6 reverse the "per-user installs: never"
> non-goal at all?) and **Q-PU2** (build Tier A only, or A and B?).

> [!WARNING]
> Top risks (details in Section 12): (1) AppLocker's `FileHash` for an `.exe` is the
> Authenticode hash, not the plain SHA-256, and Phase 5's existing `Hash` exceptions
> compile the plain one (S-17 must show whether they ever match); (2) a Staff-token
> process is checked against the Staff AppLocker rules, so the installer and any child
> `.exe` it starts from `%TEMP%` (Inno's `.tmp` copy) can be blocked (S-15); (3) the
> install tree is Staff-writable until it is locked, and the DLL collection is off, so
> an allowed unsigned `.exe` could load a planted DLL (E-33 class); (4) the policy
> refresh after an install is slow or unknown on Windows Pro (CSP), so a tile may be
> unusable for a while; (5) re-homing a token into session 0 and loading the profile are
> **unverified** on this build.

## 1. Goal and non-goals

**Goal.** An admin marks an app "installs for the Staff account only"; the agent
installs, updates, rolls back and removes it there; the Staff App launches it like any
other tile; nothing ever shows a window or UAC prompt in the Staff session; every
program that may start for Staff is still named by a signed document and verified by
hash or publisher.

**Non-goals (not in this add-on):**

| Not here | Why / where |
|---|---|
| Per-employee installs (each employee their own copy) | Employees share one Windows account (Decision 13); per-user means per **Staff account**. HKCU and AppData are shared by all employees in either scope |
| Per-user MSI, MSIX, Squirrel/ClickOnce bootstrappers, portable zips | MSI: `msiexec` is on the Staff deny list. The others are already v1.x in the parent plan |
| Letting Staff install anything | Never. The admin catalogues an app; the agent installs it |
| A vendor-supplied uninstaller run by Rulebox | Q-PU6 (recommended: delete the tree instead) |
| winget per-user-only apps (`Scope: user`, e.g. Spotify) | Possible later on top of this mode (Q-PU8) |
| App Control (WDAC) `allowlist` level with per-user apps | Refused with the existing `allowlist_level_with_user_install` |
| Changing the `desktop.exe` template grammar for machine apps | Unchanged |

## 2. What exists today (checked in the code on 2026-11-25)

| Area | State | Anchor |
|---|---|---|
| Installers run as SYSTEM, session 0, no window | `WindowsPlatform::run_installer`: `std::process::Command`, `CREATE_NO_WINDOW`, `CREATE_SUSPENDED`, kill-on-close job, own TEMP/TMP, NUL std handles | `apps/agent/src/platform/windows.rs:423` |
| What may be started | `System32\msiexec.exe`, `System32\pnputil.exe` (two fixed shapes), or `<downloads>\<sha256>.exe\|.msi` | `apps/agent/src/installs/mod.rs:268`, `:309` |
| Wait, timeout, `needs_interaction` | `wait_for_installer` over a `RunningInstaller` trait (CPU sample five minutes before the timeout, visible window on the service desktop, job kill) | `installs/mod.rs:576`, `:538` |
| Per-user detection (SYSTEM) | `installed_per_user`: file with the program's name below `System32\config\systemprofile\AppData` or the `SysWOW64` twin, depth 4 | `installs/engine.rs:1986`, `installs/probe.rs:51`, `platform/mod.rs:464` |
| Per-user detail in both lists | `installed_per_user` is detail 20 of 23 | `installs/mod.rs:190`, `convex/lib/deviceApiRules.ts:139`, `apps/agent/tests/vectors/install-details.json` |
| Dashboard hint | `perUserLikely` = NSIS and `requestedExecutionLevel asInvoker` (heuristic) | `convex/lib/installerDetect.ts:27`, `:371`; banner `AppInstaller.tsx:156`, text `appInstaller.ts:64` |
| Path templates | `expand_exe`: roots `{ProgramFiles}`, `{ProgramFilesX86}`, `{SystemRoot}\System32`, `{RuleboxApps}`; one `*` folder allowed; deny list; no AppData root | `crates/rulebox-policy/src/paths.rs:240` |
| Silent-arg tokens | `{AnswerFile}`, `{LogFile}` only | `paths.rs:351` |
| Token + launch as a user | `launch_in_session`: `WTSQueryUserToken`, refuses an elevated token, `DuplicateTokenEx`, `CreateEnvironmentBlock`, `CreateProcessAsUserW` (no job, no suspend) | `crates/rulebox-win32/src/process.rs:213` |
| Job object | `KillOnCloseJob`: assign, `active_processes`, `cpu_time`, `process_ids`, `has_visible_window` (service desktop only), `terminate` | `crates/rulebox-win32/src/job.rs` |
| Staff account facts | `ensure_profile`, `profile_path` (`ProfileList`), `test_logon` (`LogonUserW`, NETWORK); password in LSA `DefaultPassword` | `crates/rulebox-win32/src/accounts.rs:372`, `:419`, `:442`; `apps/agent/src/kiosk.rs:527-602` |
| Staff hive | `with_user_hive` (uses `HKU\<SID>` if loaded, else mounts `NTUSER.DAT` as `RuleboxStaffTmp`); writes only through `staffreg::ALLOWED_ROOTS` (no `Uninstall` root); read-only `get_loaded_user_value`, `list_loaded_user_value_names` | `registry.rs:442`, `:328`, `:341`; `staffreg.rs:20` |
| Staff `Run` entries | removed one by one by the kiosk performance layer (journalled) | `apps/agent/src/lockdown/perf.rs:45` |
| AppLocker | Collections EXE, MSI, Script, Appx (DLL **off**); Staff rules are path, publisher, **hash** (`FileHashCondition` SHA256, `SourceFileLength="0"`); everyone else allow-all; SYSTEM principals allow-all (S-6: SYSTEM-started programs are not evaluated) | `lockdown/applocker.rs:18`, `:184`, `:239` |
| Allow-list | path rules only for admin-only folders (`writable_by_staff`, `is_user_writable_location` treats `\appdata\` as writable); exceptions: publisher, hash, path; `vendor_exceptions` makes a publisher rule per Vendor app | `lockdown/allowlist.rs:294`, `:324`, `:347`, `:464` |
| Facts feeding the compilers | `machine_facts` (catalogue exe folders, browsers, vendor exceptions) | `lockdown/runtime.rs:240`, `lockdown/invariants.rs:121` |
| Re-apply trigger from the engine | `on_driver_change` -> `reconciler.lockdown_changed()` | `apps/agent/src/agent.rs:634`, `installs/engine.rs:760` |
| App Control `allowlist` level | refused while a catalogue app folder is outside Program Files and Windows | `lockdown/appcontrol.rs:181`, `:203` |
| Process watch | ignores session-0 starts; for Staff starts checks folder rules, signer, and a **plain SHA-256** only for files up to 64 MiB, cached by path + stamp | `lockdown/procwatch.rs:56`, `:396-420` |
| Staff App launch | the Staff App itself starts `desktop.exe` (a catalogue path from the agent) with `CreateProcessW` as Staff; refuses only `.bat`/`.cmd`, relative paths, missing files | `apps/staff-app/src-tauri/src/launcher.rs:36`, `crates/rulebox-desktop/src/launch.rs:91-116` |
| Known folders | Only Documents, Desktop, Downloads are redirected, per employee, at sign-in; **AppData is not** redirected (the agent only detects a redirect: `staff_app_data_redirected`) | `crates/rulebox-desktop/src/known_folders.rs:34`, `platform/mod.rs:367` |
| Session cleanup | deletes `{LocalAppData}\<rel>` folders listed in apps' `resetFolders` at sign-out; `RESET_DENY` protects Windows secrets, `dev.rulebox.staff`, `Rulebox` | `crates/rulebox-policy/src/paths.rs:118`, `apps/agent/src/cleanup.rs` |
| Exe-kind removal | an `exe` app is never "removable" (`remove_when_unassigned && kind != Exe`) | `engine.rs:706` |

**Correction to the brief:** Documents, Desktop and Downloads are redirected (per
employee, only while an employee is signed in); **AppData is not**. A per-user install
therefore writes to the real `C:\Users\RuleboxStaff\AppData\...` unless something else
redirected it, and shortcuts the installer drops on the Desktop land in the employee's
folder if an employee is signed in (hence the apply window in 5.2).

## 3. Hard rules and how this design meets them

| Rule (source) | Design answer |
|---|---|
| Staff App and Staff account have no admin rights; a UAC prompt in the Staff session is a bug (CLAUDE.md) | The installer runs with Staff's own **non-elevated** token (the existing `launch_in_session` elevation refusal is reused) **in session 0**, where no interactive window or consent prompt can be shown. A manifest that demands admin fails at `CreateProcess` (error 740) and is reported `needs_elevation`. **(unverified: S-14)** |
| Every privileged action goes through the agent | Unchanged: token, job, ACL change, policy rewrite are all agent (SYSTEM) work. The Staff App only starts the finished program, as today |
| Installers SHA-256 verified; desired state, not commands; versioned (CLAUDE.md) | Unchanged. The same `install.sha256`, signed document and revision. Only a **verified copy** is staged for the Staff token (5.4) |
| Phase 5 AppLocker: never a path rule under a user-writable folder (edge case 13); no hash rule that breaks silently | Unsigned per-user programs get **hash rules** (never a path rule on the Staff profile); signed ones get the **publisher** rule; the tree is locked so Staff cannot change it (5.7). The one standing path rule is on an **admin-only** staging folder |
| Phase 5 invariants I1-I10 | The new rules are additive allow rules for the Staff SID only; no deny rule; golden-file tests run with and without per-user apps (Step PU-7) |
| Convex free-tier I/O budget (CLAUDE.md) | **No new Convex function, table, index or subscription.** Two optional fields on an existing embedded object, six new values of an existing `detail` string. The agent writes only on change (existing `installResults` upsert). Section 11 |
| 4 GB RAM target | One operation at a time (existing). No extra process stays resident; the profile is not loaded by the service when the Staff session is already up (5.3). Hash set is at most 60 files per app |
| Offline-first; no CDN | Nothing new at runtime |
| Never open executables from Files (PRD 7.3) | Unchanged: the Staff App starts only catalogue ids; the installed tree is not reachable from the Files app |
| Hard rule 5 of the parent plan: "A UAC prompt or any installer window in the Staff session is a bug. Installers run as SYSTEM in session 0" | **Amended** by this add-on for `scope: staff` apps only: the installer runs as the Staff account **but still in session 0**. The rule's intent (nothing visible in the Staff session) is kept; its wording needs the change in Section 14 |

## 4. Design

### 4.1 Options considered

| Option | What runs where | Security | Compatibility | Effort | Verdict |
|---|---|---|---|---|---|
| **A. Install-folder override** | Installer as SYSTEM with `/D=...` / `/DIR=...` into `{ProgramFiles}` | Same as today (admin-only folder, path rule) | Works only if the installer honours the switch (NSIS `/D=`, Inno `/DIR=` normally do; Tauri's NSIS template **(unverified: S-13)**). HKCU-side effects land in SYSTEM's hive (harmless for apps that do not read them). App must not write next to its own exe | S | **Build first** |
| **B. Staff-account install (owner's idea)** | Installer with Staff's token in session 0; files in Staff's profile | Staff-writable tree until locked; hash/publisher identity only; extra moving parts (token, ACL, policy rewrite) | Highest: real HKCU, real `%LOCALAPPDATA%` | L | **Build second, behind spike** |
| C. Install account | Installer as a 3rd local user; Staff gets read+execute | Strongest (Staff cannot write; a path rule is legal) | HKCU settings do not reach Staff; new account with allow-all AppLocker rule and a stored password | L | Not recommended |
| D. Admin repackages | Admin supplies an MSI/zip | Strongest | Needs vendor cooperation or tooling | S (Rulebox side: none) | Always possible today, document it |

The dashboard offers **A first** when the detector says per-user (cheap, safe), then B.

### 4.2 Data model (Convex and desired state)

All fields optional; old rows stay valid; no migration. Document format stays
`rulebox.desired/2`.

```text
// installSpec (convex/lib/validators.ts:133, crates/rulebox-policy/src/catalog.rs:259) gains:
scope?: "machine" | "staff"        // absent = machine. Unknown (new agent, unknown value) => app `unsupported`
lockFolder?: boolean               // staff only; absent = true. Refused with update.mode "vendor"
userDir?: { uninstallExe?: string }   // reserved, NOT built (Q-PU6)
// silentArgs tokens (paths.rs:351) gain:  {InstallDir}   (machine scope only, Tier A)
// desktop.exe template roots gain (staff scope only):  {StaffLocalAppData}, {StaffAppData}
```

- `{InstallDir}`: the folder of the expanded `desktop.exe`, chosen by the agent. Only
  two argument shapes are legal and only when the exe starts with `{ProgramFiles}` or
  `{ProgramFilesX86}` (and has no `*`): the **last** argument exactly `/D={InstallDir}`
  (NSIS), or an argument exactly `/DIR={InstallDir}` (Inno). Anything else with the
  token is refused (`check_silent_args` already refuses unknown `{...}`).
- `scope: "staff"` rules (server and agent, same grammar, shared vectors file):
  `install.kind` must be `exe`; `desktop.exe` must start with `{StaffLocalAppData}\` or
  `{StaffAppData}\`, 2-8 components (first = the vendor's folder), one `*` folder allowed
  as in 4.4.3, ends `.exe`, not on the deny list; the first folder must not be
  `Microsoft`, `Packages`, `Temp`, `Programs\Microsoft`, or in `RESET_DENY`
  (`paths.rs:118`); the install folder (the parent of the first `*` or of the exe) must
  not equal, contain, or lie inside any `resetFolders` entry of the same app
  (`install_folder_in_reset_folder`), and `lockFolder: true` must not be combined with
  `update.mode: "vendor"` (`vendor_cannot_lock`).
- `desired.ts` (`convex/lib/desired.ts:93`, `:323`) copies the two new `install` fields
  like `timeoutMin`. `check_limits` and `check_spec` (`engine.rs:642`) repeat the rules;
  the engine never trusts the document alone (defence in depth, as today).
- Capability reporting (Phase 5 D9) gains `perUserInstall` and `installDirToken`; the
  dashboard shows "this PC's agent is too old for Staff-account installs" from the
  capability list. An old agent ignores the fields and reports `installed_per_user`.
- `convex/ioBudgets.ts`: **no new row** (no new function). The existing `apps:save` /
  `apps:update` budgets do not change (the new fields are inside the one app document).

Rust: `InstallScope { Machine, Staff, Unknown }` via `unknown_on_new_values!`.
**Unknown is not "machine"**: a new agent refuses an unknown scope (`unsupported`),
because running a per-user installer as SYSTEM is the very mistake this feature fixes.

### 4.3 Detection hints (server and dashboard)

- `convex/lib/installerDetect.ts` keeps `perUserLikely` (NSIS + `asInvoker`). **Do not
  extend it to Inno `asInvoker`**: BIXOLON (Inno, `asInvoker`, X-1) installed
  machine-wide as SYSTEM ("Administrative install mode: Yes", `C:\BIXOLON`). Add a
  second field `perUserEvidence: "manifest" | "device"`. The dashboard sets `device`
  when an install result says `installed_per_user` for that app.
- Pre-fill for an NSIS per-user-likely installer: silent switches `["/S",
  "/D={InstallDir}"]` and exe template `{ProgramFiles}\<ProductName>\<file>.exe` (Tier
  A), with the banner text changed from "try it on one PC first" to a three-way choice:
  *Install into the program folder (recommended)*, *Install for the Staff account*,
  *Leave as is*. The second choice is shown only when the agent capability list says
  every assigned PC supports it.
- `installed_per_user` text in `screenStrings/install.ts:32` changes from "Use a
  per-machine installer" to "...use the install-folder option, or Staff-account
  install". The dashboard size budget for AppEdit (29 KB, `apps/dashboard/scripts/size.mjs`)
  must be re-checked; the strings ride the lazy chunk `appInstaller.ts`.
- The dashboard never infers scope from the exe path alone.

### 4.4 New agent details (closed list, both lists + shared vector)

Added to `Detail` (`installs/mod.rs:94`), `INSTALL_DETAILS`
(`convex/lib/deviceApiRules.ts:139`), `apps/agent/tests/vectors/install-details.json`
and `screenStrings/install.ts`; the existing test that compares the lists
(`installs/mod.rs` test `details_are_exactly_the_servers_fixed_list`, count 23) moves to 29:

| Detail | Meaning |
|---|---|
| `staff_unavailable` | No Staff account or profile, kiosk off, no usable Staff session or token yet. Waiting, retried (not counted until a run was tried) |
| `staff_logon_failed` | The Staff token could not be built or re-homed (S-14 decides the wording) |
| `needs_elevation` | The installer's manifest requires administrator (error 740) or it tried to elevate: it cannot work for Staff. The admin must use Tier A or a machine installer |
| `installed_machine_wide` | `scope: staff` was asked, but the program exists under Program Files or ProgramData and not under the Staff profile (the installer ignored the user token) |
| `rule_not_applied` | The program is installed and locked, but the Staff allow rule did not become active in time (policy refresh), so the tile stays hidden; retried |
| `lock_failed` | The folder could not be made read-only for Staff (a reparse point, a handle in use). Nothing is trusted; the tile stays hidden |

`installed_per_user` stays (the SYSTEM-profile outcome of a machine-scope run).

## 5. Agent flow

### 5.1 Tier A (install-folder override)

Files: `installs/answer.rs` (token expansion), `installs/mod.rs`, `engine.rs`,
`platform/{mod,sim,windows}.rs` (`InstallerCommand`), tests.

1. `expand_silent_args` (`installs/answer.rs`) learns `{InstallDir}`: replaced with the
   folder of `spec.exe` (`installs/version.rs::program_folder`), only when the exe is a
   plain path (no `*`) under `{ProgramFiles}` / `{ProgramFilesX86}`; otherwise
   `Detail::Unsupported`.
2. NSIS needs `/D=` as the **last argument, unquoted, even with spaces**. `std::process::Command`
   would quote `/D=C:\Program Files\X` as one argument and NSIS would not recognise it.
   `InstallerCommand` gets `raw_tail: Option<String>`, set by the engine **only** from
   the validated token shape above and passed with `CommandExt::raw_arg`
   (`platform/windows.rs:443`). The folder is validated by `plain_absolute`; it can contain
   no quote, `&`, control character or `..` (so no second argument can be smuggled).
3. Inno's `/DIR=` is an ordinary argument (quoting works).
4. No change to the program rule: the program is still `<downloads>\<sha256>.exe`.
5. After a successful exit the existing detection runs (`wait_for_exe`, `installed`).
   If the exe is still missing and the system-profile search finds it, the detail stays
   `installed_per_user` and the dashboard now says the override was ignored.
6. Uninstall registry entries are written into SYSTEM's `HKU\.DEFAULT` (S-9). Harmless;
   do not use them. The uninstaller itself sits in the Program Files folder and, run as
   SYSTEM with `/S`, removed the app in S-9 (exit 0). Removal for `exe` apps stays
   "never" in v1 (`engine.rs:706`); this is a documented later option (Q-PU6).

### 5.2 Tier B: gating (when a `scope: staff` job may run)

A `scope: staff` job runs only when **all** are true (re-evaluated on the existing wake
sources: boot, employee sign-in/out, document change, process exit; plus one 30-second
timer **only while such a job waits and the kiosk is on**, to notice the Staff Windows
session; it stops with the job):

1. Staff account and profile exist (`staff_profile_dir`, `kiosk` enabled).
2. A Staff Windows session exists (`Platform::sessions()` shows `user_sid == staff_sid`;
   `WindowsPlatform::sessions` at `platform/windows.rs:231`), or the P2 path is enabled
   (5.3).
3. **No employee is signed in** (the existing apply window 1 or 2 of parent 4.4.5, for
   first installs as well as updates). Reasons: the Desktop/Documents/Downloads redirect
   is active while an employee works (installer shortcuts would land in their files);
   4 GB laptops; and the Staff App can show "Updating apps..." with its 5-minute hold.
   Q-PU5 asks whether first installs may run immediately instead.
4. No other install operation runs (existing: one at a time).
5. Disk check: free space >= 3 x installer size + 200 MiB (`check_disk`, `engine.rs:1593`);
   the install size is unknown, so the margin is deliberately large.
6. The lockdown layers are in a state where the rule can be applied (AppLocker `Ok` or
   `Audit` or `Off`, not `Failed`/`foreign policy`), else `rule_not_applied` is reported
   after the install and the tile stays hidden.

If 1 or 2 is false: record state stays `pending`, detail `staff_unavailable` is reported
once (write on change), no failure is counted.

### 5.3 Tier B: running as Staff, no window, no UAC

New in `crates/rulebox-win32/src/process.rs` (or a new `staffrun.rs`): `run_as_user_in_job`.

**Mechanism P1 (preferred, no password, no profile loading): the signed-in Staff
session's token, re-homed to session 0.**

1. `WTSQueryUserToken(staff_session)`; check the user SID equals the Staff SID, the token
   is not elevated and not `TokenElevationTypeFull` (copy the checks of
   `launch_in_session`, `process.rs:239-259`), `DuplicateTokenEx` to a primary token.
2. `SetTokenInformation(TokenSessionId, 0)` with SYSTEM's `SeTcbPrivilege`, so the process
   is created in **session 0**: an installer window or a consent prompt is never visible to
   anybody. **(unverified: S-14.)** If this fails on the build, P1 is dropped (do not
   fall back to starting in the Staff session on its visible desktop).
3. `CreateEnvironmentBlock(token, inherit = false)`; `TEMP`/`TMP` point to a fresh folder
   `<StaffLocalAppData>\Temp\rb-<random>` created by SYSTEM with Staff as owner and
   removed after the run (like `RunTemp`, `installs/mod.rs:642`). `LOCALAPPDATA` etc. come
   from the profile.
4. `CreateProcessAsUserW(primary, staged_exe, ...)` with `CREATE_SUSPENDED |
   CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT`, NUL standard handles (`STARTF_USESTDHANDLES`,
   no handle inheritance), current directory = the per-run temp folder.
5. Put the suspended process in a `KillOnCloseJob` (`job.rs`) **and** apply
   `JOBOBJECT_BASIC_UI_RESTRICTIONS` (desktop, handles, exit-windows, system parameters)
   as defence in depth; then `resume_process`. No breakaway is allowed, so everything the
   installer starts, including an app it launches at the end, is in the job and dies with it
   (parent edge case 33 holds).
6. Wait with the existing `wait_for_installer` (new `RunningInstaller` impl `UserRun` over
   the process handle: `try_exit` = `GetExitCodeProcess`, `active` / `cpu_time` / `kill_all`
   from the job). `has_window` returns `false` for a Staff-token run: `EnumWindows` only sees
   the service's own desktop, and giving the Staff SID rights on the service window station
   is not done. **`needs_interaction` for Staff installs therefore rests on the CPU-idle
   rule alone** (spike S-15 measures whether that is enough). Add a `still_valid` closure
   polled with `cancel`: it returns false if the Staff Windows session disappeared (logoff),
   which kills the job and re-queues the work (edge case 3).
7. After the exit, the tail grace and the job kill apply as today; handles, environment
   block and temp folder are released on every path.

**Mechanism P2 (only if the owner wants installs while Staff has no Windows session;
Q-PU2b): `LogonUserW(Staff, LOGON32_LOGON_INTERACTIVE)` with the password the agent
already keeps in the LSA secret (`kiosk.rs:549`), then `LoadUserProfileW`, build the
environment, run as in P1 steps 3-7 (the logon token is born in session 0), then
`UnloadUserProfile`.** Risks: a hive left loaded after a leaked handle can make Windows
create a temporary profile at Staff's next logon (the existing `with_user_hive` unload
retry, `registry.rs:491`, shows how fragile this is); a 4624 logon event per install; the
password is used by a second code path. Not recommended for v1: a kiosk PC's Staff session
exists a minute after boot (autologon).

**Never:** the Staff session's own token for a process started in session 1; the linked
(elevated) token; `runas`/`ShellExecute` verbs; PowerShell or `cmd` (still not on the
program list).

### 5.4 Tier B: staging the installer for the Staff token

The Staff token cannot read `<data>\downloads` (protected). Without weakening it:

1. Download and verify as today (`download`, `open_verified`, `engine.rs:1791-1841`).
2. Copy the verified file to `<data>\staff-install\<sha256>.exe` (new
   `DataPaths::staff_install_dir()`, `apps/agent/src/paths.rs`), hold a locked handle on
   the **copy** (read sharing only) and hash it again through that handle (TOCTOU, same
   pattern as `open_verified`).
3. Grant the Staff SID **read and execute on that one file only** (the folder stays
   SYSTEM and Administrators; `set_path_acl` accepts only the install root and the state
   dir today, `platform/mod.rs:105`, so `acl_target_allowed` gets the new folder).
   "Bypass traverse checking" lets Staff reach the leaf without access to the parents
   **(unverified: S-15)**.
4. `installer_command_allowed` (`installs/mod.rs:309`) gets one more allowed shape:
   `<data>\staff-install\<sha256>.exe` (plain, absolute, directly inside the folder),
   used only by the new Staff run method. The existing method still refuses it.
5. The copy is deleted when the run ends (and swept at agent start, like
   `sweep_run_temps`).

### 5.5 Tier B: after the installer ends (the order matters and is journalled)

1. `Success` exit per `judge_install` (exe codes as listed). Nothing else is trusted.
2. Resolve the Staff Local AppData **from the machine**, not by assumption: profile from
   `ProfileList` (`accounts::profile_path`), then `User Shell Folders\Local AppData` from
   the hive (`Platform::staff_app_data_redirected`, `platform/mod.rs:367`); a redirect
   that Rulebox did not make -> refuse the app (`staff_unavailable`, text "Staff's AppData is
   redirected"). Expand `{StaffLocalAppData}` in `desktop.exe` (new roots in
   `PathRoots`, set where `path_roots()` is built: `windows.rs`, `sim.rs`, `catalog.rs`;
   `PathRoots {` is constructed in 14 places, all in tests or those three files).
3. `wait_for_exe` (existing). Missing: search for the stray locations -> `installed_machine_wide`
   (Program Files/ProgramData) or `installed_per_user` (SYSTEM profile) or
   `exe_missing_after_install`.
4. **Lock the tree** (if `lockFolder`): new `rulebox_win32::staffapp::lock_tree(profile, folder, staff_sid)`:
   open every directory relative to its parent's held handle (the `rulebox_win32::tree`
   pattern, `tree.rs`), refuse a reparse point or case-sensitive folder anywhere on the
   way or inside (`lock_failed`), set owner SYSTEM and a **protected DACL**: SYSTEM and
   Administrators full, Staff read+execute, inherited by children. Only folders strictly
   below `<profile>\AppData\Local` (or `Roaming`) and deeper than the vendor's own folder
   qualify; never the profile, `Microsoft`, `Temp`, `Rulebox`, `dev.rulebox.staff`.
5. Enumerate the `.exe` files in the locked tree (depth <= 4, at most 60 per app, links
   never followed; more -> `unsupported`, text "too many programs in the folder").
6. For each, compute the **AppLocker hash** (Authenticode SHA-256; new
   `Platform::authenticode_hash`, **unverified: S-17**) and the plain SHA-256
   (`file_sha256`), with the file stamp (`file_stamp`). If the AppLocker hash cannot be
   computed -> refuse (`rule_not_applied`); never fall back to a path rule.
7. Signed programs (the exe has a valid Authenticode signature whose subject equals
   `install.publisher` or `update.publisher`): no hash rule; the publisher rule is used
   (existing `vendor_exceptions`, extended below).
8. Write the journal record `staff_app { sid, folder, exes[{rel, appLockerHash, sha256, stamp}],
   locked, installedAt }` (`installs.json` schema 2 -> 3, additive, schema 2 still read;
   an older agent refuses schema 3 and starts empty, same rule as the 1 -> 2 step).
9. Ask the lockdown runtime to apply again (`reconciler.lockdown_changed()`, as
   `on_driver_change` does, `agent.rs:634`) and **wait until the applied document contains
   the app's rules** (state read from the shared lockdown status, new field
   `appliedStaffApps: BTreeSet<appId>`; bounded wait 10 minutes). Only then does the record
   become `Installed` and `InstallBook::is_installed` return true (the tile appears:
   "never show a half-installed app", PRD 13.5; the same idea as `browserReady`).
   Timeout -> `rule_not_applied`, retried at the next window.
10. Report once (`installedVersion` from `file_version(exe)`).

### 5.6 Tier B: update, rollback, removal, scope switch

- **Update (Managed or Pinned with a new hash):** same gating and window as parent 4.4.5,
  plus the app must not be running (`app_running`, `engine.rs:1067`; the existing
  `waiting_for_close`). Steps: stage the new installer; **unlock** the tree (reset the DACL
  to the inherited one, SYSTEM does it); run; lock; re-hash; re-apply policy; ready. While
  the tree is unlocked and the new rule is not applied, the tile is hidden ("Updating...").
  The old rules stay in the policy until the new ones are applied (additive first, then
  remove the old hash set), so a rollback target keeps working.
- **Rollback (Managed, `rollbackOnFail`):** the previous installer (`kept`/`previous`,
  `engine.rs:236`) runs through the same Staff path; hashes are recomputed.
- **Vendor mode (signed vendor updates itself in AppData):** `lockFolder` must be false
  (the vendor's updater has to write). Trust is the publisher rule only; a signed new
  exe from the vendor starts without any policy change. This is the best case for
  Slack/Teams-style per-user apps and needs **no hash churn**. Unsigned apps cannot be
  Vendor (existing rule, `vendor_mode_needs_publisher`).
- **Removal (app unassigned, `removeWhenUnassigned`):** v1 never runs a vendor uninstaller.
  The agent unlocks, then deletes the recorded folder with the handle-based deleter
  (`rulebox_win32::tree::reset_below`, `Platform::reset_folder` pattern, `windows.rs:553`:
  no link followed, in-use -> retried), removes the app's hash rules (policy re-apply), and
  removes the `Uninstall` subkey it discovered **only if** it is under the Staff hive and
  its `InstallLocation` equals the recorded folder (new read/delete root, below). A program
  that already existed before Rulebox saw it (`preexisting`) is never deleted
  (existing rule, `engine.rs:168`). Note `engine.rs:706`: exe apps are not removable today;
  for `scope: staff` the flag is honoured (the folder is Rulebox-recorded, so safe).
- **Scope switch machine <-> staff:** treated as a new install: the record keeps the old
  folder; staff -> machine removes the Staff tree and rules first; machine -> staff leaves
  the Program Files copy in place (exe apps are not removed in v1; the path rule vanishes
  with the catalogue entry) and says so on the device page.

### 5.7 Tier B: AppLocker and procwatch (exact rules)

The compilers get a new fact list, not new document exceptions (nothing for the admin to
type, nothing in the signed document that the device cannot derive).

New in `lockdown/invariants.rs` `Facts`: `staff_apps: Vec<StaffAppFacts>` filled by
`machine_facts` (`runtime.rs:240`) from `InstallBook::snapshot()` (the runtime needs an
`Arc<InstallBook>` in its deps: **wiring unverified**, `agent.rs` builds both). Each:
`{ app_id, folder, exes: [{path, appLockerHash, sha256, stamp}], publisher: Option<{subject, product}> }`.

| Item | AppLocker (EXE, MSI, Script collections) | procwatch (L5) | App Control |
|---|---|---|---|
| Installer staging folder | **Standing path rule** `<data>\staff-install\*` for the Staff SID, **only while at least one assigned app has `scope: staff`**; the folder is admin-only (the allow-list refuses it otherwise, as for catalogue folders) | folder rule (`allowed: CatalogueFolder`-like) | n/a |
| Installed exes, unsigned | One `FileHashRule` per exe (Staff SID, `SourceFileName` = `staffapp-<appId>-<file>`), value = **AppLocker hash** | `Allowed::StaffApp` only when the process image path equals the recorded path **and** the stamp-cached hash equals the recorded `sha256` (cache keyed by path + stamp, `procwatch.rs:341-420`; the 64 MiB hashing cap does not apply because the hash was taken at install time) | not used |
| Installed exes, signed | publisher rule (existing `vendor_exceptions` shape, id `staff-<appId>`), narrowed by product | existing `PublisherException` | not used |
| Same bytes elsewhere | A hash rule matches the bytes **anywhere**, e.g. a copy in a writable folder next to a planted DLL | new `Denied::StaffAppMoved` (fixed code `staff_app_moved`): same hash, other path -> finding, and `terminate` in `enforce` | n/a |
| Uninstaller, updater and helper exes in the locked tree | included in the hash set (60 max) so the agent's own removal/rollback run and the app's helpers work | same | n/a |
| App Control `allowlist` level | n/a | n/a | refused through `check_allowlist_level` (`appcontrol.rs:203`): per-user folders are added to a new `Facts.staff_app_folders` that **only** this check reads, so `allowlist::build` is not asked for a path rule it would refuse (`catalogue_folder_writable`) |

Compile-time checks to add to `check_compiled` / the invariant tests: the staging rule and
every per-user rule are for the Staff SID only; no rule names a folder under the Staff
profile as a **path** rule; the generated XML for "no per-user apps" is byte-identical to
today's (golden file), so ordinary kiosks see no change.

**Update handling for hash rules:** every new version means a new hash set and a policy
rewrite; between install end and "applied" the tile is hidden. This is why Managed is the
recommended mode for unsigned per-user apps and Vendor for signed ones. Findings that name
a per-user hash-ruled app after a vendor in-app update (`not_in_allow_list`, folder class
`userProfile`) read "break on update" like Phase 5 edge case 12.

**Policy refresh latency is unverified on Windows Pro.** The Phase 5 results file is
empty for the mechanism (rows 1-08, 1-09); S-6 used a hand-made local policy and needed
`gpupdate /force`. The agent's Pro path is the AppLocker CSP (`mechanism_for`,
`applocker.rs:98`). S-18 measures "rule written -> program runs" on the VM; the bounded wait
in 5.5 step 9 and the hidden-tile rule absorb the delay, but if it is minutes the apply
window (no employee) is where it happens.

### 5.8 Dashboard and Staff App

- App form (`AppInstaller.tsx`): scope selector, `lockFolder` switch, `installDir`
  preview, the exe-template helper for `{StaffLocalAppData}`, and plain-language warnings:
  "The program lives in the Staff account's folder. Rulebox locks it so Staff cannot change
  it, and allows exactly these program files. A new version of an unsigned program needs a
  new rule, so use *Managed* updates."
- Device page: per-app badge "Installed for the Staff account" and the file count; detail
  texts for the six new details.
- **Staff App and IPC: no change.** The tile exists only when the agent says the app is
  installed and ready; the Staff App starts `desktop.exe` as before
  (`launcher.rs plan_launch`). The "Updating apps..." sign-in hold (parent 4.4.5) already
  covers the apply window.
- `lockdown-status` and the findings screen: `staff_app_moved`, and the per-user app list.

## 6. Why not just WTS/`runas` in the Staff session

Because the installer would run on the Staff's visible desktop (a stray window is a rule-5
bug, a self-elevating installer would show UAC), `has_visible_window` cannot see another
session, and the Staff App would have to be involved. Session 0 with Staff's token gives
Staff's HKCU and profile, hides everything, and keeps the agent as the only actor.

## 7. Tests (dev machine, automated and safe)

| Area | Tests |
|---|---|
| `rulebox-policy` | `InstallScope` unknown value -> app unsupported; `{InstallDir}` accepted only in the two shapes and only under Program Files; `{StaffLocalAppData}` grammar vectors (shared file with `convex/lib/pathRules.ts`, mirrored like `reset-folders.json`); install folder vs `resetFolders` overlap; `vendor_cannot_lock`; old documents byte-identical (existing vector test) |
| Convex | `appRules`: scope/lockFolder validation and refusal codes; `desired.ts` copies the fields only for staff scope; detector `perUserEvidence`; `INSTALL_DETAILS` shared-vector test (29 entries); matrix rows unchanged (no new function); `ioBudgets` test unchanged |
| Dashboard | form states (machine, override, staff), warnings, new detail strings, size budget (`size.mjs`), light/dark and 390x844 screenshots |
| Agent: Tier A | token expansion; raw tail only from the validated shape; hostile folder text (`"`, `&`, `..`, trailing `\`) refused; Inno vs NSIS shape; `installer_run` records the raw tail (SimPlatform `world.installer_runs`) |
| Agent: engine (SimPlatform) | gating (no Staff session, kiosk off, employee signed in); `staff_unavailable` written once; staged copy hashed twice and deleted; run result mapping for each detail; success with exe missing -> `installed_machine_wide` / `installed_per_user` / `exe_missing_after_install`; lock failure -> `lock_failed`; more than 60 exes -> `unsupported`; record schema 2 loads with defaults, schema 3 written, old agent refuses; update unlock/relock order; rollback; removal order; scope switch both ways; preexisting program never deleted; install folder inside a reset folder skipped by cleanup |
| Agent: lockdown | golden XML with and without per-user apps (no-app output unchanged); staging rule only with a staff-scope app assigned; hash rule per exe; publisher rule for signed; invariants I1-I10 still hold; App Control level refused; procwatch: allowed at recorded path and hash, `StaffAppMoved` at another path, stamp change forces re-hash, 64 MiB cap not applied to recorded hashes; applocker `Off`/`Audit`/`Enabled` readiness rules |
| `rulebox-win32` (dev-safe) | pure parts only: DACL builder (SDDL string for the locked tree), relative-path validation, UI-restriction flags; real calls are `#[ignore]` VM tests (below) |
| SimPlatform | new fakes: `run_installer_as_staff` (scripted exit + effect on a fake Staff file set), `lock_staff_folder`, `authenticode_hash` (stable fake), Staff session list, `staff_install_dir`; the `MUTATING_METHODS` list (`platform/mod.rs:38`) and `guard_coverage` tests updated; every new mutating `WindowsPlatform` method calls `guard()` first (`blocked(...)` test pattern, `windows.rs:1381`) |

VM-only integration tests live in a new `crates/rulebox-win32/tests/vm_staff_install.rs`
(`#[ignore]`, first line `require_vm()`, same pattern as `vm_lifecycle.rs`). The user runs
them; nothing here runs on the dev machine.

## 8. Steps

Machine column as in the parent plan: **dev** = SimPlatform, convex-test, Vitest only.
**VM** = `rulebox-test-pro`, the user runs it.

| Step | What | Machine | Depends on | Size |
|---|---|---|---|---|
| PU-0 | Spike S-13..S-20 (Section 9) | **VM** | parent Step 2 harness | 0.5-1 day of VM time |
| PU-1 | Owner answers Section 15; sync the docs of Section 14 | dev | PU-0 | 0.5 day |
| PU-2 | Types and server: `{InstallDir}`, `scope`, `lockFolder`, path grammar, details, detector, dashboard form | dev | PU-1 | Tier A part 1 day; Tier B part 1.5 days |
| PU-3 | **Tier A agent**: `{InstallDir}` expansion, `raw_tail`, tests | dev | PU-2 | 1 day |
| PU-4 | `rulebox-win32`: `run_as_user_in_job`, `staffapp::{lock_tree, unlock_tree}`, `authenticode_hash`, `list_exes`, hive `Uninstall` read root, tests | dev (+ VM test file) | S-14, S-17 | 4-5 days |
| PU-5 | Platform seam and Sim: new methods, `PathRoots` Staff roots, `acl_target_allowed`, guard coverage | dev | PU-4 | 1.5 days |
| PU-6 | Engine flow for `scope: staff`: gating, staging, run, discovery, lock, hash, journal schema 3, ready state, update, rollback, removal, scope switch | dev | PU-5 | 4-5 days |
| PU-7 | Lockdown: `Facts.staff_apps`, allow-list (staging rule, hash set, publisher), procwatch path binding, App Control refusal, `lockdown_changed` wiring, golden files | dev | PU-6 | 3 days |
| PU-8 | Dashboard device page, `lockdown-status`, findings text, size budget | dev | PU-7 | 1 day |
| PU-9 | VM run: fixture `Zahras POS Dev 1.0.2` (Section 10) | **VM** | PU-3 (A), PU-8 (B) | 1 VM session each |
| PU-10 | Wrap-up: update the parent plan, PRD, Phase 5 plan, README index | dev | PU-9 | 0.5 day |

**Rough size:** Tier A **about 3 days dev + one short VM session**. Tier B **about
15-18 days dev + two VM sessions** (the win32 layer and the lockdown wiring are the
risk). With both: roughly 4 weeks of calendar time at one developer, or 3 weeks if the
dashboard steps run in parallel with the agent steps.

**Where it fits in the Phase 6 order (parent Section 5):**

- PU-0 can be run **now** with the existing spike harness (S-13 uses `Start-SpikeSystem`;
  S-14..S-20 need the VM-only test file of PU-4 or a throwaway helper, so they follow PU-4's
  first half).
- Tier A is **"Step 14c"**: it belongs next to Step 14 (wizard installer handling) and must be
  done **before Step 23** (VM run B), so Step 23 can use the Zahras POS fixture for real.
  It does not depend on Step 18.
- Tier B is **"Step 14d"** and is the largest single item left in Phase 6 after Step 18. Build
  it **after Step 17/18 and before Step 23** only if the owner needs it for the pilot
  (Q-PU2); otherwise schedule it as v1.x and run only Tier A in the pilot. The parent plan's
  Step 25 (I/O measurement) is unaffected (no new queries).
- Parent Step 22 (MSI run) and Step 24 (browsers) are independent.

## 9. VM spike (PU-0): observations that decide the design

Each row is an **observation**, not an attack. Append them to `phase-6-vm-spike.md`
(Group F) when PU-0 starts. Same rules as Step 2: revert to `spike-base` first; no Rulebox
code except where noted; evidence files under `phase-6-vm-spike/`.

| # | Observe | Decides |
|---|---|---|
| S-13 | `Zahras POS Dev 1.0.2` run as SYSTEM with `/S /D=C:\Program Files\Zahras POS Dev` (raw text, no quotes, last): where do the files land, exit code, does it start the app, what do the uninstall entry and `uninstall.exe /S` do, does the app start **as `spikestaff`** and keep its data in `%LOCALAPPDATA%\<identifier>` and `%APPDATA%` (not next to its exe)? Also `/S /D=` with a 32-bit Inno sample if one is on hand | **Tier A viability** (4.1, 5.1) |
| S-14 | A throwaway VM test (PU-4 first half): `WTSQueryUserToken` for `spikestaff`'s session, `SetTokenInformation(TokenSessionId, 0)`, `CreateProcessAsUserW` suspended into a kill-on-close job, run `Zahras POS Dev` `/S`: does it install under `C:\Users\spikestaff\AppData\Local`, is `HKU\<spikestaff SID>\...\Uninstall` written (hive shared with the live session), is any window or UAC visible in the Staff session, exit code, `%LOCALAPPDATA%` seen by the child | **P1 viability**, 5.3 |
| S-15 | The same run with the Staff AppLocker policy of S-6 (Enabled, Administrators and SYSTEM allow-all, Staff path rules for `%WINDIR%` and `%PROGRAMFILES%` only): is the installer blocked? Which event (8004/8003), user = Staff? Add a path allow for a staged copy under `C:\rb-spike\staff-install\` (Staff RX on the file only): does it run without access to the parent folders? Does a self-copying installer (Inno sample, `is-*.tmp\*.tmp`) get blocked? | 5.4 staging rule, Section 12 (Staff token and AppLocker) |
| S-16 | P2 only if S-14 fails: `LogonUser` INTERACTIVE + `LoadUserProfile` + run + `UnloadUserProfile` while Staff is signed in and signed out; does the next Staff logon get its normal profile; Security log events | 5.3 P2 |
| S-17 | Compute the AppLocker hash of `zahras-pos-desktop.exe` with `Get-AppLockerFileInformation -Path` and compare with `Get-FileHash`: equal or not? Add a `FileHashRule` with each value (Staff SID, Enabled) and see which one lets `spikestaff` start it. Repeat for a **copy** in a writable folder (does the rule match the bytes anywhere?). Check Phase 5's existing `Hash` exception the same way | 5.5 step 6, 5.7, risk 1 |
| S-18 | Policy refresh: with the CSP route (the agent's Pro path) and with the local route, seconds from "rule written" to "program starts" for a new hash rule; is `AppIDSvc` restart needed | 5.5 step 9, 5.7 |
| S-19 | Lock the installed tree (owner SYSTEM, Staff RX, protected DACL): does `zahras-pos-desktop.exe` still run and keep working as `spikestaff` (WebView2 data dir elsewhere)? Can `spikestaff` rename or replace the locked folder by name? (Expected yes via `FILE_DELETE_CHILD` on the parent; that is why trust is by hash, not path.) Does a file dropped next to the exe by Staff fail? | 5.5 step 4, 5.7 |
| S-20 | `Run`-key and shortcut effects of the Staff-token run (S-14): what the installer wrote under the Staff hive `Run` and the Start Menu; does the existing performance layer remove the `Run` entry; does an Inno sample need `.tmp` children from `%TEMP%` | edge cases 13-15 |

**Done when:** every row has a result or "could not observe" and a reason; Sections 4-5 are
updated where a result differs. **Do NOT:** run any of this on the dev machine, or keep the
VM state.

## 10. VM fixture and checks for Step PU-9 (user runs)

Fixture: `[DEV] Zahras POS Dev_1.0.2_x64-setup.exe` (SHA-256
`76645CA1290D4830A79492005FE7306A591CCED967690C02609EBE5DF761825F`, unsigned, NSIS,
`asInvoker`, FileVersion 1.0.2; `rerun-2026-11-25-log.txt`).

| # | Check | Pass |
|---|---|---|
| PU-A1 | Tier A: catalogue the app with `silentArgs ["/S","/D={InstallDir}"]`, exe `{ProgramFiles}\Zahras POS Dev\zahras-pos-desktop.exe`; apply | Installed under Program Files, tile appears, AppLocker path rule on the folder (admin-only), no `installed_per_user`, the app starts for Staff |
| PU-A2 | Tier A with an installer that ignores `/D=` (use a second sample) | `installed_per_user`, dashboard text says the override was ignored |
| PU-B1 | Tier B first install (kiosk on, Staff signed in, no employee): `scope staff`, exe `{StaffLocalAppData}\Zahras POS Dev\zahras-pos-desktop.exe`, AppLocker `Enabled` | No window or UAC in the Staff session; files in `C:\Users\RuleboxStaff\AppData\Local\Zahras POS Dev`; tree locked (Staff cannot write); hash rules for every exe; tile appears only after the policy is active; the app starts for an employee |
| PU-B2 | Same with AppLocker `AuditOnly` and `Off` | Ready at once; no block events |
| PU-B3 | Staff tries to replace the exe or add a DLL in the folder (by hand, as `spikestaff`) | Refused by ACL; a renamed-folder copy of the exe runs only if the hash matches and is caught by `staff_app_moved` in `enforce` |
| PU-B4 | Update 1.0.2 -> a second build (Managed or Pinned with a new hash) while the app is closed, then while it is running | Closed: unlock, run, lock, new rules, tile hidden meanwhile. Running: `waiting_for_close`, nothing touched |
| PU-B5 | Roll back a failed update | Previous installer runs through the Staff path; app works |
| PU-B6 | Unassign the app | Tile gone; tree deleted; hash rules gone after re-apply; the `Uninstall` subkey the agent discovered is removed; a `preexisting` copy is left alone |
| PU-B7 | Staff signs out mid-install (use a long-running dummy installer), sleep/resume, stop the agent service | Job killed, work re-queued, no half-trusted tree, hidden tile |
| PU-B8 | Installer that demands elevation | `needs_elevation`, nothing visible |
| PU-B9 | Switch the app machine -> staff -> machine | Old tree and rules removed, new install proper |
| PU-B10 | Profile reset / Staff account recreated | Record invalid, reinstall, new SID in the rules |
| PU-B11 | `rulebox-agent recover` and Disable kiosk with a per-user app installed | Windows restored; Staff profile untouched or removed with the account; no hive left mounted |
| PU-B12 | Lockdown escape rows E-30..E-39 with a per-user app present | Unchanged results; a copy of the app's exe in a writable folder does not run in `enforce` |

## 11. Database I/O, observability and security checklist

- **Convex I/O:** zero new functions, tables, indexes or subscriptions. `apps:save` /
  `apps:update` read and write the same one document. The device reports one more
  `detail` value on the existing `installResults` upsert (write on change). No row in
  `ioBudgets.ts`, none in the authorization matrix. Re-run the existing
  `ioBudgets`/probe tests to prove no counts changed.
- **Agent log** (local, existing rotation): one line per decision (gate result, run
  result, lock result, rule applied) with the app id; no paths from the Staff session
  other than the recorded install folder, no command lines.
- **Security checklist (add to parent Section 9):**
  - [ ] The device never runs anything not named by the signed document and verified by hash.
  - [ ] The Staff-token process is non-elevated, in session 0, in a kill-on-close job.
  - [ ] No path allow rule under the Staff profile; one standing path rule on the admin-only staging folder, only while a staff-scope app is assigned.
  - [ ] Every per-user `.exe` is allowed by hash (unsigned) or publisher (signed); procwatch binds hash to path.
  - [ ] The install folder is locked read-only for Staff before it is hashed.
  - [ ] `{InstallDir}` and `/D=` text cannot carry a second argument.
  - [ ] The agent never runs a command read from the Staff hive.
  - [ ] No-per-user-app policy XML is byte-identical to today's.

## 12. Risks

| Risk | Detail | Handling |
|---|---|---|
| AppLocker hash type | `FileHash` for a PE file is the Authenticode hash; Phase 5's `Hash` exception writes the plain SHA-256 (`applocker.rs:184`), procwatch compares the plain one. If they differ, existing hash exceptions never match in AppLocker | S-17 first; if confirmed, a Phase 5 bug to fix with the same `authenticode_hash` function |
| Staff token and AppLocker | The Staff-token installer and its children are evaluated (S-6 only proved SYSTEM is not) | S-15; staged path rule; installers that spawn `%TEMP%` children may be unsupported (documented) |
| DLL planting | DLL collection off; the app folder is Staff-writable before lock; a hash rule matches bytes anywhere | Lock the tree; procwatch path binding; Managed/Pinned only for unsigned; residual risk written down like E-33 |
| Policy latency | CSP refresh time unknown | S-18; hidden tile; bounded wait; apply window |
| Session-0 re-homing | `SetTokenInformation(TokenSessionId)` and HKCU sharing with the live session unverified | S-14; fallback P2 or Tier A only |
| Profile handling (P2) | Leaked hive handle -> temporary profile at next logon | P1 first; P2 only with owner approval and S-16 |
| Detection quality | `asInvoker` is a weak per-user signal (BIXOLON counter-example) | Evidence field; the device result is the truth |
| Reverses a locked non-goal | Parent Section 2 row, PRD 7.3/13.5 text, Phase 5 edge case 48 | Q-PU1; Section 14 doc sync |
| Large exes | procwatch hashes only up to 64 MiB (`procwatch.rs:56`) | Hashes recorded at install; stamp cache; no re-hash |
| Antivirus/SmartScreen | Unsigned exe in a profile | Same as machine installs; no Mark-of-the-Web (agent download); compat warning exists for Smart App Control |

## 13. Edge cases and failure modes

| # | What can go wrong | Required behaviour | Step |
|---|---|---|---|
| 1 | Staff not signed in (no Windows session) | Job waits; `staff_unavailable` reported once; 30 s session check only while waiting; runs when the Staff session appears and no employee is signed in. P2 only if Q-PU2b says yes | PU-6 |
| 2 | Kiosk disabled, Staff account removed, or Staff password unknown | Same wait; never creates the account; never uses a password in P1 | PU-6 |
| 3 | Staff signs out (Windows logoff) mid-install | `still_valid` false -> job killed, no half-trusted tree (nothing is locked or ruled until success), retried at the next window | PU-4, PU-6 |
| 4 | PC sleeps or hibernates mid-install | Same as other installers: may time out or fail with the exit code; retried with the existing backoff | PU-6 |
| 5 | Agent stops or crashes mid-install | Job closes and kills the tree; journal says `installing`; at start the installer is re-run (installers are re-runnable); no ready mark without lock + rules | PU-6 |
| 6 | Installer requires administrator (manifest) | `needs_elevation` (error 740); nothing visible; text points to Tier A | PU-6 |
| 7 | Installer elevates itself mid-way (`runas`) | Cannot succeed in session 0 for a standard token: fails or stalls -> `exit_code` or `needs_interaction` at timeout; no UAC anywhere | PU-6 |
| 8 | Installer installs machine-wide after all | Program found under Program Files/ProgramData -> `installed_machine_wide`; admin switches to `scope machine` | PU-6 |
| 9 | Tier A: installer ignores `/D=` | `installed_per_user` (SYSTEM profile); text updated; nothing trusted | PU-3 |
| 10 | Profile reset or Staff account recreated | Record's SID/profile differs -> invalid -> reinstall; rules follow the new SID at the next apply | PU-6 |
| 11 | Disk full in the profile / system drive | Pre-check; installer exit code failure; a tree created by this run is deleted; retried | PU-6 |
| 12 | AppData redirected by something other than Rulebox | `staff_unavailable` with a specific text; Documents/Desktop/Downloads redirect (Phase 3) does not matter because installs run with no employee | PU-6 |
| 13 | Installer writes Desktop/Start-menu shortcuts | Land in Staff's default folders (no employee signed in); the Staff App ignores `.lnk` (PRD 7.3); not cleaned in v1 | PU-6 |
| 14 | Installer writes an HKCU `Run` entry | Removed by the existing performance layer at the next apply (journalled); the app does not auto-start | PU-7 |
| 15 | Installer starts the app or a service/task at the end | App is in the job and dies with it; a per-user scheduled task survives and runs later as an exe of the locked, hashed tree (allowed) or is blocked (not in the set); recorded as residual risk | PU-6 |
| 16 | In-app updater downloads a new exe into AppData | Unsigned: blocked (locked tree, hash rule); signed + Vendor mode: allowed by publisher rule; documented per mode | PU-7 |
| 17 | Vendor updates an unsigned app by itself | New exe blocked; finding `not_in_allow_list`; dashboard suggests Managed | PU-7 |
| 18 | Update of a per-user app | Apply window; unlock, run, lock, re-hash, re-apply; tile hidden meanwhile; old rules removed only after the new ones are applied | PU-6 |
| 19 | App running during update | `waiting_for_close` (existing); nothing is unlocked or touched | PU-6 |
| 20 | Rollback | Previous installer through the same Staff path; hashes recomputed; `update_rolled_back` / `rollback_failed` | PU-6 |
| 21 | Unassigned (removal) | Tile hidden at once; tree deleted by the handle-based deleter; rules removed after re-apply; `preexisting` never deleted | PU-6 |
| 22 | Switch machine <-> staff | New install; staff -> machine cleans the Staff tree first; machine -> staff leaves the Program Files copy (exe apps are not removed) | PU-6 |
| 23 | Several employees, one Staff account | App data and HKCU are shared, as for machine installs; the admin should list the app's data folders in `resetFolders`; the install folder is refused as a reset folder | PU-2, PU-6 |
| 24 | 32-bit installer | A Staff-token process is not redirected to `SysWOW64\config\systemprofile` (that was SYSTEM's profile); detection uses the Staff path; the `Uninstall` read covers both registry views | PU-4 |
| 25 | Exe template does not match where the installer put the program | `exe_missing_after_install`; search of the Staff profile (read-only, depth 4) names the real folder in the device log, never in a report | PU-6 |
| 26 | `.lnk`, file associations, protocol handlers written by the installer | Ignored: the Staff App never uses Windows associations (CLAUDE.md hard rule) | - |
| 27 | Unsigned installer | Allowed (D-e); `install.publisher` check applies only when set; hash is the control | PU-6 |
| 28 | SHA-256 mismatch (download or staged copy) | `hash_mismatch`; nothing copied or run; the staged copy is re-hashed through a locked handle | PU-6 |
| 29 | Staged installer swapped by Staff | Not possible: admin-only folder; Staff has read+execute on the file only; copy held open with read sharing | PU-6 |
| 30 | Exit 0 but nothing installed (false success, as with drivers) | Success is "exe exists at the template path, hash set computed, lock done, rules applied"; otherwise a detail, never `installed` | PU-6 |
| 31 | Antivirus quarantines the exe | Missing exe at reconcile -> reinstall with the existing bounded backoff; final after six failures | PU-6 |
| 32 | Offline | Download fails -> `download_failed`; an already staged installer runs offline; apply window unaffected | PU-6 |
| 33 | Kiosk disabled / Exit mode / `recover` | Windows restored; per-user apps stay in the profile (removed with the account if the admin removes it); no hive left mounted (P1 never mounts one) | PU-9 |
| 34 | Device locked (Phase 5 4.17) | Installs are session-0 work and do not show anything; no change | - |
| 35 | Lite mode / 4 GB | One operation at a time; no resident helper; hash set <= 60 files | PU-6 |
| 36 | App Control `allowlist` level on | Refused (`allowlist_level_with_user_install`) while a staff-scope app is assigned; recommended-blocks level unaffected | PU-7 |
| 37 | AppLocker `Off` or `AuditOnly` | No rule needed; ready after lock; audit events still list the program | PU-7 |
| 38 | AppLocker policy not yet active (`restartPending`, `AppIDSvc` start) | `rule_not_applied`; tile hidden; retried | PU-7 |
| 39 | AppLocker hash cannot be computed | Refused (`rule_not_applied`); never a path rule | PU-4 |
| 40 | Exe over 64 MiB | Recorded hash is trusted by stamp; procwatch does not re-hash | PU-7 |
| 41 | More than 60 exes in the folder | `unsupported`, text names the limit | PU-6 |
| 42 | Folder contains a reparse point | `lock_failed`; nothing trusted | PU-4 |
| 43 | Install folder equals or sits in a `resetFolders` entry | Refused at save; the agent skips such a reset folder at runtime | PU-2, PU-6 |
| 44 | Old agent gets the new fields | Ignores them, runs as SYSTEM, reports `installed_per_user`; dashboard shows "agent too old" from the capability list | PU-2 |
| 45 | Detector is wrong | Admin edits; the device result is the truth | PU-2 |
| 46 | Same exe name under two apps | Hash rules are per file with the app id in `SourceFileName`; procwatch binds hash and path per app | PU-7 |
| 47 | Staff process created by the installer survives the job | Cannot: no breakaway; kill on close; `process_ids` checked empty before reporting | PU-4 |
| 48 | Windows Update or restart during install | Same as 4/5 | PU-6 |
| 49 | Staff employee opens the install folder from Files | Not reachable (Files shows only the employee's folder); the tree is read-only anyway | - |
| 50 | winget app whose only installer is per-user | Still `winget_unsupported` in v1 (Q-PU8) | - |

## 14. Documents to change when the owner approves (not edited by this plan)

| Document | Change |
|---|---|
| `docs/plans/phase-6-installer-pilot.md` | Section 2 non-goal row "Per-user installs..." -> "Per-user installs for the Staff account: Phase 6 add-on; per-user **self-update** by an unsigned vendor: still never"; rule 5 wording ("installers run as SYSTEM in session 0" -> "...or as the Staff token in session 0 for `scope: staff`"); 4.6 "Per-user installer" row (cross-reference); risk 78 and edge case 30/78 (point to the add-on); Step 14 and 23 status lines; Step order (14c, 14d) |
| `docs/plans/phase-5-lockdown.md` | Edge cases 12, 13, 48 and Section 4.9 text (a staff-scope app is the one allowed user-profile program, by hash/publisher only); invariants unchanged; Section 21 (hash type, S-17) |
| `docs/prd.md` | 7.3 and 13.5 (one sentence each: per-user installs for the Staff account exist, are locked and hash-allowed), 13.6 row 1 ("Prefer machine-wide installers" stays the advice) |
| `docs/plans/README.md` | One index row for this file with its status |
| `docs/plans/phase-6-vm-spike.md` | Group F with S-13..S-20 |
| `convex/lib/appRules.ts`, `pathRules.ts`, `validators.ts`, `desired.ts`; `rulebox-policy` `catalog.rs`/`paths.rs`; `installs/*`; `lockdown/*`; `rulebox-win32` | Code, in the steps above |

If a better solution than this plan is found while building (for example Tier A covers
every real app and Tier B is never needed), say so in the step report so the PRD can
follow (CLAUDE.md: Section 13.6 rule).

## 15. Open questions for the owner

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q-PU1 | May Phase 6 reverse the "per-user installs: never" non-goal (parent Section 2)? | (a) Yes, for the Staff account only, with the hardening in this plan. (b) No: Tier A and "ask the vendor for a machine installer" only | **(a) in principle, built in two tiers.** Tier A alone keeps the old non-goal intact |
| Q-PU2 | What to build now? | (a) Tier A only; Tier B after the pilot. (b) A now, B after Step 18 and before Step 23. (c) B only | **(a), then decide B from S-13.** If `/D=` works for Zahras and the next two apps, B may never be needed. If the owner has a per-user-only app that ignores `/D=`, (b) |
| Q-PU2b | Install while Staff has no Windows session (P2, password, profile load)? | (a) No, wait for the Staff session. (b) Yes | **(a).** Autologon makes the wait about a minute; P2 is the riskiest code in this plan |
| Q-PU3 | Trust for an unsigned per-user program | (a) Hash rules + locked tree + procwatch path binding, Managed or Pinned only. (b) Refuse unsigned per-user apps (publisher only) | **(a).** (b) would exclude Zahras POS |
| Q-PU4 | Lock the install folder read-only for Staff | (a) Default on; off by switch. Forced off for Vendor mode. (b) Never lock | **(a).** An unlocked tree is the DLL-planting hole |
| Q-PU5 | When may the **first** install of a staff-scope app run? | (a) Only with no employee signed in (like updates). (b) Immediately | **(a).** Desktop redirect, 4 GB RAM, simple "Updating apps..." story |
| Q-PU6 | Removal of a per-user app | (a) Delete the recorded tree and rules; never run a vendor uninstaller. (b) Run a declared `uninstallExe` as Staff first | **(a)** for v1 |
| Q-PU7 | Per-user MSI | (a) Not supported. (b) `msiexec` as Staff (needs un-denying `msiexec` for the Staff token) | **(a)** |
| Q-PU8 | Use this mode to unlock winget apps that only have a per-user installer (Spotify) | (a) Later. (b) Now | **(a)** |
| Q-PU9 | App Control `allowlist` level with a staff-scope app | (a) Refuse (existing code). (b) Build hash rules into App Control | **(a)** |
| Q-PU10 | Caps | (a) 60 exes per app, 200 per device. (b) Other | **(a)**; revisit with the first real Electron app |
| Q-PU11 | If the AppLocker hash cannot be made (S-17 negative or API unavailable) | (a) Refuse per-user unsigned apps until fixed. (b) A path rule on the locked folder | **(a).** (b) breaks the Phase 5 rule (rename trick, S-19) |
| Q-PU12 | Wording of rule 5 and the non-goal in the parent plan and PRD | Owner reviews Section 14 | Approve with the sentences in Section 14 |
| Q-PU13 | Install account option C | (a) Not built. (b) Spike it | **(a)** |

## 16. Stop and ask the user if

- S-14 shows `SetTokenInformation(TokenSessionId)` does not work and the owner has not
  approved P2.
- S-17 shows the Phase 5 `Hash` exception never matches (a Phase 5 fix is then a separate,
  tell-the-owner change).
- Any Staff-token run shows a window or a consent prompt in the Staff session.
- The policy refresh takes longer than the bounded wait (10 minutes) in S-18.
- Tier A (`/D=`) works for an app: confirm the owner still wants Tier B before building it.

## 17. Could not be verified (settled where)

- Tauri NSIS honours `/D=` when `installMode` is `currentUser` — S-13.
- Re-homing a Staff token to session 0; HKCU shared with the live session; no visible
  window; installers behave without a window station of their own — S-14.
- AppLocker evaluates a session-0 Staff-token process; `.tmp` children of Inno; traverse
  access to the staged file — S-15.
- LogonUser/LoadUserProfile effects on the next Staff logon — S-16.
- AppLocker hash vs `Get-FileHash`; match of a hash rule on a copied file; the existing
  Phase 5 `Hash` exception — S-17.
- Policy refresh time on the CSP route; `AppIDSvc` restart — S-18.
- Locked-tree behaviour for the app; rename of a locked folder by Staff — S-19.
- Installer side effects in the Staff hive — S-20.
- Wiring of an `InstallBook` handle into the lockdown runtime — Step PU-7.
- Phase 5 VM result rows 1-08 and 1-09 are still empty: the Pro AppLocker mechanism in
  practice is unverified.
