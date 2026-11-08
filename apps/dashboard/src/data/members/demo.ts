/**
 * Demo members lists (`VITE_DEMO=1`): the contract of `members:page` / `members:invitesPage` (convex/members.ts):
 * contains-search on the email, the sort keys of the table, offset cursors and the exact `total` inside the page.
 */
import type { DemoDb, DbInvite } from "../fixtures/seed";
import { byKey, contains, useDemoServerPage } from "../demo/lists";
import { currentMember, fail } from "../demo/store";
import type { InviteRow, MemberRow, Role } from "../types";
import type { MembersApi } from "./api";

const ROLE_RANK: Record<Role, number> = { owner: 0, admin: 1, viewer: 2 };
const DAY = 24 * 60 * 60_000;

function requireReader() {
  const me = currentMember();
  if (!me) fail("unauthenticated");
  if (me.status === "disabled") fail("forbidden");
  return me;
}

function memberRows(db: DemoDb, me: { _id: string; role: Role }): MemberRow[] {
  return db.members.map((m) => ({
    _id: m._id,
    email: m.email,
    role: m._id === me._id ? me.role : m.role,
    status: m.status,
    createdAt: m.createdAt,
    isYou: m._id === me._id,
    revision: m.revision,
  }));
}

/** `createdAt` of an invite made before the field existed: a week before it expires. */
const createdOf = (i: DbInvite) => i.createdAt ?? i.expiresAt - 7 * DAY;

export const demoMembersApi: MembersApi = {
  useMembersPage(query) {
    return useDemoServerPage<MemberRow>(
      "members:page",
      "",
      query,
      (db, sort, search) => {
        const me = requireReader();
        const key = sort?.key ?? "email";
        const get = (m: MemberRow): string | number =>
          key === "role" ? ROLE_RANK[m.role] : key === "status" ? m.status : key === "created" ? m.createdAt : m.email;
        return memberRows(db, me)
          .filter((m) => !search || contains(search, m.email))
          .sort(byKey(get, sort?.dir ?? "asc"));
      },
      "o",
    );
  },

  useInvitesPage(nowMinute, query) {
    return useDemoServerPage<InviteRow>(
      "members:invitesPage",
      // Not part of the key: the minute moving must not drop the rows on screen (the heartbeat recomputes anyway).
      "",
      query,
      (db, sort, search) => {
        requireReader();
        const key = sort?.key ?? "created";
        const get = (i: InviteRow): string | number => (key === "email" ? i.email : key === "expires" ? i.expiresAt : i.createdAt);
        return db.invites
          .filter((i) => i.usedAt === undefined && i.expiresAt > nowMinute && (!search || contains(search, i.email)))
          .map((i): InviteRow => ({ _id: i._id, email: i.email, role: i.role, kind: i.kind, expiresAt: i.expiresAt, createdAt: createdOf(i) }))
          .sort(byKey(get, sort?.dir ?? "desc"));
      },
      "o",
    );
  },
};

/** Resolved through the `@rulebox/members-impl` alias in demo builds. */
export const membersApi = demoMembersApi;
