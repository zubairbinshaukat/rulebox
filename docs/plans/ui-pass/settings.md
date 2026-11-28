# Settings page (UI pass, 2026-11-28): plan

Scope: `/settings`, every section. Spec: `docs/plans/follow-ups.md` "0b", "Users are not technical", "Automate the complex
things", sections 3, 4 and 6; contract: `docs/plans/ui-pass/README.md`. Read for this plan: `screens/Settings.tsx`,
`screens/settings/*`, `lib/screenStrings/settings.ts`, `data/release/*`, `data/live/hooks.ts` (keys mapper), `convex/ruleboxRelease.ts`,
`convex/settings.ts`, `convex/keys.ts`, `convex/lib/{functions,safeFetch,winget}.ts`, `convex/ioBudgets.ts`, `tests/convex/matrixRows.ts`,
`.github/workflows/release.yml`, `docs/guides/release.md`, `apps/website/scripts/fetch-release.mjs`, `apps/agent/src/selfupdate.rs`
(header), PRD 23. Out of scope: `apps/dashboard/src/stepup/` (PIN setup screen, other agent), the shared components themselves
(foundations), the Convex `set` mutations (unchanged).

Status: planned. Every decision took the recommended option (Section 11); the owner reviews afterwards.

## 1-2. Inventory and classification

Classes: **UF** up front, **1C** one click deeper (dialog, menu, disclosure inside the section), **ADV** under "Advanced" /
"Technical details", **AUTO** filled automatically, **RM** removed. Roles: V viewer, A admin, O owner. PIN = fresh step-up.

