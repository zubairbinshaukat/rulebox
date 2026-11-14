# Phase 5 Step 0 - Preflight results

Run 2026-11-08 on the dev machine, read-only (plus `cargo check`). Nothing
was applied, no dependency added, VM not started.

## Result: PASS, no stop condition

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Toolchain | OK | rustc 1.99.0 (b940084d7 2026-09-28), cargo 1.99.0, node v24.15.0, pnpm 12.8.1, Windows 11 Pro 10.0.26300 (26H2) |
| 1 | Git | OK | HEAD `db5c0ce`; working tree: docs/plans/README.md and phase-5-lockdown.md modified (docs agent), untracked VM-CHECKLIST*.md, screenshot, `vite.config.ts`, dashboard e2e helpers/playwright config |
| 2 | Disk | OK | D: 17.1 GB free (stop below 10), C: 114.6 GB free; `target\` 9.33 GB before, 9.52 GB after `cargo check` |
| 2 | Downloads | OK | None needed for Step 0 (`cargo check --workspace --offline` passed, exit 0, 31 s) |
| 3 | Phase 4 Steps 2, 8, 9, 10, 12, 13, 15 | OK, all committed | Step 2 `a8ee968`, 8 `ee5db94`, 9 `eeb6288`, 10 `e8e4f05`/`7a9ab07`, 12 `7e3c794`, 13 `9665638`, 15 `c7da590` |
| 3 | Phase 3 Step 19 | OK | README: Phase 3 closed 2026-11-01 (workspace checks run); close-out commit `50540ee`. No commit message says "Phase 3 step 19" literally |
| 3 | Phase 4 Steps 19, 21, 22 | Waived | waived by owner 2026-11-08, Phase 4 Steps 19/21/22 parked (Step 19 blocked on Convex login). Not prerequisites of any Phase 5 step |
| 3 | Blocked Phase 5 steps (Section 3.4) | None | All prerequisites (Phase 4 Steps 2, 8, 9, 10, 12, 13, 15; Phase 3 Step 19) are committed |
| 4 | Test-machine marker | OK | `Test-Path 'HKLM:\SOFTWARE\Rulebox\TestMachine'` = False |
| 5 | Sections 19 and 20 | Done | Owner accepted all open questions with the recommended option on 2026-11-08 (earlier on 2026-10-27, per the plan's Updates section) |
| - | ConfigCI module (App Control, Steps 6, 21) | OK on dev | `Get-Module -ListAvailable ConfigCI` found; `ConvertFrom-CIPolicy`, `New-CIPolicy` present |
| - | VM-only checks | pending | AppLocker on Pro (CSP vs local path), ETW, Safe Mode behaviour, Home edition: VM: pending (Steps 21-22) |

README note: the Phase 4 row in docs/plans/README.md still says "In progress
(updated 2026-11-01), not started: Steps 8-13" - stale; the commits above show
otherwise. The docs agent should refresh it.

## What Step 1 needs (Section 4.22 vs the workspace)

Already present: `windows` 0.62.2, `zeroize` 1.9.1, `quick-xml` 0.42.0
(transitive), `sha2` 0.11.1 (workspace; 0.10.9 also in the tree),
`ed25519-dalek` 3.0.0 (curve25519-dalek 5.0.0).

Not present, to add: `x25519-dalek`, `chacha20poly1305`, `hkdf`.

> Plan conflict to resolve at Step 1: Section 4.22 names `x25519-dalek` 2.x,
> `chacha20poly1305` 0.10, `hkdf` 0.12. Those sit on the old digest 0.10 /
> curve25519-dalek 4 stack, while the workspace is on sha2 0.11 (digest 0.11)
> and curve25519-dalek 5. crates.io newest: `x25519-dalek` 3.0.0,
> `chacha20poly1305` 0.11.0, `hkdf` 0.13.0, `hmac` 0.13.0. Recommendation:
> use these newer majors (one crypto stack, no duplicate digest/dalek copies,
> smaller build), after checking each release is at least 14 days old and that
> `x25519-dalek` 3 builds against curve25519-dalek 5. This is the "better
> solution than the plan" case: tell the owner so the plan can be updated.

Also new `windows` 0.62 features (no download, already vendored): `Win32_System_Diagnostics_Etw`,
`Win32_NetworkManagement_WiFi`, `Win32_Graphics_Printing`,
`Win32_System_EventLog`, `Win32_System_Wmi`, `Win32_System_Services`
(`Win32_NetworkManagement_NetManagement` is already enabled).
`@noble/curves` and `@noble/ciphers` 2.x are npm packages for Step 10 (not
Step 1). Size: the new Rust crates are about 100 MB built, as the plan says;
the sum is small next to the 9.5 GB `target\`.
