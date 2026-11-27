# Dashboard UI pass (2026-11-28) — shared rules and contracts

Spec: `docs/plans/follow-ups.md`, section "NEXT after VM run A3: dashboard UI pass" (sections 0–6, the
"Users are not technical" rule and the "Automate the complex things" owner requirements). The owner asked to
plan **and** execute in one run: every page plan in this folder records the decisions taken (always the
recommended option) so the owner can review afterwards.

Plans in this folder:

| File | Page(s) |
|---|---|
| `audit.md` | Every route rated against the owner's bar, every form input a normal user would not understand |
| `foundations.md` | Shared components and layout rules (this README is the contract; foundations.md records what was built) |
| `device-detail.md` | `/devices/:id` |
| `settings.md` | `/settings` incl. Updates from GitHub releases |
| `add-app.md` | `/apps/new`, `/apps/:id` (Windows app, website/web app, popular apps gallery) |
| `lockdown.md` | `/groups/:id/lockdown`, `/lockdown/findings` |
| `lists-and-cards.md` | Generic table, Table/Cards view, list pages |
| `enrollment-networks.md` | `/enrollment` (guided steps), `/networks` + Wi-Fi/printer/driver forms |

## Owner rules for every page

1. **Impress at every width.** Deliberate layout per band, never a stack of full-width sections on desktop.
2. **Users are not technical.** Show only what most people need, in plain words. Hide technical values
   (hashes, byte sizes, IDs, registry-ish names) or fill them automatically. Advanced and rare options go behind
   "Advanced" or a later step. Prefer a good default over a choice. One clear main action per screen. Short
   labels; the explanation goes in an (i) tooltip. Errors and warnings stay visible inline, never only in a tooltip.
3. **Automate the complex things.** Never ask a normal user for technical input up front. For every form input a
   normal user would not understand, the plan says how it is automated, defaulted, hidden or turned into an
   interactive picker.
   - Windows app: no silent-install command field by default; pick the silent mode automatically (installer
     type / winget data), show "Installs silently" with (i); the command field moves under Advanced.
   - Website / web app: replace the raw "allow subdomains" input with an interactive example (the address with
     clickable parts, "also allow mail.example.com, shop.example.com") and a live preview of which addresses open
     and which are blocked. Same data model.
   - Add a PC (enrollment): a few guided steps (1. Create code, 2. Run the installer on the PC, 3. Done, the PC
     appears here), no prerequisite list up front, one-click download/copy/QR, technical details behind (i) or
     Advanced, live progress when the new PC appears.

## Hard rules (repo `CLAUDE.md`)

