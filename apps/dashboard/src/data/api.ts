/**
 * The data seam: every hook a screen may call. Both implementations
 * (`demo/hooks.ts` and `live/hooks.ts`) must satisfy this type, so swapping
 * one hook body for Convex is a local change (see README.md).
 */
import type {
  AppDetail,
  AppInstallRow,
  AppRow,
  Audience,
  AuditEntry,
  DesktopAppInput,
  DeviceDetail,
  DeviceFilter,
  DeviceInstallRow,
  DeviceRow,
  EmployeeDetail,
  EmployeeInput,
  EmployeeRow,
  EnrollmentCodeRow,
  EnrollmentInput,
  FileTypesScreen,
  GroupDetail,
  GroupRow,
  Id,
  InstallState,
  KeysScreen,
  LiveStatus,
  MeResult,
  MembersScreen,
  MfaSetup,
  MfaStatus,
  OrgSettings,
  OverviewScreen,
  PagedState,
  QueryState,
  Role,
  SettingsScreen,
  WebAppInput,
  WebMeta,
  WingetResolved,
} from "./types";

type Mutation<A, R = void> = () => (args: A) => Promise<R>;

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

  // ---- devices (fleet:*)
  useDevicesScreen: (filter: DeviceFilter) => PagedState<DeviceRow> & { searchCapped?: boolean };
  useLiveStatus: (deviceIds: Id[]) => LiveStatus | undefined;
  useDeviceDetail: (deviceId: Id) => QueryState<DeviceDetail>;
  useDeviceInstalls: (deviceId: Id) => PagedState<DeviceInstallRow>;
  useRenameDevice: Mutation<{ deviceId: Id; expectedRevision: number; name: string }>;
  useMoveDevice: Mutation<{ deviceId: Id; expectedRevision: number; groupId: Id }>;
  useSetKiosk: Mutation<{ deviceId: Id; enabled: boolean }>;
  useRevokeDevice: Mutation<{ deviceId: Id }>;
  useRemoveDevice: Mutation<{ deviceId: Id }>;
  useRequestRotation: Mutation<{ deviceId: Id }>;

  // ---- groups
  useGroupsScreen: () => QueryState<GroupRow[]>;
  useGroupDetail: (groupId: Id) => QueryState<GroupDetail>;
  useCreateGroup: Mutation<{ name: string; description?: string }, Id>;
  useUpdateGroup: Mutation<{ groupId: Id; expectedRevision: number; name: string; description?: string }>;
  useDeleteGroup: Mutation<{ groupId: Id }>;
  useAssignApp: Mutation<{ groupId: Id; appId: Id; audience: Audience; pinnedTaskbar: boolean; pinnedDesktop: boolean }>;
  useUpdateAssignment: Mutation<{ assignmentId: Id; audience: Audience; pinnedTaskbar: boolean; pinnedDesktop: boolean }>;
  useUnassignApp: Mutation<{ assignmentId: Id }>;
  useAddGroupEmployee: Mutation<{ groupId: Id; employeeId: Id }>;
  useRemoveGroupEmployee: Mutation<{ groupId: Id; employeeId: Id }>;

  // ---- employees
  useEmployeesScreen: (filter: { groupId?: Id; search?: string }) => PagedState<EmployeeRow> & { searchCapped?: boolean };
  useEmployeeDetail: (employeeId: Id | "new") => QueryState<EmployeeDetail>;
  useCreateEmployee: Mutation<EmployeeInput, Id>;
  useUpdateEmployee: Mutation<EmployeeInput & { employeeId: Id; expectedRevision: number }>;
  useSetEmployeePassword: Mutation<{ employeeId: Id; password: string }>;
  useSetEmployeeDisabled: Mutation<{ employeeId: Id; disabled: boolean }>;
  useUnlockEmployee: Mutation<{ employeeId: Id }>;
  useDeleteEmployee: Mutation<{ employeeId: Id }>;

  // ---- apps
  useAppsScreen: (filter: { archived: boolean }) => PagedState<AppRow>;
  useAppDetail: (appId: Id | "new") => QueryState<AppDetail>;
  useAppInstalls: (appId: Id, state: InstallState) => PagedState<AppInstallRow>;
  useCreateWebApp: Mutation<WebAppInput, Id>;
  useCreateDesktopApp: Mutation<DesktopAppInput, Id>;
  useUpdateApp: Mutation<{ appId: Id; expectedRevision: number; web?: WebAppInput; desktop?: DesktopAppInput }>;
  useSetAppArchived: Mutation<{ appId: Id; archived: boolean }>;
  useDeleteApp: Mutation<{ appId: Id }>;
  useRetryApp: Mutation<{ appId: Id }>;
  useResolveWinget: Mutation<{ packageId: string; version?: string }, WingetResolved>;
  useFetchWebMeta: Mutation<{ url: string }, WebMeta>;

  // ---- file types
  useFileTypesScreen: () => QueryState<FileTypesScreen>;
  useSetFileHandler: Mutation<{ extension: string; appId: Id }>;
  useRemoveFileHandler: Mutation<{ handlerId: Id }>;

  // ---- enrollment codes
  useEnrollmentScreen: (nowMinute: number) => PagedState<EnrollmentCodeRow>;
  useCreateEnrollmentCode: Mutation<EnrollmentInput, { code: string; expiresAt: number }>;
  useRevokeEnrollmentCode: Mutation<{ tokenId: Id }>;

  // ---- audit
  useAuditScreen: () => PagedState<AuditEntry>;
  useHistory: (targetId: Id) => PagedState<AuditEntry>;

  // ---- settings, signing keys, members
  useSettingsScreen: () => QueryState<SettingsScreen>;
  useUpdateSettings: Mutation<{ expectedRevision: number; name: string; settings: OrgSettings }>;
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
