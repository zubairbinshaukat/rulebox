# Phase 4b: one generic table, server-driven lists, PIN sign-in

Status: **approved by the owner 2026-11-03** (decisions below). Written after
Phase 4 Steps 14, 16 and 17 so the table and auth work lands on stable screens.
Not part of the original Phase 4 step list; Steps 18-22 follow after this.

## Owner decisions (2026-11-03)

1. **Settings** opens from a gear icon in the top bar, next to the user avatar.
   It opens a panel anchored in the navbar (like the account menu), not a full
   page. `/settings` stays as a deep link to the same content.
2. **Authenticator app (TOTP) is removed.** This goes against PRD 12.3 and 16
   ("2FA required for Owner and Admin") and plan 4.16 / D3 / Q2. The owner
   chose it knowingly; the PRD and plan must be amended (see "PRD changes").
3. **Forgot-PIN email uses Resend (free tier).** The API key is NOT an env var
   of a tenant: it is a platform setting entered in the operator console, the
   same place the Tigris keys and the tenants are managed (post-phase-5
   architecture). The operator console is not built yet, so until it exists the
   key is set through an internal mutation / CLI script (see Part C).

## Database I/O rules for this work (see CLAUDE.md)

Convex free tier: reads and writes are tight. Every list is server-side
(index + cursor). Totals come from existing `orgStats` counters, in a **separate
small count query**, never inside the list query (a hot counter document would
re-run every open list on every write). No new index unless a visible sort or
search needs it. Register every new query in `convex/ioBudgets.ts`.

## Part A: server-driven lists

**List contract** (shared helper `convex/lib/listing.ts`):

- Args: `paginationOpts` (`numItems` 10, 25 or 50; max 50), optional
  `sort: { key, dir }` validated against a per-table allow-list, optional
  `search` (trimmed, max 100 chars, sent only on Enter), plus the table's own
  filters. The default sort is today's order.
- Large or growing tables: each allowed sort key maps to one index
  (`.withIndex(...).order(dir)`); search uses a `searchIndex` (devices,
  employees, apps) or a name-prefix range on an index (groups, others). No
  `.filter()`, no sorting after paging.
- Small bounded tables (groups, members, file types, install-status for one
  app/device read through `.take(n)`): the sort may run inside the query on the
  bounded read; this is still server-side and still bounded.
- `<table>:count`: total records for the unfiltered table (and the "No group"
  filter) from `orgStats`. Tables without a counter (audit, enrollment codes,
  installs) show no total: the pager shows Previous / Next and "Page N" only.
  A new counter is allowed only if it is exact, written on change, and cheap.
  The devices total must match the visible rows (revoked devices are listed
  but not in `deviceCount`).
- Short pages are allowed (filters after paging); `isDone` decides Next.

