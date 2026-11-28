# Other pages: group, overview, rollout, employee, messages, audit, small dialogs (UI pass, 2026-11-28)

Status: **planned, decisions taken with the recommended option** (owner reviews afterwards, section 11).
Scope: `/groups/:id`, `/`, `/groups/:id/rollout` (+ Roll back dialog), `/employees/new` and `/employees/:id`,
`/broadcasts` + the Send a message dialog, `/audit` (wording and filters), the Assign app / Edit assignment and Add
file type dialogs. Binding: `README.md` (rules, bands, component contract), `audit.md` (rows covered: section 12),
`lists-and-cards.md` (every table/cards list here uses its `Column` roles, `RowActions`, `Truncate`; not re-planned),
`device-detail.md` (same header + "Needs attention" + tabs language), PRD 24.3 (rings, one-click rollback), 24.4
(messages), 7.3 (file types). Owner decision recorded: **the first employee password gets a Generate button
(option (a)); the employee does not set it.**

Cross-plan notes: `lockdown.md` owns the words in `overview/strings.ts` (trial run, "Lockdown not applied") and the
group lockdown page; this plan only changes how `LockdownAttention` is laid out. `device-detail.md` uses "Gets
changes: First / Early / With everyone" for the ring: this plan uses the same stage names (D10). The lists plan's
step L7c (column arrays in GroupDetail, Overview) runs **after** steps O4/O5 here, and L7b (Audit, FileTypes columns)
runs **before** O9/O10.

## 0. Shared pieces this plan adds (used by several pages)

| Piece | File | API / behaviour |
|---|---|---|
| `ChoiceCards` | `components/ChoiceCards.tsx` | `{ name, value, onChange, options: { value, label, hint?, art?: ReactNode, disabled? }[], columns?: 2\|3, "aria-label" }`; a `radiogroup` of large cards (roving arrows like `SegmentedControl`), selected = accent border + check icon (`check-circle-bold-duotone`). Stacks to one column under 420 px container. |
| `ChipPicker` | `components/ChipPicker.tsx` | `{ label, value: string[], onChange, options: SelectOption[], max?, emptyText, searchPlaceholder }`: chips (name + remove ×, `aria-label "Remove Front desk"`) followed by a `SearchSelect` "Add…" whose options exclude the chosen ones; Backspace in the empty search removes the last chip. Over 12 chips: first 12 + "+N more" toggle. |
| `MoreMenu` | `components/MoreMenu.tsx` | ⋯ button (`menu-dots-linear`, `aria-label`) + `MenuList` placed with `placeFloating`; items `{ label, icon?, onSelect \| to, danger?, hidden? }`, danger items last after a divider. Esc returns focus. |
| `AttentionList` | `components/AttentionList.tsx` | `{ items: AttentionItem[], max = 5, emptyText }`, `AttentionItem = { key, tone: "danger"\|"warning"\|"info", icon, title, body?, action?: { label, to } \| { label, onClick } }`. Sorted danger → warning → info; cards in a container-query grid (1 col < 560, 2 cols ≥ 560); "Show all (n)" / "Show fewer" when over `max` (client only). Same look as the device page's problem cards. |
| `StatTile` | `components/StatTile.tsx` | `{ label, value, sub?, to? \| onClick?, tone?, info? }`: compact tile (≈ 72 px high), in `dash-grid--auto`; replaces the tall `dash-stat`. |
| password generator | `lib/password.ts` | `generatePassword(): string`: 12 characters from `abcdefghjkmnpqrstuvwxyz23456789` via `crypto.getRandomValues` (rejection sampling), shown grouped `k7mq-p4xt-9wrb` (dashes are part of the password: 14 chars). Always passes `v.employeePassword`. |
| audit words | `lib/auditText.ts` | `plainSummary(entry): string` (section 6), `actorKind(type)`. |

CSS for these goes in `styles/dashboard.css`, one named section each ("Choice cards", "Chip picker", "Attention",
"Stat tile"). Animation: none except the existing `dash-enter`; hover lift via `transform` off under reduced motion/Lite.

## 1. Group detail `/groups/:id`

### 1.1 Inventory and classification (`GroupDetail.tsx`, `display/GroupDisplayCard.tsx`, `groups/AssignmentDialogs.tsx`)

| # | Control (today) | Class | New treatment |
|---|---|---|---|
| G1 | Back "All groups", h1 name, description lead | up front | header; name wraps anywhere, clamp 2 lines on phone |
| G2 | Pills "3 devices", "34 employees" | up front → tiles | tiles on Overview (PCs, People, Apps, Protection) |
| G3 | Lockdown link | up front | ghost "Protection" in the header (everyone) |
| G4 | Rollout link | 1 click | ⋯ More "Staged rollout" + row in "How this group is set up" |
| G5 | Edit (name, description dialog) | 1 click | ⋯ More "Rename" (admin); dialog unchanged |
| G6 | Delete (type to confirm / dependents) | 1 click | ⋯ More "Delete group" (admin, danger, last); dialogs unchanged |
| G7 | Apps card: glyph, name link, Who sees it, pins, Edit, Unassign, Assign app | up front | Overview main: assignments `DataTable` (global view; cards default on phone) with `rowActions` Edit / Unassign; "Assign app" is the header primary |
| G8 | Display and memory card: mode, window cap, idle close, Save (all full width, shown to all) | **Advanced** | one row "Display: Automatic" in the setup card; admin "Change" opens `GroupDisplayDialog` (the three `Select`s, long hints → `info`) |
| G9 | Devices list (name, kiosk, pager) | 1 click | **PCs tab**: framed `ServerTable` (name, status, kiosk, policy cells from `DeviceCells.tsx`), "Add a PC" → `/enrollment?group=<id>` |
| G10 | Employees list (name + username, Remove, Add employee dialog) | 1 click | **People tab**: framed `ServerTable`, `rowActions` Remove, toolbar "Add people" (existing search-first dialog) |
| G11 | History panel | 1 click | **Activity tab**: `HistoryPanel` full width |
| G12 | (new) Needs attention / get-ready checklist | auto | section 1.2 |
| G13 | (new) Send a message to this group | 1 click | ⋯ More "Send a message" (admin): `SendBroadcastDialog` with the group preset |

Inputs a normal user would not understand: display mode, window cap, idle close (G8) → hidden behind a dialog,
default Automatic, one line "Older PCs use a lighter look by themselves" + (i). Nothing else on this page is technical.

### 1.2 Needs attention (pure `screens/group/problems.ts`, `groupProblems(g, role): AttentionItem[]`)

| When | Tone | Title | Action |
|---|---|---|---|
| `rollout.state === "halted"` | danger | The staged rollout is paused | "Open rollout" |
| `lockdownAuditSince` older than 14 days | warning | Program blocking is still a trial run | "Open protection" |
| an assigned app is archived | warning | "PDF Reader is archived. PCs no longer get it." | admin: "Unassign" (opens the confirm) |
| `rollout.enabled` and state rolling | info | A change is reaching the first PCs | "Open rollout" |

**Empty group** (any of apps, PCs, people is 0): a "Get this group ready" checklist card replaces the info rows:
① Assign apps ("Assign app" opens the dialog) ② Add people (opens the People tab with the add dialog) ③ Add PCs
(→ `/enrollment?group=<id>`; `enrollment-networks.md` preselects the group from `?group=` if present, else ignored).
Done steps get a check and muted text; the card disappears when all three are done. Viewers see it without buttons.

