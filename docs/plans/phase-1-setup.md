# Phase 1 — Setup (monorepo skeleton)

> **For the implementing agent:** follow this plan step by step. Each step
> has a **Done when** check — run it and see it pass before moving on.
> Read `CLAUDE.md` first. From `prd.md`, read only Sections 3, 4.1–4.4, 16
> and 22.5. Don't build anything from later phases (no shell
> replacement, lockdown, auth or Windows service logic).

## Goal

An empty but working monorepo where:

1. `apps/dashboard` (Vite + React + TS) runs in the browser.
2. `apps/staff-app` (Tauri v2 + Vite + React + TS) opens a desktop window.
3. Both apps connect to the same Convex deployment and show
   **"Backend: connected"**.
4. Both apps use one shared design system (`packages/ui`) that matches
   the vibe of `design/staff-desktop-v0/`.
5. A Rust type (`DesiredState`) generates a TypeScript type into
   `packages/types`. This proves the Rust ↔ TS contract works.
6. `apps/agent` compiles as a plain Rust binary stub.

## Non-goals (do NOT build in Phase 1)

- Shell replacement, Win32 window tracking, taskbar logic, kiosk lockdown
- Windows service install, enrollment, IPC between agent and shell
- Convex Auth / sign-in (that's Phase 4); the sign-in screen is visual only
- Installer / MSI
- Real screens beyond the gallery and status pages described below

---

## Step 0 — Preflight (stop if anything fails)

Run these and record the output in your final report:

```powershell
node --version        # must be >= 22
pnpm --version        # want 11.x; if missing: corepack enable && corepack prepare pnpm@latest --activate
rustc --version; cargo --version
Get-CimInstance Win32_LogicalDisk | % { "{0} {1:N1} GB free" -f $_.DeviceID, ($_.FreeSpace/1GB) }
```

- Check that MSVC Build Tools ("Desktop development with C++") are
  installed. Run `where.exe link` from a Developer prompt, or run
  `cargo build` on a hello-world crate.
- **If Node, Rust or MSVC is missing: stop and tell the user** what to
  install, with links to https://v2.tauri.app/start/prerequisites/. Never
  install toolchains silently.
- If D: has **less than 10 GB free**, stop and warn the user. The first
  Tauri build downloads and compiles ~2–4 GB.

**Pin versions by checking, not by guessing.** Research in Oct 2026 found
roughly these versions: Tauri 2.11.x, Convex 1.45.x, Vite 8.x, React
19.x, pnpm 11.x. Before writing any version, confirm it with
`npm view <pkg> version` or `cargo search <crate> --limit 1`.

---

## Step 1 — Repo root

Work in `D:\work\personal\rulebox`. **Keep** `prd.md`, `CLAUDE.md` and
`design/` exactly where they are. Don't delete
`Rulebox Staff Desktop.zip`; just add it to `.gitignore`.

Create these files:

| File | Content |
|---|---|
| `.gitignore` | `node_modules/`, `target/`, `dist/`, `.env*.local`, `*.zip`, `.DS_Store`, `*.log`. Do **not** ignore `convex/_generated/` (Convex recommends committing it) |
| `.editorconfig` | 2 spaces for TS/JSON/CSS, 4 for Rust, LF line endings, final newline |
| `.gitattributes` | `* text=auto eol=lf` |
| `package.json` | `"private": true`, `"packageManager": "pnpm@<confirmed>"`, `"engines": {"node": ">=22"}`, scripts below |
| `pnpm-workspace.yaml` | `packages: ["apps/*", "packages/*"]` + a `catalog:` for shared versions (react, react-dom, typescript, vite, @vitejs/plugin-react, convex) + `allowBuilds` for `esbuild` (pnpm 11 blocks build scripts by default) |
| `Cargo.toml` | workspace (see below) |
| `rust-toolchain.toml` | `channel = "stable"` only, without pinning a number (avoids extra toolchain downloads) |
| `tsconfig.base.json` | `strict: true`, `moduleResolution: "bundler"`, `module: "ESNext"`, `target: "ES2022"`, `jsx: "react-jsx"`, `noEmit: true`, `skipLibCheck: true`, `noUncheckedIndexedAccess: true` |

Root `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["apps/agent", "apps/staff-app/src-tauri", "crates/*"]

[workspace.package]
edition = "2021"
license = "MIT"

[profile.dev]
debug = "line-tables-only"   # keeps target/ small (see CLAUDE.md)

[profile.release]
lto = true
codegen-units = 1
strip = true
```

Root `package.json` scripts:

```json
{
  "dev:dashboard": "pnpm --filter @rulebox/dashboard dev",
  "dev:staff": "pnpm --filter @rulebox/staff-app tauri dev",
  "dev:convex": "convex dev",
  "typecheck": "pnpm -r typecheck",
  "lint": "pnpm -r lint",
  "gen:types": "cargo test -p rulebox-policy export_bindings"
}
```

Then run `git init` and stop for a moment: **don't commit yet**.

**Done when:** `pnpm install` succeeds at the root (with no apps yet).

---

## Step 2 — `packages/ui` (design system)

Package name `@rulebox/ui`. It ships source TS/TSX (no build step); apps
import it directly through the workspace (`"@rulebox/ui": "workspace:*"`).

```
packages/ui/
├─ package.json            # exports: "./tokens.css", "./fonts.css", ".": "./src/index.ts"
├─ src/
│  ├─ tokens.css           # all colors, radii, shadows, sizes as CSS vars
│  ├─ fonts.css            # @font-face for self-hosted Geist + Geist Mono
│  ├─ base.css             # reset + body defaults (from the design's <style>)
│  ├─ theme.ts             # setTheme('light'|'dark'|'auto'), setLite(bool)
│  ├─ components/
│  │  ├─ Button.tsx        # variants: primary (ink bg), ghost, danger-ghost
│  │  ├─ Input.tsx         # 46px, radius 12, accent focus ring
│  │  ├─ Panel.tsx         # frosted card (glass bg + blur + border + shadow)
│  │  ├─ Avatar.tsx        # initials circle, accent-soft bg
│  │  ├─ SegmentedControl.tsx
│  │  ├─ AppTile.tsx       # icon block + name + optional desc, running dot, badge
│  │  ├─ TitleBar.tsx      # 46px window chrome: icon, title, min/max/close
│  │  └─ Backdrop.tsx      # the two blurred color blobs behind the desktop
│  └─ index.ts
```

**Fonts must be self-hosted**, because kiosk PCs may be offline. Use the
`geist` npm package or `@fontsource-variable/geist` and
`@fontsource-variable/geist-mono`, whichever exists. Confirm with
`npm view`. **No Google Fonts link.**

**Tokens.** These come from the light/dark fallback values in
`design/staff-desktop-v0/Rulebox Staff Desktop.dc.html`. Use semantic
names. **Never** copy the design's `--t0…--t83` names.

| Token | Light | Dark |
|---|---|---|
| `--rb-bg` | `oklch(0.935 0.009 85)` | `oklch(0.16 0.006 70)` |
| `--rb-ink` | `oklch(0.24 0.012 70)` | `oklch(0.97 0.006 70)` |
| `--rb-ink-hover` | `oklch(0.32 0.012 70)` | `oklch(0.91 0.006 70)` |
| `--rb-on-ink` | `white` | `oklch(0.2 0.01 70)` |
| `--rb-muted` | `oklch(0.5 0.012 70)` | `oklch(0.775 0.006 70)` |
| `--rb-faint` | `oklch(0.62 0.01 70)` | `oklch(0.685 0.006 70)` |
| `--rb-line` | `oklch(0.9 0.006 80)` | `oklch(0.338 0.006 70)` |
| `--rb-surface` | `oklch(0.995 0.002 85)` | `oklch(0.215 0.006 70)` |
| `--rb-surface-glass` | `oklch(0.995 0.002 85 / 0.72)` | `oklch(0.22 0.006 70 / 0.72)` |
| `--rb-glass-border` | `oklch(1 0 0 / 0.85)` | `oklch(1 0 0 / 0.077)` |
| `--rb-hover` | `oklch(0.94 0.006 85)` | `oklch(0.287 0.006 70)` |
| `--rb-accent` | `oklch(0.5 0.085 175)` | `oklch(0.64 0.09 175)` |
| `--rb-accent-soft` | `oklch(0.94 0.03 175)` | `oklch(0.34 0.05 175)` |
| `--rb-accent-text` | `oklch(0.38 0.085 175)` | `oklch(0.8 0.08 175)` |
| `--rb-danger` | `oklch(0.6 0.17 25)` | `oklch(0.6 0.17 25)` |
| `--rb-danger-text` | `oklch(0.5 0.15 25)` | `oklch(0.78 0.15 25)` |
| `--rb-blob-a` | `oklch(0.86 0.045 170)` | `oklch(0.32 0.045 170)` |
| `--rb-blob-b` | `oklch(0.9 0.045 75)` | `oklch(0.32 0.045 75)` |

Other tokens:
- Radii: `--rb-r-sm 8px`, `--rb-r-md 12px`, `--rb-r-lg 14px`,
  `--rb-r-xl 20px`, `--rb-r-2xl 26px`.
- Sizes: `--rb-titlebar 46px`, `--rb-taskbar 60px`,
  `--rb-taskbar-inset 12px`.
- Font: base `14px` Geist, numbers use `font-variant-numeric: tabular-nums`.
- Shadows: copy the two-layer shadow pattern from the design's tiles and
  panels into `--rb-shadow-sm`, `--rb-shadow-md` and `--rb-shadow-lg`.
- Motion: `--rb-ease cubic-bezier(.2,.8,.2,1)`.

**Theming rules:**
- `:root` holds the light theme.
- `[data-theme="dark"]` holds the dark theme.
- `[data-theme="auto"]` follows `prefers-color-scheme`.
- `[data-lite="true"]` (PRD 22.5 Lite mode) sets `backdrop-filter: none`,
  hides the blobs, uses solid surfaces instead of glass and turns
  transitions off. Every component must look right in Lite mode.

**Done when:** `pnpm --filter @rulebox/ui typecheck` passes.

---

## Step 3 — `crates/rulebox-policy` + `packages/types`

- `crates/rulebox-policy`: a library crate with `serde` and `ts-rs`
  (confirm the latest version). It defines `DesiredState`, matching
  PRD Section 10:
  `kiosk_enabled: bool`, `apps: Vec<String>`, `allowed_sites: Vec<String>`,
  `file_handlers: BTreeMap<String,String>`, `storage: StorageConfig { default_quota_gb: u32 }`,
  `branding: Branding { name: String, logo: Option<String> }`, `version: u64`.
- Use `#[serde(rename_all = "camelCase")]` and
  `#[ts(export, export_to = "../../packages/types/src/generated/")]`.
- Add a unit test that round-trips the PRD's example JSON through serde.
- `packages/types` (`@rulebox/types`): `src/index.ts` re-exports
  `./generated/*`. Commit the generated files.

**Done when:** `pnpm gen:types` creates `DesiredState.ts` and
`cargo test -p rulebox-policy` passes.

---

## Step 4 — `convex/` (backend skeleton)

- Add `convex` as a **root** devDependency (catalog version) and as a
  dependency of both apps.
- Run `npx convex dev` once at the root. It is **interactive**: it asks
  the user to log in and create a project. **Ask the user to run it**
  with `! npx convex dev --once` (suggest the project name `rulebox`).
  Don't try to automate the login.
- `convex/schema.ts`: create these tables now, so later phases share
  one model. Fields come from the PRD; add indexes on obvious lookups.
  - `organizations` — name, branding
  - `groups` — orgId, name
  - `devices` — orgId, groupId?, name, status, lastSeen, os, ramMb, diskFreeGb, lockdownLevel
  - `employees` — orgId, name, username, groupIds, quotaGb, disabled
  - `apps` — orgId, type (`winget` | `web` | `msi` | `portable`), name, iconUrl?, config (v.any() for now)
  - `desiredStates` — orgId, scope (group/device id), version, doc
  - `enrollmentTokens` — orgId, tokenHash, expiresAt, usesLeft
  - `auditLog` — orgId, actor, action, target, at (PRD Decision 15: v1)
- `convex/health.ts`: a public query `ping` that returns
  `{ ok: true, at: Date.now() }`. Don't add any other functions.
- `.env.local` gets `CONVEX_DEPLOYMENT` (written by the CLI). Each app
  gets its own `.env.local` with `VITE_CONVEX_URL`, plus a committed
  `.env.example`.

**Done when:** `npx convex dev --once` deploys with no errors and the
dashboard at dashboard.convex.dev shows the 8 tables.

---

## Step 5 — `apps/dashboard`

- Scaffold with `pnpm create vite apps/dashboard --template react-ts`,
  then rename the package to `@rulebox/dashboard`.
- Swap the dependencies to `catalog:` / `workspace:*`. Extend
  `tsconfig.base.json`. Add `typecheck` (`tsc -b --noEmit` or
  `tsc --noEmit -p tsconfig.app.json`) and `lint` scripts.
- Delete the template's demo content (logos, counter, App.css).
- Import `@rulebox/ui/tokens.css`, `fonts.css` and `base.css` in `main.tsx`.
- Wrap the app in `ConvexProvider` using `import.meta.env.VITE_CONVEX_URL`.
  If the variable is missing, show a clear on-screen error instead of crashing.
- Two routes (plain state switch, no router library yet):
  - **Status:** "Rulebox Dashboard" plus a `Panel` showing
    "Backend: connected · <time>" from `health.ping`. It shows
    "connecting…" while loading.
  - **Gallery:** every `@rulebox/ui` component in light, dark and Lite,
    with a toggle to switch.
- Import Convex functions from `../../convex/_generated/api`. If that
  relative path is awkward in TS, add a `paths` alias `@convex/*` and say
  so in the report.

**Done when:** `pnpm dev:dashboard` shows "Backend: connected", the
gallery switches themes, and `pnpm --filter @rulebox/dashboard typecheck`
passes.

---

## Step 6 — `apps/staff-app` (Tauri v2)

- Scaffold with `pnpm create tauri-app` (template **react-ts**, manager
  **pnpm**) into `apps/staff-app`. If the CLI won't scaffold into an
  existing monorepo path, scaffold into a temp folder and move it.
- Package name `@rulebox/staff-app`. Crate name `rulebox-staff`.
  Identifier `dev.rulebox.staff`.
- `src-tauri/Cargo.toml`: use `edition.workspace = true`. There must be
  **no** separate `[workspace]` and no `target/` inside `src-tauri`. Build
  output has to land in the root `target/`. Check that after the first build.
- `tauri.conf.json`:
  - one window, 1280×800, title "Rulebox", `decorations: true` for now
    (custom chrome comes in Phase 3).
  - CSP that allows the Convex URL (`https://*.convex.cloud` and
    `wss://*.convex.cloud`) and blocks everything else.
  - Remove plugins the template adds that aren't needed. Keep the
    capabilities file minimal.
- Use the same frontend setup as the dashboard (tokens, fonts,
  ConvexProvider, error state if the env var is missing).
- **One screen** that recreates the design's **sign-in look** as a static
  visual (no real auth): `Backdrop` blobs, big 96px light clock + date,
  frosted `Panel` with `Avatar`, password `Input` and the arrow `Button`,
  "Backend: connected" in the footer where the design shows "Managed by
  …", and a theme/Lite toggle in a corner for testing. Get the data from
  `health.ping`.
- Lite mode: read a `?lite=1` query param or a hard-coded toggle for now
  (the agent sets it in later phases).

**Done when:**
- `pnpm dev:staff` opens a window with the sign-in visual and
  "Backend: connected".
- `cargo check --workspace` passes.
- `target/` exists **only** at the repo root.

> First build warning: it compiles ~400 crates. Tell the user before
> starting and run it once. Never run `tauri build` (release) in Phase 1.

---

## Step 7 — `apps/agent` (stub)

- A binary crate `rulebox-agent` that depends on `rulebox-policy`.
- `main.rs` parses the PRD example desired state and prints
  `rulebox-agent <version>: desired state v42 OK`. Nothing else: no
  service code and no `windows` crate yet.

**Done when:** `cargo run -p rulebox-agent` prints that line.

---

## Step 8 — Wrap-up

1. Run all of these and paste the results in the report:
   `pnpm typecheck`, `pnpm lint`, `cargo clippy --workspace -- -D warnings`,
   `cargo test --workspace`.
2. Report the size of the root `target/` folder
   (`"{0:N1} GB" -f ((gci target -r -file | measure Length -sum).Sum/1GB)`).
3. Update `CLAUDE.md`. Replace "File structure not created yet" with the
   real dev commands (`pnpm dev:dashboard`, `pnpm dev:staff`,
   `pnpm dev:convex`, `pnpm gen:types`). Don't change anything else.
4. Make the **first commit**, "Phase 1: monorepo skeleton", only after
   the user has looked at both apps running. Ask first.

## Final report format (keep it short)

- ✅ / ❌ for each step's **Done when** check
- Versions actually pinned (Tauri, Convex, Vite, React, pnpm, Rust)
- Size of `target/`
- Every deviation from this plan, and why. If you found a better way
  (CLAUDE.md rule), say so explicitly.
- Open questions for the user

## Stop and ask the user if

- a prerequisite is missing, or free disk space is below 10 GB
- Convex login or project creation is needed
- a step's **Done when** check still fails after 2 honest fix attempts
- you want to add any dependency not named in this plan
