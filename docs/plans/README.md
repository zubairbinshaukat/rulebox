# Rulebox v1 — Phase Plans

Each phase gets its own detailed plan file in this folder before work
starts. Phases 2 and 3 can run in parallel (they meet only at the IPC
contract).

| # | Plan file | Status | One-line description |
|---|---|---|---|
| 1 | `phase-1-setup.md` | ✅ Done (reviewed) | Monorepo skeleton: dashboard, Staff App, Convex schema and shared design system, all running empty |
| 2 | `phase-2-agent-core.md` | ✅ Done (VM-verified on Windows 11 Pro 26300, results in `phase-2-vm-results.md`; three late fixes are unit-tested only and need a re-check on the next VM run: exit-hold timing, kill-on-close job, `recover` for LSA auto sign-in owners) | Rust Windows service: enrollment code, Staff account, auto sign-in, shell replacement, watchdog and agent↔shell IPC |
| 3 | `phase-3-staff-shell.md` | ✅ Done pending laptop-only checks (closed 2026-11-01 by the owner; report in `phase-3-final-report.md`): Steps 1-19 done (Step 17 numbers in `phase-3-step17-results.md`: budgets met, logo targets met, accessibility pass with 83 new tests; browser flags measured but not enabled); Step 18 VM run done on Hyper-V Windows 11 Pro 26300 with the owner's go-ahead (record in `phase-3-step18-progress.md`); Step 19 workspace checks run 2026-11-01 (typecheck, lint, 523 Staff App tests, 822 Rust tests pass; clippy clean except one Phase 4 test file, see the final report). Deferred to the real laptop: second monitor, sleep/resume, touch keyboard, brightness/volume sliders, camera/download/two-employee web logins on a second PWA, and the items of `VM-CHECKLIST-3.md` the owner did not run. Extras done: Windows-key hook helper, paged colourful app tiles, floating taskbar, navy dark theme, Documents/Desktop/Downloads redirect (VM-checked on sign-in) | Staff App as the shell: sign-in, desktop, taskbar, Start menu, window tracking, web app windows, file explorer and viewers |
| 4 | `phase-4-dashboard-state.md` | In progress (updated 2026-11-01): Section 21 answered (recommended options; Q3, Q4 deferred); post-Phase-5 I/O amendments A1-A22 applied to Steps 5-22 (2026-10-27); Steps 1-4 (tooling, schema v2 + wrappers, member accounts + MFA, dashboard foundation) done; Step 5a (step-up authentication) backend and dashboard UI done (fc8c432, 43a4b0b); Step 5 (org settings, exit PIN, groups) backend and dashboard screens done (a18a292), group assignments and group members not wired live until Steps 10 and 11; Step 6 (enrollment codes) backend and live Enrollment screen done (7d714af, 0820a9c); Step 7 (devices) backend done, widen migration run on dev (narrow step pending), dashboard Devices screens being wired live now; not started: Steps 8, 9, 10, 11, 12, 13 (agent seams only), 14, 16, 17, 18 (partial: matrix.test.ts only), 19, 20, 21, 22; Step 15 not started (its wait for Phase 3 Step 19 is over, Phase 3 closed 2026-11-01) | Dashboard and desired state: devices, employees, groups, apps, remote installs, Convex Auth, policy signing and audit log |
| 5 | `phase-5-lockdown.md` | Coding done (Steps 0-20b committed locally, last commit 7ce87ba, pushed 2026-11-19); owner VM runs (Steps 21-22) and Step 23 pending. Written 2026-10-27 (24 steps, 74-row escape checklist, 61 edge cases; open questions Q1-Q13 answered 2026-10-27, all recommended) | Lockdown hardening and Section 24 features: layered Staff policies, AppLocker (Staff only), App Control, process watchdog, web app permissions, Wi-Fi/printers, rollout rings, device lock; pass the escape checklist |
| 5b | `post-phase-5-architecture-and-io.md` | Written 2026-10-27 (I/O model and rules, plan limits, pooled multi-tenancy, operator console, file storage pool, amendments A1-A22; owner answered Q1-Q4, Q6, Q7 and added step-up auth; A1-A22 folded into Phase 4; all I/O numbers are estimates until measured) | Hosted-service architecture: database I/O budget, per-organization keys, operator console (separate control plane), storage pool |
| 6 | `phase-6-installer-pilot.md` | In progress (2026-11-21): Steps 8, 11 (9c6e2e1), 12 + 16 (0172e87), 12 dashboard part + 13 + 19 (next commit) done on the dev PC, VM checks pending; Step 19 Lite wallpaper not built (no wallpaper pipeline); Step 21 skipped (Q1 = a); left: Step 2 VM spike (blocks 15, 17), 9 CI, 14, 18, 20, VM runs 22-24, 25-28. Earlier: Step 3 done (73eb607), Step 1 done (PRD edits: owner approved all Section 18 rows 2026-11-19, applied to `docs/prd.md`; Section 21.1 untouched), Steps 4, 5, 6 committed (39ca02e, 94d63ad, 8a840a8); Step 7 (MSI sources in `apps/installer/`, static test `pnpm test:installer`, 33 tests) committed locally 2026-11-20, never run through WiX (a real build is CI Step 9 / VM Step 22); Step 11 (agent engine: versions, modes, windows, rollback) done pending VM checks, uncommitted 2026-11-21 (the `apps.updating` event and sign-in hold go to Step 17/18); Step 16 (browser web apps: server and dashboard) done 2026-11-21, uncommitted (convex + dashboard component tests only, never looked at on a running screen; allowed sites of a Chrome/Edge program are stored on the server but not yet in the device document, a Step 17 item); Step 12 (server feed resolver: `convex/feeds.ts`, `convex/lib/feed/*`, hourly cron, Approve / Dismiss / Pause / Check now; 39 tests in `convex/feeds.test.ts`) done 2026-11-21, uncommitted (dashboard buttons and status line not built; the 100 MiB measurement on the dev deployment is still to do, the cap stays 512 MiB until then); other steps not started or on a paused branch (`refs/backup/phase6-wip`). Written 2026-11-14 (29 steps 0-28, 80 edge cases, browser checklist B-01..B-24; owner decisions D-a..D-h in Section 17; owner accepted every Section 19 recommendation 2026-11-14 (Q13 Zahras POS confirmation still due before Step 23)) | MSI installer (WiX v7, SignPath) with compatibility check, Lite mode tuning, release guard, per-app update modes (pinned / vendor / server-managed feed), wizard installers and drivers, web apps in Chrome/Edge, pilot on a real 4 GB laptop then a small group |
| C | `operator-console.md` | Plan written 2026-11-21 (Fable research; 13 proposed changes PC-1..PC-13 and 14 owner questions open; build after the Phase 6 pilot) | Owner console at `admin.<domain>`: entitlement registry, plans as data, safe change requests for non-technical staff, own Convex team, Cloudflare Access + passkeys |
| W | `website-nextjs.md` (+ `../website/story-and-copy.md`) | Plan written 2026-11-21 (Fable research of 13 real product sites; 15 owner questions open; no visual design yet) | Public Next.js site on the main domain, hosted on Cloudflare: story, use-case pages, SEO, MDX blog and `/docs`, download page |

