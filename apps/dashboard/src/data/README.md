# Dashboard data seam

Screens import data hooks only from `src/data` (`index.ts`). Two implementations
satisfy the same `DataApi` type (`api.ts`):

- `demo/hooks.ts` — in-memory fixtures (`fixtures/seed.ts`), used when
  `VITE_DEMO=1` (`pnpm --filter @rulebox/dashboard dev:demo`, `build:demo`,
  `preview:demo`). Reactive like Convex, with simulated latency, connection
  loss (writes queue), failing queries and stale edits (top-bar demo controls).
- `live/hooks.ts` — the real backend. Session, sign-in, MFA, account and
  members are live (Step 4, against the Step 3 functions); settings, the plan
  and groups since Step 5; enrollment codes since Step 6 (their own seam,
  see below); every other hook answers `not_ready` with the
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
  `.withOptimisticUpdate(...)` (kiosk, archive, pins).
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
| `useDevicesScreen({ groupId, search })` | `api.fleet.list({ groupId })` (paginated); with `search`: `api.fleet.search({ text })` (`.take(50)`, set `searchCapped` when 50 came back) |
| `useLiveStatus(ids)` | `api.fleet.liveStatus({ deviceIds })` (≤ 100 ids) |
| `useDeviceDetail` | `api.fleet.get` |
| `useDeviceInstalls` | `api.fleet.installs` (paginated) |
| `useRenameDevice` / `useMoveDevice` / `useSetKiosk` / `useRevokeDevice` / `useRemoveDevice` / `useRequestRotation` | `api.fleet.rename` / `move` / `setKiosk` (optimistic) / `revoke` / `remove` / `requestCredentialRotation` |
| `useGroupsScreen` | `api.groups.list` (`{ count, more }` per count → one number capped at 501, "500+") | live |
| `useGroupDetail` | `api.groups.get` → `{ group, apps }` mapped to `GroupDetail` (assignment `_id` = app id until Step 10) | live |
| `useCreateGroup` / `useUpdateGroup` / `useDeleteGroup` | `api.groups.create` → id (`plan_limit` detail "groups", `conflict` field "name") / `rename` (`expectedRevision`; description undefined = unchanged, "" = cleared) → `{ revision }` / `remove` (major; `has_dependents` detail lists what to move first) | live |
| `useAssignApp` / `useUpdateAssignment` / `useUnassignApp` | `api.groups.assignApp` / `updateAssignment` (optimistic) / `unassignApp` |
| `useAddGroupEmployee` / `useRemoveGroupEmployee` | `api.groups` members section (Step 11) |
| `useEmployeesScreen({ groupId, search })` | `api.employees.list` (paginated) / `api.employees.search` |
| `useEmployeeDetail(id \| "new")` | `api.employees.get` ("new": only the pickers + `defaultQuotaGb`) |
| `useCreateEmployee` | `api.employees.create` |
| `useUpdateEmployee` | `api.employees.update`, then `setGroups`, then `setDirectApps` (each with `expectedRevision`) |
| `useSetEmployeePassword` / `useSetEmployeeDisabled` / `useUnlockEmployee` / `useDeleteEmployee` | `useAction(api.employees.setPassword)` / `setDisabled` / `unlock` / `remove` |
| `useAppsScreen({ archived })` | `api.apps.list` (paginated) |
| `useAppDetail(id \| "new")` | `api.apps.get` + `api.apps.installSummary` |
| `useAppInstalls(appId, state)` | `api.apps.installs` (paginated) |
| `useCreateWebApp` / `useCreateDesktopApp` / `useUpdateApp` | `api.apps.createWeb` / `createDesktop` / `update` |
| `useSetAppArchived` / `useDeleteApp` / `useRetryApp` | `api.apps.setArchived` (optimistic) / `remove` / `retry` |
| `useResolveWinget` / `useFetchWebMeta` | `useAction(api.apps.resolveWinget)` / `useAction(api.apps.fetchWebMeta)` |
| `useFileTypesScreen` / `useSetFileHandler` / `useRemoveFileHandler` | `api.fileHandlers.list` / `set` / `remove` |
| `useAuditScreen` / `useHistory(targetId)` | `api.audit.list` / `api.audit.forTarget` (paginated) |
| `useSettingsScreen` / `useUpdateSettings` | `api.settings.get` (`exitPin: { set, setAt }`) / `api.settings.update` → `{ revision, changed }` (fresh step-up when `adminExit` changes; `invalid_argument` field `adminExit.hotkey` with the grammar rule in `detail`) | live |
| `usePlan` | `api.settings.plan` (plan, status, limits, usage); Settings → Organization and the "New group" dialog | live |
| `useSetExitPin` / `useClearExitPin` | `useAction(api.settings.setExitPin)` (major; `invalid_argument` field `pin`, `detail` the rule) / `api.settings.clearExitPin` (major) | live |
| `useKeysScreen` | `api.keys.status` (+ `keys:trustProgress`) |
| `useRegisterKey` / `usePrepareRotation` / `useFinishRotation` | `api.keys.registerActive` / `prepareRotation` / `finishRotation` |
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
`EmployeeDetail.groupOptions/appOptions/defaultQuotaGb`,
`AppDetail.groupOptions`, `KeysScreen`, `DeviceRow` without `deviceStatus`.
(`MfaStatus` and `MembersScreen` now match Step 3's functions; `account:me`
also returns `memberships`, unused until v2.)
