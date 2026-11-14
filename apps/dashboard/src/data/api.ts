/**
 * The data seam: every hook a screen may call. Both implementations
 * (`demo/hooks.ts` and `live/hooks.ts`) must satisfy this type, so swapping
 * one hook body for Convex is a local change (see README.md).
 */
import type {
  AppDetail,
  AppOption,
  Audience,
  CheckResult,
  DesktopAppInput,
  DeviceDetail,
  DeviceLiveness,
  EmployeeDetail,
  EmployeeInput,
  FailedInstallRow,
  GroupDetail,
  GroupRow,
  Id,
  InstallCounts,
  KeysScreen,
  MeResult,
  NetworksScreen,
  OrgSettings,
  OverviewScreen,
  PlanScreen,
  PrinterDetail,
  PrinterInput,
  QueryState,
  Role,
  SettingsSaved,
  SettingsScreen,
  WebAppInput,
  WebMeta,
  WebPermissions,
  WifiDetail,
  WifiInput,
  WingetResolved,
} from "./types";
import type { ListQuery, ServerList } from "./serverList";

type Mutation<A, R = void> = () => (args: A) => Promise<R>;

/**
 * The `not_ready` detail of a live hook whose Convex step has not landed yet;
 * a region shows "Coming in a later step" for it instead of an error.
 */
export const NOT_DEPLOYED = "Phase 4 backend function not deployed yet";

export interface DataApi {
  // ---- session (Convex Auth + account:me)
  useAuthState: () => { isLoading: boolean; isAuthenticated: boolean };
  useMe: () => MeResult | undefined;
  useAuthActions: () => {
    signIn: (args: { email: string; password: string }) => Promise<void>;
    signUp: (args: { inviteCode: string; email: string; password: string }) => Promise<void>;
    signOut: () => Promise<void>;
  };
  useRedeemReset: Mutation<{ email: string; code: string; newPassword: string }>;
  useConnectionState: () => { isWebSocketConnected: boolean };

  // ---- overview. `overview:get` has no arguments: it re-runs on counter, presence and audit
  // changes only, never on a ping.
  useOverview: () => QueryState<OverviewScreen>;
  /**
   * `overview:failedInstallsPage`: one page of failed installs, sort key `updated` only. `total` is `overview:get`'s
   * `failedInstallCount`. Subscribed only while `enabled`, that is while the counter says there are some.
   */
  useFailedInstallsPage: (query: ListQuery & { enabled: boolean }) => ServerList<FailedInstallRow>;

  // ---- devices (fleet:*). The two paginated lists (`useDevicesScreen`,
  // `useDeviceInstalls`) are in their own seam, `./devices`.
  useDeviceDetail: (deviceId: Id) => QueryState<DeviceDetail>;
  /** `fleet:liveness`: subscribe only while the detail page is open (plan 4.9). */
  useDeviceLiveness: (deviceId: Id) => QueryState<DeviceLiveness>;
  /** `fleet:watch` (viewer): the page calls it on open and every 4 minutes while visible. */
  useWatchDevice: Mutation<{ deviceId: Id }, { fastUntil: number | null }>;
  /** `fleet:checkNow` (admin, at most 50 PCs, 1 per minute per organization). */
  useCheckNow: Mutation<{ deviceIds: Id[] }, { checkId: Id }>;
  /** `fleet:checkResult` (admin): subscribe for at most 60 s after the request. */
  useCheckResult: (checkId: Id) => QueryState<CheckResult>;
  useRenameDevice: Mutation<{ deviceId: Id; expectedRevision: number; name: string }>;
  useMoveDevice: Mutation<{ deviceId: Id; expectedRevision: number; groupId: Id }>;
  /** Turning the kiosk off is a major action (fresh step-up, retried by the hook). */
  useSetKiosk: Mutation<{ deviceId: Id; expectedRevision: number; enabled: boolean }>;
  useRevokeDevice: Mutation<{ deviceId: Id }>;
  useRemoveDevice: Mutation<{ deviceId: Id }>;
  useRequestRotation: Mutation<{ deviceId: Id }>;