- Custom UI, no component library. Shared pieces live in `packages/ui/`.
- Icons: Solar only via `unplugin-icons` (`~icons/solar/<name>-linear`, active `-bold-duotone`). App logos in the
  popular-apps gallery are app art, not UI icons (bundled files; letter tile when the logo's terms are unclear).
- Offline-first: nothing from a CDN or online API at runtime (the GitHub releases list is fetched by a **Convex
  action** on the server, not by the browser).
- Dashboard animation: plain CSS (`dash-enter` style), `transform` and `opacity` only, honour
  `prefers-reduced-motion` and Lite mode. No GSAP in the dashboard.
- 4 GB RAM target: lazy load, small bundles. The size budget (`apps/dashboard/scripts/size.mjs`) is never raised
  silently; a needed raise is reported with the reason.
- **Convex I/O budget** (`CLAUDE.md` "Database I/O budget" and "Data access rules"): one query per screen (or
  per tab), `.withIndex`, no `.collect()` on growing tables, paginate lists, sorting/search server-side, bounded
  `.take(n)` for "latest" widgets, fast-changing data in its own table. Every new query gets an entry in
  `convex/ioBudgets.ts`. A tab that is not open loads nothing. Never run `convex dev` / `convex deploy`;
  Convex changes are tested with `pnpm test:convex` only.
- Do not touch `apps/agent/`, `crates/`, `apps/installer/`, `apps/website/`, the defaults in
  `convex/lib/lockdownValidators.ts`, or `apps/dashboard/src/stepup/`.
- Every screen keeps working in **demo mode** (`src/data/demo/*`, in-memory fixtures) and **live mode**
  (`src/data/live/*`, Convex). A new data need is added to the data seam (`src/data/api.ts` + demo + live).

## Width bands (one set for every page)

| Band | Width | Shell | Content |
|---|---|---|---|
| phone | < 600 px | top bar + menu sheet | one column, 16 px gutter, sticky main action at the bottom where it helps |
| tablet | 600–1023 px | top bar + menu sheet (< 768) / rail | two columns where cards are short; forms one column |
| laptop | 1024–1599 px | side nav | main + aside (2:1) or 2-column grids; forms two columns for short fields |
| wide | ≥ 1600 px | side nav | content max width 1480 px; 3-column grids where the content has 3 groups |

Prefer **container queries** (`container-type: inline-size`) inside cards and grids so a section lays itself
out by its own width, and media queries only for the shell.

## Shared component contract (build in `packages/ui/` unless noted)

Names are fixed so page builders can code against them while foundations are being built.

- **`Select`** (`packages/ui`, custom listbox, replaces every native `<select>`):
  `{ value, onChange(value), options: SelectOption[], placeholder?, compact?, disabled?, id?, name?,
  "aria-label"?, "aria-labelledby"?, "aria-describedby"?, "aria-invalid"?, "aria-required"?, className? }`,
  `SelectOption = { value: string; label: string; hint?: string; disabled?: boolean; icon?: ReactNode }`.
  Button trigger + `role="listbox"` popup; arrows, Home/End, type-ahead, Esc, Enter/Space, Tab closes; focus
  returns to the trigger; opens down or up by available space and stays inside the viewport on phones; long
  labels truncate in the trigger (full text in `title`), wrap in the menu; never widens the page. The old
  native wrapper is renamed **`NativeSelect`** for the migration and deleted at the end of the pass.
- **`SearchSelect`** (`packages/ui`): same props plus `searchPlaceholder?`, `emptyText?`; ARIA combobox with a
  filter input for long lists (groups, apps, employees). Options can also come from the server
  (`onSearch?(text)` + `loading?`).
- **`InfoTip`** (`packages/ui`): `{ label: string (accessible name, e.g. "About Kiosk mode"), children: ReactNode,
  placement?: "top" | "bottom" }`. An (i) button next to a label. Hover (with a short delay) and focus show the
  tooltip; on touch, tap opens a popover, tap outside or Esc closes. Max width ~280 px, max ~3 short sentences.
  Flips to stay on screen.
- **`Popover` positioning helper** (`packages/ui/src/floating.ts`): `placeFloating(anchor, floating, { side,
  align, gap })` → flips and clamps inside the viewport; used by Select, SearchSelect and InfoTip.
- **`Field` / `FieldSet`** (`apps/dashboard/src/components/Field.tsx`): new `info?: ReactNode` prop renders an
  `InfoTip` next to the label. `hint` stays for the one short line a user needs to act; long explanations move
  to `info`.
- **`PageTabs`** (`apps/dashboard/src/components/PageTabs.tsx`) + **`useUrlTab(tabs, fallback, param = "tab")`**
  (`apps/dashboard/src/lib/useUrlTab.ts`): tab bar synced to `?tab=` (replace history), keyboard per WAI-ARIA tabs,
  optional count/badge per tab, scrolls sideways on phone with the active tab in view. Panels render only the
  active tab (lazy), so a tab that is not open loads nothing.
- **Layout classes** (`apps/dashboard/src/styles/dashboard.css`, section "Page layout"): `dash-page` (max width
  per band), `dash-grid` + `dash-grid--2|--3|--auto` (responsive columns), `dash-split` (main + aside, 2:1 on
  laptop+, stacked below), `dash-form-grid` (two columns for short fields on laptop+, `dash-form-grid__full` for a
  full-width field), `dash-advanced` (a `<details>` "Advanced" disclosure with consistent styling).
- **Generic table** (`DataTable`/`Pager`): short cells never wrap (columns declare `nowrap` or are numeric/date
  /state/badge), long text truncates with full text on hover/focus; the footer has one layout per band.
- **Cards view**: designed in `lists-and-cards.md`, built on the same `Column` definitions.

## Page CSS

Page-specific styles go in a CSS file next to the screen (e.g. `src/screens/device/device.css`) imported by the
lazy screen, so they ship in that screen's chunk, not in the entry CSS. Shared rules go in `dashboard.css` or
`packages/ui/src/components.css`. Use the tokens (`packages/ui/src/tokens.css`), never raw colours.

## Screenshots

`apps/dashboard/e2e/shots.mjs` (demo mode). Start a demo dev server on your own port, then:

```
pnpm --filter @rulebox/dashboard exec vite --mode demo --port <port> --strictPort
$env:RB_CHROME = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1255\chrome-headless-shell-win64\chrome-headless-shell.exe"
node e2e/shots.mjs http://localhost:<port> --out=../../.tmp/ui-pass/<page> --paths=device:@device,settings:/settings?tab=updates
```

Widths 390, 820, 1366, 1920; light and dark. `.tmp/` is gitignored.
