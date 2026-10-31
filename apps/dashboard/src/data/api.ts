/**
 * The data seam: every hook a screen may call. Both implementations
 * (`demo/hooks.ts` and `live/hooks.ts`) must satisfy this type, so swapping
 * one hook body for Convex is a local change (see README.md).
 */
import type {
  AppDetail,
  AppOption,
  Audience,
  AuditEntry,
  CheckResult,
  DesktopAppInput,
  DeviceDetail,
  DeviceLiveness,
  EmployeeDetail,
  EmployeeInput,
  FileTypesScreen,
  GroupDetail,
  GroupRow,
  Id,
  KeysScreen,
  MeResult,
  MembersScreen,
  MfaSetup,
  MfaStatus,
  OrgSettings,
  OverviewScreen,
  PagedState,
  PlanScreen,
  QueryState,
  Role,
  SettingsSaved,
  SettingsScreen,
  WebAppInput,
  WebMeta,
  WingetResolved,
} from "./types";

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

  // ---- MFA (mfa:*)
  useMfaStatus: () => QueryState<MfaStatus>;
  useBeginMfaSetup: Mutation<void, MfaSetup>;
  useConfirmMfaSetup: Mutation<{ code: string }, string[]>;
  useVerifyMfa: Mutation<{ code: string }>;
  useRedeemRecoveryCode: Mutation<{ code: string }>;

  // ---- overview
  useOverview: (nowMinute: number) => QueryState<OverviewScreen>;

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
  useGroupsScreen: () => QueryState<GroupRow[]>;
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
  /** `apps:options`: the apps a group may be given. Subscribed only while the assign dialog is open. */
  useAppOptions: () => QueryState<AppOption[]>;
  useCreateWebApp: Mutation<WebAppInput, Id>;
  useCreateDesktopApp: Mutation<DesktopAppInput, Id>;
  useUpdateApp: Mutation<{ appId: Id; expectedRevision: number; web?: WebAppInput; desktop?: DesktopAppInput }>;
  useSetAppArchived: Mutation<{ appId: Id; archived: boolean }>;
  useDeleteApp: Mutation<{ appId: Id }>;
  useRetryApp: Mutation<{ appId: Id }>;
  useResolveWinget: Mutation<{ packageId: string; version?: string }, WingetResolved>;
  useFetchWebMeta: Mutation<{ url: string }, WebMeta>;
  /** `apps:saveIcon`: stores the PNG `useFetchWebMeta` previewed (its `data:` URL), after the app is saved. */
  useSaveAppIcon: Mutation<{ appId: Id; png: string }>;

  // ---- file types
  useFileTypesScreen: () => QueryState<FileTypesScreen>;
  useSetFileHandler: Mutation<{ extension: string; appId: Id }>;
  useRemoveFileHandler: Mutation<{ handlerId: Id }>;

  // ---- enrollment codes: their own seam (`enrollment/api.ts`), kept out of the first load.

  // ---- audit
  useAuditScreen: () => PagedState<AuditEntry>;
  useHistory: (targetId: Id) => PagedState<AuditEntry>;

  // ---- settings, signing keys, members
  useSettingsScreen: () => QueryState<SettingsScreen>;
  useUpdateSettings: Mutation<{ expectedRevision: number; name: string; settings: OrgSettings }, SettingsSaved>;
  usePlan: () => QueryState<PlanScreen>;
  useSetExitPin: Mutation<{ pin: string }>;
  useClearExitPin: Mutation<void>;
  useKeysScreen: () => QueryState<KeysScreen>;
  useRegisterKey: Mutation<void>;
  usePrepareRotation: Mutation<void>;
  useFinishRotation: Mutation<void>;
  useMembersScreen: () => QueryState<MembersScreen>;
  useInviteMember: Mutation<{ email: string; role: Role }, { code: string; expiresAt: number }>;
  useRevokeInvite: Mutation<{ inviteId: Id }>;
  useChangeRole: Mutation<{ memberId: Id; role: Role; expectedRevision: number }>;
  useSetMemberDisabled: Mutation<{ memberId: Id; disabled: boolean; expectedRevision: number }>;
  useCreateResetCode: Mutation<{ memberId: Id }, { code: string; expiresAt: number }>;
  useResetMemberMfa: Mutation<{ memberId: Id }>;
}
