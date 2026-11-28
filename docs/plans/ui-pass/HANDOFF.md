# UI pass handoff (paused 2026-11-28)

Branch `t3/dashboard-ui-pass` (worktree `C:\Users\OMEN\.t3\worktrees\rulebox\t3-1d705356-f88f320476fe53c1`), on top of
`39ad727`. Nothing pushed. Owner asked to stop at a graceful point; work continues in a later session.

**HEAD does not typecheck** because of the last WIP commit (`bcfc656`, Add app UI). Fixing that is resume step 1.
The full dashboard suite, `pnpm test:convex` and `pnpm ci:check` were **not** run on the final tree.

## Done (committed, typecheck + own tests green at commit time, screenshots looked at)

| Area | Commits | Notes |
|---|---|---|
| Rules, contract, screenshot script | `84a563a` | `README.md` here; `apps/dashboard/e2e/shots.mjs` (demo mode, 4 widths, light/dark, `@device`/`@group`/... shortcuts, `--storage=`) |
| Plans + audit | `58a542e`, `9b10bc9`, `88e9304` | `device-detail`, `settings`, `add-app`, `lockdown`, `lists-and-cards`, `enrollment-networks`, `other-pages`, `audit` |
| Foundations | `6fb2400`, `7b39302` | `Select`, `SearchSelect`, `InfoTip`, `floating.ts` (packages/ui); `NativeSelect` = old wrapper (to delete when unused); `Field info`; `PageTabs` + `useUrlTab`; layout classes (`dash-grid--*`, `dash-split`, `dash-form-grid`, `dash-advanced`); table nowrap + footer; `qrcode-generator` 1.4.4 |
| Lists / Cards | `f57f9be`, `900d438` | `CardGrid` by container width, card roles on `Column`, `Truncate`, `RowActions`, sort/rows-per-page `Select`, phone defaults to Cards (changes the Phase 4b default; see Q3), cards code lazy |
| Device page | `47655e9`, `fab60f9`, `510253c` | `fleet:page` + per-tab queries, problems model, 6 URL tabs; page never subscribes `fleet:get` (test in `deviceTabs.test.tsx`) |
| Settings | `14a5071`, `1a4396a` | GitHub releases action (owner, module cache + ETag, no DB I/O), grouped section nav, General presets, key recorder, Updates picker + confirm + PIN. Members tab (step 11) NOT done |
| Lockdown | `6c3681c`, `1e39416` | `lockdown:groupSync`, Basic/Standard/Strict, Off/Trial run/Block, Advanced, save bar + "Saved. Your PCs get this within a minute.", "PCs up to date: n of m", Programs to review |
| Add a PC | `1e069fe` (data), `948b13e` (screen) | 3 guided steps, copy/download/QR, live progress, codes aside. Screenshots taken by the builder; I checked the "ready" state at 1366 only |
| Add app data | `1884be8`, `2ef89e0` | form model extracted, `siteAccess`, `silentMode`, gallery catalog (21 entries, letter tiles, `verified: false`), `apps:fingerprintInstaller`, `apps:byWinget`, `+` in winget IDs |
| Shared pieces (other pages) | `bb42622` | `ChoiceCards`, `ChipPicker`, `MoreMenu`, `AttentionList`, `StatTile`, `lib/password.ts`, `lib/auditText.ts` |

## In progress (WIP commits)

1. **`d657689` Networks** (`enrollment-networks.md` steps 9–12): Networks grid, Wi-Fi form with the password in the add
   form, printer form from one address are built; typecheck and networks tests pass. Left: driver form (step 12), screenshot
   review incl. dark + 1920, delete `NativeSelect` uses there if any remain.
2. **`bcfc656` Add app UI** (`add-app.md` steps 10–12): `AddAppStart`, `GalleryGrid`, `addSearch`, `desktop/*` exist.
   Left: missing string keys in `lib/screenStrings/appAdd.ts`/`appInstaller.ts` (`start.results`, `siteHint`, `wingetHint`,
   `catalogue`, `shown`, `advancedGroups`, `chooseVersion`, `useVersion`, `linkPlaceholder`, `chooseFile`, `checkAgain`,
   `rateLimited`, `fromFile`, `fileFailed`, `keepOffInfo`, `folder`, `silentArgs`), `AppEdit.tsx` still imports
   `DetectRow`/`InstallerCard` from `AppInstaller.tsx` (moved), then step 11 (edit page shell), 14, 15 (route switch), 16.
3. **`6c515c4` other-pages O2**: `groups:get` extra fields + audit `since` only. Left: `broadcasts:live`,
   `fileHandlers:setMany`, `ioBudgets.ts` + `matrixRows.ts` rows, Convex tests, then O3 seam.

## Next, in order

1. Fix HEAD typecheck: finish the Add app strings and the `AppEdit` imports (resume the Add app UI builder, brief below).
2. Finish Networks (driver form + screenshots).
3. Add app: website form + `SiteAccessPicker` (steps 9, 13), edit page shell (11), Details tab (14), route switch (15),
   tests (16a–c), verify (17). Website form plugs into the `AppPage` Details tab.
4. Settings Members tab (`settings.md` step 11) and list migrations L7a/b/c (`lists-and-cards.md`), then flip the
   default column type to `short` in `lib/columns.ts`.
5. Other pages: O2 rest, O3, then O4 Group detail, O5 Overview, O6 Rollout, O7 Employee, O8 Messages, O9 Audit,
   O10 dialogs (`other-pages.md` section 10).
6. NativeSelect sweep (every remaining native select → `Select`/`SearchSelect`, then delete `NativeSelect`) and the
   helper-text → `info` sweep on pages not redesigned (lists in `audit.md` section d).
