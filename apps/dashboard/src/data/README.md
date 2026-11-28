# Dashboard data seam

Screens import data hooks only from `src/data` (`index.ts`). Two implementations
satisfy the same `DataApi` type (`api.ts`):

- `demo/hooks.ts` — in-memory fixtures (`fixtures/seed.ts`), used when
  `VITE_DEMO=1` (`pnpm --filter @rulebox/dashboard dev:demo`, `build:demo`,
  `preview:demo`). Reactive like Convex, with simulated latency, connection
  loss (writes queue), failing queries and stale edits (top-bar demo controls).
- `live/hooks.ts` — the real backend. Session, sign-in, account and
  members are live (Step 4, against the Step 3 functions); settings, the plan
  and groups since Step 5; enrollment codes since Step 6, the device
  lists since Step 7, the app lists since Step 10 and the employee list since Step 11 (each in its own
  seam, see below); apps, assignments and file types since Step 10; employees and group members since
  Step 11; install status, the overview, the audit log and history since
  Step 17 (the audit lists in their own seam, `audit/`). Every hook is live; a
  hook whose Convex step has not landed answers `not_ready` with the detail
  `NOT_DEPLOYED` (`api.ts`), which a region shows as "Coming in a later step"
  (no hook uses that now). `live/convex.ts` holds the adapters
  (`useMemberQuery`, `useMapped`, `mapError`).

All shapes live in `types.ts` and use the field names of plan Section 4.2.

## How to swap a hook

Replace the hook body in `live/hooks.ts`; screens do not change.

- **Query** (`QueryState<T>`): `return useMemberQuery(api.x.y, args)`
  (`live/convex.ts`). It is skipped until Convex Auth confirms the session,
  uses `useQueries` so errors come back as `status: "error"` (mapped to
  `AppError`) instead of throwing during render, and `retry` re-subscribes.
  `unauthenticated` also fires `reportUnauthenticated()` (`lib/session.ts`):
  `useSessionGuard` sends the person to `/sign-in?next=…&expired=1`.
  `account:me` (public) stays a plain `useQuery`.
- **Paginated** (`ServerList<T>`, Phase 4b): `useServerPage(api.x.page, args, identity)` (`live/serverList.ts`): a plain query with `paginationOpts` that subscribes to ONE page, with the cursor stack in the screen (`useCursorPager`); never `usePaginatedQuery`, which accumulates pages. `useServerCount` reads the `<table>:count` total. Sorting, search and filters are arguments of the query. The hooks live in a seam of their own that only the lazy screen imports (`apps/`, `audit/`, `enrollment/`, `members/`, `devices/`, `employees/`).
- **Mutation / action**: `useMapped(useMutation(api.x.y))` /
  `useMapped(useAction(api.x.y))`: a thrown `ConvexError` with a known code
  becomes an `AppError` (`toAppError`, `lib/errors.ts`); anything else is
  passed on and shown only as the generic sentence. Toggles add
  `.withOptimisticUpdate(...)` (archive, pins; not the device kiosk switch).
- **Actions resolve before the queries update.** When the screen must wait
  for the result to show (for example `stepUp:verifyActionPin` → the unlock), wait
  for the query, not the promise (the controller does: `lib/stepup/controller.ts`).

## Hook → Convex function

