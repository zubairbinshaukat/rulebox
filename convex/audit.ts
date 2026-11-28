import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { auditEntryOf, auditEntryValue } from "./lib/audit";
import { fail } from "./lib/errors";
import { memberQuery } from "./lib/functions";
import { checkPageSize, pickSort, sortArg } from "./lib/listing";
import { MAX_AUDIT_PAGE, MAX_AUDIT_TARGET_ID } from "./lib/limits";

// The audit log screens (plan Step 17 items 4-5, 4.11). Append-only rows are
// written by `lib/audit.ts` only; these queries read them newest first through
// the organization's own index ranges and return the shown fields only. The
// only `sort` key is "at" (time), either direction (lib/listing.ts); no search
// and no total (no exact counter). UI pass 2026-11: both take an optional `since` (a time in ms; rows at or after it), a
// `.gte("at", since)` on the same index (both indexes end in `at`), so the reads per page do not change and no index was added.

function checkPage(numItems: number): void {
  checkPageSize(numItems, MAX_AUDIT_PAGE);
}

/**
 * The organization's audit log, newest first (viewer, paginated by
 * `auditLog.by_org_at`). At most MAX_AUDIT_PAGE rows a page; one document read
 * per row. Re-runs only when a new row lands inside the loaded range.
 */
export const list = memberQuery("viewer")({
  args: { paginationOpts: paginationOptsValidator, sort: sortArg, since: v.optional(v.number()) },
  returns: paginationResultValidator(auditEntryValue),
  handler: async (ctx, args) => {
    checkPage(args.paginationOpts.numItems);
    const sort = pickSort("audit", args.sort);
    const since = args.since;
    const result = await ctx.db
      .query("auditLog")
      .withIndex("by_org_at", (q) => (since === undefined ? q.eq("orgId", ctx.orgId) : q.eq("orgId", ctx.orgId).gte("at", since)))
      .order(sort.dir)
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(auditEntryOf) };
  },
});

/**
 * The history of one device, employee, app or group (viewer, paginated by
 * `auditLog.by_org_target`): the rows whose target is `targetId`, newest first.
 * The range starts with the caller's organization, so another organization's
 * rows can never match, whatever id is asked for.
 */
export const forTarget = memberQuery("viewer")({
  args: { targetId: v.string(), paginationOpts: paginationOptsValidator, sort: sortArg, since: v.optional(v.number()) },
  returns: paginationResultValidator(auditEntryValue),
  handler: async (ctx, args) => {
    checkPage(args.paginationOpts.numItems);
    const sort = pickSort("audit", args.sort);
    if (args.targetId.length < 1 || args.targetId.length > MAX_AUDIT_TARGET_ID) fail("invalid_argument", { field: "targetId" });
    const since = args.since;
    const result = await ctx.db
      .query("auditLog")
      .withIndex("by_org_target", (q) => {
        const base = q.eq("orgId", ctx.orgId).eq("targetId", args.targetId);
        return since === undefined ? base : base.gte("at", since);
      })
      .order(sort.dir)
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(auditEntryOf) };
  },
});