## Answers to the plans' open questions (13 October 2026)

Applied to `phase-3-staff-shell.md` on 2026-10-13 (P3, P7 and P9 changed the
text; the rest matched). Phase 2 is done and its answers matched the plan.

| Plan | Question | Answer |
|---|---|---|
| 2 | Q1 device auth to Convex | Device secret now; proper auth in Phase 4 |
| 2 | Q2 `devices.status` / `lastSeen` | Fix now: move to a `deviceStatus` table |
| 2 | Q4 Staff account name | `RuleboxStaff` |
| 2 | Q5 "Disable kiosk" on Windows | Stop auto sign-in, restore originals, give Staff normal Windows, keep account and files |
| 2 | Q8 who relaunches the Staff App | The launcher; the agent is the backup |
| 2 | Q11 device revoked remotely | Stay locked, stop syncing; never unlock remotely |
| 2 | Q12 kiosk on right after enrollment | Yes |
| 2 | Q15 test VMs | Windows 11 Pro on Hyper-V first; Home later |
| 3 | P1 sign-in through the agent | Yes |
| 3 | P2 hidden exit on the launcher fallback screen | Yes |
| 3 | P3 default exit combination | **Ctrl + Shift + F12** (differs from the plan) |
| 3 | P4 delete | Trash folder inside the employee's folder |
| 3 | P7 Windows key opens Start | **Yes** (differs from the plan) |
| 3 | P9 employee light/dark theme switch | **Yes** (differs from the plan) |
| 3 | P10 remember last employee | Yes |
| 3 | P11 Wi-Fi | Status only |
| 3 | P12 employee Lock | Yes |
| 3 | P13 second monitor | Blank |
| 3 | P14 agent side of protocol 1.1 | Phase 2 addendum; real backend in Phase 4 |
| 2 | 1.1: demo employees on a real agent | Allowed only when `agent-config.json` asks for it and the test-machine marker is present |
| 2 | 1.1: broken PIN hash from the dashboard | Fail closed: the exit turns off until a valid PIN arrives |
| 2 | 1.1: kiosk returns after an admin exit | Re-arm when an administrator signs in, after 5 minutes, or at agent restart |
| 2 | 1.1: launcher IPC | Reuse the `rulebox-ipc` client (tokio allowed in the launcher) |

All other open questions: the plan's recommendation stands.
