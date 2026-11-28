# Lists and cards: generic table, Table | Cards view, list pages (UI pass, 2026-11-28)

Status: **planned, decisions taken with the recommended option** (owner reviews afterwards, see "Decisions taken").
Spec: `docs/plans/follow-ups.md` "NEXT after VM run A3", sections 1 (generic table), 2 (Cards view, Opus plan),
3 (sort and rows-per-page selects), 6 (desktop layouts), "Users are not technical". Contract: `README.md` in this
folder (Select, InfoTip, `placeFloating`, layout classes, width bands). Builds on `docs/plans/phase-4b-tables-and-pin.md`
(server-driven lists: one page per query, sort/search on the server, cursor pager).

Screenshots of the problem: `.personal/ui-pass-2026-11-28/01-table-wrap.png` (short cells wrap: "0 of 1 used",
"4 minutes ago"), `02-table-footer-narrow.png` (footer falls apart at ~700 px), `03-cards-view.png` (a card is a
full-width list of label ... value pushed to the far right, one card per row), `04-native-dropdown.png`.

## 0. What exists today (read before building)

- `components/DataTable.tsx`: one semantic `<table>`; `Column<T>` = `key, header, cell, primary, actions, numeric,
  className, isEmpty, sortable, sortDefaultDir`. Cards view is **CSS only**: `html[data-view="cards"]
  .dash-table--stack` turns `tr`/`td` into `display: block` and prints `td::before { content: attr(data-label) }`
  with `justify-content: space-between` (the far-right values in `03`). A sort `<select>` appears in the toolbar in
  cards view (CSS `:has`).
- `components/ServerTable.tsx`: wires `useListPaging` + a list hook to `DataTable` + `Pager` + `SearchInput`.
- `components/Pager.tsx`: grid summary | nav | size; stacks at `@container (max-width: 679px)` with the summary
  centred alone and the size row `space-between` (the broken look in `02`).
- `lib/viewMode.ts` + `boot/boot.js`: one global `rulebox.view` (`table` default at every width) put on
  `<html data-view>` before first paint. `ViewSwitch` sits in the toolbar of framed tables and in `AccountMenu`.
- Container widths of a page-level list today (`--dash-max` 1200, sidebar 256 ≥ 1100 px, rail 76 at 768–1099):
  **390 → 358 px, 820 → ~692 px, 1366 → ~1030 px, 1920 → 1200 px** (1480 px once foundations raises the wide max).

## 1. Inventory: every list, every field, its table type and its card role

