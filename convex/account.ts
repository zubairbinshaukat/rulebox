import { doc } from "convex-helpers/validators";
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { requireMember } from "./lib/authz";
import { role } from "./lib/validators";
import schema from "./schema";

/**
 * The member check for `memberAction` (actions have no `db`). Same rules as
 * the query and mutation wrappers; the caller's identity travels with
 * `ctx.runQuery`.
 */
export const authorize = internalQuery({
  args: {
    minRole: role,
    skipMfa: v.boolean(),
    orgId: v.optional(v.id("organizations")),
  },
  returns: v.object({
    member: doc(schema, "members"),
    orgId: v.id("organizations"),
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
  }),
  handler: async (ctx, args) => {
    return await requireMember(ctx, args.minRole, {
      skipMfa: args.skipMfa ? true : undefined,
      orgId: args.orgId,
    });
  },
});
