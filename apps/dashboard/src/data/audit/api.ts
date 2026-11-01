import type { AuditEntry, Id, PagedState } from "../types";

/**
 * The paginated audit lists (plan Step 17). A seam of their own, like
 * `../devices` and `../apps`: the live lists need Convex's `usePaginatedQuery`,
 * which must not reach the first load (sign-in). Only the lazy Audit screen and
 * the history panel of the detail screens import `data/audit`.
 */
export interface AuditApi {
  /** `audit:list`, paginated (50), newest first. */
  useAuditScreen: () => PagedState<AuditEntry>;
  /** `audit:forTarget({ targetId })`, paginated (10, then 10 more), newest first: one device, employee, app or group. */
  useHistory: (targetId: Id) => PagedState<AuditEntry>;
}