### 1.3 Tabs and data

`PageTabs` + `useUrlTab(["overview","pcs","people","activity"], "overview")`; the default writes no `?tab=`.

| Tab | Holds | Queries while open | Badge |
|---|---|---|---|
| Overview | tiles, needs attention / checklist, apps, "How this group is set up" | `groups:get` | count of danger + warning |
| PCs (n) | PC list | `groups:get` (header) + `fleet:list({ groupId })` | — |
| People (n) | employee list | + `employees:list({ groupId })` | — |
| Activity | history | + `audit:forTarget` | — |

`groups:get` gains two fields (no new query): `rollout: { enabled: boolean; state: "idle"\|"rolling"\|"halted" } \| null`
(`groupRollouts.by_group` `.unique()`, 1 read ≤ 2 KB) and `lockdownAuditSince: number \| null`
(`groupLockdown.by_group` `.unique()`, 1 read ≤ 2 KB). The assignment rows already carry `archived` (server) → map it
into `AssignmentRow.archived`. Re-runs added: a rollout row change (promote, snapshot) and a lockdown save of this
group, both rare. `ioBudgets.ts`: `"groups:get"` → `maxReads: 3 + 1 + 150 + 150 + 1002 + 2`, `maxReadBytes: 604_096`.
Demo: `demo/hooks.ts` `useGroupDetail` fills both from `db.rollouts` / the lockdown fixture ("Pharmacy counter" has
rings on; add a trial-run date to one group so the warning shows). Today the page holds 4 subscriptions at once
(`get`, devices, employees, history); after: 1 on Overview, 2 on the other tabs.

### 1.4 Layout per band

- **Header** (`group/Header.tsx`): back; h1 + description; actions right of the title on tablet+ (container ≥ 640 px):
  primary "Assign app" (admin), ghost "Protection", `MoreMenu`. Phone: a row under the lead: [Assign app] (flex 1)
  [Protection] [⋯]. Sticky tab bar as on the device page (compact name fades in when the h1 leaves the view).
- **Overview**: tiles `dash-grid--auto` (PCs, People, Apps, Protection: "Trial run" / "Set up"), then `dash-split`:
  main = attention/checklist + Apps; aside = "How this group is set up" (Protection, Staged rollout On/Off/Paused,
  Display, each a row with value + link). Phone: tiles 2×2, everything one column, aside last, a sticky bottom bar
  "Assign app" (admin, only while the header button is out of view, IntersectionObserver). Tablet: tiles 4 across,
  aside cards `dash-grid--2` under the apps. Wide: split 2:1, apps cards 3 columns (container query of lists plan).
- **PCs / People**: framed list full width at every band (lists plan toolbar and footer rules).

Laptop 1366, Overview:
```
| < All groups                                                                           |
| Pharmacy counter                                [+ Assign app] [Protection] [ ⋯ ]      |
| Dispensing and label printing.                                                         |
|========================================================================================|
| Overview (1) | PCs 3 | People 34 | Activity                              <- sticky     |
|========================================================================================|
| [PCs  3 ] [People 34] [Apps  4 ] [Protection  Trial run]                               |
| Needs attention                                  | How this group is set up            |
| (!) PDF Reader is archived. PCs no      [Unass.] | Protection     Trial run  [Open]    |
|     longer get it.                               | Staged rollout On         [Open]    |
| Apps                                    4 apps   | Display        Automatic [Change]   |
| +----------------+ +----------------+            |   (i) Older PCs use a lighter look. |
| |[D] Drug ref.   | |[P] PDF Reader  |            |                                     |
| |Everyone        | |Everyone        |            |                                     |
| |Taskbar·Desktop | |Desktop         |            |                                     |
| |   [Edit][Unas.]| |   [Edit][Unas.]|            |                                     |
```
Phone 390, Overview:
```
| < All groups              |
| Pharmacy counter          |
| Dispensing and label pr…  |
| [ + Assign app ][Prot][⋯] |
|===========================|
| Overview(1) PCs 3 People >|
|===========================|
| [PCs   3 ][People 34]     |
| [Apps  4 ][Protection…]   |
| (!) PDF Reader is archived|
|     [ Unassign ]          |
| Apps                      |
| [D] Drug reference        |
|  Everyone · Taskbar, Desk.|
|  [Edit] [Unassign]        |
| How this group is set up  |
|---------------------------|
| [   + Assign app   ]  <- sticky bottom |
```

### 1.5 Strings (`screens/group/strings.ts`, new; `lib/screenStrings/group.ts` keeps shared keys)