Status: **live** = wired in `live/hooks.ts` (or in the hook's own seam).

| Hook | Convex | Status |
|---|---|---|
| `useAuthState` | `useConvexAuth()` from `convex/react` (inside `ConvexAuthProvider`, `shouldHandleCode={false}`) | live |
| `useMe` | `useQuery(api.account.me)` (public; `null` signed out, `{ noAccess }` without membership; compare `serverApiVersion` with `DASHBOARD_API_VERSION`) | live |
| `useAuthActions` | `useAuthActions()` from `@convex-dev/auth/react`: `signIn("password", { flow: "signIn", email, password })`, sign-up `signIn("password", { flow: "signUp", inviteCode, email, password })`, `signOut()`. A wrong email or password is a plain error without a code (shown as "Email or password is not right."); coded: `rate_limited`, `invite_invalid`, `invalid_argument {field:"password"}`, `account_disabled` | live |
| `useRedeemReset` | `useAction(api.account.redeemReset)` → `null` | live |
| `useConnectionState` | `useConvexConnectionState()` | live |
| `useOverview` | `api.overview.get` (no arguments: the `orgStats` counters, the sum of the `orgPresence` shards as `onlineCount`, the plan, the key state, `publishFailedAt` and the newest 10 audit rows; about 25 documents; re-runs on counter, presence and audit changes, never on a ping) | live |
| `useFailedInstallsPage({ enabled, ...query })` | `useServerPage(api.overview.failedInstallsPage, …)` (one page of failed results with PC and app names; sort key `updated` only; the total is `overview:get`'s `failedInstallCount`). Subscribed only while `enabled`, that is while `failedInstallCount` is above zero; disabled it answers an empty list without a subscription | live |
| `useDevicesScreen(query)` / `useDevicesCount(filter)` | `useServerPage(api.fleet.list, …)` / `useServerCount(api.fleet.count, …)` (one page per subscription; sort, search at most 100 characters and the group filter are arguments; `groupId` must be a real group id or the "no group" sentinel). `presence` (`{ online, since, revoked }`) is on every `DeviceRow`, so there is no separate live-status query. In `data/devices/` | live |
| `useDeviceDetail` | **Deprecated (UI pass 2026-11)**: `api.fleet.get` (`DeviceDetail` has `presence` too). The device page moves to `useDevicePage`; this stays until the screen is rebuilt, then goes with the query | live |
| `useDevicePage(id)` | `api.fleet.page({ deviceId })` → `DevicePage`: header, Overview and Protection data in one subscription (no group list, versions or rollout revision), plus the head's `latestVersion` / `planState`, the lockdown fields, `failedInstalls` (`count` of the newest 10 failed results that still count, `more`, `names` ≤ 2) and `network` (failed Wi-Fi / printer counts from the apply report). Mapped by `devicePageOf` (`live/devices.ts`). `not_found` for a foreign id | live |
| `useDeviceSettingsOptions(id)` / `useDeviceVersions(id, enabled)` / `useDeviceNetwork(id)` | `api.fleet.deviceSettings` (groups ≤ 500 sorted + the group's `rolloutRevision`) / `api.fleet.versions` (last 5, newest first; `enabled: false` subscribes to nothing) / `api.fleet.network` (the PC's group's Wi-Fi, printers and drivers with their state on this PC; never a passphrase, address, URL or hash). Each is subscribed only while its tab (or disclosure) is open. In `data/devices/` | live |
| `useDeviceLiveness(id)` | `api.fleet.liveness({ deviceId })` → `{ lastContactAt, online, fastUntil }`; the detail screen calls it next to `useDeviceDetail`, not inside the loaded page | live |
| `useWatchDevice` | `useMapped(useMutation(api.fleet.watch))` → `{ fastUntil }` (on open, then every 4 minutes while visible) | live |
| `useCheckNow` / `useCheckResult(checkId)` | `api.fleet.checkNow({ deviceIds })` (admin, first 50 shown, 1 per minute) → `{ checkId }` / `api.fleet.checkResult({ checkId })` (subscribed for 60 s) | live |
| `useDeviceInstalls` | `useServerPage(api.fleet.installs, { deviceId })` (in `data/devices/`) | live |
| `useRenameDevice` / `useMoveDevice` / `useSetKiosk` / `useRevokeDevice` / `useRemoveDevice` / `useRequestRotation` | `api.fleet.rename` / `move` / `setKiosk` / `revoke` / `remove` / `requestCredentialRotation`. `rename`, `move` and `setKiosk` take `expectedRevision` (`stale_edit` when the PC changed); `setKiosk` is not optimistic (turning it off is a major action with a fresh step-up) | live |
| `useLockDevice` / `useUnlockDevice` | `api.fleet.lock` / `unlock` (admin, major: fresh step-up retried by the hook; `lock` returns `{ lockId }`; the same text again writes nothing; `DeviceDetail.lock` is `{ lockId, message, contact?, lockedAt } \| null`) | live |
| `useBroadcastsPage(query)` / `useSendBroadcast` / `useCancelBroadcast` | `api.broadcasts.list` (viewer; one page, sort key `sent` only, no search or total; each row has `targetCount` and `ackCount`, the screen works out the status from `cancelledAt` and `expiresAt`) / `send` (admin; `too_large` detail `active` at 20 live messages) / `cancel` | live |
| `useRolloutView(groupId)` / `useRolloutHealth(groupId)` | `api.rollouts.groupView` (viewer; the rollout row or null, the versions newest first, the stage in flight, the first 100 PCs with their ring) / `api.rollouts.health` (viewer; applied / failed / partial / waiting of the stage, subscribed only while a stage is in flight because it moves with every apply report). Phase 5 Step 16 | live |
| `useSetRolloutEnabled` / `useSetAutoPromote` / `useSetRings` / `usePromoteRollout` / `usePromoteAll` / `useRollback` / `useResumeRollout` | `api.rollouts.setEnabled` (`conflict` detail `no_pilot_devices`) / `setAutoPromote` (bake 1-168 h, failure 1-100 %) / `setRings` (1-100 PCs, `changed`) / `promote` / `promoteAll` / `rollback` (admin, MAJOR: fresh step-up, retried by the hook) / `resume`; every one takes `expectedRevision` = the row's `revision` (`stale_edit`) and resolves to `{ revision }`. Conflict details: `rings_disabled`, `halted`, `nothing_to_promote`, `version_missing`, `not_halted` | live |
| `useGroupsScreen` | `api.groups.list` (`{ count, more }` per count → one number capped at 501, "500+") | live |
| `useGroupDetail` | `api.groups.get` → `{ group, apps }` mapped to `GroupDetail` (assignment `_id` = the `appAssignments` id) | live |
| `useSetGroupDisplay` / `useSetDeviceDisplayMode` | Phase 6 Step 19: `api.groups.setDisplay` (`expectedRevision`; `displayMode` auto/standard/lite, `webWindowCap` 1-12 or null, `webIdleCloseMin` 0 or 5-240 or null) / `api.fleet.setDisplayMode` (`expectedRevision`; the PC's own choice wins over its group's). Both → `{ revision }`; unchanged = no write; republish the group / PC | live |
| `useCreateGroup` / `useUpdateGroup` / `useDeleteGroup` | `api.groups.create` → id (`plan_limit` detail "groups", `conflict` field "name") / `rename` (`expectedRevision`; description undefined = unchanged, "" = cleared) → `{ revision }` / `remove` (major; `has_dependents` detail lists what to move first) | live |
| `useAssignApp` / `useUpdateAssignment` / `useUnassignApp` | `api.groups.assignApp` (`conflict` field `app`, `too_large` detail `group apps`, `invalid_argument` field `app` for an archived app) / `updateAssignment` (optimistic on `groups:get`; nothing changed = no write) / `unassignApp`; each republishes the group | live |
| `useAddGroupEmployee` / `useRemoveGroupEmployee` | `api.groups.addEmployee` / `removeEmployee` (already a member / not a member = no write; each appends one signed roster entry for the group, and republishes it only when the employee has direct apps; `too_large` detail `employee groups` / `group employees`) | live |
| `useEmployeesScreen(query)` / `useEmployeesCount(filter)` | `useServerPage(api.employees.list, …)` / `useServerCount(api.employees.count, …)` (one page per subscription, each row with its first 5 groups; sort, search and the group filter are arguments). `useEmployeePicker(text)` is `api.employees.search({ text })` (best 50, `capped`); blank text subscribes to nothing. In `data/employees/` | live |
| `useEmployeeDetail(id \| "new")` | `api.employees.get` (never a hash: `passwordSet` comes from `passwordSetAt`; the lockout row is shown only while `lockedUntil` is in the future) / `api.employees.options` for "new" (the pickers + `defaultQuotaGb`) | live |
| `useCreateEmployee` | `useAction(api.employees.create)` → id (an action: the optional first password is hashed on the server; `conflict` field `username`, `invalid_argument` field `name` / `username` / `quotaGb` / `password` with detail `length` or `username`, `plan_limit` detail `employees`, `not_ready` detail `signing key`, `rate_limited`) | live |
| `useUpdateEmployee` | `api.employees.save`: profile, groups and direct apps in one transaction with one revision check (all stored or none; a part that changes nothing writes nothing). Resolves to `{ revision }`, which the form sends next | live |
| `useSetEmployeePassword` / `useSetEmployeeDisabled` / `useUnlockEmployee` / `useDeleteEmployee` | `useAction(api.employees.setPassword)` (300 per hour per organization) / `setDisabled` / `unlock` / `remove` (major: fresh step-up; `invalid_argument` field `disabled` while the employee is active) | live |
| `useAppsScreen({ archived, ...query })` / `useAppsCount` | `apps:list` (ONE page: `paginationOpts` {numItems, cursor}, `sort` created / name, `search` = name index, relevance, `sort` ignored) / `apps:count` (a query of its own: total of the active tab; null for the archived tab or a search). In `data/apps/` | live |
| `useAppDetail(id \| "new")` | `api.apps.get` (`"new"` subscribes to nothing and answers a constant form). The install counts are not in it (`useAppInstallSummary`) | live |
| `useAppInstallSummary(appId)` | `api.apps.installSummary`: PCs per install state, each counted up to 1,001 ("1000+"), mapped to the states that have PCs. A query of its own: the counts change with every PC's report, so `apps:get` must not carry them; only the install card subscribes | live |
| `useAppOptions` | `api.apps.options` (non-archived apps, at most 500): the group page's assign dialog, subscribed only while it is open; also the website form's Chrome program picker (rows carry `browser: "chrome" \| "edge"`), subscribed only while "Opens in" is Chrome | live |
| `useAppInstalls(appId, state, query)` | `apps:installs` one page, sort `updated` only, no total. In `data/apps/` | live |
| `useCreateWebApp` / `useCreateDesktopApp` / `useUpdateApp` | `api.apps.createWeb` / `createDesktop` / `update` (`expectedRevision`; `invalid_argument` names the field, e.g. `url`, `exe`, `install.sha256`; `plan_limit` detail `apps`) | live |
| `useSetAppPermissions` | `api.apps.setPermissions` (admin, `expectedRevision`; the eight permissions of a website; resolves to `{ revision }`, the same one when nothing changed; `invalid_argument` field `appId` for a program). `useAppDetail` also carries `denials30d` (`[{ kind, count }]`, the last 30 days summed from `orgSecurityDaily`, websites only: counts only, never a page or an employee) | live |
| `useNetworks` / `useWifiDetail(id \| "new")` | `api.networks.list` (viewer; `{ wifi, printers, approvedDrivers }`, each Wi-Fi row with `hasPassphrase` / `passphraseSetAt` and the first 10 group names plus `groupCount`; never a passphrase, key or box; no apply counts, they would re-run the list on every report) / `api.networks.wifiDetail` (adds `groupIds` and the apply `counts`, computed on demand for the detail screen only; `"new"` subscribes to nothing). Phase 5 Steps 13 and 14 | live |
| `useSaveWifi` / `useDeleteWifi` | `api.networks.saveWifi` (admin; no `id` creates, `id` + `expectedRevision` updates; resolves to `{ id, revision }`; `too_large` detail `wifi` = 50 networks; `invalid_argument` field `name` / `ssid` / `groupIds` (detail `too_many` = more than 100 groups); the first 10 groups get their new configuration in the call, the rest a moment later) / `api.networks.deleteWifi` | live |
| `usePrinterDetail(id)` / `useSavePrinter` / `useDeletePrinter` | `api.networks.printerDetail` (viewer; the row plus `groupIds`, `defaultForGroupIds` and the apply `counts`, on demand, detail screen only; `"new"` subscribes to nothing) / `api.networks.savePrinter` (admin; no `id` creates, `id` + `expectedRevision` updates; resolves to `{ id, revision }`; `invalid_argument` field `name` (detail `taken`) / `address` / `port` / `queue` / `driver` (detail `not_approved`) / `defaultForGroupIds` (detail `taken`, `not_assigned`); `too_large` detail `printers` = 100 printers; `invalid_argument` field `groupIds` detail `too_many` = more than 100 groups) / `api.networks.deletePrinter` (admin). Phase 5 Step 14 | live |
| `useCreateWifiWithPassphrase` | `useAction(api.wifi.createWithPassphrase)` (admin; `{ name, ssid, hidden, security, autoConnect, groupIds, passphrase }` → `{ id, revision: 2 }`: a NEW secured network with its password, one call, one publish; `security` is never `open` (`invalid_argument` field `security` detail `open`: an open network is `useSaveWifi`); the same errors as `useSaveWifi` + `useSetWifiPassphrase`; a failure after the network was made removes it again; the live hook sends only these fields) | live |
| `useSetWifiPassphrase` | `useAction(api.wifi.setPassphrase)` (admin; `{ id, passphrase, expectedRevision }` → `{ revision }`; the ONLY place a passphrase travels: the dashboard keeps it in the dialog's form state until the call returns, never in a query, toast, error sentence, storage or URL; `invalid_argument` field `passphrase` detail `length` / `characters`, field `id` detail `open`; `not_ready` detail `sealing_key`) | live |
| `useSetAppArchived` / `useDeleteApp` / `useRetryApp` | `api.apps.setArchived` (optimistic on `apps:get`) / `remove` (major: fresh step-up; `has_dependents` detail `groups, file types`) / `retry` | live |
| `useResolveWinget` / `useFetchWebMeta` | `useAction(api.apps.resolveWinget)` (`winget_unsupported` detail = the reason, `winget_unreachable`) / `useAction(api.apps.fetchWebMeta)` → `{ name?, hue?, iconPreviewUrl? }` (`webmeta_failed`). The demo's `useResolveWinget` knows every package of the popular-apps gallery (`demo/wingetFixtures.ts`; Teams and Slack answer `winget_unsupported` like the server) | live |
| `useSaveAppIcon` | `useAction(api.apps.saveIcon)`: the `data:` URL `useFetchWebMeta` previewed, sent after the app is saved | live |
| `useInspectInstaller` | `useAction(api.apps.inspectInstaller)` (Phase 6 Step 13, "Detect"): at most three byte ranges of the installer; the refusal is `invalid_argument` with `detail` `inspect_blocked` / `inspect_unsupported` / `inspect_failed` / `inspect_not_installer` | live |
| `useFingerprintInstaller` | `useAction(api.apps.fingerprintInstaller)` (UI pass, "check the link"): the server downloads the installer once over https (public hosts, at most 512 MiB, never stored), hashes it with SHA-256 and detects its type → `{ sha256, sizeBytes, inspection }`; 10 an hour per organization; the refusal is `invalid_argument` field `url` with `detail` `fingerprint_too_large` / `fingerprint_blocked` / `fingerprint_failed` / `fingerprint_not_installer`. Demo twin (`demo/wingetFixtures.ts`): technology from words in the address, `big` in it = too large, a private host = blocked, a made-up but stable hash | live |
| `useAppByWinget(packageId \| "skip")` | `api.apps.byWinget` (viewer): the app (archived too) that already has that winget id, else `null`; 1 indexed row (`apps.by_org_winget`, `.take(1)`). The review page's duplicate notice; `"skip"` subscribes to nothing. Demo: searches the in-memory apps | live |
| `useFileTypesPage(query)` (`data/apps/`) / `useSetFileHandler` / `useRemoveFileHandler` | `api.fileHandlers.page` (bounded: offset cursors, exact `total` in the page, sort extension / app, contains-search) / `set` / `remove` (major). The add dialog's program picker is `useAppOptions` (`apps:options`), subscribed only while the dialog is open | live |
| `useAuditScreen(query)` / `useHistory(targetId, query)` | `audit:list` / `audit:forTarget` one page, sort `at` only, no search, no total. In `data/audit/` | live |
| `useSettingsScreen` / `useUpdateSettings` | `api.settings.get` (`exitPin: { set, setAt }`) / `api.settings.update` → `{ revision, changed }` (fresh step-up when `adminExit` changes; `invalid_argument` field `adminExit.hotkey` with the grammar rule in `detail`) | live |
| `usePlan` | `api.settings.plan` (plan, status, limits, usage); Settings → Organization and the "New group" dialog | live |
| `useSetExitPin` / `useClearExitPin` | `useAction(api.settings.setExitPin)` (major; `invalid_argument` field `pin`, `detail` the rule) / `api.settings.clearExitPin` (major) | live |
| `useKeysScreen` | `api.keys.status` (`signing` "ok" / "missing" / "mismatch", env key ids, `managed` "keyring" (the organization's own key, `orgKeys.signing`) / "deployment" (the key in the server environment) and `keyringLocked` (`orgKeys.locked`), `publishFailedAt`) + `keys:trustProgress` page after page (200 devices each, summed, only while a `next` key exists) | live |
| `useRegisterKey` / `usePrepareRotation` / `useFinishRotation` | `api.keys.registerActive` / `prepareRotation` / `finishRotation` (Owner, major: fresh step-up; `not_ready` when the env key is missing or not the prepared one, `conflict` detail `key_exists` / "an active key exists") | live |
| `usePublishAgain` | `api.keys.registerActive` without `force` (Owner, major): with the active key in the deployment it registers nothing and publishes every PC again; the failure signal is `publishFailedAt` (`overview:get` / `keys:status`, which also carry `rosterPending`). The global banner (`app/PublishBanner.tsx`) and the Signing tab use it through `lib/publish.ts`. `not_ready` = no key on the deployment, `conflict` = another key | live |
| `useMembersPage(query)` / `useInvitesPage(nowMinute, query)` | `members:page` / `members:invitesPage` (bounded: offset cursors, exact `total` in the page; members sort email / role / status / created, invites created / email / expires; contains-search on the email). In `data/members/` | live |
| `useInviteMember` / `useCreateResetCode` | `useAction(api.members.invite)` / `useAction(api.members.createResetCode)` → `{ code, expiresAt }` (code shown once, kept in component state only) | live |
| `useRevokeInvite` | `useMutation(api.members.revokeInvite)` | live |
| `useChangeRole` / `useSetMemberDisabled` | `useMutation(api.members.changeRole)` / `useMutation(api.members.setDisabled)`, both with `expectedRevision` (`stale_edit` when the member changed) | live |

## Rulebox release hooks (`data/release/`, Phase 6 Step 20)

The seam of the Settings → Updates tab (`ReleaseApi` in `release/api.ts`, `release/live.ts`, `release/demo.ts`, picked by the
`@rulebox/release-impl` alias; only the lazy `screens/settings/UpdatesTab.tsx` imports it).

| Hook | Convex | Status |
|---|---|---|
| `useRelease` | `api.ruleboxRelease.get` (viewer): `{ revision, release: { version, url, sha256, sizeBytes } \| null }`, one read of the organization row | live |
| `useSetRelease` | `api.ruleboxRelease.set` (Owner, major: fresh step-up): `{ expectedRevision, release \| null }` → `{ revision }`; `stale_edit`; `invalid_argument` field `release.version` / `release.url` / `release.sha256` / `release.sizeBytes`; `null` clears | live |
| `useGithubReleases(enabled)` | `useAction(api.ruleboxRelease.githubReleases)` (Owner, unlocked session, not major; the browser never calls GitHub): `{ refresh? }` → `{ status: "ok", repoUrl, checkedAt, stale, releases[≤10] }` or `{ status: "unavailable", reason: "rate_limited" \| "unreachable" \| "not_found", retryAt? }`; each release has `msi { name, url, sizeBytes, sha256 }` or a `problem`. Returns `{ state: idle \| loading \| ready \| error, refreshing, canRefresh, refresh() }` (`release/githubRunner.ts`, shared by live and demo): one call when `enabled` (pass `useCan("owner")`), never polls, last `ok` answer kept 5 min in memory, Refresh locked 30 s, late answers dropped. The server caches in memory (10 min, ETag, 30 s gap): 0 database reads beyond the member check, nothing stored. Demo: a fake list after 500 ms, `?demoReleases=empty\|unavailable\|rate\|stale` for the other states | live |

## Enrollment-code hooks (`data/enrollment/`, plan Step 6)

Same pattern as the step-up seam below (`EnrollmentApi` in `enrollment/api.ts`,
`enrollment/live.ts`, demo hooks in `demo/hooks.ts` re-exported by
`enrollment/demo.ts`, picked by the `@rulebox/enrollment-impl` alias). Only
`screens/Enrollment.tsx` imports it, so the paging code never reaches
sign-in.

| Hook | Convex | Status |
|---|---|---|
| `useEnrollmentScreen(nowMinute, query)` | `useServerPage(api.enrollmentCodes.list, { nowMs, … })` (one page per subscription; `nowMs` = the minute) | live |
| `useCreateEnrollmentCode` | `useAction(api.enrollmentCodes.create)` → `{ code, expiresAt, tokenId }` (code shown once, kept in component state only; `tokenId` is the row id, not secret: what `useEnrollmentProgress` and `?watch=` carry; `plan_limit` detail `enrollmentCodes` / `suspended`, `invalid_argument` field `uses` / `ttlMinutes` / `label`, `not_found` group, `not_ready` URL) | live |
| `useRevokeEnrollmentCode` | `useMutation(api.enrollmentCodes.revoke)` (major: fresh step-up) | live |
| `useEnrollmentProgress(tokenId \| null)` | `useMemberQuery(api.enrollmentCodes.progress, tokenId ? { tokenId } : "skip")` (viewer; the "Add a PC" wizard's live view of ONE code: counts, group name, the newest <= 10 PCs that joined with presence and kiosk phase, the organization's release as `download`; <= 36 reads; no clock argument, so the screen derives expired / used up with `progressState(p, now)`; **subscribe only while step 2 or 3 is on screen, pass `null` everywhere else**; an id of another organization or a deleted code is `not_found`). Demo: one simulated PC per created code joins 6 s later (`demo/enrollmentSim.ts`) | live |

## Device-list hooks (`data/devices/`, plan Step 7)

The same pattern a third time: `DevicesApi` in `devices/api.ts`, `devices/live.ts`,
demo hooks in `demo/hooks.ts` re-exported by `devices/demo.ts`, picked by the
`@rulebox/devices-impl` alias (`vite.config.ts` and the `paths` entry in
`tsconfig.json`). It holds the paginated hooks, `useDevicesScreen`
and `useDeviceInstalls` (and the count), so it is imported only by the lazy Devices, Device
detail and Group detail screens and stays out of the `core` chunk. Every other device hook
(`useDeviceDetail`, `useDeviceLiveness`, `useWatchDevice`, `useCheckNow`,
`useCheckResult`, the writes) is in `DataApi` / `live/hooks.ts`.

## App-list hooks (`data/apps/`, plan Step 10)

The same pattern a fourth time: `AppsApi` in `apps/api.ts`, `apps/live.ts`, demo hooks in
`demo/hooks.ts` re-exported by `apps/demo.ts`, picked by the `@rulebox/apps-impl` alias
(`vite.config.ts` and the `paths` entry in `tsconfig.json`; `vite.config.ts` keeps the folder out of
the `core` chunk). It holds `useAppsScreen` and `useAppInstalls`, imported only by the lazy Apps and
App screens.

## Audit-list hooks (`data/audit/`, plan Step 17)

The same pattern a sixth time: `AuditApi` in `audit/api.ts`, `audit/live.ts`, the demo hooks in `demo/hooks.ts`
re-exported by `audit/demo.ts`, picked by the `@rulebox/audit-impl` alias (`vite.config.ts` and the `paths` entry in
`tsconfig.json`; `vite.config.ts` keeps the folder out of the `core` chunk). It holds `useAuditScreen` and
`useHistory`, imported only by the lazy Audit screen and by `HistoryPanel` (the device, employee, app and group pages).

## Employee-list hook (`data/employees/`, plan Step 11)

The same pattern a fifth time: `EmployeesApi` in `employees/api.ts`, `employees/live.ts`, the demo hook in
`demo/hooks.ts` re-exported by `employees/demo.ts`, picked by the `@rulebox/employees-impl` alias
(`vite.config.ts` and the `paths` entry in `tsconfig.json`; `vite.config.ts` keeps the folder out of the
`core` chunk). It holds `useEmployeesScreen` only, imported by the lazy Employees and Group detail screens.
Two server queries sit behind it (`employees:list`, `employees:search`); only one is subscribed at a time.
Everything else about employees is in `DataApi` / `live/hooks.ts` (`live/employees.ts` maps `employees:get`).

## Step-up hooks (`data/stepup/`, plan 4.16)

A second, smaller seam with the same rules (`StepUpApi` in `stepup/api.ts`,
`stepup/live.ts` and `stepup/demo.ts`, picked by the `@rulebox/stepup-impl`
alias). It is kept out of `DataApi` and out of the `core` chunk so the sign-in
page never downloads it: only the signed-in shell (`stepup/StepUpProvider.tsx`),
Settings → Security and the `/pin-reset` page import `data/stepup`.

Writes that may need a confirmation go through `withStepUp`
(`src/lib/stepUpRetry.ts`), which the seam applies itself (`useMapped` /
`runMutation` in `live/convex.ts`, `runMutation` in `demo/store.ts`): on
`step_up_required` / `step_up_setup_required` the confirm dialog opens and the
call is retried once; cancelled, the original error is thrown. Every member
write needs an unlocked session on the server, so build each new mutation hook
on those helpers and a screen needs nothing extra.
The demo store applies the same rule (`runMutation(role, fn, "unlocked" |
"fresh" | "none")`); the demo Owner's PIN is `482915` (recovery code `7KQ2-M9XD`), the
other demo members have none and set one after signing in. The demo "email" for Forgot PIN
is the fixed link `/pin-reset#token=demo-pin-reset-token`.

| Hook | Convex | Status |
|---|---|---|
| `useStepUpStatus` | `api.stepUp.status` (any role; server timestamps, never a hash or credential id) | live |
| `useVerifyActionPin` | `useAction(api.stepUp.verifyActionPin)` → `{ verifiedAt, freshUntil, serverNow }` | live |
| `useSetActionPin` | `useAction(api.stepUp.setActionPin)` (the first PIN right after a password sign-in, or a change after a fresh step-up) | live |
| `useGenerateRecoveryCodes` | `useAction(api.stepUp.generateRecoveryCodes)` → 10 codes, once (major; the bootstrap counts as fresh) | live |
| `useBeginPasskeyVerification` / `useFinishPasskeyVerification` | `useAction(api.passkeys.beginVerification)` → `{ optionsJson, expiresAt }` / `finishVerification({ responseJson })`; the ceremony runs in `lib/stepup/passkey.ts` (`@simplewebauthn/browser`, loaded on first use) | live |
| `useBeginPasskeyRegistration` / `useFinishPasskeyRegistration` | `useAction(api.passkeys.beginRegistration)` / `finishRegistration({ responseJson, name })` | live |
| `useRenamePasskey` / `useRemovePasskey` | `useMutation(api.stepUp.renamePasskey)` / `removePasskey` (major) | live |
| `useKeepAlive` / `useLockSession` | `useMutation(api.stepUp.keepAlive)` (at most every `policy.keepAliveMs`, only on input) / `api.stepUp.lock` | live |
| `useResetMemberStepUp` | `useMutation(api.stepUp.resetMember)` (Owner, major) | live |
| `useResetStepUpWithRecoveryCode` | `useAction(api.stepUp.resetWithRecoveryCode)` with `{ code, newPin }` (password sign-in under 15 minutes old) | live |
| `useRequestPinReset` | `useAction(api.account.requestPinReset)`: no arguments, session-bound, always `{ ok }` | live |
| `useRedeemPinReset` | `useAction(api.account.redeemPinReset)` with `{ token, newPin }` (the `/pin-reset#token=` token; every token problem is `step_up_invalid`) | live |
| `useChangePassword` | `useAction(api.account.changePassword)` with `{ currentPassword, newPassword }` (major: fresh step-up) | live |

Shapes the plan does not pin down and the backend must match (or the types
change):
`AppDetail.groupOptions`, `DeviceRow` without `deviceStatus`.
(`EmployeeDetail.groupOptions/appOptions/defaultQuotaGb` now match `employees:get`.)
(`account:me` also returns `memberships`, unused until v2.)