**Pager** (design from the owner's screenshot): left "147 records · Page 1 of
15"; centre `‹ 1 2 … 15 ›`; right "Rows per page" select (10, 25, 50). Convex
paginates by cursor only, so the client keeps a stack of cursors: pages already
visited and the next page are reachable; the last page is reachable only when a
total exists, by reading the list in the opposite order with `numItems = total
mod pageSize` (one cheap query). Changing sort, search, filter or page size
resets to page 1. Page size, sort and filters live in the URL query string.

**Generic table** (`components/DataTable.tsx`, one component for every list):

- Sortable column headers (buttons, `aria-sort`, Solar sort icon).
- The whole row is clickable (`onRowClick`); a real link stays in the name cell
  so keyboard users and ctrl/middle-click still work; buttons and links inside
  a row do not trigger the row click.
- Search box fires on **Enter** (and the clear button), not on every keystroke.
- Loading skeleton, empty state, error state, "no total" pager variant.
- Header corners follow the container radius (clip the card with
  `overflow: clip`, round the first and last header cells); sticky header fixed
  by giving the wrapper a proper scroll context or removing the wrapper scroll.
- **View switcher above every table:** Table | Cards. One global preference,
  stored in `localStorage` (`rulebox.view`), applied before first paint through
  `data-view` on `<html>` (same pattern as the theme in `src/boot/boot.js`).
  Default is the table on every screen width (phones scroll sideways); Cards
  shows the existing stacked-card layout at any width.
- Migrate every list: Devices, DeviceDetail, Audit, Apps, AppEdit, GroupDetail,
  FileTypes, Employees, Enrollment, Groups, MembersTab, and the custom
  `ul.dash-list` lists (Overview failed installs and attention, invites,
  employee picker, policy versions).

**Settings panel:** a gear icon beside the avatar in `dash-top` opens an
anchored panel (focus trap, Escape, outside click, bottom sheet on phones)
hosting the settings tabs; reuse the tab components, keep `/settings` working.

## Part B: sign-in with a required PIN (replaces TOTP)

- Every member (all roles) must set a PIN to finish sign-in. The setup screen
  warns "do not forget your PIN" and says how to reset it by email.
- Optional, skippable passkey step (fingerprint / face ID) after the PIN; the
  passkey prompt starts at once on the PIN screen when a passkey exists; if it
  is cancelled, the PIN field is shown. The PIN can never be removed.
- Every page load / reopen shows the PIN screen (per-tab lock, so another tab
  is not locked); the server still verifies the PIN (Argon2, rate limit).
- The 10-failure rule no longer disables the PIN (a password thief could lock
  the owner out): it becomes a 24 hour lockout plus an email notice.
- Remove TOTP everywhere: `/mfa`, `convex/mfa.ts`, `lib/totp.ts`, `mfa_*`
  codes, `memberSecrets` TOTP fields, `mfaSessions`, `members:resetMfa`,
  `resetMfaByEmail`, demo hooks and fixtures, tests. Data migration: widen,
  then narrow (as in Step 7). Recovery codes stay as a PIN fallback.
- Bootstrap (first PIN) needs a password sign-in younger than 15 minutes;
  invited members cannot finish joining without setting a PIN.

## Part C: forgot PIN by email

- "Forgot PIN?" on the lock screen sends a single-use, short-lived, hashed
  token by email (Resend). Same response whether or not the account exists;
  rate limited by email and by token hash.
- The link opens a page that requires the password sign-in too, then lets the
  member set a new PIN. All other sessions end, a "your PIN was reset" email
  goes out, and the event is audited. Never email alone (plan 4.16).
- Platform setting `resendApiKey` (and from-address): a server-only table, never
  returned to any client, encrypted with a master key from the deployment env,
  written only by the operator. Until the operator console exists: internal
  mutation + `scripts/` CLI. If no key is set the flow is off and the PIN
  screen says so (an Owner reset, passkey or recovery code still work).

## PRD changes needed (tell the owner when done)

PRD 12.3 and 16 (two-factor wording), plan 4.16 (never e-mail alone, TOTP
bootstrap), D3, Q2 and goal 1 in `phase-4-dashboard-state.md`, the deviations
table, post-phase-5 lines 669 and 926 (TOTP), PRD 11.1 (list rules: sort, search
and counts), and a new PRD note for the operator-owned Resend key.

## Work packages and order

| Wave | Package | Files | Model |
|---|---|---|---|
| 1 | WP1 backend list contract, counters, indexes | `convex/**` | opus |
| 1 | WP2 UI foundation: DataTable, Pager, ViewSwitch, boot.js, header fix, settings panel | `apps/dashboard/src/{components,app,styles,boot}` | sonnet |
| 2 | WP3 migrate every screen to the new table and lists | `apps/dashboard/src/{screens,data}` | sonnet x2 |
| 2 | WP5a auth backend: TOTP removal, PIN at sign-in, forgot-PIN, platform secret | `convex/**` (auth files) | opus |
| 3 | WP5b auth frontend and demo, SecurityTab, MembersTab bits | `apps/dashboard/src/{stepup,screens/settings,data}` | sonnet |
| 4 | Reviews (security for Parts B and C, code review for A), PRD and plan edits | read-only, then docs | opus / sonnet |

WP5a waits for WP1 (both edit `convex/schema.ts`); WP5b waits for WP3 (both
touch `MembersTab`). Each wave ends with typecheck, lint and the whole test
suite, then a commit per package.

## Status: WP1 backend list contract (2026-11-03, done, not committed)

Contract and helpers: `convex/lib/listing.ts` (`sortArg`, `pickSort` +
`LIST_SORTS` allow-lists, `checkPageSize` 1..50, `cleanSearch` trim/max 100,
`pageInMemory` offset cursors, `orgStatsRow`). All new args are optional;
arg-less / old calls keep today's order and shape. `numItems` 1..50 is
accepted everywhere so the last-page read (opposite `dir`, `total mod
pageSize`) works.

| Table | Query | Sort keys (first = default) | Search | Total |
|---|---|---|---|---|
| Devices | `fleet:list` | created (desc), name | `search_name` (sort ignored) | `fleet:count`: `deviceCount + revokedDeviceCount`; "No group": `noGroupDeviceCount + revokedNoGroupDeviceCount`; one group / search: null |
| Employees | `employees:list` | created (desc), name, username; with `groupId` only created (= added to group) | `search_text`, paginated, group filter drops non-members (short pages) | `employees:count`: `employeeCount`; filter / search: null |
| Apps | `apps:list` | created (desc), name | new `apps.search_name` (orgId, archived) | `apps:count`: `appCount` for `archived: false`; archived tab / search: null |
| Audit | `audit:list`, `audit:forTarget` | at (desc) | none | none |
| Enrollment codes | `enrollmentCodes:list` | created (desc), expires | none | none (`activeEnrollmentCodes` counts usable codes only) |
| Installs | `apps:installs`, `fleet:installs`, new `overview:failedInstallsPage` | updated (desc) | none | none (failed list: `overview:get` `failedInstallCount`) |
| Groups | new `groups:page` (bounded, <= 500) | name (asc), created | contains, name/description | exact `total` in the page |
| Members | new `members:page` (bounded, <= 200) | email (asc), role, status, created | contains, email | exact `total` in the page |
| Invites | new `members:invitesPage` (pending only, newest 100) | created (desc), email, expires | contains, email | exact `total` in the page |
| File types | new `fileHandlers:page` (bounded, <= 201) | extension (asc), app | contains, extension/program | exact `total` in the page |

New indexes: `devices.by_org_name`, `devices.by_org_group_name`,
`employees.by_org_name`, `apps.by_org_archived_name`, `apps.search_name`,
`enrollmentTokens.by_org_expires`. New counters: `orgStats.revokedDeviceCount`
and `revokedNoGroupDeviceCount` (revoke +1, `fleet:remove` -1, same mutation;
`stats:reconcile` and `maintenance:migratePlans` recount them).

Not possible cheaply (left out): devices by group name, status/online or
version (other tables; would need denormalized, hot fields); employees by
name inside a group (membership rows carry no name); any sort while a
full-text search is active (relevance order); totals for audit, codes,
installs, one group's devices or any search. `groups:list`, `members:list`,
`fileHandlers:list`, `employees:search`, `overview:failedInstalls` are
unchanged for today's dashboard; WP3 moves the tables to the new `*:page`
queries (the file-types picker becomes `apps:options`, subscribed while the
dialog is open) and they can be removed afterwards.