| # | Section (file) | Field / control / value / action today | Who | Class | Reason, and how a non-technical input is handled |
|---|---|---|---|---|---|
| H1 | Shell (`Settings.tsx`) | Page header "Settings" + lead | all | UF | Keep, shorter lead |
| H2 | Shell | 7 tabs in one row (`organization`, `adminExit`, `signing`, `updates`, `members`, `security`, `about`), arrows/Home/End | all | UF | Becomes a grouped section nav (Section 3); ids kept |
| O1 | Organization (`OrganizationTab.tsx`) | Organization name (text) | A | UF | Plain; long hint to (i) |
| O2 | Organization | Offline sign-in, number 0-30 days | A | UF | **Picker**: `Select` of presets Off / 1 / 3 (default) / 7 / 14 / 30 days; a stored value outside the presets shows as an extra option "N days". No number typing |
| O3 | Organization | Default storage quota, number 0-2000 GB, "0 = unlimited" | A | UF | **Picker**: `Select` Unlimited / 1 / 2 / 5 / 10 (default) / 20 / 50 / 100 GB (+ stored value). "0 = unlimited" disappears |
| O4 | Organization | Power options: Sleep / Restart / Shut down checkboxes | A | UF | Keep as three toggles in one row, label "Power buttons" |
| O5 | Organization | Save changes + "unsaved" hint | A | UF | One main action; sticky bar on phone while dirty |
| O6 | Organization | Read-only notice (viewer) | V | UF | Keep |
| O7 | Organization | Stale edit / server errors (`FormError`, Reload) | A | UF | Inline, unchanged |
| O8 | Organization, plan card | Headline "Team plan: 2 of 25 PCs, ..." + status pill + suspended notice | all | UF | Aside card |
| O9 | Organization, plan card | Six usage rows (PCs, Employees, Apps, Groups, Dashboard members, Active enrollment codes) + "Limit reached" | all | UF | Compact rows with a thin meter; "No limit" rows show the count only |
| O10 | Organization, plan card | "Audit log kept for N days." + "Contact us to upgrade." | all | 1C | Audit days into (i) of the plan title; "Contact us" stays visible only when a limit is reached or suspended |
| A1 | Admin exit (`AdminExitTab.tsx`) | "Allow admin exit" switch | A, PIN | UF | Keep; the PIN sentence becomes a pill "Asks for your PIN" on the section header |
| A2 | Admin exit | Hint "Changing the admin exit asks you to confirm ..." | A | RM | Replaced by the pill + (i) |
| A3 | Admin exit | Key combination text input, grammar errors live, "Saved as X" | A, PIN | UF / ADV | **Picker**: key chips (`Ctrl` `Shift` `F12`) + "Change" opens a recorder ("Press the keys now", Esc cancels), validated with `v.parseHotkey`. The typed field moves under Advanced ("Type it instead") for combinations the browser swallows (Alt+F4, Ctrl+W) |
| A4 | Admin exit | "Use default" button | A | UF | Small link "Use Ctrl+Shift+F12" shown only when not default |
| A5 | Admin exit | Save changes | A | UF | Keep |
| A6 | Admin exit, PIN card | Exit PIN state: "PIN set on <date>" / warning "No PIN yet" | all | UF | Keep (warning stays inline) |
| A7 | Admin exit, PIN card | Set / Change PIN dialog (6-12 digits, repeat) | A, PIN | UF | Keep; the long rule sentence moves to (i) on the PIN field, the error stays inline |
| A8 | Admin exit, PIN card | Clear PIN (danger confirm) | A, PIN | 1C | Small danger-ghost button, unchanged |
| S1 | Signing (`SigningTab.tsx`) | Lead about signing | all | UF | One status line instead: "Changes to your PCs are signed automatically." |
| S2 | Signing | Publish failed notice + Publish again (O) | all / O | UF | Keep: it is the one thing an owner must act on |
| S3 | Signing | Roster pending notice + Publish again | all / O | UF | Keep |
| S4 | Signing | "RULEBOX_POLICY_KEY is not set on the deployment." | all | ADV | **Only for orgs signing with the deployment key.** Today it also shows for keyring orgs, where it is false (they sign with their own key) |
| S5 | Signing | Key mismatch danger notice | all | UF | Keep, plain words; detail text to (i) |
| S6 | Signing | Three CLI commands with copy fields (no key yet) | O | ADV | "Set up the key" disclosure, deployment-key orgs only |
| S7 | Signing | "No signing key registered" + Register key | O, PIN | UF | Keep (deployment-key orgs without a key) |
| S8 | Signing | Key list: key id, fingerprint, created, status | all | ADV | "Key details" disclosure |
| S9 | Signing | Rotation card: steps, trust progress, Prepare / Finish (type-to-confirm) | O, PIN | ADV | Deployment-key orgs only. **Hidden for keyring orgs**: the server refuses `prepareRotation` / `finishRotation` there (`refuseWhenKeyringOwns`, `conflict` `org_keys`) |
| S10 | Signing | "If the key is lost" / "If the key is stolen" cards | all | ADV | One short "If something goes wrong" text inside Advanced |
| U1 | Updates (`UpdatesTab.tsx`) | Current release: version pill | all | UF | "Your PCs update to Rulebox 0.2.1" |
| U2 | Updates | Size "36.2 MB (37,958,123 bytes)" | all | UF / ADV | Pretty size up front; bytes only in Technical details |
| U3 | Updates | Installer URL (mono) | all | ADV | File name up front ("Rulebox-0.2.1-x64.msi"), full URL in Technical details |
| U4 | Updates | SHA-256 (mono) | all | ADV | Technical details only |
| U5 | Updates | "No release set" empty state | all | UF | Keep, shorter |
| U6 | Updates | Stop updating (danger confirm) | O, PIN | 1C | Small danger-ghost in the current card, unchanged |
| U7 | Updates | Version field | O | AUTO / ADV | **Filled by picking a GitHub release**; manual under "Advanced: use your own build" |
| U8 | Updates | Installer address field | O | AUTO / ADV | Same (MSI `browser_download_url`) |
| U9 | Updates | SHA-256 field | O | AUTO / ADV | Same (the release's `SHA256SUMS`) |
| U10 | Updates | Size in bytes field | O | AUTO / ADV | Same (GitHub asset `size`) |
| U11 | Updates | "Setting the release ... asks you to confirm" notice | O | RM | Pill "Asks for your PIN" on the header |
| U12 | Updates | Set release button | O, PIN | UF | "Update PCs to 0.3.0", then a confirm dialog, then the PIN when needed |
| U13 | Updates | "Only an Owner can set the release." | A, V | UF | Keep, shorter |
| M1 | Members (`MembersTab.tsx`) | Members table (email + "You", role, status, joined), search, sort, pager, Table/Cards | all | UF | Keep (generic table from `lists-and-cards.md`) |
| M2 | Members | Invite member → dialog: email + native role select with role help line | O, PIN | UF | One main action; role becomes `Select` with `hint` per option (owner / admin / viewer meaning) |
| M3 | Members | Invite / reset code dialog (copy, shown once) | O | UF | Keep |
| M4 | Members | Four row buttons: Change role, Create reset code, Reset PIN and passkeys, Disable / Enable | O, PIN | 1C | **One "More" (`menu-dots`) menu per row** (`MenuList` as in `AccountMenu.tsx`); dialogs unchanged |
| M5 | Members | Pending invites table (email, for, sent, expires, Revoke); hidden when none | all / O | UF | Aside on laptop+ (compact list, same query) |
| M6 | Members | "Only an Owner ..." notice | A, V | UF | Keep |
| P1 | Security (`SecurityTab.tsx`) | Action PIN: state pill, Set / Change PIN dialog, `sec.pinRequiredHint` | self | UF | Layout only. `stepup.test.tsx` asserts `sec.pinRequiredHint`, `sec.synced`, `sec.passkeysOff` as visible text and the button names: they stay visible |
| P2 | Security | Passkeys list (name, synced, suspended, created, last used), Add / Rename / Remove, four notices | self | UF | Layout only |
| P3 | Security | Session: "Confirmed with ... 3 minutes ago", Lock now, lock hint | self | 1C | Slim strip at the top of the section |
| P4 | Security | Recovery codes left + Create new codes | self, PIN | UF | Layout only |
| P5 | Security | Change password (PIN first) | self, PIN | UF | Layout only |
| B1 | About (`AboutTab.tsx`) | Logo, name, MIT sentence | all | UF | Keep, plus "Source code" link to the repository |
| B2 | About | Dashboard version (+ demo badge) | all | UF | Keep |
| B3 | About | Dashboard API version | all | ADV | Technical details |
| B4 | About | Credits (Solar CC BY 4.0, fonts) + notices line | all | UF | Keep (licence credit is required) |
| B5 | About | "Open the design gallery" link | all | ADV | Technical details, demo and dev builds only (a developer tool) |

## 3. Information architecture

One page, a grouped **section nav** (links that set `?tab=`, `replace` history, as today). Order puts what people change
most first, rare and risky last. Sections that ask for the PIN carry an "Asks for your PIN" pill in their header; owner-only
sections carry a lock icon (`lock-keyhole-minimalistic-linear`, label "Owner only") in the nav for every role.

| Order | Group | Nav label | `?tab=` (unchanged id) | Changes | Contents |
|---|---|---|---|---|---|
| 1 | Organization | General | none / `organization` | A | Your organization (name), Employees on the PCs (offline sign-in, storage, power buttons), Plan and usage |
| 2 | Organization | Members | `members` | O | Members table, invite, row menu, pending invites |
| 3 | Your account | Your security | `security` | self | PIN, passkeys, recovery codes, password, session |
| 4 | PCs | Admin exit | `adminExit` | A + PIN | Switch, key combination, exit PIN, how it works |
| 5 | PCs | Rulebox updates (lock) | `updates` | O + PIN | Current target, GitHub releases picker, Advanced own build |
| 6 | System | Signing (lock) | `signing` | O + PIN | Status, notices; Advanced: key details, setup, rotation |
| 7 | System | About | `about` | none | Versions, credits, source link |

- **URL:** ids stay, so `/settings?tab=signing` (Overview), `?tab=security` (AccountMenu, PIN-setup banner from follow-ups
  "PIN setup" item 3), `e2e/check-ui.mjs` and every test path keep working. No id = General. Unknown id = General
  (`replace`). Switching section drops every other parameter (today's behaviour: Members' `page`/`sort`/`q`/`i*` must not leak);
  if `useUrlTab` keeps other params, Settings passes a clearing setter.
- **Why links, not `PageTabs`:** seven grouped destinations in a sidebar are navigation (`<nav aria-label="Settings sections">`,
  `aria-current="page"`, middle-click opens a new tab). On narrow widths the same links render as a horizontal strip styled
  like `PageTabs` (`dash-tabs` classes), the active one scrolled into view. One component: `settings/SectionNav.tsx`.
- **Lazy:** only the open section renders and queries (as today). Updates and Security stay separate chunks; Signing also
  becomes lazy (rarely opened).
- **Nav badges from data already loaded, zero extra reads:** Your security shows a warning dot when `me.pin.set` is false. No
  other badge (it would need a query per section).

## 4. Layout per band

Container queries on `.set-layout` (the whole Settings area) and `.set-section` (one section); the media query is only the
app shell's. CSS in `screens/settings/settings.css` (imported by `Settings.tsx`) and `settings/updates/updates.css` (Updates
chunk). Tokens only. Section switch: `dash-enter` (opacity + translateY 4 px, 160 ms; none with reduced motion or Lite).

