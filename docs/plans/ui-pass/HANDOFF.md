# UI pass handoff (finished 2026-11-28)

Branch `t3/dashboard-ui-pass` (worktree `C:\Users\OMEN\.t3\worktrees\rulebox\t3-1d705356-f88f320476fe53c1`). `main`
(71ae0e5) merged in (`467eab8`, no conflicts). Nothing pushed.

Final checks on the finished tree: `pnpm -r typecheck` + `typecheck:convex` clean, `pnpm lint` clean, dashboard tests 1878/1878,
Convex tests 2054 passed / 1 skipped, `pnpm ci:check -Fast` "All CI checks passed", `scripts/size.mjs` within budget. Screenshots of
32 changed pages at 390/820/1366/1920, light and dark (256 files, no horizontal overflow, no page errors) in
`.tmp/ui-pass/final/` (gitignored).

## What was built (plans in this folder)

- **Foundations:** custom `Select`/`SearchSelect`/`InfoTip` (+ `floating.ts`), `Field info`, layout classes, `PageTabs`/`useUrlTab`,
  table nowrap/truncation/footer per width, real Cards view (`CardGrid`, card roles on columns, `RowActions`), shared
  `ChoiceCards`/`ChipPicker`/`MoreMenu`/`AttentionList`/`StatTile`. `NativeSelect` deleted; no native select left in the dashboard.
- **Pages:** device detail (6 tabs, `fleet:page` + per-tab queries), Settings (section nav, Updates from GitHub releases), Lockdown +
  Programs to review (levels, plain words, "PCs up to date: n of m"), Add a PC wizard, Networks + Wi-Fi/printer/driver forms, Add app
  (start page + gallery, Windows flow with automatic silent mode, website form with the site-access picker, app page with tabs),
  Overview, Group detail, Rollout, Employees + employee page, Messages, Audit log, assign-app and file-type dialogs, every list.
- **Server (needs a deploy; never deployed from here):** `fleet:page`/`deviceSettings`/`versions`/`network`,
  `ruleboxRelease:githubReleases`, `lockdown:groupSync` + `deviceLockdownSync` table, `enrollmentCodes:progress`,
  `wifi:createWithPassphrase`, `apps:fingerprintInstaller`, `apps:byWinget`, `broadcasts:live`, `fileHandlers:setMany`,
  `groups:get` fields, audit `since`. All with `ioBudgets.ts` rows (MEASURED) and tests.

## After deploy (also in `follow-ups.md`)

1. `npx convex run maintenance:backfillLockdownSync '{}'` once on dev and once on production.
2. Delete `fleet:get` one release later.
3. VM check of the popular apps (paths and website domains), then `verified: true`.
4. Try a 100 MiB installer with `apps:fingerprintInstaller` on dev.

## Decisions and open questions

All page-level decisions are in each plan's "Decisions taken" section; the lead's decisions and the owner's answers are in the
final report of this run (thread) and summarised here:
- Owner (2026-11-28): size budgets measured, trimmed, raised only where needed with a reason per line (`scripts/size.mjs`);
  "PCs up to date" reads the small `deviceLockdownSync` table (14.6 KB for 50 PCs); other open questions take the recommendation.
- Phone default view = Cards; Settings › Signing keeps Register key for keyring orgs; `+` allowed in winget IDs; generated first
  employee password; letter tiles for the gallery; design gallery only in demo and dev builds.
