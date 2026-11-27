# Phase 6 — Installer, app updates, browser web apps, wizard installers, pilot

> **For the implementing agent:** follow this plan step by step. Each step
> has a **Done when** check. Run it and see it pass before moving on. Read
> `CLAUDE.md` first, then the reading list in Section 3. Do not build
> anything listed under Non-goals. One step = one commit
> (`Phase 6 step N: <what>`), made only when the user says so.
>
> This plan also tests a kiosk. It names each route out of the Staff session
> only by a short label, the control that closes it and the observation that
> proves it closed. It never describes how to perform an escape. Keep it
> that way when you edit it.
>
> **Nine rules override everything else in this file:**
>
> 1. **Nothing system-altering runs on the dev machine.** Installing the MSI,
>    writing browser policies, running an installer as SYSTEM, `pnputil`,
>    AppLocker changes: VM or the pilot laptop only, and only the **user**
>    runs them. The dev machine never gets the test-machine marker and never
>    gets the MSI installed (Section 4.11).
> 2. **The way back always works** (Phase 5 rule 2). The MSI, the production
>    guard, browser policies and app updates must never block the agent, the
>    launcher, the Staff App, the hidden exit, Shift at startup, Disable
>    kiosk or `rulebox-agent recover`. Uninstalling Rulebox restores Windows.
> 3. **The agent downloads only what a signed document names.** Feed checks
>    happen on the server (D-b). The device never reads a vendor feed. Every
>    installer, answer file and driver package has a URL, a size and a
>    SHA-256 inside the signed desired state.
> 4. **Desired state, not commands** (PRD 10). An app update is a new
>    catalogue version. Rings and rollback are the Phase 5 ones.
> 5. **A UAC prompt or any installer window in the Staff session is a bug.**
>    Installers run as SYSTEM in session 0. The Staff App never updates
>    itself or any app (D-f).
> 6. **Database I/O is the scarce resource.** No device polling loop. Feed
>    checks are scheduled server work with a hard bound. Every new function
>    has an index, a bounded read, a row in `convex/ioBudgets.ts` and a row
>    in the authorization matrix (Section 4.16). Device reports are
>    change-driven.
> 7. **Security events only, no usage tracking** (Decisions 7, 8). Browser
>    mode never reports URLs, titles or history.
> 8. **Offline-first, Solar icons, GSAP rules, 4 GB RAM** (CLAUDE.md) apply
>    to every new screen. The dashboard keeps its plain-CSS entrance
>    animations.
> 9. **Nothing here is "unescapable".** A real browser has more surface than
>    the built-in window. Section 6 names the residual risk of every row.

Research date for every version and API fact in this file: **2026-11-14**.
Items marked **(unverified)** could not be confirmed from a primary source.
Each says how it gets confirmed (almost always Step 2 or the VM runs).
Nothing in this plan was compiled or run.

## Updates since this plan was written

- **2026-11-14:** the owner accepted every Section 19 recommendation
  (Q13 Zahras POS confirmation still due before Step 23).
- **2026-11-19:** the owner approved **Section 18 (PRD changes) in full**,
  every row. Step 1 applied them to `docs/prd.md` (each changed paragraph
  marked "(changed 2026-11, Phase 6)"). No row was rejected, so no steps are
  removed (Steps 16-18 stay). Section 21.1 (locked decisions) was not
  touched; no Decision 20 or 21 was added. Two rows needed no PRD text
  (22.5, and the `guard.rs` / Phase 5 Section 16 rows belong to code and
  plan docs, not the PRD); the 24.2 "Drivers" bullet already existed from
  Phase 5 Step 14b and was only aligned.
- **2026-11-19:** Phase 6 Step 3 is done (commit `73eb607`: device aliases
  removed, one `LITE_MAX_RAM_MB`).
- **2026-11-21:** the owner accepted every recommendation raised while building
  Steps 8-19:
  - **Step 8:** the agent may import the `windows` crate directly for the Setup
    window (`setup/ui.rs` only). Note it in PRD 14 and the Step 8 file list.
  - **Step 13:** strict `{...}` rule on `silentArgs` (only `{AnswerFile}` and
    `{LogFile}`), also applied to apps saved before Step 13 on their next save.
  - **Step 14 / 17:** when Step 17 wires the document check, do **not** call
    `check_silent_args` from `catalog::check_limits`; bad switches make only that
    app `unsupported` (`check_spec`), never refuse the whole document.
  - **Step 16:** geolocation stays blocked for browser web apps, with screen share,
    clipboard read and downloads.
  - **Step 19:** Lite wallpaper is built together with the branding wallpaper
    feature (deferred Phase 4 Q3); until then Lite keeps the flat desktop.
  - **Dashboard size budgets:** overview 166.5 KB, DeviceDetail 25.5 KB, AppEdit
    29 KB (in `apps/dashboard/scripts/size.mjs`) are approved.

---

## 1. Goal

At the end of Phase 6:

1. **One signed MSI** (`Rulebox-<version>-x64.msi`, hand-authored WiX v7)
   installs the agent service and the Staff App per machine, checks the PC
   first, and upgrades and uninstalls cleanly (D-d, D-e).
2. **Compatibility check** (PRD 14) covers WebView2 and reports
   **Full / Reduced protection** per edition, before enrollment and on the
   dashboard.
3. **Release builds work on customer PCs** without the test-machine marker,
   and the dev machine stays protected (Section 4.11). This is a blocker for
   everything after Step 9.
4. **Per-app update mode** (D-a): Pinned, Vendor self-update, or
   Rulebox-managed. Managed updates are resolved **on the server** from the
   vendor feed and published as a normal signed catalogue version (D-b).
   Zahras POS is the first managed app. Chrome is the first vendor app.
5. **Wizard installers run silently** (D-h): the dashboard detects the
   installer technology and pre-fills switches, takes an answer file, and
   the agent says "needs interaction" instead of a bare timeout. Driver
   packages install from an INF. The TPCL driver is the test case.
6. **Web apps can open in Chrome or Edge** per app (D-g), locked by browser
   policies written from the signed desired state. Built-in stays the
   default. Lite mode always uses built-in.
7. **Lite mode tuned** (PRD 22): one RAM constant, admin override per group
   and per device, a web window cap, idle close.
8. **Aliases "kept until Phase 6" are removed.**
9. **Pilot:** one real 4 GB laptop, then a small group through rings, with
   all carry-over checks from Phases 2, 3 and 5 and real I/O numbers (A21).

On the **dev machine** everything is built and tested against
`SimPlatform`, convex-test, Vitest and dashboard fixtures. Real Windows
changes happen only in Steps 2, 22, 23, 24, 26 and 27, which the user runs.

## 2. Non-goals (do NOT build in Phase 6)

