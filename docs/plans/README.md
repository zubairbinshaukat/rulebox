# Rulebox v1 — Phase Plans

Each phase gets its own detailed plan file in this folder before work
starts. Phases 2 and 3 can run in parallel (they meet only at the IPC
contract).

| # | Plan file | Status | One-line description |
|---|---|---|---|
| 1 | `phase-1-setup.md` | Implemented — awaiting user review | Monorepo skeleton: dashboard, Staff App, Convex schema and shared design system, all running empty |
| 2 | `phase-2-agent-core.md` | Not written | Rust Windows service: enrollment code, Staff account, auto sign-in, shell replacement, watchdog and agent↔shell IPC |
| 3 | `phase-3-staff-shell.md` | Not written | Staff App as the shell: sign-in, desktop, taskbar, Start menu, window tracking, web app windows, file explorer and viewers |
| 4 | `phase-4-dashboard-state.md` | Not written | Dashboard and desired state: devices, employees, groups, apps, remote installs, Convex Auth, policy signing and audit log |
| 5 | `phase-5-lockdown.md` | Not written | Lockdown and Section 24 features: App Control, process watchdog, policies, web app permissions, Wi-Fi/printers, rollout rings, device lock; pass the escape checklist |
| 6 | `phase-6-installer-pilot.md` | Not written | MSI installer with compatibility check, Lite mode tuning, and a pilot on a real 4 GB laptop, then a small group |
