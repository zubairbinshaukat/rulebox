/**
 * Live implementation (real Convex backend). Session, sign-in, MFA, account
 * and members are wired to the Phase 4 Step 3 functions (Step 4); settings,
 * the plan and groups to Step 5's (enrollment codes, Step 6: `../enrollment/`;
 * devices, Step 7: here and `../devices/`; signing keys, Step 8; apps,
 * assignments and file types, Step 10: here and `../apps/`). Every other
 * hook answers `not_ready` until its Convex step lands — see `../README.md`
 * for the exact function per hook.
 */
import { useAuthActions as useConvexAuthActions } from "@convex-dev/auth/react";
import {
  useAction,
  useConvexAuth,
  useConvexConnectionState,
  useMutation,
  useQueries,
  useQuery,
  type RequestForQueries,
} from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useCallback, useMemo, useState } from "react";
import { api } from "@convex/_generated/api";
import { NOT_DEPLOYED, type DataApi } from "../api";
import { AppError } from "../../lib/errors";
import { cappedNumber, type Audience, type KeysScreen, type MeResult, type PagedState, type QueryState, type Role } from "../types";
import { appDetailOf, NEW_APP } from "./apps";
import { deviceDetailOf } from "./devices";
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

const TRUST_PAGE = 200;
const trustProgressRef = makeFunctionReference<"query">("keys:trustProgress");

type TrustPage = { page: { total: number; trustNext: number }; isDone: boolean; continueCursor: string };

/**
 * "N of M devices trust the new key": `keys:trustProgress` page after page
 * (200 devices each), summed; subscribed only while a `next` key exists.
 * Undefined while a page is loading.
 */
function useTrustTotals(enabled: boolean): { trusting: number; total: number } | undefined {
  const { isAuthenticated } = useConvexAuth();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const requests = useMemo((): RequestForQueries => {
    if (!enabled || !isAuthenticated) return {};
    return Object.fromEntries(
      cursors.map((cursor, i) => [`p${i}`, { query: trustProgressRef, args: { paginationOpts: { numItems: TRUST_PAGE, cursor } } }]),
    );
  }, [enabled, isAuthenticated, cursors]);
  const results: Record<string, unknown> = useQueries(requests);
  const pages = cursors.map((_, i) => results[`p${i}`]);
  const last = pages[pages.length - 1];
  const lastPage = last !== undefined && !(last instanceof Error) ? (last as TrustPage) : null;
  const more = lastPage !== null && !lastPage.isDone ? lastPage.continueCursor : null;
  // The next page's subscription is added during render (React's "adjust state
  // while rendering" pattern, as `usePagedState` does).
  if (more !== null && !cursors.includes(more)) setCursors([...cursors, more]);
  if (!enabled || pages.some((p) => p === undefined || p instanceof Error) || more !== null) return undefined;
  let trusting = 0;
  let total = 0;
  for (const p of pages as TrustPage[]) {
    trusting += p.page.trustNext;
    total += p.page.total;
  }
  return { trusting, total };
}

