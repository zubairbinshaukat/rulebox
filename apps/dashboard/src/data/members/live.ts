/**
 * Live members lists (Phase 4b; `convex/members.ts`). One page per subscription
 * (`useServerPage`); the totals come inside the page (bounded tables).
 */
import { api } from "@convex/_generated/api";
import { useServerPage } from "../live/serverList";
import { listArgs } from "../serverList";
import type { InviteRow, MemberRow } from "../types";
import type { MembersApi } from "./api";

export const liveMembersApi: MembersApi = {
  useMembersPage(query) {
    return useServerPage<MemberRow>(api.members.page, listArgs(query), "members");
  },
  useInvitesPage(nowMinute, query) {
    return useServerPage<InviteRow>(api.members.invitesPage, { nowMs: nowMinute, ...listArgs(query) }, "invites");
  },
};

/** Resolved through the `@rulebox/members-impl` alias in live builds. */
export const membersApi = liveMembersApi;
