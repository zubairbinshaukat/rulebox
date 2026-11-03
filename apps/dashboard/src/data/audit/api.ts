import type { ListQuery, ServerList } from "../serverList";
import type { AuditEntry, Id } from "../types";

/**
 * The server-driven audit lists (plan Step 17, Phase 4b). A seam of their own, like
 * `../devices` and `../apps`: only the lazy Audit screen and the history panel of the detail
 * screens import `data/audit`. Sort key `at` only (newest first by default), no search and
 * no total (no exact counter): the pager shows Previous / Next and "Page N".
 */
export interface AuditApi {
  /** `audit:list`, one page. */
  useAuditScreen: (query: ListQuery) => ServerList<AuditEntry>;
  /** `audit:forTarget({ targetId })`, one page: one device, employee, app or group. */
  useHistory: (targetId: Id, query: ListQuery) => ServerList<AuditEntry>;
}
