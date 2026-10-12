# Rulebox v1 — Phase Plans

Each phase gets its own detailed plan file in this folder before work
starts. Phases 2 and 3 can run in parallel (they meet only at the IPC
contract).

| # | Plan file | Status | One-line description |
|---|---|---|---|
| 1 | `phase-1-setup.md` | ✅ Done (reviewed) | Monorepo skeleton: dashboard, Staff App, Convex schema and shared design system, all running empty |
| 2 | `phase-2-agent-core.md` | Plan written | Rust Windows service: enrollment code, Staff account, auto sign-in, shell replacement, watchdog and agent↔shell IPC |
| 3 | `phase-3-staff-shell.md` | Plan written | Staff App as the shell: sign-in, desktop, taskbar, Start menu, window tracking, web app windows, file explorer and viewers |
| 4 | `phase-4-dashboard-state.md` | Not written | Dashboard and desired state: devices, employees, groups, apps, remote installs, Convex Auth, policy signing and audit log |
| 5 | `phase-5-lockdown.md` | Not written | Lockdown and Section 24 features: App Control, process watchdog, policies, web app permissions, Wi-Fi/printers, rollout rings, device lock; pass the escape checklist |
| 6 | `phase-6-installer-pilot.md` | Not written | MSI installer with compatibility check, Lite mode tuning, and a pilot on a real 4 GB laptop, then a small group |

## Answers to the plans' open questions (13 October 2026)

Not yet applied to the plan files. Apply these before starting the phase.

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

All other open questions: the plan's recommendation stands.