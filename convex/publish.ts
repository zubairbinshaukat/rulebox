import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Publish queue consumer (plan 4.4). STUB until Step 8: it only clears the
// organization's queue row. Step 8 replaces the body with the publisher
// (resolve targets, build, sign and write each device's document).

export const run = internalMutation({
  args: { orgId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("publishQueue")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (row !== null) await ctx.db.delete(row._id);
    return null;
  },
});
