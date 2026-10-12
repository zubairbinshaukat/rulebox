# Phase 3 — Staff App as the shell

> **For the implementing agent:** follow this plan step by step. Each step
> has a **Done when** check — run it and see it pass before moving on.
> Read `CLAUDE.md` first, then the reading list in Section 4. Do not build
> anything listed under Non-goals.
>
> **Four rules override everything else in this file:**
>
> 1. **The Staff App has no admin rights and never asks for them.** Every
>    privileged action goes to the agent over IPC. A UAC prompt in the
>    Staff session is a bug. Never call `ShellExecute`, never use a Tauri
>    plugin that opens files or URLs with Windows' default handlers.
> 2. **Nothing system-altering runs on the dev machine.** Setting the work
>    area, registering as the task manager window, hiding minimized
>    windows, and global hotkeys happen only in **shell mode** (Section
>    5.2), which is detected automatically and is never true while
>    Explorer is the shell. Replacing the shell is tested only on a VM, by
>    the user.
> 3. **Web app content is hostile.** A window that shows a remote site
>    gets no Tauri IPC, no capability, no local file access and no access
>    to the pipe. Never add a capability that matches `web-*`. Never add a
>    `remote` entry to a capability.
> 4. **Do not edit the Phase 2 plan or the files Phase 2 owns**
>    (`crates/rulebox-ipc`, `crates/rulebox-win32`, `apps/agent`,
>    `apps/shell-launcher`). What Phase 3 needs from them is listed in
>    Section 15; report it, do not implement it there.

Research date for every version and Windows fact in this file:
**2026-10-13**. Items marked **(unverified)** could not be confirmed from
a primary source; the plan says how each one gets confirmed.

---

## 1. Goal

At the end of Phase 3:

1. `rulebox-staff.exe` starts, shows the logo splash, and reaches the
   **sign-in screen**. An employee signs in and sees the **desktop**: a
   greeting, tiles for their apps, and a "My files" panel.
2. A **taskbar** stays on top at the bottom edge: Start button, pinned
   and running apps with an open/active indicator, quick settings
   (volume, battery, network status), clock, and the employee's avatar.
   Maximized windows of other apps never cover it.
3. The **Start menu** lists the employee's apps with search, recent
   files, the profile, Log out and power options.
4. **Other apps' windows are tracked**: every top-level window appears in
   the taskbar and can be focused, minimized, restored and closed from
   it. Desktop apps are launched by the shell as the Staff user.
5. **Web apps** open in their own window, restricted to their allow-list
   of domains, with per-app permissions and downloads that land only in
   the employee's folder.
6. A **file explorer** shows only the employee's folder. Double-click
   opens a file in a **built-in viewer** (image, audio, video, PDF, text,
   CSV, DOCX, XLSX) or in the approved app from the `fileHandlers` table.
   Executables and scripts never open.
7. **Log out** closes the employee's apps and returns to sign-in.
8. Everything works with **no internet**, in **light and dark**, with
   **reduced motion**, and in **Lite mode** on a 4 GB laptop.
9. On a VM, with the Phase 2 agent, the app runs as the **actual shell**
   of the Staff account with Explorer absent.

On the **dev machine** the whole UI runs in a normal window arrangement
("dev mode") against a built-in demo agent or the Phase 2 simulated
agent, with Explorer untouched.

## 2. Non-goals (do NOT build in Phase 3)

| Not in Phase 3 | Belongs to |
|---|---|
| Anything inside `crates/rulebox-ipc`, `crates/rulebox-win32`, `apps/agent`, `apps/shell-launcher`; the agent side of any IPC method | Phase 2 (see Section 15) |
| Verifying employee credentials, the offline credential cache, sign-in rate limiting, employee records, the app catalogue's real data, wiping app data folders on logout, storing the admin-exit PIN | Agent and backend (Phases 2 and 4). Phase 3 builds the UI and the calls |
| Dashboard, Convex functions, Convex Auth. **The Staff App does not connect to Convex at all** (Section 3, A-13) | Phase 4 |
| Installing apps, update flow and "Update ready — restart Rulebox" (PRD 23.4) | Phase 4 / later |
| Lockdown policies, App Control, the process allow-list watchdog, blocking Ctrl+Alt+Del or Task Manager, restricting common file dialogs and print dialogs, device lock screen (PRD 24.4), broadcast messages, Wi-Fi list / connect / toggle, printer setup | Phase 5 |
| Custom title bar on **web app** windows (Tauri multiwebview is still behind the `unstable` flag; PRD 13.6 #7 says build the native title bar first) | later enhancement |
| System tray host, Windows toast hosting, multi-monitor taskbars | v1.x (PRD 13.4, 17) |
| Low-level keyboard hooks of any kind (so: no "Windows key opens Start") | Section 17, P7 |
| PPTX preview (Section 17, P5), HEVC/AVI/WMV playback, editing any document | later |
| Idle auto-logout, idle auto-close of web apps (PRD 22.4), shift hours | later; the hooks are noted in Section 13 |
| MSI, WebView2 bootstrap, code signing, release builds | Phase 6 |

---

## 3. Assumptions from Phase 2 open questions

The Phase 2 questions are **not answered yet**. Phase 3 is planned on the
Phase 2 recommendations. If the user picks the other option, only the
places in the last column change.

| # | Phase 2 question | Assumed answer | If the user picks the other option |
|---|---|---|---|
| A-8 | Q8: who relaunches a crashed Staff App | `rulebox-shell.exe` stays alive and relaunches it; exit code 0 means "restart me now" | Section 6.5 (exit codes) and Step 9's "Restart Rulebox" path change: the app would ask the agent to restart it over IPC instead of exiting with 0. Nothing else moves |
| A-13 | Q13: where the Staff App gets the Convex URL | Moot for Phase 3: the Staff App never connects to Convex. `convexUrl` in the snapshot is ignored | If employee sign-in must talk to Convex directly from the Staff App: Step 3 (`AgentPort::sign_in`), Step 5 (sign-in), the CSP in Step 1 and Section 17 P1 change. Everything else stays |
| A-14 | Q14: crash-loop fallback | The launcher shows the native "Contact your administrator" screen. The Staff App does nothing special | If "drop to Explorer" is chosen: no Phase 3 change (it is launcher behaviour) |
| A-1 | Q1: device auth to Convex | Not relevant to the Staff App (it has no Convex connection and never sees the device secret) | No change, unless A-13 flips; then the Staff App would need its **own** credential, never the device secret |
| A-5 | Q5: what "Disable kiosk" does | The agent sends `agent.shuttingDown { reason: "kioskDisabled", graceMs }`, then signs the Staff session out | Step 5 (`ShuttingDown` banner text) only |
| A-12 | Q12: kiosk on right after enrollment | The Staff App can start on a device with no desired state document and no apps | Step 6's empty state already covers it |
| A-16 | Q16: policy signing | The Staff App trusts what the agent gives it and verifies nothing itself | No change |
| A-2..4, 6, 7, 9..11, 15 | — | No effect on Phase 3 | — |

Decisions already made by the user and used here:

- **Hidden admin exit (PRD 9.5, 12.4):** the key combination is set per
  organization from the dashboard, with a fixed default (suggested
  Ctrl + Alt + Shift + R; the exact default is still open, P3). A correct
  PIN **signs the Staff session out to the Windows sign-in screen**. It
  goes through the agent (Section 6.4), because automatic sign-in would
  otherwise sign Staff straight back in and because PIN checking must not
  live in the untrusted session.
- **Ctrl + Alt + Del is not an admin route (PRD 9.5, 12.2).** Its screen
  is emptied for the Staff account by policy, including Switch user.
  Applying that policy is Phase 5 and agent work; Phase 3 neither applies
  it nor depends on it. The consequence for Phase 3: **the hidden exit is
  the only way from the Staff session to an admin**, so it must be robust
  (Section 7.11). Recovery when the Staff App itself is broken is outside
  the app: Disable kiosk from the dashboard, or hold Shift during startup
  to skip automatic sign-in.

---

## 4. Prerequisites

### 4.1 Reading list

- `CLAUDE.md` (all of it).
- `docs/plans/phase-2-agent-core.md`: Section 6 (the IPC contract) in
  full; Sections 4.3 and 6.9–6.10; skim the rest.
- `docs/prd.md` — Sections 2, 3.3, 4 (all), 5, 6, 7, 8, 9.2, 9.5, 12.1,
  12.4, 13.1, 13.3, 13.4, 13.6 (rows 3, 6, 7), 21 (locked; never
  re-open), 22 (all), 24.1, 25 (all). Lines 1–1690 have escaped markdown;
  that is cosmetic.
- `design/staff-desktop-v0/Rulebox Staff Desktop.dc.html` — the look to
  match. **Skip** `Rulebox Staff Desktop.html` and `support.js`. It is a
  starting vibe, not the spec: the PRD wins on behaviour. Known
  differences you must not copy: it loads Geist from Google Fonts (use
  Figtree, bundled); it draws its own glyphs (use Solar icons); it has no
  Start menu; its windows are in-page `div`s; it animates
  `left/top/width/height` and `box-shadow`; its variables are
  `--t0…--t83` (never copy those names); its sample tenant text
  ("Larkfield Logistics", "ext. 4410", "any password works") is not
  product copy.
- `packages/ui/src/components/LogoMotion.tsx` and `LogoMark.tsx`. Use
  them; never redraw or re-time the logo.

### 4.2 What exists today

- `apps/staff-app/src/main.tsx` and `App.tsx` only. `main.tsx`
  **requires** `VITE_CONVEX_URL` to render; `App.tsx` is a static sign-in
  picture using `health.ping` and a hand-drawn placeholder logo. Both are
  replaced.
- `apps/staff-app/vite.config.ts`: React plugin, alias `@convex`, port
  1420. **No** `unplugin-icons`. `tsconfig.json` lacks
  `unplugin-icons/types/react`.
- `apps/staff-app/src-tauri`: Tauri 2.12.3, crate `rulebox-staff`, lib
  `rulebox_staff_lib`, one decorated 1280×800 window `main`, capability
  `default` = `core:default` for `main`, no commands, no plugins, no
  Cargo features, `bundle.active: false`.
- `packages/ui` exports: `Button`, `Input`, `Panel`, `Avatar`,
  `SegmentedControl`, `AppTile`, `TitleBar`, `Backdrop`, `ErrorBoundary`,
  `Pill`, `Switch`, `ProgressBar`, `StatCard`, `LogoMark`, `LogoMotion`,
  `setTheme`, `setLite`. Tokens are `--rb-*` in `tokens.css`. Lite mode
  is `[data-lite="true"]`, which kills CSS transitions and animations but
  **not** JavaScript-driven (GSAP) animation.
- Not installed anywhere: `gsap`, `@gsap/react`, `@tauri-apps/api`, any
  Tauri plugin, any router, any state library, any test runner.
- `packages/types/src/index.ts` is a manual barrel.

---

## 5. Architecture

### 5.1 Windows and WebViews

The target is 4 GB of RAM, so the number of WebViews is a budget. All
shell and built-in windows load the same local origin and use the default
WebView2 data folder, so they share **one** browser process tree. Web
apps use a second data folder per employee (one more tree).

| Window label | Count | What it shows | Window settings |
|---|---|---|---|
| `shell-desktop` | 1, lives for the whole run | Splash, sign-in, lock, desktop (layers in one page) | No decorations, sized to the primary monitor, kept at the bottom, never closable |
| `shell-taskbar` | 1, lives for the whole run | The taskbar | No decorations, always on top, `focusable(false)`, 84 px high strip at the bottom edge, never closable |
| `shell-popup` | 1, created at start, hidden until used | Start menu, quick settings, account menu, app switcher, thumbnail preview, admin-exit PIN | No decorations, always on top, hidden from our own taskbar, closes on blur |
| `shell-exit` | 0..1, created only while the admin exit is open | The admin-exit PIN dialog, from its own minimal page (`exit.html`) | No decorations, always on top, centred, 380×300, takes focus |
| `app-<n>` | 0..n (Standard mode); exactly 0..1 (Lite mode) | Built-in apps: file explorer and viewers, with the Rulebox title bar | No decorations, resizable, shadow on |
| `web-<appId>-<n>` | 0..n | One remote web app | **Native** decorations, external URL, per-employee data folder, no IPC |

Rules:

- **No transparent windows and no window effects** (Mica/Acrylic). Tauri
  documents them as slow while dragging or resizing, and they need
  transparency. The frosted look is CSS inside each page. (PRD 4.1 asks
  for Mica/Acrylic on Windows 11; see Section 16.)
- The **Tauri `unstable` feature is forbidden** (multiwebview). That is
  why web app windows use the native title bar.
- **Lite mode** (PRD 22.4): there is one `app-0` window with a tab per
  open file or tool. **Standard mode:** each built-in app opens its own
  `app-<n>` window. The React code is the same (`AppHost` with one or
  many tabs).
- Minimized or hidden WebViews are suspended (Step 17).

### 5.2 Shell mode and dev mode

```rust
// crates/rulebox-desktop/src/mode.rs
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShellMode { Shell, Dev }
/// Shell only when no other process owns the shell window (GetShellWindow() is null)
/// and RULEBOX_STAFF_FORCE_DEV is not set. Decided once at startup.
pub fn detect() -> ShellMode;
/// Proof that we are in shell mode. Functions that change the session take `&ShellToken`.
pub struct ShellToken(());
impl ShellToken { pub fn acquire(mode: ShellMode) -> Option<ShellToken>; }
```

| | Shell mode (VM only) | Dev mode (dev machine, Explorer running) |
|---|---|---|
| `shell-desktop` | Borderless, covers the primary monitor, bottom of the z-order | Normal decorated window, 1280×800, title "Rulebox (dev)" |
| `shell-taskbar` | Bottom 84 px of the primary monitor | Same strip, placed directly above the Windows taskbar (bottom of the current work area), not topmost |
| Work area | Set with `SPI_SETWORKAREA` | **Not touched** |
| `SetTaskmanWindow`, `ARW_HIDE`, global hotkeys | Yes | **Never** |
| Window tracking and control | Yes | Yes (read-only tracking is harmless; it behaves like a second taskbar) |
| Closing apps on logout | Only windows and processes **the shell launched** | Same rule. Never close anything the shell did not launch |

Every function in `rulebox-desktop` that changes session-wide state takes
`&ShellToken`, so it cannot be called in dev mode by mistake.

### 5.3 Rust side versus React side

**Rust is the source of truth.** React renders what Rust sends and asks
Rust to act. No window keeps authoritative state of its own, because
several windows show the same state.

| Concern | Rust (`apps/staff-app/src-tauri`, `crates/rulebox-desktop`) | React (`apps/staff-app/src`) |
|---|---|---|
| Agent link | `AgentPort` (real IPC or demo), heartbeat | shows status |
| Session | sign-in / sign-out calls, employee state, files root | forms and screens |
| Windows of other apps | tracking, icons, control, thumbnails | taskbar buttons |
| Shell windows | creation, placement, DPI, popup positioning | content |
| Files | `SafeRoot`, quota, watcher, `rbfile` protocol, open-with | explorer and viewers |
| Web apps | window creation, allow-list, permissions, downloads | none (remote content) |
| System | volume, battery, network status, power, hotkeys | sliders and menus |

React state: one small store per window built on `useSyncExternalStore`,
filled by `invoke("shell_state")` at load and kept current by the Tauri
event `shell://state`. **No state library and no router are added.**
Each window reads its route from `location.hash`.

### 5.4 File layout

```
crates/rulebox-desktop/                 # new; Win32 for the shell (see Section 15, R5)
├─ Cargo.toml
└─ src/
   ├─ lib.rs            # #![cfg(windows)]
   ├─ error.rs          # DesktopError
   ├─ mode.rs           # ShellMode, ShellToken
   ├─ msgloop.rs        # dedicated Win32 thread + hidden window + command channel
   ├─ windows.rs        # enumerate, taskbar filter, WindowInfo
   ├─ tracker.rs        # shell hook + WinEvent hooks -> WindowEvent stream
   ├─ control.rs        # activate, minimize, restore, maximize, close, hung check, move
   ├─ workarea.rs       # SPI_SETWORKAREA, ARW_HIDE, SetTaskmanWindow (ShellToken)
   ├─ icons.rs          # HICON / exe icon -> PNG bytes
   ├─ thumbs.rs         # DWM thumbnails
   ├─ launch.rs         # CreateProcessW + job objects
   ├─ audio.rs          # Core Audio volume / mute
   ├─ power.rs          # battery, shutdown / restart / sleep
   ├─ net.rs            # connectivity status
   ├─ hotkeys.rs        # RegisterHotKey (ShellToken)
   └─ notify.rs         # display, DPI, power-resume, session notifications

apps/staff-app/src-tauri/
├─ Cargo.toml           # changed
├─ build.rs             # changed: AppManifest::commands
├─ tauri.conf.json      # changed
├─ capabilities/
│  ├─ shell.json        # windows: shell-*
│  └─ apps.json         # windows: app-*          (default.json is deleted; nothing matches web-*)
└─ src/
   ├─ main.rs
   ├─ lib.rs            # builder, plugins, setup, command registration
   ├─ model.rs          # all types shared with React (ts-rs export)
   ├─ state.rs          # AppState, publish()
   ├─ agent/
   │  ├─ mod.rs         # AgentPort trait, AgentError
   │  ├─ ipc.rs         # IpcAgent (rulebox-ipc client)
   │  └─ demo.rs        # DemoAgent (debug builds only)
   ├─ shellwin.rs       # create/place shell-desktop, shell-taskbar, shell-popup
   ├─ appwin.rs         # app-* windows, snapping, position memory
   ├─ session.rs        # sign-in, sign-out, lock, logout cleanup
   ├─ tasks.rs          # tracked windows -> TaskItem list, grouping
   ├─ launcher.rs       # launching catalogue apps
   ├─ files/
   │  ├─ mod.rs
   │  ├─ saferoot.rs    # SafeRoot (confinement)
   │  ├─ names.rs       # name validation (pure)
   │  ├─ types.rs       # extension tables: viewers, deny-list (pure)
   │  ├─ quota.rs       # usage + watcher
   │  ├─ protocol.rs    # rbfile:// handler with Range
   │  ├─ preview.rs     # text / csv / office pre-checks
   │  └─ openwith.rs    # fileHandlers launch
   ├─ webapp/
   │  ├─ mod.rs         # window creation
   │  ├─ allow.rs       # domain allow-list (pure)
   │  ├─ hooks.rs       # webview2-com event handlers
   │  └─ download.rs    # download destination + sanitising
   ├─ system.rs         # volume, battery, network, power commands
   ├─ hotkeys.rs        # app switcher, Start, admin exit
   └─ commands.rs       # #[tauri::command] functions (thin)

apps/staff-app/
├─ shell.html           # entry for shell-desktop / shell-taskbar / shell-popup
├─ exit.html            # entry for shell-exit (admin exit; minimal, no shared store)
├─ apps.html            # entry for app-* windows
├─ vite.config.ts       # changed
└─ src/
   ├─ shell/main.tsx, apps/main.tsx
   ├─ lib/              # tauri.ts (typed invoke), store.ts, motion.ts, format.ts, a11y.ts
   ├─ shell/
   │  ├─ DesktopRoot.tsx          # layer switch: splash | signin | lock | desktop
   │  ├─ boot/Splash.tsx, boot/StatusScreen.tsx
   │  ├─ signin/SignIn.tsx, signin/LockScreen.tsx
   │  ├─ desktop/Desktop.tsx, AppGrid.tsx, tileLayout.ts, MyFilesPanel.tsx
   │  ├─ taskbar/Taskbar.tsx, TaskButton.tsx, SystemArea.tsx, Clock.tsx
   │  └─ popup/PopupRoot.tsx, StartMenu.tsx, QuickSettings.tsx, AccountMenu.tsx,
   │        AppSwitcher.tsx, ThumbPreview.tsx, ConfirmLogout.tsx
   ├─ exit/main.tsx, exit/AdminExit.tsx       # the shell-exit window's page
   └─ apps/
      ├─ AppHost.tsx              # title bar + tabs + content
      ├─ files/FileExplorer.tsx, FileGrid.tsx, FileList.tsx, useSelection.ts, keymap.ts
      └─ viewers/ImageViewer.tsx, MediaPlayer.tsx, TextViewer.tsx, CsvViewer.tsx,
               PdfViewer.tsx, DocxViewer.tsx, SheetViewer.tsx, Unsupported.tsx

packages/ui/src/        # additions only (Step 2)
vendor/xlsx-0.20.3.tgz  # SheetJS, vendored (Step 14)
```

### 5.5 Dependencies

**Pin by checking.** Confirm every version with `npm view <pkg> version`
or `cargo search <crate> --limit 1` before writing it. The "Found" column
is what research saw on 2026-10-13. Use a newer patch freely; stop and
ask before a newer minor or major.

JavaScript (add to the `catalog:` in `pnpm-workspace.yaml`, then to
`apps/staff-app/package.json`):

| Package | Found | Why |
|---|---|---|
| `@tauri-apps/api` | 2.12.3 | `invoke`, events. Match the Rust `tauri` minor |
| `gsap`, `@gsap/react` | check | PRD 25: GSAP + Flip. Not installed yet. Already credited in `THIRD_PARTY_NOTICES.md` |
| `unplugin-icons`, `@iconify-json/solar`, `@svgr/core`, `@svgr/plugin-jsx` | in catalog | Solar icons at build time (Decision 16); copy the dashboard's setup |
| `@tanstack/react-virtual` | 3.14.17 (MIT) | Virtual lists for folders with thousands of files. Positions rows with `transform` |
| `pdfjs-dist` | 6.4.299 (Apache-2.0) | PDF viewer. Use the **legacy** build |
| `docx-preview` | 0.4.1 (Apache-2.0) | DOCX read-only preview |
| `xlsx` (SheetJS CE) | 0.20.3 (Apache-2.0), **vendored tarball** | XLSX preview. The npm registry copy (0.18.5) is stale; do not use it |
| `dompurify` | 3.4.17 (MPL-2.0 OR Apache-2.0) | Sanitising generated document HTML |
| `vitest`, `jsdom`, `@testing-library/react` | check | Unit tests for pure logic and stores (dev only) |

Rust (`[workspace.dependencies]`; Phase 2 adds this table — if it does
not exist yet, create it and tell the user, because both phases write to
the root `Cargo.toml`):

| Crate | Found | Used by | Why |
|---|---|---|---|
| `tauri` | 2.12.3 | staff | Minimum 2.12.0 (security fixes for remote-origin IPC and channels). **No** features: not `unstable`, not `protocol-asset` |
| `tauri-plugin-single-instance` | 2.5.3 | staff | One Staff App per session (required by the launcher contract) |
| `webview2-com` | 0.39.1 | staff | Raw WebView2 events for web apps. Same version Tauri already compiles |
| `windows` | 0.62.2 | desktop, staff (`webapp/` only) | Win32. Same line as Tauri and Phase 2 |
| `rulebox-ipc` (feature `client`), `rulebox-policy` | path | staff | The contract and `DesiredState` |
| `serde`, `serde_json`, `ts-rs`, `thiserror`, `tracing`, `tracing-subscriber`, `tracing-appender` | as Phase 2 | staff, desktop | Same choices as Phase 2 |
| `cap-std` | 4.0.3 | staff | Directory-handle confinement for employee files |
| `walkdir` | 2.5.0 | staff | Folder size |
| `notify`, `notify-debouncer-full` | 8.2.0 / 0.7.0 | staff | Live refresh and usage updates |
| `infer` | 0.22.0 | staff | Refuse executable content behind an allowed extension |
| `chardetng`, `encoding_rs` | 1.0.0 / 0.8.42 | staff | Text decoding |
| `csv` | 1.4.0 | staff | CSV parsing off the JS heap |
| `dunce` | 1.0.5 | staff | Removing the `\\?\` prefix for display and launch |
| `png`, `zip` | check | staff | Icon encoding; zip-bomb pre-check for Office files |

Do **not** add: `tauri-plugin-fs`, `-dialog`, `-opener`, `-shell`,
`-notification`, `-store`, `-window-state`, `-global-shortcut`,
`tauri-plugin-frame`, a router, zustand/redux/jotai, `mammoth`,
`exceljs`, `papaparse`, `trash`, `jwalk`, `image`, `wmi`. Research
rejected each (attack surface, default file associations, staleness, or
weight).

---

## 6. Consuming the IPC contract

### 6.1 The port

React never sees IPC. Tauri commands call one trait:

```rust
// apps/staff-app/src-tauri/src/agent/mod.rs
pub trait AgentPort: Send + Sync + 'static {
    fn link(&self) -> tokio::sync::watch::Receiver<AgentLink>;           // Disconnected | Connecting | Linked | VersionMismatch
    fn snapshot(&self) -> tokio::sync::watch::Receiver<Option<rulebox_ipc::AgentSnapshot>>;
    fn capabilities(&self) -> Vec<String>;
    fn ready(&self) -> BoxFuture<'_, Result<(), AgentError>>;            // shell.ready
    fn heartbeat(&self) -> BoxFuture<'_, Result<(), AgentError>>;        // shell.heartbeat
    // protocol 1.1 (Section 6.4). Return AgentError::Unsupported when the capability is missing.
    fn sign_in(&self, req: SignInRequest) -> BoxFuture<'_, Result<SignInOutcome, AgentError>>;
    fn sign_out(&self) -> BoxFuture<'_, Result<(), AgentError>>;
    fn verify_password(&self, password: String) -> BoxFuture<'_, Result<VerifyOutcome, AgentError>>;
    fn apps(&self) -> BoxFuture<'_, Result<Vec<AppEntry>, AgentError>>;
    fn admin_exit(&self, pin: String) -> BoxFuture<'_, Result<AdminExitOutcome, AgentError>>;
}
pub enum AgentError { NotLinked, Timeout, Unsupported, VersionMismatch, Rejected { code: String, message: String }, Internal(String) }
```

| Implementation | Used when | Notes |
|---|---|---|
| `IpcAgent` | Always in release builds; in debug builds unless demo is chosen | Wraps `rulebox_ipc::IpcClient` (Phase 2, Section 6.10). Never opens the pipe itself |
| `DemoAgent` | Debug builds only, when `RULEBOX_STAFF_DEMO=1` | In-process fake: enrolled, online, kiosk applied; employees `maya` / `demo` and `sam` / `demo`; a catalogue of sample apps; files root `target\demo-files\<username>`; admin-exit PIN `2468` (logs "would sign out to Windows" and does nothing). Compiled out of release builds with `#[cfg(debug_assertions)]` |

