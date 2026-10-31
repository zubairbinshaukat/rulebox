import { describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { probe } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DENY_EXTENSIONS, extensionProblem, normalizeExtension } from "./lib/denyList";
import { MAX_FILE_HANDLERS, MINUTE_MS } from "./lib/limits";
import rustTypes from "../apps/staff-app/src-tauri/src/files/types.rs?raw";
import dashboardValidate from "../apps/dashboard/src/lib/validate.ts?raw";

// File types (plan Step 10 item 7; PRD 7.3). Only these rules decide what opens
// a file, and an executable or script can never get one.

describe("deny-list", () => {
  /** The quoted extensions between the match of `open` and the next `close`. */
  function listIn(text: string, open: RegExp, close: string): string[] {
    const m = open.exec(text);
    expect(m, "list not found").not.toBeNull();
    const from = m!.index + m![0].length;
    return [...text.slice(from, text.indexOf(close, from)).matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  }
  test("the same list as the Staff App's `DENY` and the dashboard's mirror", () => {
    const rust = listIn(rustTypes, /pub const DENY: &\[&str\] = &\[/, "];");
    expect(rust.length).toBeGreaterThan(100);
    expect([...DENY_EXTENSIONS].sort()).toEqual([...rust].sort());
    const client = listIn(dashboardValidate, /DENY_EXTENSIONS: ReadonlySet<string> = new Set\(\[/, "]);");
    expect([...DENY_EXTENSIONS].sort()).toEqual([...client].sort());
  });

  test("executables, scripts, installers, shortcuts and macros are refused; documents are not", () => {
    for (const ext of ["exe", "bat", "cmd", "ps1", "vbs", "js", "msi", "lnk", "url", "scr", "com", "dll", "reg", "hta", "jar", "py", "sh", "docm", "xlsm", "html", "svg", "iso"]) {
      expect(extensionProblem(`.${ext}`), ext).toBe("denied");
    }
    for (const ext of ["pdf", "docx", "xlsx", "txt", "csv", "png", "jpg", "mp3", "mp4", "pptx"]) {
      expect(extensionProblem(`.${ext}`), ext).toBeNull();
    }
  });

  test("normalizing and the shape: .{1,10} of lower-case letters and digits", () => {
    expect(normalizeExtension(" PDF ")).toBe(".pdf");
    expect(normalizeExtension(".Docx")).toBe(".docx");
    expect(extensionProblem(normalizeExtension("EXE"))).toBe("denied"); // case cannot dodge the list
    expect(extensionProblem(normalizeExtension("..exe"))).toBe("format");
    for (const bad of ["", ".", "..", ".a.b", ".a b", ".a/b", ".a\\b", ".a-b", ".abcdefghijk", "pdf.", "pd\u0000f"]) {
      expect(extensionProblem(bad === "" ? bad : normalizeExtension(bad)), JSON.stringify(bad)).not.toBeNull();
    }
    expect(extensionProblem(".abcdefghij")).toBeNull(); // 10 characters
    expect(extensionProblem(".7z")).toBeNull();
  });
});

const program = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  desktop: {
    source: "preinstalled" as const,
    exe: `{ProgramFiles}\\${name}\\${name}.exe`,
    args: [],
    fileArgTemplate: ["{file}"],
    resetFolders: [],
    ...over,
  },
});

async function admin(t: T, orgId: Id<"organizations">, stepUp: "fresh" | "stale" = "fresh") {
  const m = await asMember(t, { role: "admin", mfa: true, orgId });
  if (stepUp === "fresh") await giveStepUp(t, m);
  else await giveStepUp(t, m, { verifiedAgoMs: 6 * MINUTE_MS, activeAgoMs: 0 });
  return m;
}

async function rules(t: T, orgId: Id<"organizations">) {
  return (await t.run((ctx) => ctx.db.query("fileHandlers").withIndex("by_org_ext", (q) => q.eq("orgId", orgId)).take(300))).map((r) => [r.extension, r.appId]);
}

describe("fileHandlers", () => {
  test("set adds a rule, moves an extension to another program, and the same program again writes nothing", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const reader = await a.as.mutation(api.apps.createDesktop, program("Reader"));
    const viewer = await a.as.mutation(api.apps.createDesktop, program("Viewer"));
    await a.as.mutation(api.fileHandlers.set, { extension: "PDF", appId: reader });
    expect(await rules(t, orgId)).toEqual([[".pdf", reader]]);
    const same = await probe(() => a.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId: reader }));
    expect(same.io.writes).toBe(0);
    await a.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId: viewer });
    expect(await rules(t, orgId)).toEqual([[".pdf", viewer]]); // one rule per extension
    const log = (await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(50))).map((r) => r.action);
    expect(log.filter((x) => x === "fileHandler.set")).toHaveLength(2);
  });

  test("a denied or malformed extension is refused with the reason; nothing is written", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const reader = await a.as.mutation(api.apps.createDesktop, program("Reader"));
    const reason = async (extension: string) => {
      try {
        await a.as.mutation(api.fileHandlers.set, { extension, appId: reader });
      } catch (e) {
        return (e as { data: { code: string; field?: string; detail?: string } }).data;
      }
      return null;
    };
    for (const ext of ["exe", ".BAT", " .ps1", "msi", "lnk", "js", "vbs"]) {
      expect(await reason(ext), ext).toEqual({ code: "invalid_argument", field: "extension", detail: "denied" });
    }
    for (const ext of ["", ".", ".a.b", ".a b", "x".repeat(11)]) {
      expect(await reason(ext), ext).toEqual({ code: "invalid_argument", field: "extension", detail: "format" });
    }
    expect(await rules(t, orgId)).toEqual([]);
  });

  test("the program must be a non-archived desktop app with a file argument", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const noFiles = await a.as.mutation(api.apps.createDesktop, program("Calc", { fileArgTemplate: [] }));
    const site = await a.as.mutation(api.apps.createWeb, { name: "Wiki", url: "https://wiki.example.com", allowedDomains: [] });
    const archived = await a.as.mutation(api.apps.createDesktop, program("Old"));
    await a.as.mutation(api.apps.setArchived, { appId: archived, archived: true });
    for (const appId of [noFiles, site, archived]) {
      await expectCode(a.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId }), "invalid_argument");
    }
    const list = await a.as.query(api.fileHandlers.list, {});
    expect(list.appOptions).toEqual([]); // none of the three can open files
    const ok = await a.as.mutation(api.apps.createDesktop, program("Reader"));
    expect((await a.as.query(api.fileHandlers.list, {})).appOptions).toEqual([{ _id: ok, name: "Reader", kind: "desktop", canOpenFiles: true }]);
  });

  test("list is ordered by extension and names the program, also an archived one (its rule waits)", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const reader = await a.as.mutation(api.apps.createDesktop, program("Reader"));
    const viewer = await a.as.mutation(api.apps.createDesktop, program("Viewer"));
    await a.as.mutation(api.fileHandlers.set, { extension: ".txt", appId: viewer });
    await a.as.mutation(api.fileHandlers.set, { extension: ".docx", appId: reader });
    await a.as.mutation(api.apps.setArchived, { appId: viewer, archived: true });
    const list = await a.as.query(api.fileHandlers.list, {});
    expect(list.rows.map((r) => [r.extension, r.appName])).toEqual([
      [".docx", "Reader"],
      [".txt", "Viewer"],
    ]);
  });

  test("at most 200 rules per organization", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const reader = await a.as.mutation(api.apps.createDesktop, program("Reader"));
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_FILE_HANDLERS; i++) await ctx.db.insert("fileHandlers", { orgId, extension: `.x${String(i).padStart(3, "0")}`, appId: reader });
    });
    await expectCode(a.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId: reader }), "too_large");
    // moving an existing extension is not a new rule
    await a.as.mutation(api.fileHandlers.set, { extension: ".x000", appId: reader });
    const list = await probe(() => a.as.query(api.fileHandlers.list, {}));
    expect(list.result.rows).toHaveLength(MAX_FILE_HANDLERS);
    expect(list.io.reads).toBeLessThanOrEqual(3 + MAX_FILE_HANDLERS + 1 + 500 + 10);
  });

  test("viewers read but cannot write; remove needs a fresh step-up; other organizations see nothing", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const reader = await a.as.mutation(api.apps.createDesktop, program("Reader"));
    await a.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId: reader });
    const handlerId = (await t.run((ctx) => ctx.db.query("fileHandlers").withIndex("by_org_ext", (q) => q.eq("orgId", orgId)).first()))!._id;

    const v = await asMember(t, { role: "viewer", mfa: true, orgId });
    await giveStepUp(t, v);
    expect((await v.as.query(api.fileHandlers.list, {})).rows).toHaveLength(1);
    await expectCode(v.as.mutation(api.fileHandlers.set, { extension: ".txt", appId: reader }), "forbidden");
    await expectCode(v.as.mutation(api.fileHandlers.remove, { handlerId }), "forbidden");

    const stale = await admin(t, orgId, "stale");
    await expectCode(stale.as.mutation(api.fileHandlers.remove, { handlerId }), "step_up_required");
    await stale.as.mutation(api.fileHandlers.set, { extension: ".txt", appId: reader }); // set is an ordinary write

    const other = await admin(t, await makeOrg(t, "Other"));
    expect((await other.as.query(api.fileHandlers.list, {})).rows).toEqual([]);
    await expectCode(other.as.mutation(api.fileHandlers.remove, { handlerId }), "not_found");
    await a.as.mutation(api.fileHandlers.remove, { handlerId });
    expect(await rules(t, orgId)).toEqual([[".txt", reader]]);
  });
});
