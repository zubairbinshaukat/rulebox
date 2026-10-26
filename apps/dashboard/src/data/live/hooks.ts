/**
 * Live implementation (real Convex backend). The Phase 4 Convex functions do
 * not exist yet, so every hook answers `not_ready` for now. Each one is
 * swapped for `useQuery(api.x.y)` / `usePaginatedQuery` / `useMutation` /
 * `useAction` as the backend steps land — see `../README.md` for the exact
 * function per hook.
 *
 * The connection state is already real (`ConvexReactClient.connectionState()`).
 */
import { useConvex } from "convex/react";
import { useEffect, useState } from "react";
import type { DataApi } from "../api";
import { AppError } from "../../lib/errors";
import type { PagedState, QueryState } from "../types";

const notReady = () => new AppError({ code: "not_ready", detail: "Phase 4 backend function not deployed yet" });

function useNotReady<T>(): QueryState<T> {
  return { status: "error", error: notReady(), retry: () => undefined };
}

function useNotReadyPaged<T>(): PagedState<T> {
  return { status: "error", error: notReady(), retry: () => undefined };
}

function useNotReadyMutation<A, R>(): (args: A) => Promise<R> {
  return async () => {
    throw notReady();
  };
}

export const liveApi: DataApi = {
  // Step 4: useConvexAuth() from convex/react (with ConvexAuthProvider).
  useAuthState: () => ({ isLoading: false, isAuthenticated: false }),
  // Step 3/4: useQuery(api.account.me)
  useMe: () => null,
  // Step 4: useAuthActions() from @convex-dev/auth/react; signIn("password", { email, password, flow: "signIn" | "signUp", inviteCode })
  useAuthActions: () => ({
    signIn: async () => {
      throw notReady();
    },
    signUp: async () => {
      throw notReady();
    },
    signOut: async () => undefined,
  }),
  useRedeemReset: useNotReadyMutation,
  useConnectionState() {
    const convex = useConvex();
    const [connected, setConnected] = useState(true);
    useEffect(() => {
      const tick = () => setConnected(convex.connectionState().isWebSocketConnected);
      const t = setInterval(tick, 1000);
      return () => clearInterval(t);
    }, [convex]);
    return { isWebSocketConnected: connected };
  },

  useMfaStatus: useNotReady,
  useBeginMfaSetup: useNotReadyMutation,
  useConfirmMfaSetup: useNotReadyMutation,
  useVerifyMfa: useNotReadyMutation,
  useRedeemRecoveryCode: useNotReadyMutation,

  useOverview: useNotReady,

  useDevicesScreen: useNotReadyPaged,
  useLiveStatus: () => undefined,
  useDeviceDetail: useNotReady,
  useDeviceInstalls: useNotReadyPaged,
  useRenameDevice: useNotReadyMutation,
  useMoveDevice: useNotReadyMutation,
  useSetKiosk: useNotReadyMutation,
  useRevokeDevice: useNotReadyMutation,
  useRemoveDevice: useNotReadyMutation,
  useRequestRotation: useNotReadyMutation,

  useGroupsScreen: useNotReady,
  useGroupDetail: useNotReady,
  useCreateGroup: useNotReadyMutation,
  useUpdateGroup: useNotReadyMutation,
  useDeleteGroup: useNotReadyMutation,
  useAssignApp: useNotReadyMutation,
  useUpdateAssignment: useNotReadyMutation,
  useUnassignApp: useNotReadyMutation,
  useAddGroupEmployee: useNotReadyMutation,
  useRemoveGroupEmployee: useNotReadyMutation,

  useEmployeesScreen: useNotReadyPaged,
  useEmployeeDetail: useNotReady,
  useCreateEmployee: useNotReadyMutation,
  useUpdateEmployee: useNotReadyMutation,
  useSetEmployeePassword: useNotReadyMutation,
  useSetEmployeeDisabled: useNotReadyMutation,
  useUnlockEmployee: useNotReadyMutation,
  useDeleteEmployee: useNotReadyMutation,

  useAppsScreen: useNotReadyPaged,
  useAppDetail: useNotReady,
  useAppInstalls: useNotReadyPaged,
  useCreateWebApp: useNotReadyMutation,
  useCreateDesktopApp: useNotReadyMutation,
  useUpdateApp: useNotReadyMutation,
  useSetAppArchived: useNotReadyMutation,
  useDeleteApp: useNotReadyMutation,
  useRetryApp: useNotReadyMutation,
  useResolveWinget: useNotReadyMutation,
  useFetchWebMeta: useNotReadyMutation,

  useFileTypesScreen: useNotReady,
  useSetFileHandler: useNotReadyMutation,
  useRemoveFileHandler: useNotReadyMutation,

  useEnrollmentScreen: useNotReadyPaged,
  useCreateEnrollmentCode: useNotReadyMutation,
  useRevokeEnrollmentCode: useNotReadyMutation,

  useAuditScreen: useNotReadyPaged,
  useHistory: useNotReadyPaged,

  useSettingsScreen: useNotReady,
  useUpdateSettings: useNotReadyMutation,
  useSetExitPin: useNotReadyMutation,
  useClearExitPin: useNotReadyMutation,
  useKeysScreen: useNotReady,
  useRegisterKey: useNotReadyMutation,
  usePrepareRotation: useNotReadyMutation,
  useFinishRotation: useNotReadyMutation,
  useMembersScreen: useNotReady,
  useInviteMember: useNotReadyMutation,
  useRevokeInvite: useNotReadyMutation,
  useChangeRole: useNotReadyMutation,
  useSetMemberDisabled: useNotReadyMutation,
  useCreateResetCode: useNotReadyMutation,
  useResetMemberMfa: useNotReadyMutation,
};

/** Resolved through the `@rulebox/data-impl` alias in live builds. */
export const dataApi = liveApi;