| Band | Section nav | General | Members | Admin exit | Updates | Security |
|---|---|---|---|---|---|---|
| phone 390 | horizontal strip | one column; Save sticky at the bottom while dirty | Cards view default, invites below | one column | current card, list, sticky "Update PCs to X" bar once picked, Advanced last | one column |
| tablet 820 | horizontal strip | 2 columns: org name + plan / PCs card full | table, invites below | 2 columns (switch+keys / PIN) | one column, current card on top | 2 columns |
| laptop 1366 | vertical, 200 px, sticky | `dash-split` 2:1: main = name card over PCs card, aside = plan | split: table / aside invites | 2 columns + how-it-works strip | split: releases list / aside current + selected + main action (sticky) | session strip; grid 2: PIN, Recovery / Passkeys (span 2) / Password |
| wide 1920 | vertical, 220 px | 3 columns: name, PCs, plan | split 2:1 | 3 columns: switch+keys, PIN, how-it-works | split 2:1, notes show 6 lines | 3 columns: PIN, Recovery, Password; Passkeys full width |

Vertical nav from `.set-layout` width >= 880 px (laptop 1366 gives ~1080 px). Section content max width follows `dash-page`
(1480 px wide). Forms use `dash-form-grid` for short fields. No full-width stack on laptop+ anywhere.

### Settings, laptop (General open)

```
Settings
Choices for your whole organization.
+----------------+  +---------------------------------------------------------------------------+
| ORGANIZATION   |  | General                                                                   |
| > General      |  | +-- Your organization -----------------------+  +-- Plan and usage (i) -+ |
|   Members      |  | | Organization name (i)                      |  | Team plan             | |
| YOUR ACCOUNT   |  | | [ Acme Ltd                             ]   |  | PCs        12 of 25 = | |
|   Your security|  | +--------------------------------------------+  | Employees  40 of 100  | |
| PCS            |  | +-- Employees on the PCs --------------------+  | Apps        9 of 50   | |
|   Admin exit   |  | | Offline sign-in (i)   Storage per employee |  | Groups      3 of 10   | |
|   Rulebox upd. |  | | [ 3 days        v ]   [ 10 GB          v ] |  | Members     2 of 5    | |
| SYSTEM         |  | | Power buttons (i)                          |  | Codes       1 of 10   | |
|   Signing   [L]|  | | [x] Sleep  [x] Restart  [x] Shut down      |  +-----------------------+ |
|   About        |  | +--------------------------------------------+                            |
+----------------+  | [ Save changes ]  Unsaved changes                                         |
                    +---------------------------------------------------------------------------+
```

### Settings, phone (General open)

```
Settings
[General] [Members] [Your security] [Admin e...   <- scrolls
+-- Your organization ----------+
| Organization name (i)         |
| [ Acme Ltd                 ]  |
+-------------------------------+
+-- Employees on the PCs -------+
| Offline sign-in (i)           |
| [ 3 days                 v ]  |
| Storage per employee (i)      |
| [ 10 GB                  v ]  |
| Power buttons (i)             |
| [x] Sleep [x] Restart         |
| [x] Shut down                 |
+-------------------------------+
+-- Plan and usage -------------+
| Team plan . PCs 12 of 25 ...  |
+-------------------------------+
|######## [ Save changes ] #####|  <- sticky, only while dirty
```

### Updates, laptop (owner, list loaded, newest preselected)

```
Rulebox updates                                       [Asks for your PIN]
Choose the Rulebox version your PCs install. They update when nobody is signed in.
+-- Releases ------------------------------- Checked 2 min ago [Refresh] -+  +-- Your PCs update to ------+
| (o) Rulebox 0.3.0   [Newest] [Not code-signed (i)]          12 Dec 2026 |  | Rulebox 0.2.1    [Current] |
|     Fixes printing on shared PCs. Faster sign-in ...     Show notes v   |  | 36.2 MB . Rulebox-0.2.1... |
|     View on GitHub ->                                                   |  | > Technical details        |
| ( ) Rulebox 0.3.0-rc1  [Test build (i)]                      5 Dec 2026 |  | [Stop updating]            |
|     ...                                                                 |  +----------------------------+
| ( ) Rulebox 0.2.1   [Current]                               20 Nov 2026 |  +-- Selected ----------------+
| (-) Rulebox 0.2.0   Can't be used: no checksum file.        12 Nov 2026 |  | Rulebox 0.3.0 . 38.4 MB    |
+-------------------------------------------------------------------------+  | ! warnings, if any         |
> Advanced: use your own build                                               | [ Update PCs to 0.3.0 ]    |
                                                                             +----------------------------+
```

### Updates, phone

```
Rulebox updates          [PIN]
Choose the version your PCs install.
+-- Your PCs update to ---------+
| Rulebox 0.2.1  [Current]      |
| 36.2 MB  > Technical details  |
+-------------------------------+
Releases       [Refresh]
+-------------------------------+
| (o) Rulebox 0.3.0  [Newest]   |
|     12 Dec . Not code-signed  |
|     Fixes printing ... more v |
+-------------------------------+
| ( ) Rulebox 0.3.0-rc1 [Test]  |
+-------------------------------+
> Advanced: use your own build
|##### [ Update PCs to 0.3.0 ] #|  <- sticky once a release is picked
```

## 5. Updates from GitHub releases

### 5.1 Facts found

- Repository: `zubairbinshaukat/rulebox` (git remote, `apps/website/src/config.ts` `REPO_URL`, `docs/guides/release.md`).
- `release.yml`: tag `vX.Y.Z` or `vX.Y.Z-suffix` publishes a GitHub release (suffix = `prerelease: true`); manual runs are dry
  runs that only upload workflow artifacts (never visible in the releases API, so "empty until the first `v*` release" is
  automatic). Assets: exactly one MSI named `Rulebox-<X.Y.Z>-x64.msi` (signed) or `Rulebox-<X.Y.Z>-x64-unsigned.msi`, and
  `SHA256SUMS` (`<64 lower hex>␠␠<file name>\n`, LF, no BOM). A re-run of a tag replaces the files (`gh release upload --clobber`).
- The MSI and the agent carry only `X.Y.Z` (`RULEBOX_VERSION` = `steps.ver.outputs.version`), never the suffix. The agent updates
  only to a **higher** version than it runs (`selfupdate.rs` `decide`).
- `convex/lib/safeFetch.ts` `fetchPublic` is the only network reader (https, public host, redirects re-checked, size cap,
  deadline). It treats any 3xx without `Location` as a failure, so a 304 needs a small extension (5.2).
