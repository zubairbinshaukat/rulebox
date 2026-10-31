# Phase 3 final report (2026-11-01)

Phase 3 (Staff App as the shell) is closed by the owner as "done pending laptop-only checks". Sources: the plan,
`phase-3-step17-results.md`, `phase-3-step18-progress.md`, `git log`, and the Step 19 runs of 2026-11-01. Anything I
could not find evidence for is marked (unverified) or "not re-verified".

## Step 19 checks (run 2026-11-01)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass (types, ui, dashboard, staff-app, convex) |
| `pnpm lint` | pass (dashboard, staff-app, convex) |
| `pnpm --filter @rulebox/staff-app test -- --testTimeout=30000` | pass, 54 files, 523 tests |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | **fails on one Phase 4 file**: `crates/rulebox-ipc/tests/hotkey_vectors.rs` lines 17-18 (`clippy::expect_used`, added by Phase 4 step 5). Phase 3 code is clean after the `webapp/icon.rs` fixes (`as_chunks`, `checked_div`; behaviour unchanged) |
| `cargo test --workspace --all-features` | pass, 822 tests, 4 ignored (`vm_lifecycle`, VM only) |
| `target\` size | 11.13 GB (debug only) |

Leftover checks: no `ShellExecute` call (one comment in `files/openwith.rs` says never to use it); no `web-*`
capability and no `remote` key (capabilities: `apps`, `exit`, `popup`, `shell`); `tauri` has no features and no
`unstable`; no `convex` import under `apps/staff-app`; every `~icons/` import starts with `~icons/solar/`. `unsafe`
outside the allowed files: only `webapp/barhost.rs` (see "Deviations"); every `unsafe` site there now carries a
`// SAFETY:` comment or a `# Safety` doc section. Raw colour literals in `apps/staff-app/src` (non-test): `#e8e6e1` and a shadow
in `viewers/docxFrame.ts` and `DocxViewer.tsx`, `#000` in `MediaPlayer.tsx`, `#fff` in `PdfViewer.tsx` (document and
video surfaces, not theme colours), `oklch(0.62 0.14 hue)` in `popup/Monitor.tsx` (computed hue), `rgb(...)` built from
pixels in `iconAnalysis.ts` (data, not design). `target\demo-files\` deleted.

## Done-when per step

| Step | Mark | Evidence |
|---|---|---|
| 0 Preflight | not re-verified | no record besides the commits |
| 1-16 | done (committed 2026-10; not re-verified one by one here) | commits `b1543ea` to `3deba75`, review-fix commits, plan index; today's typecheck, lint and tests pass |
| 17 Performance, Lite, logo, accessibility | done | `phase-3-step17-results.md`: budgets and logo targets met, 83 new accessibility tests |
| 18 VM run | done with deferrals | `phase-3-step18-progress.md`; rounds 1 to 5 on Hyper-V Windows 11 Pro 26300; deferrals listed in its "Phase 3 close" |
| 19 Wrap-up | done | this report; item 4 (screenshots in `docs/screenshots/`) not done because the owner did not ask |

## Versions pinned

Rust (`Cargo.lock`): tauri 2.12.3, tauri-build 2.7.2, tauri-plugin-single-instance 2.5.3, webview2-com 0.39.1, windows
0.62.2, cap-std 4.0.3, notify 8.2.0, notify-debouncer-full 0.7.0, png 0.18.1, zip 9.0.2, infer 0.22.0, csv 1.4.0.
JavaScript (`pnpm-workspace.yaml` catalog): @tauri-apps/api 2.12.3, gsap 3.15.0, @gsap/react 2.1.2,
@tanstack/react-virtual 3.14.17, pdfjs-dist 6.4.299, docx-preview 0.4.1, dompurify 3.4.17, vitest 5.0.4, jsdom 30.1.2,
@testing-library/react 16.3.3, axe-core 4.13.0, react ^19.3.0, vite ^8.3.4; xlsx 0.20.3 from the vendored tarball.
WebView2 runtime: 156.0.4314.50 on the dev machine; the VM's runtime version was not recorded (unverified).

## Budgets (dev machine, debug build, Standard mode; from `phase-3-step17-results.md`)

| Scenario | Budget | Measured |
|---|---|---|
| Sign-in screen idle | 300 MB | 178 MB |
| Desktop idle | 350 MB | 198 MB |
| + file explorer | 520 MB | 229 MB |
| Files window minimized | none | 218 MB |
| One web app (example.com) | (900 MB for two) | about 107 MB, 6 processes |
| Idle CPU, desktop | < 1 % | 0.5 % |

VM (4 GB, 2 vCPU, headless run of 2026-10-27): sign-in screen 103-105 MB (Lite budget 220 MB), desktop idle about
120 MB, with Files about 152-158 MB. Logo frame meter: all four animations average 6.9-7.2 ms, worst 34.7 ms, at most
1 frame over 32 ms, targets (18 / 50 / 3) met; Lite fade path also met. Not measured: PDF open, two web apps, cold
start time, 1366x768, non-144 Hz display, Lite on a real 4 GB laptop, top-bar RAM per web window (estimate 15-30 MB,
(unverified)).

## VM results

Windows 11 Pro 26300 on Hyper-V (`rulebox-test-pro`). Per-round passes, failures and fixes are in
`phase-3-step18-progress.md`. Round 1 passed: splash and sign-in within 4 s, Staff restart in about 2 s, taskbar and work
area, minimized windows, Alt+Tab switcher, Ctrl+Esc does not open Start, Windows key opens Start, lock, sign out, files
confinement, trash and quota. Round 2 passed: all viewers, Zubyr and Example web apps, lock/unlock. Freeze test: the
agent replaced a suspended Staff process after 27 s. Later rounds were fixed and rebuilt; the owner saw rounds 1 to 4 on
screen, round 5 (solid popups, Zahras POS, top bar, toasts, icon fill) only through agent screenshots. Activation rung:
not recorded in these files (unverified). Brightness as a standard user: the VM has no backlight, so not tested
(unverified). Agent modes used: demo (`DemoAgent`, dev machine), simulated (`--sim --sim-demo`), real (`IpcAgent` on
the VM); the real agent's capability list was not recorded (unverified).

## Deviations from the plan

- The web app top bar is a second WebView2 controller in the same window (replaced the injected pill).
- The taskbar window is 360 px taller than the strip so Rulebox toasts can be drawn; a region clips it to pills and cards.
- Web windows keep the native title bar plus the bar (plan 7.10 and P6); PRD 4.4 says "custom title bar": they disagree.
- tao undecorated shell windows need a style guard (`guard_overlay_frame`): any transparent shell window needs it.
- `.txt` and `.csv` map to Notepad in the example desired state (`rulebox-policy`, ipc golden JSON, `agent/demo.rs`).
- Fixture catalogue has 7 apps including Zubyr, Batwa and Zahras POS, with embedded icons.
- The lock animation no longer plays over the lock card (plan 7.6 said "on entry").
- Also in the progress file: exit dialog transparent, `is_blocked_name` rule for `.exe` in rename/copy/move,
  `fullscreen.rs` cover for video, Files watcher uses `NoCache` (junction walk), async `open_doc`, Windows-key hook helper
  process, Documents/Desktop/Downloads redirect, floating taskbar and navy dark theme.
- `webapp/barhost.rs` (the web-window top bar's second WebView2 controller) contains `unsafe` outside the three allowed
  locations; every block carries a SAFETY comment.
- Clippy: `webapp/icon.rs` was changed in Step 19 to satisfy `-D warnings` (no behaviour change).

## Open questions

- Top-bar RAM per window is unmeasured (switch to a native bar if over about 40 MB).
- Mirror Windows apps' toasts in Rulebox's toast host: Phase 5.
- Explorer tabs: separate small plan after Phase 3 (3 to 5 days estimated).
- `rbicon` protocol: does it need a CORS header? (unverified)
- The Files window sometimes opens minimized or off-screen when My files is launched from the desktop (not investigated).
- Two "R" taskbar entries appear when a viewer and the Files window are both open (not investigated).
- "Charging 100%" is partly hidden on the sign-in screen (not investigated).
- Restore the desktop after a crash (recommended no), Wi-Fi in quick settings (recommended status only).
- Fix `hotkey_vectors.rs` lint (Phase 4 owner).

## Handed to the owner

Plan Sections 15 (Requested changes to Phase 2), 16 (PRD changes to propose) and 17 (Open questions for the user).
`docs/prd.md`, `CLAUDE.md` and the Phase 2 plan were not edited. Nothing is committed or pushed.
