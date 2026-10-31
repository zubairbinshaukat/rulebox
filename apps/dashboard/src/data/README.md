# Dashboard data seam

Screens import data hooks only from `src/data` (`index.ts`). Two implementations
satisfy the same `DataApi` type (`api.ts`):

- `demo/hooks.ts` — in-memory fixtures (`fixtures/seed.ts`), used when
  `VITE_DEMO=1` (`pnpm --filter @rulebox/dashboard dev:demo`, `build:demo`,
  `preview:demo`). Reactive like Convex, with simulated latency, connection
  loss (writes queue), failing queries and stale edits (top-bar demo controls).
- `live/hooks.ts` — the real backend. Session, sign-in, MFA, account and
  members are live (Step 4, against the Step 3 functions); settings, the plan
  and groups since Step 5; enrollment codes since Step 6, the device
  lists since Step 7, the app lists since Step 10 and the employee list since Step 11 (each in its own
  seam, see below); apps, assignments and file types since Step 10; employees and group members since
  Step 11; every other hook answers `not_ready` with the
  detail `NOT_DEPLOYED` (`api.ts`), which a region shows as "Coming in a
  later step", until its Convex step lands. `live/convex.ts` holds the
  adapters (`useMemberQuery`, `useMapped`, `mapError`).

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
- **Paginated** (`PagedState<T>`): `usePagedState(usePaginatedQuery(api.x.y, isAuthenticated ? args : "skip", { initialNumItems: 50 }), 50)`
  (`live/convex.ts`) → `items = results`, `canLoadMore = status === "CanLoadMore" || status === "LoadingMore"`,
  `isLoadingMore = status === "LoadingMore"`, `loadMore = () => loadMore(50)`,
  `"LoadingFirstPage"` → `{ status: "loading" }` (or the previous rows while new
  arguments load). Two rules: `usePaginatedQuery` **throws** query errors during
  render, so the screen renders the list inside a `RegionBoundary`; and it is
  ~1 KB gzip that must stay out of the first load: put the hooks in a seam of
  their own that only the lazy screen imports (as `enrollment/`), never in
  `live/hooks.ts` (`vite.config.ts` keeps `use_paginated_query` out of
  `vendor-convex`). A changed argument restarts at page 1, so a screen whose
  argument moves (Enrollment's `nowMs` minute) stops moving it once more
  pages are loaded.
- **Mutation / action**: `useMapped(useMutation(api.x.y))` /
  `useMapped(useAction(api.x.y))`: a thrown `ConvexError` with a known code
  becomes an `AppError` (`toAppError`, `lib/errors.ts`); anything else is
  passed on and shown only as the generic sentence. Toggles add
  `.withOptimisticUpdate(...)` (archive, pins; not the device kiosk switch).
- **Actions resolve before the queries update.** When the screen must wait
  for the result to show (for example `mfa:verify` → `verified`), wait for the
  query, not the promise (see `screens/Mfa.tsx`).

## Hook → Convex function

Status: **live** = wired in `live/hooks.ts`; everything else answers
`not_ready` in live builds until its step lands.

| Hook | Convex | Status |
|---|---|---|
| `useAuthState` | `useConvexAuth()` from `convex/react` (inside `ConvexAuthProvider`, `shouldHandleCode={false}`) | live |
| `useMe` | `useQuery(api.account.me)` (public; `null` signed out, `{ noAccess }` without membership; compare `serverApiVersion` with `DASHBOARD_API_VERSION`) | live |
| `useAuthActions` | `useAuthActions()` from `@convex-dev/auth/react`: `signIn("password", { flow: "signIn", email, password })`, sign-up `signIn("password", { flow: "signUp", inviteCode, email, password })`, `signOut()`. A wrong email or password is a plain error without a code (shown as "Email or password is not right."); coded: `rate_limited`, `invite_invalid`, `invalid_argument {field:"password"}`, `account_disabled` | live |
| `useRedeemReset` | `useAction(api.account.redeemReset)` → `null` | live |
| `useConnectionState` | `useConvexConnectionState()` | live |
| `useMfaStatus` | `api.mfa.status` (query) | live |
| `useBeginMfaSetup` / `useConfirmMfaSetup` | `useAction(api.mfa.beginSetup)` → `{ secret, uri }` / `useAction(api.mfa.confirmSetup)` → `string[]` (recovery codes, once) | live |
| `useVerifyMfa` / `useRedeemRecoveryCode` | `useAction(api.mfa.verify)` / `useAction(api.mfa.useRecoveryCode)` (**actions**, so the lockout counter commits) | live |
| `useOverview(nowMinute)` | `api.overview.get({ nowMs })` |
| `useDevicesScreen({ groupId, search })` | `usePaginatedQuery(api.fleet.list, { groupId?, search? })` (50 per page; search is an argument of the same query, at most 100 characters; `groupId` must be a real group id, there is no "no group" filter). `presence` (`{ online, since, revoked }`) is on every `DeviceRow`, so there is no separate live-status query. In `data/devices/` | live |
| `useDeviceDetail` | `api.fleet.get` (`DeviceDetail` has `presence` too) | live |
| `useDeviceLiveness(id)` | `api.fleet.liveness({ deviceId })` → `{ lastContactAt, online, fastUntil }`; the detail screen calls it next to `useDeviceDetail`, not inside the loaded page | live |
| `useWatchDevice` | `useMapped(useMutation(api.fleet.watch))` → `{ fastUntil }` (on open, then every 4 minutes while visible) | live |
| `useCheckNow` / `useCheckResult(checkId)` | `api.fleet.checkNow({ deviceIds })` (admin, first 50 shown, 1 per minute) → `{ checkId }` / `api.fleet.checkResult({ checkId })` (subscribed for 60 s) | live |
| `useDeviceInstalls` | `usePaginatedQuery(api.fleet.installs, { deviceId })` (in `data/devices/`) | live |
| `useRenameDevice` / `useMoveDevice` / `useSetKiosk` / `useRevokeDevice` / `useRemoveDevice` / `useRequestRotation` | `api.fleet.rename` / `move` / `setKiosk` / `revoke` / `remove` / `requestCredentialRotation`. `rename`, `move` and `setKiosk` take `expectedRevision` (`stale_edit` when the PC changed); `setKiosk` is not optimistic (turning it off is a major action with a fresh step-up) | live |
| `useGroupsScreen` | `api.groups.list` (`{ count, more }` per count → one number capped at 501, "500+") | live |
| `useGroupDetail` | `api.groups.get` → `{ group, apps }` mapped to `GroupDetail` (assignment `_id` = the `appAssignments` id) | live |
| `useCreateGroup` / `useUpdateGroup` / `useDeleteGroup` | `api.groups.create` → id (`plan_limit` detail "groups", `conflict` field "name") / `rename` (`expectedRevision`; description undefined = unchanged, "" = cleared) → `{ revision }` / `remove` (major; `has_dependents` detail lists what to move first) | live |
| `useAssignApp` / `useUpdateAssignment` / `useUnassignApp` | `api.groups.assignApp` (`conflict` field `app`, `too_large` detail `group apps`, `invalid_argument` field `app` for an archived app) / `updateAssignment` (optimistic on `groups:get`; nothing changed = no write) / `unassignApp`; each republishes the group | live |
| `useAddGroupEmployee` / `useRemoveGroupEmployee` | `api.groups.addEmployee` / `removeEmployee` (already a member / not a member = no write; each appends one signed roster entry for the group, and republishes it only when the employee has direct apps; `too_large` detail `employee groups` / `group employees`) | live |
| `useEmployeesScreen({ groupId, search })` | `usePaginatedQuery(api.employees.list, { groupId? })` (50 per page, newest first, each row with its first 5 groups) while the search box is empty, `api.employees.search({ text, groupId? })` (best 50, `searchCapped`) while it has text; text that is blank after trimming subscribes to nothing. In `data/employees/` | live |
| `useEmployeeDetail(id \| "new")` | `api.employees.get` (never a hash: `passwordSet` comes from `passwordSetAt`; the lockout row is shown only while `lockedUntil` is in the future) / `api.employees.options` for "new" (the pickers + `defaultQuotaGb`) | live |
| `useCreateEmployee` | `useAction(api.employees.create)` → id (an action: the optional first password is hashed on the server; `conflict` field `username`, `invalid_argument` field `name` / `username` / `quotaGb` / `password` with detail `length` or `username`, `plan_limit` detail `employees`, `not_ready` detail `signing key`, `rate_limited`) | live |
| `useUpdateEmployee` | `api.employees.save`: profile, groups and direct apps in one transaction with one revision check (all stored or none; a part that changes nothing writes nothing). Resolves to `{ revision }`, which the form sends next | live |
| `useSetEmployeePassword` / `useSetEmployeeDisabled` / `useUnlockEmployee` / `useDeleteEmployee` | `useAction(api.employees.setPassword)` (300 per hour per organization) / `setDisabled` / `unlock` / `remove` (major: fresh step-up; `invalid_argument` field `disabled` while the employee is active) | live |
| `useAppsScreen({ archived })` | `usePaginatedQuery(api.apps.list, { archived })` (50 per page, newest first; per row a group count capped at 101 and the icon address, never install results). In `data/apps/` | live |
| `useAppDetail(id \| "new")` | `api.apps.get` (`"new"` subscribes to nothing and answers a constant form). `installCounts` is `{}` until Step 17 (`apps:installSummary`) | live |
| `useAppOptions` | `api.apps.options` (non-archived apps, at most 500): the group page's assign dialog, subscribed only while it is open | live |
| `useAppInstalls(appId, state)` | `api.apps.installs` (paginated, Step 17). In `data/apps/` | `not_ready` |
| `useCreateWebApp` / `useCreateDesktopApp` / `useUpdateApp` | `api.apps.createWeb` / `createDesktop` / `update` (`expectedRevision`; `invalid_argument` names the field, e.g. `url`, `exe`, `install.sha256`; `plan_limit` detail `apps`) | live |
| `useSetAppArchived` / `useDeleteApp` / `useRetryApp` | `api.apps.setArchived` (optimistic on `apps:get`) / `remove` (major: fresh step-up; `has_dependents` detail `groups, file types`) / `retry` | live |
| `useResolveWinget` / `useFetchWebMeta` | `useAction(api.apps.resolveWinget)` (`winget_unsupported` detail = the reason, `winget_unreachable`) / `useAction(api.apps.fetchWebMeta)` → `{ name?, hue?, iconPreviewUrl? }` (`webmeta_failed`) | live |
| `useSaveAppIcon` | `useAction(api.apps.saveIcon)`: the `data:` URL `useFetchWebMeta` previewed, sent after the app is saved | live |
| `useFileTypesScreen` / `useSetFileHandler` / `useRemoveFileHandler` | `api.fileHandlers.list` / `set` (`invalid_argument` field `extension` detail `format` or `denied`; field `app`) / `remove` (major) | live || `useAuditScreen` / `useHistory(targetId)` | `api.audit.list` / `api.audit.forTarget` (paginated) |
| `useSettingsScreen` / `useUpdateSettings` | `api.settings.get` (`exitPin: { set, setAt }`) / `api.settings.update` → `{ revision, changed }` (fresh step-up when `adminExit` changes; `invalid_argument` field `adminExit.hotkey` with the grammar rule in `detail`) | live |
| `usePlan` | `api.settings.plan` (plan, status, limits, usage); Settings → Organization and the "New group" dialog | live |
| `useSetExitPin` / `useClearExitPin` | `useAction(api.settings.setExitPin)` (major; `invalid_argument` field `pin`, `detail` the rule) / `api.settings.clearExitPin` (major) | live |
| `useKeysScreen` | `api.keys.status` (`signing` "ok" / "missing" / "mismatch", env key ids, `publishFailedAt`) + `keys:trustProgress` page after page (200 devices each, summed, only while a `next` key exists) | live |
| `useRegisterKey` / `usePrepareRotation` / `useFinishRotation` | `api.keys.registerActive` / `prepareRotation` / `finishRotation` (Owner, major: fresh step-up; `not_ready` when the env key is missing or not the prepared one, `conflict` detail `key_exists` / "an active key exists") | live |
| `useMembersScreen` | `api.members.list` → `{ members, invites }` (invites in every state, newest 100; the screen shows only unused, unexpired ones) | live |
| `useInviteMember` / `useCreateResetCode` | `useAction(api.members.invite)` / `useAction(api.members.createResetCode)` → `{ code, expiresAt }` (code shown once, kept in component state only) | live |
| `useRevokeInvite` / `useResetMemberMfa` | `useMutation(api.members.revokeInvite)` / `useMutation(api.members.resetMfa)` | live |
| `useChangeRole` / `useSetMemberDisabled` | `useMutation(api.members.changeRole)` / `useMutation(api.members.setDisabled)`, both with `expectedRevision` (`stale_edit` when the member changed) | live |

## Enrollment-code hooks (`data/enrollment/`, plan Step 6)

Same pattern as the step-up seam below (`EnrollmentApi` in `enrollment/api.ts`,
`enrollment/live.ts`, demo hooks in `demo/hooks.ts` re-exported by
`enrollment/demo.ts`, picked by the `@rulebox/enrollment-impl` alias). Only
`screens/Enrollment.tsx` imports it, so `usePaginatedQuery` never reaches
sign-in.

| Hook | Convex | Status |
|---|---|---|
| `useEnrollmentScreen(nowMinute)` | `usePaginatedQuery(api.enrollmentCodes.list, { nowMs })` (50 per page; `nowMs` = the minute) | live |
| `useCreateEnrollmentCode` | `useAction(api.enrollmentCodes.create)` → `{ code, expiresAt }` (code shown once, kept in component state only; `plan_limit` detail `enrollmentCodes` / `suspended`, `invalid_argument` field `uses` / `ttlMinutes` / `label`, `not_found` group, `not_ready` URL) | live |
| `useRevokeEnrollmentCode` | `useMutation(api.enrollmentCodes.revoke)` (major: fresh step-up) | live |

## Device-list hooks (`data/devices/`, plan Step 7)

The same pattern a third time: `DevicesApi` in `devices/api.ts`, `devices/live.ts`,
demo hooks in `demo/hooks.ts` re-exported by `devices/demo.ts`, picked by the
`@rulebox/devices-impl` alias (`vite.config.ts` and the `paths` entry in
`tsconfig.json`). It holds the two `usePaginatedQuery` hooks, `useDevicesScreen`
and `useDeviceInstalls`, so it is imported only by the lazy Devices, Device
detail and Group detail screens and stays out of the `core` chunk. Every other device hook
(`useDeviceDetail`, `useDeviceLiveness`, `useWatchDevice`, `useCheckNow`,
`useCheckResult`, the writes) is in `DataApi` / `live/hooks.ts`.

## App-list hooks (`data/apps/`, plan Step 10)

The same pattern a fourth time: `AppsApi` in `apps/api.ts`, `apps/live.ts`, demo hooks in
`demo/hooks.ts` re-exported by `apps/demo.ts`, picked by the `@rulebox/apps-impl` alias
(`vite.config.ts` and the `paths` entry in `tsconfig.json`; `vite.config.ts` keeps the folder out of
the `core` chunk). It holds `useAppsScreen` and `useAppInstalls`, imported only by the lazy Apps and
App screens.

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
page never downloads it: only the signed-in shell (`stepup/StepUpProvider.tsx`)
and Settings → Security import `data/stepup`.

Writes that may need a confirmation go through `useStepUpAction(hook())`
(`src/stepup/context.ts`): on `step_up_required` / `step_up_setup_required`
the confirm dialog opens and the call is retried once; cancelled, the original
error is thrown. Every member write needs an unlocked session on the server,
so wrap each new mutation hook a screen uses this way (Members tab: all six).
The demo store applies the same rule (`runMutation(role, fn, "unlocked" |
"fresh" | "none")`); the demo Owner's action PIN is `482915`.

| Hook | Convex | Status |
|---|---|---|
| `useStepUpStatus` | `api.stepUp.status` (any role; server timestamps, never a hash or credential id) | live |
| `useVerifyActionPin` | `useAction(api.stepUp.verifyActionPin)` → `{ verifiedAt, freshUntil, serverNow }` | live |
| `useSetActionPin` / `useClearActionPin` | `useAction(api.stepUp.setActionPin)` (bootstrap or fresh) / `useMutation(api.stepUp.clearActionPin)` (major) | live |
| `useBeginPasskeyVerification` / `useFinishPasskeyVerification` | `useAction(api.passkeys.beginVerification)` → `{ optionsJson, expiresAt }` / `finishVerification({ responseJson })`; the ceremony runs in `lib/stepup/passkey.ts` (`@simplewebauthn/browser`, loaded on first use) | live |
| `useBeginPasskeyRegistration` / `useFinishPasskeyRegistration` | `useAction(api.passkeys.beginRegistration)` / `finishRegistration({ responseJson, name })` | live |
| `useRenamePasskey` / `useRemovePasskey` | `useMutation(api.stepUp.renamePasskey)` / `removePasskey` (major) | live |
| `useKeepAlive` / `useLockSession` | `useMutation(api.stepUp.keepAlive)` (at most every `policy.keepAliveMs`, only on input) / `api.stepUp.lock` | live |
| `useResetMemberStepUp` | `useMutation(api.stepUp.resetMember)` (Owner, major) | live |
| `useResetStepUpWithRecoveryCode` | `useAction(api.stepUp.resetWithRecoveryCode)` | live |

Shapes the plan does not pin down and the backend must match (or the types
change):
`AppDetail.groupOptions`, `DeviceRow` without `deviceStatus`.
(`EmployeeDetail.groupOptions/appOptions/defaultQuotaGb` now match `employees:get`.)
(`MfaStatus` and `MembersScreen` now match Step 3's functions; `account:me`
also returns `memberships`, unused until v2.)