- `GITHUB_TOKEN` (optional env, `convex.config.ts`) already raises winget's limit; the same token serves here.
- CSP (`vite.config.ts`, `public/_headers`, `vercel.json`): `connect-src 'self' *.convex.cloud/site` only. The browser cannot
  and does not call GitHub; the "View on GitHub" link is a navigation (not governed by `connect-src`); notes render as text, so
  `img-src` never meets a GitHub image. **No CSP change.** Offline-first holds: nothing is loaded from GitHub at runtime in the
  browser; the server action does the fetch.

### 5.2 The action

`convex/ruleboxRelease.ts`: `export const githubReleases = memberAction("owner")({ ... })` (owner, an **unlocked** session, not
a major action: it only reads public data; saving stays `ruleboxRelease:set`, major). Pure logic and the cache in a new
`convex/lib/githubReleases.ts`.

- **Args:** `{ refresh: v.optional(v.boolean()) }`.
- **Returns** (validator `githubReleasesResult`; also mirrored as a TS type in `data/release/api.ts`):

```ts
type GithubReleasesResult =
  | { status: "ok"; repoUrl: string; checkedAt: number; stale: boolean; releases: GithubRelease[] }
  | { status: "unavailable"; reason: "rate_limited" | "unreachable" | "not_found"; retryAt?: number };

type GithubRelease = {
  tag: string;               // "v0.3.0-rc1"
  title: string;             // release name, or "Rulebox <tag without v>"; max 120 chars
  version: string;           // "0.3.0": X.Y.Z from the MSI name = what the agent reports after installing it
  prerelease: boolean;
  publishedAt: number;       // ms
  pageUrl: string;           // html_url, must start with https://github.com/<repo>/releases/
  notes: string;             // body as plain text source, <= 4,000 chars, "\r" and <!-- --> removed
  notesTruncated: boolean;
  signed: boolean;           // MSI name without "-unsigned"
  msi: { name: string; url: string; sizeBytes: number; sha256: string } | null; // null when problem !== null
  problem: null | "no_msi" | "two_msis" | "version_mismatch" | "no_checksums" | "checksums_unreadable"
              | "not_in_checksums" | "hash_mismatch" | "too_large" | "invalid";
};
```

- **Upstream calls:** `GET https://api.github.com/repos/<repo>/releases?per_page=10` with `accept: application/vnd.github+json`,
  `x-github-api-version: 2022-11-28`, `user-agent: rulebox-dashboard` (generic, no personal data), `if-none-match: <etag>` when
  cached, and `authorization: Bearer <GITHUB_TOKEN>` **only for host `api.github.com`** (`headers(url)` callback). Body cap 2 MiB,
  deadline 8 s. Then, in parallel for each candidate release, `SHA256SUMS` from its `browser_download_url` (redirects to the
  GitHub asset host are followed by `fetchPublic` with checks; no token; cap 16 KiB; deadline 5 s each). The whole action is
  bounded at ~15 s. Release-asset downloads do not use the REST API quota.