/** `keys:status` (+ the trust totals while a rotation is prepared), as `KeysScreen`. */
function useLiveKeysScreen(): QueryState<KeysScreen> {
  const status = useMemberQuery(api.keys.status, {});
  const hasNext = status.status === "ready" && status.data.keys.some((k) => k.status === "next");
  const trust = useTrustTotals(hasNext);
  const trusting = trust?.trusting;
  const total = trust?.total;
  const data = status.status === "ready" ? status.data : undefined;
  const screen = useMemo((): KeysScreen | undefined => {
    if (data === undefined) return undefined;
    return {
      envKeyPresent: data.env.active !== null,
      envNextKeyPresent: data.env.next !== null,
      signing: data.signing,
      publishFailedAt: data.publishFailedAt,
      keys: data.keys.map((k) => ({ keyId: k.keyId, fingerprint: k.fingerprint, status: k.status, createdAt: k.createdAt })),
      trust: hasNext && trusting !== undefined && total !== undefined ? { trusting, total } : null,
    };
  }, [data, hasNext, trusting, total]);
  if (status.status !== "ready" || screen === undefined) return status.status === "ready" ? { status: "loading" } : status;
  return { status: "ready", data: screen };
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

  // ---- devices (Step 7). The paginated lists are in `../devices/live.ts`. Admin writes
  // go through `useMapped`: turning the kiosk off, revoke and remove need a fresh step-up
  // (the dialog opens and the call is retried once), the others an unlocked session.
  useDeviceDetail(deviceId) {
    return useMappedState(useMemberQuery(api.fleet.get, { deviceId }), deviceDetailOf);
  },
  useDeviceLiveness(deviceId) {
    return useMemberQuery(api.fleet.liveness, { deviceId });
  },
  useWatchDevice() {
    return useMapped(useMutation(api.fleet.watch));
  },
  useCheckNow() {
    return useMapped(useMutation(api.fleet.checkNow));
  },
  useCheckResult(checkId) {
    return useMemberQuery(api.fleet.checkResult, { checkId });
  },
  useRenameDevice() {
    const rename = useMutation(api.fleet.rename);
    const call = useCallback(
      async (a: { deviceId: string; expectedRevision: number; name: string }) => {
        await rename(a);
      },
      [rename],
    );
    return useMapped(call);
  },
  useMoveDevice() {
    const move = useMutation(api.fleet.move);
    const call = useCallback(
      async (a: { deviceId: string; expectedRevision: number; groupId: string }) => {
        await move(a);
      },
      [move],
    );
    return useMapped(call);
  },
  useSetKiosk() {
    const set = useMutation(api.fleet.setKiosk);
    const call = useCallback(
      async (a: { deviceId: string; expectedRevision: number; enabled: boolean }) => {
        await set(a);
      },
      [set],
    );
    return useMapped(call);
  },
  useRevokeDevice() {
    const revoke = useMutation(api.fleet.revoke);
    const call = useCallback(
      async (a: { deviceId: string }) => {
        await revoke(a);
      },
      [revoke],
    );
    return useMapped(call);
  },
  useRemoveDevice() {
    const remove = useMutation(api.fleet.remove);
    const call = useCallback(
      async (a: { deviceId: string }) => {
        await remove(a);
      },
      [remove],
    );
    return useMapped(call);
  },
  useRequestRotation() {
    const request = useMutation(api.fleet.requestCredentialRotation);
    const call = useCallback(
      async (a: { deviceId: string }) => {
        await request(a);
      },
      [request],
    );
    return useMapped(call);
  },

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
      assignments: apps.map((a) => ({
        _id: a.assignmentId,
        appId: a.appId,
        appName: a.name,
        appKind: a.kind,
        hue: a.hue,
        audience: a.audience,
        pinnedTaskbar: a.pinnedTaskbar,
        pinnedDesktop: a.pinnedDesktop,
      })),
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
  // Assigning apps to a group: a group's document is rebuilt on the server for every change.
  useAssignApp() {
    const assign = useMutation(api.groups.assignApp);
    const call = useCallback(
      async (a: { groupId: string; appId: string; audience: Audience; pinnedTaskbar: boolean; pinnedDesktop: boolean }) => {
        await assign(a);
      },
      [assign],
    );
    return useMapped(call);
  },
  useUpdateAssignment() {
    const base = useMutation(api.groups.updateAssignment);
    // Pins and audience are toggles: the group page shows the change at once, the server's answer replaces it.
    const update = useMemo(
      () =>
        base.withOptimisticUpdate((store, a) => {
          for (const { args, value } of store.getAllQueries(api.groups.get)) {
            if (value === undefined || !value.apps.some((x) => x.assignmentId === a.assignmentId)) continue;
            store.setQuery(api.groups.get, args, {
              ...value,
              apps: value.apps.map((x) =>
                x.assignmentId === a.assignmentId ? { ...x, audience: a.audience, pinnedTaskbar: a.pinnedTaskbar, pinnedDesktop: a.pinnedDesktop } : x,
              ),
            });
          }
        }),
      [base],
    );
    const call = useCallback(
      async (a: { assignmentId: string; audience: Audience; pinnedTaskbar: boolean; pinnedDesktop: boolean }) => {
        await update(a);
      },
      [update],
    );
    return useMapped(call);
  },
  useUnassignApp() {
    const unassign = useMutation(api.groups.unassignApp);
    const call = useCallback(
      async (a: { assignmentId: string }) => {
        await unassign(a);
      },
      [unassign],
    );
    return useMapped(call);
  },  useAddGroupEmployee: useNotReadyMutation,
  useRemoveGroupEmployee: useNotReadyMutation,

  useEmployeesScreen: useNotReadyPaged,
  useEmployeeDetail: useNotReady,
  useCreateEmployee: useNotReadyMutation,
  useUpdateEmployee: useNotReadyMutation,
  useSetEmployeePassword: useNotReadyMutation,
  useSetEmployeeDisabled: useNotReadyMutation,
  useUnlockEmployee: useNotReadyMutation,
  useDeleteEmployee: useNotReadyMutation,

  // ---- apps (Step 10). The paginated lists are in `../apps/live.ts`. `remove` is a major action
  // (fresh step-up); `useMapped` opens the dialog and retries.
  useAppDetail(appId) {
    const q = useMemberQuery(api.apps.get, appId === "new" ? "skip" : { appId });
    const mapped = useMappedState(q, appDetailOf);
    return appId === "new" ? { status: "ready", data: NEW_APP } : mapped;
  },
  useAppOptions() {
    return useMemberQuery(api.apps.options, {});
  },
  useCreateWebApp() {
    return useMapped(useMutation(api.apps.createWeb));
  },
  useCreateDesktopApp() {
    return useMapped(useMutation(api.apps.createDesktop));
  },
  useUpdateApp() {
    const update = useMutation(api.apps.update);
    const call = useCallback(
      async (a: Parameters<typeof update>[0]) => {
        await update(a);
      },
      [update],
    );
    return useMapped(call);
  },
  useSetAppArchived() {
    const base = useMutation(api.apps.setArchived);
    const set = useMemo(
      () =>
        base.withOptimisticUpdate((store, a) => {
          const detail = store.getQuery(api.apps.get, { appId: a.appId });
          if (detail !== undefined) store.setQuery(api.apps.get, { appId: a.appId }, { ...detail, archived: a.archived });
        }),
      [base],
    );
    const call = useCallback(
      async (a: { appId: string; archived: boolean }) => {
        await set(a);
      },
      [set],
    );
    return useMapped(call);
  },
  useDeleteApp() {
    const remove = useMutation(api.apps.remove);
    const call = useCallback(
      async (a: { appId: string }) => {
        await remove(a);
      },
      [remove],
    );
    return useMapped(call);
  },
  useRetryApp() {
    const retry = useMutation(api.apps.retry);
    const call = useCallback(
      async (a: { appId: string }) => {
        await retry(a);
      },
      [retry],
    );
    return useMapped(call);
  },
  useResolveWinget() {
    return useMapped(useAction(api.apps.resolveWinget));
  },
  useFetchWebMeta() {
    return useMapped(useAction(api.apps.fetchWebMeta));
  },
  useSaveAppIcon() {
    const save = useAction(api.apps.saveIcon);
    const call = useCallback(
      async (a: { appId: string; png: string }) => {
        await save(a);
      },
      [save],
    );
    return useMapped(call);
  },

  // ---- file types (Step 10). Removing a rule is a major action.
  useFileTypesScreen() {
    return useMemberQuery(api.fileHandlers.list, {});
  },
  useSetFileHandler() {
    const set = useMutation(api.fileHandlers.set);
    const call = useCallback(
      async (a: { extension: string; appId: string }) => {
        await set(a);
      },
      [set],
    );
    return useMapped(call);
  },
  useRemoveFileHandler() {
    const remove = useMutation(api.fileHandlers.remove);
    const call = useCallback(
      async (a: { handlerId: string }) => {
        await remove(a);
      },
      [remove],
    );
    return useMapped(call);
  },
  // Enrollment codes (Step 6) have their own seam: `../enrollment/live.ts`.

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
  // ---- signing keys (Step 8). The three writes are Owner major actions (fresh step-up).
  useKeysScreen: useLiveKeysScreen,
  useRegisterKey() {
    const register = useMutation(api.keys.registerActive);
    const call = useCallback(async () => {
      await register({});
    }, [register]);
    return useMapped(call);
  },
  usePrepareRotation() {
    const prepare = useMutation(api.keys.prepareRotation);
    const call = useCallback(async () => {
      await prepare({});
    }, [prepare]);
    return useMapped(call);
  },
  useFinishRotation() {
    const finish = useMutation(api.keys.finishRotation);
    const call = useCallback(async () => {
      await finish({});
    }, [finish]);
    return useMapped(call);
  },
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

