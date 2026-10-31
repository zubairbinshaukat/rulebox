# Phase 3 Step 18: progress log (VM run as the real shell)

Written 2026-10-31. Nothing here is committed. The to-do list for the user is `VM-CHECKLIST.md` (repo root); this file
is the record of what is done.

## State of the VM `rulebox-test-pro`

- Checkpoint `before-step18` taken (VM was off, clean). Older checkpoints: `fresh-windows-11-pro`,
  `before-phase2-vm-run`, `before-phase3-vm-run`.
- Round 2 build deployed with `scripts\vm-deploy.ps1 -FixtureDirectory` from `C:\rb-deploy` inside the VM (files staged on
  the host in `%TEMP%\rb-stage`). Deployed `rulebox-staff.exe` is 24,932,352 bytes. Agent online, enrolled, kiosk enabled.
- The test-machine marker already existed in the VM; Claude never creates it.
- Sample files exported by the agent to `%ProgramData%\Rulebox\fixture-samples\` and copied (robocopy) into
  `C:\Users\RuleboxStaff\RuleboxFiles\emp_maya\`.
- Helper scripts in the VM: `C:\rb-deploy\tools\status.cmd`, `junction.cmd`, `toast.ps1`.
- Re-deploy recipe (host, elevated): build (`pnpm --filter @rulebox/staff-app tauri build --debug --no-bundle`,
  `cargo build -p rulebox-agent -p rulebox-shell`, `cargo build -p rulebox-ipc --example fake_staff --features client`),
  copy the four exes + `scripts\vm-deploy.ps1` to `%TEMP%\rb-stage`, `Copy-Item -ToSession` into `C:\rb-deploy`, then in
  the VM `logoff 1` (the old shell locks the files) and run `vm-deploy.ps1 -FixtureDirectory`, then restart the
  `RuleboxAgent` service once (fixture samples are exported at agent start).
- Driving the VM: PowerShell Direct with `D:\work\hypervisor\rbtest.cred.xml`.

## Verified by Claude from the host

- `rulebox-agent status`: `shell : healthy`, `connection : online`.
- Freeze test (NtSuspendProcess on the Staff process): the agent replaced it after **27 s** (target about 30 s).
- Stopping and starting the `RuleboxAgent` service leaves the Staff processes running; the service restarts cleanly.
- The VM has working DNS and HTTPS to `zubyr.dev` (web apps failed in round 1 only because the fixture domains were fake).
- The "freeze UI" button is a dev-only overlay (Ctrl+Shift+D) and is not in `--debug --no-bundle` builds.

## Passed by the user in round 1

Start-up splash and sign-in within 4 s; kill and restart of the Staff process (about 2 s); taskbar position and
work area; minimized windows; taskbar entries for apps, second windows and dialogs; task button focus/minimize/restore;
Alt+Tab switcher; Ctrl+Esc does not open Start; Windows key alone opens Start; typing and antivirus; Notepad File > Open
shows Documents; sign in online/offline and sign out; tiles and desktop app launch; log out closes apps; lock and unlock;
explorer shows only the employee folder; trash, restore, empty trash and quota bar.

## Fixes made after round 1 (code only, not yet seen on screen)

| Finding | Root cause | Fix (files) |
|---|---|---|
| "Try again in NaN:NaN" | `SignInOutcome`, `VerifyOutcome`, `AdminExitOutcome` serialized fields in snake_case (`retry_after_ms`) | `rename_all_fields = "camelCase"` in `src-tauri/src/model.rs`; tests in `step17_tests.rs`, `SignIn.test.tsx`, `shell/a11y.test.tsx` |
| Splash over the lock card | `LockScreen.tsx` drew the lock `LogoMotion` over the card for ~3 s | Overlay removed from `LockScreen.tsx` (deviates from plan 7.6 "on entry"; plan/PRD needs a one-line update) |
| Logout confirm not centered | `popup_open` in `shellwin.rs` fell back to the bottom-left rect for an unanchored confirm | Uses `placement::centered_rect` |
| Exit dialog square frame | `exit.rs` window not transparent, shadow on; page wrapper painted `--rb-bg` with padding | `.transparent(true)`, `.shadow(false)`, `rb-page-transparent` on `<html>` in `exit/main.tsx`, transparent wrapper in `AdminExit.tsx`; PIN label and hint (`exit/logic.ts`). Demo PIN `2468` |
| Taskbar transparent gaps swallow clicks | `shell-taskbar` is one 84 px window | `SetWindowRgn` clipped to the pills (`crates/rulebox-desktop/src/windows.rs::set_shape`, `placement.rs`), `taskbar_shape` command, `useTaskbarShape.ts` |
| Volume / brightness missing, poor dialog | `volume` is null with no audio endpoint (VM); brightness hidden on failure | `QuickSettings.tsx` rewritten: disabled volume row with message, brightness only when reported, Network status row, Wi-Fi note (status only per plan P11), `useThrottledValue.ts`; `SystemArea.tsx` hides the volume chip with no device |
| `.exe` visible in side panel, hidden elsewhere | `fs_files` kind `All` accepted every name | One rule `is_blocked_name` in `src-tauri/src/files/types.rs` used by `opener_for`, `FileKind::matches`, downloads; `svg` removed from image lists; folder view still lists the file (opening is refused) |
| Web apps could not load | Fixture domains were fake | `apps/agent/src/fixtures.rs`: Zubyr (`zubyr.dev`, camera denied), Example (`example.com`, camera allowed), Notepad, "System Configuration" (`msconfig.exe`, requires admin); old Orders/Mail removed |
| No sample files for the viewers | n/a | Six real sample files in `apps/agent/assets/fixture-samples/` (about 112 KB), exported by the agent on a marked test machine; `Renamed program.png` is an `MZ` file for the rename test |

Checks run: `pnpm typecheck`, `lint`, `vitest` (40 files, 366 tests) for the Staff App; `cargo test/clippy` for
`rulebox-staff`, `rulebox-agent`, `rulebox-desktop`.

## Round 2 findings (owner, 2026-10-31 evening) and fixes (round 3 build on the VM, `rulebox-staff.exe` 25,244,160 bytes)

Passed in round 2 (owner): all viewers open correctly (mp4 plays and seeks), web apps Zubyr/Example load, Lock/unlock,
quick settings opens. Recorded, not bugs: toast from `toast.ps1` does not appear bottom-right (only the notification
list; Phase 5 note), `ms-settings:display` errors for the Staff account (use Claude to change scale from outside),
`status.cmd` needs admin (Claude runs status from the host), Task Manager runs anything (Phase 5).

| Finding | Root cause | Fix |
|---|---|---|
| Sign-in takes 60-160 s with no loading indicator | `FilesHub::sign_in` started the folder watcher with `notify_debouncer_full`'s default `FileIdMap` cache, which walks the tree with `follow_links(true)`. `junction-test` (junction to `C:\Windows`, left by `junction.cmd`) made it walk all of Windows on the sign-in worker (`open_files_ms=157573`). Not Convex (agent online), not serde, not the taskbar region | `files/quota.rs`: `new_debouncer_opt` with `NoCache`; test `files::quota::watch_tests`. After: `open_files_ms=1-3`, desktop in 3-8 s |
| Double-click a file freezes the UI (hover works, clicks dead), agent kills the app after 30 s, app restarts on sign-in | `open_doc` was a sync command, so window creation ran on the UI thread and waited in a nested WebView2 message loop forever | `open_doc` and `admin_exit_open` are now `async` + `blocking(...)` (`commands.rs`); test `commands::window_thread_tests::no_sync_command_builds_a_window`; debug-only probes in `monitor.rs`/`state.rs` ("UI thread has not answered for 2 s", `ui_alive` after 12 s) |
| Taskbar lags when Notepad opens; orange sliver outside the pill | Region shape sent from a rAF callback, throttled while the window is covered | `useTaskbarShape.ts` sends from the ResizeObserver callback, re-sends at 120/400 ms; test added |
| Dark theme: pale rim, "Rulebox" caption and window buttons through the pills | Taskbar window kept `WS_CAPTION`/system menu bits; DWM paints a caption once a region is set; 2 px margin exposed the window behind | `windows.rs::strip_caption` (also on every `set_shape`); `TASKBAR_SHAPE_MARGIN_LOGICAL = 0`; outer `box-shadow` removed from `.rb-dock` |
| Exit PIN `2468` said wrong, 1 try left | On a non-`--sim-demo` agent the PIN is `adminExit.pinHash` from the cached desired state (the dashboard PIN). `2468` is only for `--sim --sim-demo`. `lockouts.json` shows 4 failures; the next wrong PIN locks the exit for 60 s, then 5, 15, 30, 60 min | Nothing changed. Safest fix: set a new PIN in the dashboard (Settings, Admin exit); a new PIN gets a clean counter |
| No hover on My files rows (panel and explorer) | Inline backgrounds override CSS; `--rb-hover` almost equals `--rb-bg` | New classes in `packages/ui/src/components.css` (`rb-file-row`, `rb-file-card`, `rb-nav-btn`, `rb-crumb`, `rb-filter-btn`, `rb-panel-row`), test `hoverStyles.test.ts` |
| "Open with" missing | Shown only when `fileHandlers` maps the extension to a catalogue desktop app; the example state mapped only `.docx` to a missing app | `.txt` and `.csv` now map to `notepad` in `EXAMPLE_DESIRED_STATE_JSON` (`rulebox-policy`), the ipc golden JSON and `agent/demo.rs`. If the VM policy comes from Convex, map them on the dashboard File types screen |
| File could be renamed to `.exe` | `SafeRoot::rename` checked syntax only | `files/saferoot.rs`: `FileError::BlockedName`, applied to rename, copy, move, paste; message "Files ending in .exe aren't allowed on this PC." |
| mp4 fullscreen leaves the taskbar on top | Taskbar is its own always-on-top window | `fullscreen.rs` (`viewer_fullscreen` command, state machine with 7 tests) + `useFullscreenCover.ts`; restores on exit, close, crash (7 s watcher) and focus loss |
| Want to see animations on the VM (Lite mode on) | Lite disables motion | Debug-only "Force full motion" switch in the resource monitor popup (`lib/devMotion.ts`, `vite.config.ts` `envPrefix` includes `TAURI_ENV_`) |
| Zubyr tile/window generic icon | Fixture had no icon; Start menu and web window ignored icons | `apps/agent/assets/icons/zubyr.png` (180x180 apple-touch-icon from zubyr.dev, 3,832 bytes) embedded; `StartMenu.tsx` and `webapp/icon.rs` + `build_window` use it. Web windows keep the native title bar (plan 7.10, P6; PRD 4.4 wording disagrees) |

Round 3b (later the same evening), build `rulebox-staff.exe` 25,313,280 bytes on the VM:

| Item | Cause / change |
|---|---|
| Taskbar caption band ("Rulebox taskbar", window buttons, pale arc) came back after clicks | Clicking a taskbar button briefly activated the taskbar window, which painted a caption; tao also re-applies window flags (restores `WS_CAPTION`, drops `WS_EX_TOOLWINDOW`) without anything re-stripping them. Fix in `crates/rulebox-desktop/src/windows.rs`: window subclass (`guard_overlay_frame`) strips frame bits on `WM_STYLECHANGING`, forwards `WM_NCACTIVATE` with -1, swallows `WM_NCPAINT`, `MA_NOACTIVATE` for the taskbar; `shellwin.rs` guards taskbar (never activate) and popup. VM: 0 of 12 click cycles showed it (was 30-50%). Plan/PRD note: any transparent shell window needs this style guard |
| No Back / Forward / Reload in web apps | Injected closed-shadow-root pill (no extra WebView, no new command): `webapp/nav.rs`, `webapp/navbar.js`, hooks in `webapp/hooks.rs`/`mod.rs`; state from WebView2 `CanGoBack/CanGoForward`; keys Alt+Left/Right, F5, Ctrl+R via `AcceleratorKeyPressed`; no address bar; blocked redirects add one history entry (the blocked page) so Back returns to the linking page. Plan 7.10 table and Step 15 text updated. 31 new TS tests + 11 Rust tests. Open question: real toolbar via child webview later with the custom title bar |
| Batwa PWA | `batwa-web` fixture (`https://batwa.zubyr.dev`, icon `apps/agent/assets/icons/batwa.png` 180x180 from its apple-touch-icon, camera allowed, downloads and notifications default on). Per-employee web profiles are `%LOCALAPPDATA%\dev.rulebox.staff\web\<employeeId>` |

