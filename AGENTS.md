# Rulebox: instructions for coding agents

This file is for any coding agent (Cursor, Codex, Claude Code, ...). The
project rules live in **`CLAUDE.md`**. This file only points to them and
repeats the few rules that must never be missed. If the two ever disagree,
`CLAUDE.md` wins.

## Read first, in this order

1. `CLAUDE.md`: all of it. It is binding.
2. `docs/plans/README.md`: which phase is current. **Phase 2 is done; the
   current phase is Phase 3.**
3. `docs/plans/phase-3-staff-shell.md`: the plan. Read the "Updates since
   this plan was written" block first. Follow the steps in order; every step
   ends with a **Done when** check you must see pass before moving on.
4. `docs/plans/phase-2-agent-core.md`, Section 6.11 (protocol 1.1 wire
   shapes) and Section 12 ("Changes Phase 3 must pick up").
5. `docs/prd.md`: only the sections a step names. Section 21 is locked; do
   not reopen a decision. If code and PRD disagree, ask.

## Never

- **Never run anything destructive on this machine.** That means creating,
  changing or deleting a Windows account; writing Winlogon, policy or LSA
  values; loading another user's registry hive; signing a session out;
  installing or removing the Rulebox service; and running
  `rulebox-agent enroll`, `recover`, `unenroll` or `service install` for
  real. All of that runs only on the test VM, and only the user runs it.
- **Never create the test-machine marker**
  (`HKLM\SOFTWARE\Rulebox\TestMachine`), on any machine.
- **Never edit what Phase 2 owns** from a Phase 3 step: `apps/agent`,
  `apps/shell-launcher`, `crates/rulebox-ipc`, `crates/rulebox-win32`. The
  IPC contract is frozen at 1.0 + 1.1. If Phase 3 needs a change there,
  stop and write it down for the user (Section 15 of the Phase 3 plan).
- **Never put an admin right in the Staff App.** It runs as a standard
  user. Every privileged action goes through the agent over IPC. A UAC
  prompt in the Staff session is a bug.
- **Never log or store a password, PIN, PIN hash, device secret or
  enrollment code.**
- **Never load anything from a CDN, Google Fonts or an icon API at
  runtime** (offline-first). Icons: Solar only.

## Git

- Commit as the repository's own identity (`user.name` / `user.email`).
  Never change git config.
- **No AI attribution anywhere**: no `Co-Authored-By` trailer, no
  "Generated with ..." line, in commits, PRs, issues or tags.
- One commit per plan step, message `Phase 3 step N: <what>`.
- **Never push and never open a PR** without the user's explicit go-ahead.

## Working here

- Windows 11, PowerShell. Use **pnpm** (never npm or yarn). One Cargo
  workspace and one `target/` at the repo root; debug builds only. Disk is
  tight: warn the user before a step that builds several GB.
- Build against the **simulated agent**, not the real one:
  `cargo run -p rulebox-agent -- run --console --simulate --sim-demo --sim-staff-session`
  (protocol 1.1 is live there: demo employees, apps, admin exit; the
  admin-exit PIN in the demo is `2468`).
- Verify before you say "done": Rust `cargo clippy -p <crate> --all-targets
  -- -D warnings` and `cargo test -p <crate>`; TypeScript `pnpm typecheck`
  and `pnpm lint`; UI: run it and look at it (screenshots are part of the
  step's Verify list).
- Unit tests passing is necessary, not enough: the Phase 2 VM run found
  eight defects that no unit test did. Say plainly what you could not
  verify.
- If a step's Done-when check fails twice after honest fixes, stop and ask.
