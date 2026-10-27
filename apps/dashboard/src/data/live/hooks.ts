/**
 * Live implementation (real Convex backend). Session, sign-in, MFA, account
 * and members are wired to the Phase 4 Step 3 functions (Step 4); settings,
 * the plan and groups to Step 5's. Every other
 * hook answers `not_ready` until its Convex step lands — see `../README.md`
 * for the exact function per hook.
 */
import { useAuthActions as useConvexAuthActions } from "@convex-dev/auth/react";
import { useAction, useConvexAuth, useConvexConnectionState, useMutation, useQuery } from "convex/react";
import { useCallback, useMemo } from "react";
import { api } from "@convex/_generated/api";
import { NOT_DEPLOYED, type DataApi } from "../api";
import { AppError } from "../../lib/errors";
import { cappedNumber, type MeResult, type PagedState, type QueryState, type Role } from "../types";
import { mapError, useMapped, useMappedState, useMemberQuery } from "./convex";

const notReady = () => new AppError({ code: "not_ready", detail: NOT_DEPLOYED });

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

/** Convex Auth sign-in through the "password" credentials provider (convex/auth.ts). */
function useLiveAuthActions() {
  const { signIn, signOut } = useConvexAuthActions();
  return useMemo(() => {
    const run = async (params: Record<string, string>) => {
      try {
        const r = await signIn("password", params);
        // Credentials sign-in either returns tokens or throws; anything else is a failure.
        if (!r.signingIn) throw new Error("sign-in did not complete");
      } catch (e) {
        throw mapError(e);
      }
    };
    return {
      signIn: ({ email, password }: { email: string; password: string }) => run({ flow: "signIn", email, password }),
      signUp: ({ inviteCode, email, password }: { inviteCode: string; email: string; password: string }) =>
        run({ flow: "signUp", inviteCode, email, password }),
      // Convex Auth removes its own tokens; errors (already signed out) are ignored there.
      signOut: () => signOut(),
    };
  }, [signIn, signOut]);
}

export const liveApi: DataApi = {
  // ---- session (Convex Auth + account:me)
  useAuthState() {
    const { isLoading, isAuthenticated } = useConvexAuth();
    return { isLoading, isAuthenticated };
  },
  useMe(): MeResult | undefined {
    return useQuery(api.account.me);
  },
  useAuthActions: useLiveAuthActions,
  useRedeemReset() {
    const redeem = useAction(api.account.redeemReset);
    const call = useCallback(
      async (a: { email: string; code: string; newPassword: string }) => {
        await redeem(a);
      },
      [redeem],
    );
    return useMapped(call);
  },
  useConnectionState() {
    const { isWebSocketConnected } = useConvexConnectionState();
    return { isWebSocketConnected };
  },

  // ---- MFA (actions except `status`)
  useMfaStatus() {
    return useMemberQuery(api.mfa.status, {});
  },
  useBeginMfaSetup() {
    const begin = useAction(api.mfa.beginSetup);
    const call = useCallback(async () => await begin({}), [begin]);
    return useMapped(call);
  },
  useConfirmMfaSetup() {
    return useMapped(useAction(api.mfa.confirmSetup));
  },
  useVerifyMfa() {
    const verify = useAction(api.mfa.verify);
    const call = useCallback(
      async (a: { code: string }) => {
        await verify(a);
      },
      [verify],
    );
    return useMapped(call);
  },
  useRedeemRecoveryCode() {
    const redeem = useAction(api.mfa.useRecoveryCode);
    const call = useCallback(
      async (a: { code: string }) => {
        await redeem(a);
      },
      [redeem],
    );
    return useMapped(call);
  },

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

  // ---- groups (Step 5). Counts arrive as `{ count, more }` and become one capped number.
  useGroupsScreen() {
    const q = useMemberQuery(api.groups.list, {});
    return useMappedState(q, (rows) =>
      rows.map(({ devices, employees, ...g }) => ({ ...g, deviceCount: cappedNumber(devices), employeeCount: cappedNumber(employees) })),
    );
  },
  useGroupDetail(groupId) {
    const q = useMemberQuery(api.groups.get, { groupId });
    return useMappedState(q, ({ group: g, apps }) => ({
      _id: g._id,
      name: g.name,
      description: g.description,
      revision: g.revision,
      deviceCount: cappedNumber(g.devices),
      employeeCount: cappedNumber(g.employees),
      assignments: apps.map((a) => ({ _id: a.appId, appId: a.appId, appName: a.name, appKind: a.kind, audience: a.audience, pinnedTaskbar: a.pinnedTaskbar, pinnedDesktop: a.pinnedDesktop })),
    }));
  },
  useCreateGroup() {
    const create = useMutation(api.groups.create);
    const call = useCallback(async (a: { name: string; description?: string }) => (await create(a)).groupId as string, [create]);
    return useMapped(call);
  },
  useUpdateGroup() {
    return useMapped(useMutation(api.groups.rename));
  },
  useDeleteGroup() {
    const remove = useMutation(api.groups.remove);
    const call = useCallback(
      async (a: { groupId: string }) => {
        await remove(a);
      },
      [remove],
    );
    return useMapped(call);
  },
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

  // ---- organization settings (Step 5). Changing the admin exit, the exit PIN and
  // deleting a group are major actions: `useMapped` opens the step-up dialog and retries.
  useSettingsScreen() {
    return useMemberQuery(api.settings.get, {});
  },
  useUpdateSettings() {
    return useMapped(useMutation(api.settings.update));
  },
  usePlan() {
    return useMemberQuery(api.settings.plan, {});
  },
  useSetExitPin() {
    // An action: the PIN is hashed on the server and never sent to a query.
    const set = useAction(api.settings.setExitPin);
    const call = useCallback(
      async (a: { pin: string }) => {
        await set(a);
      },
      [set],
    );
    return useMapped(call);
  },
  useClearExitPin() {
    const clear = useMutation(api.settings.clearExitPin);
    const call = useCallback(async () => {
      await clear({});
    }, [clear]);
    return useMapped(call);
  },
  useKeysScreen: useNotReady,
  useRegisterKey: useNotReadyMutation,
  usePrepareRotation: useNotReadyMutation,
  useFinishRotation: useNotReadyMutation,
  // ---- members (Owner-only changes; codes are returned once and kept in component state)
  useMembersScreen() {
    return useMemberQuery(api.members.list, {});
  },
  useInviteMember() {
    return useMapped(useAction(api.members.invite));
  },
  useRevokeInvite() {
    const revoke = useMutation(api.members.revokeInvite);
    const call = useCallback(
      async (a: { inviteId: string }) => {
        await revoke(a);
      },
      [revoke],
    );
    return useMapped(call);
  },
  useChangeRole() {
    const change = useMutation(api.members.changeRole);
    const call = useCallback(
      async (a: { memberId: string; role: Role; expectedRevision: number }) => {
        await change(a);
      },
      [change],
    );
    return useMapped(call);
  },
  useSetMemberDisabled() {
    const set = useMutation(api.members.setDisabled);
    const call = useCallback(
      async (a: { memberId: string; disabled: boolean; expectedRevision: number }) => {
        await set(a);
      },
      [set],
    );
    return useMapped(call);
  },
  useCreateResetCode() {
    return useMapped(useAction(api.members.createResetCode));
  },
  useResetMemberMfa() {
    const reset = useMutation(api.members.resetMfa);
    const call = useCallback(
      async (a: { memberId: string }) => {
        await reset(a);
      },
      [reset],
    );
    return useMapped(call);
  },
};

/** Resolved through the `@rulebox/data-impl` alias in live builds. */
export const dataApi = liveApi;

