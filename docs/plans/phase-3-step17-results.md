# Phase 3, Step 17: measurements (2026-10-27)

Machine: the dev laptop (Windows 11, 15.6 GB RAM, 144 Hz display), **debug**
build of the Staff App in dev mode against `DemoAgent`, Standard mode (not
Lite). Memory is the private working set of `rulebox-staff.exe` and all its
WebView2 processes (what the dev monitor shows; also written to
`metrics.jsonl` next to the log). Each figure is the mean of the last 10 s of
a 20 s settle. Single runs, so read differences under about 10 MB as noise.
The two builds ran back to back under the same conditions (other programs
were running, so absolute numbers are a little high).

## Budget table (dev machine, Standard)

| Scenario | Budget | Before | After |
|---|---|---|---|
| Sign-in screen idle | ≤ 300 MB | 221 MB | **178 MB** |
| Desktop idle, no apps | ≤ 350 MB | 229 MB | **198 MB** |
| + file explorer | ≤ 520 MB (with one PDF) | 265 MB | **229 MB** |
| Files window minimized | (no budget) | 262 MB | **218 MB** |
| One web app (example.com) on top of the desktop | (≤ 900 MB for two) | ≈ 107 MB, 6 processes | unchanged |
| Idle CPU, desktop visible | < 1 % | 0.5 % | **0.5 %** (includes the 2 s monitor sampling itself) |

Not measured: PDF open, two web apps with one minimized, cold start time,
task-button reaction time, anything in Lite on a 4 GB machine. Those belong
to the VM run.

## What changed the numbers

Backdrop blobs without `filter: blur(120px)` and no `backdrop-filter` in the
transparent popup and taskbar pages (GPU process), a hidden popup and
minimized windows (`SetIsVisible(false)` + `MemoryUsageTargetLevel` Low),
lazy route chunks per shell window. App icons no longer travel in every
state broadcast; with the demo's three tiny icons this shows no memory
difference, but a real catalogue sent every icon (up to 256 KB each) to
three windows on every change.

## Logo frame meter (full motion and Lite, 1280×800 and maximized)

Through `useLogoSequence` in the debug logo bench (`VITE_RB_BENCH=1`,
`RULEBOX_BENCH_LOGO=1`). Targets: average ≤ 18 ms, worst ≤ 50 ms, ≤ 3 frames
over 32 ms.

| Animation | Frames | Average | Worst | Over 32 ms |
|---|---|---|---|---|
| splash, full | 541 / 529 | 7.0 / 7.2 ms | 14.1 / 27.8 ms | 0 / 0 |
| loading (10 s), full | 1526 / 1502 | 6.9 / 7.1 ms | 13.8 / 34.7 ms | 0 / 1 |
| open, full | 343 / 355 | 7.2 / 6.9 ms | 14.1 / 7.2 ms | 0 / 0 |
| lock, full | 476 / 467 | 7.1 / 7.2 ms | 14.3 / 21.0 ms | 0 / 0 |
| all four in Lite (fade) | 105–1514 | 6.9–7.1 ms | 7.2–20.8 ms | 0 |

(first number: window, second: maximized). All targets met; `logo-motion.css`
and `LogoMotion.tsx` untouched. In Lite and with the fade level both
`onCovered` and `onDone` arrive, from the animation's callback first and the
fallback timer right after (the log says which). Not measured: real OS
reduced-motion setting (the fade path was exercised through Lite), 1366×768
exactly, a non-144 Hz display.

## Browser flags tried (not enabled)

Measured on the shell windows through `RULEBOX_BROWSER_ARGS` (debug builds):

| Flag | Desktop idle | Processes | Note |
|---|---|---|---|
| none | 205 MB | 10 | |
| `--in-process-gpu` | 163 MB (−42) | 9 | a GPU crash would take the whole browser process, so every shell window |
| `--process-per-site` | 175 MB (−30) | 7 | shell windows and built-in windows share one renderer: one hang or crash takes them all |
| `--enable-low-end-device-mode` | 197 MB (−8) | 10 | |
| `--disable-gpu` | 135 MB | 10 | CPU 2.5–3.3 % with the Files window: not acceptable |

For one web app window `--in-process-gpu` saved 17 MB of 107 MB. None is
enabled, because the budgets are met without them and a kiosk shell should
not trade crash isolation for 30–40 MB. If the VM run on a 4 GB machine shows
memory pressure, `--process-per-site` is the first one to try for Lite only.
(Earlier runs that used the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
environment variable changed nothing: Tauri's own arguments win.)

## Other Step 17 checks

- Bundles: `shell` entry 147 kB → 2 kB plus per-window chunks (taskbar 50 kB,
  popup 29 kB, desktop in the entry's lazy chunk); viewers stay lazy
  (`PdfViewer` 492 kB, `DocxViewer` 203 kB, xlsx worker 364 kB load only when
  used). No GSAP Flip outside the taskbar.
- Timers when idle: `ui_alive` every 5 s (desktop only), a minute-aligned
  clock in the taskbar and desktop; the sign-in screen now ticks once a
  minute (once a second only during a lockout countdown).
- Accessibility: see the Step 17 commit; 83 new tests, axe clean in jsdom.
  Not seen on screen: focus rings, Narrator, 200 % zoom, focus return between
  the popup and the taskbar (VM).
- Desktop covered by a maximized window: the Low memory request fires
  (logged `desktop page covered by a program window`); its saving is too
  small to separate from noise on this machine.

## VM run (2026-10-27, headless; Windows 11 Pro build 26300, 4 GB RAM, 2 vCPU, 1024×768, software rendering)

The debug build as the real shell with the real agent (`IpcAgent`), driven with synthetic mouse and keys from the host,
read through the log, `metrics.jsonl` and VM screenshots (only the VM screen, no host screen).

| What | Result |
|---|---|
| Staff App tree at the sign-in screen | **103–105 MB**, 10 processes, CPU 0–0.4 % (Lite budget ≤ 220 MB) |
| Signed in, desktop idle | **≈ 120 MB** |
| + Files window | ≈ 152–158 MB; back to ≈ 120 MB when closed |
| Files maximized | log: `desktop page covered by a program window covered=true` (the call works in shell mode) |
| Windows key alone | opens Start (the popup that was hidden while closed shows again, correctly placed) |
| Boot after a deploy | sign-in screen with the Windows-key hook installed, known folders restored |
| Keyboard focus ring (new `--rb-focus`) | visible on the password field and on the Start search |

Found and fixed during the run: at 1024 px the tray pill slid over the middle (apps) pill, hiding the task buttons.
The taskbar grid now keeps the side pills at their content width and lets the middle pill give way.

Not done in this run (still open for checklist 12.2): Alt+Tab and Ctrl+Esc, sign-out restore of the known folders,
Notepad Save-As, DPI 125/150 %, second monitor, sleep, touch keyboard, toast notices, web apps and a PDF in the VM,
Narrator, 200 % zoom. The three Phase 2 fixes that are unit-tested only are also still open.
