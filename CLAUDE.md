# Rulebox

Open-source (MIT) kiosk OS for Windows: turns a PC into a locked, branded
workstation managed from a web dashboard. v1 = Windows, v2 = Android.

## Source of truth

- **`docs/prd.md`** is the spec. Read the relevant section before building a
  feature. Locked decisions are in Section 21 — do not re-open them.
- If code and PRD disagree, ask; don't silently pick one.
- Section 13.6 lists researched risks with recommended fixes. If you find
  a better solution than the PRD's, use it **and tell the user** what
  changed and why so the PRD can be updated.

## Components and stack

| Part | Stack | Location (planned) |
|---|---|---|
| Dashboard | Vite + React + TS, custom UI (no component library) | `apps/dashboard/` |
| Backend | Convex (cloud free tier) + Convex Auth | `convex/` |
| Staff App (shell) | Tauri v2 + Vite + React | `apps/staff-app/` |
| Agent | Rust Windows service (SYSTEM), `windows` crate, Convex Rust client ≥0.10.3 | `apps/agent/` |
| Installer | WiX MSI + compatibility check | `apps/installer/` |
| Shared Rust | policy types/signing, agent↔shell IPC, Win32 helpers | `crates/` |
| Shared TS | design system, generated types | `packages/ui/`, `packages/types/` |

Monorepo: Cargo workspace + pnpm workspace. Dev commands (repo root):
`pnpm dev:dashboard`, `pnpm dev:staff` (Tauri), `pnpm dev:convex`,
`pnpm gen:types` (Rust `DesiredState` -> `packages/types`), `pnpm gen:brand`
(logo files).
Phase plans live in `docs/plans/` (index: `docs/plans/README.md`) — follow
the current phase's plan exactly and update its status in the index.

## Hard rules

- Staff App has **no admin rights**; every privileged action goes through
  the agent over local IPC. A UAC prompt in the Staff session is a bug.
- Never use Windows' default file associations; only the `fileHandlers`
  table. Never open executables/scripts (PRD 7.3).
- Desired state, not commands (PRD 10). Every change is versioned.
- Installers/executables are always SHA-256 verified; policies and
  manifests are signed (v1).
- Do not run the `winget` CLI from the agent — it fails under SYSTEM. Use
  `Microsoft.WinGet.Client` or install from the manifest's URL + hash.
- Animation follows PRD Section 25: GSAP (+ Flip), only `transform` and
  `opacity`, clean up on unmount, honor reduced motion and Lite mode.
  The web dashboard is the exception (owner decision 2026-10-27): its few entrance
  animations are plain CSS (dash-enter, opacity and transform only, reduced motion
  and Lite honoured) so GSAP stays out of its small bundle.
- **Icons: Solar only** (Decision 16), bundled at build time via
  `@iconify-json/solar` + `unplugin-icons` (e.g.
  `import IconHome from '~icons/solar/home-2-bold-duotone'`). Dashboard:
  `-linear`, active `-bold-duotone`. Staff App: `-bold-duotone`, selected
  `-bold`. No other icon sets, no runtime Iconify API. Keep the
  CC BY 4.0 credit in `THIRD_PARTY_NOTICES.md` and the About screens.
- **Offline-first** (Decision 17): fonts, icons, GSAP and every UI asset
  are bundled. Never load anything from a CDN, Google Fonts or online icon
  API at runtime.
- Target hardware is **4 GB RAM** laptops: keep WebView count low, lazy
  load, respect Lite mode (PRD 22).

## Data access rules (Convex) — PRD 11.1

1. **One query per screen**: join on the server; return exactly what the
   screen shows. No client-side waterfalls of small queries.
2. **Always `.withIndex(...)`**; never `.filter()` over a whole table. Add
   the index in `schema.ts` together with the query.
3. **No `.collect()` on growing tables** (audit log, devices, employees,
   install results, history). Lists use `.paginate()` +
   `usePaginatedQuery`; "latest" widgets use `.take(n)`.
4. **Keep fast-changing data separate**: `lastSeen`/online status lives in
   its own small table, never in the `devices` row lists subscribe to.
5. **Write only on change**: heartbeats and status reports write only when
   something changed; the live connection is the online signal.
6. **Agent = one subscription** to its own desired state; no polling loops.

## Design reference

`design/staff-desktop-v0/` is a Claude Design export of the Staff App.
It is a **starting vibe, not the source of truth** — layouts and features
will change; the PRD wins on behavior.

- Read `Rulebox Staff Desktop.dc.html` (readable template + script).
  Skip `Rulebox Staff Desktop.html` (400 KB bundle) and `support.js`.
- Vibe to keep: warm paper neutrals (oklch hue ~70–85), single teal
  accent (oklch hue 175), Figtree + Geist Mono (Decision 19; the design
  export still shows Geist — ignore that), soft blurred color blobs
  behind the desktop, generous radii (12–26 px), frosted panels, calm
  shadows, light + dark themes via CSS tokens.
- Screens in it: sign-in (big clock + frosted card), desktop (greeting,
  app tiles with "running" dot and badges, "My files" side panel), custom
  46 px title bars, bottom taskbar (84 px), sample viewers.
- Turn its inline styles into tokens in `packages/ui/` — never copy the
  `--t0…--t83` variable names as-is.

**Logo:** pixel "R" in a rounded box with a green leg (`#12b76a`,
`--rb-brand`; the UI accent stays teal). Spec in PRD 25.5.
- Geometry lives in `packages/ui/src/brand/geometry.ts`. Never redraw it.
- Still logo: `<LogoMark>`. Splash / loading / open-desktop / lock:
  `<LogoMotion>` (pure CSS in `logo-motion.css`, the one exception to the
  GSAP rule). Keep those animations exactly as they are.
- Static files in `assets/brand/`, favicons and Tauri icons are generated:
  change the geometry, then run `pnpm gen:brand`. Never edit them by hand.
- Design reference: `design/logo/rulebox_pixel_r_logo_v2_dense_grid.html`
  (gitignored).
## Environment

- Windows 11, PowerShell. Disk space is tight (~22 GB free on D:, ~39 GB
  on C:). Rust `target/` folders are the biggest cost (debug ~3–6 GB,
  release +1–3 GB); the final Tauri installer is only ~5–15 MB.
- Keep disk use low:
  - **One Cargo workspace** at the repo root so the agent, Staff App and
    crates share a single `target/` folder. Never create per-app targets.
  - In the root `Cargo.toml`, keep dev builds light:
    ```toml
    [profile.dev]
    debug = "line-tables-only"
    ```
  - Use **pnpm** (shared store), never npm or yarn.
  - Build `--release` only when needed; run `cargo clean` (or
    `cargo clean --release`) when space gets low. Don't leave stray build
    outputs or copies of installers lying around.
  - Warn the user before any step that downloads or builds several GB.
- Lockdown code (accounts, policies, shell replacement) must be tested on
  a **VM or test PC**, never on the dev machine.

## How to verify work

- Rust: `cargo check` / `cargo clippy` / `cargo test` for the touched crate.
- TS: typecheck + lint for the touched app.
- UI: run it and look at it (screenshot) before saying it's done.
- Report failures honestly with the output.
