import type { ListQuery, ServerList } from "../serverList";
import type { AllowInput, AllowOptions, DeviceLockdown, FindingRow, FindingStatus, Id, LockdownSettings, LockdownView, QueryState } from "../types";

type Mutation<A, R = void> = () => (args: A) => Promise<R>;

/**
 * Lockdown hooks (Phase 5 Step 19, `convex/lockdown.ts`, plan 4.20). A seam of their own, like `../enrollment`: only the
 * lockdown, findings and device screens import `data/lockdown`, so nothing here is in the first load.
 */
export interface LockdownApi {
  /** `lockdown:groupView` (viewer): the group's settings, its newest exceptions and how many findings are open. */
  useLockdownView: (groupId: Id) => QueryState<LockdownView>;
  /** `lockdown:update` (admin; MAJOR when a program rule changes mode or App Control changes level: the hook opens the step-up dialog and retries). */
  useSaveLockdown: Mutation<{ groupId: Id; settings: LockdownSettings; expectedRevision: number }, { revision: number }>;
  /** `lockdown:findings` (viewer): one page of one status; sort key `seen` only; no search, no total. */
  useFindingsPage: (query: ListQuery & { status: FindingStatus }) => ServerList<FindingRow>;
  /** `lockdown:allowOptions` (admin): groups and programs for the allow dialog. Subscribed only while the dialog is open. */
  useAllowOptions: () => QueryState<AllowOptions>;
  /** `lockdown:allow` (admin): one exception per chosen group (at most 10). */
  useAllowFinding: Mutation<AllowInput, { added: number }>;
  /** `lockdown:ignore` (admin). */
  useIgnoreFinding: Mutation<{ findingId: Id }>;
  /** `lockdown:removeException` (admin). */
  useRemoveException: Mutation<{ exceptionId: Id }>;
  /**
   * The lockdown part of `fleet:get` for the device page's cards. The SAME query and arguments as `useDeviceDetail`, so Convex
   * serves both from one subscription: no extra read. (Kept here so the first load does not carry the lockdown fields.)
   */
  useDeviceLockdown: (deviceId: Id) => QueryState<DeviceLockdown>;
  /** `fleet:allowUsb` (admin): 1 to 8 whole hours; 0 ends it now. */
  useAllowUsb: Mutation<{ deviceId: Id; hours: number }, { until: number | null }>;
}