  // ---- groups
  /** Every group with capped counts (`groups:list`): the group pickers and filters. The Groups table uses `useGroupsPage`. */
  useGroupsScreen: () => QueryState<GroupRow[]>;
  /** `groups:page`: a bounded list with its exact total inline and offset cursors. Sort keys `name` (default) and `created`; the search is a contains match on name and description. */
  useGroupsPage: (query: ListQuery) => ServerList<GroupRow>;
  useGroupDetail: (groupId: Id) => QueryState<GroupDetail>;
  useCreateGroup: Mutation<{ name: string; description?: string }, Id>;
  /** `description`: undefined = unchanged, "" = cleared (the server's rule). */
  useUpdateGroup: Mutation<{ groupId: Id; expectedRevision: number; name: string; description?: string }, { revision: number }>;
  useDeleteGroup: Mutation<{ groupId: Id }>;
  useAssignApp: Mutation<{ groupId: Id; appId: Id; audience: Audience; pinnedTaskbar: boolean; pinnedDesktop: boolean }>;
  useUpdateAssignment: Mutation<{ assignmentId: Id; audience: Audience; pinnedTaskbar: boolean; pinnedDesktop: boolean }>;
  useUnassignApp: Mutation<{ assignmentId: Id }>;
  useAddGroupEmployee: Mutation<{ groupId: Id; employeeId: Id }>;
  useRemoveGroupEmployee: Mutation<{ groupId: Id; employeeId: Id }>;

  // ---- employees. The paginated list (`useEmployeesScreen`) is in its own seam,
  // `./employees`, like the device and app lists.
  useEmployeeDetail: (employeeId: Id | "new") => QueryState<EmployeeDetail>;
  /** `password` (optional) is hashed on the server; nothing returns it. */
  useCreateEmployee: Mutation<EmployeeInput, Id>;
  /**
   * Profile, groups and direct apps in ONE atomic call (`employees:save`: one
   * revision check, all stored or none). Resolves to the revision to send next;
   * a failure leaves the employee, and so the form's revision, untouched.
   */
  useUpdateEmployee: Mutation<Omit<EmployeeInput, "password"> & { employeeId: Id; expectedRevision: number }, { revision: number }>;
  useSetEmployeePassword: Mutation<{ employeeId: Id; password: string }>;
  useSetEmployeeDisabled: Mutation<{ employeeId: Id; disabled: boolean }>;
  useUnlockEmployee: Mutation<{ employeeId: Id }>;
  useDeleteEmployee: Mutation<{ employeeId: Id }>;

  // ---- apps. The two paginated lists (`useAppsScreen`, `useAppInstalls`) are in
  // their own seam, `./apps`, like the device lists.
  useAppDetail: (appId: Id | "new") => QueryState<AppDetail>;
  /** `apps:installSummary`: a query of its own (the counts change with every PC's report); only the install card subscribes. */
  useAppInstallSummary: (appId: Id) => QueryState<InstallCounts>;
  /** `apps:options`: the apps a group may be given. Subscribed only while the assign dialog is open. */
  useAppOptions: () => QueryState<AppOption[]>;
  useCreateWebApp: Mutation<WebAppInput, Id>;
  useCreateDesktopApp: Mutation<DesktopAppInput, Id>;
  useUpdateApp: Mutation<{ appId: Id; expectedRevision: number; web?: WebAppInput; desktop?: DesktopAppInput }>;
  /**
   * `apps:setPermissions` (admin, `expectedRevision`): the eight permissions of a website, saved on their own so the
   * form's other fields are untouched. Resolves to the revision to send next (the same one when nothing changed).
   */
  useSetAppPermissions: Mutation<{ appId: Id; expectedRevision: number; permissions: WebPermissions }, { revision: number }>;
  useSetAppArchived: Mutation<{ appId: Id; archived: boolean }>;
  useDeleteApp: Mutation<{ appId: Id }>;
  useRetryApp: Mutation<{ appId: Id }>;
  useResolveWinget: Mutation<{ packageId: string; version?: string }, WingetResolved>;
  useFetchWebMeta: Mutation<{ url: string }, WebMeta>;
  /** `apps:saveIcon`: stores the PNG `useFetchWebMeta` previewed (its `data:` URL), after the app is saved. */
  useSaveAppIcon: Mutation<{ appId: Id; png: string }>;