### 6.2 Developing against the simulated agent

Three ways to run, in order of how early they are available:

```powershell
# 1. No agent at all (works from Step 3): everything is fake.
$env:RULEBOX_STAFF_DEMO = "1"; pnpm dev:staff

# 2. Phase 2's simulated agent (after Phase 2 Step 6): real pipe, real framing, protocol 1.0.
cargo run -p rulebox-agent -- run --console --simulate      # terminal 1
$env:RULEBOX_AGENT_SIM = "1"; pnpm dev:staff                # terminal 2

# 3. Real agent on the VM (Step 18): the built exe under Program Files\Rulebox\versions\.
```

In way 2 the agent only speaks 1.0, so sign-in shows "This PC's Rulebox
agent cannot sign employees in yet" (Section 7.2). That is the expected
result until Phase 2 delivers Section 15.

### 6.3 Health contract (Phase 2 Sections 5.7 and 6.9)

- After `Linked`, when the sign-in screen (or desktop) has painted its
  first frame, the desktop window calls the command `ui_ready`; Rust then
  calls `shell.ready` once per link.
- **Heartbeat proves the UI is alive, not only the process.** The desktop
  window calls `ui_alive` every 5 seconds. A Rust timer sends
  `shell.heartbeat` every 10 seconds **only if** `ui_alive` arrived in the
  last 15 seconds. A frozen WebView therefore stops the heartbeats and
  the agent restarts the app.
- The app is single-instance (`tauri-plugin-single-instance`; a second
  start exits with code 0 after focusing nothing).
- **Exit codes:** 0 = intentional restart (the launcher starts the app
  again at once); anything else is a crash. The app never exits to
  "close". `shell-desktop` and `shell-taskbar` ignore close requests
  (`prevent_close`).
- `ClientEvent::ShuttingDown`: show a full-width banner on the desktop
  and taskbar ("Rulebox is closing in N seconds. Save your work.") and
  stop accepting new launches.
- Version mismatch (`unsupported_protocol`): the status screen "Rulebox
  needs an update. Please contact your administrator." No retry loop
  faster than every 30 seconds.

### 6.4 Methods Phase 3 needs that protocol 1.0 does not have

These are **requests to Phase 2** (Section 15 has the exact shapes).
Phase 3 codes against `AgentPort`, so it is complete and testable with
`DemoAgent` before the agent implements them. `IpcAgent` maps each to its
method when `capabilities` contains the capability; otherwise it returns
`Unsupported`.

| Capability | Methods | Used for |
|---|---|---|
| `session` | `session.signIn`, `session.signOut`, `session.get`, `session.verifyPassword` | Employee sign-in (online and offline), log out, unlock |
| `apps` | `apps.list` | The signed-in employee's app catalogue |
| `adminExit` | `adminExit.submit` | PIN check, then sign the Staff session out to the Windows sign-in screen |

---

## 7. Screens, flows and states

Every screen must be checked in **light, dark, Lite, and reduced
motion**. "Lite" means: no blur, no blobs, solid surfaces, only opacity
fades of at most 150 ms, no GSAP movement. "Reduced motion" means:
movement replaced by short fades.

### 7.1 Boot

| State | Condition | What is shown |
|---|---|---|
| Splash | App start | `<LogoMotion animation="splash">` full window. Cut short as soon as the next screen is ready (PRD 25.5: the splash never delays sign-in) |
| Waiting for agent | Not linked after the splash | `<LogoMotion animation="loading">` + "Starting Rulebox…" |
| Agent unavailable | Not linked for 20 s | Loading logo + "Rulebox is still starting. If this does not change, contact your administrator." Keeps retrying |
| Needs update | Version mismatch | Static `<LogoMark>` + "Rulebox needs an update…" |
| Not set up | `enrollment: notEnrolled` | "This PC is not set up yet." |
| Removed | `enrollment: revoked` | "This PC has been removed from your organization. Contact your administrator." Sign-in stays possible offline only if the agent allows it (the agent decides) |
| Applying | `kiosk.phase: applying` | Loading logo + "Getting this PC ready…" |
| Clock warning | `clockSuspect: true` | A non-blocking banner on the sign-in screen: "This PC's date and time look wrong. Tell your administrator." |

### 7.2 Sign-in

Layout from the design: backdrop blobs, 96 px clock and long date, a
frosted panel (max width 360) with avatar, name, password field and the
arrow button, the organization line bottom-left, network and battery
bottom-right.

