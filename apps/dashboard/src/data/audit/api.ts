import type { ListQuery, ServerList } from "../serverList";
import type { AuditEntry, Id } from "../types";

/**
 * The server-driven audit lists (plan Step 17, Phase 4b). A seam of their own, like
 * `../devices` and `../apps`: only the lazy Audit screen and the history panel of the detail
 * screens import `data/audit`. Sort key `at` only (newest first by default), no search and
 * no total (no exact counter): the pager shows Previous / Next and "Page N".
 */
export interface AuditApi {
  /**
   * `audit:list` (or `audit:forTarget` when `targetId` is set), one page. `since` (ms, rows at or after it) is the When filter; the screen passes the
   * start of the local day so the subscription does not churn. `targetId` is "only this item" (any id the log has a row for, also a deleted one).
   */
  useAuditScreen: (query: AuditScreenQuery) => ServerList<AuditEntry>;
  /** `audit:forTarget({ targetId })`, one page: one device, employee, app or group. */
  useHistory: (targetId: Id, query: ListQuery) => ServerList<AuditEntry>;
}

/** What the audit screen filters by besides the page: both are arguments of the server query (existing indexes, no new one). */
export type AuditScreenQuery = ListQuery & { since?: number; targetId?: Id };
