# Dashboard data seam

Screens import data hooks only from `src/data` (`index.ts`). Two implementations
satisfy the same `DataApi` type (`api.ts`):

- `demo/hooks.ts` — in-memory fixtures (`fixtures/seed.ts`), used when
  `VITE_DEMO=1` (`pnpm --filter @rulebox/dashboard dev:demo`, `build:demo`,
  `preview:demo`). Reactive like Convex, with simulated latency, connection
  loss (writes queue), failing queries and stale edits (top-bar demo controls).
- `live/hooks.ts` — the real backend. Today every hook answers `not_ready`
  (the Phase 4 Convex functions do not exist yet); `useConnectionState` is
  already real.

All shapes live in `types.ts` and use the field names of plan Section 4.2.

## How to swap a hook

Replace the hook body in `live/hooks.ts`; screens do not change.

- **Query** (`QueryState<T>`): `const r = useQuery(api.x.y, args)` →
  `r === undefined ? { status: "loading" } : { status: "ready", data: r }`.
  Query errors throw during render and are caught by the per-region
  `RegionBoundary` (same "Try again" UI as `status: "error"`).
- **Paginated** (`PagedState<T>`): `usePaginatedQuery(api.x.y, args, { initialNumItems: 50 })`
  → `items = results`, `canLoadMore = status === "CanLoadMore" || status === "LoadingMore"`,
  `isLoadingMore = status === "LoadingMore"`, `loadMore = () => loadMore(50)`,
  `"LoadingFirstPage"` → `{ status: "loading" }`.
- **Mutation / action**: `useMutation(api.x.y)` / `useAction(api.x.y)`; wrap so a
  thrown `ConvexError` becomes `toAppError(e) ?? e` (see `lib/errors.ts`).
  Toggles add `.withOptimisticUpdate(...)` (kiosk, archive, pins).

## Hook → Convex function

| Hook | Convex |
|---|---|
| `useAuthState` | `useConvexAuth()` (inside `ConvexAuthProvider`) |
| `useMe` | `useQuery(api.account.me)` |
| `useAuthActions` | `useAuthActions()` from `@convex-dev/auth/react`: `signIn("password", { email, password, flow: "signIn" })`, sign-up with `flow: "signUp", inviteCode`, `signOut()` |
| `useRedeemReset` | `useAction(api.account.redeemReset)` |
| `useConnectionState` | `useConvex().connectionState()` (done) |
| `useMfaStatus` | `api.mfa.status` |
| `useBeginMfaSetup` / `useConfirmMfaSetup` | `useAction(api.mfa.beginSetup)` / `useAction(api.mfa.confirmSetup)` |
| `useVerifyMfa` / `useRedeemRecoveryCode` | `useMutation(api.mfa.verify)` / `useMutation(api.mfa.useRecoveryCode)` |
| `useOverview(nowMinute)` | `api.overview.get({ nowMs })` |
| `useDevicesScreen({ groupId, search })` | `api.fleet.list({ groupId })` (paginated); with `search`: `api.fleet.search({ text })` (`.take(50)`, set `searchCapped` when 50 came back) |
| `useLiveStatus(ids)` | `api.fleet.liveStatus({ deviceIds })` (≤ 100 ids) |
| `useDeviceDetail` | `api.fleet.get` |
| `useDeviceInstalls` | `api.fleet.installs` (paginated) |
| `useRenameDevice` / `useMoveDevice` / `useSetKiosk` / `useRevokeDevice` / `useRemoveDevice` / `useRequestRotation` | `api.fleet.rename` / `move` / `setKiosk` (optimistic) / `revoke` / `remove` / `requestCredentialRotation` |
| `useGroupsScreen` | `api.groups.list` |
| `useGroupDetail` | `api.groups.get` (also returns the app picker, `.take(500)`) |
| `useCreateGroup` / `useUpdateGroup` / `useDeleteGroup` | `api.groups.create` / `rename` (+ description) / `delete` |
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
| `useEnrollmentScreen(nowMinute)` | `api.enrollmentCodes.list({ nowMs })` (paginated) |
| `useCreateEnrollmentCode` / `useRevokeEnrollmentCode` | `useAction(api.enrollmentCodes.create)` / `revoke` |
| `useAuditScreen` / `useHistory(targetId)` | `api.audit.list` / `api.audit.forTarget` (paginated) |
| `useSettingsScreen` / `useUpdateSettings` | `api.settings.get` / `api.settings.update` |
| `useSetExitPin` / `useClearExitPin` | `useAction(api.settings.setExitPin)` / `api.settings.clearExitPin` |
| `useKeysScreen` | `api.keys.status` (+ `keys:trustProgress`) |
| `useRegisterKey` / `usePrepareRotation` / `useFinishRotation` | `api.keys.registerActive` / `prepareRotation` / `finishRotation` |
| `useMembersScreen` | `api.members.list` |
| `useInviteMember` / `useCreateResetCode` | `useAction(api.members.invite)` / `useAction(api.members.createResetCode)` |
| `useRevokeInvite` / `useChangeRole` / `useSetMemberDisabled` / `useResetMemberMfa` | `api.members.revokeInvite` / `changeRole` / `setDisabled` / `resetMfa` |

Shapes the plan does not pin down and the backend must match (or the types
change): `MfaStatus.lockedUntil/recoveryCodesLeft`, `GroupDetail.appOptions`
and `enrollmentCodeCount`, `EmployeeDetail.groupOptions/appOptions/defaultQuotaGb`,
`AppDetail.groupOptions`, `KeysScreen`, `MembersScreen`, `DeviceRow` without
`deviceStatus`.
