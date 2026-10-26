# Rulebox v1 — Phase Plans

Each phase gets its own detailed plan file in this folder before work
starts. Phases 2 and 3 can run in parallel (they meet only at the IPC
contract).

| # | Plan file | Status | One-line description |
|---|---|---|---|
| 1 | `phase-1-setup.md` | ✅ Done (reviewed) | Monorepo skeleton: dashboard, Staff App, Convex schema and shared design system, all running empty |
| 2 | `phase-2-agent-core.md` | ✅ Done (VM-verified on Windows 11 Pro 26300, results in `phase-2-vm-results.md`; three late fixes are unit-tested only and need a re-check on the next VM run: exit-hold timing, kill-on-close job, `recover` for LSA auto sign-in owners) | Rust Windows service: enrollment code, Staff account, auto sign-in, shell replacement, watchdog and agent↔shell IPC |
| 3 | `phase-3-staff-shell.md` | In progress (awaiting VM run): Steps 1-17 done (Step 17 numbers in `phase-3-step17-results.md`: budgets met, logo targets met, accessibility pass with 83 new tests; browser flags measured but not enabled); Step 19 workspace checks pass (typecheck, lint, clippy, 1000+ tests); Step 18 (VM checklist 12.2) partly run, rest waits for a VM run; Step 19 closes only after that. Extras done: Windows-key hook helper, paged colourful app tiles, floating taskbar, navy dark theme, Documents/Desktop/Downloads redirect (VM-checked on sign-in) | Staff App as the shell: sign-in, desktop, taskbar, Start menu, window tracking, web app windows, file explorer and viewers |
| 4 | `phase-4-dashboard-state.md` | In progress: Section 21 answered (recommended options; Q3, Q4 deferred); dashboard UI on fixtures done; Steps 1-3 (tooling, schema v2 + wrappers, member accounts + MFA) done; Step 4 next. Step 15 waits for Phase 3 Step 19 | Dashboard and desired state: devices, employees, groups, apps, remote installs, Convex Auth, policy signing and audit log |
| 5 | `phase-5-lockdown.md` | Partly written 2026-10-27 (Sections 1-3 and a 24-step outline; the rest is pending, see the file) | Lockdown hardening and Section 24 features: layered Staff policies, AppLocker (Staff only), App Control, process watchdog, web app permissions, Wi-Fi/printers, rollout rings, device lock; pass the escape checklist |
| 6 | `phase-6-installer-pilot.md` | Not written | MSI installer with compatibility check, Lite mode tuning, and a pilot on a real 4 GB laptop, then a small group |

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