Tabs "Overview · PCs · People · Activity"; tiles "PCs", "People", "Apps", "Protection" (values "Trial run" /
"Set up"); setup card "How this group is set up", rows "Protection", "Staged rollout" (On / Off / Paused, (i) "Send
changes to a few PCs first, then to the rest."), "Display" (Automatic / Lite / Standard, (i) "PCs with 4 GB of memory
or less use a lighter look by themselves."); More "Staged rollout", "Send a message", "Rename", "Delete group";
checklist "Get this group ready", "Assign apps", "Add people", "Add PCs"; problems as in 1.2. Audience words come from
section 7.1. `groups.devices` "Devices" → "PCs"; `employees` "Employees" → "People".

### 1.6 Edge cases and roles

Viewer: Protection + More (Staged rollout only); no Assign, no row actions, display row read-only, checklist without
buttons. Group with 500+ PCs: tile "500+" (capped counts). Revoked PCs dim in the PCs tab. 150 apps (the cap):
`groups:get` returns them all and the assignments list shows them without a pager, as today. Delete with dependents: the existing explanation dialog. Long app names: `Truncate` (lists plan).
Unknown `?tab=`: Overview. Old server without the new fields: no rollout/trial warnings, setup rows show "—".

## 2. Overview `/`

### 2.1 Inventory and classification (`Overview.tsx`, `overview/LockdownAttention.tsx`, `lib/strings.ts` overview)

| # | Control | Class | New treatment |
|---|---|---|---|
| V1 | Greeting h1 ("Good morning") | up front | kept |
| V2 | Lead "N things need a look…" | up front | **status line** under the greeting with tone icon: "Everything is fine on your 523 PCs." / "3 things need you." (danger tone if any danger) |
| V3 | Add a PC, Add employee (ghost), Add app (primary) | up front | laptop: same, one primary; phone: one "Add" button opening a `MenuList` (PC, employee, app) |
| V4 | 4 tall stat cards (PCs, Online of, Employees, Apps + groups) | up front | 4 compact `StatTile`s: PCs (sub "498 online"), Employees, Apps (sub "in 12 groups"), Failed installs (warning tone when > 0, opens the dialog) |
| V5 | Attention list: no key, rotating, publish failed, roster pending, suspended, limits ×4, no group, large fleet, out of support + 3 lockdown lines | up front | `AttentionList` max 5, most urgent first; wording in 2.3 |
| V6 | Failed installs: paginated table (the tallest thing) | 1 click | top 5 compact list + "See all (n)" → wide `Modal` with today's `ServerTable` (sizes 10/25/50) |
| V7 | Recent activity timeline + View all | up front | aside; summaries through `plainSummary` |

### 2.2 Data

No server change. `overview:get` unchanged. Failed installs card: `useFailedInstallsPage({ numItems: 5, sort:
updated desc, enabled: count > 0 && !dialogOpen })`; the dialog subscribes its own page (10 default) and the card
pauses while it is open (one subscription at a time). `overview:failedInstallsPage` reads ≤ 3 + 4 × 5 for the card
(was 10 per page). No `ioBudgets` change (same function, smaller page). Demo: unchanged hooks.

### 2.3 Strings (plain words; `lib/strings.ts` `overview`)

| Key | New text |
|---|---|
| statusCalm(n) | "Everything is fine on your {n} PCs." (0 PCs: "Welcome. Add your first PC to get started." + link) |
| statusAttention(k) | "{k} thing(s) need you." |
| noKeyTitle / Detail | "PCs can't be added yet" / "An owner needs to set up the signing key." |
| rotatingTitle | "A key change is in progress" / "Finish it once every PC has the new key." |
| publishFailedTitle | "Changes are not reaching your PCs" / "Open Settings and press Publish again." |
| rosterPendingTitle | "A disabled employee can still sign in on some PCs" / "Open Settings and press Publish again." |
| noGroupTitle(n) | "{n} PC(s) not in a group" / "Nobody can sign in on them until they are in one." |
| outOfSupportTitle(n) | "{n} PC(s) need a Windows update" / "Their Windows no longer gets security fixes." |
| largeFleetTitle / Detail | **owners only**: "More than 300 PCs" / "Ask your Rulebox provider whether your plan covers this many." (no vendor name; audit `lib/strings.ts:337-338`) |
| limitTitle / overLimitTitle | unchanged meaning, shorter: "You can't add more {what}" / "You have more {what} than your plan allows" |
| failedCard | "Failed installs", "See all ({n})", row "Zoom on RECEPTION-01" + reason (1 line) + "2 h ago" |
| lockdown lines | words from `lockdown.md` (`overview/strings.ts`), untouched here |

### 2.4 Layout per band

Laptop: header; status line; tiles 4 across; `dash-split` main = Needs attention + Failed installs, aside = Recent
activity. Wide ≥ 1600: three columns `dash-grid--3`-like (`overview.css`, grid 5fr 4fr 4fr): Needs attention |
Failed installs | Recent activity. Tablet: tiles 4 across (2×2 under 700 px container); attention full width; failed +
activity `dash-grid--2`. Phone: tiles 2×2, attention (actions full width under the text), failed, activity (first 6).

Laptop 1366:
```
| Good morning                                    [+ Add a PC] [+ Add employee] [Add app] |
| (!) 3 things need you.                                                                  |
| [PCs 523 · 498 online] [Employees 1,204] [Apps 37 · in 12 groups] [Failed installs 4]   |
| Needs attention                                   | Recent activity        View all >    |
| +---------------------+ +---------------------+   | (o) App assigned · Front desk       |
| |(!) Changes are not  | |/!\ 2 PCs not in a   |   |     owner@… · 5 min ago             |
| | reaching your PCs   | | group      [Show]   |   | (o) PC enrolled · RECEPTION-04      |
| | [Open Settings]     | +---------------------+   |     …                               |
| +---------------------+   Show all (6)            |                                     |
| Failed installs (4)                 See all >     |                                     |
| Zoom on RECEPTION-01 · Download failed · 2 h ago  |                                     |
```
Phone 390:
```
| Good morning      [+ Add v] |
| (!) 3 things need you.      |
| [PCs 523   ][Employees 1204]|
| [Apps 37   ][Failed 4      ]|
| Needs attention             |
| (!) Changes are not reaching|
|     your PCs                |
|     [   Open Settings    ]  |
| /!\ 2 PCs not in a group    |
|     [       Show        ]   |
| Show all (6)                |
| Failed installs   See all > |
| Recent activity   View all >|
```

Edge cases: 0 PCs (welcome status, tiles show 0, checklist-like attention "Add your first PC"); viewer: no Add
buttons, attention actions that need admin hidden (links to Settings stay); suspended org: danger first; lockdown
chunk still lazy (rendered as `AttentionItem`s by `LockdownAttention`, so it merges into the same sorted grid).

## 3. Rollout `/groups/:id/rollout` (+ Roll back dialog)

### 3.1 Inventory and classification (`Rollout.tsx`, `rollout/*.tsx`, `rollout/strings.ts`)

| # | Control | Class | New treatment |
|---|---|---|---|
| R1 | Title "Rollout of X", long lead | up front | title "Staged rollout", lead "{group}: send changes to a few PCs first." + (i) |
| R2 | No configuration yet | up front | "This group has no changes to send yet. Assign an app first." + link to the group |
| R3 | Paused banner + Resume | up front | danger banner on top, Resume = the page's primary |
| R4 | Rings switch card + confirm off | up front | **Off**: one hero card "Try changes on a few PCs first" + primary "Turn on" (→ 3.2). **On**: "Turn off" in `MoreMenu` (confirm kept) |
| R5 | Pointers list (ring, help, "Version 7", reason, date, "Getting it now") | up front | **pipeline** of 3 stages (3.3); version numbers hidden (title attribute + (i)) |
| R6 | Promote to Early / Everyone, Promote all (confirm), Roll back | up front | the next action on the active stage ("Send to Early PCs" primary); "Send to everyone now" (confirm) and "Undo the last change" in the page `MoreMenu` and under the pipeline as ghost buttons |
| R7 | Health card (applied, failed, partly, waiting, caps, notes) | up front | inside the active stage: a 4-part bar + counts; capped notes as (i) |
| R8 | Auto promotion form: switch, hours, %, return-pilot switch, Save/Discard | **A+D+H** | "Moves on by itself": `ChoiceCards` Off / Careful / Quick (+ "Custom" when saved values match neither); Advanced: hours, %, "Send the first PCs back when it stops" switch |
| R9 | PCs and their rings: select all, checkboxes, ring pills, "Put selected PCs in" buttons | 1 click | card "Which PCs go first": list with stage pills; selection bar "Move 2 PCs to [First ▾] [Move]" (`Select`) |
| R10 | Roll back dialog: version select, ring checkboxes | **D+H** | 3.4 |

Technical inputs: bake hours, failure %, auto-rollback, version numbers, ring names → presets, Advanced, hidden.

### 3.2 Turning stages on (automation)

"Turn on" opens `FirstPcsDialog`: "Which PCs get changes first?" with the group's PCs (≤ 100 from `groupView`),
search box (local filter of that bounded list), the **first PC preselected** (or the ones already in First). Confirm =
`setRings({ ring: "pilot", deviceIds })` → its returned `revision` → `setEnabled({ enabled: true })`. Skipped when
First already has PCs. Errors as today (`rolloutErrorMessage`). No server change. A group with 0 PCs: button disabled,
"Add PCs to this group first."

### 3.3 Stages (names: First / Early / Everyone, D10)

Each stage card: name, "n PCs" (counted from `view.devices`; "100+" when truncated), what it has ("The newest change"
/ "Change of 25 Nov: Lockdown settings changed", version in `title`), state chip: "Up to date" / "Testing now" /
"Waiting". The active stage (`view.stage`) holds the health bar (only then `rollouts:health` is subscribed, as today)
and the next action. Auto on: "Moves on by itself in 18 h if nothing fails" (from `stageStartedAt + bakeHours`).

### 3.4 Roll back dialog (`RollbackDialog.tsx`)

Default: **"Undo the last change"**: "PCs go back to: Lockdown settings changed (25 Nov)." All stages. One click
(major action: step-up stays). Advanced: "Choose another change" (`Select`, options "25 Nov: Lockdown settings changed",
newest first, version in `hint`) and "Which stages go back" (3 checkboxes; with stages off: not shown). Lead shortened:
"Your settings stay as they are; only the PCs go back." (i) "The next change you make is sent as a new one."

### 3.5 Data

No server change, no new query: `rollouts:groupView` (page) + `rollouts:health` (only while a stage is in flight).
Stage PC counts come from `groupView.devices` (bounded 101). Demo unchanged.

### 3.6 Layout per band

Laptop: header (title, lead, `MoreMenu`: Send to everyone now, Undo the last change, Turn off); banner if paused;
pipeline 3 columns with arrow connectors (CSS); `dash-split` main = "Which PCs go first", aside = "Moves on by
itself". Wide: same, max 1480. Tablet: pipeline 3 columns (each ≥ 200 px) else vertical; cards stacked. Phone:
vertical stepper (stages stacked with a 2 px connector line), action full width inside the active stage.

Laptop 1366 (stages on, a change testing on First):
```
| < Pharmacy counter                                                                       |
| Staged rollout                                                                  [ ⋯ ]    |
| Pharmacy counter: send changes to a few PCs first. (i)                                   |
| +--------------------------+   +--------------------------+   +-------------------------+ |
| | FIRST · 1 PC             |-->| EARLY · 2 PCs            |-->| EVERYONE · 18 PCs       | |
| | Testing now              |   | Waiting                  |   | Waiting                 | |
| | Lockdown settings changed|   | App assigned, 20 Nov     |   | App assigned, 20 Nov    | |
| | [####......] 1 done      |   |                          |   |                         | |
| | 0 failed · 0 waiting     |   |                          |   |                         | |
| | [Send to Early PCs]      |   |                          |   |                         | |
| +--------------------------+   +--------------------------+   +-------------------------+ |
| [Send to everyone now] [Undo the last change]                                           |
| Which PCs go first                             | Moves on by itself                      |
| [x] COUNTER-01            [First]              | ( ) Off   (o) Careful   ( ) Quick       |
| [ ] COUNTER-02            [Early]              | Careful: after 24 h, stops if 10 % fail |
| 1 selected  Move to [Early v] [Move]           | > Advanced                    [Save]    |
```
Phone 390:
```
| < Pharmacy counter     [⋯] |
| Staged rollout             |
| (1) FIRST · 1 PC           |
|  |  Testing now            |
|  |  [####....] 1 done      |
|  |  [ Send to Early PCs ]  |
| (2) EARLY · 2 PCs  Waiting |
|  |                         |
| (3) EVERYONE · 18  Waiting |
| Which PCs go first         |
| Moves on by itself         |
```

### 3.7 Strings (`rollout/strings.ts`)

Stages `{ pilot: "First", early: "Early", everyone: "Everyone" }`, help (i): First "One or two PCs you can check
yourself.", Early "A few more PCs.", Everyone "All other PCs in the group."; states "Up to date" / "Testing now" /
"Waiting"; actions "Send to Early PCs", "Send to everyone", "Send to everyone now" (confirm "Every PC in this group gets
this change now, without waiting."), "Undo the last change", "Resume"; presets Off "You send each step yourself.",
Careful "After 24 hours, if fewer than 10 % fail." (`bake 24, pct 10`), Quick "After 4 hours, if fewer than 20 %
fail." (`bake 4, pct 20`), Custom "{h} hours, stops at {p} %"; Advanced labels "Wait before moving on (hours)",
"Stop when this share fails (%)", "Send the first PCs back when it stops"; halt reasons reworded ("Too many PCs could
not apply the change.", "A first PC went back to its last working settings.", "Someone undid the change."). Errors
keep their codes, words use the new stage names.

### 3.8 Edge cases and roles

Viewer: pipeline and lists read-only, no buttons, auto card as one sentence. Paused: Send buttons hidden, Resume
primary. Stages off: pipeline replaced by the hero card; members list still visible (to prepare First). Stale edit:
FormError Reload as today. > 100 PCs: "Showing the first 100" stays.

## 4. Employee `/employees/new`, `/employees/:id`

### 4.1 Inventory and classification (`EmployeeDetail.tsx`, `lib/screenStrings/employee.ts`)

| # | Control | Class | New treatment |
|---|---|---|---|
| E1 | Full name | up front | kept |
| E2 | Username (letters/digits/dots… hint) | **A** | derived from the name, shown as "Signs in as **maria.fernanda**" + "Change" (reveals the input with the rule as (i)); existing: same line, Change reveals it |
| E3 | Storage quota (GB), empty = default, 0 = unlimited | **H+D** | Advanced: `Select` "Organization default (10 GB)" / "Unlimited" / "Custom…" (number field appears) |
| E4 | Groups: checkbox list of every group | **P** | `ChipPicker` "Groups" hint "Can sign in on the PCs of these groups." |
| E5 | Extra apps: checkbox list (+ desktop note) | **P+H** | link "+ Give extra apps" reveals a `ChipPicker` (shown when any); desktop note as option `hint` |
| E6 | First password (new, optional) | **A** (owner decision) | "Password" row prefilled with a generated password (visible, Copy, "Generate another", "Type my own") |
| E7 | Create / Save changes, Cancel, unsaved hint | up front | laptop: form footer; phone: sticky save bar when dirty |
| E8 | Read-only profile (viewer) | — | same layout, values as text/chips |
| E9 | Disabled notice, Locked-out notice + Unlock | up front | kept (notice row under the header) |
| E10 | Password card + Set password dialog (new + repeat) | aside | card "Password: set 3 days ago" + "New password" → dialog: generated by default (Copy); "Type my own" shows one field + repeat |
| E11 | Account card (danger tone): Disable/Enable, Delete (type username) | aside | **neutral** card; Disable (danger-ghost) / Enable; Delete only when disabled (as today) |
| E12 | History | aside | `HistoryPanel` (5 rows, lists plan) |
| E13 | (new) Summary on "new" | aside | live sentence card (4.3) |

### 4.2 Create flow with the generated password

New form opens with a generated password already in the field (`generatePassword()`, plain text, monospace, Copy).
Create sends it to `employees:create` (password only to the action, as today). On success a **hand-over dialog**:
"Maria is added. Give her this password: `k7mq-p4xt-9wrb` [Copy]" + "She uses it with the sign-in name
maria.fernanda." [Done] → navigates to the employee. The password lives only in component state (never in router
state, storage or a URL). "Type my own" switches to a `PasswordInput` with the rule line visible.

### 4.3 Data

No server change. `employees:get` / `employees:options` already return `groupOptions` (≤ 500), `appOptions` (≤ 500),
`defaultQuotaGb`; the pickers filter those bounded lists in the browser (an option list, not a table). Save stays one
call (`employees:save` / `create`). Summary: "Maria can sign in on the PCs of Front desk and Kitchen and gets their
apps, plus 2 extra." (names from options; no counts, which would need a query).

### 4.4 Layout per band

Laptop/wide: `dash-split` main = Profile card (`dash-form-grid`: name | sign-in line; Groups full; Extra apps full;
Password full on new; Advanced last); aside = new: Summary; existing: Password, Account, History. Tablet: one column,
aside cards `dash-grid--2` below. Phone: one column, sticky Save/Create bar.

Laptop 1366, new:
```
| < All employees                                                                         |
| Add employee                                                                            |
| Profile                                              | Summary                          |
| Full name                Signs in as                 | Maria Fernanda                   |
| [Maria Fernanda       ]  maria.fernanda  [Change](i) | signs in as maria.fernanda       |
| Groups                                               | Can sign in on the PCs of Front  |
| [Front desk x] [Kitchen x] [Add…              v]     | desk and Kitchen and gets their  |
| + Give extra apps                                    | apps.                            |
| Password                                             |                                  |
| k7mq-p4xt-9wrb   [Copy] [Generate another]           |                                  |
| Type my own                                          |                                  |
| > Advanced (Storage: organization default, 10 GB)    |                                  |
| [Create employee]  Cancel                            |                                  |
```
Phone 390, existing:
```
| < All employees            |
| Maria Fernanda             |
| maria.fernanda · ● Active  |
| Profile                    |
| Full name [Maria Fern…   ] |
| Signs in as maria.fernanda |
|   [Change]                 |
| Groups [Front desk x] [+]  |
| Password: set 3 days ago   |
|   [New password]           |
| Account  [Disable]         |
| History …                  |
|[      Save changes      ]  | <- sticky when dirty
```

### 4.5 Strings (`lib/screenStrings/employee.ts`)

`username` "Signs in as", (i) "The name the employee types on the PC. Letters, digits, dots, dashes and
underscores."; `change` "Change"; `groupsHint` "Can sign in on the PCs of these groups."; `appsAdd` "+ Give extra
apps", (i) "Apps for this person only, on top of their groups' apps. Windows apps only appear on PCs whose group has
them."; `quota` "Storage", options "Organization default ({n} GB)" / "Unlimited" / "Custom"; `password` "Password",
`generate` "Generate another", `typeOwn` "Type my own", `useGenerated` "Use a generated password", `copy` "Copy" /
"Copied"; hand-over `handoverTitle(name)` "{name} is added", `handoverBody` "Give them this password. It is not shown
again."; `summary(name, groups, extra)`; `accountTitle` "Account"; `disabledHelp` short "A disabled employee can't sign
in anywhere." (rest to (i)); `passwordInitialHint` removed (generated by default).

### 4.6 Edge cases and roles

Viewer: read-only profile, no password/account buttons, new page shows "read only" notice (as today). Name with
accents/emoji → username via `suggestUsername` (unchanged); empty result → the input opens with the error. Username
taken → error under the opened input. 0 groups in the org → picker empty text "No groups yet" + link. 500 groups:
searchable picker handles it. A user who navigates away after create without Done: the password is lost; the Password
card says "Set just now" and "New password" makes another. Clipboard blocked: Copy shows "Select and copy it".

## 5. Messages `/broadcasts` + Send a message

### 5.1 Inventory and classification (`Broadcasts.tsx`, `broadcasts/SendDialog.tsx`, `Preview.tsx`, `strings.ts`)

| # | Control | Class | New treatment |
|---|---|---|---|
| M1 | Title, 3-sentence lead | up front | lead "Banners and full-screen notices on your PCs." + (i) "Plain text only. Never shown on the Windows sign-in screen." |
| M2 | Send a message (primary) | up front | kept |
| M3 | List (message, to, sent, status, acknowledged, Cancel) | up front | lists plan (L7b); unchanged here |
| M4 | (new) Live now strip | up front | 5.2 |
| D1 | Group `NativeSelect` | **P+D** | `SearchSelect` of groups; preset from the group page; auto-chosen when the org has exactly one group |
| D2 | Style select + hint | **P** | `ChoiceCards` with a mini drawing: "Banner" ("A strip at the top. People can close it.") / "Full screen" ("Covers the screen until someone presses OK.") |
| D3 | Title + counter "12 / 80" | up front | counter only at ≥ 80 % of the limit |
| D4 | Message + counter "0 / 500" | up front | same |
| D5 | Show for select (5 choices) | **D** | `SegmentedControl` "1 hour · 1 day · 1 week · Until I cancel", default 1 day ("4 hours" dropped from the UI) |
| D6 | Ask for an acknowledgement + 2-line hint | **D** | checkbox "Keep it until someone presses OK", hint → (i) "Rulebox counts the PCs where OK was pressed, never who pressed it." |
| D7 | Preview (below everything) | up front | beside the form on laptop (sticky), under it on phone |

### 5.2 Live now

A strip above the list: "On your PCs now" with up to 20 small cards (style icon, title, "Front desk", "until Tue
14:00", "14 of 20 saw it" when OK is asked, admin "Cancel"). None: one muted line "Nothing is showing on your PCs right
now." Horizontal scroll-snap row on phone, `dash-grid--auto` (min 260 px) on tablet+.

Data: **new query `broadcasts:live`** (viewer) in `convex/broadcasts.ts`: two ranges of the existing index
`by_org_open`: never-expiring `.eq(orgId).eq("cancelledAt", undefined).eq("expiresAt", undefined).take(21)` and
timed `.eq(orgId).eq("cancelledAt", undefined).order("desc").take(21)` (largest expiry first, so every live timed one
is in it; no clock in the query), + target names (per-query cache, ≤ 42 gets). Returns ≤ 42 rows of `broadcastRow`;
the client keeps those not expired by its own clock (`useNow(30_000)`, already on the page). Reads ≤ 3 + 21 + 21 +
42 = 87, ~60 KB. Re-runs on a send, a cancel, an ack count change of those rows. `ioBudgets.ts`: `"broadcasts:live":
{ maxReads: 87, maxReadBytes: 64_000, maxWrites: 0, maxWriteBytes: 0, live: true }`. Seam: `useLiveBroadcasts()`
(main seam next to `useBroadcastsPage`), demo filters `db.broadcasts`. `tests/convex/matrixRows.ts`: add the row.

Compose data: unchanged (`useGroupsScreen`, `broadcasts:send`). `SendTarget` becomes `{ kind: "group"; id?: string;
name?: string } | { kind: "device"; id; name }` (preset group shows "To: Front desk" with "Change").

### 5.3 Layout

Page laptop: header; Live now grid; the list (lists plan). Dialog: `Modal wide`; ≥ 860 px: two columns (form 3fr |
preview 2fr, preview sticky); < 860: one column, preview after Show for; phone: bottom sheet, sticky Send.

Dialog, laptop:
```
| Send a message                                                            [x] |
| To        [Front desk                v]   | PREVIEW                           |
| Style     +-----------+ +------------+    | +-------------------------------+ |
|           |[==]Banner | |[##]Full scr| |    | | Maintenance at 5 pm   [Close] | |
|           | strip...  | | covers...  |     | |                               | |
|           +-----------+ +------------+    | |        desktop                | |
| Title     [Maintenance at 5 pm        ]   | +-------------------------------+ |
| Message   [Please save your work…     ]   |                                   |
| Show for  [1 hour|1 day|1 week|Until…]    |                                   |
| [ ] Keep it until someone presses OK (i)  |                                   |
|                                   [Cancel] [Send]                             |
```
Page, phone 390:
```
| Messages     [+ Send]   |
| On your PCs now         |
| [Maintenance…][Inventor>|  <- scroll-snap
| Front desk · until 17:00|
| [Search…]  [▦]          |
| card list (lists plan)  |
```

### 5.4 Edge cases and roles

Viewer: no Send, no Cancel (strip read-only). 20 active: Send stays enabled; the server refusal "You can have 20
active messages at a time. Cancel one first." shows inline (as today) and the strip shows them. Target deleted:
"(deleted)". No groups: group picker empty text + link "Create a group". Device target (device page) unchanged: "To:
RECEPTION-01". Markup in text: preview renders text (unchanged test).

## 6. Audit log `/audit` (wording and filters)

### 6.1 Inventory and classification (`Audit.tsx`, `components/AuditItem.tsx`, `lib/screenStrings/audit.ts`)

| # | Control | Class | New treatment |
|---|---|---|---|
| A1 | Lead + "Times are shown in Asia/Karachi." | up front | "Everything that changed, newest first." + "Times are your local time." (zone ID in (i)) |
| A2 | Print | up front | ghost Print + (i) "Prints this page of the log. Choose 50 rows per page to print more." |
| A3 | Columns time / what / who (+ Member/Device/System) / on / details | up front | lists plan types; actor sub-label "Team member" / "PC" / "Rulebox" |
| A4 | Details with field names ("Changed organization settings: offlineDays, power") | **A** | `plainSummary`: known tokens → words |
| A5 | (new) When filter | up front | `SegmentedControl` "All time · Today · 7 days · 30 days" (URL `?since=7d`) |
| A6 | (new) About filter | 1 click | each target cell gets a small "Only this" icon button (`filter-linear`, aria "Show only Front desk"); sets `?about=<id>&label=<name>`; a removable chip "About: Front desk ×" in the toolbar |

`plainSummary` token map (only for actions `org.settingsChanged`, `employee.updated`, `app.permissionsChanged`,
`group.displayModeChanged`): `offlineDays` → "offline sign-in days", `defaultQuotaGb` → "default storage", `power` →
"power options", `adminExit` → "administrator exit", `name` → "name", `quota` → "storage", `username` → "sign-in
name", permission keys (`camera`, `microphone`, `screenShare` → "screen sharing", `clipboardRead` → "clipboard",
`notifications`, `downloads`, `printing`, `location`); unknown camelCase in those actions → split into words. Other
actions: shown as written (server sentences are already plain). Used by the table, cards, `AuditTimelineItem`.

### 6.2 Data

`audit:list` and `audit:forTarget` get `since: v.optional(v.number())` → `.gte("at", since)` on the existing indexes
(`by_org_at`, `by_org_target` both end in `at`). No new index (who/what filters deferred, D25). `since` is computed
from the start of the local day (stable for a day, so the subscription does not churn). Reads unchanged (a page of
≤ 50); `ioBudgets.ts` comments restated, numbers unchanged. Seam: `useAuditScreen({ ...query, since?, targetId? })`
→ live uses `forTarget` when `targetId` is set, else `list`; demo filters `db.audit` the same way.

### 6.3 Layout

Laptop: header (title, lead, Print); toolbar: When segmented · About chip · spacer · view switch; list. Phone:
segmented full width (scrolls sideways if needed), About chip under it, cards (lists plan default on phone).
```
| Audit log                                                          [Print] (i) |
| Everything that changed, newest first. Times are your local time. (i)          |
| [All time | Today | 7 days | 30 days]  [About: Front desk x]        [☰|▦]      |
| WHEN         WHAT              WHO                 ON                DETAILS   |
| 5 min ago    App assigned      owner@… Team member Front desk [⊿]    Drug ref… |
```

### 6.4 Edge cases

Filter with no rows: "Nothing in this period." / "Nothing logged about Front desk in this period." + "Clear filters".
Deleted target: label kept, "Only this" still works (by id). Print prints the filtered page as a table (lists plan).

## 7. Small dialogs

### 7.1 Assign app / Edit assignment (`groups/AssignmentDialogs.tsx`)

| Control | Class | Treatment |
|---|---|---|
| App `NativeSelect` (first app preselected) | **P** | `SearchSelect` with `AppGlyph` icons and kind hint ("Website" / "Windows app"); nothing preselected unless exactly one app is available |
| Who sees it select + 2-line hint | **P+D** | `ChoiceCards` (2): "Everyone in the group" (default) / "Only people I choose" with (i) "Only people who have this app under Extra apps on their employee page." |
| Pins (2 checkboxes) | **D** | one line of two toggle buttons with icons (`aria-pressed`): "Taskbar", "Desktop" (default Desktop on) |

Data unchanged (`apps:options` only while open). Errors unchanged (`assignmentErrorMessage`).

### 7.2 Add file type (`FileTypes.tsx` `AddDialog`)

| Control | Class | Treatment |
|---|---|---|
| Extension input ".pdf" | **P** | chips (multi-select, `aria-pressed`): PDF (.pdf), Word (.docx .doc), Excel (.xlsx .xls), PowerPoint (.pptx .ppt), Pictures (.jpg .jpeg .png .gif .bmp), Music (.mp3 .wav .m4a), Video (.mp4 .mov .avi .mkv), Text (.txt), Zip (.zip); "Other…" reveals the raw input (validated as today) |
| Program select | **P+D** | `SearchSelect` of programs that can open files; preselected when exactly one |

A line under the chips: "Files already set to another program move to this one." Data: **new mutation
`fileHandlers:setMany({ extensions: string[] (1-20), appId })`** so one chip = one configuration version per group (a
loop of `set` would make up to 5 versions and flood the rollback list): validates every extension like `set`, upserts
the rules, one audit row "Files ending in .jpg, .png… now open with X", one `snapshotAppGroups` over the program and
every program that lost an extension, `publishApp` for those. `ioBudgets.ts`: `"fileHandlers:setMany"` = `set`'s row
with `+ 20` rule lookups and up to 21 programs in the snapshot (formula in the file; UNSURE until measured, like the
other publish rows). `matrixRows.ts` row; demo `useSetFileHandlers`. `set` stays for "Other".

### 7.3 Roll back: section 3.4.

## 8. Data summary

| Change | Where | Reads | Notes |
|---|---|---|---|
| `groups:get` + `rollout`, `lockdownAuditSince` | `convex/groups.ts` | +2 | budget row updated |
| `broadcasts:live` (new query) | `convex/broadcasts.ts` | ≤ 87 | existing index `by_org_open` |
| `audit:list`, `audit:forTarget` + `since` | `convex/audit.ts` | unchanged | existing indexes |
| `fileHandlers:setMany` (new mutation) | `convex/fileHandlers.ts` | ≈ `set` × programs | one snapshot per call |
| Overview failed installs page of 5 | screen only | fewer | — |
| Everything else | — | — | no change: rollout, employee, compose, assign |

No schema change, no new index. `_generated/api.d.ts` needs no regeneration (all in existing modules). Convex tests
only via `pnpm test:convex`. Follow-up (not here): pickers use `groups:list`, which reads up to 1,002 count rows per
group it does not need; a names-only `groups:options` would serve every group picker.

## 9. Tests

Changed:
- `screens/step5.test.tsx` "Group detail": header actions (Assign primary; Rename/Delete via More; viewer: no admin
  items); assign dialog via `SearchSelect` (no preselect), audience cards, pin toggles; delete via More; tabs:
  Overview subscribes only `groups:get`, PCs tab adds `fleet:list({ groupId })`.
- `screens/display.test.tsx` GroupDisplayCard → `GroupDisplayDialog` from the setup row (same calls and nulls).
- `screens/step11.test.tsx` EmployeeDetail: save still one call; username line + Change; groups via `ChipPicker`;
  quota via Advanced Select (default → undefined, Unlimited → 0, Custom → n); new: generated password sent to the
  action, hand-over dialog, "Type my own" path keeps the rule messages; Set password dialog: generated by default,
  typed path has repeat; "Group page employees" moves to the People tab.
- `screens/step15.test.tsx` send dialog: group via `SearchSelect`, style cards, segmented expiry (default 1 day,
  "Until I cancel" sends no `expiresAt`), counters hidden below 80 %, preset group target.
- `screens/step17.test.tsx` Overview: card asks for 5 rows; "See all" dialog pages with the cursor; attention words;
  large fleet only for owners, no "Convex"; Audit: plain actor words, summary mapping, `since` and `targetId` args.
- `screens/step19.test.tsx` "the overview warnings" (layout only; words stay with `lockdown.md`), "the group page
  links to it" (Protection button).
- `screens/step10.test.tsx` File types: chips call `setMany`; Other calls `set`; denied extension still refused.
- `data/demo/demo.test.tsx` rollout block if strings move; `data/live/live.test.tsx` new hooks map.
- `convex/` tests: `groups.test.ts` (new fields, null without rows), `broadcasts.test.ts` (`live`: forever + timed,
  cancelled out, expired returned for the client to hide, cross-org isolation), `audit.test.ts` (`since` on both),
  `fileHandlers.test.ts` (`setMany`: denied ext refused as a whole, one audit row, one snapshot, moves rules).

New:
- `components/ChoiceCards.test.tsx`, `ChipPicker.test.tsx`, `MoreMenu.test.tsx`, `AttentionList.test.tsx`
  (keyboard, ARIA, max + Show all, sorting).
- `lib/password.test.ts` (alphabet, length, grouping, passes `employeePassword`, uses `crypto.getRandomValues`).
- `lib/auditText.test.ts` (each token, unknown camelCase split, untouched other actions).
- `screens/group/problems.test.ts` (halted, trial > 14 days, archived app, checklist states, viewer).
- `screens/rollout/rollout.test.tsx`: off → Turn on opens first-PCs dialog with the first PC ticked, then
  `setRings` then `setEnabled` with the returned revision; pipeline states; Send to Early; presets map to numbers and
  "Custom"; Advanced validation messages; rollback defaults to the previous change and all stages; viewer read-only.
- `screens/broadcasts/live.test.tsx`: strip hides expired rows by clock, Cancel for admins only, empty line.

## 10. Build steps (each one Sonnet agent; typecheck + lint + dashboard tests at the end of each)

Rules for every step: only the listed files; no `pnpm install`, `convex dev`, `convex deploy`, git
commit/stash/reset/checkout; Solar icons only; tokens; page CSS next to the screen; screenshots at 390/820/1366/1920
light and dark for the touched pages (`e2e/shots.mjs`, own port).

| Step | Work | Files | Depends | Parallel |
|---|---|---|---|---|
| **O1a** | `ChoiceCards`, `ChipPicker` + tests + CSS sections | `components/ChoiceCards.tsx`, `ChipPicker.tsx`, tests, `dashboard.css` (own sections) | foundations `Select`/`SearchSelect` | with O1b, O1c, O2 (shares `dashboard.css`, separate sections) |
| **O1b** | `MoreMenu`, `AttentionList`, `StatTile` + tests + CSS | `components/MoreMenu.tsx`, `AttentionList.tsx`, `StatTile.tsx`, tests, `dashboard.css` (own sections) | — | with O1a, O1c, O2 |
| **O1c** | `lib/password.ts`, `lib/auditText.ts` + tests | those 4 files | — | with O1a, O1b, O2 |
| **O2** | Convex: `groups:get` fields, `broadcasts:live`, `audit` `since`, `fileHandlers:setMany`, `ioBudgets.ts`, `tests/convex/matrixRows.ts`, convex tests | `convex/groups.ts`, `broadcasts.ts`, `audit.ts`, `fileHandlers.ts`, `ioBudgets.ts`, `tests/convex/matrixRows.ts`, `convex/*.test.ts` | — | with O1* |
| **O3** | Data seam for O2: types (`GroupDetail` fields, `AssignmentRow.archived`), `useLiveBroadcasts`, audit `since`/`targetId`, `useSetFileHandlers`, live + demo + fixtures (trial-run date) + seam tests | `data/types.ts`, `data/api.ts`, `data/index.ts`, `data/audit/*`, `data/live/*`, `data/demo/*`, `data/fixtures/seed.ts` | O2 | — |
| **O4** | Group detail: split into `screens/group/{Header,OverviewTab,PcsTab,PeopleTab,SetupCard,problems,strings}.ts(x)` + `group.css`; `GroupDetail.tsx` composes; `display/GroupDisplayCard.tsx` → dialog; tests (step5 group, display, step11 group employees, step19 link, problems) | those files | O1a, O1b, O3, O8 (`SendTarget`) | with O5, O6, O7, O9, O10 |
| **O5** | Overview: status line, tiles, attention grid, failed top 5 + dialog, wide 3 columns; `LockdownAttention` returns `AttentionItem`s; `overview/overview.css`; `lib/strings.ts` (overview section only); step17/step19 overview tests | `Overview.tsx`, `overview/LockdownAttention.tsx`, `overview/overview.css`, `lib/strings.ts`, tests | O1b, O1c; after `lockdown.md` step 3 (strings) | with O4, O6, O7 (shares `lib/strings.ts` with O9: different sections) |
| **O6** | Rollout: pipeline, first-PCs dialog, presets + Advanced, members card, rollback defaults, `rollout/rollout.css`, strings, `rollout.test.tsx` | `Rollout.tsx`, `rollout/*` | O1a, O1b | with O4, O5, O7 |
| **O7** | Employee: `screens/employee/{ProfileForm,PasswordCard,AccountCard,Summary,HandoverDialog}.tsx` + `employee.css`; `EmployeeDetail.tsx` composes; strings; step11 tests | those files, `lib/screenStrings/employee.ts` | O1a, O1c | with O4, O5, O6 |
| **O8** | Messages: `SendDialog.tsx` (pickers, cards, segmented, counters, side preview, `SendTarget`), `broadcasts/LiveNow.tsx`, `Broadcasts.tsx` (strip + lead), `broadcasts/broadcasts.css`, strings, step15 + live tests | `broadcasts/*`, `Broadcasts.tsx` | O1a, O3; after lists L7b | before O4 |
| **O9** | Audit: filters, plain summary and actor words, time zone line, Print (i); `AuditItem.tsx` uses `plainSummary`; strings; step17 audit tests | `Audit.tsx`, `components/AuditItem.tsx`, `lib/screenStrings/audit.ts`, `lib/strings.ts` (`common.timeZone*`) | O1c, O3; after lists L7b | with O4-O7 |
| **O10** | Dialogs: `AssignmentDialogs.tsx`, `FileTypes.tsx` `AddDialog` (chips, `setMany`), `screens/groups/strings.ts`, `lib/screenStrings/fileTypes.ts`; step5 assign + step10 file-type tests | those files | O1a, O3; after lists L7b | with O4 (O4 imports the dialogs unchanged API) |
| **O11** | Full dashboard tests, `pnpm test:convex`, build + size budget (report any raise), screenshots of every page here at 4 widths × 2 themes, fix pass; update `docs/plans/ui-pass/README.md` table (add this file) | read + small fixes | all | — |

## 11. Decisions taken (recommended option chosen; owner reviews)

1. **Group page shape.** (a) one page, 2:1 split with all lists; (b) header + Needs attention + tabs Overview / PCs /
   People / Activity like the device page; (c) three columns on wide. **(b)**: same product feel, one query per tab,
   no three pagers side by side.
2. **Display and memory.** (a) Advanced disclosure on the page; (b) one row in "How this group is set up" with a
   Change dialog. **(b)**.
3. **Group header actions.** Primary Assign app, ghost Protection, ⋯ More (Staged rollout, Send a message, Rename,
   Delete last). Alternative "all buttons" rejected (Delete next to Edit). **Chosen.**
4. **Group status.** (a) none; (b) +2 reads in `groups:get` (rollout state, trial-run date); (c) subscribe
   `lockdown:groupSync` (≈ 400 reads). **(b)**.
5. **Empty group** gets a 3-step "Get this group ready" checklist. **Chosen.**
6. **Group PCs and People** become full tabs, so they are card-capable lists (changes `lists-and-cards.md` row
   "always table" for these two). **Chosen.**
7. **Overview top.** Status line + 4 compact tiles (Online folded into PCs, Failed installs added). **Chosen.**
8. **Failed installs.** (a) keep the paged table; (b) top 5 + "See all" dialog with the table; (c) a new route.
   **(b)** (no new route or query).
9. **Large-fleet warning.** Owners only, no vendor name. Alternative: remove it. **Chosen.**
10. **Stage names.** (a) Pilot / Early / Everyone; (b) Test PCs / Early PCs / Everyone else (audit); (c) First /
    Early / Everyone (device plan's "Gets changes"). **(c)**. Follow-up for `lockdown.md`: `savedRings` "Pilot PCs" →
    "First PCs".
11. **Turning stages on** picks the first PCs in a dialog (first PC preselected), then `setRings` + `setEnabled`; no
    server change. **Chosen.**
12. **Moving on by itself.** Off / Careful (24 h, 10 %, the server default) / Quick (4 h, 20 %) + Custom; numbers and
    the send-back switch under Advanced. **Chosen.**
13. **Roll back** defaults to "Undo the last change", all stages, one click (PRD 24.3); other versions and stages
    under Advanced. **Chosen.**
14. **Version numbers** hidden behind the change's reason and date (`title` / (i)). **Chosen.**
15. **Username** derived from the name, shown as "Signs in as … [Change]". **Chosen.**
16. **First password: Generate (owner decision (a)).** Prefilled generated password, Copy, "Generate another",
    "Type my own"; hand-over dialog after Create; never stored. Set password dialog generates by default. **Chosen.**
17. **Password format.** 12 characters from an unambiguous alphabet in 3 groups (crypto random) vs a word list (bundle
    size). **Groups of 4.**
18. **Employee pickers.** `ChipPicker` over `SearchSelect` from the options `employees:get` already returns; no
    multi-select added to the shared `SearchSelect` contract. **Chosen.**
19. **Extra apps** behind "+ Give extra apps" (shown when any); Storage under Advanced as a 3-way Select. **Chosen.**
20. **Account card** neutral tone (danger only on the buttons). **Chosen.**
21. **Live now strip.** (a) derived from page 1 of the list (misses old "until cancelled" messages); (b) new bounded
    `broadcasts:live` (≤ 87 reads, existing index, no clock in the query). **(b)**.
22. **"Everyone" as a message target.** Not offered: the server targets one group or one PC; a per-org target is a
    follow-up. **Chosen.**
23. **Show for** as a 4-way segmented control, default 1 day; "4 hours" dropped from the UI. **Chosen.**
24. **Counters** appear at 80 % of the limit. **Chosen.**
25. **Audit filters.** Date range and "About this item" on existing indexes now; who/what filters deferred (each
    would add an index to the growing audit table). **Chosen.**
26. **Audit wording.** Client-side plain words for known field tokens (old and new rows) vs changing server
    summaries (new rows only). **Client-side.**
27. **Time zone** "Times are your local time" with the zone in (i). **Chosen.**
28. **File type chips.** (a) loop `set` per extension (several config versions); (b) new `fileHandlers:setMany` (one
    version). **(b)**.
29. **Assign app** has no preselected app unless only one is available; audience as two cards; pins as toggles.
    **Chosen.**
30. **Group picker data** in the compose dialog stays `groups:list`; a names-only `groups:options` is a follow-up.
    **Chosen.**
31. **Shared components** (`ChoiceCards`, `ChipPicker`, `MoreMenu`, `AttentionList`, `StatTile`) live in
    `apps/dashboard/src/components/`; `lockdown/RadioCards` and the device page's problem cards may adopt them later
    (follow-up). **Chosen.**

## 12. Audit coverage (every `audit.md` row for these pages)

| Audit row | Covered in |
|---|---|
| (a) `/` Overview: tall stat cards, failed-installs table, jargon, "Convex" | 2.1, 2.3, 2.4 |
| (a) `/groups/:id`: five stacked sections, phone row actions, Display for all, Delete next to Edit, three pagers | 1.1-1.4 |
| (a) `/groups/:id/rollout`: six cards, 1000 px number inputs, jargon, plain Promote buttons | 3.1-3.7 |
| (a) `/employees/new` and `/:id`: one long form, checkbox lists, quota alone, loud Account card | 4.1-4.5 |
| (a) `/broadcasts`: lead wraps, nothing "live now"; dialog: hints, no side preview | 5.1-5.3 |
| (a) `/audit`: field names, time-zone ID, actor sub-labels, no filters, Print | 6.1-6.3 |
| (a) `/file-types` add dialog; Assign app; Roll back | 7.2, 7.1, 3.4 |
| (b) priorities 1-8 | sections 1-7 (Group, Overview, Rollout, Employee, Messages, Audit, File types, Assign) |
| (c) GroupDisplayCard (H) | 1.1 G8 |
| (c) Rollout settings (A+D+H), rings (D+P), Rollback (D) | 3.1 R8, R9, 3.2, 3.4 |
| (c) Assign app (P+D) | 7.1 |
| (c) New/edit employee (A, H, P, Generate); employee password (A) | 4.1 E2-E6, E10 |
| (c) Send message (P+D) | 5.1 D1-D7 |
| (c) File type (P) | 7.2 |
| (d) native selects: `SendDialog` 99/112/126, `GroupDisplayCard` 58/66/78, `AssignmentDialogs` 28/92, `RollbackDialog` 90, `FileTypes` 182 | 5.1, 1.1 G8, 7.1, 3.4, 7.2 (all to `Select` / `SearchSelect` / cards / segmented) |
| (d) helper paragraphs: rollout 19, 23, 83, 95, 99, 103, 117; display 4, 12, 14, 18; groups 29; employee 9, 11, 19, 33; broadcasts 47, 53 | 3.7, 1.5, 7.1, 4.5, 5.1 (moved to (i) or removed) |
| (d) `lib/strings.ts:337-338` and overview attention sentences | 2.3 |
