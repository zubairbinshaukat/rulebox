import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { publishApp, snapshotAppGroups } from "./lib/appPublish";
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

/** `setMany` takes at most this many extensions in one call (the add dialog's chips are 1-5 each). */
const MAX_FILE_HANDLERS_PER_CALL = 20;

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
 * files. Same program again = no write. `too_large` at 200 rules. The groups that assign the programs get a configuration version (the first 10 in the call, the rest in batches).
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
    // Step 16b: file-type rules are ring-gated. One new configuration version for every group that assigns the program
    // (and the one that lost the extension); the first 10 groups at once, the rest by scheduled batches (Step 20b).
    await snapshotAppGroups(ctx, existing === null ? [app._id] : [existing.appId, app._id], `File type ${extension}`, ctx.member._id);
    if (existing !== null) await publishApp(ctx, ctx.orgId, existing.appId); // the program that lost the extension
    await publishApp(ctx, ctx.orgId, app._id);
    return null;
  },
});

/**
 * Set the program for several extensions at once (admin; UI pass other-pages plan 7.2: the "Pictures" chip is five extensions).
 * Same checks as `set` for EVERY extension (1-20, duplicates ignored; one refused extension refuses the whole call, nothing is
 * written) but ONE configuration version per group, one audit row and one publish per program, where a loop of `set` would make
 * up to 20 versions and flood the rollback list. Extensions that already open with this program are skipped; nothing to change =
 * no write. `too_large` when the new rules would pass 200.
 */
export const setMany = memberMutation("admin")({
  args: { extensions: v.array(v.string()), appId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.extensions.length < 1 || args.extensions.length > MAX_FILE_HANDLERS_PER_CALL) fail("invalid_argument", { field: "extensions" });
    const extensions = [...new Set(args.extensions.map(normalizeExtension))];
    for (const extension of extensions) {
      const problem = extensionProblem(extension);
      if (problem !== null) fail("invalid_argument", { field: "extension", detail: problem });
    }
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    if (!canOpenFiles(app)) fail("invalid_argument", { field: "app" });

    const toInsert: string[] = [];
    const toMove: Doc<"fileHandlers">[] = [];
    for (const extension of extensions) {
      const existing = await ctx.db
        .query("fileHandlers")
        .withIndex("by_org_ext", (q) => q.eq("orgId", ctx.orgId).eq("extension", extension))
        .first();
      if (existing === null) toInsert.push(extension);
      else if (existing.appId !== app._id) toMove.push(existing);
    }
    if (toInsert.length === 0 && toMove.length === 0) return null;
    if (toInsert.length > 0) {
      const all = await ctx.db
        .query("fileHandlers")
        .withIndex("by_org_ext", (q) => q.eq("orgId", ctx.orgId))
        .take(MAX_FILE_HANDLERS);
      if (all.length + toInsert.length > MAX_FILE_HANDLERS) fail("too_large", { detail: "file types" });
    }
    for (const extension of toInsert) await ctx.db.insert("fileHandlers", { orgId: ctx.orgId, extension, appId: app._id });
    for (const rule of toMove) await ctx.db.patch(rule._id, { appId: app._id });
    const changed = [...toInsert, ...toMove.map((r) => r.extension)].sort();
    const shown = changed.length > 6 ? `${changed.slice(0, 6).join(", ")} and ${changed.length - 6} more` : changed.join(", ");
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "fileHandler.set",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: `Files ending in ${shown} now open with ${app.name}`,
    });
    // One configuration version per group for the program and every program that lost an extension (as `set`, once for all).
    const lost = [...new Set(toMove.map((r) => r.appId))];
    await snapshotAppGroups(ctx, [...lost, app._id], `File types ${shown}`, ctx.member._id);
    for (const appId of lost) await publishApp(ctx, ctx.orgId, appId);
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
    await snapshotAppGroups(ctx, [handler.appId], `File type ${handler.extension} removed`, ctx.member._id);
    await publishApp(ctx, ctx.orgId, handler.appId);
    return null;
  },
});