7. Polish list: release-notes clamp cuts a heading in half (Settings › Updates); follow-up entry "delete `fleet:get`"
   one release after the server deploy; update `lockdown.md` (Findings aside from 1600 px, lazy Advanced chunk).
8. Final verify: `pnpm ci:check -Fast`, `pnpm test:convex`, size budgets (see below), screenshots of every changed page
   at 390/820/1366/1920 light + dark, update `README.md` index and `docs/plans/README.md`.

## Audit results (`audit.md`)

- Planned and largely done: device detail, Settings, Lockdown + Findings, Add a PC, list pages (table/cards).
- In scope, not yet built: Group detail (top), Overview, Rollout, Employee detail + new, Messages, Audit log wording and
  filters, assign-app / file-type / rollback dialogs, Networks (WIP), Add/edit app (WIP).
- Fine as is: sign-in, join, reset, pin-reset, NotFound, gallery.
- 38 native selects and ~55 helper paragraphs listed in `audit.md` section d; forms inventory in section c.

## Decisions taken (recommended option each time; owner reviews)

All per-plan decisions are listed in each plan's "Decisions taken" section. Lead decisions on top:
- Plans executed without owner review (owner's instruction for this run).
- Size budgets raised once (`6fb2400`): sign-in/join 145 → 146, pin-reset 150 → 151, overview 167.5 → 168.5 (InfoTip in
  every Field). Marked "Needs owner OK" in `scripts/size.mjs`. Other overruns are open (Q1).
- `lockdown:groupSync` reads each up-to-date PC's apply report (bounded, ~2 MB per 50-PC catch-up per open screen) rather
  than adding a new per-PC field (Q2).
- Phone defaults to Cards when no view is stored (changes Phase 4b "table everywhere") (Q3).
- Settings › Signing keeps "Register key" for keyring orgs without an active key (today's behaviour).
- Enrollment index is `devices.by_org_enrollment_token` (`["orgId","enrollmentTokenId"]`), so the tenant guard stays narrow.
- `+` allowed in winget IDs (dashboard + Convex) so Notepad++ can be added; query strings must use `encodeURIComponent`.
- First employee password: generated (`k7mq-p4xt-9wrb` style) with Copy / Generate another / Type my own.
- Group PCs and People become full tabs with Table/Cards; Lockdown says "First PCs" instead of "Pilot PCs".
- Gallery: letter tiles for every app (no logos until vendor terms are checked); Teams/Slack/Outlook as websites.

## Open questions (with recommendation)

- **Q1 Size budgets.** With all WIP, total JS was ~445 KB vs 400, overview ~172 vs 168.5, AppEdit ~31.5 vs 29.5,
  Enrollment ~27.3 vs 25. Recommendation: measure on the finished tree, trim what is cheap (lazy chunks), then raise the
  rest with a written reason per line.
- **Q2 groupSync cost.** (A) keep as built, (B) add a small `configApplied` field to `deviceSummary` (≈20 KB per 50-PC
  run, but one more write per PC per save and device-list re-runs). Recommendation: A now, B only if the I/O report shows
  real cost.
- **Q3 Phone default view.** Cards when nothing is stored (built) vs table everywhere. Recommendation: keep Cards.
- **Q4 PRD updates.** Tell-the-owner notes are at the end of each plan (device: one query per open tab, "Disconnect this
  PC", ring under Settings › Advanced; lockdown: two queries, Trial run/Block words; settings: GitHub releases + confirm
  dialog; add-app: silent mode automatic, server fingerprint, every allowed domain includes its subdomains).
  Recommendation: apply them to the PRD when the pass is merged.
- **Q5 Same-source trust.** Until SignPath signing, the MSI hash comes from the same release as the file. Recommendation:
  keep, and pin a code-signing key in the agent when signing lands.
- **Q6 Unverified gallery data.** Program paths for Reader, SumatraPDF, Foxit, GIMP, Audacity, Notepad++ and the web
  apps' domains (Teams likely needs more) need the VM check (`add-app.md` step 18).
- **Q7 Fingerprint limit.** 512 MiB streaming download in a Convex action is untested on a real deployment.
  Recommendation: try a 100 MiB file first; lower the cap if the action runs out of time or memory.

## How to resume

Environment: `pnpm install` is done in the worktree; `apps/dashboard/.env.local` is copied (gitignored). Demo screenshots:
`pnpm --filter @rulebox/dashboard exec vite --mode demo --port <port> --strictPort`, then `$env:RB_CHROME =
"$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1255\chrome-headless-shell-win64\chrome-headless-shell.exe"`
and `node e2e/shots.mjs ...` from `apps/dashboard`. Never run `convex dev`/`deploy`. Keep 3–4 builders at most.

Restart these Sonnet builders (fresh agents; the brief = the plan step list + "read CLAUDE.md, ui-pass/README.md,
the plan; own only these files; don't commit; typecheck + lint + own tests + screenshots on your port"):
1. **Add app UI** (port 4343): finish `bcfc656` — strings + `AppEdit` imports first (typecheck green), then `add-app.md`
   steps 11, 14, 15, 16a–c; website path keeps today's form until builder 2 lands.
2. **Add app website** (port 4349): `add-app.md` steps 9 and 13 (`SiteAccessPicker`, `WebAppForm`, Chrome/Edge chip
   editor), wired into `AppPage`'s Details tab; after builder 1 has done step 11.
3. **Networks** (port 4347): finish `d657689` — driver form (step 12), screenshots, dark mode.
4. **Other pages data** (no port): O2 rest + O3 (`other-pages.md`); then page builders O4–O10 (two or three at a time;
   O8 before O4).
5. **Settings Members + lists L7a/b/c** after the pages above land (they share screen files).
Planning was done with Opus subagents and building/audits with Sonnet subagents, as the owner chose.
