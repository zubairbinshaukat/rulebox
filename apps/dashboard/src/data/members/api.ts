import type { ListQuery, ServerList } from "../serverList";
import type { InviteRow, MemberRow } from "../types";

/**
 * The server-driven members lists (Phase 4b). A seam of their own, like `../apps`: only
 * Settings, Members imports `data/members`. Both are small bounded tables: the server sorts,
 * searches and pages the bounded read, with offset cursors (`o:<n>`) and the exact `total`
 * inside the page.
 */
export interface MembersApi {
  /** `members:page`: sort keys `email` (default), `role`, `status`, `created`; the search is a contains match on the email. */
  useMembersPage: (query: ListQuery) => ServerList<MemberRow>;
  /**
   * `members:invitesPage`: pending invites and reset codes only (`nowMinute` = the client's clock rounded down to the
   * minute, like `enrollmentCodes:list`). Sort keys `created` (default, newest first), `email`, `expires`; contains-search on the email.
   */
  useInvitesPage: (nowMinute: number, query: ListQuery) => ServerList<InviteRow>;
}