  // ---- networks (Phase 5 Steps 13 and 14): Wi-Fi profiles and printers.
  /** `networks:list` (viewer): one subscription for both lists and the approved driver names; no passphrase and no per-device counts. */
  useNetworks: () => QueryState<NetworksScreen>;
  /** `networks:wifiDetail` (viewer) with the apply counts, computed on demand. A NEW network has no detail: its screen builds the blank form itself. */
  useWifiDetail: (id: Id) => QueryState<WifiDetail>;
  /** `networks:saveWifi` (admin): create, or update with `expectedRevision`. Resolves to the id and the revision to send next. */
  useSaveWifi: Mutation<WifiInput, { id: Id; revision: number }>;
  /** `networks:deleteWifi` (admin): the profile leaves every PC's document and the PCs remove it. */
  useDeleteWifi: Mutation<{ id: Id }>;
  /**
   * `wifi:setPassphrase` (admin ACTION: encrypted on the server). The passphrase goes in the call and nowhere else; no query or
   * answer ever returns it. Resolves to the revision to send next.
   */
  useSetWifiPassphrase: Mutation<{ id: Id; passphrase: string; expectedRevision: number }, { revision: number }>;
  /** `networks:printerDetail` (viewer) with the apply counts, computed on demand. A NEW printer has no detail: its screen builds the blank form itself. */
  usePrinterDetail: (id: Id) => QueryState<PrinterDetail>;
  /** `networks:savePrinter` (admin): create, or update with `expectedRevision`. Resolves to the id and the revision to send next. */
  useSavePrinter: Mutation<PrinterInput, { id: Id; revision: number }>;
  /** `networks:deletePrinter` (admin): the printer leaves every PC's document and the PCs remove the queue they made. */
  useDeletePrinter: Mutation<{ id: Id }>;

  // ---- file types
  // (the rules table, `useFileTypesPage`, is in the apps seam, `./apps`; the program picker is `useAppOptions`)
  useSetFileHandler: Mutation<{ extension: string; appId: Id }>;
  useRemoveFileHandler: Mutation<{ handlerId: Id }>;

  // ---- enrollment codes: their own seam (`enrollment/api.ts`), kept out of the first load.

  // ---- audit: the paginated screen and history lists are in their own seam, `./audit`.

  // ---- settings, signing keys, members
  useSettingsScreen: () => QueryState<SettingsScreen>;
  useUpdateSettings: Mutation<{ expectedRevision: number; name: string; settings: OrgSettings }, SettingsSaved>;
  usePlan: () => QueryState<PlanScreen>;
  useSetExitPin: Mutation<{ pin: string }>;
  useClearExitPin: Mutation<void>;
  useKeysScreen: () => QueryState<KeysScreen>;
  useRegisterKey: Mutation<void>;
  /**
   * "Publish again" after a failed publish (`publishFailedAt` is set): `keys:registerActive` without
   * `force`, which registers nothing when the deployment's key is the active key and just signs and
   * publishes every PC's policy again. Owner, major action (fresh step-up); `not_ready` while the
   * deployment has no usable key, `conflict` when its key is not this organization's active key.
   */
  usePublishAgain: Mutation<void>;
  usePrepareRotation: Mutation<void>;
  useFinishRotation: Mutation<void>;
  // (the members and invites tables, `useMembersPage` / `useInvitesPage`, are in their own seam, `./members`)
  useInviteMember: Mutation<{ email: string; role: Role }, { code: string; expiresAt: number }>;
  useRevokeInvite: Mutation<{ inviteId: Id }>;
  useChangeRole: Mutation<{ memberId: Id; role: Role; expectedRevision: number }>;
  useSetMemberDisabled: Mutation<{ memberId: Id; disabled: boolean; expectedRevision: number }>;
  useCreateResetCode: Mutation<{ memberId: Id }, { code: string; expiresAt: number }>;
}