Round 4 (2026-10-31 night): taskbar pill lag and toasts.

| Item | Cause / change |
|---|---|
| Middle pill (apps) grew late, 1 to 4 s in the debug build and up to a minute in a release build | Measured on the VM with a screen-capture loop in the Staff session (about 46 fps) and timestamped notes from the page. The page showed the new pill within 10 ms of the window event and Rust applied the clip in 1 ms, but `useTaskbarShape` never sent it: its ResizeObserver watched only the pills that existed when the page loaded. Signed out, the start and apps pills are plain `<div />` placeholders, and React turns them into the pills in place after sign-in, so the child-list observer did not fire and nothing observed the apps pill. The clip followed only when the tray pill changed size (the monitor chip text, the clock). Not DWM, not the tracker, not throttling. The 3b "send from the observer callback" change could not help. Fix: `useTaskbarShape(bar, layoutKey)` re-arms the observers on sign-in/out; it returns `refresh`, called from a layout effect in `Taskbar.tsx` after every change of the button list, so the clip is sent before the browser paints. Result: the first presented frame after the window appears already has the full pill (about 60 to 120 ms after the window is visible on the slow VM, which is the page's own render and the 40 ms tracker settle). Tests in `useTaskbarShape.test.tsx` |
| Toasts | `shell/toast/` (`ToastHost`, `toastQueue`, `toastStore`, `toast.css`, `DevToastButtons`). Every `AppState::notify` shows a card; the bell list keeps them. Drawn in the taskbar window, no extra WebView. The window is now `TOAST_AREA_LOGICAL` (360) px taller than the strip (`placement::taskbar_window_rect`); its bottom edge is unchanged, and the region covers only pills and cards. Until the page reports its shape the bottom strip alone takes clicks (`clip_taskbar_to_strip`), and an empty report also falls back to the strip. Debug builds: `dev_toast` command and "Test toast" buttons in the resource monitor popup |

VM incident (mine): a forced `Restart-VM -Force` right after copying zeroed `current.json` and the tail of
`rulebox-staff.exe` (unflushed NTFS writes), which gave `kiosk=shell_binary_missing` and exit code 0xC0000005. Fixed by
rewriting `current.json`, re-copying the exes (SHA-256 verified against the host) and a graceful in-guest
`Restart-Computer`. Lesson: always reboot the VM gracefully after a deploy, and verify hashes.

Checks on the integrated tree: staff typecheck + lint clean, vitest 44 files / 388 tests, `cargo test` for
`rulebox-staff` (150 + 114), `rulebox-desktop`, `rulebox-agent` (358) all pass. Pre-existing failing test
`files::names::short_alias_tests` did not fail in this run.

VM leftovers: Maya's theme is Light; `C:\rb-claude\` holds helper scripts; `C:\rb-deploy\rulebox-staff.round2.exe`
is the previous exe; `junction-test` is still in `emp_maya` (kept for the junction check); the VM was rebooted 5 times
and no new checkpoint was taken (`before-step18` is still the clean one).

Other agent observations, not investigated: the Files window sometimes opens minimized/off-screen when My files is
launched from the desktop; the taskbar can show two "R" entries when a viewer and the Files window are both open.

## Findings that are not Phase 3 fixes

- **Task Manager reachable from Ctrl+Alt+Del / Ctrl+Shift+Esc:** by design until Phase 5 (PRD 9.5, 12.2). Add it to the
  Phase 5 escape checklist if missing.
- **Killed Staff App returns on the sign-in screen:** documented (plan edge-case row 37).
- **Explorer tabs:** not in the PRD; estimated 3 to 5 days; low RAM risk if tabs are in-memory view state.

## Open decisions (waiting for the owner)

1. After a crash, restore the signed-in desktop? Recommended: no (keep the plan's behavior).
2. Wi-Fi in quick settings: status only until Phase 5 (recommended) or pull a Wi-Fi UI forward.
3. Explorer tabs: separate small plan after Phase 3 closes (recommended) or now.

## Still to do

See `VM-CHECKLIST.md`. Step 19 closes only after the retests pass or each unticked item has a reason.

## Round 5 (2026-11-01): popups, Zahras POS, top bar, toasts, icon fill

| Item | What changed | Seen by the owner? |
|---|---|---|
| Popups transparent | `.rb-surface--popover` is solid (`var(--rb-surface)`), no backdrop blur; test `popupSurface.test.ts` | no |
| Zahras POS | Fixture catalogue now 7 apps (`zahras-pos-web`, `zahras-pos.vercel.app`, embedded icon) | no |
| Back / Forward / Reload | Replaced the floating pill by a 44 px top bar (`webapp/bar.*`, second WebView2, read-only address, empty `bar::ACTIONS` slot). Memory per window is an estimate (15-30 MB); measure on the VM, switch to a native Win32 bar if over about 40 MB | no |
| Pill not growing | `useTaskbarShape` re-arms observers and exposes `refresh`; `Taskbar` calls it in a layout effect | no |
| Toasts | Rulebox toast host at bottom-right (`shell/toast/`), taskbar window 360 px taller and clipped by a region; `dev_toast` + "Test toast" in the monitor | no |
| Icon fill | `iconAnalysis.ts` returns the logo bounds and background; `iconCutout.ts` crops to a square with a margin (later set to 3.5%, logo about 93% of the box), keys out the flat background without halo; `data-icon-fit` = `logo`/`inset`/`cover` in `AppArt` and `AppTile`; `webapp/icon.rs` crops the window icon the same way. Tests use the real shipped PNGs | screenshots only (agent, VM) |

Known leftovers: Z corner tips clip about 1 px at 26-34 px; window title-bar icon keeps its flat square (no rounded mask)
so Batwa's lavender shows faintly on a light title bar; Alt+Tab not screenshot in light theme (same code as dark).
VM state: staff exe SHA-256 `37C99F68DA5B474F6C51613BBD40FD0C4C50C3E8663EC8A5D58978EFE65629D3`; Maya's theme was set to
Light by writing `prefs.json` (was dark).

## Phase 3 close (2026-11-01)

The owner considered the VM checklist done and ended Phase 3 on 2026-11-01. Step 18 was run on the Hyper-V VM
(`rulebox-test-pro`, Windows 11 Pro 26300) with the owner's go-ahead; the record is this file. The final report is
`phase-3-final-report.md`.

Deferred to the real laptop (not run, not failed):

- Second monitor, sleep and resume, touch keyboard, working volume and brightness sliders (the VM has no audio or
  backlight device).
- Camera rule on a real camera; web downloads and two employees not sharing a web login on a second PWA that has a
  login (Batwa was only partly exercised in the VM).
- The items of `VM-CHECKLIST-3.md` the owner did not run (no results file was written; the owner ended the phase in
  chat, so every item without a note above is "not recorded", not "passed").
- Top-bar RAM per web window (VM-CHECKLIST-3 section 3b) was never measured: still an estimate of 15 to 30 MB.
- The three Phase 2 fixes that were unit-tested only (exit-hold timing, kill-on-close job, `recover` for LSA owners)
  stay open unless the owner or Claude ran them in Step 18 (not recorded here).

Added after the last round, for the record:

- New design tokens `--rb-logo-filter-dark` and `--rb-logo-filter-light` (in `tokens.css`, per theme): a CSS colour
  filter applied to a bare logo that would vanish on the theme (Zubyr's black Z is drawn light on dark). They replaced
  the short-lived `--rb-chip-for-*` plate tokens, which are gone.
- Icons are shown as a bare logo (no square plate): `iconCutout.ts` crops to the logo (3.5% margin, logo about 93% of
  the box), keys out the flat background and `recolorFor(luma)` picks the filter; `AppArt` and `AppTile` mark the
  choices with `data-icon-fit` and `data-icon-recolor`. `webapp/icon.rs` crops the window icon the same way onto
  transparent pixels. Seen on the VM (dark and light): tiles, taskbar, Start menu, Alt+Tab, window title bar.
  Not seen: a live theme switch without reboot, the native title bar under Windows dark mode.