Roles: **title** (one per list, the record's name, also the link), **subtitle** (one short line under the title),
**status** (state words and pills: the badge row), **fact** (the 2-4 values people compare across records, label
above value), **detail** (secondary and technical values, muted, last), **actions** (buttons), **hidden** (not in
cards). Table types (section 2): `name`, `text`, `short`, `date`, `num`, `badge`, `mono`, `actions`.
"Card-only" columns use `table: false` (section 5). Non-technical rule: technical values (builds, agent and policy
version numbers, exit codes, layers, hashes) are never facts; they are details or hidden.

### Page lists (framed, card-capable)

**Devices** (`fleet:list`, `DeviceRow`). New column order (technical last): Name, Status, Kiosk, Policy, Enrolled, Windows.

| Column | Shows | Table type (limit) | Card role |
|---|---|---|---|
| name | name link + group sub-line / "No group" pill | name (280 px, 1 line; sub 1 line) | title (`cardCell`: link only), 2 lines |
| group *(card-only)* | group name, or "No group" warning pill | — | subtitle |
| status | ● Online / ● Offline · since 3 hours ago | short | status |
| kiosk | kiosk pill (Applied / Failed / Kiosk off / Revoked) | badge | status |
| alerts *(card-only)* | "Over limit" / "Suspended" / "Out of support" pills | — | status (hidden when none) |
| policy | **"Up to date" / "Update waiting"** (numbers in the tooltip) + plan pill | badge | fact "Policy" (`cardCell` without the plan pill) |
| created | Enrolled, relative | date | fact "Enrolled" |
| windows | build (mono) + out-of-support pill + agent sub-line | mono (160 px) | detail (`cardCell`: "Windows build 22631 · Agent 1.4.2") |

**Employees** (`employees:list`, `EmployeeRow`; dim when disabled)

| Column | Shows | Table type | Card role |
|---|---|---|---|
| name | name link | name (260 px) | title |
| username | mono username | mono (200 px, truncates) | subtitle (mono) |
| status | ● Active / ● Disabled | short | status |
| groups | group pills + "+ more" | badge (280 px; pills wrap between, each pill ≤ 160 px) | fact "Groups", `cardWide`, `cardCell`: first 2 pills + "+N more" pill (tooltip lists the rest) |
| quota | header **"Storage"** (was "Quota"): Default / Unlimited / 5 GB | short | fact "Storage" |

**Apps** (`apps:list`, `AppRow`)

| Column | Shows | Table type | Card role |
|---|---|---|---|
| name | glyph + name link + description sub-line | name (300 px; description 1 line) | title (`cardCell`: glyph + link), `cardSub`: description (1 line) |
| kind | icon + Desktop/Website + source pill + update pill | badge (wrap between pills) | status (`cardCell`: kind word + update pill; source pill hidden: technical) |
| groups | "3 groups" / "10+ groups" | short | fact "Groups" |
| installs | meter + "12 installed · 1 failed · 0 pending" | text (min 160, max 220) | fact "Installs", `cardWide` (website: "—") |
| created | Added (backend gap: always "—" today) | date | **hidden** until `apps:list` returns `createdAt` |

**Groups** (`groups:page`, `GroupRow`)

| Column | Shows | Table type | Card role |
|---|---|---|---|
| name | name link + description sub-line | name (300 px) | title, `cardSub`: description |
| devices | count ("500+") | num | fact "PCs" |
| employees | count | num | fact "Employees" |
| created | relative | date | fact "Created" |

**Enrollment codes** (`enrollmentCodes:list`, `EnrollmentCodeRow`; no row click; dim when not active).
`enrollment-networks.md` owns the page around it; this plan owns the list.

| Column | Shows | Table type | Card role |
|---|---|---|---|
| label | label / "Unlabeled code" (muted) | name (240 px) | title |
| state | Active / Used up / Expired / Revoked pill | badge | status |
| group | group link / "Group removed" | name (200 px) | fact "Group" |
| uses | "0 of 1 used" | short | fact "Used" |
| expires | "in 54 minutes" | date | fact "Expires" |
| created | "6 minutes ago" | date | detail, `cardLabel` "Created" |
| by | creator email | text (220 px, 1 line) | detail, `cardLabel` "By" |
| act | Revoke (active codes, admins) | actions | actions |

**Audit** (`audit:list`, `AuditEntry`; no row click)

| Column | Shows | Table type | Card role |
|---|---|---|---|
| at | relative + absolute date sub-line | date (stack, nowrap) | fact "When" (`cardCell`: relative only; absolute in tooltip) |
| action | action label | name (240 px) | title |
| actor | actor label + type sub-line | text (240 px) | fact "By" |
| target | target link | text (240 px) | fact "On" |
| summary | free text | text (360 px, 2 lines) | detail, 3 lines |

**File types** (`fileHandlers:page`, `FileTypeRow`; row opens the app)

| Column | Shows | Table type | Card role |
|---|---|---|---|
| extension | mono chip ".pdf" | mono | title |
| app | app link | name (260 px) | fact "Opens with", `cardWide` |
| act | Remove (admins) | actions | actions |

**Broadcasts** (`broadcasts:list`, `BroadcastRow`; no row click)

| Column | Shows | Table type | Card role |
|---|---|---|---|
| message | title + body + "Banner · Expires …" | text (360 px; title 1 line, body 2 lines) | title (`cardCell`: message title), `cardSub`: body (2 lines) |
| status | Active / Expired / Cancelled pill | badge | status |
| target | name + "Group"/"PC" sub-line | name (200 px) | fact "Sent to" ("Front desk · Group") |
| sent | relative | date | fact "Sent" |
| acks | "14 of 20 PCs" / "No confirmation asked" | short | fact "Seen by" |
| style/expiry *(card-only)* | "Banner · Expires 3 Dec, 14:00" | — | detail |
| actions | Cancel (active, admins) | actions | actions |

**Lockdown findings** (`lockdown:findings`, `FindingRow`; `lockdown.md` owns the words)

| Column | Shows | Table type | Card role |
|---|---|---|---|
| program | file name + product sub-line | name (280 px, 2 lines) | title, `cardSub`: product |
| signer | publisher / "Unsigned" pill | text (220 px) | fact "Publisher" |
| devices | "3 PCs" | short | fact "PCs" |
| seen | relative | date | fact "Last seen" |
| where | folder words | short | fact "Folder" |
| layer | AppLocker / App Control | short | detail (technical) |
| actions | Allow, Ignore | actions | actions (2 inline) |

**Settings > Members** (`members:page`) and **invites** (`members:invitesPage`; `settings.md` owns the tab)

| Column | Shows | Table type | Card role |
|---|---|---|---|
| email (+ "You" pill) | email | name (320 px) | title |
| status | ● Active / ● Disabled | short | status |
| role | Owner / Admin / Viewer | short | fact "Role" |
| created | Joined, relative | date | fact "Joined" |
| act | Change role, Reset code, Reset sign-in, Disable/Enable | actions | actions: **Change role inline, the rest in "More actions"** |
| invite email | email | name (320 px) | title |
| invite kind | role / "Password reset" | short | fact "Type" |
| invite created | relative | date | fact "Invited" |
| invite expires | **relative** (was an absolute date) | date | fact "Expires" |
| invite act | Revoke | actions | actions |

### Lists inside detail pages and cards

| List (file) | Columns → card roles | View |
|---|---|---|
| Device installs (`DeviceDetail.tsx` `Installs`) | app → title; state → status; detail (failed reason) → detail, 3 lines; updated → fact "Updated"; act Retry → actions | global view |
| Policy versions (`DeviceDetail.tsx` `versionCols`) | version chip → title; applied → status; date → fact; reason → detail | global view (device-detail.md may move it behind a disclosure) |
| App installs (`AppEdit.tsx` `InstallList`) | device → title; state → status; version (mono) → detail; detail (+ exit code) → detail; updated → fact | global view |
| Group assignments (`GroupDetail.tsx` `Assignments`) | app (glyph) → title; audience → fact "Who gets it"; pins → fact "Pinned"; Edit, Unassign → actions (2 inline) | global view |
| Failed installs (`Overview.tsx`) | app + reason → title + `cardSub`; device → fact "PC"; updated → fact | global view |
| History (`HistoryPanel.tsx`) | what+summary+actor, at | **always table** (`stack={false}`): a 2-column list in a side card |
| Group PCs (`GroupDetail.tsx` `GroupDevices`) | name, kiosk | **always table** (2 columns, side card) |
| Group employees (`GroupDetail.tsx` `GroupEmployees`) | name+username, Remove | **always table** |
| App's groups (`AppEdit.tsx` `AssignmentsTable`) | one column | **always table** |
| Employee picker (`GroupDetail.tsx` `AddEmployeeDialog`) | name, Add | always table (already `stack={false}`) |
| `EmployeeDetail.tsx` | no table today | — |
| `Gallery.tsx` sample | name → title, ring → status, apps → fact | global view (update the sample to show every role) |

## 2. Table rules: acceptance criteria (section 1 of the spec)

### 2a. What the table builder's current work must satisfy (checkable now)

The Sonnet builder is doing the quick fixes in `DataTable.tsx` / `Pager.tsx` / `dashboard.css`. Check each item at
390, 820, 1366, 1920 px, light and dark, on Enrollment, Devices, Employees, Apps, Groups, Audit, File types,
Broadcasts, Findings and Settings > Members (`e2e/shots.mjs`).

- **B1 Short cells never wrap.** Cells of counts, dates, states, badges and short words stay on one line:
  "0 of 1 used", "4 minutes ago", "in 56 minutes", "Expired", "3 groups". Mechanism: a column declares it
  (`nowrap: true` per the README contract, or the `type` of 2b which implies it); `numeric` implies it.
- **B2 Header labels never wrap** ("CREATED BY" on one line): `th { white-space: nowrap }`.
- **B3 Long text truncates, never breaks the row height.** Name/label/email/target cells cut with an ellipsis at
  their max width (2b). The full text stays in the DOM (screen readers read it) and shows on **hover**; a truncated
  **link** shows it on **keyboard focus** too. Acceptable interim: the native `title` attribute for hover; 2b's
  `Truncate` replaces it in step L2.
- **B4 Sizing.** Short columns shrink to their content (`width: 1%` + nowrap); the name/text columns take the rest.
  The fixed `min-width: 680px` floor on `.dash-table-wrap .rb-table` is gone: a table is as wide as its content
  needs, at least the container. Long names cannot widen a column beyond its max (cap on the inner element: a
  `max-width` on a `td` is ignored in auto table layout).
- **B5 Sideways scroll only inside the table.** When the columns need more than the container, `.dash-table-wrap`
  scrolls sideways (focusable region, visible thin scrollbar); the page itself never scrolls sideways at 390 px.
- **B6 Footer, one layout per width** (container query on `.dash-dt__footer`, which already has
  `container-type: inline-size`):
  - container **≥ 680 px**: one row, vertically centred: summary left ("147 records · Page 1 of 15"), page
    buttons centred, "Rows per page [10]" right.
  - container **< 680 px**: two aligned rows. Row 1: the page buttons, centred (Previous at the far left, Next at the
    far right when the strip is wider than the space). Row 2: summary left-aligned (may wrap after "·"), "Rows per
    page [10]" right-aligned on the same row. Both rows share the footer's left/right padding. No element sits
    centred alone except the page buttons.
  - At 358 px nothing overflows; the page strip scrolls inside itself (already) and touch targets stay 44 px.
- **B7 Tight side cards** (`dash-card--tight`): the name column still takes the remaining width and truncates.

### 2b. Rules this plan adds (step L1, L2, L6)

Column `type` (CSS class `dash-col--<type>` on `th` and `td`):

| type | Used for | Wrap | Width | Align |
|---|---|---|---|---|
| `name` | the record's name (primary) | 1 line, ellipsis | min 160, max 280 (per-column `maxWidth` 200-320) | start |
| `text` | free text (summary, message, failure reason) | up to 2 lines, then ellipsis | min 200, max 360 | start |
| `short` | state words, role, "0 of 1 used", "3 PCs" | never | fit | start |
| `date` | `RelativeTime` (absolute in its tooltip) | never | fit (≥ 104 px for "in 56 minutes") | start |
| `num` | counts (= today's `numeric`) | never | fit | end, tabular |
| `badge` | pills | never inside a pill; between pills only | fit, max 280 | start |
| `mono` | build, version, username, extension | never | fit, max 200 then ellipsis | start |
| `actions` | buttons (= today's `actions`) | never | fit (`width: 1%`) | end |

- Default when a column declares nothing: `primary` → `name`, `actions` → `actions`, `numeric` → `num`, else
  `short`. Every list in section 1 declares its type explicitly.
- **`Truncate` (full text on hover and focus).** `components/Truncate.tsx`: `<Truncate full={string} lines={1|2|3}>`
  wraps a cell's text or link. It measures itself (one shared `ResizeObserver` for the whole page) and only when it
  is really cut: shows **one shared tooltip** (placed with `placeFloating`, max width 320 px, `aria-hidden` because
  the full text is already in the DOM) after 400 ms of hover, at once on focus (of the link inside or of itself),
  hides on leave, blur and Esc. Cut plain text (an email, a signer) gets `tabIndex=0` so keyboard users can reach
  it; uncut text is never a tab stop. The native `title` is removed where `Truncate` is used (no double tooltip).
  Touch: no tooltip; the record's page shows the full text.
- **Sticky first column** when the table's container is **< 900 px** (container query on `.dash-dt__surface`):
  the first cell of every row is `position: sticky; inset-inline-start: 0` with a solid surface background (hover
  and dim colours repainted on it as solid colours, not transparent), a 1 px divider at its end and its name max
  width lowered to 200 px. ≥ 900 px: not sticky (the table fits).
- Rows keep today's behaviour: whole-row click, a real link in the name cell, `aria-sort` headers.
- **Pager, one page only:** when page 1 is the only page (`!hasNext`, no total > page size) and the size is the
  default 10, the footer shows only the summary ("3 records", or nothing when there is no total). A non-default
  size keeps the size select so the person can go back.
- **Page change scrolls to the list.** After Previous/Next/a page number, when the list's top is above the
  viewport, it scrolls into view (`behavior: "auto"` under reduced motion or Lite, else `"smooth"`) and the surface
  (`tabIndex=-1`) takes focus without scrolling again, so keyboard and screen-reader users start at the new page.

## 3. Cards view

### 3a. Anatomy (one `RecordCard` per row)

```
┌───────────────────────────────────────────┐
│ [glyph] Title of the record, at most two  │  title: 15 px / 600, 2 lines, the link
│ lines then …                              │
│ Subtitle, one line, muted…                │  subtitle: 13 px muted, 1 line
│ ● Online  [Kiosk applied]  [Over limit]   │  status: badge row, wraps, 8 px gap
│                                           │
│ POLICY             ENROLLED               │  facts: label above value, 2 per row
│ Up to date         3 days ago             │  (auto-fill, min 124 px), at most 4
│ GROUPS (wide fact spans both columns)     │
│ [Front desk] [Kitchen] [+3 more]          │
│ ───────────────────────────────────────── │  hairline only when details or actions follow
│ Windows build 22631 · Agent 1.4.2         │  details: 12.5 px muted, inline "label value · …", clamp 2 lines
│                       [Change role] [⋯]   │  actions: end-aligned footer, pinned to the bottom
└───────────────────────────────────────────┘
```

- **Title** (`cardCell ?? cell` of the title column): 2 lines (`-webkit-line-clamp: 2`, `overflow-wrap: anywhere`
  so "PC-RECEPTION-FRONTDESK-0001-XXXX" breaks), `Truncate lines={2}`. Required: `cardLayout` refuses (dev error)
  a card-capable list without a title column. An empty title renders the cell's own fallback ("Unlabeled code").
- **Subtitle**: from `cardSub` of the title column or a `card: "subtitle"` column. 1 line. Omitted when empty.
- **Status**: every `status` column's cell in order, in one wrapping row; each pill nowrap with max width 200 px
  (ellipsis + `Truncate`). A status column whose `isEmpty` is true is skipped; no row when all are empty. Lists
  have at most 3 status columns, so no "+N" for status.
- **Facts**: `<dl>` grid, `grid-template-columns: repeat(auto-fill, minmax(124px, 1fr))`, gap 10 px 16 px.
  Label: 11.5 px, 600, muted, letter-spacing 0.04em, 1 line (`cardLabel ?? header`). Value: 14 px, 1 line with
  ellipsis (`Truncate`); a `cardWide` fact spans the full row and may wrap to 2 lines. **An empty fact shows a muted
  "—"** so facts stay in the same place on every card. **At most 4 facts**: extra `fact` columns are shown as
  details (dev warning). Labels are never pushed to the far edge from their value.
- **Details**: one muted block, items inline as "**Label** value" separated by " · " (`cardLabel: false` = value
  only), clamp 2 lines; a `text` detail (summary, failure reason, message body) gets its own block, clamp 3 lines.
  Empty details are skipped.
- **Actions**: footer row, end-aligned, `margin-top: auto` (pinned to the card bottom so cards in a row line up),
  marked `data-no-row-click`. Rules in 3d. No footer when the row has no action.
- **Glyph** (apps, assignments): part of the title cell; 28 px.

Density (one density, no toggle): padding 16 px (14 px when the card is < 320 px), radius `--dash-radius-sm`
(12 px), gap between blocks 10 px. Surface: `--rb-surface`, 1 px `--rb-line` border, the calm `--dash-card-shadow`
for page-level lists; **flat tiles** (border, no shadow) inside a `Card`. Dim rows: text in `--rb-muted`, no opacity
on the whole card (contrast stays readable); the status pill already says why (Revoked, Disabled, Expired).

### 3b. Grid by container width

`.dash-dt__surface { container: dt / inline-size }`; `.dash-cards` is a CSS grid whose columns come from the
container, never from the viewport:

| Container width | Columns | Gap | Typical place |
|---|---|---|---|
| < 560 px | 1 | 12 px | phone (358), side cards (340-420) |
| 560-879 px | 2 | 12 px | tablet (692) |
| 880-1239 px | 3 | 16 px | laptop (1030), wide today (1200) |
| ≥ 1240 px | 4 | 16 px | wide after foundations (1480) |

- `align-items: stretch`: cards in one grid row share the height; the footer is pinned to the bottom.
- One record: one card at one column's width (not stretched across the row).
- Hundreds of records: the server pages (10/25/50 per page, max 50 cards rendered), so no virtualisation. The
  pager sits under the grid; page change scrolls to the top of the grid (section 2b).

### 3c. Click, keyboard, screen readers

- **Whole card clickable** when the list has `onRowClick`, with the same handler as rows (`ignoreRowClick`: links,
  buttons, menus, selected text and modified clicks are left alone). The **title link is the real link**
  (keyboard, ctrl/middle-click, "open in new tab"). No `<a>` wrapping the card (nested interactive content) and no
  stretched-link overlay (blocks text selection and needs z-index tricks for every action).
- Focus: Tab goes to the title link, then to the card's actions, then the next card (DOM order = visual order,
  row by row). A focused title link draws the card's focus ring (`.dash-rcard:has(.dash-rcard__title a:focus-visible)`,
  2 px accent outline) and the link's own outline is removed, like rows today. No arrow-key grid navigation.
- Markup: `<ul class="dash-cards" role="list" aria-label={caption} aria-busy={busy}>` → `<li>` →
  `<article aria-labelledby={titleId}>`; facts and details are `<dl>` (`<dt>` label, `<dd>` value). The card
  title is not a heading (the level would depend on the page). Action buttons carry the record name
  ("Revoke: VM run A3"), the menu button "More actions for VM run A3".
- Hover (clickable cards only): border `--rb-line-strong`, background `--rb-hover` (no transition) and
  `transform: translateY(-1px)` with `--rb-duration`; no transform under `prefers-reduced-motion` or Lite.
  No entrance animation (pages change often; a stagger would be noise).

### 3d. Actions: inline vs "More actions"

Declarative per list (`rowActions`, section 5) so table and cards apply one rule:

- **≤ 2 actions** for a row: inline small buttons (today's look). Destructive ones use `danger-ghost`.
- **> 2 actions**: the action marked `primary` inline, the rest behind a **⋯ "More actions"** button opening a
  `MenuList` (`packages/ui`, already used by `AccountMenu`) placed with `placeFloating`; destructive items last,
  `danger`. Arrow keys, Home/End, Esc returns focus to the ⋯ button. Today only Settings > Members needs it.
- Same in the table's actions cell and the card footer. Disabled actions keep their reason as a hint
  (Retry: "This app can't be retried"). Confirm dialogs stay as they are.

### 3e. States

- **Loading**: `SkeletonCards` (new, in `Skeleton.tsx`) in the same grid: `min(skeletonRows, 6)` cards with a title
  bar, a subtitle bar and 2 × 2 fact bars. Same shimmer rules as `SkeletonRows` (Lite: static).
- **Busy** (next page loading): old cards stay, `opacity: 0.55`, `aria-busy` on the list.
- **Empty / no results / error**: the same `EmptyState` / `RegionError` as the table, inside the surface card (a
  framed list keeps its card for these states so the page does not look broken).
- **Empty page** (server filtered after paging): the existing note "Nothing on this page. Try the next page."

### 3f. Surface

- Framed page lists, cards view: **no outer card**: the grid sits on the page background, the pager under it in
  its own frosted bar (no border-top, 16 px above). Table view keeps today's card.
- Lists inside a `Card` (detail pages): flat tiles inside the card body, 12 px padding around the grid.

## 4. List page layout per band

Page = `dash-page` → `PageHeader` (title, short lead, one main action) → optional notice → the list (toolbar,
surface, footer). Foundations owns `PageHeader` and the page max width; this plan owns the toolbar and the list.

**Toolbar** (`.dash-dt__toolbar`, container query on the list, not the viewport):

| Container | Row 1 | Row 2 |
|---|---|---|
| ≥ 880 | search (flex, max 420) · filters · spacer · list actions (`toolbarEnd`, e.g. Check now) · sort `Select` (cards only) · `ViewSwitch` (icon + label) | — |
| 560-879 | search (flex) · filters | spacer · list actions · sort · `ViewSwitch` (icon + label) |
| < 560 | search (full width) | filters (flex 1) · sort (flex 1, cards only) · `ViewSwitch` **icon only** |

- Sort `Select` (foundations' custom listbox, `compact`) only in cards view (the table has its headers). Plain
  option labels by column type: name/text "Name: A to Z" / "Name: Z to A"; date "Enrolled: newest first" /
  "Enrolled: oldest first"; num "PCs: most first" / "PCs: fewest first". A list whose default order has no column
  (Employees: newest added) passes `defaultSort={{ key, dir, label: "Newest first" }}` so the Select always shows
  the current order. While searching by relevance the sort Select is disabled with "Best matches first".
- Devices: "Check now" moves from its own row above the table into `toolbarEnd`; its result notice stays above
  the list.

**Default view and persistence** (`lib/viewMode.ts`, `boot/boot.js`):

- Stored choice (`rulebox.view` = `table` | `cards`) always wins, at every width, on every list.
- **No stored choice: viewport < 600 px → Cards, otherwise Table** ("auto"). It follows the width live
  (`matchMedia` listener) until the person picks one with the switch. `boot.js` resolves the same before first
  paint and sets `<html data-view>`. No `matchMedia` (tests) → Table.
- Printing always prints the table: `beforeprint` forces `table` (`flushSync`), `afterprint` restores (Audit has
  a Print button).
- Lists marked `stack={false}` are tables in every view and show no switch.

**Footer**: section 2a B6 in table view; in cards view the same pager under the grid.

### Wireframes: Devices

Laptop 1366 (container ~1030), table view:

```
Devices                                                                  [+ Add PC]
Every PC in your organization.
[🔍 Search PCs                ] [All groups        ▾]           [⟳ Check now] [☰ Table|▦ Cards]
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ NAME ↕                  STATUS                 KIOSK         POLICY          ENROLLED ↓  WINDOWS │
│ Reception PC 01         ● Online               [● Applied]   Up to date      3 days ago  22631   │
│ Front desk                                                                                       │
│ Kitchen tablet with a…  ● Offline · 2 h ago    [Kiosk off]   [Update waiting] 1 week ago 19045 [Out of support] │
│ [No group]                                                                                       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 147 records · Page 1 of 15        ‹ [1] 2 3 … 15 ›                   Rows per page [10 ▾] │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Laptop 1366, cards view (3 columns of ~332 px, no outer card):

```
[🔍 Search PCs            ] [All groups   ▾]   [⟳ Check now] [Enrolled: newest first ▾] [☰|▦ Cards]
┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
│ Reception PC 01          │ │ Kitchen tablet with a    │ │ Office laptop 3          │
│ Front desk               │ │ very long name that …    │ │ Back office              │
│ ● Online [● Applied]     │ │ [No group]               │ │ ● Online [● Applied]     │
│                          │ │ ● Offline · 2 h ago      │ │ [Over limit]             │
│ POLICY      ENROLLED     │ │ [Kiosk off][Out of supp…]│ │ POLICY      ENROLLED     │
│ Up to date  3 days ago   │ │ POLICY        ENROLLED   │ │ Update wai… 5 days ago   │
│ ──────────────────────── │ │ Update waiting 1 week ago│ │ ──────────────────────── │
│ Windows build 22631 ·    │ │ ──────────────────────── │ │ Windows build 22631 ·    │
│ Agent 1.4.2              │ │ Windows build 19045 · …  │ │ Agent 1.4.1              │
└──────────────────────────┘ └──────────────────────────┘ └──────────────────────────┘
╭ 147 records · Page 1 of 15        ‹ [1] 2 3 … 15 ›             Rows per page [10 ▾] ╮
```

Phone 390 (container 358), cards view (the default on a phone):

```
Devices                 [+ Add PC]
[🔍 Search PCs                    ]
[All groups ▾] [Newest first ▾] [☰|▦]
┌────────────────────────────────┐
│ Reception PC 01                │
│ Front desk                     │
│ ● Online  [● Applied]          │
│ POLICY          ENROLLED       │
│ Up to date      3 days ago     │
│ ────────────────────────────── │
│ Windows build 22631 · Agent 1.4.2 │
└────────────────────────────────┘
┌────────────────────────────────┐
│ Kitchen tablet …               │
└────────────────────────────────┘
╭        ‹ [1] 2 3 … 15 ›        ╮
│ 147 records ·    Rows per page │
│ Page 1 of 15            [10 ▾] │
╰────────────────────────────────╯
```

Phone 390, table view (chosen with the switch): sticky name column, the rest scrolls sideways inside the card:

```
┌────────────────────┬───────────────────────────
│ NAME ↕             │ STATUS            KIOSK  →
│ Reception PC 01    │ ● Online          [● App…
│ Front desk         │
│ Kitchen tablet w…  │ ● Offline · 2 h   [Kiosk…
├────────────────────┴───────────────────────────
│        ‹ [1] 2 3 … 15 ›                       │
│ 147 records ·            Rows per page [10 ▾] │
│ Page 1 of 15                                  │
```

Tablet 820 (container ~692 < 900): table view has the sticky name column and scrolls sideways when the six
columns need more room; cards view has 2 columns. Wide 1920 (1200 → 1480): table fits; cards 3 → 4 columns.

## 5. Component API changes, file by file

`apps/dashboard/src/components/DataTable.tsx`

```ts
export type ColumnType = "name" | "text" | "short" | "date" | "num" | "badge" | "mono" | "actions";
export type CardRole = "title" | "subtitle" | "status" | "fact" | "detail" | "actions" | "hidden";

export interface RowAction {
  label: string;                // "Revoke"; the aria-label adds the row: "Revoke: VM run A3"
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;                // why it is disabled
  primary?: boolean;            // stays inline when there are more than 2
}

export interface Column<T> {
  key: string; header: string; cell: (row: T) => ReactNode;
  primary?: boolean; actions?: boolean; numeric?: boolean; className?: string;
  isEmpty?: (row: T) => boolean; sortable?: boolean; sortDefaultDir?: SortDir;
  nowrap?: boolean;             // README contract; implied by short/date/num/badge/mono/actions
  type?: ColumnType;            // table width class (section 2b); default from primary/actions/numeric
  maxWidth?: number;            // px cap for name/text/mono truncation in the table
  table?: boolean;              // false = card-only column (default true)
  card?: CardRole;              // default: primary→title, actions→actions, else fact
  cardCell?: (row: T) => ReactNode;      // the card's rendering when it differs from the table cell
  cardSub?: (row: T) => ReactNode;       // title column only: the subtitle line
  cardLabel?: string | false;            // fact/detail label (default header; false = none)
  cardWide?: boolean;                    // fact spanning the whole facts row
  rowActions?: (row: T) => RowAction[];  // actions column: declarative buttons (section 3d)
}
```

`DataTableProps` adds: `rowLabel?: (row: T) => string` (record name for action labels; required with
`rowActions`), `toolbarEnd?: ReactNode`, `defaultSort?: SortState & { label: string }`, `pageKey?: string | number`
(scroll-to-list on change). `stack` keeps its meaning (false = always table). Rendering: `asCards ? <CardGrid/> :
<table/>`; the `dash-table--stack` class and the `data-label` attributes go away.

New files:

- `components/CardGrid.tsx`: `CardGrid<T>({ caption, columns, rows, getKey, isDim, onActivate, rowLabel, busy,
  flat })` → the `<ul>` grid; memoized `RecordCard` (same stable `activate` callback pattern as `Row`). Uses
  `cardLayout` once per `columns` change (memo), not per row.
- `lib/cardLayout.ts` (pure): `cardLayout(columns) → { title, subtitle?, status[], facts[], details[], actions? }`,
  defaults, the "max 4 facts" demotion, the "one title" check, `table: false` filtering for the table
  (`tableColumns(columns)`), plus `sortOptions(columns, defaultSort)` → `SelectOption[]` with plain labels.
- `components/RowActions.tsx`: `RowActions({ actions, rowName })` → inline buttons or primary + ⋯ `MenuList`.
- `components/Truncate.tsx`: section 2b; one module-level `ResizeObserver` and one shared tooltip element.
- `components/Skeleton.tsx`: add `SkeletonCards({ count })`.

Changed files:

- `components/ServerTable.tsx`: passes `toolbarEnd`, `defaultSort`, `rowLabel`, `pageKey={pager.page}`; disables
  the sort Select while searching by relevance (shows `strings.table.byRelevance`).
- `components/Pager.tsx`: single-page simplification; summary split into two spans (records / page) so it wraps
  at the "·"; narrow layout per B6 (if the builder has not done it). Size select on the new `Select` API (if
  foundations has not migrated it).
- `components/ViewSwitch.tsx`: `iconOnly` driven by the list's container (CSS: label `dash-sr` under 560 px
  container, `title` always set), no prop needed in the toolbar.
- `lib/viewMode.ts`: `resolveView()` (stored ?? auto by `(max-width: 599px)`), `matchMedia` subscription while
  nothing is stored, print override. `boot/boot.js`: same resolution.
- `styles/dashboard.css`, section "tables": `dash-col--*` classes, sticky first column, B4 sizing; section
  "Cards view": **replace** the `html[data-view="cards"] .dash-table--stack` block (lines ~1201-1276) and the
  `:has(.dash-table--stack) .dash-dt__sortsel` rule with `.dash-cards`, `.dash-rcard*`, the container grid, tiles,
  skeleton cards, hover/reduced-motion/Lite rules; section "pager": B6 + single-page rules. Shared by every list
  screen, so it stays in `dashboard.css` (not a page CSS file).
- `components/README.md`: the new Column fields, card roles, `rowActions`, `Truncate`.
- `lib/strings.ts`: section 7.
- Screens: section 1 roles and types; action columns move to `rowActions`; Devices `CheckNowButton` →
  `toolbarEnd`; `DeviceCells.tsx` `PolicyCell` words.

## 6. Data and I/O

- **No new reads, no new query, no new index, no `ioBudgets.ts` change.** Cards render exactly the rows of the
  page the list hook already returns; switching the view does not change any query argument (same sort, search,
  page, size), so the subscription is reused, not re-run.
- Every card field is in today's row types (`DeviceRow`, `EmployeeRow`, `AppRow`, `GroupRow`,
  `EnrollmentCodeRow`, `AuditEntry`, `FileTypeRow`, `BroadcastRow`, `FindingRow`, `MemberRow`, `InviteRow`,
  install rows). Card-only columns derive from fields already fetched (Devices group/alerts, Broadcasts
  style/expiry).
- Known gap, **not fixed here**: `apps:list` does not return `createdAt` (the "Added" column is always "—"). The
  card hides it. Returning it would be a field on the same row (no extra read); left to the add-app plan.
- Client cost: per-cell clocks (`useNow` in Enrollment state cells, Broadcast status) are the same in cards.
  Truncate adds one shared observer and one tooltip node per page, not per cell.

## 7. Strings (`lib/strings.ts` unless noted)

```ts
table: {
  // existing: view, viewTable, viewCards, sortSelect "Sort by", emptyTitle, noResults, byRelevance, emptyPage
  sortOption: (column: string, dirLabel: string) => `${column}: ${dirLabel}`,       // replaces "Created, descending"
  sortDir: {
    name: { asc: "A to Z", desc: "Z to A" },
    date: { asc: "oldest first", desc: "newest first" },
    num: { asc: "fewest first", desc: "most first" },
  },
  moreActions: "More actions",
  moreActionsFor: (name: string) => `More actions for ${name}`,
  actionFor: (label: string, name: string) => `${label}: ${name}`,
  moreItems: (n: number) => `+${n} more`,
  empty: "—",
},
pager: { /* existing */ recordsShort: (n: number) => `${formatNumber(n)} ${n === 1 ? "record" : "records"}` },
```

Screen strings: `screenStrings/devices.ts` `policyUpToDate: "Up to date"`, `policyWaitingShort: "Update waiting"`,
`policyWaitingHint: (applied, latest) => "This PC has version …; the newest is …"`, `colGroupCard: "Group"`,
`windowsDetail: (build, agent) => \`Windows build ${build} · Agent ${agent}\``; `employees.ts` `colQuota: "Storage"`;
`broadcasts/strings.ts` `colSentTo: "Sent to"`, `colSeenBy: "Seen by"`; enrollment `cardBy: "By"`,
`cardCreated: "Created"`; audit `cardWhen: "When"`, `cardBy: "By"`, `cardOn: "On"`; groups `cardPcs: "PCs"`;
apps `kindWebsite: "Website"`, `kindDesktop: "Desktop app"`. Findings and Members labels come from
`lockdown.md` / `settings.md` if they rename them.

## 8. Tests

Changed (they assert today's CSS-only cards):

- `components/DataTable.test.tsx`: "in cards view the wrapper is no scroll region" → cards view renders a
  `list` named by the caption with one `listitem` per row and **no** `table`; `stack={false}` stays a table.
  "gives the cells their labels for the cards view" (`data-label`) → facts render `dt`/`dd` with the header or
  `cardLabel`. "offers a sort select in the toolbar for the cards view" → the custom `Select`, plain labels.
- `screens/lists4b.test.tsx` "the Cards view keeps the same rows and offers a sort select" (Apps): no
  `dash-table--stack`; cards list with 2 items, sort via the new Select sends `{ key: "name", dir: "desc" }`.
  Every `fireEvent.change(getByLabelText(strings.pager.rowsPerPage))` moves to the custom Select (foundations'
  test helper) in `lists4b`, `step5`, `step7`, `step11`.
- `screens/step5.test.tsx:325`, `step7.test.tsx:370`, `step11.test.tsx:247`: the switch test now also expects the
  `list` role after switching.
- `lib/viewMode.test.tsx` "is the table by default, at every width" → "table by default without matchMedia;
  cards when nothing is stored and the viewport is < 600 px; a stored choice wins; follows a width change until a
  choice is stored".
- `boot/boot.test.ts`: the auto rule with a stubbed `matchMedia`.
- `components/Pager.test.tsx`: add the single-page cases; existing ones keep passing (they use `hasNext` or totals).

New:

- `lib/cardLayout.test.ts`: defaults (primary→title, actions→actions, rest→fact), `table: false` columns only in
  cards, 5 facts → 4 facts + 1 detail, missing title throws in dev, sort option labels per type, `defaultSort`
  option first.
- `components/CardGrid.test.tsx`: whole-card click opens the row; links, buttons, ⋯ menu, selected text and
  ctrl-click do not; Tab order title → actions → next title; focus ring class via `:focus-visible` (assert the
  link is focusable and the card has no tabIndex); empty facts show "—", empty status/details/actions render
  nothing; dim cards get `data-dim`; busy sets `aria-busy`; memoized cards re-render only when their row changes.
- `components/RowActions.test.tsx`: 1-2 actions inline with "Label: name" names; 4 actions → primary inline + ⋯
  menu, arrows/Home/End/Esc, focus back on ⋯, danger item last, disabled item with hint.
- `components/Truncate.test.tsx` (stub `scrollWidth`/`clientWidth`): tooltip only when cut, on focus at once and
  on hover after 400 ms, Esc hides, cut plain text gets `tabIndex=0`, uncut does not, no `title` attribute.
- `screens/listsCards.test.tsx`: for Devices, Employees, Enrollment, Members: the title, status, facts and
  actions land in the right slots from the real column definitions (catches drift between table and cards);
  Members shows "Change role" inline and the rest under "More actions".
- Print: `beforeprint` renders the table, `afterprint` restores cards.

## 9. Build steps (each one Sonnet agent; typecheck + lint + the dashboard tests at the end of each)

Prerequisites: the table builder's quick fixes (2a) are merged; foundations' `Select` (options API) and
`placeFloating` exist. If `Select` is not ready, L6 keeps the current select and a follow-up swaps it.

| Step | Files | Depends | Parallel |
|---|---|---|---|
| **L0** Review the builder's quick fixes against 2a (B1-B7), screenshots of the 10 lists at 4 widths × 2 themes; list gaps as fixes for L6 | read-only + `.tmp/ui-pass/lists/` | builder done | — |
| **L1** `Column` / `RowAction` / props types in `DataTable.tsx` (no rendering change yet), `lib/cardLayout.ts` + test | `DataTable.tsx`, `lib/cardLayout.ts`, `lib/cardLayout.test.ts` | L0 | with L2, L3, L4 |
| **L2** `Truncate` + shared tooltip + CSS (`dash-truncate-tip`) + test | `components/Truncate.tsx`, `Truncate.test.tsx`, `dashboard.css` (tooltip block only) | — | with L1, L3, L4 |
| **L3** `RowActions` + test | `components/RowActions.tsx`, `RowActions.test.tsx` | — | with L1, L2, L4 |
| **L4** auto default view, `matchMedia` follow, print override, boot | `lib/viewMode.ts`, `viewMode.test.tsx`, `boot/boot.js`, `boot.test.ts` | — | with L1, L2, L3 |
| **L5** `CardGrid` / `RecordCard`, `SkeletonCards`, the "Cards view" CSS block (replaces the stack block) + `CardGrid.test.tsx` | `CardGrid.tsx`, `Skeleton.tsx`, `dashboard.css` (cards section) | L1, L2, L3 | — |
| **L6** wire it: `DataTable` renders `CardGrid` / table with `dash-col--*` classes, `Truncate` in name/text cells, `RowActions` in action cells, toolbar (`toolbarEnd`, sort Select with plain labels + `defaultSort`, switch icon-only by container), framed-cards surface, sticky first column, page-change scroll; `ServerTable`; `Pager` single-page + B6 leftovers; `ViewSwitch`; strings; `DataTable.test`, `Pager.test`, `components/README.md` | `DataTable.tsx`, `ServerTable.tsx`, `Pager.tsx`, `ViewSwitch.tsx`, `strings.ts`, `dashboard.css` (tables, pager), tests | L4, L5 | — |
| **L7a** Devices, Employees, Groups: types, roles, card-only columns, `PolicyCell` words, Check now → `toolbarEnd`, Employees `defaultSort`, "Storage" | `Devices.tsx`, `Employees.tsx`, `Groups.tsx`, `DeviceCells.tsx`, `screenStrings/devices.ts`, `employees.ts`, `groups.ts`, step tests touched | L6 | with L7b, L7c |
| **L7b** Apps, File types, Enrollment codes list, Broadcasts, Audit: types, roles, `rowActions` | `Apps.tsx`, `FileTypes.tsx`, `Enrollment.tsx` (`CodeList` only), `Broadcasts.tsx`, `Audit.tsx`, their strings, `lists4b.test.tsx` | L6 | with L7a, L7c |
| **L7c** Findings, Members + invites, Overview failed installs, DeviceDetail installs + versions, GroupDetail (assignments; PCs/employees → `stack={false}`), AppEdit (installs; assignments → `stack={false}`), HistoryPanel `stack={false}`, Gallery sample | those files (column arrays and `ServerTable` props only) | L6, and after the page builders of `device-detail.md`, `settings.md`, `lockdown.md`, `add-app.md` have landed (they rewrite these screens) | with L7a, L7b |
| **L8** `screens/listsCards.test.tsx`; full dashboard test run; `pnpm --filter @rulebox/dashboard build` + size budget (report any raise, never raise silently); screenshots of every list, table and cards, 390/820/1366/1920, light and dark; fix pass | tests, `.tmp/ui-pass/lists/` | L7a-c | — |

Rules for every step: only the files listed (other agents share the worktree); no `pnpm install`, `convex dev`,
`convex deploy`, git commit/stash/reset/checkout; Solar icons only (`~icons/solar/menu-dots-linear` for ⋯);
tokens, no raw colours; animation only `transform`/`opacity`, reduced motion and Lite honoured.

## 10. Decisions taken (recommended option chosen; owner reviews)

1. **How cards are drawn.** (a) keep restyling the `<table>` with CSS; (b) a separate React `CardGrid` from the
   same columns. **Chosen: (b)**: real grid, real list semantics, label-above-value facts, actions footer; (a)
   cannot do a multi-column grid or a card anatomy and loses table semantics anyway.
2. **Where roles live.** (a) a separate card config per list; (b) on the existing `Column` (`card`, `cardCell`,
   `cardSub`, `cardLabel`, `cardWide`, `table: false`) with defaults. **Chosen: (b)**: table and cards cannot drift.
3. **Default view.** (a) table everywhere (Phase 4b owner decision 2026-11-03); (b) phone (< 600 px viewport) cards
   when nothing is stored, a stored choice always wins; (c) cards everywhere. **Chosen: (b)**. **This changes the
   Phase 4b decision "Default is the table on every screen width"**: the owner should confirm; reverting is one
   line in `viewMode.ts` and `boot.js`.
4. **Grid breakpoints (container width).** 1 col < 560, 2 at 560-879, 3 at 880-1239, 4 at ≥ 1240 px (min card
   ~272-300 px). Alternative `auto-fill minmax(280px)` rejected: no cap at 4 and uneven counts. **Chosen.**
5. **Facts layout.** Label above value, 2 per row, max 4 facts; extras become details. (Label left / value far
   right rejected: the owner's complaint.) **Chosen.**
6. **Status placement.** (a) top-right of the title; (b) a badge row under the title. **Chosen: (b)**: devices
   have up to 3 statuses and long names; top-right squeezes the title.
7. **Empty values.** Empty facts show a muted "—" (stable positions); empty status, subtitle, details and actions
   are left out. **Chosen.**
8. **Card click.** (a) whole card is an `<a>`; (b) stretched-link overlay; (c) the row handler on the card + the
   title link as the real link. **Chosen: (c)** (same code and tests as rows).
9. **Actions.** ≤ 2 inline; > 2: primary inline + ⋯ "More actions" menu (`MenuList`); declared with `rowActions`
   for both views. Alternative "always a menu" rejected (one more click for the common Revoke/Remove). **Chosen.**
10. **Full text of truncated values.** (a) native `title` only; (b) `Truncate` with a shared tooltip on hover and
    focus, cut plain text focusable. **Chosen: (b)** (`title` does not show on focus).
11. **Sticky first column** when the table's container is < 900 px. Alternative: never sticky. **Chosen: sticky**
    (the name stays visible while scrolling at tablet width, `02`).
12. **Scroll hint.** Visible thin scrollbar + sticky divider; no JS scroll shadows. **Chosen.**
13. **Narrow pager.** Row 1 page buttons centred; row 2 summary left + rows-per-page right. **Chosen.**
14. **Single-page pager.** Only the summary when there is one page at the default size. **Chosen** (less noise).
15. **Surface in cards view.** Page lists: cards on the page background, no outer card; inside a `Card`: flat
    tiles. **Chosen** (no card-in-card).
16. **Compact side-card lists stay tables** (`stack={false}`): History, Group PCs, Group employees, App's groups,
    employee picker. **Chosen**: 1-2 column lists are already list-like; cards would only add frames.
17. **Sort labels in plain words** by column type ("Enrolled: newest first"). **Chosen.**
18. **Printing** always prints the table. **Chosen.**
19. **Motion.** No entrance animation; hover lift (`transform`) off under reduced motion / Lite. **Chosen.**
20. **Density.** One density, no toggle. **Chosen** (fewer options).
21. **Devices columns.** Technical last (Windows build + agent as card details); Policy in words ("Up to date" /
    "Update waiting", version numbers in the tooltip) in both views; Check now in the toolbar. **Chosen.**
22. **Employees "Quota" → "Storage"**; invites' expiry relative ("in 6 days"). **Chosen.**
23. **Apps "Added"** hidden in cards while the backend does not return it (no backend change here). **Chosen.**
24. **Audit** stays card-capable (phones), printed as a table. **Chosen.**
25. **Bundle.** `CardGrid`, `RowActions`, `Truncate` ship with `DataTable` (used on almost every screen); no
    lazy chunk (a lazy view would flash). Expected +3-4 KB gzip; reported if over budget. **Chosen.**
26. **Keyboard.** Tab order only, no arrow-key grid navigation; the card title is not a heading. **Chosen.**
27. **Page change** scrolls the list's top into view and focuses the list surface. **Chosen.**
28. **No multi-select** (checkboxes) in this pass. **Chosen** (not in the spec).

## 11. Open points for the owner

- Decision 3 overrides a Phase 4b owner decision (phones default to cards). Confirm or revert.
- Devices: should the Windows build stay a table column at all (technical), or move to the device page only?
  Kept as the last column for now.
- `apps:list` `createdAt` (the "Added" column) is still missing; fix in the add-app work or drop the column.