| State | What is shown |
|---|---|
| Returning employee | Avatar and name of the last employee on this PC, password field focused, link "Not Maya? Switch user" |
| Switch user / first use | Username and password fields |
| Checking | Fields disabled, the arrow button becomes the loading logo at 28 px |
| Wrong credentials | Inline error "That username or password is not right." Password cleared and refocused |
| Locked out | "Too many tries. Try again in M:SS." (count down from the agent's `retryAfterMs`); fields disabled |
| Account disabled | "Your account has been turned off. Contact your administrator." |
| Offline, has signed in here before | Works. Small note under the panel: "Offline — signed in with saved details." |
| Offline, never signed in here | "You need an internet connection the first time you sign in on this PC." (PRD 13.3) |
| Offline period expired | "Connect to the internet to sign in again." |
| Agent cannot sign in | `Unsupported`: "This PC's Rulebox agent cannot sign employees in yet." |
| Agent not reachable | Fields disabled, banner "Rulebox is reconnecting…" |
| Success | `<LogoMotion animation="open">`; on `onCovered` swap in the desktop; on `onDone` remove the logo layer |

The password leaves React once, as the argument of the `sign_in` command,
and is never stored, logged or echoed. Only `shell-desktop` may call
`sign_in`, `unlock` and `admin_exit` (Step 1, command permissions).

### 7.3 Desktop

- Header: date · organization name (from `desiredState.branding.name`),
  then "Good morning|afternoon|evening, {first name}" (before 12:00,
  before 18:00, after).
- App grid: tiles for the catalogue, sized by the three tiers in the
  design (large, medium, small) from the available area; running dot;
  badge count.
- "My files" panel (shown when the window is at least 1,000 px wide):
  recent files with All / Docs / Media tabs, "Open Files" link.

| State | What is shown |
|---|---|
| Loading catalogue | Tile skeletons (static in Lite) |
| No apps | The design's empty state: "No apps assigned yet" + explanation + "Check again". No tenant phone number |
| Catalogue unavailable | "Can't load your apps right now." + "Try again"; the Files tile still works |
| Offline | Small "Offline" pill next to the date; web app tiles stay enabled (the site decides) |
| Launch failed | Tile shakes once (fade pulse in Lite) and a notice "Zoom could not be opened." with the reason |

### 7.4 Taskbar

Left to right: **Start** button (`<LogoMark compact>`), divider, task
buttons (pinned apps first, then running windows), notices bell with a
count, network / volume / battery group (opens quick settings), clock and
date, avatar and first name (opens the account menu).

| State | What is shown |
|---|---|
| Signed out | Only network / volume / battery and the clock. No Start, no tasks, no avatar |
| No windows | "Open an app to get started" in the task area |
| Window active / inactive / minimized | 18 px accent indicator / 6 px grey indicator / 60% opacity |
| Window wants attention (flash) | Indicator pulses (static accent dot in Lite and reduced motion) |
| Window not responding | "Not responding" in the tooltip and a warning dot; the menu offers "End app" |
| Too many buttons | Buttons shrink to icon-only below 120 px each; beyond that the row scrolls with chevrons |

Click: restore if minimized; minimize if it is the active window; else
focus. Right-click or Shift+F10: menu with Close window, and for pinned
apps Open.

### 7.5 Popups (`shell-popup`)

| Popup | Content | States |
|---|---|---|
| Start menu | Search field, app grid, recent files, profile row, **Log out**, power (Sleep, Restart, Shut down) | No results; power item hidden when the Staff account lacks the shutdown right or the admin disabled it |
| Quick settings | Volume slider + mute, battery line, network status line, brightness slider if supported, notices list | No audio device ("No sound device"); desktop PC (no battery line); brightness unsupported (hidden) |
| Account menu | Avatar, name, role; "Lock"; "Log out" | — |
| Confirm log out | "Log out? These apps will be closed: …" with the list, "Unsaved work may be lost." | Nothing open: no list |
| App switcher | Icon + title per window (thumbnail in Standard mode) | One window only: still shown |
| Thumbnail preview | Live preview above the hovered task button (Standard mode). Lite: title tooltip only | Source minimized or cloaked: icon + title |

All popups close on Escape, on blur, and when another popup opens. The
admin exit is **not** one of these popups; it has its own window
(Section 7.11).

### 7.6 Lock (employee lock, apps stay open)

"Lock" from the account menu: minimize every tracked window, hide the
taskbar's tasks, raise `shell-desktop` to topmost, show the sign-in panel
for the current employee with "Locked · your apps are still open" and
`<LogoMotion animation="lock">` on entry. Unlock calls
`session.verifyPassword`. "Log out instead" is offered. This is a
convenience lock, **not** a security boundary until Phase 5 (Section 9).

### 7.7 Built-in app window (`AppHost`)

Rulebox title bar (46 px): icon, title, minimize, maximize/restore,
close; drag to move; double-click toggles maximize; in Lite mode a tab
strip under it. Content is one of: file explorer, a viewer, or
"Unsupported".

### 7.8 File explorer ("Files on this laptop", PRD 4.6)

Sidebar (All files, Documents, Audio, Video, Images, Downloads, Trash),
breadcrumbs, search field, grid/list toggle, sort menu, storage bar.

| State | What is shown |
|---|---|
| Loading | Skeleton rows |
| Empty folder | "This folder is empty." |
| No search results | "Nothing matches “…”" |
| Folder unreadable / removed underneath | "This folder can't be opened." + "Go to All files" |
| Quota 80% / 95% / 100% | Bar turns warning / strong warning with "Free up space" / blocked banner "Storage is full. Delete files to save new ones." State is in text and icon, not colour alone |
| Name rejected | Inline message under the rename field naming the rule broken |
| Operation failed | Notice with the file name and reason; nothing half-done is left |
| Blocked file type | Dialog "This type of file can't be opened on this PC." |
| No handler | Dialog "No app on this PC can open .xyz files." |

### 7.9 Viewers

| Viewer | Formats | States beyond "showing" |
|---|---|---|
| Image | jpg, jpeg, png, gif, webp | Loading; too large (over 40 megapixels): "This picture is too large to preview."; decode error |
| Audio / video | mp3, wav, m4a, aac, ogg; mp4, webm | Loading; cannot play (`error` event or `canPlayType` empty): "This file can't be played here." + "Open with …" if a handler exists |
| PDF | pdf | Loading page; password-protected: "This PDF is locked."; damaged file |
| Text | txt | Truncated banner above 2 MB: "Showing the first part of this file." |
| CSV | csv | Row cap 5,000 with the same banner; malformed rows shown as text |
| DOCX | docx | Loading; over 25 MB or zip check failed: "Too large to preview."; render error |
| XLSX | xlsx | Same; sheet tabs; 2,000 rows × 100 columns cap per sheet |
| Unsupported | everything else allowed | "Preview not available." + "Open with <app>" when `fileHandlers` has an entry |

All viewers are read-only and lazy-loaded (their code is not in the
desktop or taskbar bundle).

### 7.10 Web app window

Native title bar showing the page title and the app's icon.

| Situation | Behaviour |
|---|---|
| Navigation to an allowed domain | Proceeds |
| Top-level navigation to another domain | Cancelled; the window shows the local "This site is not allowed" page with the blocked host and a "Go back" link (PRD 6.2) |
| Site opens a new window or tab | Allowed domain: the same window navigates there. Otherwise: blocked page |
| Download | Saved to `<employee folder>\Downloads` with a cleaned name; a notice "Saved report.pdf"; blocked types and a full quota cancel it with a notice |
| Permission request | Answered from the app's rules without any browser prompt (PRD 24.1). A denial adds a notice "Microphone is not allowed for this app." |
| External protocol link (`mailto:`, `ms-settings:`, …) | Always cancelled |
| Page crash or load failure | WebView2's own error page; closing and reopening from the taskbar works |
| Offline | The site's own behaviour; the shell adds nothing |

### 7.11 Hidden admin exit (the only in-session route to an admin)

Flow: key combination → PIN dialog → the **agent** checks the PIN → the
agent signs the Staff session out to the Windows sign-in screen (PRD
12.4). The Staff App never checks a PIN and never holds its hash.

Because nothing else leads to an admin from inside the Staff session, the
exit must not depend on the rest of the UI being healthy:

| Requirement | How it is met |
|---|---|
| Works on every shell screen: splash, waiting, "not set up", "needs update", sign-in, lock, desktop, log-out in progress, shutting-down banner | The dialog is its own window (`shell-exit`) with its own tiny page (`exit.html`): no shared store, no GSAP, no icons plugin, no lazy chunks. It is opened from **Rust**, not from another page |
| Works while another app or a web app has the focus | A global hotkey registered on the message thread (shell mode) |
| Works if the hotkey could not be registered | Every Rulebox page (`shell.html`, `apps.html`, `exit.html`) also listens for the same combination and calls `admin_exit_open`; registration is retried every 30 seconds |
| Works if a React page crashed (error boundary) or the popup window is stuck | `shell-exit` is independent of `shell-desktop`, `shell-taskbar` and `shell-popup`; opening it first hides `shell-popup` |
| Works offline | The agent checks the PIN locally; no internet is needed. The dialog never mentions the network |
| Works in Lite and reduced motion | The page has no animation at all |
| Key combination changed from the dashboard | Read from the agent snapshot (Section 15, R4); the hotkey is re-registered on change. Unparseable or unregistrable → the default is used and the fact is logged |

Dialog states:

| State | What is shown |
|---|---|
| Ready | "Administrator exit", a masked digits-only PIN field (4–12), "Sign out to Windows", Cancel. Escape cancels |
| Checking | Field disabled, small loading logo. Timeout 10 seconds |
| Wrong PIN | "That PIN is not right." plus the attempts left when the agent gives them; field cleared |
| Locked out | "Too many tries. Try again in M:SS." (from the agent); field disabled until zero |
| Signing out | "Signing out to Windows…". The window stays until the session ends |
| Agent not linked, or a call timed out | Field disabled. "Rulebox can't check the PIN right now. Waiting for the Rulebox service…" It re-enables by itself when the link is back (the PIN is **not** kept or re-sent). After 30 seconds also: "If this does not change: restart this PC while holding Shift, or turn kiosk off from the dashboard." |
| Agent has no `adminExit` capability | "Admin exit is not available on this PC yet." plus the same recovery line |
| Exit disabled by the organization (snapshot says disabled, or outcome `disabled`) | The key combination does nothing at all |

What the Staff App does **not** do, even when the agent is unreachable:
it does not verify the PIN itself, does not sign the session out itself,
and does not offer any other route. A PIN check in the Staff session
would put the hash where an employee's process can read it, and a
sign-out without the agent would be undone at once by automatic sign-in.

What stays out of reach of the Staff App: if `rulebox-staff.exe` is not
running (crash loop → the launcher's native fallback screen), there is no
hidden exit unless the launcher provides one (Section 15, R11). Until
then the routes are the two recovery routes of PRD 9.5.

---

## 8. Steps

Rules for every step:

- Verify the touched crate or app only:
  `cargo clippy -p <crate> --all-targets -- -D warnings`,
  `cargo test -p <crate>`,
  `pnpm --filter @rulebox/staff-app typecheck`,
  `pnpm --filter @rulebox/staff-app lint`,
  `pnpm --filter @rulebox/staff-app test`. Workspace-wide commands run in
  Step 19 only.
- **UI steps are not done until you ran the app and looked at it.** Take
  a screenshot of each new screen in light, dark and Lite, and keep them
  for the final report. In demo mode, `?lite=1` on the URL no longer
  exists; use the dev overlay (Step 3) to switch theme, Lite and reduced
  motion.
- Never run `tauri build` without `--debug`, never `cargo build
  --release`.
- No `unwrap()`/`expect()` outside tests. `unsafe` only in
  `crates/rulebox-desktop` and `src-tauri/src/webapp/hooks.rs`, each
  block small with a `// SAFETY:` comment; every handle, hook, icon and
  COM pointer owned by a type that frees it on `Drop`.
- Icons: Solar only, imported per icon, `-bold-duotone`, and `-bold` for
  the selected state, for example
  `import IconFolder from '~icons/solar/folder-bold-duotone'`. No inline
  SVG glyphs except the logo components.
- Styling follows the dashboard's convention: inline `style` objects that
  reference `var(--rb-*)` tokens, or classes added to `packages/ui`.
  Never a raw colour in app code.
- Animation: GSAP inside `useGSAP()` only, `x`, `y`, `scale`,
  `autoAlpha` only, through the helpers in `lib/motion.ts` (Step 3),
  which do nothing but a ≤150 ms fade in Lite or reduced motion. Hover
  and press effects are CSS transitions. The logo is the one CSS-animated
  exception and is used as shipped.
- If an API name here does not match the version you pinned, use the
  equivalent and record it under "Deviations".

---

### Step 0 — Preflight (stop if anything fails)

1. Record: `rustc --version`, `node --version`, `pnpm --version`, free
   space on D:, size of `target\`, `git status --short`.
2. **Disk.** Phase 3 adds roughly 1 GB to `target\debug` (more `windows`
   features, `webview2-com` use, `cap-std`, `notify`) and about 150 MB of
   `node_modules` store. Stop below **8 GB** free on D:. Tell the user
   before the first build.
3. Confirm the versions in Section 5.5.
4. Check which Phase 2 pieces exist: `crates/rulebox-ipc` (is feature
   `client` there? is `IpcClient` there?), `[workspace.dependencies]` in
   the root `Cargo.toml`, the `gen:types` script. Phase 3 can start
   before them: **if `rulebox-ipc` does not exist yet, build Steps 1–17
   with `DemoAgent` only, leave `agent/ipc.rs` as a stub that always
   reports `Disconnected`, and say so in the report.**
5. Show the user Section 17 and Section 15.
6. Confirm the WebView2 runtime version on the dev machine
   (`Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' pv`).
   Record it; it must be 125 or newer.

**Done when:** all recorded; the user has seen Sections 15 and 17.

---

### Step 1 — Tooling, entries, capabilities, CSP

**Frontend**

- `pnpm-workspace.yaml` catalog: add the JS packages of Section 5.5.
- `apps/staff-app/package.json`: dependencies and
  `"test": "vitest run"`. Remove `convex`.
- `vite.config.ts`: add `Icons({ compiler: "jsx", jsx: "react" })`
  (same as the dashboard); remove the `@convex` alias;
  `build.rollupOptions.input = { shell: "shell.html", apps: "apps.html" }`;
  Vitest config with `environment: "jsdom"`.
- `tsconfig.json`: add `"unplugin-icons/types/react"` to `types`; remove
  the `@convex/*` path.
- Delete `index.html`, `src/main.tsx`, `src/App.tsx`, `.env.example`
  (the app no longer needs `VITE_CONVEX_URL`). Create `shell.html`,
  `apps.html`, `src/shell/main.tsx`, `src/apps/main.tsx`. Both entries
  import `@rulebox/ui/fonts.css`, `tokens.css`, `base.css` and render an
  `ErrorBoundary`.

**Tauri**

- `Cargo.toml`: dependencies of Section 5.5; add
  `[lints] workspace = true` if Phase 2 created workspace lints.
- New crate `crates/rulebox-desktop` (`#![cfg(windows)]`, empty modules).
- `tauri.conf.json`:
  - `app.windows`: **empty array** (all windows are created in Rust).
  - `build.devUrl` stays `http://localhost:1420`.
  - `app.withGlobalTauri`: `false`.
  - `app.security.csp`:

    ```
    default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
    img-src 'self' data: blob: http://rbfile.localhost http://rbicon.localhost;
    media-src 'self' blob: http://rbfile.localhost;
    font-src 'self' data:; worker-src 'self' blob:;
    connect-src 'self' ipc: http://ipc.localhost http://rbfile.localhost;
    frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'
    ```

    The Convex hosts are removed on purpose. If PDF.js later needs
    `'wasm-unsafe-eval'` in `script-src`, add exactly that and report it.
- `capabilities/default.json` is deleted. Create:
  - `shell.json`: `"windows": ["shell-*"]`, permissions
    `core:event:default`, `core:app:default`, plus the `allow-<command>`
    permissions of the shell commands.
  - `apps.json`: `"windows": ["app-*"]`, permissions `core:event:default`,
    `core:window:allow-start-dragging`, plus the app commands.
  - Neither has `remote`. Nothing matches `web-*`.
- `build.rs`: declare every command with
  `tauri_build::Attributes::new().app_manifest(AppManifest::new().commands(&[...]))`
  so each command needs an explicit permission. Keep two constant lists
  in `build.rs`, `SHELL_COMMANDS` and `APP_COMMANDS`; a command may be in
  both.
- `lib.rs`: builder with `tauri_plugin_single_instance`, logging
  (`tracing` to `%LOCALAPPDATA%\dev.rulebox.staff\logs\staff.<date>.log`,
  7 files), a panic hook that logs and then exits with code 1, and an
  empty `setup`.
- Every command starts by checking the caller's window label prefix
  (`shell-` or `app-`) and returns `Forbidden` otherwise. This is the
  second check behind the capability.
- Root `package.json`: `gen:types` must cover three crates:
  `cargo test -p rulebox-policy -p rulebox-ipc -p rulebox-staff export_bindings`
  (drop `-p rulebox-ipc` while that crate does not exist; Section 15, R6).

**Verify:** `pnpm install`; `cargo check -p rulebox-staff -p rulebox-desktop`;
typecheck; lint; `pnpm test` (zero tests is a pass);
`$env:RULEBOX_STAFF_DEMO="1"; pnpm dev:staff` starts with no window and
logs "no windows yet" (close it with Ctrl+C).

**Done when:** all pass and `git grep -n "convex" apps/staff-app` returns
nothing.

---

### Step 2 — Design system additions (`packages/ui`)

Add tokens to `tokens.css` (semantic names; values from the design
export; dark values by the same lightness shifts the existing tokens
use):

| Token | Light value | Use |
|---|---|---|
| `--rb-r-16`, `--rb-r-18`, `--rb-r-22` | 16px, 18px, 22px | small tile, taskbar, large tile / side panel |
| `--rb-taskbar-zone` | `84px` | reserved bottom strip (60 + 12 + 12) |
| `--rb-taskbar-item` | `44px` | task button height |
| `--rb-paper` | `oklch(0.982 0.003 85)` | title bar background |
| `--rb-raise` | `oklch(0.995 0.002 85)` | active task button |
| `--rb-shadow-window`, `--rb-shadow-window-inactive` | the design's focused / unfocused window shadows | built-in windows |
| `--rb-shadow-popover` | `0 20px 48px -16px oklch(0.3 0.02 70 / 0.35)` | popups |
| `--rb-glass-strong` | `oklch(0.99 0.003 85 / 0.94)` | popups, taskbar (0.8 alpha variant `--rb-glass-bar`) |
| `--rb-z-popover`, `--rb-z-banner` | 100, 200 | in-page layers only |
| `--rb-tint-bg`, `--rb-tint-fg` | `oklch(0.93 0.045 var(--rb-hue))`, `oklch(0.43 0.1 var(--rb-hue))` | per-app and per-file-type tint; set `--rb-hue` inline |

Lite overrides: glass tokens become the solid surface, window and popover
shadows become the Lite shadow.

Component changes (keep existing props working; the dashboard gallery
uses them):

```ts
// TitleBar: add
icon?: ReactNode;            // replaces the mono block when given
focused?: boolean;           // default true; false = muted title
dragRegion?: boolean;        // adds data-tauri-drag-region to the bar and title
onDoubleClick?: () => void;
children?: ReactNode;        // extra controls before the window buttons
// The three window buttons take their glyphs from props so apps pass Solar icons:
minimizeIcon?: ReactNode; maximizeIcon?: ReactNode; restoreIcon?: ReactNode; closeIcon?: ReactNode;

// AppTile: add
size?: "lg" | "md" | "sm";   // default "md" = today's look; lg/sm per the design tiers
hue?: number;                // sets --rb-hue for the icon block
// Change the hover style: lift with transform only; the stronger shadow is a
// pseudo-element whose opacity changes (no box-shadow transition).

// Avatar: unchanged. Backdrop: add
offsetY?: number;            // px; shifts the blob layer so two windows can show one continuous backdrop
```

New components (each: one file, named export, props interface, classes in
`components.css`, works in dark and Lite, visible focus ring):

| Component | Props (essentials) |
|---|---|
| `IconButton` | `label: string` (required, becomes `aria-label` and tooltip), `size?: 32 \| 38 \| 44`, `active?: boolean` |
| `Surface` | `kind: "popover" \| "bar" \| "window"`; the frosted container used by popups, the taskbar and windows |
| `Slider` | `value`, `onChange`, `min`, `max`, `step`, `label`; native `<input type="range">` styled |
| `MenuList`, `MenuItem` | `role="menu"` / `menuitem`, arrow-key navigation, `danger?: boolean`, `icon?`, `hint?` |
| `Dialog` | `title`, `children`, `actions`; focus trap, Escape closes, `role="dialog"` + `aria-modal` |
| `Tabs` | `tabs: {id,label,closable?}[]`, `value`, `onChange`, `onClose`; `role="tablist"` |
| `FileChip` | `ext: string`; the coloured type chip (hue from a fixed table) |
| `Notice` | `tone`, `title`, `detail?`, `onDismiss?` |
| `Spinner` | wraps `<LogoMotion animation="loading" wordmark={false}>` at a given `size`; never a new spinner drawing |

`SegmentedControl`: add arrow-key handling (it has `role="radiogroup"`
but no keys today).

Add each new component to the dashboard gallery (`apps/dashboard/src/Gallery.tsx`)
in its own section; this is the only dashboard file you touch.

**Verify:** `pnpm --filter @rulebox/ui typecheck`;
`pnpm --filter @rulebox/dashboard typecheck`; `pnpm dev:dashboard`,
open the gallery, screenshot the new section in light, dark and Lite.

**Done when:** typechecks pass and the screenshots show every new
component in the three modes.

---

### Step 3 — Core: model, state, agent port, store

`model.rs` — every type crossing to React derives
`Serialize, Deserialize, Clone, Debug, PartialEq, TS` with
`#[serde(rename_all = "camelCase")]` and `#[ts(export)]`:

```rust
pub struct ShellState {                 // the one object every shell window renders
    pub mode: ShellModeDto,             // "shell" | "dev"
    pub link: AgentLinkDto,             // "disconnected" | "connecting" | "linked" | "versionMismatch"
    pub agent: Option<AgentSummary>,    // enrollment, connection, kioskPhase, clockSuspect, orgName
    pub display: DisplayPrefs,          // { lite: bool, theme: "light"|"dark"|"auto", reducedMotion: bool }
    pub session: SessionState,
    pub apps: CatalogState,             // { status: "idle"|"loading"|"ready"|"error", items: Vec<AppEntry> }
    pub tasks: Vec<TaskItem>,
    pub system: SystemState,            // volume, battery, network, canPowerOff
    pub notices: Vec<NoticeItem>,
    pub banner: Option<BannerDto>,      // shutting-down banner
    pub capabilities: Vec<String>,
}
pub enum SessionState { SignedOut { last: Option<EmployeeBrief> }, SigningIn, SignedIn { employee: Employee, locked: bool, offline: bool }, SigningOut }
pub struct Employee { pub id: String, pub username: String, pub name: String, pub role: Option<String>,
                      #[ts(type = "number")] pub quota_bytes: u64 }
pub struct EmployeeBrief { pub username: String, pub name: String }
pub struct AppEntry { pub id: String, pub name: String, pub description: Option<String>, pub kind: AppKind,
                      pub icon_key: Option<String>, pub hue: Option<u16>, pub pinned_taskbar: bool, pub pinned_desktop: bool,
                      pub badge: Option<u32> }
pub enum AppKind { Builtin { tool: BuiltinTool }, Web(WebApp), Desktop(DesktopApp) }
pub enum BuiltinTool { Files }
pub struct WebApp { pub url: String, pub allowed_domains: Vec<String>, pub permissions: WebPermissions }
pub struct WebPermissions { pub camera: bool, pub microphone: bool, pub screen_share: bool, pub clipboard_read: bool,
                            pub notifications: bool, pub downloads: bool, pub printing: bool, pub geolocation: bool }
                            // Default = PRD 24.1: notifications, downloads true; the rest false
pub struct DesktopApp { pub exe: String, pub args: Vec<String>, pub file_arg_template: Vec<String> }  // never sent to React; #[serde(skip)] on exe/args in the DTO
pub struct TaskItem { pub id: String /* hwnd as decimal */, pub app_id: Option<String>, pub title: String, pub icon_key: String,
                      pub active: bool, pub minimized: bool, pub flashing: bool, pub hung: bool, pub own: bool }
pub struct NoticeItem { pub id: u32, pub tone: NoticeTone, pub title: String, pub detail: Option<String>, #[ts(type = "number")] pub at_ms: u64 }
```

`state.rs`: `AppState` holds the above behind one `Mutex`, plus things
React never sees (the `SafeRoot`, job handles, the agent port).
`AppState::update(|s| …)` mutates and then emits `shell://state` to all
`shell-*` and `app-*` windows. Emissions are coalesced to at most one per
50 ms.

`agent/`: `AgentPort`, `IpcAgent`, `DemoAgent` (Section 6). A task copies
link and snapshot changes into `AppState`. `display.lite` comes from the
snapshot's `displayMode`; `display.theme` is `"auto"` (P9);
`display.reducedMotion` is read in React from the media query.

Commands (all thin): `shell_state() -> ShellState`, `ui_ready()`,
`ui_alive()`, `dismiss_notice(id)`. Debug builds only:
`dev_set_display(lite, theme)`.

React:

```ts
// src/lib/tauri.ts
export function call<K extends keyof Commands>(name: K, args: Commands[K]["args"]): Promise<Commands[K]["result"]>;
// src/lib/store.ts
export function useShell<T>(select: (s: ShellState) => T): T;     // useSyncExternalStore; equality by JSON of the selection
// src/lib/motion.ts
export function useMotionLevel(): "full" | "fade";                 // "fade" when Lite or prefers-reduced-motion
export function enter(el: Element, level, opts?): gsap.core.Tween; // full: y 8 -> 0 + autoAlpha, 0.2 s, --rb-ease; fade: autoAlpha only, 0.15 s
export function exit(el: Element, level, opts?): gsap.core.Tween;
```

On every state change the entry file applies `setTheme` and `setLite` to
`<html>`.

Dev overlay (debug builds, toggled with Ctrl+Shift+D inside a shell
window): switches light / dark / auto, Lite, simulated reduced motion,
and shows the frame meter of Step 17.

Tests: `ShellState` golden JSON (pins the wire shape for React);
`DemoAgent` sign-in success / wrong password / lockout after 5 tries;
state coalescing; `useShell` re-renders only when its selection changes;
`motion.ts` returns fade-only tweens in Lite.

**Verify:** clippy and tests for `rulebox-staff`; `pnpm gen:types`
(adds the new types; extend `packages/types/src/index.ts` by hand);
typecheck, lint, `pnpm test`.

**Done when:** all pass.

---

### Step 4 — Shell windows

`crates/rulebox-desktop`: `mode.rs` (Section 5.2), `msgloop.rs`,
`notify.rs`, `workarea.rs`.

```rust
// msgloop.rs — ONE dedicated thread owns a hidden top-level window (never shown, WS_EX_TOOLWINDOW;
// not a message-only window: those do not receive broadcasts) and runs GetMessageW.
pub struct MsgLoop { /* thread handle, hwnd as isize, command sender */ }
impl MsgLoop {
    pub fn start(mode: ShellMode, events: tokio::sync::mpsc::UnboundedSender<DesktopEvent>) -> Result<MsgLoop, DesktopError>;
    pub fn run<T: Send + 'static>(&self, f: impl FnOnce(&LoopCtx) -> T + Send + 'static) -> oneshot::Receiver<T>; // posts WM_APP to wake the loop
    pub fn stop(self);        // posts WM_QUIT; unhooks; restores the work area; joins
}
pub enum DesktopEvent { Window(WindowEvent), DisplayChanged, DpiChanged, Resumed, SessionLocked, SessionUnlocked,
                        PowerChanged, Hotkey(HotkeyId), VolumeChanged, NetworkChanged }
// workarea.rs
pub fn set_bottom_reserve(_t: &ShellToken, px_physical: i32) -> Result<(), DesktopError>;  // primary monitor rect minus the strip; SPI_SETWORKAREA with SPIF_SENDCHANGE, no SPIF_UPDATEINIFILE
pub fn hide_minimized(_t: &ShellToken) -> Result<(), DesktopError>;                        // MINIMIZEDMETRICS.iArrange |= ARW_HIDE
pub fn register_taskman(_t: &ShellToken, hwnd: isize) -> Result<(), DesktopError>;         // SetTaskmanWindow (undocumented user32 export: declare it with windows::core::link!)
pub fn primary_monitor() -> Result<MonitorRect, DesktopError>;                             // physical pixels + scale
```

The wndproc never blocks: it pushes a `DesktopEvent` and returns.

`shellwin.rs`: `create_all(app, mode)` builds the three shell windows
with `WebviewWindowBuilder` and `WebviewUrl::App("shell.html#/desktop")`,
`#/taskbar`, `#/popup`.

| Setting | desktop | taskbar | popup |
|---|---|---|---|
| `decorations` | false (shell) / true (dev) | false | false |
| `resizable` | false / true | false | false |
| `always_on_top` | false | true (shell) / false (dev) | true |
| `focusable` | true | **false** | true |
| `visible` at creation | true | true | false |
| `shadow` | false | false | false |
| `skip_taskbar` | do not call (it may depend on Explorer) | — | — |
| `transparent`, `effects` | never | never | never |
| devtools | debug builds only | same | same |
| drag-drop handler | disabled (`disable_drag_drop_handler`) | disabled | disabled |

- Set `focus`/`focused` explicitly on every builder; the documented
  default changed between Tauri releases.
- After creation, add `WS_EX_TOOLWINDOW` to the taskbar and popup through
  their HWND (Tauri has no option for it). Our own tracker also skips
  every `shell-*` HWND.
- Placement in **physical pixels** from `primary_monitor()`: desktop =
  the whole monitor (not Tauri's `fullscreen`, which forces topmost and
  has open bugs with undecorated windows and scaling); taskbar = full
  width × `84 × scale` at the bottom.
- Re-apply placement and (shell mode) the work area on `DisplayChanged`,
  `DpiChanged`, `Resumed` and Tauri's `ScaleFactorChanged`.
- Keep the desktop at the bottom: in shell mode, on its `Focused(true)`
  event call `SetWindowPos(HWND_BOTTOM, …, SWP_NOACTIVATE | SWP_NOMOVE |
  SWP_NOSIZE)`.
- `CloseRequested` on `shell-desktop` and `shell-taskbar`:
  `api.prevent_close()`.
- Popup API: `popup_open(kind, anchor: Option<Rect>)`,
  `popup_close()`. Rust sizes and positions the popup (above the anchor,
  clamped to the work area), emits `popup://show { kind }`, shows and
  focuses it. `Focused(false)` hides it and emits `popup://hide`.
- The taskbar page draws the strip with `<Backdrop offsetY=…>` so the
  blobs line up with the desktop behind it (no transparency needed). In
  Lite there are no blobs.

Shell-mode-only startup, in this order: `register_taskman`,
`hide_minimized`, `set_bottom_reserve`. On exit (`MsgLoop::stop`):
restore the full work area.

Tests (pure): placement maths for 1366×768 @100%, 1920×1080 @125% and
@150%; popup clamping; `ShellToken::acquire(Dev)` is `None`.

**Verify:** clippy + tests for both crates; run in demo mode: a
decorated "Rulebox (dev)" window, a taskbar strip directly above the
Windows taskbar, the Windows work area unchanged
(`[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea` before and
after), Alt+F4 on the desktop window does nothing; screenshot.

**Done when:** all of that holds. If the work area changed on the dev
machine, stop: shell mode leaked.

---

### Step 5 — Boot flow and sign-in

Files: `DesktopRoot.tsx`, `boot/*`, `signin/SignIn.tsx`, `session.rs`,
commands `sign_in({ username, password })`, `sign_in_last({ password })`,
`switch_user()`.

Logo sequencing — a hook that owns the timing so the callbacks' known
gaps cannot strand the UI:

```ts
// src/shell/boot/useLogoSequence.ts
export function useLogoSequence(kind: "splash" | "open" | "lock", level: "full" | "fade"):
  { animation: LogoAnimation; key: number; onCovered(): void; onDone(): void; covered: boolean; done: boolean; skip(): void };
```

- It passes `onCovered` / `onDone` to `LogoMotion` **and** arms fallback
  timers: splash 3.5 s, lock 3.0 s, open → covered 1.6 s and done 2.1 s;
  in `fade` level 0.4 s for all. Whichever comes first wins.
- Always render `LogoMotion` with the default `tagline` (with
  `tagline={null}` and a wordmark, splash and lock never report done).
- `open` measures the window at mount, so mount it only when the desktop
  window has its final size, and remount (new `key`) if the window is
  resized mid-animation.
- To replay, change `key`.
- Splash is skipped (`skip()`) the moment the next screen is ready.

`session.rs`: `sign_in` → `SigningIn` → `AgentPort::sign_in`:

```rust
pub struct SignInRequest { pub username: String, pub password: String }
pub enum SignInOutcome {
    Ok { employee: Employee, files_root: String, offline: bool },
    WrongCredentials, Disabled,
    LockedOut { retry_after_ms: u64 },
    OfflineNeverSignedIn, OfflineExpired,
}
```

On `Ok`: open the `SafeRoot` (Step 12; until then keep the path), load
the catalogue, remember `EmployeeBrief` as "last" in
`%LOCALAPPDATA%\dev.rulebox.staff\last-user.json`, set `SignedIn`.
Every other outcome maps to a state of Section 7.2. The password `String`
is dropped right after the call; `Debug` for `SignInRequest` redacts it.

Tests: reducer-style tests for every outcome; `useLogoSequence` fires
`done` from the timer when the callback never comes; splash `skip`;
component tests for each sign-in state (render + assert the text).

**Verify:** tests, typecheck, lint; run in demo mode and walk every state
(the dev overlay can force link states); screenshots of splash, loading,
"not set up", sign-in (returning and switch-user), wrong password,
lockout, and the open animation mid-way, in light, dark and Lite.

**Done when:** every state of Sections 7.1 and 7.2 has been seen.

---

### Step 6 — Desktop

Files: `desktop/Desktop.tsx`, `AppGrid.tsx`, `tileLayout.ts`,
`MyFilesPanel.tsx` (static list until Step 13 fills it).

```ts
// tileLayout.ts (pure)
export function solveTiles(area: { w: number; h: number }, count: number, gap = 18):
  { cols: number; tile: { w: number; h: number }; tier: "lg" | "md" | "sm"; scroll: boolean };
// aspect 1.2 (h = w / 1.2); max width 300; min 128 (104 when area.h < 360); tier lg >= 230, md >= 160, else sm
```

- A `ResizeObserver` feeds the solver. When the tier or column count
  changes, tiles move with **GSAP Flip** (full motion only).
- Tile click calls `launch_app(id)` (Step 8); until then it adds a notice
  "Not available yet".
- Greeting and date re-evaluate every minute.

Tests: solver table for 0, 1, 3, 7, 8, 16 and 24 apps at 1366×768 and
1920×1080 work areas; greeting boundaries at 11:59, 12:00, 17:59, 18:00.

**Verify:** tests; run; screenshots of 0, 3, 8 and 24 apps (the demo
agent has a `RULEBOX_DEMO_APPS=<n>` override) in light, dark and Lite.

**Done when:** the four counts look right in the three modes and nothing
overlaps the taskbar strip.

---

### Step 7 — Window tracking and the task list

`crates/rulebox-desktop`: `windows.rs`, `tracker.rs`, `icons.rs`.

```rust
pub struct WindowInfo { pub hwnd: isize, pub pid: u32, pub title: String, pub exe: Option<PathBuf>, pub aumid: Option<String>,
                        pub minimized: bool, pub cloaked: bool, pub class: String }
pub fn enumerate() -> Vec<WindowInfo>;                     // EnumWindows
pub fn is_task_window(hwnd: isize) -> bool;                // the filter below
pub enum WindowEvent { Added(WindowInfo), Removed(isize), Changed(WindowInfo), Activated(Option<isize>), Flash(isize, bool) }
pub fn start(ctx: &LoopCtx) -> Result<Tracker, DesktopError>;   // on the MsgLoop thread
pub fn icon_png(hwnd: isize, size: u32) -> Option<Vec<u8>>;     // WM_GETICON (ICON_SMALL2, ICON_SMALL, ICON_BIG, 1 s timeout) -> class icon -> exe icon
pub fn exe_icon_png(exe: &Path, size: u32) -> Option<Vec<u8>>;  // IShellItemImageFactory, SIIGBF_ICONONLY
```

Taskbar filter (the logic ManagedShell uses): the window is valid and
visible; it has no owner **or** has `WS_EX_APPWINDOW`; it does not have
`WS_EX_TOOLWINDOW`; if it has `WS_EX_NOACTIVATE` it must also have
`WS_EX_APPWINDOW`; the property `ITaskList_Deleted` is absent;
`DWMWA_CLOAKED` is 0; and its class is not `Windows.UI.Core.CoreWindow`,
`ApplicationFrameWindow` without `WS_EX_WINDOWEDGE`,
`StartMenuSizingFrame` or `Shell_LightDismissOverlay`.

Feeds, combined:

1. `enumerate()` once at start and after `DisplayChanged` / `Resumed`.
2. Shell hook: `RegisterShellHookWindow(hidden hwnd)` +
   `RegisterWindowMessage("SHELLHOOK")` → created, destroyed, activated
   (also "rude" activation), redraw (title/icon refresh, clears flash),
   flash.
3. `SetWinEventHook` (out of context, **not** skipping our own process,
   because built-in and web windows belong to us) for exactly:
   show / hide, cloaked / uncloaked, name change, foreground, minimize
   start / end. Filter `idObject == OBJID_WINDOW && idChild == 0` and
   top-level only. Never hook location change.

`tasks.rs` turns the window set into `Vec<TaskItem>`:

- Skip every `shell-*` HWND.
- `own = true` for `app-*` and `web-*` windows; their `app_id` comes from
  the label.
- Other windows map to a catalogue app by: PID in a job the shell
  created (Step 8) → AUMID → full exe path.
- `hung` from `IsHungAppWindow`, refreshed every 5 seconds for visible
  tasks only.
- Icons are cached by key (`hwnd:<n>` or `exe:<hash>`) and served by the
  custom protocol `rbicon` (`http://rbicon.localhost/<key>`), PNG,
  `Cache-Control: max-age=60`. Convert icons on a worker, never on the
  message thread.

React: `Taskbar.tsx`, `TaskButton.tsx` render pinned apps and tasks
(states of Section 7.4). Reordering uses GSAP Flip in full motion.

Tests: the filter as a pure function over a struct of flags (12 cases);
grouping; debounced title changes; BGRA→RGBA conversion with a mask-only
icon.

**Verify:** clippy + tests; run in demo mode on the dev machine: open and
close Notepad and a browser — buttons appear and disappear, titles and
icons are right, the active indicator follows focus, UWP Calculator shows
once (not twice). Screenshot.

**Done when:** that works with at most a 300 ms delay and idle CPU of the
Staff App stays under 1% with 10 windows open (Task Manager, 30 s
average).

---

### Step 8 — Window control and launching apps

`control.rs`:

```rust
pub fn activate(hwnd: isize) -> Result<(), DesktopError>;
pub fn minimize(hwnd: isize) -> Result<(), DesktopError>;   // PostMessage WM_SYSCOMMAND SC_MINIMIZE (after checking WS_MINIMIZEBOX)
pub fn restore(hwnd: isize) -> Result<(), DesktopError>;    // SendMessageTimeout SC_RESTORE, SMTO_ABORTIFHUNG, 200 ms; then activate
pub fn close(hwnd: isize) -> Result<(), DesktopError>;      // SendMessageTimeout WM_SYSCOMMAND SC_CLOSE, 200 ms
pub fn is_hung(hwnd: isize) -> bool;
pub fn end_process_of(hwnd: isize) -> Result<(), DesktopError>;   // TerminateProcess; same user only
```

`activate`, in order, stopping at the first that makes the target the
foreground window: (1) restore if minimized, then
`SetForegroundWindow(GetLastActivePopup(hwnd))`; (2) a synthetic Alt
press and release with `SendInput`, then retry; (3) `SwitchToThisWindow`.
Never `AttachThreadInput` (it can hang on a frozen app). Log which rung
worked. Clicks on the taskbar arrive in the WebView2 process, so whether
rung 1 is enough is **(unverified)**; the ladder exists for that.

`launch.rs`:

```rust
pub struct Launched { pub pid: u32, pub job: JobHandle }
/// CreateProcessW(application name = full exe path, quoted command line built from args,
/// CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, current dir = exe's folder), assign to a new job, resume.
/// Error 740 (elevation required) is returned as DesktopError::NeedsElevation and is NEVER retried elevated.
pub fn launch(exe: &Path, args: &[String]) -> Result<Launched, DesktopError>;
pub fn job_pids(job: &JobHandle) -> Vec<u32>;
pub fn terminate_job(job: &JobHandle) -> Result<(), DesktopError>;
```

- The job has **no** kill-on-close limit; it is for tracking and for
  deliberate cleanup.
- Never put the Staff App itself or WebView2 processes in a job.
- `launcher.rs`: `launch_app(id)`:
  - Builtin Files → open or focus the explorer (Step 11).
  - Web → Step 15.
  - Desktop → if a task for this app exists, activate it; else `launch`.
    The exe path comes only from the catalogue the agent supplied; React
    sends an app id, never a path. Refuse a path that is not absolute,
    does not exist, or ends in `.bat`/`.cmd`.
- Failures become notices: not found, needs administrator rights ("This
  app needs administrator rights and can't be opened here."), other.

Commands: `task_activate(id)`, `task_minimize(id)`, `task_close(id)`,
`task_end(id)` (only when `hung`), `launch_app(id)`, `show_desktop()`
(minimize all tracked; second call restores those it minimized).

Tests: command-line quoting (spaces, quotes, trailing backslash); app
resolution rules; `show_desktop` toggle bookkeeping; the task-click rule
(restore / minimize / focus) as a pure function.

**Verify:** clippy + tests; on the dev machine in demo mode (the demo
catalogue has Notepad as a desktop app): launch from a tile, see it in
the taskbar, click to minimize and restore, close from the menu, launch a
second time focuses instead of duplicating. Note which activation rung
was logged.

**Done when:** all of that works.

---

### Step 9 — Start menu, account menu, log out, lock, power

Files: `popup/PopupRoot.tsx`, `StartMenu.tsx`, `AccountMenu.tsx`,
`ConfirmLogout.tsx`, `signin/LockScreen.tsx`, `power.rs`, `session.rs`.

- Start menu search filters apps by name (case-insensitive, diacritics
  folded) and, after Step 13, files by name. Arrow keys move through
  results; Enter opens.
- **Log out** (PRD 5.1, 13.3), in `session::sign_out`:
  1. Show `ConfirmLogout` with the list of open apps.
  2. Set `SigningOut`; show `<LogoMotion animation="lock">` over the
     desktop.
  3. Close built-in windows and web windows.
  4. For every job the shell created: `close` each of its windows, wait
     up to 5 seconds, then `terminate_job`. **Never** touch a window or
     process the shell did not launch.
  5. Clear the in-app file clipboard, recent lists in memory, notices.
  6. `AgentPort::sign_out()` (the agent wipes app data folders in
     Phase 4). An error or `Unsupported` is logged and does not stop the
     log out.
  7. Drop the `SafeRoot`, set `SignedOut`, show sign-in.
- **Lock / unlock**: Section 7.6. `unlock(password)` →
  `AgentPort::verify_password`.
- **Power** (`power.rs`): `can_power_off()` checks the process token for
  `SeShutdownPrivilege`; `sleep()`, `restart()`, `shut_down()` enable the
  privilege and call `SetSuspendState` / `ExitWindowsEx` with a real
  reason code. If the privilege is missing the three items are hidden.
  Restart and Shut down first run the log-out steps 3–6 when someone is
  signed in. These are not privileged for a default standard user, so
  they do not go through the agent.
- **Restart Rulebox** (debug overlay only in Phase 3): exits with code 0;
  the launcher brings the app back.

Tests: sign-out sequence against a fake launcher (order of calls; a
foreign window is never closed; agent failure does not block); lock
state transitions; search matching.

**Verify:** tests; demo run: sign in, launch Notepad from a tile and also
open a Notepad by hand from Explorer; log out — the launched one closes,
the hand-opened one **stays**; screenshots of Start, account menu,
confirm dialog, lock screen.

**Done when:** that holds. Do not click Sleep / Restart / Shut down on
the dev machine; they are exercised on the VM.

---

### Step 10 — Quick settings and notices

`audio.rs`, `power.rs` (battery), `net.rs`, `system.rs`,
`QuickSettings.tsx`, `SystemArea.tsx`, `Clock.tsx`.

```rust
pub struct Volume { pub level: f32 /* 0..1 */, pub muted: bool }
pub fn volume() -> Result<Option<Volume>, DesktopError>;     // None = no render device
pub fn set_volume(level: f32) -> Result<(), DesktopError>;   // IAudioEndpointVolume::SetMasterVolumeLevelScalar
pub fn set_muted(m: bool) -> Result<(), DesktopError>;
pub fn battery() -> Option<Battery>;                          // GetSystemPowerStatus; None on desktops
pub fn connectivity() -> Connectivity;                        // None | Local | Internet (INetworkListManager)
```

- Core Audio and network COM objects live on a **second** worker thread
  (multithreaded apartment), not on the message thread. Their change
  callbacks arrive on arbitrary threads: push an event and return; never
  unregister from inside a callback. Re-bind on default-device change.
- Battery and power-source changes come from
  `RegisterPowerSettingNotification` on the hidden window.
- **Wi-Fi is status only**: an icon for internet / local only / none.
  There is no network list, no connect, no toggle (non-goal; on Windows
  11 24H2 the scan APIs also need location consent).
- **Brightness** is best effort: try `WmiMonitorBrightnessMethods.WmiSetBrightness`
  through raw COM in `Win32_System_Wmi`; if querying the current
  brightness fails at startup, the slider is hidden for the session.
  Whether a standard user may set it is **(unverified)**; it is checked
  on the VM. If this takes more than half a day, drop the slider and
  record it.
- Clock: time `HH:mm` and short date from the OS locale, updated on the
  minute boundary (one timer, not a 500 ms poll).
- Notices: `AppState::notify(tone, title, detail)` keeps the latest 20;
  the bell shows the unread count; the list is in quick settings. There
  are no floating toasts in Phase 3 and no Windows toasts.

Tests: volume clamping and rounding; battery text ("86% · Charging",
"On battery · 2 h 10 min left", none); connectivity mapping.

**Verify:** tests; demo run: the slider changes the real system volume
and moves when the volume is changed elsewhere; unplugging power (if a
laptop) updates the battery line within 5 seconds; screenshots.

**Done when:** that works and idle CPU is still under 1%.

---

### Step 11 — Built-in app windows

`appwin.rs`, `apps/AppHost.tsx`.

```rust
pub enum AppDoc { Files { path: String }, View { path: String } }   // path is RELATIVE to the employee root
pub fn open_doc(app: &AppHandle, doc: AppDoc) -> Result<String /* window label */, ShellError>;
pub enum SnapZone { Left, Right, TopLeft, TopRight, BottomLeft, BottomRight, Maximize, Restore }
pub fn snap(win: &WebviewWindow, zone: SnapZone) -> Result<(), ShellError>;   // rectangles from the current work area
```

- Standard mode: a new `app-<n>` window per document (the same file
  opened twice focuses the existing window). Lite mode: one `app-0`
  window; `open_doc` adds or selects a tab (max 8 tabs; the 9th asks to
  close one).
- Builder: no decorations, resizable, shadow on, minimum 380×280, URL
  `apps.html#/host`, default sizes from the design (files 860×540, image
  820×600, pdf 820×700, text 780×700, media 980×580, sheet 860×520),
  clamped to the work area, cascaded by 28 px.
- `AppHost` uses `<TitleBar dragRegion …>` with Solar icons. Window
  buttons call `win_minimize`, `win_toggle_maximize`, `win_close`
  (commands that act on the **calling** window only).
- Snapping (PRD 4.4): a menu on the maximize button with the six zones
  and Ctrl+Alt+Arrow keys inside a built-in window. Windows 11's own
  snap-layout flyout does not appear on a custom maximize button; do not
  try to add it.
- Open and close animation in full motion: `autoAlpha` 0→1 with `scale`
  0.97→1 over 0.2 s on the page root. Lite / reduced: fade only.
- Position memory (PRD 4.4): on move/resize end, save
  `{kind, x, y, w, h, maximized}` per employee in
  `%LOCALAPPDATA%\dev.rulebox.staff\employees\<employeeId>\windows.json`;
  restore if the rectangle still fits the current work area.
- All `app-*` windows close on log out and on lock they are minimized.

Tests: snap rectangles for two work areas; cascade; tab bookkeeping;
restore-if-fits.

**Verify:** tests; demo run: open the (still empty) Files window, drag,
resize, snap left and right, maximize — it must not cover the taskbar
strip **in dev mode it will respect the Windows work area; that is
expected**; switch to Lite in the overlay and see a single tabbed window.
Screenshots.

**Done when:** that works in Standard and Lite.

---

### Step 12 — Files backend: confinement, quota, protocol

`files/names.rs` (pure) — a component is rejected when it is empty, `.`
or `..`; contains any of `< > : " / \ | ? *` or a control character;
ends with a dot or a space; is a reserved device name (`CON`, `PRN`,
`AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, including the superscript
digit forms) with or without an extension, case-insensitively; is longer
than 255 UTF-16 units; or contains a right-to-left override character.
Rejecting `:` blocks alternate data streams and drive-relative paths.

`files/saferoot.rs`:

```rust
pub struct SafeRoot { /* cap_std::fs::Dir for the root, canonical root path */ }
pub struct RelPath(Vec<String>);                           // only constructible through validation
impl RelPath { pub fn parse(s: &str) -> Result<RelPath, FileError>; }   // splits on '/', validates each component
impl SafeRoot {
    pub fn open(root: &Path) -> Result<SafeRoot, FileError>;
    pub fn list(&self, dir: &RelPath) -> Result<Vec<Entry>, FileError>;          // reparse points are omitted
    pub fn stat(&self, p: &RelPath) -> Result<Entry, FileError>;
    pub fn open_read(&self, p: &RelPath) -> Result<std::fs::File, FileError>;
    pub fn mkdir(&self, p: &RelPath) -> Result<(), FileError>;
    pub fn rename(&self, from: &RelPath, to: &RelPath) -> Result<(), FileError>; // never overwrites
    pub fn copy(&self, from: &RelPath, to_dir: &RelPath) -> Result<RelPath, FileError>;   // " (1)" de-duplication
    pub fn move_to(&self, from: &RelPath, to_dir: &RelPath) -> Result<RelPath, FileError>;
    pub fn trash(&self, p: &RelPath) -> Result<(), FileError>;                    // into .rulebox-trash/<id> + index
    pub fn restore(&self, id: &str) -> Result<RelPath, FileError>;
    pub fn purge(&self, id: Option<&str>) -> Result<(), FileError>;               // None = empty trash
    /// For handing a file to an external app or WebView2: opens the file without following
    /// reparse points, asks the OS for its final path, verifies it is under the root, returns it without the \\?\ prefix.
    pub fn absolute_for_launch(&self, p: &RelPath) -> Result<PathBuf, FileError>;
}
pub enum FileError { InvalidName(NameRule), NotFound, Exists, IsReparsePoint, OutsideRoot, QuotaExceeded { short_by: u64 },
                     BlockedType, TooLarge, Io(String) }
```

Rules:

- **React only ever sends paths relative to the root**, with `/`
  separators. No command accepts an absolute path.
- All I/O goes through the `Dir` handle opened once at sign-in.
- **Reparse points (symlinks, junctions) are rejected everywhere**: not
  listed, not traversed in walks, sizes or search, not opened. A standard
  user can create junctions without any privilege.
- Delete moves to a hidden `.rulebox-trash` folder inside the root (P4).
  It is hidden from listings, counts toward the quota, and is purged
  after 30 days or by "Empty trash". Shift+Delete deletes permanently
  after a confirmation.
- Hidden from listings: names starting with `.rulebox-`.

`files/types.rs` (pure):

```rust
pub enum Opener { Viewer(ViewerKind), Handler { app_id: String }, None, Blocked }
pub fn opener_for(name: &str, handlers: &BTreeMap<String, String>) -> Opener;
```

Order: (1) **deny-list** — the last extension, lower-cased, after
trimming dots and spaces, is in `DENY` → `Blocked`, and `fileHandlers`
can never override it; (2) built-in viewer for the extension; (3)
`fileHandlers[".ext"]`; (4) `None`. `DENY` is Outlook's blocked-attachment
list plus additions; it must contain at least: `exe msi bat cmd com scr
pif cpl ps1 psm1 psd1 ps1xml vbs vbe js jse wsf wsh ws hta lnk url scf
reg inf msc msp mst jar jnlp application appref-ms appx appxbundle msix
msixbundle appinstaller gadget dll sys ocx drv chm hlp iso img vhd vhdx
library-ms search-ms settingcontent-ms diagcab py pyw rb pl sh xll wll
html htm mht mhtml svg xml rdp`. Put the full list (from the research
source in Section 19) in one sorted constant with a test that it is
sorted and lower-case. `svg`, `html` and `xml` are blocked from
**opening**; SVG is never rendered.

Content check before any preview or launch (`infer` on the first 8 KB):
refuse when the bytes are a Windows executable, an installer or a
shortcut whatever the extension says, and refuse a `.pdf` that does not
start with `%PDF-`.

`files/quota.rs`: one `walkdir` pass at sign-in on a worker (skipping
reparse points), cached total; a recursive `notify` watch (debounced
400 ms) updates the total and emits `files://changed { dir }` for the
folders that changed; a rescan event triggers a full re-walk. At 100%:
block copy, paste-as-copy, restore from trash, new files and downloads;
**always** allow delete, empty trash, move, rename, open. A copy that
would exceed the quota is refused up front with the shortfall.

`files/protocol.rs` — custom scheme `rbfile`
(`register_asynchronous_uri_scheme_protocol`), URL
`http://rbfile.localhost/<url-encoded relative path>`:

- Only for the signed-in employee; 403 when signed out.
- Parse with `RelPath::parse`; open with `SafeRoot::open_read` on a
  worker thread.
- `Range` request → `206` with `Content-Range`, at most 2 MiB per
  response; no `Range` → `200` with `Accept-Ranges: bytes` and
  `Content-Length`; unsatisfiable → `416`.
- `Content-Type` from a fixed table of the viewer formats only; anything
  else → 403. Never `text/html`, never SVG.
- Always `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

`files/preview.rs`: `read_text(p)` (first 2 MiB, BOM then `chardetng`,
returns UTF-8 + `truncated`), `read_csv(p)` (first 5,000 rows),
`office_precheck(p)` (file ≤ 25 MB; with the `zip` crate: at most 2,000
entries and declared uncompressed total ≤ 200 MB, else `TooLarge`),
`image_info(p)` (pixel size from the header; over 40 megapixels →
`TooLarge`).

`files/openwith.rs`: `open_with(p)` → `opener_for` must be `Handler`;
find the catalogue app; build arguments from its `file_arg_template`
(tokens; `{file}` must be a whole token and is replaced by
`absolute_for_launch`); `launch` (Step 8). Never `ShellExecute`, never a
shell, never default associations.

Commands (in `APP_COMMANDS`; `fs_list`, `fs_recent`, `fs_search` also in
`SHELL_COMMANDS` for the desktop panel and Start menu): `fs_list`,
`fs_stat`, `fs_mkdir`, `fs_rename`, `fs_copy`, `fs_move`, `fs_trash`,
`fs_restore`, `fs_purge`, `fs_usage`, `fs_search(query)` (streaming,
case-insensitive substring on names, cancellable, capped at 500),
`fs_recent()`, `fs_open(path)` (returns what to do: viewer kind, launched
handler, blocked, none), `fs_read_text`, `fs_read_csv`,
`fs_office_check`.

Tests (run on the dev machine inside a temp directory under `target\`):

1. `RelPath::parse` rejects: `..`, `a/../b`, absolute `C:\x`, `\\server\s`,
   `C:foo`, `\\?\C:\x`, `a.txt:stream`, `CON`, `nul.txt`, `x.` and `x `,
   a 300-unit name, a name with U+202E.
2. A **junction** to `C:\Windows` created inside the root
   (`cmd /c mklink /J`): not listed, `open_read` through it fails, the
   size walk ignores it.
3. A directory swapped for a junction between `list` and `open_read`
   fails with `IsReparsePoint` or `OutsideRoot`.
4. `rename` onto an existing name fails; case-only rename works.
5. Trash → restore → original place; restore when the name is taken
   de-duplicates.
6. `opener_for`: `a.exe` blocked even with a `.exe` handler configured;
   `a.pdf.exe` blocked; `A.PDF` → PDF viewer; `a.docx` with a handler →
   viewer first (viewer wins; "Open with" is a separate action);
   `a.mkv` with a handler → handler; `a.xyz` → none.
7. A file named `x.pdf` whose bytes start with `MZ` is refused.
8. Protocol: 200 / 206 / 416 shapes; a 3 MiB range request is capped;
   signed out → 403; `nosniff` present.
9. Quota: copy refused with the right shortfall; delete allowed at 100%.
10. Zip pre-check refuses an archive whose declared size is over the cap.

**Verify:** clippy and tests for `rulebox-staff`.

**Done when:** all tests pass, including 2 and 3.

---

### Step 13 — File explorer UI

Files under `apps/files/`.

- Views: grid (`minmax(124px, 1fr)`, `FileChip` + name) and list (name,
  type, size, modified). Both are virtualised with
  `@tanstack/react-virtual`; keep the focused row mounted so keyboard
  focus is never lost.
- Selection model (`useSelection.ts`, pure reducer): click, Ctrl+click,
  Shift+click, rubber band is **not** built.
- Keyboard (`keymap.ts`): arrows; Home / End; Page Up / Down; Shift +
  arrows extend; Ctrl+A; Enter opens; F2 renames (the base name is
  selected, not the extension; Escape cancels); Delete → trash;
  Shift+Delete → permanent with a confirmation; Ctrl+C / Ctrl+X / Ctrl+V;
  Backspace and Alt+Up → parent; Alt+Left / Alt+Right → back / forward;
  F5 refresh; Ctrl+F search; Ctrl+Shift+N new folder; type-ahead with a
  500 ms buffer; Shift+F10 or the Menu key opens the context menu.
- **Clipboard is app-internal only**: a list of relative paths plus
  copy/cut in Rust state. The Windows clipboard is never read or written
  for files, so nothing can be imported from outside the root.
- **Drag and drop**: only moves inside the explorer (pointer-based). The
  page cancels `dragover` and `drop` at document level so a file dropped
  from outside never navigates the WebView.
- Context menu: Open, Open with <app> (only when `fileHandlers` has an
  entry), Rename, Copy, Cut, Paste, Move to trash, New folder. Never the
  Windows shell context menu.
- Storage bar: `ProgressBar` with "6.2 of 10 GB" and the thresholds of
  Section 7.8.
- Live refresh from `files://changed`.
- Accessibility: list view is a grid (`role="grid"`, `aria-rowcount`,
  `aria-rowindex`, `aria-multiselectable`); grid view is a listbox; the
  focused item uses `aria-activedescendant`; an `aria-live="polite"`
  region announces "3 items selected", "Moved to trash", errors.
- `MyFilesPanel` (desktop) and Start-menu recents now use `fs_recent`.

Tests: selection reducer (15 cases); keymap table; rename validation
messages; storage bar thresholds at 79, 80, 95, 100%.

**Verify:** tests, typecheck, lint; demo run with the seeded demo folder
(the demo agent creates about 12 sample files and one folder of 5,000
empty files): every state of Section 7.8, keyboard-only walk through
create, rename, copy, paste, trash, restore; scroll the 5,000-file folder
smoothly; screenshots in light, dark, Lite.

**Done when:** all of it works without a mouse.

---

### Step 14 — Viewers and "open with"

Every viewer is a lazily imported chunk (`React.lazy`), loaded only when
first used (PRD 22.4).

| Viewer | How |
|---|---|
| Image | `<img decoding="async">` from `rbfile`, after `image_info`. Zoom and pan with pointer events and `transform: translate() scale()` only; fit / 100% / zoom in / out buttons; `+`, `-`, `0` keys |
| Audio / video | Native `<audio>` / `<video controls controlsList="nodownload noremoteplayback" disablePictureInPicture>` from `rbfile` (seeking relies on the 206 responses). On `error`, show the fallback of Section 7.9 |
| Text | `<pre>` filled with `textContent` (never `innerHTML`); windowed rows above 5,000 lines |
| CSV | Virtualised table from `fs_read_csv`; every cell rendered as text |
| PDF | `pdfjs-dist` **legacy** build, core API with your own canvas viewer (toolbar: page n of m, zoom 50–200%, fit width). Do **not** ship PDF.js's `viewer.html`. Options: `isEvalSupported: false`, `enableXfa: false`, `disableAutoFetch: true`, load by URL from `rbfile` (range requests). Worker: `import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"`. Copy `cmaps/` and `standard_fonts/` from the package into `public/pdfjs/` with a small script in `package.json` (`"prepare:pdfjs"`), and set `cMapUrl`, `cMapPacked: true`, `standardFontDataUrl`. Render only the visible pages ±1; cap each canvas at 6 megapixels and device pixel ratio 1.5; call `page.cleanup()` and destroy the document on close. Check option names against the 6.x type definitions |
| DOCX | `fs_office_check`, then `docx-preview` in the page; sanitise the produced HTML with `dompurify`; show it inside `<iframe sandbox srcdoc>` (no `allow-scripts`, no `allow-same-origin`) whose document carries its own CSP `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:` |
| XLSX | `fs_office_check`, then SheetJS in a **Web Worker** with `sheetRows` capped; formulas are not evaluated; render your own virtualised grid (never `sheet_to_html`); sheet tabs |
| Unsupported | Section 7.9 |

SheetJS: download `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
once at development time into `vendor/`, commit it, and depend on it with
`"xlsx": "file:../../vendor/xlsx-0.20.3.tgz"`. This is build-time
vendoring, not a runtime CDN. Record the file's SHA-256 in the report.
If the download is not possible, stop and ask.

Each Office parse has a 15-second timeout (terminate the worker) and
shows "Preview not available" on failure. Macros are never run; external
links and images are never fetched (the CSP forbids it).

`THIRD_PARTY_NOTICES.md`: add PDF.js, docx-preview, SheetJS CE,
DOMPurify, TanStack Virtual with their licences (this file is the one
exception to "touch no other files" in Phase 3 — it is required by the
project rules).

"Open with": the file context menu and the Unsupported screen call
`fs_open_with(path)` (Step 12).

Tests: viewer selection from `fs_open` results; zoom maths; CSV cell
rendering treats `=cmd|…` as text; the sandboxed iframe has no
`allow-scripts`; a unit test that the built PDF viewer chunk is not
imported by `shell/main.tsx` (assert on the import graph with a simple
string check of the Vite manifest in a script, or a lint rule).

**Verify:** tests, typecheck, lint; demo run with real sample files you
create under `target\demo-files\` (a multi-page PDF, a 20-megapixel JPG,
an MP3, a 1-minute MP4, a DOCX with an image, an XLSX with two sheets, a
3 MB text file, a renamed `.exe` → `.pdf`): each opens or is refused as
specified; seeking in the MP4 works; screenshots in light, dark, Lite.

**Done when:** all of it holds and the desktop page's network panel shows
no viewer chunk loaded before a file is opened.

---

### Step 15 — Web app windows

`webapp/allow.rs` (pure):

```rust
pub struct AllowList { /* lower-cased registrable hosts */ }
impl AllowList {
    pub fn new(primary_url: &str, extra_domains: &[String]) -> Result<AllowList, WebError>;
    /// https only (plus the local blocked page). Host equals an allowed domain or is a subdomain of one.
    /// IP literals, user-info in the URL, non-default ports unless listed with the port, and punycode
    /// look-alikes are not special-cased: only exact suffix matches on label boundaries pass.
    pub fn allows(&self, url: &str) -> bool;
}
```

`webapp/mod.rs` — `open_web_app(app: &AppEntry)`:

- Label `web-<appId>-<n>`; `WebviewUrl::External(url)`; **native
  decorations**; title = app name; 1100×720 clamped to the work area.
- `data_directory` =
  `%LOCALAPPDATA%\dev.rulebox.staff\web\<employeeId>` — one folder per
  employee, shared by all of that employee's web apps, so they share one
  browser process (PRD 22.4) and employees never share cookies (PRD 5.3).
- `additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI")`.
  This **replaces** the defaults on purpose: it leaves SmartScreen on for
  remote content. (Different arguments require a different data folder
  than the shell UI, which this already is.)
- `devtools(false)`, `zoom_hotkeys_enabled(false)`,
  `general_autofill_enabled(false)`, no initialization script, no
  `withGlobalTauri`, drag-drop handler left on (it blocks file drops from
  navigating).
- `on_navigation(|url| allow.allows(url) || is_blocked_page(url))`; when
  it returns false, navigate the window to the blocked page.
- `on_new_window(|url, _| …)`: allowed → navigate **this** window to the
  URL and return `Deny`; otherwise show the blocked page and return
  `Deny`. A new native window is never created by a site.
- `on_download`: see `download.rs`.
- Blocked page: custom scheme `rbblocked`
  (`http://rbblocked.localhost/?host=<host>&back=<url-encoded last allowed url>`),
  a static HTML document **without scripts**, with the text of Section
  7.10 and a plain link back. It is the only local page a `web-*` window
  can show, and it grants nothing.

`webapp/hooks.rs` — through `with_webview` and `webview2-com`, on the
`ICoreWebView2` of each web window (this is the only place outside
`rulebox-desktop` that uses `unsafe`):

| WebView2 event or setting | Behaviour |
|---|---|
| `PermissionRequested` | Look up the request's **URI** in the app's allow-list and the permission kind in `WebPermissions`; `SetState(ALLOW or DENY)`; set `SavesInProfile(false)` (otherwise the decision is stored in the profile and the handler stops firing). Unknown kinds → deny. Each denial adds a notice and increments a per-app counter in `AppState` (for PRD 24.1's dashboard count, reported in Phase 4). Use this raw handler, **not** Tauri's `on_permission_request`: that API does not give the requesting origin |
| `FrameNavigationStarting` | Cancel navigations of frames to hosts outside the allow-list (Tauri's `on_navigation` sees the top level only) |
| `LaunchingExternalUriScheme` | Always cancel |
| `ScreenCaptureStarting` | Cancel unless `screenShare` is allowed |
| `NotificationReceived` | If `notifications` is allowed: mark handled and add a Rulebox notice with the title; else ignore |
| `ICoreWebView2Settings` | `AreDevToolsEnabled(false)`, `AreDefaultContextMenusEnabled(false)`, `AreBrowserAcceleratorKeysEnabled(false)`, `IsStatusBarEnabled(false)`, `IsPasswordAutosaveEnabled(false)`, `IsGeneralAutofillEnabled(false)`, `IsZoomControlEnabled(false)` |

Find the exact interface versions in `webview2-com` 0.39 for
`SetSavesInProfile` and the newer events; if one is missing in that
version, skip that single handler, default to deny where possible, and
report it.

`webapp/download.rs` (pure part + the handler):

```rust
pub fn clean_download_name(suggested: &str) -> String;   // file name only; names.rs rules; max 120 chars; "download" when empty
pub fn destination(root: &SafeRoot, name: &str) -> Result<PathBuf, FileError>;   // <root>\Downloads\<name>, " (1)" de-duplication (WebView2 overwrites)
```

`Requested`: `downloads` permission off → cancel; name on the deny-list →
cancel + notice; quota at 100% → cancel + notice; else set the
destination. `Finished`: run the content check (delete an executable in
disguise), update usage, delete the file if it pushed usage over the
quota (soft enforcement: Tauri's event has no progress or cancel after
start), add a notice.

Lifecycle: web windows appear in the task list as `own`; closing the
last window of an employee's web apps leaves the data folder (logins
persist for that employee, PRD 5.3); log out closes them all.
Minimized → set the controller invisible and `TrySuspend`; restored →
visible again (resume is automatic).

Known gaps to state in the report, not to fix here (Section 9):
`<input type="file">` opens the Windows file dialog; `window.print()`
opens the print dialog. WebView2 offers no supported way to intercept
either.

Tests: `AllowList` (exact host, subdomain, `evil-example.com` vs
`example.com`, `example.com.evil.net`, `http:` refused, port handling,
upper-case host, trailing dot); `clean_download_name` (path separators,
`..`, reserved names, trailing dots, 300 characters, empty); download
decision table; permission decision table.

**Verify:** clippy + tests; demo run with the demo web app pointing at
`https://example.com` with `iana.org` **not** allowed: the page loads;
the "More information" link shows the blocked page with a working "Go
back"; DevTools shortcut and right-click do nothing; a second demo app
on a camera test page is denied without any prompt and a notice appears;
a download lands in `target\demo-files\<user>\Downloads`. In the web
page's console (temporarily enable devtools in a debug build only)
confirm `window.__TAURI__` and `window.__TAURI_INTERNALS__` cannot invoke
any command (**(unverified)** whether the object exists at all; what
matters is that every call is rejected). Screenshots.

**Done when:** all of that holds.

---

### Step 16 — App switcher, thumbnails, hotkeys, admin exit

`hotkeys.rs` (crate, needs `&ShellToken`): `RegisterHotKey` on the
message thread for:

| Id | Default keys | Action |
|---|---|---|
| `Switcher` | Alt+Tab | Open the app switcher |
| `Start` | Ctrl+Esc | Open the Start menu |
| `AdminExit` | Ctrl+Alt+Shift+R (default; later from the agent, Section 15 R4) | Open the admin-exit PIN popup |

- **Shell mode only.** In dev mode the same three actions are reachable
  from the dev overlay, so nothing global is registered on the dev
  machine.
- If a registration fails, log it and continue; the feature is then
  reachable only by mouse (Start) or not at all (switcher). Record it.
- **No low-level keyboard hook** is installed anywhere in Phase 3. The
  Windows key therefore does not open Start (P7).

App switcher: the popup shows the task list (most recently active
first). Because the popup takes focus, key handling is in React: Tab /
Shift+Tab / arrows move; releasing Alt or pressing Enter activates;
Escape cancels. What Windows itself does with Alt+Tab when Explorer is
absent is **(unverified)** (sources conflict); the VM run decides whether
the registration works at all.

Thumbnails (`thumbs.rs`), Standard mode only:

```rust
pub struct Thumb { /* HTHUMBNAIL, unregisters on Drop */ }
pub fn show(dest_popup_hwnd: isize, source: isize, dest_rect_physical: Rect) -> Result<Thumb, DesktopError>;
```

The destination is the popup's own top-level window; the page leaves an
empty rectangle and sends its position; DWM draws the live thumbnail
there. Shown after a 400 ms hover on a task button, removed on leave.
Fallback (minimized, cloaked, registration error, Lite): icon and title.
This works with Explorer running, so it is testable on the dev machine.

Admin exit — implement Section 7.11 exactly. Files: `exit.html`,
`src/exit/main.tsx`, `src/exit/AdminExit.tsx` (add `exit` to the Vite
inputs), `hotkeys.rs`, commands `admin_exit_open()` (any `shell-*` or
`app-*` window), `admin_exit_state()`, `admin_exit_submit(pin)` and
`admin_exit_close()` (only `shell-exit`).

```rust
pub enum AdminExitOutcome { SigningOut, WrongPin { attempts_left: Option<u32> }, LockedOut { retry_after_ms: u64 }, Disabled }
pub struct AdminExitView { pub link: AgentLinkDto, pub supported: bool, pub enabled: bool, pub lite: bool, pub theme: ThemeDto }
/// Parses "Ctrl+Alt+Shift+R"-style text: 1..3 modifiers from Ctrl, Alt, Shift plus one letter, digit or F-key.
/// Rejects combinations without Ctrl or Alt, and Alt+Tab / Ctrl+Esc / Ctrl+Alt+Del.
pub fn parse_hotkey(text: &str) -> Result<Hotkey, HotkeyError>;
```

- `admin_exit_open` is implemented entirely in Rust: if the exit is
  disabled, return; hide `shell-popup`; create `shell-exit` (or focus the
  existing one). It must work when `AppState` is in any session state and
  when no agent was ever linked.
- `exit.html` imports only `@rulebox/ui` CSS, `Input`, `Button` and
  `LogoMotion`; it calls `admin_exit_state` on load and listens to one
  event, `exit://state`. It does not import `lib/store.ts`.
- The global hotkey is registered at startup **before** the agent link
  exists, with the default; it is re-registered when the snapshot brings
  another combination. Registration failure → retry every 30 seconds.
- In every Rulebox page a small shared listener (`lib/exitKey.ts`,
  dependency-free) matches the current combination on `keydown` and calls
  `admin_exit_open`. This also makes the exit reachable in dev mode,
  where no global hotkey is registered.
- `admin_exit_submit` has a 10-second timeout and maps `NotLinked` /
  `Timeout` to the "can't check right now" state. The PIN `String` is
  dropped after the call and never logged.
- `SigningOut`: show the message and wait; the **agent** ends the Staff
  session and holds automatic sign-in back (Section 15, R3). The Staff
  App does not call `ExitWindowsEx` for this.
- Rate limiting, lockout and audit are the agent's job (PRD 12.4). The
  UI shows what the agent answers.

Tests: switcher ordering and key handling; thumbnail rectangle scaling
at 125%; `parse_hotkey` (valid, missing modifier, reserved combinations,
garbage); admin-exit state mapping for every row of Section 7.11
including agent-not-linked → linked; PIN input filter; `admin_exit_open`
succeeds in each `SessionState` and with `link = Disconnected`; a test
that `exit.html`'s entry does not import the store, GSAP or any icon.

**Verify:** tests; demo run: open the switcher from the overlay and pick
a window with the keyboard; hover a task button and see a live thumbnail
of Notepad (Standard) or the tooltip (Lite). Admin exit, in demo mode:
press the combination on the splash, the sign-in screen, the lock screen,
the desktop, inside the file explorer, and while the Start menu is open —
the dialog opens every time; `2468` shows "Signing out…" and the demo
agent logs it; a wrong PIN shows the error; five wrong PINs show the
countdown; with the demo agent's "link down" switch the field is disabled
and re-enables when the link returns; force an error in the desktop page
(dev overlay "throw") and open the exit again; repeat once in Lite.
Screenshots of each dialog state. Confirm that **no** global hotkey was
registered in dev mode (Alt+Tab still shows the Windows switcher).

**Done when:** all of that holds.

---

### Step 17 — Performance, Lite, logo smoothness, accessibility pass

**Suspension (PRD 22.4).** For every `app-*` and `web-*` window: on
minimize or hide, set the WebView controller invisible and call
`TrySuspend`; on show, make it visible. While a maximized window covers
the desktop, set `MemoryUsageTargetLevel` to Low on the `shell-desktop`
WebView and back to Normal when the desktop is visible again. Do not use
both mechanisms on the same WebView.

**Frame meter** (`lib/frameMeter.ts`, debug builds): counts
`requestAnimationFrame` gaps while a named span is active and logs
`{ name, frames, avgMs, worstMs, over32ms }`.

**Logo check in WebView2 (required; the animations were checked frame by
frame in Chrome but never profiled).** With the frame meter running in
the real Tauri window, at 1366×768 and at full screen, record splash,
loading (10 s), open and lock, in full motion, reduced motion and Lite.
Targets on the dev machine: average frame ≤ 18 ms, worst ≤ 50 ms, no
more than 3 frames over 32 ms per animation; in Lite and reduced motion
the logo only fades and **both** `onCovered` and `onDone` arrive (from
the callback or the fallback timer — log which). If a target is missed,
**do not change `logo-motion.css` or `LogoMotion.tsx`**; report the
numbers and stop for the user (CLAUDE.md: keep those animations exactly).

**Budgets** (measure with Task Manager → Details, "Memory (private
working set)", summed over `rulebox-staff.exe` and all its
`msedgewebview2.exe` processes; record every number in the report):

| Scenario | Budget (4 GB laptop, Lite) | Budget (dev machine, Standard) |
|---|---|---|
| Sign-in screen idle | ≤ 220 MB | ≤ 300 MB |
| Desktop idle, no apps | ≤ 260 MB | ≤ 350 MB |
| + file explorer + one PDF | ≤ 380 MB | ≤ 520 MB |
| + two web apps open, one minimized | ≤ 700 MB | ≤ 900 MB |
| Idle CPU, desktop visible | < 1% | < 1% |
| Cold start to sign-in screen | ≤ 4 s | ≤ 2 s |
| Task button reacts to a window opening | ≤ 300 ms | ≤ 300 ms |

These numbers are targets set by this plan, not measurements; Microsoft
publishes no per-WebView figure. If a budget is missed by more than 20%,
report it with the measurements instead of cutting features on your own.

Other checks: the desktop and taskbar bundles contain no viewer code and
no GSAP Flip unless used (inspect the Vite build output sizes); only one
`setInterval` per window runs when idle (the 5 s `ui_alive`) plus the
minute clock; every GSAP animation is created in `useGSAP` and reverted
on unmount; nothing animates in a minimized window.

**Accessibility pass** (Section 11) over every screen: keyboard-only
walk, visible focus, names on all icon buttons, contrast in light and
dark, 200% text zoom in built-in windows.

**Done when:** the table is filled for the dev machine, the logo targets
are met or reported, and the accessibility checklist is ticked.

---

### Step 18 — VM run as the real shell (the user runs this)

Build for the VM (debug profile; this embeds the frontend, so no dev
server is needed):

```powershell
pnpm --filter @rulebox/staff-app tauri build --debug --no-bundle
```

Confirm the flag names with `pnpm --filter @rulebox/staff-app tauri build --help`;
the output is `target\debug\rulebox-staff.exe`. Never build without
`--debug`.

Give the user that exe and the checklist in Section 12.2. On the VM it
replaces `fake_staff` at
`%ProgramFiles%\Rulebox\versions\0.0.0-dev\rulebox-staff.exe` (Phase 2's
`vm-deploy.ps1` copies it; Section 15, R7). You do not run any of it.
Record the user's results; for each failure fix, rebuild, and ask for a
re-run of that item (2 attempts, then stop and ask).

If the Phase 2 agent is not ready, the user can still run the checklist
items marked "(no agent needed)" by setting the Staff account's shell to
the exe by hand on a VM snapshot; say clearly in the report which items
were not run.

**Done when:** Section 12.2 is ticked on at least one Windows 11 VM, or
each unticked item is listed with the reason.

---

### Step 19 — Wrap-up

1. Run and paste: `pnpm typecheck`, `pnpm lint`,
   `pnpm --filter @rulebox/staff-app test`,
   `cargo clippy --workspace --all-targets --all-features -- -D warnings`,
   `cargo test --workspace --all-features`, and the size of `target\`.
2. Leftover checks: no `unsafe` outside `crates/rulebox-desktop`,
   `src-tauri/src/webapp/hooks.rs` and Phase 2's crates; no
   `ShellExecute` anywhere; no capability matching `web-*`; no `remote`
   key in `capabilities/`; `tauri` has no `unstable` feature; no
   `convex` import under `apps/staff-app`; no raw colour literals under
   `apps/staff-app/src`; every icon import starts with `~icons/solar/`.
3. Delete `target\demo-files\` and any stray build output.
4. Put two screenshots in `docs/screenshots/` (`signin.png`,
   `desktop.png`) only if the user asks; the README mentions them.
5. Update `docs/plans/README.md`: Phase 3 status → `✅ Done` only after
   the user reviewed the VM run; until then
   `In progress (awaiting VM run)`.
6. Do not edit `docs/prd.md`, `CLAUDE.md` or the Phase 2 plan. Hand the
   user Sections 15, 16 and 17.
7. Commit only when the user says so; no push; no Claude attribution.

## Final report format (keep it short)

- ✅ / ❌ for each step's **Done when** check.
- Versions pinned (Section 5.5), WebView2 runtime version tested.
- The budget table of Step 17 with real numbers; the logo frame-meter
  numbers.
- Screenshots list (screen × light / dark / Lite).
- VM checklist results per Windows edition and build.
- Which activation rung worked, whether Alt+Tab and Ctrl+Esc registered,
  whether brightness works as a standard user.
- Which agent modes were tested (demo, simulated, real) and which
  capabilities the real agent had.
- Every deviation from this plan and why; anything **(unverified)** that
  you confirmed or disproved.
- Open questions for the user.

## Stop and ask the user if

- free disk space is below 8 GB, or a prerequisite is missing;
- the Windows work area, hotkeys or minimized-window setting changed on
  the dev machine (shell mode leaked);
- you would need the Tauri `unstable` feature, a plugin from the "do not
  add" list, a low-level keyboard hook, or `ShellExecute`;
- a logo animation misses its targets (do not edit the logo files);
- you need to change a file Phase 2 owns, or anything in the IPC
  contract;
- a step's **Done when** check still fails after 2 honest fix attempts;
- you want a dependency not named in Section 5.5, or a newer minor/major
  of a pinned one exists;
- the SheetJS tarball cannot be downloaded;
- the PRD and this plan disagree on something not listed in Section 16
  or 17.

---

## 9. Security notes

- **No admin rights, ever.** The app runs as the standard Staff user.
  `CreateProcessW` fails with error 740 for apps that demand elevation,
  and that failure is the wanted result. Nothing uses `runas`,
  `ShellExecute` or a compatibility layer to get around it.
- **Trust zones by window label.** `shell-*` and `app-*` get exactly the
  commands they need; `web-*` gets none; no capability has `remote`.
  Since Tauri 2.11.1 a remote origin needs an explicit `remote`
  capability to call anything, and there is none. Commands also check
  the caller's label. Passwords and the admin PIN are accepted only from
  `shell-desktop` / `shell-popup`.
- **React never names a program or an absolute path.** It sends app ids
  and root-relative paths; Rust resolves them against data that came
  from the agent.
- **Files:** one directory handle, validated relative paths, reparse
  points rejected, deny-list before anything else, content check before
  preview or launch, viewers read-only, Office previews sanitised and
  sandboxed without scripts, PDF scripting never wired up, SVG and HTML
  never rendered, served types limited to a fixed table with `nosniff`.
- **Web apps:** separate data folder and process tree, allow-list on
  top-level navigation, frame navigation and new windows, external
  protocols always cancelled, permissions answered per origin and never
  saved in the profile, downloads confined and checked, DevTools /
  context menu / browser shortcuts off, SmartScreen left on. **Not
  covered:** sub-resource requests (images, scripts, XHR) to other hosts
  are not filtered; that is how the web works and the PRD asks for a
  navigation allow-list only.
- **Secrets:** the Staff App holds none. It never sees the device secret,
  the Staff account password, the credential cache or the PIN hash. The
  employee's password exists only for the duration of one call.
- **The Staff session is untrusted, including this app.** Nothing here is
  a security boundary against a process running as Staff; the agent
  re-checks everything it is asked to do (Phase 2, Section 9).
- **Escape routes that remain after Phase 3** (Phase 5 locks these down;
  Phase 3 must not make them worse, and must not *rely* on any of them
  being open or closed):

  | Route | State after Phase 3 | Phase 3 rule |
  |---|---|---|
  | Ctrl+Alt+Del screen, Task Manager | Untouched until Phase 5 empties the screen by policy (PRD 12.2). It is **not** an admin route | No text, test or flow mentions or depends on it; the hidden exit is the route |
  | Windows key shortcuts, Win+R, Win+E | Untouched; many do nothing without Explorer **(unverified)** | No hook is installed |
  | File Open / Save dialogs in desktop apps and in web pages (`<input type="file">`) | Open: they show the real file system | Built-in windows never open a common dialog; the explorer has its own rename / new-folder UI |
  | Print dialog (`window.print()`, "Save as PDF") | Open | Built-in viewers have no print button |
  | Links in desktop apps opening a browser | Open | The shell never registers itself as a URL handler |
  | Sticky Keys and other accessibility shortcuts | Untouched | — |
  | The employee "Lock" | Convenience only | Labelled as such in Section 7.6 |
  | `explorer.exe` started by an allowed app | Opens a folder window (it is not the shell) | The tracker shows it like any window; nothing more |

---

## 10. Performance budget and Lite mode

- **WebView count:** 3 permanent shell WebViews in one process tree; at
  most 1 extra for built-in apps in Lite; 1 per open web app in a second
  tree. Never a hidden WebView kept "warm" other than `shell-popup`.
- **Lite mode** (`display.lite`, from the agent; RAM ≤ 4,352 MB): no
  blur, no blobs, solid surfaces, opacity fades ≤ 150 ms only, no Flip,
  no thumbnails, one tabbed built-in window, logo animations replaced by
  their built-in Lite fades.
- **CSS cannot stop GSAP**, so every animation goes through
  `lib/motion.ts`, which checks the level.
- **Lazy loading:** viewers, the file explorer, Start menu contents and
  quick settings load when first used.
- **No polling:** state arrives by events. Allowed timers: `ui_alive`
  (5 s), heartbeat (10 s, Rust), clock (per minute), hung check (5 s,
  only while tasks are visible).
- **Images:** icons are cached PNGs at the size shown; no thumbnail
  generation for files in Phase 3 (type chips instead).
- Budgets and how to measure: Step 17.

---

## 11. Accessibility basics

- Every action reachable by keyboard; Tab order follows the visual
  order; popups trap focus and return it on close.
- Visible focus ring everywhere (2 px accent outline, as `Button` has).
- Every icon-only control has a name (`IconButton` requires `label`).
- Roles: taskbar `role="toolbar"`; task buttons are buttons with
  `aria-pressed` for the active one; Start menu `role="dialog"` with a
  labelled search; menus `role="menu"`; file lists per Step 13; sliders
  are native range inputs; the lock and sign-in fields have labels.
- State is never colour alone (quota, active task, errors use text or an
  icon too).
- Contrast: body text ≥ 4.5:1 and large text ≥ 3:1 in light and dark;
  check `--rb-muted` on `--rb-surface-glass` over the blobs.
- `prefers-reduced-motion` and Lite both give fades only.
- Live regions announce sign-in errors, notices and file operations.
- Text scales: built-in windows stay usable at 200% zoom; the shell
  respects the Windows display scale (125%, 150%).

---

## 12. Test strategy

### 12.1 Dev machine (automated and manual, safe)

| Area | Kind |
|---|---|
| Name rules, `RelPath`, deny-list, opener choice, allow-list, download names, tile layout, snapping, selection, key maps, motion level | pure unit tests (Rust and Vitest) |
| `SafeRoot` including junction escapes, quota, protocol ranges | Rust tests in a temp directory under `target\` |
| State shape, demo agent, sign-in / sign-out sequences | Rust unit tests |
| Stores and screens' states | Vitest + Testing Library with mocked `invoke` |
| Window tracking, control, launching, volume, thumbnails | manual, in **dev mode** with Explorer running |
| Every screen in light / dark / Lite / reduced motion | manual with screenshots |
| IPC framing against Phase 2's simulated agent | manual (way 2 in Section 6.2) |

Dev mode cannot change the session: the functions that would need a
`ShellToken`, and `acquire` returns `None` while Explorer is the shell.

### 12.2 VM checklist (the user runs it; snapshot first)

Record Windows edition, version, build, display scale and RAM. Items
marked **(A)** need the Phase 2 agent with the capability named.

**Start-up**

- [ ] After sign-in to the Staff account the splash appears, then the
      sign-in screen, within 4 seconds; no Explorer desktop or taskbar.
- [ ] `rulebox-agent status` shows `shell.health: healthy` **(A)**.
- [ ] Killing `rulebox-staff.exe` brings it back in about 2 seconds;
      freezing it (debug overlay "freeze UI") gets it restarted by the
      agent in about 30 seconds **(A)**.
- [ ] With the agent service stopped, the app shows "Rulebox is still
      starting…" and recovers by itself when the service starts.

**Shell behaviour (no agent needed)**

- [ ] The taskbar is at the bottom; a maximized Notepad stops above it.
- [ ] Minimized windows do not leave small title bars at the bottom-left.
- [ ] Windows opened by desktop apps (including a second window and a
      dialog) appear in and disappear from the taskbar.
- [ ] Clicking a task button focuses, minimizes, restores. Note the
      activation rung from the log.
- [ ] Alt+Tab: what happens? (Rulebox switcher / nothing / Windows
      switcher.) Ctrl+Esc opens Start? The Windows key: what happens?
- [ ] Change resolution and scale (100% → 125% → 150%): desktop and
      taskbar re-fit; the work area follows.
- [ ] Plug in a second monitor: the shell stays on the primary one;
      windows moved to the second monitor are still controllable.
- [ ] Sleep and resume: taskbar, clock, battery and volume are right
      within 5 seconds.
- [ ] Volume slider works; brightness slider works or is hidden.
- [ ] A common file dialog (Notepad → Open) still works without Explorer.
      Record what it lets the user see (for Phase 5).
- [ ] The touch keyboard on a touch device: record behaviour.
- [ ] Another app's toast notification: record whether it appears.

**Employee flow (A: `session`, `apps`)**

- [ ] Sign in online; sign out; sign in offline; wrong password five
      times shows the lockout.
- [ ] Tiles show the assigned apps; a desktop app launches unelevated;
      an app that needs elevation shows the notice and **no UAC prompt**.
- [ ] Log out closes the launched apps and web windows.
- [ ] Lock and unlock.

**Files and viewers**

- [ ] The explorer shows only the employee folder; a junction created
      inside it (`mklink /J`) is invisible.
- [ ] Each viewer opens its sample; MP4 seeking works; a renamed `.exe`
      is refused.
- [ ] "Open with" starts the mapped app with the file.
- [ ] Trash, restore, empty trash; quota bar thresholds.

**Web apps**

- [ ] Allowed site loads; a link to a non-listed domain shows the blocked
      page; a pop-up to a non-listed domain is blocked.
- [ ] Camera denied without a prompt when not allowed; allowed when the
      app's rule says so.
- [ ] A download lands in the employee's Downloads folder.
- [ ] Two employees do not share a login in the same web app.

**Admin exit (A: `adminExit`)**

- [ ] The key combination opens the PIN dialog on: the sign-in screen,
      the desktop, the lock screen, while a desktop app has the focus,
      and while a web app has the focus.
- [ ] Wrong PIN and lockout messages; the right PIN ends at the
      **Windows sign-in screen** and Staff is not signed back in
      automatically.
- [ ] With the network cable out, the right PIN still works.
- [ ] With the agent service stopped: the dialog opens, says it cannot
      check the PIN, and works again once the service is started.
- [ ] In Lite mode the dialog looks and works the same.
- [ ] Recovery route (no Staff App involved): hold Shift during startup
      and reach the Windows sign-in screen.

**4 GB laptop (or a VM limited to 4 GB), Lite mode**

- [ ] The memory table of Step 17.
- [ ] Logo: fades only; sign-in to desktop is not delayed.
- [ ] Scrolling a 5,000-file folder and dragging a built-in window stay
      smooth (frame meter: worst frame ≤ 50 ms).

---

## 13. Edge cases and failure modes

| # | What can go wrong | Required behaviour | Step |
|---|---|---|---|
| 1 | Agent unreachable at start (boot race, service down) | Loading logo, retry forever with backoff, message after 20 s; no crash, no exit | 3, 5 |
| 2 | Agent goes away while an employee works | Banner "Rulebox is reconnecting…"; desktop, tracked apps, files and viewers keep working; sign-in, catalogue refresh and admin exit wait | 3 |
| 3 | IPC protocol major mismatch | "Rulebox needs an update" screen; retry every 30 s | 5 |
| 4 | Agent lacks a capability (`session`, `apps`, `adminExit`) | The matching feature shows its "not available" state; nothing else breaks | 5, 6, 16 |
| 5 | Sign-in while offline | Works if the agent says so; otherwise the two offline messages | 5 |
| 6 | Wrong credentials, lockout | Messages and countdown from the agent's answer; no client-side counting | 5 |
| 7 | Employee disabled or revoked while signed in | The agent's snapshot or next `session.get` says so → forced log out with "Your account was turned off." (hook: `SessionState` update from the agent; if the agent has no such signal yet, nothing happens — note in report) | 9 |
| 8 | `agent.shuttingDown` | Countdown banner; no new launches | 3 |
| 9 | A tracked window hangs | "Not responding" state; menu offers "End app" (terminate, same user only); control calls use timeouts so the shell never blocks | 7, 8 |
| 10 | A window steals focus or is "rudely" activated | The active indicator follows; nothing else. Popups close on blur | 7 |
| 11 | An app spawns extra windows, splash screens, dialogs | Tool and owned windows are filtered; real second windows get their own button grouped under the app; windows that become eligible later are picked up by show/uncloak events | 7 |
| 12 | A launched app hands off to an already-running instance and exits | The window maps to the app by exe path / AUMID even though it is not in the job; log out closes only windows mapped to a job the shell created **or** to a catalogue app the shell launched this session | 7, 9 |
| 13 | An app only lives in the system tray after "close" (Zoom) | Not reachable in v1 (PRD 13.4); log out still terminates it through the job | 9 |
| 14 | An app requires elevation | Notice, no UAC prompt, no retry | 8 |
| 15 | Display resolution or DPI change, monitor hot-plug | Re-place shell windows, re-apply the work area, re-clamp built-in windows and the popup | 4, 11 |
| 16 | Second monitor | Shell on the primary only; nothing drawn on the other (PRD 13.4) | 4 |
| 17 | Sleep and resume | Re-enumerate windows, re-read volume / battery / network, re-apply the work area, re-check the agent link | 4, 7, 10 |
| 18 | Windows session lock / unlock (if reachable) | On unlock: same as resume. The agent decides what a locked Staff session means (Phase 2) | 4 |
| 19 | The desktop window comes above other windows when clicked | Pushed back to the bottom on focus | 4 |
| 20 | Popup stays open after focus moved | Closes on blur and on Escape; a watchdog closes any popup visible without focus for 2 s | 4 |
| 21 | Quota exceeded | Section 7.8; downloads and copies refused; delete always works | 12, 15 |
| 22 | File type with no viewer and no handler | "No app on this PC can open .xyz files." | 12, 13 |
| 23 | Blocked file type, or an executable in disguise | Refused with the blocked-type message; never launched or previewed | 12 |
| 24 | Handler app missing or uninstalled | "LibreOffice could not be started." notice; the file is untouched | 12 |
| 25 | Path tricks: `..`, absolute, UNC, ADS, device names, junctions, swap race | Rejected by `RelPath` / `SafeRoot` (tests) | 12 |
| 26 | File changed, renamed or deleted by another app while shown | The list refreshes from the watcher; an open viewer shows "This file is no longer available." on its next read | 12, 14 |
| 27 | Huge folder, huge file, zip bomb, 100-megapixel image | Virtualised lists; size caps and pre-checks; clear "too large" states | 12–14 |
| 28 | Media codec not supported | Fallback message + "Open with" | 14 |
| 29 | Web app navigates off the allow-list (link, redirect, script) | Cancelled; blocked page. Whether `on_navigation` sees server redirects is **(unverified)**; the test in Step 15 and a redirecting test URL on the VM confirm it | 15 |
| 30 | Web app opens a new window or tab | Same-window navigation if allowed, else blocked | 15 |
| 31 | Web app downloads a file | Section 7.10; never a Save dialog | 15 |
| 32 | Web app asks for a permission | Answered silently from the rules, never stored in the profile | 15 |
| 33 | Web app opens a file picker or print dialog | Not interceptable; listed for Phase 5 | 9 (table) |
| 34 | WebView2 runtime missing or too old | The app cannot start a WebView: the launcher's crash-loop screen appears (Phase 2). Phase 6 installs the runtime; record the minimum version (125) | 0 |
| 35 | WebView2 runtime updates while the app runs | The new runtime is used after the next app restart; log out does not restart the app, so add "restart on log out when the runtime version on disk changed" only if the VM run shows a problem | 17 |
| 36 | Second instance started | Exits with code 0 at once | 1 |
| 37 | Panic in Rust | Logged; exit code 1; the launcher restarts the app; the employee is signed out of Rulebox (session state is in memory) — the sign-in screen says nothing special | 1 |
| 38 | Hotkey registration fails or is taken | Feature reachable by mouse only; logged | 16 |
| 39 | No audio device, no battery, brightness unsupported | The control is hidden or shows its "none" text | 10 |
| 40 | Clock wrong (`clockSuspect`) | Banner on sign-in; times still shown from the local clock | 5 |
| 41 | Logo callbacks never fire (Lite rule interplay, `tagline={null}`) | Fallback timers end the sequence | 5 |
| 42 | Text at 150% scale overflows the taskbar | Buttons shrink to icons, then scroll | 7 |
| 43 | Employee folder missing or unreadable at sign-in | Signed in, explorer shows "Your files can't be opened right now."; apps still work; reported to the agent log | 12 |
| 45 | Admin exit needed while the agent is slow or unreachable | Dialog opens; PIN field disabled with the "can't check right now" text; re-enables on link; after 30 s shows the two recovery routes. No local PIN check, no local sign-out | 16 |
| 46 | Admin exit needed while a page has crashed, a popup is stuck, or log-out is in progress | `shell-exit` is a separate window opened from Rust; it does not need the other pages | 16 |
| 47 | Admin-exit hotkey cannot be registered, or the dashboard sets an invalid combination | In-page listeners still work; registration retried every 30 s; invalid text → default combination, logged | 16 |
| 48 | Admin exit needed while the Staff App is not running at all (crash loop) | Not possible from the Staff App. The launcher's fallback screen should offer it (Section 15, R11); otherwise Disable kiosk from the dashboard or Shift at startup | — |
| 44 | Demo agent enabled by mistake in a release build | Impossible: `DemoAgent` is compiled only with `debug_assertions` | 3 |

---

## 14. Disk and build guidance

- One Cargo workspace, one `target\`. `crates/rulebox-desktop` is covered
  by the existing `crates/*` glob. Never set `CARGO_TARGET_DIR`.
- Debug builds only. The VM build is `tauri build --debug --no-bundle`
  (still the debug profile). No release build in Phase 3.
- Expect about +1 GB in `target\debug`. Warn before the first build of
  Step 1 and before Step 18.
- Use `-p` for Rust commands until Step 19; a workspace build also
  rebuilds the agent.
- pnpm only. `pdfjs-dist` and SheetJS are the largest additions
  (tens of MB in the store).
- Demo files live in `target\demo-files\`; delete them in Step 19.
- If space runs low: `cargo clean -p rulebox-staff` first; a full
  `cargo clean` only after telling the user.

---

## 15. Requested changes to Phase 2

Phase 3 does not edit the Phase 2 plan or Phase 2's files. These are
requests for the Phase 2 owner. Until they land, Phase 3 runs on
`DemoAgent` for the affected features.

**R1 — Protocol 1.1: employee session (capability `session`).** Wire
shapes (camelCase JSON; all additive, minor bump):

| Method | Params | Result |
|---|---|---|
| `session.signIn` | `{ username: string, password: string }` | `{ outcome: "ok", employee: { id, username, name, role?: string, quotaBytes: number }, filesRoot: string, offline: boolean }` or `{ outcome: "wrongCredentials" }`, `{ outcome: "disabled" }`, `{ outcome: "lockedOut", retryAfterMs: number }`, `{ outcome: "offlineNeverSignedIn" }`, `{ outcome: "offlineExpired" }` |
| `session.signOut` | `{}` | `{}` |
| `session.get` | `{}` | `{ employee: … \| null }` |
| `session.verifyPassword` | `{ password: string }` | `{ outcome: "ok" \| "wrongCredentials" \| "lockedOut", retryAfterMs?: number }` |

The agent verifies online against the backend, keeps the Argon2id
offline cache (PRD 13.6 #6) where the Staff account cannot read it,
rate-limits, creates the employee's folder and returns it as `filesRoot`
(a folder the Staff account can write, outside `%ProgramData%\Rulebox`).
A wrong password is an **outcome**, not an RPC error. The agent must not
log `password`.

**R2 — Protocol 1.1: app catalogue (capability `apps`).**
`apps.list {}` → `{ apps: AppEntry[] }` for the signed-in employee, with
the fields of `AppEntry` in Step 3 (`id`, `name`, `description?`, `kind`
= `builtin | web | desktop`, web: `url`, `allowedDomains`, `permissions`;
desktop: `exe`, `args`, `fileArgTemplate`; `pinnedTaskbar`,
`pinnedDesktop`, `iconPngBase64?`, `hue?`). Today `DesiredState.apps` is
only a list of ids, which is not enough to launch or draw anything.

**R3 — Protocol 1.1: admin exit (capability `adminExit`).**
`adminExit.submit { pin: string }` →
`{ outcome: "signingOut" }`, `{ outcome: "wrongPin", attemptsLeft?: number }`,
`{ outcome: "lockedOut", retryAfterMs: number }` or `{ outcome: "disabled" }`.
What the agent must do, since this is now the **only** in-session route
to an admin (PRD 9.5, 12.4):

- **Verify the PIN itself.** The salted hash (from the desired state)
  stays in the agent's protected storage; it is never put in the
  snapshot or any IPC result, so the Staff session is never trusted with
  it.
- **Rate-limit and lock out** in the agent, persisted across agent and
  PC restarts, counted per device (not per connection, since any Staff
  process can open the pipe). A wrong PIN is an outcome, not an RPC
  error. Never log the PIN.
- **Work offline**: no backend call is needed to check a PIN.
- **Audit**: record every use (success, failure, lockout) and report it
  to the dashboard audit log, queued while offline.
- **Sign out to the Windows sign-in screen** on success: suspend
  automatic sign-in first (otherwise Staff is signed straight back in),
  then end the Staff session. Re-arm automatic sign-in at the next
  restart or when the administrator's session ends (the Phase 2 owner
  chooses and documents which).
- **Answer fast**: the Staff App waits at most 10 seconds.
- **Honour remote disable and rotation** (PRD 12.4): when disabled,
  answer `disabled` and set `adminExit.enabled = false` in the snapshot.
- **Keep the Shift-at-startup bypass working.** It is one of the two
  recovery routes when the Staff App is broken. Phase 2 already forbids
  `IgnoreShiftOverride` and `ForceAutoLogon`; no later phase may set
  them.

Phase 2 currently lists the admin exit as a Phase 5 non-goal; it needs
an explicit owner now.

**R4 — Optional snapshot fields** (additive): `adminExit: { enabled:
boolean, hotkey: string }` (for example `"Ctrl+Alt+Shift+R"`; the
dashboard sets it per organization), `power: { sleep, restart, shutDown:
boolean }` (PRD 4.7), `orgName: string | null`. Until present, the Staff
App uses the default hotkey, all power options, and
`desiredState.branding.name`.

**R5 — Relax the "only two crates may use `windows`" rule** (Phase 2
plan, Section 4.2) to also allow `crates/rulebox-desktop` and
`apps/staff-app/src-tauri/src/webapp/`. The reason for the rule (one
place to migrate when `windows` 0.100 lands) still holds: it becomes
"four known places".

**R6 — `gen:types` script** must list all exporting crates:
`cargo test -p rulebox-policy -p rulebox-ipc -p rulebox-staff export_bindings`.
Both phases edit this line and `packages/types/src/index.ts`; whoever
lands second merges.

**R7 — `scripts/vm-deploy.ps1`** should copy a real `rulebox-staff.exe`
when one is next to it, and fall back to `fake_staff.exe` otherwise.

**R8 — Remove "Ctrl+Alt+Del → Switch user" as an admin route from the
Phase 2 plan.** PRD 9.5 and 12.2 now say that screen is emptied for
Staff, Switch user included. Places that rely on it: the launcher's
fallback text ("Administrators: press Ctrl+Alt+Del and choose Switch
user"), the edge-case rows about the admin's way back and about Switch
user disconnecting the Staff session, the security note that lists it,
the "Admin way back" VM checklist item, and the rule that leaves a
`Disconnected` Staff session alone. The routes to name instead: the
hidden exit, Disable kiosk from the dashboard, Shift at startup,
`rulebox-agent recover`. (Until Phase 5 applies the policy the screen
still works on a test VM, but nothing should be designed around it.)

**R11 — Hidden exit on the launcher's fallback screen.** When the Staff
App cannot start, `rulebox-shell.exe` shows its native "Rulebox can't
start" screen and there is no in-session route to an admin at all.
Request: the launcher listens for the same key combination and shows a
native PIN field that calls `adminExit.submit` on the shell pipe. This
needs the launcher to speak the IPC protocol, and Phase 2's peer check
must accept `<install>\rulebox-shell.exe` in addition to
`<install>\versions\`. If this is judged too much for Phase 2, the PRD's
two recovery routes remain the only ones in that state, and the fallback
screen's text should say so for administrators.

**R9 — Simulated agent.** `run --console --simulate` should answer the
1.1 methods from simple fixtures once they exist, so Phase 3 can test the
real pipe path for sign-in without a VM.

**R10 — Peer check.** Phase 2 accepts shell-pipe clients only from
`<install>\versions\`. That is correct and needs no change; it means a
`pnpm dev:staff` build can only ever talk to a `--simulate` agent. Stated
here so nobody "fixes" it.

No change is requested to the 1.0 contract itself.

---

## 16. PRD changes to propose

| PRD section | Proposed change | Reason |
|---|---|---|
| 4.1, 16 ("Mica/Acrylic materials via Tauri window effects") | Drop native window effects; the frosted look is CSS inside each window | They need transparent windows and Tauri documents them as slow when dragging or resizing; the target is 4 GB |
| 4.2 | Shell layout: three permanent windows (desktop + login, taskbar, one shared popup) instead of five | WebView budget; the login screen is a layer of the desktop window |
| 4.3 | Live thumbnails: Standard mode only; Lite shows a title tooltip. "Notifications" in the system area is Rulebox's own notice list, not Windows toasts | DWM thumbnails need a native surface; toasts without Explorer are unverified |
| 4.4 | Web app windows use the native title bar in v1 (already the stated fallback); Windows 11's snap-layout flyout is not available on custom title bars; Rulebox offers its own snap menu | Tauri multiwebview is still `unstable` (13.6 #7) |
| 4.5 | Work area is reserved with `SPI_SETWORKAREA` by the Staff App itself (no admin right needed); the AppBar API does not work without Explorer. Wi-Fi in quick settings is **status only** in v1; lists and connecting go through pushed profiles (24.2) | Research; Windows 11 24H2 gates Wi-Fi scanning behind location consent |
| 5.2 | State that employee sign-in is performed **by the agent** on the Staff App's request, and that the offline credential cache lives with the agent | The Staff session is untrusted; one backend connection per device instead of two |
| 3.3 | "The Staff App does not connect to the backend; the agent is its only data source" | Same; also settles the build-time Convex URL conflict |
| 7.1 | PPTX: "Preview not available — open with an approved app" in v1; list the exact formats per viewer (no HEVC, AVI, WMV); MKV depends on its codecs | No offline PPTX renderer of known quality was found; codec facts from Chromium |
| 7.3 | Publish the full deny-list (Outlook's blocked list plus additions) and state that `fileHandlers` cannot override it; add "content is checked, not only the extension" | Makes "and similar" concrete |
| 4.6 / 8 | Define delete: moves to a per-employee trash inside the folder, counted in the quota, purged after 30 days | The Recycle Bin without Explorer is unverified and has no UI |
| 12.4 | Add: the **agent** verifies the PIN and performs the sign-out (the Staff App never holds the hash); the exit works offline; the default key combination; what happens when the Staff App is not running (launcher fallback screen, Section 15 R11) | 9.5 and 12.4 already record the decision; these details are still missing |
| 13.6 #8 | Row 8 still describes "Ctrl + Alt + Del → Switch user shows the admin account" and tells the admin to use "Other user". It contradicts the new 9.5 / 12.2 and should be rewritten or removed | Stale after the decision |
| 12.2 | Note that hiding Switch user **for the Staff account only** on Windows 11 Home is unverified (`HideFastUserSwitching` is machine-wide) | Phase 5 must test it |
| 13.1 | Add rows: web-page file pickers and print dialogs cannot be intercepted in WebView2; `explorer.exe` launched by another app opens a folder window | Research |
| 13.4 | "Minimized windows": hidden with `ARW_HIDE` by the Staff App at each start. Alt+Tab behaviour without Explorer must be tested | Research; sources conflict |
| 22.4 | Define Lite "in-app windows inside one shared WebView" as one tabbed built-in window | Removes ambiguity |
| 24.1 | Permission decisions are per requesting origin and never stored in the browser profile | Otherwise the handler stops being asked |
| 25.5 | Note that `LogoMotion` callbacks need a timeout fallback in callers, and that "open" must be mounted at final window size | Found while mapping the component |
| CLAUDE.md (not PRD) | "bottom taskbar (84 px)" should read "60 px bar inside an 84 px reserved zone" | Matches tokens and the design |

---

## 17. Open questions for the user

The plan assumes the **recommended** option.

| # | Question | Options | Recommendation and what changes otherwise |
|---|---|---|---|
| P1 | Who verifies employee sign-in? | (a) The agent, over IPC. (b) The Staff App talks to Convex itself | **(a).** With (b): a second backend connection per device (free tier: 1,000 concurrent sessions), a credential cache readable by the Staff account, CSP and Step 3/5 changes |
| P2 | Should the launcher's "Rulebox can't start" screen also offer the hidden exit? (Ctrl+Alt+Del is decided: not an admin route) | (a) Yes: the launcher shows a native PIN field and asks the agent (Section 15, R11). (b) No: in that state only Disable kiosk and Shift at startup remain | **(a).** Otherwise an admin standing at a PC whose Staff App is broken has no on-screen route and must restart it. No Phase 3 step changes either way |
| P3 | Default admin-exit key combination | Ctrl+Alt+Shift+R (suggested) or another | **Ctrl+Alt+Shift+R** unless it collides with an approved app's shortcut. It is one constant (Step 16) |
| P4 | What does Delete do? | (a) Trash folder inside the employee folder. (b) Windows Recycle Bin. (c) Permanent | **(a).** (b) is unverified without Explorer and has no restore UI |
| P5 | PPTX preview (PRD 7.1 lists it) | (a) "Preview not available — open with …". (b) Ship a best-effort library | **(a).** No library of known quality was found or tested |
| P6 | Title bar of web app windows | (a) Native Windows title bar. (b) Custom, using Tauri's `unstable` multiwebview | **(a)** for v1 (PRD 13.6 #7) |
| P7 | Should the Windows key open the Rulebox Start menu? | (a) No; Start opens by click and Ctrl+Esc. (b) Yes, with a low-level keyboard hook | **(a).** A global keyboard hook looks like a keylogger to antivirus, and Phase 5 will disable Windows-key shortcuts by policy anyway |
| P8 | Lite mode built-in windows | (a) One tabbed window. (b) In-page floating windows inside one full-screen WebView | **(a).** (b) cannot interleave with other apps' windows |
| P9 | May employees change light / dark? | (a) No: follows the organization setting, default Auto. (b) Yes, per employee, in quick settings (the design shows it) | **(a)** until the dashboard has the setting; (b) is a small addition in Step 10 |
| P10 | Sign-in screen remembers the last employee's name | (a) Yes (as designed). (b) Always ask for the username | **(a).** With (b): one branch less in Step 5 |
| P11 | Wi-Fi in quick settings | (a) Status only. (b) List and connect now | **(a).** (b) needs agent methods and the location-consent story |
| P12 | Employee "Lock" (apps stay open) | (a) Include as a convenience. (b) Leave out until Phase 5 | **(a).** It is in the design and PRD 4.7 mentions locking |
| P13 | Second monitor | (a) Blank in v1 (PRD 13.4). (b) Mirror the wallpaper | **(a)** |
| P14 | Who implements the agent side of `session.*`, `apps.list` and `adminExit.submit`? | (a) A Phase 2 addendum (wire types + fixtures in the simulated agent), real backend in Phase 4. (b) Entirely Phase 4 | **(a).** Phase 3 can then be tested on the real pipe much earlier |
| P15 | Brightness slider | (a) Best effort from the Staff App, hidden when it fails. (b) Through the agent | **(a)**; move to (b) if the VM shows a standard user cannot set it |

---

## 18. Could not be verified

Each item is carried into the plan with a way to settle it (mostly the VM
checklist).

- Whether **Switch user can be hidden for the Staff account alone** on
  Windows 11 Home (the known policy value is machine-wide). Phase 5 work,
  listed here because the hidden exit's importance rests on it.
- Whether `RegisterHotKey` accepts the admin-exit combination in every
  state without Explorer (the in-page listeners are the fallback).
- What Windows does with **Alt+Tab** and the **Windows key** when Explorer
  is not the shell; whether `RegisterHotKey` for Alt+Tab and Ctrl+Esc
  succeeds there.
- Whether `SetForegroundWindow` succeeds when the click landed in the
  WebView2 child process (activation ladder, Step 8).
- Whether `SetTaskmanWindow` is required for shell-hook messages; whether
  `SPI_SETWORKAREA` and `ARW_HIDE` persist; how maximized windows react
  when the work area grows.
- Standard-user rights for `WmiSetBrightness`.
- Toast notifications, the touch keyboard and the common file dialog
  without Explorer.
- Whether Tauri's `on_navigation` is called for server redirects; whether
  Tauri injects its IPC bootstrap object into external pages (calls are
  rejected either way).
- Exact `webview2-com` 0.39 interface versions for `SavesInProfile`,
  `ScreenCaptureStarting`, `NotificationReceived`,
  `LaunchingExternalUriScheme`.
- Whether Tauri's `on_download` hides WebView2's own download flyout, and
  whether downloads get a Mark-of-the-Web.
- `cap-std` behaviour with junctions and concurrent renames on Windows
  (covered by Step 12 tests 2 and 3).
- PDF.js 6.x option names (`isEvalSupported`, worker and font paths) and
  whether its decoders need `'wasm-unsafe-eval'`.
- Whether WebView2 ships H.264 / AAC decoding on every Windows edition
  (assumed yes; the fallback handles no).
- Whether the Lite-mode logo fades fire their callbacks (fallback timers
  cover it).
- Per-WebView memory cost; all budgets in Step 17 are targets.
- DWM thumbnails of minimized or UWP windows.
- `tauri build --debug --no-bundle` flag spelling on CLI 2.12.
- Versions of `gsap`, `@gsap/react`, `vitest`, `jsdom`, `png`, `zip`
  (not researched; confirm with `npm view` / `cargo search`).
- Rust crate versions in Section 5.5 came from docs.rs (crates.io was
  unreachable during research).
- Nothing in this plan was compiled; every signature is a specification.

---

## 19. Sources

Tauri and WebView2
- https://v2.tauri.app/release/tauri/ · https://github.com/tauri-apps/tauri/releases
- https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html · https://docs.rs/tauri/latest/tauri/window/struct.Window.html
- https://v2.tauri.app/reference/config/ · https://v2.tauri.app/reference/acl/capability/ · https://v2.tauri.app/security/capabilities/ · https://v2.tauri.app/security/scope/
- https://v2.tauri.app/learn/window-customization/ · https://v2.tauri.app/develop/tests/mocking/
- https://github.com/tauri-apps/tauri/issues?q=is%3Aissue+is%3Aopen+label%3A%22scope%3A+unstable+flag%22
- https://github.com/tauri-apps/wry/blob/dev/src/webview2/mod.rs · https://docs.rs/wry/latest/wry/enum.PermissionKind.html
- https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/windows/window_state.rs · https://v2.tauri.app/release/tao/v0.37.1/
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model · https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance
- https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MemoryUsageTargetLevel.md
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2downloadstartingeventargs
- https://docs.rs/tauri/latest/tauri/webview/enum.DownloadEvent.html
- https://github.com/MicrosoftEdge/WebView2Feedback/issues/1479 (file chooser interception)
- https://v3.tauri.app/start/migrate/from-tauri-2/ (v3 is alpha; not used)

Win32 shell
- https://raw.githubusercontent.com/cairoshell/ManagedShell/master/src/ManagedShell.WindowsTasks/TasksService.cs
- https://raw.githubusercontent.com/cairoshell/ManagedShell/master/src/ManagedShell.WindowsTasks/ApplicationWindow.cs
- https://github.com/cairoshell/ManagedShell/blob/master/src/ManagedShell.AppBar/AppBarManager.cs
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registershellhookwindow
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-systemparametersinfow
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-minimizedmetrics
- https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmregisterthumbnail
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-exitwindowsex
- https://learn.microsoft.com/en-us/windows/win32/nativewifi/wi-fi-access-location-changes
- https://learn.microsoft.com/en-us/windows/win32/wmicoreprov/wmisetbrightness-method-in-class-wmimonitorbrightnessmethods
- https://devblogs.microsoft.com/oldnewthing/20240919-00/?p=110283 (non-activating windows)

Files and viewers
- https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
- https://github.com/bytecodealliance/cap-std
- https://osv.dev/vulnerability/GHSA-28m8-9j7v-x499 (Tauri 1.x scope bypass through junctions)
- https://support.microsoft.com/en-us/office/blocked-attachments-in-outlook-434752e1-02d3-4e90-9124-8b81e49a8519
- https://doc.rust-lang.org/std/process/struct.Command.html
- https://github.com/advisories/GHSA-wgrm-67xf-hhpq (PDF.js CVE-2024-4367) · https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions
- https://www.chromium.org/audio-video/
- https://docs.sheetjs.com/docs/getting-started/installation/frameworks
- https://github.com/VolodymyrBaydalka/docxjs/releases
- https://www.w3.org/WAI/ARIA/apg/patterns/grid/ · https://www.w3.org/WAI/ARIA/apg/patterns/listbox/
