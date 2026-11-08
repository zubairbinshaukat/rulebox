import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { publishApp } from "./lib/appPublish";
import { writeAudit } from "./lib/audit";
import { getInOrg } from "./lib/authz";
import { extensionProblem, normalizeExtension, programDenied } from "./lib/denyList";
import { fail } from "./lib/errors";
import { memberMutation, memberQuery } from "./lib/functions";
import { boundedPageValidator, byField, checkPageSize, cleanSearch, matches, pageInMemory, pickSort, sortArg } from "./lib/listing";
import { MAX_FILE_HANDLERS } from "./lib/limits";

// File types (plan Step 10 item 7; PRD 7.3). A rule says "files ending in
// .xyz open with this program". Only these rules decide what opens a file:
// never Windows' file associations, and never an executable or a script (the
// deny-list in `lib/denyList.ts` is copied from the Staff App, which refuses
// them again). Each device's document keeps a rule only when its app is in
// that device's catalogue (`lib/desired.ts`).

/**
 * Can this app be the target of a rule? A non-archived program with a file
 * argument that is not a shell, script host or runtime (`DENY_PROGRAMS`: a
 * `.txt` rule must never run the file as a script; checked here again for apps
 * saved before the list grew).
 */
function canOpenFiles(app: Doc<"apps">): boolean {
  return app.kind === "desktop" && !app.archived && (app.desktop?.fileArgTemplate.length ?? 0) > 0 && !programDenied(app.desktop?.exe ?? "");
}

/**
 * One page of the file-type rules for the file types table (viewer; list
 * contract in lib/listing.ts). A SMALL bounded table (<= MAX_FILE_HANDLERS
 * rules, `fileHandlers.by_org_ext`): searched (extension or program name
 * contains, case-insensitive), sorted ("extension" A-Z by default, or "app" =
 * program name) and paged in the query, with the exact `total`. The program
 * picker is `apps:options` (its `canOpenFiles` is the same rule), subscribed
 * only while the "add rule" dialog is open.
 */
export const page = memberQuery("viewer")({
  args: { paginationOpts: paginationOptsValidator, search: v.optional(v.string()), sort: sortArg },
  returns: boundedPageValidator(v.object({ _id: v.id("fileHandlers"), extension: v.string(), appId: v.id("apps"), appName: v.string() })),
  handler: async (ctx, args) => {
    checkPageSize(args.paginationOpts.numItems);
    const sort = pickSort("fileTypes", args.sort);
    const search = cleanSearch(args.search);
    const handlers = await ctx.db
      .query("fileHandlers")
      .withIndex("by_org_ext", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_FILE_HANDLERS + 1);
    // Program names: one get per distinct app (rules point at a handful of programs).
    const names = new Map<string, string>();
    const rows = [];
    for (const h of handlers) {
      if (!names.has(h.appId)) names.set(h.appId, (await ctx.db.get(h.appId))?.name ?? "");
      rows.push({ _id: h._id, extension: h.extension, appId: h.appId, appName: names.get(h.appId) ?? "" });
    }
    const kept = rows
      .filter((r) => matches(search, r.extension, r.appName))
      // Ties on the program are broken by extension (unique per organization).
      .sort(byField((r) => (sort.key === "app" ? `${r.appName}\u0000${r.extension}` : r.extension), sort.dir));
    return pageInMemory(kept, args.paginationOpts);
  },
});

/**
 * Set the program for an extension (admin; unlocked session): adds the rule or
 * moves it to another program. `invalid_argument` field "extension" with detail
 * "format" (not `.` and 1-10 letters or digits) or "denied" (executables,
 * scripts, installers...: PRD 7.3); field "app" when the program cannot open
 * files. Same program again = no write. `too_large` at 200 rules.
 */
export const set = memberMutation("admin")({
  args: { extension: v.string(), appId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const extension = normalizeExtension(args.extension);
    const problem = extensionProblem(extension);
    if (problem !== null) fail("invalid_argument", { field: "extension", detail: problem });
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    if (!canOpenFiles(app)) fail("invalid_argument", { field: "app" });

    const existing = await ctx.db
      .query("fileHandlers")
      .withIndex("by_org_ext", (q) => q.eq("orgId", ctx.orgId).eq("extension", extension))
      .first();
    if (existing !== null && existing.appId === app._id) return null;
    if (existing === null) {
      const all = await ctx.db
        .query("fileHandlers")
        .withIndex("by_org_ext", (q) => q.eq("orgId", ctx.orgId))
        .take(MAX_FILE_HANDLERS);
      if (all.length >= MAX_FILE_HANDLERS) fail("too_large", { detail: "file types" });
      await ctx.db.insert("fileHandlers", { orgId: ctx.orgId, extension, appId: app._id });
    } else {
      await ctx.db.patch(existing._id, { appId: app._id });
      await publishApp(ctx, ctx.orgId, existing.appId); // the program that lost the extension
    }
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "fileHandler.set",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: `Files ending in ${extension} now open with ${app.name}`,
    });
    await publishApp(ctx, ctx.orgId, app._id);
    return null;
  },
});

/** Remove a rule (admin, major: fresh step-up). The extension then opens with nothing from Rulebox. */
export const remove = memberMutation("admin", { major: "fileHandlers:remove" })({
  args: { handlerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const handler = await getInOrg(ctx, "fileHandlers", args.handlerId, ctx.orgId);
    await ctx.db.delete(handler._id);
    const app = await ctx.db.get(handler.appId);
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "fileHandler.removed",
      targetType: "app",
      targetId: handler.appId,
      targetLabel: app?.name,
      summary: `Files ending in ${handler.extension} no longer open from Rulebox`,
    });
    await publishApp(ctx, ctx.orgId, handler.appId);
    return null;
  },
});