- **Per release, in this order:** skip `draft`; tag must match `^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$` (else skipped: not a
  Rulebox release); MSI = assets matching `^Rulebox-(\d+\.\d+\.\d+)-x64(-unsigned)?\.msi$` with `state === "uploaded"` (0 →
  `no_msi`, 2+ → `two_msis`); MSI `X.Y.Z` must equal the tag's (`version_mismatch`); `browser_download_url` must start with
  `https://github.com/<repo>/releases/download/` (`invalid`); `size` 1..`MAX_RELEASE_BYTES` (`too_large`); `SHA256SUMS` asset
  present (`no_checksums`), readable (`checksums_unreadable`); parse strictly line by line `^([0-9a-f]{64}) [ *](.+)$`, the MSI
  name must match a line **exactly** (`not_in_checksums`; the website's `endsWith` is too loose); when GitHub's own asset
  `digest` (`"sha256:<hex>"`) is present it must equal the `SHA256SUMS` value (`hash_mismatch`); finally the candidate runs
  through `normalizeRelease` (`invalid` on a throw), so a picked release can never be refused by `set`.
- **Rate limits:** 403/429 with `x-ratelimit-remaining: 0` → `retryAt = x-ratelimit-reset * 1000`; `retry-after` (secondary
  limit) → `now + seconds`. Both set a module-level `blockedUntil` so no call goes upstream before it. Unauthenticated is 60/h
  **per IP**, and Convex cloud actions share egress IPs, so the limit can be used up by others: the (i) text says the server's
  operator can add a token (already documented in `README.md` for winget). A 304 saves the quota only for authenticated calls
  (GitHub's rule); without a token it still saves bandwidth and parsing.
- **Errors:** 404 → `not_found` (repo renamed or private); other status, bad JSON, network, timeout → `unreachable`. Every
  upstream failure with a cached list answers that list with `stale: true` instead. Only authorization errors throw
  (`unauthenticated`, `forbidden`, `step_up_required`, ...). **No new error code** (the union is the answer).
  `console.warn` the status and reason, never headers or tokens.
- **Caching: no database reads or writes beyond the member check.** Module-level state in `lib/githubReleases.ts`:
  `listCache { repo, etag, checkedAt, releases }`, TTL 10 min; `shaCache: Map<"<assetId>:<updated_at>", sha | problem>`, at most 50
  entries (oldest dropped; the key changes when a tag re-run replaces a file); `lastUpstreamAt` with a 30 s minimum gap even for
  `refresh: true`; `blockedUntil`. Fresh cache and no refresh → no network. Refresh → conditional request; 304 → `checkedAt = now`.
  The cache is per isolate and may be lost at any time (Convex reuses warm isolates but does not promise it); a cold call simply
  goes upstream. The cache holds only public release data, so sharing it across organizations on one deployment is safe.
  Rejected: a `githubReleaseCache` table (1 read per call + 1 write per refresh, against the owner's "no database reads") and the
  rate-limiter component (1 read + 1 write per call).
- **Repository:** constant `DEFAULT_RELEASES_REPO = "zubairbinshaukat/rulebox"`, overridable by a new optional env
  `RULEBOX_RELEASES_REPO` (`owner/name`, `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`, else the default) for forks and self-hosters.
- **`fetchPublic` extension** (`lib/safeFetch.ts`, additive): option `ifNoneMatch?: string`; a 304 answers
  `{ ok: false, reason: "not_modified" }`; `Fetched` gains `headers: Headers` on success and on `status` failures (for ETag and
  rate-limit headers). Existing callers do not pass the option and ignore the field.
- **Trust note (plan only, not UI):** until SignPath signing is live, the hash comes from the same place as the file (same-source
  trust): whoever can replace the MSI on the release can replace `SHA256SUMS` too. The GitHub `digest` cross-check only catches
  corruption, not a compromised release. The protection is the repository's own access control; once signing is live the agent's
  signer rule (`selfupdate.rs`) adds the second, independent check.

### 5.3 How the dashboard calls it

Actions are not reactive. `useGithubReleases(enabled)` in the release seam: runs once when the Updates section mounts **for an
owner** (`enabled = useCan("owner")`; admins and viewers never call it), never polls, never on focus. Client cache: a module
variable in `data/release/live.ts` keeps the last `ok` answer for 5 minutes, so switching sections and back does not call again
(memory only: no localStorage, so a stale hash never survives a reload). "Refresh" calls with `refresh: true`, keeps the old list
on screen while it runs, and is disabled for 30 s after a call. Late answers after unmount are dropped. Through `useMapped`, so a
locked session opens the unlock dialog and retries once.

Shape: `{ state: { status: "idle" | "loading" } | { status: "ready"; data: GithubReleasesResult } | { status: "error"; error: unknown };
refreshing: boolean; refresh(): void }`.

### 5.4 Picker states

| State | What shows |
|---|---|
| loading | Releases card with 3 skeleton rows; the current card renders from `ruleboxRelease:get` independently |
| empty (`ok`, `[]`) | Compact empty state: "No releases yet" + "New Rulebox versions appear here when they are published. To use your own build, open Advanced." Advanced open by default |
| unavailable / error | Inline warning in the Releases card ("Couldn't load the releases from GitHub." / "GitHub is busy. Try again after 14:05." with (i)), Try again button; Advanced stays usable |
| stale | List + small neutral line "Showing the list from 12 minutes ago." |
| list | `role="radiogroup"` of release rows; disabled rows (problem) show "Can't be used: <reason>." and are not selectable; notes clamped to 3 lines (6 wide) with "Show notes" (`aria-expanded`); "View on GitHub" opens a new tab (`rel="noopener noreferrer"`) |
| default pick | The newest usable non-pre-release that is **newer** than the current target is preselected; if the target is already the newest, a success line "Your PCs are set to the newest release." and nothing preselected |
| picked | Aside "Selected": title, size, badges, warnings (5.6); main button "Update PCs to 0.3.0" (sticky bar on phone) |
| saving | Button busy "Saving...", radio group and Advanced fields disabled |
| saved | Toast "Saved. PCs install Rulebox 0.3.0 when nobody is signed in."; the subscription updates the current card; the row shows "Current"; selection cleared |
| refused | `FormError` under the button: step-up cancelled, `stale_edit` with Reload, server field error (maps to the Advanced field) |
| not owner | No Releases card, no Advanced; current card + "Only an Owner can choose the update." |

Saving flow: button → `ConfirmDialog` ("Update every PC to Rulebox 0.3.0?" / "Each PC downloads it, checks it and installs it when
nobody is signed in. PCs never go back to an older version." / "Update PCs") → `ruleboxRelease:set` (unchanged; major, so the
PIN dialog appears when the last confirmation is not fresh).

### 5.5 Manual path (Advanced)

`<details class="dash-advanced">` "Advanced: use your own build" holds today's four fields (Version, Installer address, SHA-256,
Size in bytes) with (i) texts, all in **one form state** with the picker: picking fills them; editing any field turns the selection
into "Your own build" (the radio group clears) and the main button reads "Update PCs to <typed version>". Validation is today's
`releaseRules.ts` (unchanged, inline errors, `aria-describedby`), run on submit and live after the first attempt. The same-release
check (`sameRelease`, toast "Nothing changed.") stays.

### 5.6 Warnings (inline, never only in a tooltip)

Pure `relationToCurrent(candidate, current)` in `updates/pickRules.ts`:
- `older` (version lower than the current target): "This is older than the version you chose before. PCs that already have a newer
  one keep it."
- `sameVersionOtherBuild` (same version, other hash): "PCs that already run 0.3.0 keep their copy."
- `changed` (same URL as the current target, other hash, i.e. the tag was re-run): on the row and the current card: "This release's
  installer was replaced on GitHub. Choose it again so your PCs get the new copy."
- pre-release: "This is a test build. It goes to every PC." (there are no rings for Rulebox's own update)
- unsigned: badge "Not code-signed" with (i) "Windows may warn when someone opens this installer by hand. Your PCs install it
  without asking." (PRD 23.8)

### 5.7 Release notes rendering

`updates/releaseNotes.ts` (pure): `notesBlocks(text) → Block[]` with `heading | bullet | paragraph`; markdown markers are stripped
(`#`, `**`, `__`, backticks, `[text](url)` → `text`, images dropped, HTML tags removed as text). `ReleaseNotes.tsx` renders the
blocks as React text nodes only: no `dangerouslySetInnerHTML`, no links inside notes, no markdown library (bundle stays small).

## 6. Data

| Section | Queries / actions (unchanged unless noted) | Reads per run | Re-runs when |
|---|---|---|---|
| Nav | none (`me`, already loaded) | 0 | |
| General | `settings:get` + `settings:plan` (two cards, as today) | 4 + 7 | org row / orgPlans, orgStats change |
| Members | `members:page` + `members:invitesPage` (as today) | bounded pages | member / invite rows |
| Your security | `stepUp:status` | as today | own rows |
| Admin exit | `settings:get` | 4 | org row |
| Rulebox updates | `ruleboxRelease:get` (live) + **new** action `ruleboxRelease:githubReleases` (owner only, on open / Refresh) | 4 + authorize only (3 measured, 24 worst) | query: org row; action: never re-runs by itself |
| Signing | `keys:status` (+ `keys:trustProgress` pages only while a `next` key exists) | as today | key rows, counters |
| About | none | 0 | |

- **No new index, no new table, no new query.** The only new function is the action.
- `convex/ioBudgets.ts`: add, next to the two `ruleboxRelease` rows:
  `"ruleboxRelease:githubReleases": { maxReads: 4 + 20, maxReadBytes: 12_000, maxWrites: 0, maxWriteBytes: 0 }` with the comment
  "authorize only (session, member, step-up row; worst case + memberships); the GitHub calls are outside the database and nothing is
  stored; owner-only, on opening the Updates section or Refresh; never subscribed". `ioBudgets.test.ts` must stub `fetch`
  (`vi.stubGlobal`) for this row so it never reaches the network.
- **Signing seam (no new query):** `keys:status` already returns `orgKeys`; `useLiveKeysScreen` drops it. Add to `KeysScreen`
  (`data/types.ts`): `managed: "keyring" | "deployment"` (`orgKeys.signing !== null`) and `keyringLocked: boolean`
  (`orgKeys.locked`); live mapper in `data/live/hooks.ts`, demo twin in `data/demo/*` (demo org = `keyring`).
- **Release seam:** `data/release/api.ts` adds `GithubRelease`, `GithubReleasesResult`, `useGithubReleases`; `live.ts` wraps
  `useAction(api.ruleboxRelease.githubReleases)` with the client cache; `demo.ts` answers a **fake list** after 500 ms: v0.3.0
  (newest, unsigned, notes with headings and bullets), v0.3.0-rc1 (pre-release), v0.2.1, v0.2.0 (problem `no_checksums`), with
  hashes `"3".repeat(64)` etc. and GitHub-shaped URLs; demo-only URL parameter `demoReleases=empty|unavailable|rate` shows the other
  states for screenshots. Owner-only in demo too (non-owner: the hook stays idle).
- `apps/dashboard/src/data/README.md`: one row for `useGithubReleases`, the `KeysScreen` fields.

## 7. Strings

New sentences live where their section's strings live today: Settings shell, groups, Members, Signing, About in
`lib/screenStrings/settings.ts`; General, Admin exit, Updates in `screens/settings/strings.ts` (lazy). Security keeps
`lib/stepup/strings.ts` untouched (shared with the PIN-setup agent). Plain labels; (i) at most ~3 short sentences.

| Where | Label | (i) text |
|---|---|---|
| Shell | "Settings" / lead "Choices for your whole organization." | |
| Nav groups | Organization, Your account, PCs, System | |
| Nav | General, Members, Your security, Admin exit, Rulebox updates, Signing, About; lock label "Owner only" | |
| Pill | "Asks for your PIN" | "Saving this asks for your PIN or a passkey, because it changes every PC." |
| General | Card "Your organization"; "Organization name" | "Shown on the sign-in screen of every PC." |
| General | Card "Employees on the PCs"; "Offline sign-in": Off, 1 day, 3 days, 7 days, 14 days, 30 days, "N days" | "How long employees can still sign in on a PC without internet. Off: they need the internet to sign in." |
| General | "Storage per employee": Unlimited, 1 GB ... 100 GB | "Space for each employee's files. You can change it for one employee on their page." |
| General | "Power buttons": Sleep, Restart, Shut down | "The power buttons employees see on the PCs." |
| Plan | "Plan and usage"; rows as today | "Audit log kept for N days." (moved here) |
| Admin exit | Card "Admin exit"; switch "Allow admin exit on PCs" | "An administrator can leave the kiosk on a PC: press the key combination, then type the exit PIN. Employees don't see it." |
| Admin exit | "Key combination", "Change", recorder "Press the keys now", "Esc to cancel", "Use Ctrl+Shift+F12", Advanced "Type it instead" | "Ctrl or Alt, optional Shift, plus one letter, digit or F1-F12." |
| Admin exit | Card "Exit PIN"; strip "How it works": 1 "Press the keys on the PC", 2 "Type the exit PIN", 3 "The kiosk closes for you" | PIN field: "6 to 12 digits, no simple runs. It is not your own dashboard PIN." |
| Updates | Title "Rulebox updates"; lead "Choose the Rulebox version your PCs install. They update when nobody is signed in." | |
| Updates | "Your PCs update to", "No update chosen" / "PCs keep the version they have.", "Technical details", "Stop updating" | |
| Updates | "Releases", "Refresh", "Checked {relative}", "Newest", "Current", "Test build", "Not code-signed", "Show notes", "Hide notes", "View on GitHub" | Test build: "A pre-release for trying out first." |
| Updates | Problems: "Can't be used: the release has no installer." / "... has two installers." / "... its version doesn't match." / "... has no checksum file." / "... its checksum file can't be read." / "... the installer isn't in its checksum file." / "... the checksum doesn't match." / "... it is too large." / "... it isn't a valid release." | |
| Updates | "Couldn't load the releases from GitHub.", "GitHub is busy. Try again after {time}.", "Showing the list from {relative}.", "Try again" | Busy: "If this keeps happening, the person who runs your Rulebox server can add a GitHub token." |
| Updates | Main "Update PCs to {version}", "Saving...", confirm title/body/button (5.4), saved toast, "Only an Owner can choose the update." | |
| Updates, Advanced | "Advanced: use your own build"; "Version", "Installer address", "SHA-256", "Size in bytes", "Your own build" | "For example 0.3.1. PCs only move to a higher version." / "A direct https:// link to the .msi file." / "The file's checksum, 64 characters. PCs refuse a file that doesn't match." / "The exact file size, up to 1 GB." |
| Members | "Invite member", role options with hints (owner/admin/viewer as today), "More actions for {email}" | Role column: the three role meanings |
| Signing | "Changes to your PCs are signed automatically." / "Changes are signed with your server's key." / locked: "Rulebox can't open this organization's keys on this server. Nothing new reaches the PCs. Ask the person who runs your Rulebox server." | |
| Signing | Advanced "Key details", "Set up the key", "Rotate the key", "If something goes wrong" | |
| About | "Source code", "Technical details" | |

Existing problem sentences in `updates.problems` stay (Advanced). Removed strings: `updates.fresh`, `updates.formLead`,
`exit.enabledHint`, `updates.sizeBytes` (moves into Technical details only).

## 8. Edge cases and roles

| Role | General | Members | Security | Admin exit | Updates | Signing |
|---|---|---|---|---|---|---|
| Viewer | read-only (disabled fields, notice) | table only | own | read-only | current target only | status only, no buttons |
| Admin | edit | table only + notice | own | edit (PIN) | current target only, no action call | status only |
| Owner | edit | all actions (PIN) | own | edit (PIN) | picker + Advanced + Stop (PIN) | all (PIN) |

- **No release yet on GitHub (today's real state):** empty state, Advanced open; dry runs never appear.
- **Pre-release and final share `X.Y.Z`:** the agent reports `0.3.0` for both `v0.3.0-rc1` and `v0.3.0`, so PCs that installed the rc
  treat the final as "Current" and never install it. The picker shows the pre-release warning; the real fix is in the release
  process (Decision D12).
- **Tag re-run replaced the MSI:** `changed` warning (5.6); PCs that downloaded the old file fail `hash_mismatch` and wait for a new
  release, so the owner must pick it again.
- **Current target not in the list** (own build, or older than the 10 newest): current card shows it; no row says "Current".
- **Every release unusable:** list with reasons + "Use Advanced for your own build."
- **Rate limited / GitHub down / browser offline:** warning + Try again; Advanced works; cached list shown as stale when present.
- **Session locks while open:** the lock screen covers it; `useMapped` retries the action after unlock.
- **Two owners:** `stale_edit` + Reload (as today).
- **Very long notes / title, HTML in notes:** server truncates at 4,000 chars; client clamps lines; everything is text.
- **Hostile response:** URLs outside `https://github.com/<repo>/releases/...` are refused per release (`invalid`); sizes, counts and
  bodies are capped; JSON shape checked field by field.
- **Fork / self-host:** `RULEBOX_RELEASES_REPO`.
- **Admin exit recorder:** browser-reserved combinations never reach the page; the Advanced text field covers them. Recorder
  ignores lone modifiers, shows the canonical form, Esc cancels, blur cancels.
- **Offline sign-in / storage stored outside the presets:** shown as an extra option, saved unchanged unless the user picks another.
- **Members:** no menu on your own row (as today); last-owner rules stay on the server.
- **Signing, keyring org:** no env warning, no CLI, no rotation (server refuses); keyring locked → danger notice for everyone.
- **Phone:** sticky bars never cover the last field (bottom padding = bar height); the section strip scrolls the active link into view.

## 9. Tests

Existing tests that change:
- `screens/settings/UpdatesTab.test.tsx`: current-card assertions move (URL and SHA inside Technical details, size without bytes);
  form tests target the Advanced fields (labels unchanged) and the new button name "Update PCs to ..." + the confirm dialog step;
  owner-only test also asserts `ruleboxRelease:githubReleases` is never called for admin/viewer.
- `screens/settings/releaseRules.test.ts`: unchanged (rules unchanged).
- `data/release/demo.test.tsx`: add the fake list (owner only, states via `demoReleases`).
- `screens/step5.test.tsx`: Organization number inputs → `Select` options (offline days, quota, extra stored value); admin-exit
  hotkey tests use the Advanced text field (label unchanged) plus new recorder tests.
- `app/app.test.tsx` (OrganizationTab save, read-only), `screens/lists4b.test.tsx` and `screens/auth.test.tsx` (Members: row actions
  through the "More" menu; URL `?tab=members&page=2` unchanged), `screens/step17.test.tsx` (SigningTab: `managed`, keyring hides env
  warning and rotation; deployment case unchanged).
- `stepup/stepup.test.tsx` must pass **unchanged** (Security is layout only; asserted texts stay visible).
- `tests/convex/matrixRows.ts`: row `ruleboxRelease:githubReleases`, `call: (a) => a.action(api.ruleboxRelease.githubReleases, {})`,
  `expect: { ...OWNER, ownerStale: "ok", foreign: "ok" }` (owner, unlocked; fetch stubbed to answer `[]`).
- `e2e/check-ui.mjs`: add `["settings-updates", "/settings?tab=updates"]`.

New tests:
- `convex/githubReleases.test.ts` (pure, `fetch` injected, no network): list parsing and every `problem`; tag filter; drafts skipped;
  `SHA256SUMS` exact-name match, `*name` form, CRLF, uppercase hex rejected, duplicates; `digest` mismatch; size cap; URL prefix;
  notes truncation and comment stripping; 304 reuses the cache; TTL; 30 s gap; `blockedUntil` from `x-ratelimit-reset` and
  `retry-after`; stale answer on failure; 404 `not_found`; timeout `unreachable`; token sent only to `api.github.com`; sha cache key
  changes with `updated_at`.
- `convex/ruleboxRelease.test.ts`: the action through convex-test with `vi.stubGlobal("fetch", ...)`: owner ok, admin/viewer
  `forbidden`, locked `step_up_required`, **zero writes** (probe), a picked release passes `ruleboxRelease:set` unchanged.
- `convex/lib/safeFetch` behaviour (in `githubReleases.test.ts` or `webmeta.test.ts`): `ifNoneMatch` sends the header, 304 →
  `not_modified`, headers returned.
- `screens/settings/updates/pickRules.test.ts`: `fieldsOfGithub`, `relationToCurrent` (older, same, other build, changed),
  `defaultPick`.
- `screens/settings/updates/releaseNotes.test.ts`: blocks; `<script>`, `<img>`, links and markdown become plain text.
- `screens/settings/UpdatesTab.test.tsx` (new cases): every state of 5.4 (loading, empty, unavailable, rate limited with time, stale,
  list, disabled rows, default pick, picked + warnings, saving, saved, refused); Refresh calls with `refresh: true` and is disabled
  for 30 s; client cache (remount within 5 min: no second call); editing an Advanced field clears the radio selection; notes render
  as text.
- `screens/settings/Settings.test.tsx` (new): nav groups and order, `aria-current`, unknown id → General, switching drops other
  params, lock icon on owner-only items, only the open section queries.
- `screens/settings/HotkeyRecorder.test.tsx`: capture, canonical form, lone modifier ignored, Esc, invalid combination message.

## 10. Build steps

Each step is one Sonnet agent. Run `pnpm test:convex` for Convex steps, typecheck + lint + the touched tests for dashboard steps.
**Wave 1 can start now; waves 2-3 need the foundations** (`Select`, `InfoTip`, `Field info`, `useUrlTab`, layout classes).

| Step | Wave | Files | Depends on |
|---|---|---|---|
| 1 | 1 (parallel) | `convex/lib/safeFetch.ts` (`ifNoneMatch`, `not_modified`, `headers`) + its tests | |
| 2 | 1 | `convex/lib/githubReleases.ts` (pure parse, normalize, caches, `listGithubReleases(repo, opts)` with injectable `fetch`, `now`), `convex/githubReleases.test.ts`, hand-add the module to `convex/_generated/api.d.ts` (import + map line, as other no-deploy steps did) | 1 |
| 3 | 1 | `convex/ruleboxRelease.ts` (`githubReleases` action + validator), `convex/convex.config.ts` (`RULEBOX_RELEASES_REPO`), `convex/ioBudgets.ts` row, `tests/convex/matrixRows.ts` row, `convex/ruleboxRelease.test.ts` cases, `ioBudgets.test.ts` fetch stub | 2 |
| 4 | 1 (parallel) | `screens/settings/updates/pickRules.ts`, `updates/releaseNotes.ts` + tests (pure) | |
| 5 | 1 | `data/release/api.ts`, `live.ts` (client cache), `demo.ts` + fake fixtures, `demo.test.tsx`, `data/README.md` row | 3 (types of `api`) |
| 6 | 1 (parallel) | `data/types.ts` `KeysScreen.managed/keyringLocked`, `data/live/hooks.ts` mapper, demo twin | |
| 7 | 2 | `screens/settings/SectionNav.tsx`, `settings/settings.css`, `screens/Settings.tsx` (groups, lazy Signing, param clearing), shell strings, `Settings.test.tsx` | foundations |
| 8 | 2 (parallel) | `UpdatesTab.tsx` rewrite + `updates/{CurrentRelease,ReleasePicker,ReleaseNotes,CustomBuild}.tsx` + `updates/updates.css`, strings, `UpdatesTab.test.tsx` | 4, 5, foundations |
| 9 | 2 (parallel) | `OrganizationTab.tsx` (cards, presets `Select`, plan aside, sticky save), strings, `step5.test.tsx` + `app.test.tsx` parts | foundations |
| 10 | 2 (parallel) | `AdminExitTab.tsx` + `settings/HotkeyRecorder.tsx` + test, how-it-works strip, strings, `step5.test.tsx` hotkey parts | foundations; after 9 if both edit `step5.test.tsx` (same agent order: 9 then 10) |
| 11 | 2 (parallel) | `MembersTab.tsx` (row "More" menu, `Select` role with hints, invites aside), `lists4b.test.tsx`, `auth.test.tsx` | foundations, `lists-and-cards.md` table changes merged |
| 12 | 2 (parallel) | `SecurityTab.tsx` layout only (grid, session strip); `stepup.test.tsx` must stay green untouched | foundations |
| 13 | 2 (parallel) | `SigningTab.tsx` (status line, keyring vs deployment, Advanced), `step17.test.tsx` | 6, foundations |
| 14 | 2 (parallel) | `AboutTab.tsx` (source link, Technical details, gallery only in demo/dev) | foundations |
| 15 | 3 | Screenshots 390/820/1366/1920 light+dark of every section (port 4342, incl. `?tab=updates&demoReleases=empty`), `e2e/check-ui.mjs` path, size budget check (`scripts/size.mjs`, report any raise), plan status in `docs/plans/README.md` | all |

## 11. Decisions taken (recommended option each)

| # | Decision | Options | Taken |
|---|---|---|---|
| D1 | Section navigation | (a) keep one tab row, (b) grouped section nav: vertical on laptop+, strip on narrow, (c) a Settings home page with cards | **(b)**: grouped, uses the width, no new summary query (c would need one query joining 5 sources) |
| D2 | Nav semantics | (a) `PageTabs` (tablist), (b) links with `aria-current` | **(b)**: it is navigation; styled like `PageTabs` on narrow |
| D3 | Section order | as today / by frequency of use | **By frequency**: General, Members, Your security, Admin exit, Rulebox updates, Signing, About |
| D4 | URL ids | rename to match labels / keep | **Keep** (`organization`, `adminExit`, ...); no aliases |
| D5 | Offline days and storage inputs | number fields / presets `Select` / slider | **Presets `Select`** + the stored value as an extra option |
| D6 | Hotkey input | text only / recorder only / recorder + text under Advanced | **Recorder + Advanced text** (browser-reserved combinations) |
| D7 | Fetch releases where | browser / Convex action | **Convex action** (offline-first, CSP, token stays on the server) |
| D8 | Action role and step-up | owner major / owner unlocked / admin | **Owner, unlocked**: reading public data; saving stays major |
| D9 | Server cache | database table / rate-limiter component / module-level cache + ETag | **Module-level cache** (10 min TTL, 30 s gap, `blockedUntil`, ETag): zero database reads beyond the member check |
| D10 | Client cache | none / localStorage / memory 5 min | **Memory, 5 min**: no stale hash after a reload |
| D11 | When it runs | on open / on open + Refresh / polling | **On open (owners only) + Refresh** |
| D12 | Which version to fill | tag (`0.3.0-rc1`) / MSI `X.Y.Z` | **MSI `X.Y.Z`** (what the agent reports); warn on pre-releases. Recommend separately that the release workflow builds the agent with the full tag version (needs `AllowSameVersionUpgrades` or a 4th MSI field): installer and workflow are out of this pass |
| D13 | Hashes | `SHA256SUMS` only / GitHub `digest` only / `SHA256SUMS` + `digest` cross-check | **`SHA256SUMS`, cross-checked with `digest` when present** |
| D14 | When to read `SHA256SUMS` | on pick (second action) / in the list call | **In the list call, in parallel, cached per asset**: picking is instant, one action |
| D15 | How many releases | all pages / newest 10 | **Newest 10**; older ones via Advanced |
| D16 | Unusable releases | hide / show disabled with reason | **Show disabled with reason** |
| D17 | Default pick | none / newest stable if newer than current | **Newest stable if newer** |
| D18 | Confirm before saving | PIN only / confirm dialog + PIN | **Confirm dialog + PIN** (a fresh PIN skips the PIN prompt; a fleet-wide install deserves one explicit click) |
| D19 | Release notes | markdown library / HTML / plain-text blocks | **Plain-text blocks**, no library, no links in notes |
| D20 | Errors from the action | new error codes / result union | **Result union**; only auth errors throw; no `ERROR_CODES` change |
| D21 | Repository | hard-coded / env override | **Default constant + optional `RULEBOX_RELEASES_REPO`** |
| D22 | Signing for keyring orgs | as today / status line, hide env warning, CLI and rotation | **Hide** (server refuses rotation there; the env warning is false). Behaviour fix of misleading UI, no server change |
| D23 | `keys:migrateFromEnv` button for old orgs | add / not now | **Not now** (only legacy dev orgs; existing orgs already migrated) |
| D24 | Members row actions | four buttons / "More" menu | **"More" menu** (`MenuList`) |
| D25 | Design gallery link | keep / remove / Technical details in demo+dev | **Technical details, demo and dev only** |
| D26 | Signing chunk | eager / lazy | **Lazy** like Updates and Security |
| D27 | Strings for Security | edit `lib/stepup/strings.ts` / reuse | **Reuse**; that file is shared with the PIN-setup agent |

## 12. Changes to tell the owner (PRD or behaviour)

- **New:** Rulebox updates are picked from GitHub releases (PRD 23 does not describe the dashboard side; plan 4.17 gets a line).
- **New:** a confirm dialog before setting the release (D18).
- **Fix:** keyring organizations no longer see "RULEBOX_POLICY_KEY is not set" or the env rotation steps (D22).
- **Risk found:** pre-release and final of the same `X.Y.Z` look identical to the agent (D12); PCs on an rc never move to the final.
- **Trust:** same-source hash until SignPath (5.2); `GITHUB_TOKEN` recommended on cloud deployments (shared egress IPs).