| Not in Phase 6 | Belongs to |
|---|---|
| The device reading a vendor feed itself (the brief's first idea). Replaced by D-b | never |
| Per-user installs or per-user self-update (AppData). Staff can write there | never |
| `tauri-plugin-updater` in the Staff App (D-f) | never |
| Managed Installer for App Control (Section 4.4.6) | v1.x, only as a narrow helper |
| Signed App Control policies, kernel drivers | v2, if ever |
| Pinning or rolling back Chrome / Edge versions. Their updater policies need a domain join | not possible on workgroup PCs |
| Chrome / Edge `--kiosk` mode (Edge kiosk is always InPrivate) | not planned |
| Browser extensions, browser sign-in, sync, password manager | never in kiosk browsers |
| Per-app download folders and "blocked request" counters in browser mode | v1.x (Q6) |
| The full PRD 23.3 / 23.4 `versions\` flow with "Restart Rulebox" prompts, channels, deadlines | v1.x (Step 20 is the minimal MSI path) |
| Burn bundle that chains WebView2 | only if Q4 says (b) |
| Operator console, plans and limits, sign-up (H1, H2) | hosted-service phases |
| Malware scanner worker, storage console screens (S2, S3) unless Q1 says (b) | H3 |
| winget CLI on the device, PowerShell or a shell in the install engine | never |
| MSIX, Squirrel, per-user ClickOnce installers | v1.x |
| ARM64 build | v1.x |
| 802.1X Wi-Fi, shift hours | v1.x, v2 |

---

## 3. Prerequisites

### 3.1 Reading list (in this order)

1. `CLAUDE.md`.
2. `docs/prd.md` Sections 6, 6.2, 7.3, 10, 12, 13, 14, 16, 21, 22, 23, 24, 25.
3. `docs/plans/phase-5-lockdown.md`: rules, 4.5 (guard), 4.9 (allow-list),
   4.14 (rings), Step 14b, Sections 16, 19, 21.
4. `docs/plans/phase-4-dashboard-state.md`: install engine sections
   (lines ~1235-1322) and Step 14 (~4354).
5. `docs/plans/post-phase-5-architecture-and-io.md`: 1.6 (measurement),
   2.13 (budgets), Section 6 (storage), A21, owner decisions (~1291).
6. This file's Section 4, then the step you are on.

### 3.2 What exists today (checked against the code on 2026-11-14)

| Area | State | Anchor |
|---|---|---|
| Installer | `apps/installer/` does not exist. No WiX, no signing, no CI release | — |
| Service install | CLI only. "The MSI does this in Phase 6" | `apps/agent/src/service.rs:3` |
| Guard | `require_test_machine()` reads `HKLM\SOFTWARE\Rulebox\TestMachine`. "There is no bypass" | `crates/rulebox-win32/src/guard.rs:1-34` |
| Compat | Blockers `os_too_old`, `s_mode`, `managed_device`, `no_other_admin`, `legal_notice`, `shell_binary_missing`; warnings `low_disk`, `arm64_untested`. No WebView2, no protection level | `apps/agent/src/compat.rs:19-50`, `:113-155` |
| RAM constant | Two copies of 4,352 MB | `apps/agent/src/compat.rs:17`, `apps/agent/src/agent.rs:51-52` |
| App version | None. "New version" means the installer SHA-256 changed | `apps/agent/src/installs/engine.rs:690` |
| Missing exe | An installed app whose exe is gone is installed again | `engine.rs:724-730` |
| EXE exit codes | 3010 / 1641 count as success only for MSI; the dashboard sends `[0]` | `installs/mod.rs:323-332`, `apps/dashboard/src/screens/AppEdit.tsx:179` |
| Install timeout | One constant, 30 min, detail `timeout` | `installs/mod.rs:35`, `engine.rs:992-995` |
| Allowed install programs | `System32\msiexec.exe` or `<downloads>\<sha256>.exe|.msi` only | `installs/mod.rs:199-217` |
| `InstallSpec` | kind, url, sha256, size_bytes, silent_args, product_code, success_exit_codes, remove_when_unassigned | `crates/rulebox-policy/src/catalog.rs:107-122` |
| Install report | app_id, state, app_revision, attempts, exit_code, detail. No version | `installs/report.rs:31-40` |
| `installResults` | One row per device and app, indexes `by_device_app` and three more | `convex/schema.ts:780-801` |
| AppLocker for catalogue apps | Path rule on the exe folder, only if admin-only | `apps/agent/src/lockdown/allowlist.rs:477-497` |
| Exceptions | `Publisher`, `Hash`, `Path`, with `app_id` | `crates/rulebox-policy/src/lockdown.rs:403-451` |
| Web app launch | Built-in WebView2 window only, one profile per employee | `apps/staff-app/src-tauri/src/webapp/mod.rs:98-109`, `:137-203` |
| Machine registry roots | 9 roots, no Chrome or Edge; count pinned by a test | `crates/rulebox-win32/src/machinereg.rs:37-47`, `tests/guard_coverage.rs:248-250` |
| IPC | Protocol 1.3 | `crates/rulebox-ipc/src/lib.rs:47-60` |
| Drivers (Phase 5 Step 14b) | **Not built.** `pnputil.exe` is on the Staff deny list | `allowlist.rs:110` |
| Feeds | No `latest.json` or minisign code anywhere | — |
| Crons | `cleanup`, `reconcile counters`, `security rollup` (daily), `presence sweep` (5 min) | `convex/crons.ts` |
| Aliases | `devices:heartbeat`, `devices:desiredState`, `deviceApi:reportAudit`, `deviceApi:reportInstalls` | `convex/devices.ts:257`, `convex/deviceApi.ts:616`, `:628` |
| Hosting | No upload code. Design in post-phase-5 Section 6 | — |

### 3.3 Hand-off from earlier phases

- **Phase 2:** three late fixes are unit-tested only (exit-hold timing,
  kill-on-close job, `recover` for LSA auto sign-in owners). Re-check in
  Step 22. Release builds must not enable demo employees.
- **Phase 3:** laptop-only checks (second monitor, sleep and resume, touch
  keyboard, brightness and volume sliders, camera, downloads, two-employee
  web logins) and the unrun rows of `VM-CHECKLIST-3.md`. Step 26.
  Minimum WebView2 version 125.
- **Phase 4:** Q3 branding on devices ("Phase 6 polish"); Q4 installer
  uploads. Aliases.
- **Phase 5 (Section 16):** release guard answer; publisher rules for
  Rulebox once signed; compat reuses `read_security_posture` and the
  AppLocker / App Control probes; budgets re-measured on a 4 GB laptop with
  real Wi-Fi and a real printer; USB rows E-66..E-69 on real hardware; Home
  edition results; whether AppLocker reaches SYSTEM-started processes.

### 3.4 Ordering against Phase 5

Phase 5 code work runs in the same tree. Phase 6 steps need:

| Phase 6 step | Needs from Phase 5 |
|---|---|
| 4 (types) | Step 1 (policy types), Step 12 (IPC 1.3) |
| 11 (engine) | Step 9 (reports), Step 16 (rings) |
| 15 (drivers) | Step 14 (printers). Step 14b is built **here** if Phase 5 has not built it |
| 17 (browser policies) | Steps 3, 4, 7 (staffreg, L1, AppLocker) |
| 22-24 (VM runs) | Steps 21 and 22 done (the Pro VM passes the Phase 5 checklist) |
| 26-27 (pilot) | Phase 5 Step 23 closed |

Steps 3, 5-9, 13 and 19 do not wait for Phase 5.

---

## 4. Architecture and contracts

### 4.1 Owner decisions (locked for this plan, 2026-11-14)

| # | Decision |
|---|---|
| D-a | Each desktop app has an **update mode**: Pinned, Vendor self-update, or Rulebox-managed |
| D-b | Managed updates are resolved **on the server**. A bounded, scheduled Convex action reads the vendor feed (first kind: Tauri `latest.json`), verifies its minisign signature with the vendor public key stored on the app, and publishes the new version (URL + SHA-256 + version) into the **signed desired state**. The agent installs at the next boot before staff sign-in, or when the app is closed, and reports the installed version on the existing `installResults` upsert (write on change). Rings and rollback reuse desired state. Zahras POS is the first test app: per machine in Program Files, in-app updater off |
| D-c | Vendor self-update is allowed by **publisher** (an automatic exception tied to the app) or by a path rule on an admin-only folder. The engine must not fight it. "Minimum version" semantics are in 4.4.3 |
| D-d | The installer is **one hand-authored WiX v7 MSI** (agent service + Staff App, per machine). Not Tauri's MSI target. CI records the OSMF EULA acceptance. The PRD gets a note about the fee at US$10,000 a year of revenue |
| D-e | Rulebox's own builds are signed through **SignPath (free for open source)**. Customer apps may be unsigned: path rules on admin-only folders |
| D-f | The agent (SYSTEM) updates the Staff App. Never `tauri-plugin-updater` in the Staff session |
| D-g | A web app may open in **Chrome or Edge** (Built-in is the default). `--app=` with a per-employee `--user-data-dir`. Not `--kiosk`. Policies come from the signed desired state. Lite mode falls back to built-in. The PRD edits are a step (Step 1) and need owner sign-off |
| D-h | Wizard installers: detect the technology on URL add or upload and pre-fill silent switches; answer-file support; "needs interaction" on timeout; driver EXE → INF option. The TPCL driver is the VM test case |
| — | **Not decided:** installer hosting (Q1) |

### 4.2 Data model (Convex)

Changed validators (`convex/lib/validators.ts`), all new fields optional so
old rows stay valid (no migration):

```ts
// desktopSpec gains:
version?: string                       // ≤ 40 chars, the version this install delivers
update?: {
  mode: "pinned" | "vendor" | "managed",
  // vendor
  publisher?: string,                  // Authenticode subject, ≤ 200
  publisherProduct?: string,           // optional product name, narrows the rule
  minVersion?: string,
  // managed
  feed?: { kind: "tauri", url: string, pubkey: string, target: string },
  autoPublish?: boolean,               // default true (Q3)
  applyWhen?: "boot_or_signed_out" | "when_closed",   // default boot_or_signed_out
  rollbackOnFail?: boolean,            // default true
}
previous?: { version: string, url: string, sha256: string, sizeBytes: number }  // one step back

// installSpec gains:
tech?: "msi" | "nsis" | "inno" | "burn" | "installshield_msi"
     | "installshield_script" | "advanced_installer" | "exe"
answerFile?: { url: string, sha256: string, sizeBytes: number }   // ≤ 256 KiB
timeoutMin?: number                    // 5..120, default 30
publisher?: string                     // expected signer of the installer file (optional check)

// webSpec gains:
browser?: { kind: "builtin" } | { kind: "edge" } | { kind: "chrome", appId: Id<"apps"> }
```

New table (tiny: one row per managed app):

| Table | Fields | Indexes |
|---|---|---|
| `appFeeds` | `orgId`, `appId`, `nextCheckAt`, `lastCheckedAt`, `status: "ok" \| "unreachable" \| "bad_signature" \| "bad_feed" \| "too_large" \| "downgrade" \| "paused"`, `failures` (consecutive), `etag?`, `seenVersion?`, `pending?: { version, url, sha256, sizeBytes, foundAt }`, `revision` | `by_next_check [nextCheckAt]`, `by_app [appId]` |

Changed table: `installResults` gains `installedVersion: v.optional(v.string())`.
No new index. `devices` (or the device settings row that already holds
rarely-changed settings; pick it in Step 19) gains
`displayMode?: "auto" | "standard" | "lite"`; `groups` gains the same plus
`webWindowCap?` and `webIdleCloseMin?`.

Drivers follow Phase 5 Step 14b (a `driver` app kind beside `apps.ts`).
Phase 6 adds `source: "inf_zip" | "vendor_exe" | "vendor_exe_extract"` (4.8).

### 4.3 Desired-state additions (format stays `rulebox.desired/2`)

- `DesktopSpec`, `InstallSpec` and `WebSpec`
  (`crates/rulebox-policy/src/catalog.rs`) gain the fields of 4.2 as
  `Option<…>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
  The Phase 4 and Phase 5 vectors stay byte-for-byte equal (a test pins it).
- Every new enum (`UpdateMode`, `ApplyWhen`, `InstallTech`, `BrowserKind`,
  `FeedKind`, `DisplayModeOverride`, driver `source`) uses
  `unknown_on_new_values!`. `Unknown` behaves as the safe value: mode →
  pinned, browser → built-in, tech → plain exe, display mode → auto.
- The feed URL and public key are **not** sent to devices. The device gets
  only the resolved `version`, `url`, `sha256`, `sizeBytes` (rule 3).
- Browser policies are **not** a new document section. The agent derives
  them from the catalogue (web apps with a browser, their domains and
  permissions). One source of truth, nothing to drift.
- Agent-only keys (`AgentDoc`): `displayMode`, `webWindowCap`,
  `webIdleCloseMin`, `browserUploads` (group switch), and, if Step 20 is
  built, `ruleboxRelease { version, url, sha256, sizeBytes }`.
- Capability reporting (Phase 5 D9) gains `updateModes`, `browsers`,
  `answerFile`, `drivers`. An old agent ignores the new keys and behaves as
  pinned / built-in. The dashboard shows "this PC's agent is too old for
  …" from the capability list. No server-side filtering.
- Limits (`check_limits`): answer file ≤ 256 KiB; ≤ 60 browser web apps per
  device; combined browser URL patterns ≤ 800 (hard browser limit is
  1,000); version strings ≤ 40 chars, `[0-9A-Za-z.+-]`.

### 4.4 Update modes

#### 4.4.1 Versions

- `desktop.version` is free text for Pinned (display only) and **must be
  ordered** for Vendor (`minVersion`) and Managed. Ordering: dotted numeric
  parts, up to four, compared as numbers; a `-suffix` sorts before the same
  version without one (semver). Anything else is "not ordered" and refused
  for those two modes (`version_not_ordered`). One comparison function in
  Rust (`rulebox-policy`) and one in TypeScript, sharing a vector file.
- **Installed version on the device** = the file version resource of the
  app's exe (read-only Win32 call, new `Platform::file_version`). If the
  exe has none, the version the engine last installed. Reported as
  `installedVersion`.

#### 4.4.2 Pinned (today's behaviour, unchanged)

A different SHA-256 means install again. A missing exe means install again.
Chrome and Edge cannot be Pinned: their system updater ignores update
policies on workgroup PCs. The form forces Vendor for them (4.9.7).

#### 4.4.3 Vendor self-update (D-c)

The installer in the catalogue is a **bootstrap**. After it, the vendor's
own updater owns the version.

| Situation | Engine behaviour |
|---|---|
| Not installed | Install the bootstrap (same as Pinned) |
| Installed, catalogue SHA-256 changes | **Nothing.** No reinstall. The record keeps the new values for later |
| Installed, exe not found at reconcile | Local state `verifying` (not reported). Look again at the next two reconcile occasions, at least 15 min apart, and never while a process signed by the app's publisher is running as SYSTEM. Still missing → install the bootstrap again |
| `minVersion` set and installed version is lower | At the next apply window (4.4.5) run the current bootstrap. The server refuses a `minVersion` above the bootstrap's `version` (`min_above_bootstrap`) |
| Installed version higher than the bootstrap | Nothing. Rulebox never downgrades a vendor-mode app |
| Installed version changes by itself | Reported once (`installedVersion`), on change |

Rules:

- Vendor mode **requires a publisher** (`vendor_mode_needs_publisher`). An
  unsigned app that updates itself cannot be allowed safely: use Managed or
  Pinned.
- The agent checks the bootstrap's Authenticode signer against `publisher`
  before running it (`publisher_mismatch`), with
  `rulebox_win32::fileid::file_identity`.
- **Automatic exception:** the allow-list compiler
  (`lockdown/allowlist.rs`) adds, for every assigned vendor-mode app, a
  `Publisher { subject, product? }` rule for the Staff SID with that
  `app_id`. It feeds AppLocker, procwatch and findings like any exception
  (Phase 5 D2). It never reaches App Control (Phase 5 D3). It disappears
  when the app is unassigned.
- The validator refuses a publisher rule whose subject is a Windows
  platform signer (`Microsoft Windows`, `Microsoft Corporation`) without a
  `publisherProduct` (`publisher_too_broad`). The dashboard warns for every
  publisher that the rule covers all programs signed by that publisher.
- The updater itself runs as SYSTEM (a service or task), where AppLocker's
  Staff rules do not apply (**confirmed S-5, S-6, 2026-11-25**: Chrome's and
  Edge's updaters run only as SYSTEM in session 0; Staff-only rules logged
  nothing for a SYSTEM-started program, enforced or audit). An updater that
  starts in the Staff session is covered by the publisher rule. Keep the
  Phase 5 allow rule for administrators and SYSTEM anyway: with it present,
  a SYSTEM process start can still be logged as "allowed" (8002).
- Catalogue values seen in S-5 (Chrome 158, Edge 158): Chrome `subject`
  `Google LLC` (browser, `Google Chrome`, and updater, `Google Updater (x86)`,
  share the subject; the updater lives in a versioned folder
  `Google\GoogleUpdater\<ver>\updater.exe`). Edge `subject`
  `Microsoft Corporation`, so it needs `publisherProduct`: `Microsoft Edge`
  (browser) and `Microsoft Edge Update` (updater). WebView2's
  `elevation_service.exe` also says `Microsoft Edge`.
- **Exe that moves into a versioned folder:** the exe template may contain
  **one** `*` as a whole folder segment, never the first segment, never the
  file name (for example `{ProgramFiles}\Vendor\App\app-*\app.exe`). The
  agent resolves it to the highest version by the ordering of 4.4.1 and
  sends the resolved path over IPC. The path rule is on the folder above
  the `*`, which must be admin-only.

#### 4.4.4 Rulebox-managed (D-b)

```
vendor feed ──(server, scheduled, bounded)──► appFeeds.pending
     │                                              │ autoPublish or Approve
     ▼                                              ▼
 verify signature, size, version      apps.desktop.{version,install}  → revision+1
                                                    │ snapshotGroupConfig (Phase 5 4.14)
                                                    ▼
                         signed desired state (pilot ring first, if rings are on)
                                                    ▼
             agent: download, SHA-256, install in an apply window, detect, report
```

- The app is installed per machine in Program Files. Its own updater is
  off (the vendor's job; for Zahras POS the owner builds it that way).
  If it is left on, its update attempt fails harmlessly: it would need
  admin rights or a program start from a writable folder, and both are
  refused in the Staff session. The dashboard help says so.
- `previous` keeps the last version's installer coordinates. **Roll back**
  on the app page swaps `previous` and current under a new revision. With
  rings, the Phase 5 group rollback does the same through the group config.
- The server never moves a version **down** by itself (`downgrade`).
  A feed that lists a lower version than the current one is ignored and
  shown.

#### 4.4.5 Apply windows (updates only; first installs run at once as today)

An update of an app that is already installed runs only when one of these
is true:

1. **Boot:** the agent started less than 10 minutes ago and no employee has
   signed in yet. The Staff App sign-in screen shows "Updating apps…" and
   holds sign-in for at most **5 minutes**, then lets the employee in.
2. **Signed out:** no employee is signed in.
3. **Closed** (only with `applyWhen: "when_closed"`): an employee is signed
   in but no process of the app runs. The tile shows "Updating…" and cannot
   be started until the install ends.

The download happens earlier, in the background. The agent never closes a
running app to update it. A device that is never restarted and never signed
out shows "Waiting for the app to close (n days)" on the dashboard.

#### 4.4.6 Managed Installer: evaluated, not used

Microsoft: "App Control, based on managed installer, doesn't support
applications that self-update." It also over-authorises (everything a
long-lived SYSTEM agent writes would be trusted), needs AppLocker services
enforcement for EXE and DLL (unknown effect on SYSTEM under the existing
rules), and works on the OS volume only. Rulebox does not need it:
catalogue apps live under admin-only folders that the optional App Control
`allowlist` level already allows by path. **Decision P5: do not make the
agent a Managed Installer.** If a later version wants it, use a separate,
short-lived installer helper EXE as the only Managed Installer.

### 4.5 Feed resolver (server)

Files: `convex/feeds.ts`, `convex/lib/feed/{tauri.ts,minisign.ts,version.ts}`.

1. **Tick.** `crons.interval("feed tick", { hours: 1 }, internal.feeds.tick)`.
   The mutation reads `appFeeds.by_next_check` with `nextCheckAt ≤ now`,
   `.take(10)`. For each row it sets `nextCheckAt = now + 24 h + jitter
   (0-60 min)`, `lastCheckedAt = now` (the claim), and schedules
   `internal.feeds.check({ feedId })`. No due rows → **0 documents read**.
2. **Check** (internal action, default runtime):
   - Load the feed row and the app (`feeds:loadForCheck`, 2 reads).
   - `fetch(feed.url)` with `If-None-Match`, https only (redirects too),
     10 s timeout, body ≤ 64 KiB. `304` → done, no write.
   - Parse `latest.json`: `version`, `platforms[target].url`,
     `platforms[target].signature`. Whole file validated first.
     Lookup order `windows-x86_64-nsis`, then `windows-x86_64` (or the
     admin's `target`).
   - Version not higher than the app's → done (`ok`, write only if `etag`
     or `status` changed).
   - Download the installer as a stream, https only, cap **512 MiB**
     (`too_large` above it). Compute **SHA-256** and the **BLAKE2b-512**
     prehash in one pass (`@noble/hashes`, already in the dependency
     family). Verify the minisign signature (Ed25519, `@noble/curves`)
     with `feed.pubkey`. Mismatch → `bad_signature`, nothing published,
     audit `app.feedRejected`.
   - `feeds:recordResult` stores `pending` and, with `autoPublish`, calls
     the same internal publish path as `apps:update`.
3. **Failures.** `unreachable` backs off: next check after 1 h, 4 h, then
   24 h. After 7 consecutive failures the app page shows a warning. A
   failing feed never changes the app.
4. **Check now** (`feeds:checkNow`, admin action, rate limit 1 per 5 min
   per app) runs the same check.
5. **Approve / Dismiss** (`feeds:approve`, `feeds:dismiss`) when
   `autoPublish` is off.
6. **Pause** is a field on the app (`update.mode` stays `managed`,
   `appFeeds.status = "paused"`, `nextCheckAt` far in the future).

Why this is not a polling loop: it is one bounded scheduled function per
hour for the whole deployment, it reads zero rows when nothing is due, and
no device takes part. Budget in 4.16.

**(unverified)** Convex action limits for a streamed 512 MiB download
(time 10 min, memory 64 MiB in the default runtime): Step 12 measures with
a 100 MiB test file on the dev deployment and lowers the cap if needed.
**(unverified)** exact minisign encoding of Tauri's `signature` and
`pubkey` fields (base64 of the `.sig` / `.pub` file text, prehashed
algorithm `ED`): Step 12 pins it with a vector made by `tauri signer sign`.

### 4.6 Install engine changes (agent)

| Change | Detail |
|---|---|
| Journal | `installs.json` schema 1 → 2: record gains `version`, `installed_version`, `mode`, `previous { sha256, ext, version }`, `verifying_since`. Schema 1 files load with defaults. An older agent refuses a schema 2 file and changes nothing (same rule as the Phase 5 journal) |
| Upgrade test | `record.sha256 != spec.sha256` restarts only when mode is Pinned or Managed (today `engine.rs:690`) |
| Missing exe | Pinned / Managed: as today. Vendor: `verifying` grace (4.4.3) |
| Apply window | Upgrades wait for a window (4.4.5). The engine asks the session layer "employee signed in?" and procwatch's process table "is this exe running?". No new timer: it re-evaluates on boot, sign-in, sign-out, process exit of that exe, and desired-state change |
| Previous installer | On an upgrade the old `<sha256>.<ext>` is **kept** (one per app) until the new version has been detected and the Staff App was healthy for one sign-in. Total kept ≤ 2 GiB, and nothing is kept when free disk < 3 GiB |
| Rollback on failure | Managed + `rollbackOnFail`: installer fails, or detection fails → run the previous installer once. Result `failed`, detail `update_rolled_back` (old version works) or `rollback_failed`. MSI packages cannot install over a newer version: uninstall by the new product code first when it is known, else `rollback_unsupported` |
| Update retries | An update that failed is retried at the next apply window, at most 3 times (1 h apart at least), then final until a new revision or `apps:retry` |
| Detection | Exe exists (as today) **and**, when `version` is ordered, file version ≥ `version` (`version_too_low` otherwise; a warning for Pinned, a failure for Managed) |
| EXE reboot codes | 3010 / 1641 count as success-with-restart for EXE **when listed** in `successExitCodes`. The server pre-fills them per technology (4.7) |
| Timeout | Per app `timeoutMin` (5-120). On timeout the agent looks at the dead process tree: CPU time in the last 5 min < 1 s, or a top-level window on the service desktop → detail `needs_interaction`, else `timeout` |
| Per-user installer | Exit code says success, exe not found, and a file with the exe's name exists under `%WINDIR%\System32\config\systemprofile\AppData` **or `%WINDIR%\SysWOW64\config\systemprofile\AppData`** (depth ≤ 4, read-only) → detail `installed_per_user`. S-9 (2026-11-25): a 32-bit NSIS stub (Tauri, Zahras POS Dev 1.0.2) run as SYSTEM is redirected to the `SysWOW64` profile (`…\AppData\Local\Zahras POS Dev\zahras-pos-desktop.exe`, depth 3) while its `HKU\.DEFAULT` uninstall entry says `system32`; never trust that path for removal |
| Answer file | Downloaded and verified like the installer, stored `<data>\downloads\<sha256>.iss`. `{AnswerFile}` and `{LogFile}` are the only tokens expanded inside `silentArgs`. The data path has no spaces, so no quoting is needed inside `/f1…` |
| Allowed programs | Adds `System32\pnputil.exe` with **fixed** argument shapes (4.8). Nothing else. Still no PowerShell, no shell |
| Report | `installedVersion` added to the payload; sent only when it or the state changed |
| New details | `needs_interaction`, `installed_per_user`, `publisher_mismatch`, `update_rolled_back`, `rollback_failed`, `rollback_unsupported`, `version_too_low`, `waiting_for_close`, `answer_file_failed`, `driver_unsigned`, `protected_print_on`. Each goes into **both** lists: `installs/mod.rs:86-125` and `INSTALL_DETAILS` in `convex/lib/deviceApiRules.ts:139` |

### 4.7 Wizard installers (D-h)

**Detector** (`convex/lib/installerDetect.ts`, pure function, bytes in,
result out; no I/O, so it runs in an action, in the browser and in tests):

| Technology | Marker (confidence) | Pre-filled switches | Pre-filled success codes |
|---|---|---|---|
| MSI | OLE compound-file magic (H) | none needed (`msiexec /qn /norestart`) | engine default |
| NSIS | PE manifest `Nullsoft.NSIS.exehead` / description first word `nullsoft` (H/M) | `/S` | 0 |
| Inno Setup | manifest description first word `inno` (H) | `/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` | 0 |
| WiX Burn | `.wixburn` PE section / description `wix` (H/L) | `/quiet /norestart` | 0, 3010, 1641 |
| InstallShield Basic MSI | InstallShield strings + embedded MSI (L) | `/s /v/qn` | 0, 3010, 1641 |
| InstallShield InstallScript | InstallShield strings, no MSI (L) | `/s /f1{AnswerFile}` and "needs an answer file" | 0 |
| Advanced Installer | Advanced Installer strings (L) | `/exenoui /qn /norestart` | 0, 3010, 1641 |
| Unknown EXE | — | empty, with the note "ask the vendor for silent switches" | 0 |

Also returned: claimed signer subject (parsed from the certificate table,
display only; the device does the real check), `requestedExecutionLevel`
from the manifest (NSIS + `asInvoker` → warning "this may be a per-user
installer", **heuristic, unverified**), file version, product name.

**Where the bytes come from:**

- **URL source:** `apps:inspectInstaller({ url })` (admin action). Up to
  three HTTP Range requests: the first 2 MiB, the PE certificate table,
  the last 64 KiB. Total ≤ 4 MiB. https only, same URL rules as the
  engine. A host without Range → `inspect_unsupported`, the form stays
  manual. No database write.
- **Local file (optional, Q9):** "Check a file on this computer" in the app
  form reads the file in the browser, computes SHA-256 incrementally
  (`@noble/hashes`, lazy chunk) and runs the same detector. Nothing is
  uploaded. It only fills the form; the device still verifies.
- **Hosted source (if Q1 brings hosting in):** the scanner calls the same
  detector.

The admin can always edit the result. Pre-fill never overwrites a field
the admin already typed.

**Observed (S-10, S-11, 2026-11-25), the TPCL package:** an InstallShield
**InstallScript** setup (`data1.cab` + `data1.hdr`, no `.msi`) whose exe
still contains MSI strings (`IsScript.msi`, "Launching MSI prerequisite",
the launcher help "For silent mode use: /S /v/qn"). So "InstallShield
strings + embedded MSI" must mean an actual embedded `.msi` stream or file,
never an `.msi` string; otherwise this package is mis-filled as Basic MSI.
Run as SYSTEM with `/s /v"/qn /norestart"` (or `/S /V"/a …"`) it exits by
itself in about 45 s with `-2147213312` (0x80042000), no window, nothing
installed, and `setup.log` `ResultCode=-5` (no usable answer file). Treat
that exit code on an InstallShield app as "needs an answer file", not as a
generic failure. **`/s /f1` with a recorded `.iss` (second run, same day):**
exit 0 and `ResultCode=0` in about 30 s with no window, but the driver was
**not** added unless the Seagull publisher certificate was in
`LocalMachine\TrustedPublisher` first (see 4.8). Exit code and `ResultCode`
alone cannot tell a driver package's success.

**Observed (X-1, 2026-11-25), BIXOLON POS driver 5.2.3 (Inno Setup):** the
Inno row's switches run silently as SYSTEM and return 0, yet the package's
own driver setup inside it fails (-1, in the Inno log only) and nothing is
installed. Vendor driver packages wrapped in Inno or InstallShield can
report success without a driver: for a driver, success means "the INF is in
the store" (`inf_zip`, 4.8), never the wrapper's exit code.

**Answer file:** a second URL + SHA-256 (+ size) on the app. `.iss` only,
≤ 256 KiB. The dashboard text explains how to record one on a test PC. The
answer file is in the signed document like the installer.

### 4.8 Drivers (builds on Phase 5 Step 14b)

If Phase 5 has not built Step 14b when Step 15 starts, build it here under
its Phase 5 text. Phase 6 adds:

| Source | What the agent runs | When to use |
|---|---|---|
| `inf_zip` | Unpack the zip (zip-slip guard, ≤ 2,000 entries, ≤ 1 GiB unpacked) into `<data>\drivers\<sha256>\`, check every `.cat` is validly signed, then `pnputil /add-driver <inf> /subdirs /install` | **Preferred.** The admin extracts the vendor package once on a test PC |
| `vendor_exe` | The vendor EXE or MSI with its silent switches (and answer file), through the normal engine | When the vendor installer has a real silent mode |
| `vendor_exe_extract` | The vendor EXE with fixed extract arguments into `<data>\drivers\<sha256>\`, then the `inf_zip` path on the result | **Not built** (S-10, 2026-11-25): the TPCL package documents no extract switch, `/S /V"/a …"` fails with `ResultCode=-5`, and its wizard unpacks only InstallScript cabinets, no `.inf`/`.cat` |

**TPCL route after S-10/S-11 (both runs, 2026-11-25):** the driver is
Authenticode-signed by **Seagull Software, LLC, not WHQL**, so Windows adds
it only when that publisher is in `LocalMachine\TrustedPublisher`
(otherwise setupapi `0xE0000242`, and the hand install shows a "trust this
publisher?" prompt). `Get-AuthenticodeSignature` still says the `.cat` is
`Valid`, so the catalog check passes and pnputil fails later. Proven routes,
both as SYSTEM and windowless, **once the certificate is trusted**:
(1) `vendor_exe` with `/s /f1"<answer file>"` (recorded `.iss`, `ResultCode=0`);
(2) `inf_zip` from the files a silent install leaves in `C:\TEC_DRV`
(`TOSHIBATEC.inf`, `toshibatec.cat`, the package ships `SeagullPublisher.cer`
there too). Without the trust step both fail, (1) silently with exit 0.
Adding a publisher to the machine's TrustedPublisher store is a security
decision (it trusts every driver that publisher signs): **owner decision**,
not built. Until then the agent must treat a non-WHQL driver package as
`driver_untrusted_publisher` (new detail, Step 15) instead of reporting a
pnputil failure.

**Removal order (X-1):** `pnputil /delete-driver <oemN.inf> /uninstall`
fails with `0xE000023D` while the spooler still has a printer driver from
that INF. Remove the printers that use it and the printer driver
(`DeletePrinterDriverEx`) first, then pnputil. Step 15's removal does not do
this yet.

Rules: no tile; `pnputil` argument shapes are fixed in code (`/add-driver
<path> /subdirs /install`, `/delete-driver <oemN.inf> /uninstall`); removal
only for packages Rulebox added (journalled); 3010 → "restart needed".

Warnings (read-only probes, shown on the driver's install row):

- **Windows Protected Print Mode on** → printer drivers are refused with
  `protected_print_on` (Windows would remove third-party-driver printers).
  Values (S-12, 2026-11-25, build 26300), all REG_DWORD under HKLM; any one
  at 1 means on:
  - `SYSTEM\CurrentControlSet\Control\Print` `WindowsProtectedPrintState`:
    the effective state (1 on, 0 off, absent = never turned on). Read first.
  - `SOFTWARE\Policies\Microsoft\Windows NT\Printers\WPP`
    `WindowsProtectedPrintMode`: written by the Settings switch (1 on, 0 off;
    `EnabledBy`, `EnabledTimestamp` beside it while on).
  - Same key, `WindowsProtectedPrintGroupPolicyState`: written by the Group
    Policy "Configure Windows protected print" (1/0, from `Printing.admx`;
    the policy route was not driven on the VM, **unverified** whether it also
    sets `WindowsProtectedPrintState`).
  `EnableWindowsProtectedPrint` and `Control\Print\WPP\EnabledNow` do not
  exist on this build.
- **Another Seagull-based driver already present** → warning
  `seagull_driver_present` (Toshiba TEC manuals say not to mix them and to
  remove the old TPCL driver before an upgrade). Not a blocker.
- INF-only installs may miss the vendor's port or status monitor
  **(unverified, Step 23)**. X-1: BIXOLON's INF registers its own print
  processor and language monitor, so for that package nothing was missed.

### 4.9 Web apps in Chrome or Edge (D-g)

#### 4.9.1 Model

- `web.browser`: `builtin` (default), `edge`, or `chrome` with the id of a
  Chrome app in the catalogue (so the agent knows the exe and that it is
  installed). Edge uses its fixed per-machine paths.
- The Staff App picks at launch: **Lite mode → built-in. Browser exe
  missing → built-in.** The dashboard says so next to the setting.
- **Below 8 GB RAM, browser mode is off by default** (S-4, 2026-11-25:
  first `--app` window 305 MB for Chrome, 397 MB for Edge, summed working
  set; the Section 14 rule is "> 350 MB for either browser"). The Staff App
  then picks built-in unless the admin turns browser mode on for that group
  on purpose; the dashboard shows the measured cost.

#### 4.9.2 Launch

The Staff App asks the existing launcher service
(`taskops.rs:135` path, never ShellExecute) to start, as the Staff user:

```
<browser exe> --app=<start URL> --user-data-dir=<profile> --no-first-run
              --no-default-browser-check --disk-cache-size=52428800
```

- The arguments are built by Rulebox from validated fields. No admin text
  reaches the command line except the https start URL.
- Profile: `%LOCALAPPDATA%\dev.rulebox.staff\browser\<chrome|edge>\<employeeId>`.
  One profile per employee and browser, so web apps of one employee share a
  browser process and single sign-on cookies, like built-in mode.
- No `--kiosk`. No other switch (WebView2's own guidance: production apps
  should not rely on browser flags).

#### 4.9.3 Policies

Written by the agent from the catalogue, journalled (Phase 5 rule 3),
removed when the last browser web app (and any Chrome app) is unassigned
and on Disable kiosk.

**Where (decision P6, Q5):** the **Staff hive** first:
`Software\Policies\Google\Chrome` and `Software\Policies\Microsoft\Edge`
through `staffreg` (two new roots; `guard_coverage` Staff count 16 → 18, the
plan said 12 → 14 before Phase 5 Step 18 added four). The
administrator's own browser stays normal, which matches "the admin account
is not affected". `HKCU\Software\Policies` is not writable by a standard
user. **Confirmed by S-1 (2026-11-25, Chrome 158 and Edge 158, workgroup
PC, no MDM):** both list the Staff-hive values as Platform / Current user /
Mandatory / OK and enforce them (blocked page, DevTools refused); the Staff
account has only `ReadKey` on the keys. The machine-key fallback is not
needed. Both browsers then say "managed by your organization".

**Re-read at Step 17 (2026-11-25)** for **Chrome 159** (stable 159.0.8154.34;
read from Chromium's `policy_definitions` on `main`, because Google's rendered
policy pages carry no text for automated readers) and **Edge 160** (Microsoft
Learn, pages updated 2026-05 to 2026-11). Lists are **subkeys** of the policy
root (`URLBlocklist\1`, `\2`, ...) with REG_SZ values; "list" below means that.
Values are DWORDs unless noted. Restart column: the vendor says the value is
read only at browser start.

| Policy (Chrome / Edge) | Value | Restart | Note |
|---|---|---|---|
| `URLBlocklist` (list) | Chrome: `*`, `chrome://*`, `file://*`, `view-source:*`, `javascript:*`, `data:*`, `ftp://*`. Edge: the same with `edge://*` | no | From Chrome 147 `*` no longer covers `chrome://`. Both vendors warn that blocking the internal pages "can cause errors" (Microsoft: "not recommended"); Step 24 checks the window still works and the row goes if it does not. Custom schemes are covered by `*`. 1,000 entries at most. Do not block `chrome-untrusted://` |
| `URLAllowlist` (list) | `https://host[:port]` for the start host and every allowed domain of each assigned browser web app and for the `browserSites` of a Chrome or Edge program; `*.x` is written as `x` (a host pattern already covers subdomains) | no | ≤ 800 patterns per device (limit 1,000). Allowlist wins over blocklist. Not written when empty (the browser then shows its blocked page) |
| `DeveloperToolsAvailability` | 2 | no | Also controls "view page source" (Chrome and Edge ≥ 99) |
| `DownloadRestrictions` | 3 (all blocked) | no | Deviation from PRD 24.1 (Q6) |
| `AllowFileSelectionDialogs` | 0, or 1 when the group's `browserUploads` is on | no | Off breaks uploads |
| `IncognitoModeAvailability` / Edge `InPrivateModeAvailability` | 1 | Chrome: yes | |
| `BrowserGuestModeEnabled` | 0 | no | |
| `BrowserAddPersonEnabled` / Edge `BrowserAddProfileEnabled` | 0 | no | Different names |
| `BrowserSignin` | 0 | yes | |
| `SyncDisabled`, `PasswordManagerEnabled` | 1 / 0 | no | Confirmed |
| `ExtensionInstallBlocklist` (list) | `*` | no | Confirmed (`*` is the documented value) |
| `PrintingEnabled` | 1 only if some assigned browser web app allows printing, else 0 | no | Global, not per app. **Changed:** not gated on "printers exist" (a policy that allows printing with no printer does nothing, and the agent has no printer read in this layer) |
| `VideoCaptureAllowed`, `AudioCaptureAllowed` | 0 | no | **Changed:** the plan's "defaults set to block" has no default-setting policy (Chrome's `DefaultMediaStreamSetting` is deprecated, Edge has none). With these off, capture is available only to the `*AllowedUrls` origins, without a prompt |
| `VideoCaptureAllowedUrls`, `AudioCaptureAllowedUrls`, `NotificationsAllowedForUrls` (lists) | `https://[*.]host[:port]/` of the apps whose camera, microphone or notification permission is on | no | Per origin, so per app. `*` is not supported |
| `DefaultGeolocationSetting`, `DefaultNotificationsSetting`, `DefaultClipboardSetting` | 2 (block) | no | Edge's unset notification default is "allowed" (Chrome: "ask"), so it is set. Clipboard policy: Chrome ≥ 103, Edge ≥ 109 |
| `ScreenCaptureAllowed` | 0 | no | Screen sharing stays blocked in v1 |
| `AutoLaunchProtocolsFromOrigins` | **not written** | no | **Changed:** a JSON list; the vendors document no empty value, only "not configured" (no protocol launches without a prompt). External schemes are in the blocklist anyway |
| `ExternalProtocolDialogShowAlwaysOpenCheckbox` | 0 | yes | |
| `BackgroundModeEnabled` | 0 | no | Memory, and no process after the last window closes |
| Edge `StartupBoostEnabled` | 0 | no | |
| Edge `ConfigureKeyboardShortcuts` (REG_SZ JSON) | `{"disabled":[...]}` with `new_window`, `new_inprivate_window`, `downloads`, `history`, `favorites`, `view_source`, `open_file`, `save_page`, `task_manager`, `clear_browsing_data`, `profile` | yes | **Changed:** Edge has no command id for "settings"; Chrome has no such policy. The shortcut only removes the key, the UI still works |
| Edge `SleepingTabsEnabled`, `EfficiencyModeEnabled` | 1 | no | Memory; effect on `--app` windows not stated (VM). **Added** for Chrome: `HighEfficiencyModeEnabled` 1 (memory saver) |

Every policy name and value was re-read from the vendors' references at
Step 17 (above). The catalogue is one data table in code
(`apps/agent/src/lockdown/browser.rs`, `FIXED_ROWS`, plus the rows that depend
on the document) with a test per row.

**Reload:** registry writes are picked up by a running browser within 15
minutes at worst, and some values only after a restart. Measured in S-2
(2026-11-25): Edge about 10.5 min, Chrome about 13.5 min, policy page and
blocklist both live with no click; Chrome flags `IncognitoModeAvailability`
"Restart required" (Edge `InPrivateModeAvailability` applied live). Only
the "allow" direction was timed; Step 24 times the restricting one. So the agent
writes policies **before** the Staff App may show a browser tile: the IPC
snapshot marks a browser web app `ready` only after the write is
journalled as applied. Policy changes while a browser runs take effect at
the next employee sign-in at the latest (the agent closes Staff apps at
sign-out).

#### 4.9.4 Allow-list

For each assigned browser, the allow-list compiler adds the browser's
install folder as a path rule for the Staff SID (`Program Files
(x86)\Microsoft\Edge\Application`, Chrome's folder from the Chrome app),
only if admin-only. Edge is no longer blocked for Staff once an Edge web
app is assigned. That is acceptable because the policies apply to **every**
window of that browser in the Staff account, not only to `--app` windows.
Edge 158 also ships `msedge.exe` under `Microsoft\EdgeCore\<ver>\` and
`EdgeCore\Optimized\`; the windows launched from `Edge\Application\msedge.exe`
ran from `Edge\Application` (S-5), so the path rule stays on that folder.

#### 4.9.5 Task tracking

Tasks map by exe path today (`tasks.rs:101`), so two web apps in one
`chrome.exe` collide. Plan:

- **Primary:** map each top-level browser window to its app by the
  window's AppUserModelID (Chromium gives every `--app` window an id built
  from the app URL and profile). **Confirmed by S-3 (2026-11-25):**
  `Chrome.<host>_<path>.<user-data-dir leaf>.<profile>` and
  `MSEdge.<host>_<path>.…`, e.g. `Chrome.example.org_/.e1.Default`; stable
  across close and reopen; both windows share one pid; one taskbar button
  each. Visible top-level browser bubbles (Edge's "Translate page") have
  **no** AUMID: skip windows without one, never map them to an app.
- **Fallback:** one profile per employee **and app**
  (`…\browser\chrome\<employeeId>\<appId>`), so each app is its own process
  tree and maps by the launched process. Costs memory and loses shared
  sign-in between apps. Used only if the primary fails on the VM.

#### 4.9.6 Profiles and cleanup

- The agent deletes an employee's browser profiles when the employee is
  removed from the roster and when "reset on logout" is set for the app.
- Per device, keep the 10 most recently used employee profiles per browser;
  delete older ones at boot, and more when free disk < 3 GiB.
- Deletion runs only when the browser is not running (boot, sign-out).
- Browser profile bytes do **not** count toward the employee's file quota
  (PRD 8). They show as "browser data" on the device page figures the
  agent already reports, if any; no new report.

#### 4.9.7 Chrome or Edge as a normal app

A desktop app whose exe is `chrome.exe` or `msedge.exe` is recognised by
the server (`browser_app`). It gets a "Browser rules" card: an allowed
sites list (≤ 200). The same policy catalogue applies. Its update mode is
forced to Vendor with the vendor's publisher. Without any allowed site it
opens to the browser's blocked page.

#### 4.9.8 What browser mode cannot do (shown in the dashboard)

- Rules are per browser, not per app: app A's window can reach app B's
  allowed sites. Printing, uploads and downloads are one switch for all.
- No Rulebox "not allowed" screen and no blocked-request counters.
- No downloads in v1.
- More memory (4.14). Not available in Lite mode.

### 4.10 The MSI (D-d)

`apps/installer/` (new): `Package.wxs`, `Service.wxs`, `StaffApp.wxs`,
`UI.wxs`, `Checks.wxs`, `rulebox.wixproj` or a `wix build` script,
`README.md`, `build.ps1`.

- **Per machine**, x64, `C:\Program Files\Rulebox\` with the PRD 23.3
  layout (`rulebox-agent.exe`, `rulebox-shell.exe`, `current.json`,
  `versions\<v>\`), `THIRD_PARTY_NOTICES.md`, licence.
- **Service:** `ServiceInstall` (own process, auto start, Vital) +
  `ServiceControl`; `util:ServiceConfig` **nested under `ServiceInstall`**
  (restart on first, second and third failure, reset after 1 day, 5 s
  delay). The MSI leaves Windows' default service DACL and no privilege
  list; the agent sets both only while a lockdown policy is applied (L7,
  Phase 5 Step 17), not at every start (Step 22 run A).
- **Upgrade:** `MajorUpgrade Schedule="afterInstallInitialize"` (a failed
  upgrade rolls back to the old version) with a `DowngradeErrorMessage`.
  Only three version fields count.
- **Launch conditions** (no script or EXE custom actions): administrator
  (`Privileged`), x64, build ≥ 19045 read by `RegistrySearch` of
  `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` `CurrentBuildNumber`
  (`VersionNT` stops at 8.1 values; S-7 on build 26300: `VersionNT` 603 and
  `WindowsBuild` 9600, so neither property can be used). One clear message
  each. **No free-disk condition (Step 22 run A):** `PrimaryVolumeSpaceAvailable`
  was 0 at LaunchConditions in the UI and silent installs, with or without
  `PrimaryFolder`, so "≥ 2 GiB" refused every install. Windows Installer's
  own costing refuses files that do not fit; the 2 GB headroom is the compat
  report's `low_disk` warning in Rulebox Setup.
- **Uninstall guard:** while the kiosk is on, a condition blocks removal
  with "Turn kiosk mode off first" (reads `HKLM\SOFTWARE\Rulebox\Install`
  `KioskOn`, which the agent keeps). It does not apply during a major
  upgrade (`UPGRADINGPRODUCTCODE`). `rulebox-agent recover` still works
  whatever the MSI state.
- **Install marker:** the MSI writes `HKLM\SOFTWARE\Rulebox\Install`
  (`InstallDir`, `Version`, `ComputerName` filled by the agent at first
  start) for the production guard (4.11).
- **UI:** WixUI (custom-action-free since v6): welcome, licence, install,
  finish. The finish page starts **Rulebox Setup** (4.10.1) unless the
  install is silent.
- **Silent install:** `msiexec /i Rulebox.msi /qn ENROLLCODE=<code>`.
  `ENROLLCODE` is a `Hidden` property (kept out of the property lines of
  a log). It is written to `HKLM\SOFTWARE\Rulebox\Install\Pending` with an
  ACL of SYSTEM and Administrators only (`MsiLockPermissionsEx`, no custom
  action: **confirmed** in Step 22 run A); the agent reads it at start,
  enrolls, deletes it. **Differs (run A):** a verbose log (`/l*v`) still
  prints the code in the `RegAddValue` line; open question Q-A1 in
  `phase-6-vm-results.md`.
- **WebView2:** the MSI installs Microsoft's Evergreen **bootstrapper**
  (about 1.8 MB, SHA-256 pinned at build time) into the install folder.
  It does not run it. Setup or the agent runs it (`/silent /install`) only
  when the runtime is missing or below version 125 (Q4). Windows 11 always
  has the runtime.
- **OSMF:** WiX v7 refuses to run until its EULA is accepted. The CI
  workflow accepts it in a visible, commented step and
  `apps/installer/README.md` records who accepted, when, and the rule that
  a fee is due once revenue from projects that use WiX reaches US$10,000 a
  year. **(unverified: the exact accept command; Step 7 reads the WiX v7
  docs.)**

#### 4.10.1 Rulebox Setup (compatibility result and enrollment)

`rulebox-agent.exe setup` (admin, elevated by the installer's finish
page, or run later from the Start menu shortcut). A small **native** window
(the same Win32 toolkit as the launcher's fallback screen; **no WebView**):

1. Shows the compatibility report: blockers in plain words, warnings, the
   protection level (4.12), WebView2 state.
2. Installs WebView2 if missing (progress line; needs internet).
3. Takes the enrollment code, enrolls, shows the result.
4. Says what happens next (kiosk turns on, how to get back).

Console mode stays: `rulebox-agent compat`, `rulebox-agent enroll <code>`.

### 4.11 Production guard (blocker, Phase 5 Section 16)

Today every mutating call needs the test-machine marker, so a release build
on a customer PC can do nothing. New rule, in `rulebox-win32/src/guard.rs`
only:

```
require_armed_machine() =
     test marker matches this computer                     (dev and VM builds, as today)
  OR ( built with the cargo feature `production`
       AND this is not a debug build
       AND HKLM\SOFTWARE\Rulebox\Install exists and InstallDir equals the folder of the running exe
       AND that folder is admin-only (the existing DACL check)
       AND ComputerName in the marker equals this computer )
```

- The `production` feature is turned on **only** in the release workflow
  (Step 9). `cargo build`, `cargo test`, `pnpm dev:staff` never set it. A
  test fails if the workspace default features contain it.
- The install marker is written only by the MSI. The dev machine never
  installs the MSI (rule 1), so it has neither marker.
- `require_test_machine()` stays for test-only helpers (demo employees,
  simulate flags). **Release builds refuse demo employees** even with the
  test marker.
- A copy of the release exe run from another folder fails the `InstallDir`
  check.
- After SignPath is live (Q2): add "the running exe carries Rulebox's
  signature" as a fifth condition for stable-channel builds.
- The guard module's header comment ("There is no bypass") is rewritten to
  describe the two doors. This changes a Phase 2 statement: tell the owner
  (Section 18).

### 4.12 Compatibility check (PRD 14)

`apps/agent/src/compat.rs` gains (all read-only):

| Field | Source | Result |
|---|---|---|
| `webview2: { present, version, source }` | `pv` under `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` (and the per-user key); missing, empty or `0.0.0.0` = absent | Warning `webview2_missing` (Setup installs it); blocker `webview2_too_old` only if < 125 after the install attempt |
| `protection: "full" \| "reduced"` + `layers` | Edition + the Phase 5 probes (`read_security_posture`, AppLocker and App Control capability) | `reduced` when L3 or L4 is unavailable (Phase 5 Q12: enrollment allowed with a badge) |
| `browsers: { edge, chrome }` | exe exists at the per-machine paths | Information for the app form |
| `protectedPrint` | 4.8 | Warning `protected_print_on` |
| `low_ram` | RAM < 3,072 MB | Warning (below the target hardware) |

The report stays ≤ 32 KB and is still sent **once at enrollment** and when
it changes (no periodic write). The dashboard device page shows the level
and the reasons. The single RAM constant moves to `rulebox-ipc`
(`LITE_MAX_RAM_MB`), used by `agent.rs` and `compat.rs`.

### 4.13 Code signing (D-e)

- **SignPath Foundation** (free for open source): apply in Step 9. It
  needs a public repository, an OSI licence, builds from a hosted CI, and a
  code-signing policy page **(requirements from memory, unverified: read
  the current terms when applying)**. Lead time is unknown: the laptop
  pilot (Step 26) may run unsigned; the group pilot (Step 27) should not
  (Q2).
- Signed: `rulebox-agent.exe`, `rulebox-shell.exe`, the Staff App exe and
  its DLLs, the MSI. Timestamped.
- The certificate's subject will be SignPath's, **not** "Rulebox"
  **(unverified)**. So Rulebox's own publisher rules must include the
  **product name and file name**, never the publisher alone. The Phase 5
  invariant **path** rules stay (dev builds are unsigned); publisher rules
  are added, not swapped in. This differs from Phase 5 Section 16 ("replace
  the invariant path rules"): tell the owner.
- SmartScreen: a new certificate still warns for "several weeks and
  hundreds of clean installs". The install guide tells admins what they
  will see. Smart App Control blocks unsigned files: compat reports it if
  it can be read **(unverified)**.
- Customer apps stay unsigned-capable: path rules on admin-only folders
  (Phase 5 edge case 13).
- The Tauri update signing key (PRD 23.8) is created in Step 9 and kept in
  CI secrets, even though the Staff App does not self-update.

### 4.14 Lite mode tuning (PRD 22)

| Item | Change |
|---|---|
| RAM constant | One, in `rulebox-ipc` |
| Admin override (PRD 22.5) | `displayMode: auto \| standard \| lite` per group and per device (device wins). Agent-only key; the agent computes the effective mode and sends it in the IPC snapshot as today. Forcing `standard` on a ≤ 4 GB PC shows a warning in the dashboard |
| Web window cap | Open web app windows: Lite default **3**, Standard default **8**, group setting 1-12. At the cap the Staff App asks which window to close. It never closes one silently |
| Idle close (PRD 22.4) | A web app window that has been minimised or hidden, silent and without input for `webIdleCloseMin` (Lite default 30, Standard off, range 5-240, 0 = off) is closed. Its tile keeps a "paused" mark; opening it starts at the app's start URL. One coarse timer in the Staff App (once a minute). Never a window that plays audio, shares a camera or microphone, or has an open file picker |
| Browser web apps | Lite → built-in (4.9.1). In Standard, browser windows count toward the cap; idle close does not apply to them in v1 |
| Compressed wallpaper | A smaller wallpaper file for Lite, generated at build time |
| WebView2 flags | Stay **off** (Phase 3 measured them; Microsoft: "Apps in production shouldn't use WebView2 browser flags"). Keep the documented `MemoryUsageTargetLevel` / `TrySuspend` pair already in use |
| Measurements | Section 14, on the 4 GB laptop |

### 4.15 IPC protocol 1.4 (agent ↔ Staff App)

Additive (minor bump 1.3 → 1.4):

- `WebApp.browser: BrowserKind` (+ `browser_exe`, `browser_ready`).
- `AppEntry.update: Option<AppUpdateState>` (`updating`, `waiting_for_close`).
- `DesktopApp.exe` is the **resolved** path (4.4.3).
- Snapshot: `web_window_cap`, `web_idle_close_min`, `display_mode_source`
  (`auto | group | device`).
- Notification `apps.updating { count, until }` for the sign-in screen
  (4.4.5), request `browser.profileReset` is **not** added (the agent
  cleans profiles itself).
- Compatibility tests both ways: a 1.3 Staff App against a 1.4 agent
  (unknown fields ignored, browser apps open built-in), and a 1.4 Staff App
  against a 1.3 agent (fields absent → defaults). `methods.rs:153` pins
  `(1, 4)`.

### 4.16 Convex functions, I/O budget and authorization

Counts include the member wrapper (3 reads for viewer queries, 4 for admin
mutations; see `convex/ioBudgets.ts` header). All are **ESTIMATES** until
`ioBudgets.test.ts` measures them. Each row needs its `IO_BUDGETS` entry
and its `tests/convex/matrixRows.ts` row in the same step.

| Function | Kind / caller | Index and bound | Reads | Writes | Re-runs / frequency |
|---|---|---|---|---|---|
| `apps:createDesktop`, `apps:update` (changed) | admin mutation | + `db.get` of the Chrome app for `browser.chrome`; + `appFeeds.by_app` unique when mode is or was Managed | existing + ≤ 2 | existing + ≤ 1 (`appFeeds` upsert or delete) | per edit |
| `apps:createWeb` (changed) | admin mutation | + `db.get` (Chrome app) | existing + 1 | existing | per edit |
| `apps:get` (changed) | viewer query, **live** | + `appFeeds.by_app` unique, only for Managed apps | existing + 1 | 0 | re-runs when the feed row changes: ≤ 2 a day per open app page |
| `apps:inspectInstaller` (new) | admin action | no table read beyond authorization; rate limit 30 per hour per org | 4 | 0 | per click |
| `apps:rollbackVersion` (new) | admin mutation | `db.get` app | as `apps:update` | as `apps:update` | rare |
| `feeds:tick` (new) | internal mutation, cron hourly | `appFeeds.by_next_check`, `nextCheckAt ≤ now`, `.take(10)` | ≤ 10, **0 when nothing is due** | ≤ 10 | 24 runs a day for the whole deployment |
| `feeds:loadForCheck` (new) | internal query | `db.get` feed, `db.get` app | 2 | 0 | once per check |
| `feeds:recordResult` (new) | internal mutation | `db.get` feed, `db.get` app | 2 (+ publish path on a new version) | 0 when nothing changed; 1 on a status or etag change; publish path on a new version | once per check |
| `feeds:check` (new) | internal action | sum of the two above | 4 | ≤ 1 typical | **≤ 1 a day per managed app** |
| `feeds:checkNow` (new) | admin action | authorization + the check | 8 | ≤ 1 | rate limited, 1 per 5 min per app |
| `feeds:approve`, `feeds:dismiss` (new) | admin mutation | `db.get` feed, `db.get` app, `expectedRevision` | as `apps:update` / 6 | as `apps:update` / 2 | rare |
| `deviceApi:report` (changed) | device mutation | unchanged (`installResults.by_device_app`) | unchanged | unchanged; `installedVersion` rides the existing upsert, **written only when it differs** | per install state or version change |
| `apps:installs`, `apps:installSummary` (changed) | viewer query | unchanged | unchanged | 0 | returns `installedVersion` |
| `groups:update` (changed), `fleet:setDisplayMode` (new) | admin mutation | `db.get` | 5 | 3 (row, audit, publish queue) | rare |
| `drivers:*` | per Phase 5 Step 14b | `.withIndex`, paginated list | as apps | as apps | per edit |
| Removed | `devices:heartbeat`, `devices:desiredState`, `deviceApi:reportAudit`, `deviceApi:reportInstalls` | rows deleted from `IO_BUDGETS`, `matrixRows.ts`, `ioInternal.ts` | — | — | — |

Rules applied:

- `appFeeds` is never subscribed directly by a list. Only `apps:get` reads
  one row. The Apps **list** shows "update available" from a small field
  on the app row (`updateFlag?: "available" | "feed_error"`), written only
  when it changes, so `apps:list` gains no read.
- No `.collect()`, no `.filter()`. `by_next_check` is a range read with
  `.take(10)`. If more than 10 feeds are due, the rest wait for the next
  hour (fine at pilot size; raise the bound with the budget row).
- The agent keeps its single subscription. Nothing new is subscribed.

**Writes per day (estimate, to be measured in Step 25):**

| Flow | Writes |
|---|---|
| Managed app, no new version | 1 per app per day (the claim), 0 when paused |
| Managed app, new version | claim + result + the normal publish (same as an admin edit) |
| Device, app updated | 2 per app update (pending is skipped for upgrades: terminal only, with `installedVersion`) |
| Device, vendor app updated itself | 1 per app per version change |
| Device, nothing changed | **0** |
| Browser policies | 0 (they ride the Phase 5 apply report, change-driven) |
| Lite override | 1 publish per change |

### 4.17 Rulebox's own updates (minimal, gated by Q8)

Until the PRD 23.4 flow exists, pilot PCs need fixes without a visit.

- Agent-only key `ruleboxRelease { version, url, sha256, sizeBytes }`, set
  per organization by the owner (self-host: a setting; later the channels
  of PRD 23.6). Signed like everything else.
- The agent downloads the MSI, checks SHA-256 and, once signing is live,
  the Authenticode signer; in an apply window with **no employee signed
  in**, it starts `msiexec /i <msi> /qn /norestart` **outside** its
  kill-on-close job, so the upgrade survives the service stopping. The MSI's
  `afterInstallInitialize` upgrade rolls back by itself on failure.
- After the restart the agent reports its version (it already does). A
  version that failed is not retried until a new release.
- The Staff session never sees a prompt (D-f). No `versions\` switching,
  no employee "Restart Rulebox" button: those stay v1.x.

### 4.18 File layout (new and changed)

```
apps/installer/                         new: WiX sources, build script, README (EULA record)
.github/workflows/release.yml           new: build, EULA step, SignPath, artifacts
apps/agent/src/compat.rs                WebView2, protection level, browsers
apps/agent/src/setup/                   new: Rulebox Setup window, WebView2 bootstrap
apps/agent/src/installs/{engine.rs,mod.rs,report.rs,version.rs,answer.rs,probe.rs}
apps/agent/src/drivers/                 (Phase 5 14b) + inf zip, extract
apps/agent/src/lockdown/browser.rs      new: browser policy catalogue
apps/agent/src/lockdown/allowlist.rs    publisher rule per vendor app, browser folders
apps/agent/src/selfupdate.rs            new, only if Q8 = yes
crates/rulebox-win32/src/{guard.rs,staffreg.rs,fileid.rs,version.rs}
crates/rulebox-policy/src/{catalog.rs,version.rs,paths.rs}
crates/rulebox-ipc/src/{lib.rs,types.rs,requests.rs}
apps/staff-app/src-tauri/src/{taskops.rs,tasks.rs,browserapp.rs,webapp/idle.rs}
convex/{feeds.ts,apps.ts,deviceApi.ts,crons.ts,schema.ts,ioBudgets.ts}
convex/lib/{installerDetect.ts,feed/*,validators.ts,appRules.ts,desired.ts,deviceApiRules.ts}
apps/dashboard/src/screens/AppEdit.tsx  + update card, browser picker, inspect, answer file
docs/prd.md                             Step 1 only, after sign-off
docs/guides/install.md, docs/guides/pilot.md     new
docs/plans/phase-6-{vm-results,io-results,pilot-report}.md   written by the VM and pilot steps
```

### 4.19 Dependencies

| Dependency | Where | Note |
|---|---|---|
| WiX Toolset v7 (.NET tool) | CI; optional locally | Needs the .NET SDK. **Warn the user before a local install** (several hundred MB). Prefer CI builds |
| `@noble/hashes`, `@noble/curves` | `convex/` (already used for seal vectors), dashboard lazy chunk | No new package family |
| A small zip reader crate | agent | For `inf_zip`. Pick one with no default compression extras; check its size |
| No new Rust crate for minisign | — | The device does not verify feeds |
| Offline WebView2 bootstrapper | build-time download, SHA-256 pinned in the repo | About 1.8 MB inside the MSI |

Exact versions are recorded in Step 0 and the final report.

---

## 5. Steps

Machine column: **dev** = dev machine, safe (SimPlatform, convex-test,
Vitest, fixtures, file outputs under `target\` / `.tmp\`). **VM** = the
Hyper-V VM `rulebox-test-pro`, **the user runs it**. **Laptop** = the real
4 GB laptop, **the user runs it**. **CI** = GitHub Actions.

| Step | What | Machine | Depends on | Touches |
|---|---|---|---|---|
| 0 | Preflight, show Sections 18 and 19 | dev | — | nothing |
| 1 | PRD edits, after owner sign-off | dev | 0 | `docs/prd.md` |
| 2 | VM spike: twelve observations that decide open designs | **VM** | 0 | nothing in the repo |
| 3 | Clean-up: remove aliases, one RAM constant | dev | 0 | `convex/`, agent, `rulebox-ipc` |
| 4 | Types: policy fields, version ordering, IPC 1.4, `gen:types` | dev | 1, Phase 5 Steps 1, 12 | `rulebox-policy`, `rulebox-ipc`, `packages/types` |
| 5 | Production guard | dev | 3 | `rulebox-win32`, agent |
| 6 | Compatibility check: WebView2, protection level, browsers | dev | 3 | agent, `convex/`, dashboard device page |
| 7 | MSI authoring | dev (sources), CI or VM (build) | 5, 6 | `apps/installer/` |
| 8 | Rulebox Setup window, WebView2 bootstrap, enrollment hand-off | dev | 6, 7 | agent |
| 9 | Release pipeline: CI build, EULA record, SignPath, update key | CI | 7, 8 | `.github/`, docs |
| 10 | Server and dashboard: versions and update modes | dev | 4 | `convex/`, dashboard |
| 11 | Agent engine: versions, modes, apply windows, rollback, version report | dev | 4, 10, Phase 5 Steps 9, 16 | agent, `rulebox-win32` |
| 12 | Server: feed resolver | dev | 10 | `convex/` |
| 13 | Installer inspection, pre-filled switches, answer file (server, dashboard) | dev | 10 | `convex/`, dashboard |
| 14 | Agent: answer file, EXE reboot codes, timeout detail, per-user detection | dev | 11, 13 | agent |
| 15 | Drivers (Phase 5 14b if missing, plus INF zip and warnings) | dev | 14, 2, Phase 5 Step 14 | `convex/`, dashboard, agent |
| 16 | Browser web apps: server and dashboard | dev | 1, 4 | `convex/`, dashboard |
| 17 | Browser web apps: agent policies, allow-list, journal | dev | 16, 2, Phase 5 Steps 3, 4, 7 | agent, `rulebox-win32` |
| 18 | Browser web apps: Staff App launch, task mapping, profile cleanup, Lite fallback | dev (demo + simulate) | 17 | Staff App, agent |
| 19 | Lite tuning: override, window cap, idle close, wallpaper | dev | 4 | `convex/`, dashboard, agent, Staff App |
| 20 | Rulebox's own update through the MSI (only if Q8 = yes) | dev | 9, 11 | agent, `convex/` |
| 21 | Installer hosting (only if Q1 = b) | dev | 13 | `convex/`, dashboard, agent |
| 22 | VM run A: MSI, guard, compat, WebView2, upgrade, uninstall | **VM** | 5-9 | nothing new |
| 23 | VM run B: update modes, wizard installers, TPCL driver | **VM** | 10-15, 22 | nothing new |
| 24 | VM run C: browser web apps, Section 6 rows | **VM** | 16-18, 22 | nothing new |
| 25 | I/O measurement on the lab project (A21, 1.6) | owner (lab deployment) | 3, 10-12 | results file |
| 26 | Pilot 1: one real 4 GB laptop | **Laptop** | 22-25, Phase 5 closed | pilot report |
| 27 | Pilot 2: a small group through rings | **Laptops** | 26 | pilot report |
| 28 | Wrap-up | dev | 27 | docs |

Rules for every step (Phase 4 and 5 rules apply, plus):

- Verify only what you touched: `cargo clippy -p <crate> --all-targets -- -D warnings`,
  `cargo test -p <crate>`, `pnpm test:convex`,
  `pnpm --filter @rulebox/dashboard typecheck|lint|test`,
  `pnpm --filter @rulebox/staff-app typecheck|lint|test`.
- Convex: dev deployment only, `npx convex dev --once`. Never
  `npx convex deploy` (Step 25 is the one exception, on the lab project,
  run by the owner).
- No release build on the dev machine before Step 22 needs one, and then
  prefer the CI artifact. Run `cargo clean --release` afterwards.
- UI steps are not done until you ran the screen and looked at it
  (light and dark, 1280×800 and 390×844 for the dashboard; Lite for the
  Staff App; into `.tmp/phase6/`).
- No `unwrap()` / `expect()` outside tests. Every new `unsafe` lives in
  `rulebox-win32` with a `// SAFETY:` comment.
- Every new log line and report field is checked against rules 5 and 6 of
  Phase 5 (no secrets, no URLs or titles from the Staff session) by a test.
- Dashboard: Solar icons only (`-linear`, active `-bold-duotone`), no
  component library, no GSAP, lists server-side.

---

### Step 0 — Preflight (stop if anything fails)

**Machine:** dev (read-only). **PRD:** —.

1. Record tool versions, free space on D: and C:, size of `target\`,
   `git status --short`, `git log --oneline -8`.
2. **Disk:** stop below **10 GB** free on D:. Tell the user what Phase 6
   may download: the .NET SDK + WiX (only if building the MSI locally), one
   release build (+1-3 GB in `target\`), nothing else.
3. **Phase 5 status:** record which Phase 5 steps are committed. List the
   Phase 6 steps blocked by 3.4.
4. Confirm the dev machine has **no** test-machine marker and **no**
   `HKLM\SOFTWARE\Rulebox\Install` key. If either exists, stop and tell
   the user. Do not delete anything.
5. Re-check the anchors of 3.2 that the next steps rely on (files move).
6. Show the user Section 19 (open questions) and Section 18 (PRD changes)
   and wait. Record the answers here and in `docs/plans/README.md`.
   **Recorded:** Section 19 answers 2026-11-14 (all recommended options,
   see Section 19); Section 18 approved in full 2026-11-19 (see "Updates
   since this plan was written").

**Done when:** all recorded; the user answered Section 19.
**Do NOT:** start a step whose prerequisites are missing.

---

### Step 1 — PRD edits (owner sign-off first)

**Machine:** dev. **PRD:** 6, 6.2, 6.3, 7.3, 12.3, 13.1, 13.5, 14, 16,
22.4, 22.5, 23.2, 24.1, 24.2. **Files:** `docs/prd.md` only.

1. Apply exactly the rows of Section 18 the owner approved. Mark each
   changed paragraph "(changed 2026-11, Phase 6)" like the Phase 4b edits.
2. Do **not** touch Section 21.1 (locked decisions). If the owner wants a
   Decision 20 for browser web apps or update modes, the owner writes it.
3. Rows the owner rejected: record in "Updates since this plan was
   written" and remove the matching steps (16-18 for the browser rows).

**Done when:** the PRD and this plan agree; the owner confirmed the diff.
**Do NOT:** start Steps 16-18 before the D-g rows are signed off.

---

### Step 2 — VM spike (the user runs it; no Rulebox code)

**Machine:** VM, from a fresh checkpoint, reverted afterwards. **PRD:** —.

Hand-run observations that decide designs. The implementing agent writes
`docs/plans/phase-6-vm-spike.md` with the exact things to look at and a
result table; the user fills it in. Each row is an **observation**, not an
attack.

| # | Observe | Decides |
|---|---|---|
| S-1 | With policy values in the Staff account's `Software\Policies\Google\Chrome` (and Edge), does the browser's policy page list them as applied on a workgroup PC? | 4.9.3 Staff hive vs machine keys |
| S-2 | How long a changed value takes to show without a browser restart | 4.9.3 reload rule |
| S-3 | AppUserModelID of two `--app` windows of one profile | 4.9.5 primary vs fallback |
| S-4 | Working set of Edge and of Chrome with one and with three `--app` windows beside the Staff App | Section 14 budgets, Lite rule |
| S-5 | Signer subjects and install paths of Chrome's and Edge's updater; the account their updater runs as | 4.4.3 publisher values |
| S-6 | Whether a program started by a SYSTEM service is checked against the Staff AppLocker rules (Phase 5 Section 21 item) | 4.4.3, 4.8 |
| S-7 | `VersionNT`, `WindowsBuild` and the `CurrentBuildNumber` registry search in an MSI log on Windows 11 and Windows 10 | 4.10 launch conditions |
| S-8 | A Tauri NSIS installer (Zahras POS, per-machine build) run as SYSTEM with `/S`: where it installs, whether it starts the app, exit code | 4.4.4 |
| S-9 | The same with a per-user build: where the files land | 4.6 per-user detection |
| S-10 | `TPCL-drv_11.10.0_E.exe`: does it unpack with no window with the documented extract switch; which `.inf` and `.cat` files appear; are the catalogs signed; does `pnputil /add-driver … /install` add a usable printer driver | 4.8 source choice |
| S-11 | The same package with InstallShield silent switches, and with a recorded answer file | 4.7 InstallShield rows |
| S-12 | The registry value that shows Windows Protected Print Mode on and off | 4.8 warning |

**Done when:** every row has a result, or "could not observe" with the
reason. Sections 4.7-4.9 are updated where a result differs from the plan.
**Do NOT:** install anything on the dev machine; keep the VM state.

**Status (2026-11-25): run on `rulebox-test-pro` (build 26300), VM reverted
to `fresh-windows-11-pro`.** PASS: S-1, S-2, S-3, S-5, S-6, S-7 (Windows 11).
DIFFERS: S-4 (Edge over 350 MB), S-10, S-11, S-12. NOT OBSERVED: S-8, S-9
(no Zahras POS builds), S-11 answer-file run, S-7 Windows 10 half. Results
and evidence: `phase-6-vm-spike.md`, `phase-6-vm-spike/`.
**Second run (2026-11-25, owner's files):** S-9 DIFFERS (per-user files under
`SysWOW64\config\systemprofile`; agent search fixed); S-11 passes only with
the Seagull certificate trusted first (owner decision, 4.8); extra row X-1
(BIXOLON, Inno): wrapper reports success without a driver, `inf_zip` works,
removal needs the printer driver deleted first. Still NOT OBSERVED: S-8 (the
Zahras POS build is per-user only; a `perMachine` build is needed), S-7
Windows 10 half.

---

### Step 3 — Clean-up: aliases and the RAM constant

**Machine:** dev. **PRD:** 22.5. **Files:** `convex/devices.ts`,
`convex/deviceApi.ts`, `convex/ioBudgets.ts`, `tests/convex/{matrixRows.ts,ioInternal.ts}`,
`apps/agent/src/{agent.rs,compat.rs,backend/*}`, `crates/rulebox-ipc/src/types.rs`.

1. Grep the Rust client for the four alias names. Any call left moves to
   the new name first.
2. Delete `devices:heartbeat`, `devices:desiredState`,
   `deviceApi:reportAudit`, `deviceApi:reportInstalls`, their budget rows
   and matrix rows.
3. One `LITE_MAX_RAM_MB` in `rulebox-ipc`; both users import it.
4. Tests: the alias names are gone from the generated API (a test lists
   the device-callable functions); the constant has one definition (grep
   test).

**Verify:** `pnpm test:convex`; `cargo test -p rulebox-agent -p rulebox-ipc`.
**Done when:** green; `ioBudgets.test.ts` finds no orphan row.
**Do NOT:** remove an alias while any agent build in the tree still calls
it. The only enrolled devices are VMs; say so in the commit message.

---

### Step 4 — Types: policy fields, version ordering, IPC 1.4

**Machine:** dev. **PRD:** 10, 12.3. **Files:**
`crates/rulebox-policy/src/{catalog.rs,version.rs,paths.rs,lib.rs}`,
`crates/rulebox-policy/tests/{catalog.rs,vectors/version.json}`,
`crates/rulebox-ipc/src/{lib.rs,types.rs,requests.rs,methods.rs}`,
`packages/types/src/generated/*`.

1. Add the fields of 4.3. `unknown_on_new_values!` on every new enum.
2. `version.rs`: `parse`, `cmp`, `is_ordered`; vectors shared with the
   TypeScript twin (`convex/lib/feed/version.ts`).
3. `paths.rs`: the one-`*` exe template rule of 4.4.3 with `expand_exe`
   returning a pattern; refusals for `*` in the first segment, the file
   name, or twice.
4. `check_limits` additions (4.3). `check_args` accepts the two tokens
   `{AnswerFile}` and `{LogFile}` only.
5. IPC 1.4 (4.15) with both compatibility tests.
6. `pnpm gen:types`; commit the generated TypeScript.

**Verify:** `cargo clippy -p rulebox-policy -p rulebox-ipc --all-targets -- -D warnings`;
`cargo test -p rulebox-policy -p rulebox-ipc`; `pnpm gen:types`; `pnpm typecheck`.
**Done when:** green; the Phase 4 and Phase 5 document vectors serialize
byte-for-byte as before.
**Do NOT:** put the feed URL or key into anything a device receives; bump
the IPC major version.

---

### Step 5 — Production guard

**Machine:** dev. **PRD:** 12.2. **Files:**
`crates/rulebox-win32/src/guard.rs`, `crates/rulebox-win32/Cargo.toml`
(feature `production`), `crates/rulebox-win32/tests/guard_coverage.rs`,
`apps/agent/src/{agent.rs,config.rs}`.

1. Implement `require_armed_machine()` exactly as 4.11. Pure decision
   function `armed(inputs) -> Result` with the registry and path reads
   passed in, so every branch is unit-tested without touching the machine.
2. Replace the calls in mutating functions. `guard_coverage` now asserts
   that every mutating function calls `require_armed_machine` and that
   test-only helpers still call `require_test_machine`.
3. Release builds refuse demo employees: a compile-time `cfg` plus a
   runtime test.
4. Tests: feature off → install marker ignored; feature on + debug build →
   ignored; wrong `InstallDir`; writable install folder; other computer
   name; workspace default features do not contain `production`.

**Verify:** `cargo test -p rulebox-win32` (default features) and
`cargo test -p rulebox-win32 --features production` (unit tests only; no
machine change).
**Done when:** green; the dev machine still fails the guard in both builds
(add a new read-only subcommand `rulebox-agent guard-status` that prints
which condition failed; run it and paste the output).
**Do NOT:** create either marker; add an environment variable or command
line switch that opens the guard.

---

### Step 6 — Compatibility check

**Machine:** dev. **PRD:** 14, 13.2, 22.5. **Files:**
`apps/agent/src/compat.rs`, `apps/agent/src/platform/{mod.rs,windows.rs,sim.rs}`
(read-only methods), `convex/lib/compat.ts` (validation of the new
fields), dashboard device page, strings.

1. Add the fields of 4.12 through new **read-only** `Platform` methods.
2. `rulebox-agent compat` prints the level and the reasons in plain words.
3. Server: accept the larger report (still ≤ 32 KB), store as today. No
   new query: the device page already reads the report.
4. Dashboard: a "Protection" row (Full / Reduced, with the missing
   layers), WebView2 version, browsers found. No new subscription.
5. Tests: each field from `SimPlatform`; Home edition → `reduced`; missing
   WebView2 → warning, not blocker; report size.

**Verify / Done when:** agent and convex tests green; screenshots of the
device page in both themes.
**Do NOT:** decide "OS out of support" on the device (the backend does);
send the report periodically.

---

### Step 7 — MSI authoring

**Machine:** dev for the sources; the build runs in CI (Step 9) or on the
VM. **PRD:** 14, 23.3, 12.3. **Files:** `apps/installer/*`.

1. Author the package per 4.10. Read the WiX v7 docs for `ServiceInstall`,
   `util:ServiceConfig`, `MajorUpgrade`, `Launch`, `RegistrySearch` first.
2. `build.ps1` takes the built binaries' folder and a version, and writes
   one MSI under `target\installer\`. It never installs anything.
3. A static test (`apps/installer/tests/package.test.ts` or a Rust test)
   parses the `.wxs` files and asserts: per-machine scope, no `CustomAction`
   that runs a script or EXE, `ServiceConfig` nested under
   `ServiceInstall`, `afterInstallInitialize`, the upgrade code never
   changes, every file of the PRD 23.3 layout is listed, `ENROLLCODE` is
   hidden.
4. `apps/installer/README.md`: how to build, the EULA record, the fee note.

**Verify:** the static test. A real build only where WiX exists.
**Done when:** the static test passes and CI (Step 9) produces an MSI.
**Do NOT:** install WiX or the .NET SDK on the dev machine without asking;
run the MSI on the dev machine; use Tauri's MSI target; add VBScript or
JScript.

---

### Step 8 — Rulebox Setup, WebView2 bootstrap, enrollment hand-off

**Machine:** dev. **PRD:** 14, 9.1. **Files:** `apps/agent/src/setup/*`,
`apps/agent/src/main.rs` (subcommand), `apps/agent/src/enroll.rs`.

1. `rulebox-agent setup` per 4.10.1: native window, keyboard-only usable,
   readable at 200 % scaling, English strings in one table.
2. WebView2: run the bundled bootstrapper only after checking its SHA-256
   against the value compiled in; wait; re-read the version; report.
3. Pending enrollment code: read once, enroll, delete (also on failure
   after three tries, with a clear message in the event log).
4. Tests against `SimPlatform`: blockers stop enrollment; a missing runtime
   triggers the bootstrap call; a wrong bootstrapper hash refuses to run
   it; the pending code is deleted in every path.

**Verify:** `cargo test -p rulebox-agent`; a screenshot of the window in
simulate mode.
**Do NOT:** host a WebView in the agent; log the enrollment code; start
the kiosk from Setup before enrollment succeeded.

---

### Step 9 — Release pipeline

**Machine:** CI. **PRD:** 12.3, 23.8, 16. **Files:**
`.github/workflows/release.yml`, `docs/guides/release.md`, README section
"Code signing policy".

1. Workflow on a version tag: build the agent, launcher and Staff App in
   release with `--features production`, run the workspace tests, build the
   MSI, publish artifacts with SHA-256 sums.
2. A visible step accepts the WiX EULA (4.10) with a comment that links to
   the record.
3. Apply to SignPath (the owner does the application; the plan gives the
   text). Wire the SignPath action when approved; until then the workflow
   produces **unsigned** artifacts named `-unsigned`.
4. Create the Tauri update signing key; store it only as a CI secret.
5. After signing works: add Rulebox publisher rules (publisher + product +
   file name) beside the invariant path rules in `allowlist.rs` and the
   App Control sources, with tests on the generated XML.

**Done when:** a tag produces an MSI; the README names the signing policy.
**Do NOT:** commit a key or certificate; push or tag without the owner's
explicit go-ahead; drop the path rules.

---

### Step 10 — Server and dashboard: versions and update modes

**Machine:** dev. **PRD:** 6, 10, 12.3, 23.2. **Files:**
`convex/lib/{validators.ts,appRules.ts,desired.ts}`, `convex/apps.ts`,
`convex/schema.ts` (`appFeeds`, `installResults.installedVersion`),
`convex/ioBudgets.ts`, matrix rows, `apps/dashboard/src/screens/AppEdit.tsx`,
`apps/dashboard/src/lib/screenStrings/appEdit.ts`, the installs table.

1. Validators and `normalizeDesktop` rules: mode-specific required fields
   and the refusals of 4.4 (`vendor_mode_needs_publisher`,
   `publisher_too_broad`, `min_above_bootstrap`, `version_not_ordered`,
   `browser_app` forces Vendor).
2. `apps:update` keeps `previous` when the installer coordinates change in
   Managed mode. `apps:rollbackVersion` swaps them.
3. `appFeeds` row created, updated or deleted with the app (same mutation).
4. Publisher: the catalogue carries `update.mode`, `publisher`,
   `publisherProduct`, `minVersion`, `applyWhen`, `rollbackOnFail`,
   `version`. Never the feed.
5. Dashboard "Updates" card on the app form: three choices with one line
   of plain help each, the fields of the chosen mode, the feed status
   line (Step 12 fills it), "Roll back to <version>". Installs table gains
   an "Installed version" column (server-sorted like the others).
6. `deviceApi:report` accepts `installedVersion` and writes it only on
   change.
7. Tests: every refusal; an unchanged report writes nothing; budgets; the
   matrix (viewer cannot edit, another org cannot read).

**Verify:** `pnpm test:convex`; dashboard typecheck, lint, tests; screenshots.
**Do NOT:** add a query for the card (it rides `apps:get`); sort or filter
installs in the browser.

---

### Step 11 — Agent engine: versions, modes, windows, rollback

**Machine:** dev. **PRD:** 10, 13.5, 23.1. **Files:**
`apps/agent/src/installs/{engine.rs,mod.rs,report.rs,version.rs}`,
`apps/agent/src/lockdown/allowlist.rs`, `crates/rulebox-win32/src/version.rs`,
`apps/agent/src/platform/*`, `apps/agent/src/installs/engine_tests.rs`.

1. Journal schema 2 with the load-old test.
2. Mode-aware reconcile (4.6 rows "Upgrade test", "Missing exe").
3. Apply windows (4.4.5) driven by existing events. A test proves no timer
   or loop was added (the engine's wake sources are listed and asserted).
4. Keep-previous, rollback, update retries.
5. Version detection and `installedVersion` in the report queue.
6. Publisher check of the installer file; automatic publisher exception
   and the versioned-folder path rule in the allow-list compiler.
7. Tests (SimPlatform): every row of the 4.4.3 table; update while the app
   runs waits; boot window closes after 10 min; failed update rolls back
   and reports once; rollback of an MSI without a product code; low disk
   skips keep-previous; downgrade never happens in Vendor mode; a 1.3-era
   record upgrades cleanly; unknown mode behaves as Pinned.

**Verify:** `cargo clippy -p rulebox-agent --all-targets -- -D warnings`;
`cargo test -p rulebox-agent`.
**Do NOT:** close a running app; run an installer outside the allowed
program list; report progress states for upgrades (terminal only).

**Status (2026-11-21): done pending VM checks, uncommitted.** Notes:

- **Not built here (decided): the `apps.updating` event and the 5-minute
  sign-in hold ("Updating apps...").** They need the Staff App and the
  session hold, so Step 17/18 builds them. The engine only sets
  `AppEntry.update` (`Updating` / `WaitingForClose`). If Step 17/18 wants the
  engine to own the count of apps updating at boot, expose it from
  `InstallBook`.
- Windows apply to Pinned and Managed updates; a running app makes an update
  wait in every window; Vendor "occasions" are the existing reconcile
  triggers (no new timer).
- The six new install details (`publisher_mismatch`, `update_rolled_back`,
  `rollback_failed`, `rollback_unsupported`, `version_too_low`,
  `waiting_for_close`) are in `INSTALL_DETAILS` (`convex/lib/deviceApiRules.ts`)
  and in the Rust list (`details_are_exactly_the_servers_fixed_list`).
- Tests added at the end: rollback of an EXE (previous installer run again,
  no uninstall) and of a portable app (previous file placed again), a
  `Deferred` outcome with `applyWhen: when_closed`, and two updates at once
  (id order, one at a time; a running app holds back only its own update).
- Unverified until the VM (Step 22): file version read from real exes,
  process-exit wake, vendor updater signer scan, versioned-folder AppLocker
  rule.

---

### Step 12 — Server: feed resolver

**Machine:** dev. **PRD:** 10, 12.3. **Files:** `convex/feeds.ts`,
`convex/lib/feed/{tauri.ts,minisign.ts,version.ts}`, `convex/crons.ts`,
`convex/ioBudgets.ts`, `tests/convex/{ioInternal.ts,matrixRows.ts}`,
`convex/feeds.test.ts`, dashboard status line and Approve / Dismiss /
Check now buttons.

1. Implement 4.5. `fetch` is injected (tests stub it, as `lib/winget.ts`
   does). No test touches the network.
2. Vectors: a `latest.json`, an installer blob and a signature made once
   with `tauri signer sign`, checked into the test folder.
3. Measure one real check against a 100 MiB public test file on the dev
   deployment (the user approves the run); record time and memory; set the
   cap.
4. Tests: 304 writes nothing; same version writes nothing; bad signature;
   lower version (`downgrade`); missing platform key; redirect to http
   refused; body over the cap; the claim prevents a double check; 11 due
   feeds → 10 checked; paused feeds are skipped; `autoPublish` off stores
   `pending` only; two admins approve at once → `stale_edit`.
5. Budget rows and matrix rows for every function of 4.16. The cron's
   idle run is asserted to read 0 documents.

**Verify:** `pnpm test:convex`.
**Do NOT:** call the feed from a query or from the device; follow a
redirect to another scheme; store the downloaded installer; add a second
cron.

**Status (2026-11-21, uncommitted):** server side done. Files: `convex/feeds.ts`, `convex/lib/feed/{limits,minisign,tauri,fetch,resolve}.ts`,
`convex/crons.ts` (one `feed tick`), `convex/feeds.test.ts`, `tests/convex/feeds.ts`, vectors in `convex/testdata/feed/` (made with `tauri signer`,
tauri-cli 2.12.2: `signature` / `pubkey` are base64 of the `.sig` / `.pub` FILE text, algorithm `ED` = prehashed BLAKE2b-512, key id must match, the
global signature over the trusted comment is checked too). Choices made where the plan was silent: `platforms` lookup is `<target>-nsis` (`-msi` for an MSI
program) then `<target>`; `seenVersion` is the highest feed version processed (published, offered, dismissed, or rolled back from) and nothing at or below it is
downloaded again; `failures` counts consecutive checks that ended the same way (the backoff of 1 h / 4 h / 24 h applies to `unreachable` only); the etag is kept
after every outcome except `unreachable` (so a bad signature is not downloaded again until the vendor changes the file); a new version drops an MSI `productCode`
(it belongs to one version); extra admin function `feeds:setPaused` (plan 4.5 item 6 had no way to set the state); new audit action `app.feedRejected` (the
dashboard label in `screenStrings/audit.ts`, added below). Not done: the 100 MiB run on the dev deployment (the action's 10 minute / 64 MiB limits are unverified; the body is streamed and never held).

**Dashboard part (2026-11-21, uncommitted):** done. The feed status line of the app page (`AppUpdates.tsx`) has Approve / Dismiss (only while a version is offered; Approve is
disabled while the form has unsaved changes, and takes the returned revision like Roll back), Check now (off while paused) and Pause / Resume, admin only; a refusal is one
sentence under the line (`stale_edit`, `rate_limited`, paused `conflict`, nothing offered any more). Hooks `useApproveFeedUpdate`, `useDismissFeedUpdate`, `useCheckFeedNow`,
`useSetFeedPaused` in `data/` (live and `demo/feeds.ts`; the demo "finds" the next patch version once per app). `app.feedRejected` moved to the END of `AUDIT_ACTIONS`
(`convex/lib/audit.ts`) so `audit.test.ts` covers its label ("Vendor update refused"). **`updateFlag`** (4.16): optional `apps.updateFlag` (`"available"` while a version waits for
approval, `"feed_error"` for `bad_signature` / `bad_feed` / `too_large` or `unreachable` after 7 failed checks in a row; `downgrade` and `paused` have none), set by
`feeds.ts` only when it differs (a second write in the same mutation as the feed row; NO revision bump, so an open edit form is not made stale), cleared by `apps:update` when
the feed row is deleted or reset; `apps:list` returns it from the row it already reads (no new read, no new query); the Apps list shows an "Update waiting" / "Feed problem"
pill. Budget rows: `feeds:dismiss`, `feeds:setPaused` 2 -> 3 writes, `feeds:recordResult` / `check` / `checkNow` / `approve` and `apps:update` + 1 write. Known gap: when
"Check now" publishes (auto-publish on), the open form still holds the old revision, so its next save gets the usual "someone else changed this" with Reload.

---

### Step 13 — Installer inspection, pre-filled switches, answer file

**Machine:** dev. **PRD:** 6. **Files:** `convex/lib/installerDetect.ts`
(+ test with small fixture headers), `convex/apps.ts` (`inspectInstaller`),
validators (`tech`, `answerFile`, `timeoutMin`, `successExitCodes`
editable), `AppEdit.tsx`, strings.

1. The detector of 4.7 with fixtures: a few hundred bytes to a few KiB per
   technology, hand-built or cut from freely redistributable installers
   (record each source and licence).
2. `apps:inspectInstaller` with Range requests and the rate limit.
3. Form: "Detect" next to the URL; a result line ("Inno Setup installer,
   signed by …"); pre-filled switches and exit codes with an "edited"
   mark; the answer file fields appear for InstallShield InstallScript or
   on request; timeout field; the per-user warning.
4. Optional local file check (Q9) as a lazy chunk; confirm the dashboard's
   initial-load budget is unchanged.
5. Tests: every technology; garbage input; a truncated file; no Range
   support; pre-fill never overwrites typed text.

**Verify:** `pnpm test:convex`; dashboard checks; screenshots.
**Do NOT:** trust the detected signer for anything but display; upload the
local file anywhere; let a pre-fill run without the admin saving.

**Status (2026-11-21, uncommitted):** server and dashboard done; no screenshot taken (no dev server was run) and no VM. Files: `convex/lib/installerDetect.ts`
(pure detector + `certificateRange`, PE headers / resources / `.wixburn` / marker strings / claimed signer from the PKCS#7 table), `convex/lib/installerInspect.ts` (Range
reads, https + public host + every redirect re-checked), `apps:inspectInstaller` in `convex/apps.ts` (rate limit `installerInspect`, 30 an hour per organization),
validators `installTech` / `answerFileSpec` and the four new `installSpec` fields, `lib/appRules.ts` (`normalizeInstallerDetails`), `lib/desired.ts` + `lib/groupConfig.ts`
(`docInstallExtras`: the fields reach the signed document in the order of the Rust struct, left out when absent so the committed vectors stay), dashboard
`AppInstaller.tsx` (lazy: Detect row and details card), `lib/apps/{installerRules,installerPrefill,localInstaller}.ts`, strings `appInstaller.ts` / `installRefusals.ts`. Fixtures are
built by `tests/convex/installerFixtures.ts` (hand-built, no third-party bytes: nothing to license). Choices where the plan was silent: the answer file must end in `.iss`
(judged by the URL path); `{AnswerFile}` in `silentArgs` and an answer file must go together (`answer_file_unused` / `answer_file_missing`), and any other `{...}` in `silentArgs`
is refused (`silent_arg_token`, the rule of `check_silent_args` in `rulebox-policy`: it also applies to apps saved before this step); `tech` must fit the kind and "exe" / "msi" are
stored as no value; `timeoutMin` and the answer file are refused on a portable file, the answer file on an MSI; refusals of Detect are `invalid_argument` on field `url` with
`detail` `inspect_blocked` / `inspect_unsupported` / `inspect_failed` / `inspect_not_installer` (no new error code); the Range answer is judged by `Content-Range`, a 200 is
accepted only for a file that fits the first request; the detected size is shown and never stored; the claimed signer is shown and only copied into "Expected signer" when the admin
presses the button. The local file check imports the same detector (`@convex/lib/installerDetect`) and `@noble/hashes` (resolved from the root `package.json`; the dashboard's own
`package.json` does not list it yet). Bundle: initial-load routes unchanged by this step, but the AppEdit route is 28.0 KB gzip on top of overview (was about 24.6; budget 25), so
`scripts/size.mjs` allows 29 for AppEdit (needs owner OK); `overview` (166.2 > 166) and `DeviceDetail` (25.9 > 25) are over from other work in the tree, not measured per change.
**For Step 14 (agent):** `catalog.rs` `check_limits` does not yet call `check_silent_args` on `install.silent_args` (the server now refuses bad tokens, the agent should too);
the agent must expand `{AnswerFile}` / `{LogFile}`, honour `tech`-independent `successExitCodes` (3010 / 1641 listed), `timeoutMin` and `publisher`; no Rust type changed here.

---

### Step 14 — Agent: wizard installer handling

**Machine:** dev. **PRD:** 13.5. **Files:**
`apps/agent/src/installs/{mod.rs,engine.rs,answer.rs,probe.rs}`,
`apps/agent/src/platform/windows.rs` (`run_installer`), tests.

1. Answer file download, verification, token expansion.
2. `judge_install`: EXE with 3010 / 1641 listed → success + restart note.
3. Per-app timeout; the `needs_interaction` probe; `installed_per_user`.
4. Both detail lists updated together (a test compares the Rust list with
   the TypeScript list through a shared JSON file).
5. Tests: each new detail; a token in the wrong place refused; an answer
   file with a wrong hash never reaches the installer; the process tree is
   always killed on timeout.

**Verify:** `cargo test -p rulebox-agent`; `pnpm test:convex`.
**Do NOT:** show any window in the Staff session; pass admin text through
a shell; widen the allowed program list beyond 4.6.

**Status (2026-11-21, uncommitted):** agent side done on the dev PC (SimPlatform and fakes only); no installer was run for real. Files: new
`apps/agent/src/installs/answer.rs` (the two tokens, one-pass expansion; `check_silent_args` first) and `probe.rs` (the pure rules `looks_stuck`, `cpu_sample_at`,
the system-profile path, the program file name); `installs/mod.rs` (three new details, `RunningInstaller::{cpu_time, has_window}`, `wait_for_installer` samples the CPU five minutes
before the timeout and looks once, before the kill, at the CPU and the windows: `InstallerExit::Stalled`); `installs/engine.rs` (`Spec.{answer_file, timeout_min}`, `check_spec`
uses `check_silent_args` and refuses `{AnswerFile}` without an answer file, answer file 256 KiB cap and https/SHA-256 checks; the answer file is downloaded like the installer into
`<data>\downloads\<sha256>.iss`, opened locked and hashed again through its own handle held while the installer runs, expanded into `silentArgs`; the previous installer's answer file is
kept with it for a roll-back; per-app `timeoutMin`; `needs_interaction` / `timeout`; `installed_per_user`); `platform/{mod,sim,windows}.rs` (`InstallerExit::Stalled`, read-only
`Platform::find_file_below`), `crates/rulebox-win32/src/job.rs` (`cpu_time`, `process_ids`, `has_visible_window`), `crates/rulebox-policy` (`catalog::check_limits` calls
`check_silent_args`: `LimitError::BadSilentArgs`), `convex/lib/deviceApiRules.ts` + `convex/deviceApi.test.ts`. The details lists are compared through one shared file,
`apps/agent/tests/vectors/install-details.json` (a Rust test and a Convex `?raw` test read it). Decisions where the plan was silent or loose: only the three details of this step
(`needs_interaction`, `installed_per_user`, `answer_file_failed`) were added to the lists; `driver_unsigned` and `protected_print_on` of the 4.6 row are Step 15's. An answer file whose
arguments never name `{AnswerFile}` is not downloaded; one the server refused (`answer_file_unused`) cannot reach a device anyway. Any answer-file failure (404, wrong hash, too big,
disk) is the one detail `answer_file_failed`, counted and retried like any failure. `needs_interaction` is judged by the job's own CPU accounting (user + kernel of every process,
ended ones included) and by any visible top-level window of the job on the service desktop; "last five minutes" is one sample taken five minutes before the timeout (at the start when
the timeout is 5 minutes). The per-user search covers only `<SystemRoot>\System32\config\systemprofile\AppData` and (since S-9, 2026-11-25) its `SysWOW64` twin, 4 folders deep, 20,000 entries at most, links never entered; a program
path whose last part has a `*` is never searched for. `catalog::check_limits` is **not called by the agent yet** (Step 17 wires it): when it is, one bad `silentArgs` refuses the whole
document, while `check_spec` already makes only that app `unsupported`; decide at Step 17 whether the document-wide rule is wanted. A driver's installer that stalls still reports
`timeout` (drivers are Step 15). **Unverified until the VM (Step 23):** the CPU accounting and window detection on a real installer, a real InstallShield `/s /f1` run, per-user detection
with a real NSIS or Inno `asInvoker` installer, the answer file lock against a real installer reading it. The dashboard text for `timeout` still says "30 minutes" and the three new
details have no dashboard text yet (`screenStrings/install.ts`).

---

### Step 15 — Drivers

**Status (2026-11-25):** built on the dev machine (SimPlatform and convex-test only; not committed, nothing run on a VM).
Phase 5 Step 14b was already in the tree (`installs/{drivers,drivers_rules,unzip}.rs`), so this step **extended** it instead of
adding the `apps/agent/src/drivers/{zip,inf,probe}.rs` files named below: the new probes are `installs/drivers_probe.rs`.
- **Sources (4.8):** `DriverSource` is read from the signed entry (`resolve_source` in `drivers_rules.rs`); an entry without one
  goes by `kind` (`inf` = `inf_zip`, `exe`/`msi` = `vendor_exe`). A source that does not fit its kind, an unknown source and
  **`vendor_exe_extract`** make that driver `unsupported` (nothing downloaded). `vendor_exe_extract` is **not built**: it waits
  for VM spike row S-10; the enum value is defined and refused with a reason. The server does not emit `source` yet (the `kind`
  says the same; no second copy to keep equal) - add it only when `vendor_exe_extract` is built.
- **Warnings:** `protected_print_on` (an INF package of class `Printer` / `PrintQueue` is refused, as a failure with the usual
  back-off, while `Platform::protected_print_on` is true; the zip is kept; a vendor exe or msi is opaque and is never refused
  for this) and `seagull_driver_present` (rides on the `installed` result, never blocks; the package or its name in the document
  says `seagull`/`tpcl` and an installed printer driver's name does too). Both are install details in `Detail::ALL`,
  `INSTALL_DETAILS`, `install-details.json` and the dashboard texts (`screenStrings/install.ts`); 21 -> 23 details.
- **Deviations from the 4.8 text:** (1) `pnputil /add-driver <inf> /install` **without `/subdirs`** (14b's shape, kept: one
  named INF needs no traversal and the program rule stays tighter; a test pins the exact arguments, and the delete command now
  comes from one pure builder, `pnputil_delete_command`); (2) the zip limit is now 2,000 entries (was 5,000), 1 GiB unpacked;
  (3) the catalogs checked are the ones the INF names (`CatalogFile=`), which are the only ones Windows reads; (4) the detail for
  an unsigned catalog stays `unsigned_driver` (4.6 called it `driver_unsigned`).
- **Unverified (VM, Steps 23 and S-10):** the protected print registry value, the Seagull name heuristic (`seagull`, `tpcl`), and
  whether pnputil accepts the add shape on a real PC. INF-only installs may still miss the vendor's port or status monitor.
- **Spike result (2026-11-25):** S-10 confirms `vendor_exe_extract` stays unbuilt (no windowless extract). **S-12 needs a code
  fix:** `PROTECTED_PRINT_VALUES` (`apps/agent/src/platform/windows.rs`) reads `Control\Print\WPP\EnabledNow`, which does not
  exist; a PC where the Settings switch turned the mode on reads as off. Read `Control\Print\WindowsProtectedPrintState`, keep
  `WindowsProtectedPrintGroupPolicyState`, add `WindowsProtectedPrintMode` (4.8). pnputil and the TPCL INF were not reached.
  **Fixed 2026-11-25** (second run): `PROTECTED_PRINT_VALUES` reads the three S-12 values. **Built 2026-11-26 (333b80f, agent
  side, VM check pending):** the removal order (delete the printer driver before `pnputil /delete-driver`, X-1), the
  `driver_untrusted_publisher` detail for a non-WHQL package whose publisher is not trusted (S-11), and the owner's decision
  (trust the named certificate per driver, `signerThumbprint`). Left: the `signerThumbprint` field in Convex and the dashboard.

**Machine:** dev. **PRD:** 24.2 (new bullet). **Files:** as Phase 5 Step
14b, plus `apps/agent/src/drivers/{zip.rs,inf.rs,probe.rs}`.

1. Build Phase 5 Step 14b if it is not in the tree (its text is the spec).
2. Add the sources of 4.8. Build `vendor_exe_extract` **only** if Step 2
   row S-10 passed; otherwise leave the enum value unused and say so.
3. Warnings `protected_print_on`, `seagull_driver_present`.
4. Tests: zip-slip entry refused; unsigned catalog refused; only
   Rulebox-added packages are removed; `pnputil` arguments match the fixed
   shapes exactly.

**Verify:** agent and convex tests; dashboard checks.
**Do NOT:** fetch a driver from Windows Update or a print server; accept an
unsigned INF; give drivers a tile.

---

### Step 16 — Browser web apps: server and dashboard

**Machine:** dev. **PRD:** 6, 6.2, 24.1 (as edited in Step 1). **Files:**
`convex/lib/{validators.ts,appRules.ts,desired.ts}`, `convex/apps.ts`,
`AppEdit.tsx`, `AppPermissions.tsx`, strings.

1. `web.browser` in `normalizeWeb`; `chrome` needs an existing,
   non-archived Chrome app of the same organization (`browser_app_required`).
2. `browser_app` detection for desktop apps and the "Browser rules" card.
3. Publish-time limit: ≤ 800 URL patterns per device document
   (`too_many_browser_urls`, names the group).
4. Form: "Opens in" with Built-in, Edge, Chrome. Under it, the plain list
   of 4.9.8. Permissions that do nothing in browser mode are shown
   disabled with the reason.
5. Tests: refusals; the catalogue carries the browser; an archived Chrome
   app turns its web apps back to built-in at publish with a warning row
   in the response.

**Verify:** convex tests; dashboard checks; screenshots.
**Do NOT:** add a browser policy section to the document; add a query.

---

### Step 17 — Browser web apps: agent policies

**Machine:** dev. **PRD:** 12.2, 13.1. **Files:**
`apps/agent/src/lockdown/{browser.rs,allowlist.rs,apply.rs,invariants.rs}`,
`crates/rulebox-win32/src/staffreg.rs` (two roots; `machinereg.rs` only if
S-1 failed), `crates/rulebox-win32/tests/guard_coverage.rs`, tests.

1. Re-read every policy name and value of 4.9.3 from the vendors'
   references. Fix the table. Record the browser versions it was read for.
2. Compile catalogue → policy values (pure function, table tests).
3. Apply through the Phase 5 transaction: journal first, restore on
   unassign, Disable kiosk, `unenroll`, `recover`. Owner tag `L1-browser`.
4. Allow-list: browser folders as Staff path rules while assigned.
5. `browser_ready` in the snapshot only after the write is applied.
6. Invariant: a browser policy write can never touch a key outside the two
   (or four) roots; the root count test is updated in the same commit.
7. Tests: allowlist union and the 800 limit; a permission flip changes
   exactly one list; unassign removes every value and the roots if they
   are then empty and did not exist before; drift re-asserted.

**Verify:** `cargo clippy` and `cargo test` for `rulebox-win32` and the agent.
**Do NOT:** write any browser policy on the dev machine; add a root not
named here; leave policies behind after Disable kiosk.

**Status (2026-11-25): built and tested on the simulator; items 1-7 done. The
Staff-hive design only, no machine-hive roots. S-1 passed (Chrome and Edge 158
apply Staff-hive policy on a workgroup PC), so the design stands; S-2 measured
reloads of about 10.5 min (Edge) and 13.5 min (Chrome), inside the rule.**

- **Item 1:** the 4.9.3 table above is the re-read result. Versions: **Chrome 159**
  (stable 159.0.8154.34 on 2026-11-24; policy values from Chromium
  `policy_definitions` on `main`, which can be ahead of stable, the registry
  layout of Chrome lists and JSON strings follows the same scheme as Edge's
  documented one and is not stated on Google's page) and **Edge 160** (Learn,
  2026-11-24). Corrections to the plan: lists are subkeys; `BrowserAddProfileEnabled`
  (Edge) vs `BrowserAddPersonEnabled` (Chrome); `EfficiencyModeEnabled`;
  `AutoLaunchProtocolsFromOrigins` not written; no "default block" policy for
  camera and microphone (use `VideoCaptureAllowed`/`AudioCaptureAllowed` = 0 plus
  the allowed-URL lists); no Edge shortcut id for "settings"; `PrintingEnabled`
  not gated on printers.
- **Item 2:** `lockdown/browser.rs`: `BrowserInputs::from_catalog` (catalogue to
  per-browser inputs), `compile` (pure; `FIXED_ROWS` table plus the allow list,
  uploads, printing and per-origin lists), table tests per row.
- **Item 3:** `browser::apply` runs inside `staff::apply` (the Staff layer's
  state includes it, mode `on` when a browser is assigned), owner
  `JournalOwner::L1Browser` (serialized `l1-browser`; drift, status and the
  last-known-good rollback know it). Rows no longer wanted are restored through
  the journal, so unassigning leaves nothing. Emptied keys are removed by the
  journal restore itself (so Disable kiosk, `unenroll`, `recover` and rollback
  all do it): new guarded `staffreg::delete_key_if_empty` (browser roots only),
  `Platform::delete_staff_key_if_empty` (sim and Windows). A key that still holds
  an administrator's own value stays.
- **Item 4:** the program folder of an assigned browser joins
  `Facts::catalogue_exe_folders` (`runtime::machine_facts`), so the allow-list
  gives the Staff SID a path rule only while it is assigned, and only when it is
  admin-only (the existing catalogue-folder rule).
- **Item 5:** `AgentState.browser_ready` (set only when every row of that browser
  is journalled as applied) feeds `apps.list` (`browser`, `browserExe`,
  `browserReady`) through `AppResolver::with_browser_state`; `is_ready` also
  needs the browser's journal rows to still exist.
- **Item 6:** `invariants::check_browser_rows` (a set naming a key outside the two
  roots is not written at all, layer detail `browser_key_outside_roots`);
  `staffreg::ALLOWED_ROOTS` 16 → 18 and `guard_coverage` updated in the same
  change (staffreg guarded functions 2 → 3).
- **Item 7:** `lockdown/browser/tests.rs` (29 tests).
- **Also (needed by item 1 and the server):** `DesktopSpec.browser_sites`
  (`rulebox-policy`, omitted when absent; `packages/types` regenerated),
  `convex/lib/desired.ts` and `groupConfig.ts` emit and freeze `browserSites`,
  and both limit checks (`check_limits`, `checkBrowserLimits`) count a program's
  sites in the 800 patterns.
- **Left for Step 18 or later:** the Staff App launch, task mapping and profile
  cleanup; an `apps.changed` event when `browserReady` flips (the Staff App must
  ask `apps.list` again after the first apply); dashboard sentences for the new
  layer detail codes `browser_too_many_urls` and `browser_key_outside_roots`
  (the dashboard shows an unknown code as it is); the S-1, S-2 and Step 24 VM
  rows (user-hive policy applies, reload time, the `chrome://*`/`edge://*`
  block, `blob:`/`about:blank` under a `*` block, memory rows).

---

### Step 18 — Browser web apps: Staff App

**Machine:** dev (demo + simulate). **PRD:** 4.4, 4.5, 22.4. **Files:**
`apps/staff-app/src-tauri/src/{taskops.rs,tasks.rs,browserapp.rs,model.rs}`,
the tile and taskbar components, agent profile cleanup
(`apps/agent/src/browser_profiles.rs`), tests.

1. Launch per 4.9.2 through the launcher service. Fall back to built-in in
   Lite mode, when the exe is missing, or when `browser_ready` is false.
2. Task mapping per the Step 2 result (4.9.5). Taskbar entry, running dot,
   close, focus work per app.
3. Window cap counts browser windows.
4. Profile cleanup in the agent (4.9.6).
5. Tests: the argument list is exactly the fixed shape for odd URLs
   (quotes, spaces, `--` inside the URL are refused or encoded); two apps
   in one browser map to two tasks (simulated windows); Lite falls back;
   cleanup never touches a profile of a signed-in employee.

**Verify:** Staff App typecheck, lint, tests; agent tests; screenshots of
the tiles.
**Do NOT:** ShellExecute anything; pass `--kiosk`; reuse the built-in
WebView2 profile folder for a browser.

**Spike input (2026-11-25):** item 2 uses the **primary** (S-3 passed: one
AUMID per app window, `Chrome.<host>_<path>.<leaf>.<profile>` /
`MSEdge.…`, stable; skip windows with no AUMID). Item 1 adds the 4.9.1
default: below 8 GB RAM fall back to built-in unless the group opted in
(S-4).

**Status (2026-11-26): built and tested on the dev machine (Staff App 258 tests, agent targeted tests, clippy clean; no browser was
started, no server run, no screenshots, nothing on a VM).** Items 1-5 done:
- **Staff App** (`browserapp.rs`, new): `choose` (built-in window for: not chosen, Lite, below 7,168 MB RAM unless the display mode
  was forced by the group or the PC, policies not `browserReady`, program missing, or not the absolute `chrome.exe`/`msedge.exe` of
  the chosen browser), `launch_args` (exactly `--app=<url> --user-data-dir=<profile> --no-first-run --no-default-browser-check
  --disk-cache-size=52428800`; the address goes through the URL parser so spaces and quotes are percent-encoded, `--` inside it stays
  inside the one `--app=` argument, a login in the address, a non-https address or more than 2,048 characters is refused),
  `profile_path` (`%LOCALAPPDATA%\dev.rulebox.staff\browser\<chrome|edge>\<employee folder>`), `match_browser_app` (expected AUMID
  `<Chrome|MSEdge>.<host>_<path>.<employee folder>.Default`, compared without case; windows without an id, another leaf or another
  browser map to no web app). `Launcher::start_browser` keeps the job (log out closes and ends it) but never maps its processes or
  adopts windows (one browser process serves several apps). `TaskTable` maps by AUMID before the process; `taskops::launch` and
  `close_for_cap` open through `browserapp::open_now` (browser, else the built-in window, also when the browser does not start);
  `WebApps::at_cap_with` counts browser windows; the "close one first" dialog lists them (`browser-<task id>`) and closes one
  gracefully, waits up to 3 s, then opens the waiting app.
  `WebApp.browser` (`BrowserLaunch`) is Rust only (`serde(skip)`), so `@rulebox/types` is unchanged. Idle close does not apply to
  browser windows (4.14).
- **Agent**: `browserReady` flipping now says `apps.changed` (`SharedState::browser_ready_changes`, one small task in `agent.rs`
  calls `SessionManager::resync`); `browser_profiles.rs` (new) plans the profile deletion and keeps `browser-profiles.json`
  (employee folder to last sign-in); `cleanup.rs` runs it in every cleanup round through the same gate and the handle-based
  `reset_folder` (so never while an employee is signed in or signing in, in-use folders are retried). Rules: employee not in the
  roster of the document's group (only when that roster is synced, epoch above 0) loses both profiles; per browser the 10 most
  recently used stay, cut at the first round of an agent run; below 3 GiB free on the system drive only 3 stay, at every round.
  `resolve_reset` accepts exactly the template shape `browser_profiles::profile_template` makes for Rulebox's own folder
  (`dev.rulebox.staff\browser\<chrome|edge>\<name>`); every other `dev.rulebox.staff` folder stays refused.
- **Left / not done:** "reset on logout" per app does not exist for web apps in the catalogue (profiles are per employee and
  browser), so there is no per-app wipe; deletion of old profiles at boot happens at the first cleanup round after the agent starts
  (a PC where nobody signs in or out does not run one); screenshots of the tiles (nothing changed in the React tiles: the running
  dot and taskbar button follow `app_id`); the dashboard texts for the browser setting and the 8 GB rule; VM rows (Step 24: a real
  `--app` launch as the Staff user, two apps in one browser, AUMID of a path or port address, policies before the first window,
  profile deletion with a real browser running).

---

### Step 19 — Lite tuning

**Machine:** dev. **PRD:** 22.4, 22.5. **Files:** `convex/groups.ts`,
`convex/fleet.ts`, validators, `desired.ts`, group and device pages,
`apps/agent/src/agent.rs`, `apps/staff-app/src-tauri/src/webapp/{mod.rs,idle.rs}`,
`appwin.rs`, wallpaper asset pipeline.

1. Override fields, server-validated, audited (`device.displayModeChanged`,
   `group.displayModeChanged`), published as agent-only keys.
2. Agent: effective mode = device override, else group override, else RAM.
3. Staff App: window cap dialog; idle close with the exclusions of 4.14;
   one timer, cleaned up on unmount; honours reduced motion.
4. Lite wallpaper.
5. Tests: override order; the cap dialog; idle close skips audio, capture
   and file-picker windows; timer cleanup.

**Verify:** convex, agent and Staff App tests; screenshots in Lite.
**Do NOT:** enable WebView2 browser flags; add a heartbeat field; close a
window without the "paused" mark.

**Status (2026-11-21): built and tested; items 1-3 and 5 done, item 4
open, no screenshots yet (no server or Tauri run allowed in this session).**

- **Server:** `groups:setDisplay` (display mode, window cap, idle close; on the
  group row, read with the group, no extra read) and `fleet:setDisplayMode`
  (on the device row). Both admin, `expectedRevision`, no write when nothing
  changed, one publish, audit `group.displayModeChanged` /
  `device.displayModeChanged`. Ranges refused server-side (cap 1-12, idle 0 or
  5-240) because the agent refuses a whole document otherwise. Document keys
  `displayMode` (the winner: device over group; `auto` falls through),
  `displayModeSource` (`device` or `group`, **new key beyond the plan's
  list**, so the agent can fill `display_mode_source`), `webWindowCap`,
  `webIdleCloseMin`; none when nothing is set (vectors unchanged).
  `fleet:get` returns `displayMode` and `groupDisplayMode`; `groups:get` the
  group's three fields. Budget rows and matrix rows added (estimates).
- **Agent:** `AgentPolicy::apply_display` resolves the effective mode
  (override, else RAM), the source, and the cap and idle close with the
  defaults of the effective mode (Lite 3 and 30 min, Standard 8 and off), and
  sends them in the 1.4 snapshot fields. No heartbeat field.
- **Staff App:** `webapp/idle.rs` (pure rules, per-window `Activity`, the one
  once-a-minute timer, dropped = stopped); at the cap a popup (`windowCap`)
  asks which window to close, nothing closes silently; idle close skips
  windows playing audio (`IsDocumentPlayingAudio`), that were given camera,
  microphone or screen (flag kept for the window's life, WebView2 has no
  "is capturing" query) or that have a dialog open (owner window disabled,
  `control::has_modal_dialog`); the "paused" mark is set **before** the close
  and taken back if the close fails; the tile shows "Paused". No WebView2
  flags added.
- **Dashboard:** Display card on the group page and on the PC page (warning
  when Standard applies to a PC that reports 4 GB or less).
- **Open:** item 4 (Lite wallpaper). There is no wallpaper file or pipeline
  yet (branding wallpaper is deferred, Phase 4 Q3) and Lite already drops the
  blurred backdrop, so there is nothing to compress. Needs the owner: build
  the pipeline with the branding feature, or accept the flat Lite desktop.
  Browser windows (Step 18) must be counted by `WebApps::at_cap` when that
  step lands.

---

### Step 20 — Rulebox's own update through the MSI (only if Q8 = yes)

**Status (2026-11-25):** built on the dev machine (SimPlatform, FakeDownloader and convex-test only; not committed; **no msiexec or installer was run, no VM**). Files:
new `apps/agent/src/selfupdate.rs` (+ `selfupdate_tests.rs`), `Platform::start_self_upgrade` (`platform/{mod,sim,windows}.rs`, in `MUTATING_METHODS`, guarded, detached
`msiexec /i <staged msi> /qn /norestart /l*v`, no job object), `paths.rs` (`selfupdate_dir/state/log`), `agent_policy.rs` (`rulebox_release`, parsed with `check_limits`),
`agent.rs` + `main.rs` (one task, own wake sources: document, snapshot, sign-in, one timer). Server: new `convex/ruleboxRelease.ts` (`ruleboxRelease:set`: owner, major
step-up, `expectedRevision` of the organization, `null` clears, unchanged = 0 writes, audit `org.ruleboxReleaseChanged`, one all-PC publish), `schema.ts`
(`organizations.phase6Settings.ruleboxRelease`), `lib/{validators,desired,stepUp,audit}.ts`, `publish.ts` (adds the key to every document, no extra read),
`ioBudgets.ts` + `tests/convex/matrixRows.ts` rows, dashboard audit label. Tests: 27 agent (`cargo test -p rulebox-agent selfupdate`), 1 `agent_policy`, 8 Convex
(`convex/ruleboxRelease.test.ts`). Decisions taken from the plan's recommendation or from the plan text:
- **Never while signed in:** the apply window is "nobody signed in" (`SessionManager::presence`), read again right before the start; the MSI may be downloaded earlier.
- **"Signing live" = the running agent's exe is Authenticode-signed.** Then the new MSI must carry the same signer subject (`publisher_matches`); a signed fleet never
  accepts an unsigned MSI. A running agent that is unsigned (the `-unsigned` pilot builds): the SHA-256 of the signed document alone decides. A running exe whose
  signature cannot be read pauses the update (never assumes "unsigned"). SignPath signs other projects with the same certificate, so the hash stays the identity.
- **A failed release is `(version, sha256)` in `<data>\state\selfupdate.json`** (last 8), not retried until another version or another hash. Failures: hash mismatch (download
  or the last re-hash before the start), publisher mismatch, platform refused the start, or the attempt did not take (the version after the restart is still lower
  after a 30 minute grace; an agent restart inside the grace waits). A download that cannot finish (network, disk) is not a failure: 1 h apart, 3 times, then it waits for
  a new document or the next agent start. Lower or equal or unordered versions are never installed (no download).
- **One MSI at a time:** the task waits (2 min) while the install engine has an app or driver in `Installing`, so msiexec does not answer 1618.
- The MSI is kept in its own `<data>\selfupdate\` folder (the install engine cleans `downloads\`); the agent does not set a TEMP for it (the Windows Installer service does
  the work, not the client). It writes Application event log entries 1100 to 1103.
- Server: the release is a setting of the **organization**, kept out of `settings` like `phase5Settings`; every PC of the organization gets the same key.
**Left:** a real CI-built MSI and VM run 23 / Step 22 item 9 (an agent-driven upgrade with no employee signed in, and a failing one: confirm the service restarts into
the new version, the rollback leaves the old one running, `selfupdate-msi.log` is written, and that `DETACHED_PROCESS` msiexec survives the service stop; run A2
passed both, 2026-11-26); the dashboard Settings > Updates card and the `ruleboxRelease:get` query are built (4fd6141, owner-only); the release workflow does not publish the release into the setting;
`docs/prd.md` 23.9 already carries the v1 note ("an agent-driven MSI major upgrade with no employee signed in"); 23.4 was not checked.

**Machine:** dev. **PRD:** 23.1, 23.2, 23.9. **Files:**
`apps/agent/src/selfupdate.rs`, settings mutation, tests.

1. Implement 4.17. The MSI start is a new, separate, guarded `Platform`
   method (`start_self_upgrade`), outside the kill-on-close job.
2. Tests (SimPlatform): never while an employee is signed in; hash
   mismatch; signer mismatch once signing is on; a failed version is not
   retried; a lower version is refused.

**Do NOT:** update from the Staff session; switch `current.json` by hand
(the MSI owns the files in this minimal path).

---

### Step 21 — Installer hosting (only if Q1 = b)

**Machine:** dev. **PRD:** 16. Spec: post-phase-5 Section 6, steps S1 and
S4, with these Phase 6 additions: file types gain `.iss` (≤ 256 KiB) and
`.zip` driver packages (magic bytes checked); the catalogue source
`hosted` carries `fileId`, `sha256`, `sizeBytes`; `deviceApi:downloadUrl`
is one-shot and checks the file belongs to an app the device has; the
detector of 4.7 runs where the SHA-256 is computed. The scanner (S3) and
console screens (S2) are **not** part of this step; without a scanner the
SHA-256 must be computed by a server-side stream in an action, bounded like
4.5. Budget and matrix rows for every `files:*` function.

**Do NOT:** trust a browser-computed SHA-256 for a hosted file; store
credentials in the browser build; serve files through Convex file storage.

---

### Step 22 — VM run A: installer (the user runs it)

**Machine:** VM, fresh checkpoint. Results into
`docs/plans/phase-6-vm-results.md`.

**Status (2026-11-26, run A, evidence in `phase-6-vm-runs/`):**
- **Passed:** items 1 (unsigned, UI elevated and not elevated, silent with `ENROLLCODE`), 2 (not an administrator), 3, 4 (Windows 11 part), 6 (upgrade, forced failing upgrade, downgrade) and 7 (refusal with `KioskOn=1` set by hand; clean uninstall). Install times are 2 to 7 s.
- **Fixed:**
  - the free-space condition refused every install, so it was removed;
  - the release agent said 0.0.0, so `RULEBOX_VERSION` was added and `build.ps1` checks it;
  - the event source was not registered, so `Package.wxs` now registers it.
- **Differs (owner questions Q-A1, Q-A2):**
  - a verbose log shows the `ENROLLCODE`;
  - `ProgramData\Rulebox` stays after uninstall.
- **Not run:**
  - a signed MSI;
  - low disk;
  - Windows 10;
  - item 5 (needs a dashboard code and the network);
  - item 8;
  - item 9.

  Run A2 needs a CI MSI rebuilt with these fixes and an enrollment code.

**Status (2026-11-26, run A2, CI MSI 0.1.1, network on, evidence `a2-*` in `phase-6-vm-runs/`):**
- **Passed:**
  - item 5 (enroll, kiosk on);
  - E-70 (first and last), E-71 (default settings), E-73 (offline `recover`), E-74 (device side; the kiosk was turned off by a row edit, not the dashboard button);
  - item 7 with the kiosk really on (refused) and after kiosk off (uninstall);
  - item 8 (exit hold, kill-on-close job, `recover` for an LSA auto sign-in owner);
  - item 9 (agent-driven upgrade to 0.1.4 confirmed by event 1100; failing 0.1.5 rolled back and recorded `did_not_take`).
- **Fixed:**
  - the stuck kiosk shell after an agent-driven upgrade (stale launcher; `end_stale_launchers`);
  - a protocol error at enrollment logged no reason.
- **Pilot:** E-72 (Shift at startup cannot be tested with Hyper-V's synthetic keyboard).
- **Differs:**
  - empty `versions\<old>` folders after agent-driven upgrades (Q-A3);
  - uninstall leaves the RuleboxStaff account (Q-A2 extended);
  - an empty `Policies\…\OOBE` key.
- **Left:** verify the stale-launcher fix with an MSI built from it (next CI release), and the dashboard's Disable kiosk button and a release screen.

1. Unsigned and (if available) signed MSI: UI install, silent install with
   `ENROLLCODE`, the log holds no code.
2. Launch conditions: non-admin, low disk (simulated by a small VHD),
   Windows 10 22H2 VM if available.
3. Guard: the installed release agent passes; the same exe copied to
   another folder does not; no test marker is involved.
4. Setup window: compat report, WebView2 present; on a Windows 10 VM,
   WebView2 missing → installed.
5. Enroll, kiosk on, the Phase 5 way-back rows E-70..E-74 again.
6. Upgrade to a higher version (service restarts, data kept); a forced
   failing upgrade leaves the old version working.
7. Uninstall with the kiosk on → refused; Disable kiosk → uninstall →
   baseline diff is empty (Phase 5 Step 21 run 8 method).
8. The three Phase 2 late fixes (3.3).
9. If Step 20 was built: an agent-driven upgrade with no employee signed
   in, and a failing one.

**Done when:** every item has pass / fail and evidence.

---

### Step 23 — VM run B: updates, wizard installers, driver (the user runs it)

1. **Zahras POS, Managed:** add with the feed; first install; publish a
   higher version to the feed; the server finds it within one check; pilot
   ring gets it; it installs at boot before sign-in; the dashboard shows
   the new installed version; one extra `installResults` write per change
   (count it).
2. Update while the app is running → waits; applies after sign-out.
3. A broken installer for the next version → rollback to the cached
   previous installer; the app still starts; the rollout halts.
4. Feed with a wrong signature, feed unreachable, feed listing a lower
   version → nothing changes on the device.
5. **Chrome, Vendor:** enterprise MSI; allow rule by publisher; after
   Chrome updates itself (or a manual version step), it still starts and
   Rulebox does not reinstall it; the dashboard shows the new version.
6. **Wizard installers:** one NSIS, one Inno, one Burn, one InstallShield
   sample with the pre-filled switches; one with deliberately missing
   switches → `needs_interaction` within the timeout, nothing visible in
   the Staff session; a per-user installer → `installed_per_user`.
7. **TPCL driver:** the route Step 2 chose. The driver is in the store, a
   printer can be created with it (Phase 5 Step 14), a restart request is
   shown as "restart needed", removal removes only Rulebox's package.
8. Offline device during an update → converges on reconnect, no
   intermediate version. Low disk → clear failure, nothing half-installed.

---

### Step 24 — VM run C: browser web apps (the user runs it)

Run Section 6 rows B-01..B-24 for Edge and for Chrome, each on a Standard
VM (≥ 6 GB) and once with the VM set to 4 GB (must fall back to built-in).
Record `chrome://policy`-style evidence only as "policy shown as applied",
never page content. Record memory (S-4 repeated with Rulebox running).

**Done when:** every row has pass / fail, evidence and the residual risk
confirmed or corrected. A failed row in B-01..B-12 blocks the browser
feature for the pilot: turn it off by a deployment setting and tell the
owner.

---

### Step 25 — I/O measurement (the owner runs it; A21, post-phase-5 1.6)

1. Lab project `rulebox-io-lab`, probe on, per the 1.6 procedure.
2. Flows, each in its own UTC day where possible: 20 simulated devices for
   24 h; one managed-app version through rings to 20 devices; 10 feed
   checks with no change; an Apps page and an app page left open for 1 h;
   the pilot laptop's real day (Step 26) read from the Usage page.
3. Write `docs/plans/phase-6-io-results.md`: estimate vs measured per row
   of 4.16, and the projected share of the free plan for 10, 50 and 200
   devices.
4. Fix any row over budget before Step 27.

**Do NOT:** point the lab project at real devices; run `npx convex deploy`
against the dev or production deployment.

---

### Step 26 — Pilot 1: one real 4 GB laptop (the user runs it)

Guide: `docs/guides/pilot.md` (written in this step). A laptop that can be
reinstalled, with a second admin account and a recovery USB at hand.

1. Install from the MSI, enroll, kiosk on. Lite mode chosen automatically.
2. **Carry-overs** (Section 6.3): Phase 3 laptop-only list and the unrun
   rows of `VM-CHECKLIST-3.md`; Phase 5 Wi-Fi (WPA2, WPA3 transition), a
   real printer with the TPCL or another real driver, USB rows E-66..E-69
   with real devices (E-67 must pass), sleep and resume, lid close,
   battery.
3. **Budgets** (Section 14) measured over a normal working day.
4. A week of real use by one or two employees. The owner notes every
   confusion and every "I could not do my work".
5. Each day: the Convex Usage page numbers into the I/O results file.
6. One Rulebox upgrade and one managed app update during the week.

**Exit:** no way-back failure; no black screen; budgets met or the misses
accepted by the owner; no I/O row over budget.

---

### Step 27 — Pilot 2: a small group (the user runs it)

1. 3-10 PCs of mixed hardware, at least one Windows 11 Home if the owner
   has one (Phase 5 Q12 result recorded), signed MSI if SignPath is live.
2. Rings on: one Pilot device, the rest Early / Everyone. Every change of
   the two weeks goes through rings.
3. One deliberate bad change (an installer that fails) to see halt and
   rollback on real devices.
4. Stop rule ("red button"): any way-back failure, data loss, or a PC that
   needs a visit to recover → pause all rollouts, Disable kiosk on the
   affected PCs, fix, restart the pilot.
5. Report `docs/plans/phase-6-pilot-report.md`: installs, failures, update
   success rate, memory, I/O, support questions, what to change.

---

### Step 28 — Wrap-up

1. Workspace checks (clippy, tests, typecheck, lint, convex tests).
2. `docs/plans/README.md`: Phase 6 row; answers to Section 19.
3. Every **(unverified)** item marked confirmed or disproved.
4. Section 18 rows not yet in the PRD handed to the user.
5. `cargo clean --release`; no installer copies left outside
   `target\installer\`; `.tmp/phase6/` holds only referenced screenshots.

---

## Final report format (keep it short)

- Pass / fail per step's **Done when**.
- Exact dependency versions and deviations.
- Screenshot list (screen × light / dark / narrow / Lite).
- Test counts per suite; budget test results (4.16).
- VM results (Steps 2, 22-24), every **(unverified)** item settled.
- Section 6: pass / fail count, open residual risks.
- Pilot numbers and the I/O table.
- Open questions for the user.

## Stop and ask the user if

- free disk space on D: is below 10 GB, or a step needs the .NET SDK, WiX
  or a release build locally;
- any step would call a mutating `Platform` method on the dev machine, or
  would need either marker there;
- the production guard cannot be made to pass on an installed release
  build without weakening the dev protection;
- an MSI need can only be met with a script or EXE custom action;
- the feed check cannot stay inside Convex action limits for the owner's
  app;
- browser policies are not honoured on a workgroup PC from either hive;
- any Section 6 row B-01..B-12 fails;
- the TPCL driver has no silent route at all;
- SignPath refuses the project;
- a **Done when** check still fails after two honest attempts;
- the PRD and this plan disagree on something not listed in Section 18.

---

## 6. Verification checklist (VM and laptop only)

### 6.1 Browser web apps (Step 24; Edge and Chrome each)

| # | Route | Closing control | Check (pass / fail) | Residual risk |
|---|---|---|---|---|
| B-01 | Leaving the app's sites by a link or typed address | `URLBlocklist *` + allowlist | Pass: the browser's blocked page appears for a site not on the list | App A can reach app B's allowed sites |
| B-02 | Browser internal pages (`chrome://`, `edge://`) | Explicit blocklist entries | Pass: blocked page; the app window still works | Vendor adds a new internal scheme; re-check per major version |
| B-03 | Local files (`file://`) | Blocklist | Pass: blocked page | Edge documents `file://*` wildcards as unreliable; L3-L5 still stop program starts |
| B-04 | Page source view | `view-source:*` blocked, dev tools off | Pass: nothing opens | — |
| B-05 | Developer tools by keyboard or menu | `DeveloperToolsAvailability = 2` | Pass: nothing opens | — |
| B-06 | New normal browser window from an `--app` window | Policies apply to every window; Edge shortcut policy | Pass: a new window, if it opens, shows only allowed sites or the blocked page | Chrome has no shortcut policy; a plain window with an address bar may exist, limited to the allowlist |
| B-07 | New tab / address bar focus | Same | Pass: same as B-06 | Same |
| B-08 | Private browsing | `IncognitoModeAvailability` / `InPrivateModeAvailability = 1` | Pass: not offered | Needs a browser restart after first apply (handled by `browser_ready`) |
| B-09 | Guest or new profile | Guest off, add-person off | Pass: not offered | — |
| B-10 | Downloads | `DownloadRestrictions = 3` | Pass: a download link saves nothing | "Save page" and "print to PDF" are separate (B-12, B-13) |
| B-11 | External programs through links (`mailto:`, custom schemes) | Schemes blocked; no auto-launch; L3-L5 | Pass: no program starts, no "always open" box | A handler under an allowed folder could start; it is still on the allow-list |
| B-12 | Save page / save as | File dialogs off (unless uploads allowed) | Pass: no dialog; with uploads on: dialog opens but cannot start programs (Phase 5 rows) | With uploads on, the dialog shows the Staff account's folders |
| B-13 | Print dialog and "print to file" | `PrintingEnabled`; Phase 5 file-output printers removed | Pass: off → no dialog; on → only real printers | Print preview may expose "Save as PDF"; if it does, record and block by the browser's printer-type policy |
| B-14 | Upload (file picker) | `AllowFileSelectionDialogs` | Pass: off → no dialog | Uploads do not work when off |
| B-15 | Browser sign-in and sync | `BrowserSignin = 0`, sync off | Pass: not offered | — |
| B-16 | Extensions and the web store | Install blocklist `*`; store not on the allowlist | Pass: nothing installs | — |
| B-17 | History, settings, downloads pages | Internal pages blocked; Edge shortcuts off | Pass: blocked page | — |
| B-18 | Browser task manager | Policy if one exists, else note | Pass or recorded | Ending a browser process only closes the employee's own windows |
| B-19 | Drag a file into the window | Blocklist `file://` | Pass: blocked page or nothing | — |
| B-20 | Camera / microphone on an app without permission | Per-origin allow lists, default block | Pass: no prompt, no access | — |
| B-21 | The browser started without `--app` by any allowed route | Policies are account-wide | Pass: it opens to the blocked page or an allowed site only | Same as B-06 |
| B-22 | Another employee's browser profile | Per-employee folder; sign-out closes the browser | Pass: employee B sees no login of employee A | Same shared Staff account as PRD 5.3: the folder is not protected from the file dialog |
| B-23 | Policies after Disable kiosk | Journal restore | Pass: the policy keys are back to the baseline | — |
| B-24 | 4 GB RAM | Lite fallback | Pass: the tile opens the built-in window | — |

### 6.2 Installer and updates (Steps 22-23)

| # | Check | Pass |
|---|---|---|
| I-01 | MSI install as a non-admin | Refused with a clear message, nothing installed |
| I-02 | Release agent guard | Passes only from the install folder |
| I-03 | Silent install | No enrollment code in any log |
| I-04 | Failed upgrade | Old version runs |
| I-05 | Uninstall | Refused with the kiosk on; clean after Disable |
| I-06 | Installer window in the Staff session during any install or update | Never |
| I-07 | UAC prompt in the Staff session | Never |
| I-08 | Update while the app runs | Waits; never closes the app |
| I-09 | Failed update | Previous version works; reported once |
| I-10 | Vendor updater | Not fought; version reported on change only |
| I-11 | Wrong switches | `needs_interaction`, process tree gone |
| I-12 | Driver | In the store; unsigned refused; removal scoped |

### 6.3 Pilot carry-overs (Step 26)

| # | From | Check |
|---|---|---|
| P-01 | Phase 3 | Second monitor stays blank; shell on the primary |
| P-02 | Phase 3 | Sleep, resume, lid close |
| P-03 | Phase 3 | Touch keyboard |
| P-04 | Phase 3 | Brightness and volume sliders |
| P-05 | Phase 3 | Camera, downloads, two employees' web logins on a second web app |
| P-06 | Phase 3 | Unrun rows of `VM-CHECKLIST-3.md` |
| P-07 | Phase 2 | Exit-hold timing, kill-on-close job, `recover` for LSA owners (also Step 22) |
| P-08 | Phase 5 | Wi-Fi profiles: WPA2, WPA3 transition, managed-only |
| P-09 | Phase 5 | Real printer, real driver |
| P-10 | Phase 5 | USB rows E-66..E-69 on real hardware; E-67 must pass |
| P-11 | Phase 5 | Section 14 budgets on 4 GB |
| P-12 | Phase 5 | Home edition: which layers apply (if a Home PC exists) |
| P-13 | Phase 4 Q3 | Branding shown on the device |
| P-14 | A21 | Real I/O numbers for a day |

---

## 7. Edge cases and failure modes

| # | What can go wrong | Required behaviour | Step |
|---|---|---|---|
| 1 | Update arrives while the app is running | Download now, install in the next apply window; tile unchanged; dashboard "waiting for the app to close" | 11 |
| 2 | App never closes, PC never restarts | Stays waiting; day count shown; no forced close in v1 | 11 |
| 3 | Employee signs in during a boot-window install | Sign-in held ≤ 5 min with "Updating apps…"; after that the tile shows "Updating…" and is not startable | 11, 18 |
| 4 | Power loss during an update | Journal `installing`; at boot: detection decides installed vs retry; previous installer still cached | 11 |
| 5 | New version's installer fails | Rollback to the cached previous installer once; `update_rolled_back`; ring health counts a failure | 11 |
| 6 | Rollback installer also fails | `rollback_failed`; app hidden ("never show a half-installed app"); admin retries | 11 |
| 7 | Previous installer was not kept (low disk) | No rollback; `failed` with the new version's exit code; retried in the next window | 11 |
| 8 | MSI cannot install over a newer version (1638) | Uninstall by the new product code first; unknown code → `rollback_unsupported` | 11 |
| 9 | Vendor feed down | `unreachable`, backoff 1 h, 4 h, 24 h; app unchanged; warning after 7 failures | 12 |
| 10 | Vendor feed compromised (valid JSON, wrong signature) | `bad_signature`; nothing published; audit `app.feedRejected` | 12 |
| 11 | Vendor's signing key lost or rotated | Checks fail as `bad_signature`; the admin enters the new public key (audited) | 12 |
| 12 | Feed lists a lower version | `downgrade`; ignored; shown | 12 |
| 13 | Feed lists a version with the same number but another file | Ignored (version not higher); note "same version, different file" | 12 |
| 14 | Installer at the feed URL changes after the check | Device SHA-256 check fails → `hash_mismatch`; the next check re-resolves | 11, 12 |
| 15 | Installer larger than the cap | `too_large`; the admin pins by hand | 12 |
| 16 | Two feed checks at once (cron + Check now) | The claim (`nextCheckAt`, `revision`) lets one win; the other ends without a write | 12 |
| 17 | Auto-publish on, rings on | New version goes to Pilot only; promotion is the Phase 5 flow | 10, 12 |
| 18 | Auto-publish on, rings off | Goes to every device of the group; the form says so in plain words | 10 |
| 19 | Ring partial rollout: Pilot on 1.5, Everyone on 1.4 | Each ring's pointer names its version; a second new version replaces the Pilot pointer only | 10 |
| 20 | Admin rolls back while devices are mid-install | They finish or fail the current operation, then converge to the document they hold | 11 |
| 21 | Device offline for weeks | Gets the ring's current version on reconnect; never intermediate ones | 11 |
| 22 | Vendor updater races the agent (both install) | Vendor mode: the agent does not install while a publisher-signed SYSTEM process runs; MSI busy (1618) keeps the existing retry | 11 |
| 23 | Vendor updater moves the exe to a versioned folder | One-`*` template resolves the highest version; without a template: `verifying`, then reinstall of the bootstrap, and the dashboard suggests the template | 4, 11 |
| 24 | Vendor updater leaves the app broken | Not Rulebox's update; exe missing after the grace → bootstrap reinstall; else the admin sets `minVersion` or reassigns | 11 |
| 25 | `minVersion` raised above what the bootstrap delivers | Refused at save (`min_above_bootstrap`) | 10 |
| 26 | Vendor app version goes down (vendor rollback) | Reported; never "fixed" by Rulebox unless below `minVersion` | 11 |
| 27 | Publisher of an update differs from the rule (vendor changed certificate) | The new exe is stopped for Staff; a finding names the new signer; the admin updates the publisher | 11, Phase 5 findings |
| 28 | Publisher rule too broad | Refused for platform signers without a product; warning text for all | 10 |
| 29 | Unsigned app | Vendor mode refused; Pinned or Managed with a path rule on an admin-only folder | 10 |
| 30 | Per-user installer run as SYSTEM | `installed_per_user`; form warning when the detector suspects it | 13, 14 |
| 31 | Tauri app with its in-app updater left on | Its attempt fails in the Staff session without a prompt (deny elevation, Phase 5); documented | 23 |
| 32 | Installer waits for input | Killed at the timeout; `needs_interaction`; nothing visible to Staff | 14 |
| 33 | Installer starts the app at the end (in session 0) | The process tree is in the job and dies with it; the tail grace applies; the app never appears in the Staff session | 14 |
| 34 | EXE returns 3010 / 1641 | Success + "restart needed" when listed; otherwise failed with the code shown and a hint to add it | 14 |
| 35 | Inno returns 8 (needs restart) or 2 / 5 (cancelled) | Shown with the Inno meaning in the dashboard's exit-code help | 13 |
| 36 | Answer file recorded on another Windows version | Installer may still stop: `needs_interaction`; help text says to record on the same Windows version | 14 |
| 37 | Answer file path with a space | Cannot happen for the default data path; a custom path with spaces → `answer_file_failed` | 14 |
| 38 | Detection wrong | The admin edits; the device result is the truth | 13 |
| 39 | Host without Range support | `inspect_unsupported`; manual form | 13 |
| 40 | Inspect used to probe internal hosts | https only, no IP literals, no private names, rate limited, no body returned to the client beyond the parsed result | 13 |
| 41 | Driver package with an unsigned catalog | Refused before `pnputil` (`driver_unsigned`) | 15 |
| 42 | Driver needs a restart | "Restart needed"; the agent never restarts the PC | 15 |
| 43 | USB printer not plugged in at driver install | The driver is staged in the store; the device binds later | 15, 26 |
| 44 | Windows Protected Print Mode on | Printer drivers refused with a clear reason | 15 |
| 45 | Another Seagull driver present | Warning; the admin removes the old one first | 15 |
| 46 | Windows prefers the inbox IPP class driver (July 2026 ranking) | The printer step names the driver explicitly; record the result | 23, 26 |
| 47 | Browser policy not yet read by a running browser | `browser_ready` gates the tile; changes apply by the next sign-in at the latest | 17 |
| 48 | Chrome 147+ : `*` no longer blocks `chrome://` | Explicit entries; B-02 | 17 |
| 49 | Blocking internal pages breaks the app window | Found in Step 24; then allow the minimal set the vendor documents and record it | 24 |
| 50 | More than 800 URL patterns | Refused at save with the group named | 16 |
| 51 | Two web apps in one browser process | Task mapping by window identity; fallback per-app profiles | 18 |
| 52 | Browser window opened by a page (`target=_blank`, pop-up) | Belongs to the same app's task if the identity matches; otherwise shown under the browser's own entry; never unmanaged | 18 |
| 53 | Browser not installed on one PC of a group | Built-in fallback on that PC; device page says so from the compat `browsers` field | 6, 18 |
| 54 | Chrome app archived while web apps use it | Those web apps publish as built-in; warning in the response and on the app page | 16 |
| 55 | Edge updates itself while windows are open | Vendor behaviour; new version at the next start; path rule covers the folder | 17 |
| 56 | Admin's own browser | Staff-hive policies do not touch it; with machine keys (fallback) they do, and the dashboard says so | 17 |
| 57 | Employee profile cleanup while the browser runs | Skipped; retried at sign-out or boot | 18 |
| 58 | Browser profiles fill the disk | Keep 10 per browser, cache 50 MB each, extra cleanup below 3 GiB free | 18 |
| 59 | Employee removed while offline | Profile deleted when the roster change arrives | 18 |
| 60 | Lite PC with a browser web app | Built-in; a note on the dashboard | 18, 19 |
| 61 | Admin forces Standard on a 4 GB PC | Allowed with a warning; browser apps then open in the browser | 19 |
| 62 | Window cap reached | Dialog asks which to close; nothing closed silently | 19 |
| 63 | Idle close of a form with unsaved text | Only hidden or minimised windows; the dashboard help warns; default off in Standard | 19 |
| 64 | Old agent (no capability) gets new fields | Ignores them: Pinned, built-in; dashboard shows "agent too old" | 4 |
| 65 | Old Staff App with a new agent, or the reverse | IPC minor rule; both tests | 4 |
| 66 | MSI run twice / repair | Same version: repair, service restarts, state kept | 22 |
| 67 | MSI upgrade while an employee is signed in | By hand: allowed (the admin did it), Staff App restarts by the watchdog. By the agent (Step 20): never while signed in | 20, 22 |
| 68 | Antivirus or SmartScreen blocks the unsigned MSI | Install guide; signing (Step 9) | 9 |
| 69 | Smart App Control on | Unsigned Rulebox is blocked by Windows: compat warning, signed build needed | 6 |
| 70 | WebView2 bootstrap with no internet | Setup says so and stops before enrollment; offline installer documented | 8 |
| 71 | WebView2 older than 125 on Windows 10 | Bootstrap updates it; still old → blocker | 6, 8 |
| 72 | Release exe copied elsewhere and run | Guard refuses (install folder check) | 5 |
| 73 | Someone creates the install marker by hand on a dev PC | Needs admin rights **and** a `production` build **and** an admin-only folder that holds the exe: equal to installing. Documented; debug builds still refuse | 5 |
| 74 | Low disk on the device | Download check (size × 3) as today; keep-previous skipped; browser profile cleanup | 11, 18 |
| 75 | 4 GB RAM during an install | One operation at a time (existing); installs at boot or signed out, not during work | 11 |
| 76 | Clock skew | Apply windows use monotonic time since agent start; feed times are server times | 11, 12 |
| 77 | Managed app's product folder is writable by Staff after the vendor's installer | Existing rule: `catalogue_folder_writable`, app refused with the reason | 11 |
| 78 | Zahras POS built per-user by mistake | S-9 behaviour (observed 2026-11-25 with the Dev 1.0.2 build, which is per-user): exit 0, files in `SysWOW64\config\systemprofile\AppData\Local\<product>` → `installed_per_user` (search covers `SysWOW64` since then) | 23 |
| 79 | Hosting provider or URL host down | `download_failed`, existing backoff; nothing else breaks | 11 |
| 80 | Convex free-plan quota near its limit | Feed checks are in the "Defer" level of the degrade ladder (post-phase-5 2.12): paused for free tenants at level 3 | 12 |

## 8. Observability

- **Device page:** protection level, WebView2 version, browsers, per-app
  installed version, update state (`waiting_for_close`, `updating`,
  `rolled back`), restart needed.
- **App page:** feed status, last checked, pending version, history comes
  from the audit log (`app.versionPublished`, `app.feedRejected`,
  `app.rolledBack`), not from a new table.
- **Agent log** (local file, existing rotation): one line per update
  decision with the app id, versions and the window used. No URLs from the
  Staff session, no command lines.
- **Pilot telemetry** is only what already exists: install results, apply
  reports, findings, the daily summary. No new periodic report.

## 9. Security checklist

- [ ] The device never fetches a URL that is not in a signed document.
- [ ] Feed public keys can be changed only by an Admin; the change is
      audited and shows the old and new key fingerprints.
- [ ] Minisign verification failure can never publish.
- [ ] No downgrade without an explicit admin rollback.
- [ ] Installers still verified by SHA-256 on the device; publisher check
      when a publisher is set.
- [ ] Publisher exceptions are per app, Staff only, never in App Control,
      removed with the app.
- [ ] No path rule under a Staff-writable folder (unchanged validator).
- [ ] `silentArgs` tokens: two fixed names; no shell; argument limits kept.
- [ ] `pnputil` argument shapes fixed; `pnputil.exe` stays denied to Staff.
- [ ] Browser command line built only from validated fields.
- [ ] Browser policies journalled and restored; roots pinned by the count
      test.
- [ ] `ENROLLCODE` hidden; pending code ACL'd and deleted.
- [ ] Production guard: three independent conditions; no environment
      variable or switch; debug builds never armed by the install marker.
- [ ] No demo employees in release builds.
- [ ] `apps:inspectInstaller` cannot be used to read arbitrary responses.
- [ ] Signing keys only in CI secrets; no key in the repository.
- [ ] Every new function has a matrix row (viewer, other org, suspended,
      device).

## 10. Migration and compatibility rules

1. Convex: all new fields optional; no backfill. `appFeeds` starts empty.
2. Document format unchanged; new fields skipped when absent.
3. Journal: `installs.json` schema 2 reads schema 1; never the reverse.
4. IPC: minor bump only.
5. Aliases removed in Step 3; no agent older than Phase 5 is in the field.
6. MSI: the upgrade code is fixed forever from the first public build.
7. A PC enrolled by the CLI (VMs) can be moved to the MSI by: Disable
   kiosk, remove the CLI service, install the MSI, enroll. The guide says
   so; no automatic migration.

## 11. Test strategy

- **Dev machine (automated, safe):** unit and table tests for the version
  ordering, detector, feed parser and signature, policy compiler, guard
  decision, engine state machine (SimPlatform), convex-test for every
  function with the I/O probe, matrix rows, dashboard and Staff App tests,
  static checks of the WiX sources.
- **CI:** release build with `production`, MSI build, signing.
- **VM (the user runs it):** Steps 2, 22, 23, 24.
- **Real hardware (the user runs it):** Steps 26, 27.
- **Lab deployment (the owner runs it):** Step 25.

## 12. Known risks from research

| Risk | Detail | Handling |
|---|---|---|
| Browser policies on workgroup PCs | Chrome filters only a "sensitive" list on unmanaged PCs (read for M120); the lockdown set is not on it. Not tested on a current build | S-1 before any code; machine-key fallback |
| Chrome has no shortcut policy | A normal window can still open | Policies are account-wide; B-06, B-21 |
| Chromium changes | Chrome 147 changed `*` for `chrome://`; names drift | Policy table re-read each release; B rows re-run per major browser version in later pilots |
| Updater policies need a domain join | No pinning or rollback of Chrome / Edge | Vendor mode only; documented |
| AppLocker and SYSTEM | "By default, AppLocker policy only applies to code running in a user's context" | S-6 confirms for the Rulebox rules |
| Managed Installer | Does not support self-updating apps; over-authorises | Not used (4.4.6) |
| WiX v7 licence gate | EULA and fee threshold | Recorded in CI and README; PRD note |
| SignPath | Approval time and exact terms unknown; certificate subject is SignPath's | Unsigned pilot allowed for one laptop; product + file name in publisher rules |
| SmartScreen | Reputation is per file and certificate; EV no longer bypasses | Install guide; signed releases |
| Convex action limits | Streaming a large installer to hash it | Measured in Step 12; cap; manual pin above it |
| InstallShield | Silent switches differ per project type; `/f1` quoting | Detector marks low confidence; answer-file path without spaces; S-11 |
| Seagull / TPCL | Vendor has no public silent documentation; INF-only may miss monitors | S-10, Step 23, real printer in Step 26 |
| Printer driver timeline | Microsoft prefers the inbox IPP driver from July 2026; third-party drivers get security fixes only from July 2027 | Still allowed "via separate installation packages"; warn in the driver form |
| Edge memory | Separate user data folder = separate process group | Measured (S-4); Lite fallback |
| Free-plan I/O | New writes are small but real | 4.16; Step 25 |

## 13. Disk and dev environment

- No WiX, .NET SDK or release build on the dev machine unless the user
  agrees. CI builds the MSI.
- New Rust code adds one small crate (zip). Expect ≤ 100 MB more in
  `target\`. One workspace `target\`.
- Step 22 uses the CI artifact. If a local release build is needed, warn
  (+1-3 GB) and `cargo clean --release` afterwards.
- Detector fixtures are tiny headers, not whole installers. No installer
  files in the repository.
- No new Node tools beyond what `convex/` already uses.

## 14. Performance, memory and I/O budgets

Target: 4 GB RAM laptops in Lite mode. Phase 5 Section 14 budgets stay and
are re-measured on the laptop.

| Item | Budget | Measured in |
|---|---|---|
| MSI size | ≤ 25 MB (with the WebView2 bootstrapper) | Step 9 |
| Install time (MSI, SSD) | ≤ 60 s | Step 22 |
| Agent working set, idle, Phase 6 features on | Phase 5 budget + ≤ 2 MB | Step 26 |
| Engine reconcile with 30 apps, nothing to do | ≤ 50 ms, no file hashing | Step 11 bench |
| Sign-in hold for updates | ≤ 5 min, usually 0 | Step 23 |
| Kept previous installers | ≤ 2 GiB total, 0 below 3 GiB free | code |
| Browser profile | cache ≤ 50 MB each; ≤ 10 profiles per browser | code |
| One browser `--app` window beside the Staff App (Standard) | S-4 (browser alone, 4 GB VM): Chrome 305 MB, **Edge 397 MB** summed working set; over 350 MB → browsers off below 8 GB by default (4.9.1). Step 24 repeats it with the Staff App running | S-4, Step 24 |
| Lite: web windows | ≤ 3 open; idle close 30 min. S-4, three windows in one profile: Chrome 441 MB, Edge 577 MB | Step 26 |
| Staff App on 4 GB, desktop + 2 web apps | Phase 3 budgets hold | Step 26 |
| Feed check | ≤ 60 s and inside action memory for a 100 MiB file | Step 12 |
| Database I/O | 4.16 table | Steps 12, 25, 26 |

## 15. Hand-off after Phase 6

- Hosted-service phases H1-H4 (post-phase-5 Section 8.1), including the
  scanner and the console storage screens.
- PRD 23.4 Staff App update flow and channels (v1.x).
- Browser mode: per-app download folder, upload switch per app, blocked
  counters, if the pilot asks for them.
- More feed kinds (GitHub Releases, a generic JSON template).
- ARM64, Windows 10 with a Burn bundle, if the pilot has such PCs.

## 16. Definition of done for Phase 6

1. Steps 0-28 **Done when** checks pass (20 and 21 only if their question
   said yes); the final report is written.
2. A CI-built MSI installs, upgrades and uninstalls on the VM; the release
   agent works without the test marker; the dev machine still refuses.
3. Zahras POS updates itself through the feed, rings and an apply window
   on the VM and on the pilot laptop, and rolls back after a bad build.
4. Chrome in Vendor mode survives its own update.
5. The TPCL driver installs with no window, by one of the 4.8 routes, or
   the reason it cannot is written down with the vendor question to ask.
6. Section 6.1 has pass / fail and evidence for Edge and Chrome; B-01..B-12
   pass or the feature is off for the pilot.
7. Lite tuning measured on the 4 GB laptop; budgets met or misses accepted.
8. Aliases gone; every 4.16 row measured; the I/O results file exists.
9. Pilot 1 and Pilot 2 reports written; every carry-over row of 6.3 has a
   result.
10. The PRD matches (Section 18); `docs/plans/README.md` updated.

## 17. Decisions made in this plan

PRD 21.1 is untouched. D-a to D-h are the owner's (4.1). These are this
plan's own:

| # | Decision | Reason |
|---|---|---|
| P1 | An app update is a normal catalogue revision; no update table on the device side, no command | PRD 10; rings and rollback for free |
| P2 | The feed URL and key never leave the server | Rule 3; smaller documents |
| P3 | One hourly cron with `.take(10)` on an index; zero reads when idle | Rule 6; robust against a broken chain of self-scheduled runs |
| P4 | The server hashes the installer itself (SHA-256 and the minisign prehash) | Tauri's `latest.json` has no SHA-256; the device needs one |
| P5 | No Managed Installer | 4.4.6 |
| P6 | Browser policies in the Staff hive first; machine keys only if the VM says so | The administrator's browser stays normal |
| P7 | Browser policies are derived from the catalogue by the agent | One source of truth |
| P8 | Publisher exception generated from the app's update mode, not stored as an admin-made exception | It follows the app's life; nothing to forget |
| P9 | Vendor mode needs a signed app | An unsigned self-updater cannot be allowed safely |
| P10 | Updates install only in apply windows; the agent never closes an app | No lost work |
| P11 | Keep one previous installer per app for rollback | PRD 23.1 "a failed update rolls back automatically" |
| P12 | Production guard = feature + install marker + install folder; test marker stays for dev | Phase 5 hand-off; dev machine safety |
| P13 | Path rules for Rulebox stay; publisher rules are added | Dev builds are unsigned; SignPath's subject is not Rulebox's |
| P14 | No script or EXE custom actions in the MSI; a native Setup window does the rest | Fewer antivirus problems; VBScript is optional in Windows now |
| P15 | WebView2 by the pinned bootstrapper, run by Setup or the agent | Hash rule kept; MSI stays small |
| P16 | Detector is a pure function shared by server, browser and tests | One behaviour everywhere |
| P17 | Drivers: INF zip preferred; device-side extraction only if proven silent | Cleanest and least vendor-specific |
| P18 | WebView2 browser flags stay off | Microsoft guidance; Phase 3 measurements |
| P19 | Lite mode always uses the built-in window | Memory |
| P20 | No new periodic device report | Rule 6 |

## 18. PRD changes to make (tell the user; applied in Step 1 after sign-off)

**Approved in full by the owner on 2026-11-19; applied to `docs/prd.md` in Step 1.**

| PRD section | Change | Why |
|---|---|---|
| 2 (line 68) | "The real Windows … browser … not available" → add "A web app may be opened in a locked-down Chrome or Edge window if the administrator chooses that" | D-g |
| 6 (table, Web app row) | "Opens in its own Rulebox window" → "… or, per app, in a locked-down Chrome or Edge app window" | D-g |
| 6 (Custom installer row) | "Installer upload plus silent-install flags" → "Installer URL (upload when hosting exists) plus silent-install flags, **pre-filled** from the detected installer type; optional answer file" | D-h; Phase 4 already deviated to URLs |
| 6.2 | Add: in browser mode the allowlist is the union of all browser web apps on the device, and the browser shows its own blocked page | D-g limitation |
| 6.3 | Add "Update mode" and "Opens in" to per-app settings | D-a, D-g |
| 7.3 | "Files downloaded from web apps are saved only to the employee's folder" → add "Downloads are off in browser mode (v1)" | D-g (Q6) |
| 10 | Add one sentence: app versions found by the server from a vendor feed are published as desired-state versions; devices never read feeds | D-b; removes the wording tension |
| 12.3 | Add: installer publisher check (optional); vendor feed signatures are verified by the server; the device verifies SHA-256 | D-b |
| 13.1 | Row "Links in allowed apps opening a browser": add the browser-mode controls. Row "Apps that self-update": point to update modes | D-c, D-g |
| 13.5 | "App self-updates": describe Vendor mode and minimum version. "Failed installs": add "needs interaction" | D-c, D-h |
| 14 | Add rows actually built: WebView2 **version**, protection level Full / Reduced, Protected Print warning; "Install it automatically" → "installed by Rulebox Setup from the bundled bootstrapper" | Step 6, 8 |
| 15 | "Script" app type: mark as not in v1 | Not in the code |
| 16 | Installer: "WiX v7 MSI (hand-authored)"; add the OSMF note: WiX v7 needs its EULA accepted and a maintenance fee once revenue from projects using WiX reaches US$10,000 a year. Code signing: SignPath (chosen). "App updates: Tauri updater + GitHub Releases" → "Agent-installed; Tauri update **format** only" (matches 23.2). Installer storage: per Q1 / A21 | D-d, D-e, D-f, A21, A22 |
| 22.4 | "One WebView2 environment per signed-in employee" → add "browser-mode web apps use one browser profile per employee and are not available in Lite mode"; add the window cap | D-g, Step 19 |
| 22.5 | No text change; now implemented (override) | Step 19 |
| 23.2 | Managed apps row: name the three update modes | D-a |
| 23.4 / 23.9 | If Q8 = yes: note that v1 updates Rulebox by MSI major upgrade with no employee signed in; the `versions\` flow is v1.x | Step 20 |
| 24.1 | Add: in browser mode permissions are enforced by browser policy per site; screen sharing and clipboard read stay blocked; no notice and no counter | D-g |
| 24.2 | Add a "Drivers" bullet (Phase 5 asked for it): signed INF package or silent vendor installer, from the signed manifest only | Phase 5 Step 14b |
| 21.1 | **No change by the agent.** If the owner wants update modes or browser web apps locked, the owner adds Decisions 20 and 21 | Locked list |
| `guard.rs` header / Phase 2 plan statement "no bypass" | Becomes "two doors: test marker, or an installed production build" | Step 5 |
| Phase 5 Section 16 | "replace the invariant path rules" → "add publisher rules beside them" | P13 |

## 19. Open questions for the user

**Answered 2026-11-14 by the owner: every recommendation below is accepted** (Q1 a, Q2 a, Q3 a, Q4 a, Q5 a,
Q6 a, Q7 a, Q8 a, Q9 a, Q10 a, Q11 a, Q12 a, Q14 b; Q13 is the owner's Zahras POS confirmation, still due
before Step 23). Section 18 PRD edits are applied in Step 1 when Phase 6 starts. **Phase 6 is on hold** until
the owner says to start it (Phase 5 finishes first).
**Update 2026-11-19:** answers are recorded; Phase 6 has started (Steps 1 and 3 done); Section 18 was
approved in full on 2026-11-19 and applied to the PRD in Step 1.

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Installer hosting in Phase 6? Note: post-phase-5 Q4 was answered on 2026-10-27 ("pooling is kept, start with ONE account, operator adds accounts when needed"), but A21 puts hosting in Phase 6 and H3 needs H1 and a scanner | (a) Pilot with https URLs (GitHub Releases for Zahras POS, any https host for the driver zip); hosting stays H3. (b) Build S1 + S4 now with one account and server-side hashing, no scanner (Step 21). (c) Full Section 6 now | **(a).** The pilot does not need uploads; (b) adds about two weeks and an unscanned upload path; pooled free accounts still have unverified terms. Decide the provider when H3 starts |
| Q2 | Must the MSI be signed before the pilot? | (a) Laptop pilot may be unsigned; group pilot signed. (b) Both signed. (c) Neither | **(a).** SignPath lead time is unknown |
| Q3 | Managed updates: publish automatically? | (a) Automatic; with rings on they stop at Pilot until promoted. (b) Always wait for "Approve" | **(a)**, default per app, switchable |
| Q4 | WebView2 on Windows 10 PCs | (a) Bundled bootstrapper run by Setup (needs internet). (b) Burn bundle with the offline installer (+127 MB). (c) Block and ask the admin to install it | **(a)** |
| Q5 | Where browser policies live | (a) Staff hive; machine keys only if the VM requires. (b) Machine keys always | **(a).** Keeps the admin's browser normal |
| Q6 | Downloads and uploads in browser mode | (a) Downloads off; uploads off by default with a group switch. (b) Downloads into one shared folder | **(a)** for v1 |
| Q7 | Default for a new web app when Chrome or Edge exists | (a) Built-in always. (b) Suggest Edge on PCs above 4 GB | **(a)** |
| Q8 | Rulebox's own updates during the pilot | (a) Minimal agent-driven MSI upgrade (Step 20). (b) The owner visits or remotes into each PC | **(a).** A group pilot without it means a visit per fix |
| Q9 | "Check a file on this computer" in the app form | (a) Yes, lazy-loaded. (b) No, URL inspection only | **(a)** if the dashboard size budget holds |
| Q10 | Setup UI | (a) Small native window. (b) Console only | **(a)** (PRD 14 "reports results clearly") |
| Q11 | Sign-in hold for boot-time updates | (a) Up to 5 min. (b) Never hold; update only when signed out | **(a)** |
| Q12 | Pilot group size and length | (a) 3-10 PCs, 2 weeks. (b) Larger | **(a)** |
| Q13 | Zahras POS build | The owner confirms: NSIS, per machine, in-app updater off, `latest.json` on GitHub Releases, public key available | Needed before Step 23 |
| Q14 | May the feed check download up to 512 MiB per new version on the free Convex plan? | (a) Yes, cap from Step 12's measurement. (b) Lower cap (100 MiB) | **(b)** until measured |

## 20. Could not be verified

Each item says where it gets settled. Nothing was compiled or run.

- Browser policy from the Staff hive on a workgroup PC; reload timing;
  current sensitive-policy list — S-1, S-2.
- AppUserModelID of `--app` windows — S-3.
- Policy names marked in 4.9.3 — Step 17 re-read.
- Behaviour of an `--app` window for print, save, pop-ups, drag and drop —
  Step 24.
- AppLocker and SYSTEM-started processes — S-6.
- MSI property values on Windows 10 / 11; key ACL without a custom action;
  the WiX v7 EULA command — S-7, Step 7.
- SignPath terms, lead time, certificate subject — Step 9.
- Convex action limits for streamed downloads; minisign field encoding —
  Step 12.
- Tauri NSIS `/S` under SYSTEM; per-user build location — S-8, S-9.
- TPCL extract and silent switches; INF-only completeness — S-10, S-11,
  Steps 23 and 26.
- Protected Print Mode registry value; Smart App Control state value —
  S-12, Step 6.
- InstallShield and Advanced Installer markers (low confidence) — Step 13
  fixtures.
- Whether `rollouts:health` counts install failures (it reads apply
  reports) — check at Step 11; if not, the apply report carries an
  `installsFailed` count for the config version (no new write).
- Chrome and Edge memory per window — S-4.
- Phase 5 Steps 13, 15, 16 build state — Step 0.
- Whether the kill-on-close job note from Phase 4 is fully resolved — Step 22.

## 21. Sources

Research date **2026-11-14**. Re-read at the step that uses them.

WiX and MSI
- https://docs.firegiant.com/wix/schema/wxs/serviceinstall/
- https://docs.firegiant.com/wix/schema/util/serviceconfig
- https://docs.firegiant.com/wix/schema/wxs/majorupgrade/
- https://docs.firegiant.com/wix/schema/wxs/launch/
- https://docs.firegiant.com/wix/whatsnew/
- https://learn.microsoft.com/en-us/windows/win32/msi/operating-system-property-values
- https://learn.microsoft.com/en-us/windows/win32/msi/error-codes

WebView2
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model

Tauri
- https://v2.tauri.app/distribute/windows-installer/
- https://v2.tauri.app/plugin/updater/
- https://schema.tauri.app/config/2
- https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
- https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/src/updater.rs

Silent installs and detection
- https://nsis.sourceforge.io/Docs/Chapter3.html
- https://jrsoftware.org/ishelp/topic_setupcmdline.htm
- https://jrsoftware.org/ishelp/topic_setupexitcodes.htm
- https://github.com/microsoft/winget-cli/blob/master/src/AppInstallerCommonCore/Manifest/ManifestCommon.cpp
- https://github.com/microsoft/winget-create/blob/main/src/WingetCreateCore/Common/PackageParser.cs
- https://learn.microsoft.com/en-us/windows/package-manager/package/manifest
- https://learn.microsoft.com/en-us/windows/package-manager/winget/troubleshooting
- https://learn.microsoft.com/en-us/intune/app-management/deployment/win32

Drivers and printing
- https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax
- https://learn.microsoft.com/en-us/powershell/module/printmanagement/add-printerdriver
- https://learn.microsoft.com/en-us/windows-hardware/drivers/print/end-of-servicing-plan-for-third-party-printer-drivers-on-windows
- https://support.seagullsoftware.com/hc/en-us/articles/217079168

Application control and updates
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/understanding-the-publisher-rule-condition-in-applocker
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/select-types-of-rules-to-create
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/configure-authorized-apps-deployed-with-a-managed-installer
- https://learn.microsoft.com/en-us/intune/intune-service/apps/apps-win32-supersedence
- https://learn.microsoft.com/en-us/intune/app-management/deployment/enterprise-app-management
- https://learn.microsoft.com/en-us/windows/deployment/update/create-deployment-plan

Chrome and Edge
- https://chromium.googlesource.com/chromium/src/+/main/docs/updater/functional_spec.md
- https://learn.microsoft.com/en-us/deployedge/microsoft-edge-update-policies
- https://support.google.com/chrome/a/answer/6350036
- https://raw.githubusercontent.com/chromium/chromium/main/components/policy/core/common/policy_loader_win.cc
- https://raw.githubusercontent.com/chromium/chromium/120.0.6099.1/components/policy/core/common/policy_loader_common.cc
- https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/browser_command_controller.cc
- https://chromeenterprise.google/policies/
- https://support.google.com/chrome/a/answer/9942583
- https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/urlblocklist
- https://learn.microsoft.com/en-us/deployedge/microsoft-edge-configure-kiosk-mode
- https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/sleepingtabsenabled
- https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/efficiencymodeenabled

Signing
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/azure/artifact-signing/faq

Repository
- `CLAUDE.md`, `docs/prd.md`, `docs/plans/phase-4-dashboard-state.md`,
  `docs/plans/phase-5-lockdown.md`,
  `docs/plans/post-phase-5-architecture-and-io.md`,
  `.personal/phase6-requirements.md`, `.personal/installer-hosting-tigris.md`
  (both gitignored), and the code anchors of Section 3.2.
