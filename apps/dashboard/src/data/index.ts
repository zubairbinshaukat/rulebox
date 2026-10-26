/**
 * The only module screens import data hooks from. The implementation is
 * picked at build time: `VITE_DEMO=1` (`pnpm dev:demo`) uses the in-memory
 * fixtures, anything else the real Convex backend.
 */
import type { DataApi } from "./api";
import { demoApi } from "./demo/hooks";
import { liveApi } from "./live/hooks";

export const IS_DEMO = import.meta.env.VITE_DEMO === "1";

const api: DataApi = IS_DEMO ? demoApi : liveApi;

export const {
  useAuthState,
  useMe,
  useAuthActions,
  useRedeemReset,
  useConnectionState,
  useMfaStatus,
  useBeginMfaSetup,
  useConfirmMfaSetup,
  useVerifyMfa,
  useRedeemRecoveryCode,
  useOverview,
  useDevicesScreen,
  useLiveStatus,
  useDeviceDetail,
  useDeviceInstalls,
  useRenameDevice,
  useMoveDevice,
  useSetKiosk,
  useRevokeDevice,
  useRemoveDevice,
  useRequestRotation,
  useGroupsScreen,
  useGroupDetail,
  useCreateGroup,
  useUpdateGroup,
  useDeleteGroup,
  useAssignApp,
  useUpdateAssignment,
  useUnassignApp,
  useAddGroupEmployee,
  useRemoveGroupEmployee,
  useEmployeesScreen,
  useEmployeeDetail,
  useCreateEmployee,
  useUpdateEmployee,
  useSetEmployeePassword,
  useSetEmployeeDisabled,
  useUnlockEmployee,
  useDeleteEmployee,
  useAppsScreen,
  useAppDetail,
  useAppInstalls,
  useCreateWebApp,
  useCreateDesktopApp,
  useUpdateApp,
  useSetAppArchived,
  useDeleteApp,
  useRetryApp,
  useResolveWinget,
  useFetchWebMeta,
  useFileTypesScreen,
  useSetFileHandler,
  useRemoveFileHandler,
  useEnrollmentScreen,
  useCreateEnrollmentCode,
  useRevokeEnrollmentCode,
  useAuditScreen,
  useHistory,
  useSettingsScreen,
  useUpdateSettings,
  useSetExitPin,
  useClearExitPin,
  useKeysScreen,
  useRegisterKey,
  usePrepareRotation,
  useFinishRotation,
  useMembersScreen,
  useInviteMember,
  useRevokeInvite,
  useChangeRole,
  useSetMemberDisabled,
  useCreateResetCode,
  useResetMemberMfa,
} = api;

/** Must match `SERVER_API_VERSION` in `convex/lib/limits.ts` (edge case 14). */
export const DASHBOARD_API_VERSION = 1;
