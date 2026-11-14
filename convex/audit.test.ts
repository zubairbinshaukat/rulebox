import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { probe } from "../tests/convex/devices";
import dashboardAuditLabels from "../apps/dashboard/src/lib/screenStrings/audit.ts?raw";
import { asMember, expectCode, expectNoSecrets, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { AUDIT_ACTIONS, auditPolicy, looksSecret, writeAudit } from "./lib/audit";
import { AUDIT_SUMMARY_MAX } from "./lib/limits";
import schema from "./schema";
import { modules } from "./test.setup";

const actor = { type: "member" as const, id: "m1", label: "owner@acme.test" };

describe("writeAudit", () => {
  beforeEach(() => {
    auditPolicy.strict = true;
  });
  afterEach(() => {
    auditPolicy.strict = false;
  });

  test("truncates the summary to 300 characters and stores eventKey", async () => {
    const t = convexTest(schema, modules);
    const orgId = await makeOrg(t);
    const row = await t.run(async (ctx) => {
      const id = await writeAudit(ctx, {
        orgId,
        actor,
        action: "group.created",
        summary: "Created group " + "x ".repeat(400),
        eventKey: "dev:abc:1",
      });
      return await ctx.db.get(id);
    });
    expect(row?.summary.length).toBe(AUDIT_SUMMARY_MAX);
    expect(row?.eventKey).toBe("dev:abc:1");
    expect(row?.actorType).toBe("member");
    expect(row?.actorLabel).toBe("owner@acme.test");
  });

  test("a summary containing $argon2 throws in tests", async () => {
    const t = convexTest(schema, modules);
    const orgId = await makeOrg(t);
    await expect(
      t.run((ctx) =>
        writeAudit(ctx, {
          orgId,
          actor,
          action: "org.exitPinSet",
          summary: "PIN set to $argon2id$v=19$m=19456,t=2,p=1$abc$def",
        }),
      ),
    ).rejects.toThrow(/secret/);
  });

  test("outside strict mode a suspicious summary is withheld, the row is kept", async () => {
    auditPolicy.strict = false;
    const t = convexTest(schema, modules);
    const orgId = await makeOrg(t);
    const row = await t.run(async (ctx) => {
      const id = await writeAudit(ctx, {
        orgId,
        actor,
        action: "member.invited",
        summary: "Invite code: 7K2M9QX4RZ0A8B6C5D3E1F",
      });
      return await ctx.db.get(id);
    });
    expect(row?.summary).toBe("(summary withheld)");
  });

  test("control characters are flattened", async () => {
    const t = convexTest(schema, modules);
    const orgId = await makeOrg(t);
    const row = await t.run(async (ctx) => {
      const id = await writeAudit(ctx, { orgId, actor, action: "group.renamed", summary: "Renamed\n\tgroup" });
      return await ctx.db.get(id);
    });
    expect(row?.summary).toBe("Renamed  group");
  });
});

describe("looksSecret", () => {
  test.each([
    ["$argon2id$v=19$m=19456", true],
    ["password: hunter2", true],
    ["token=abc", true],
    ["Invite code 7K2M9QX4RZ0A8B6C5D3E1F", true],
    ["a".repeat(10) + "0123456789abcdef0123456789abcdef", true],
    ["Password set for Jane Doe", false],
    ["Invited bob@acme.test as admin", false],
    ["Created group Front desk", false],
    ["Reset code created for ana@acme.test", false],
  ])("%s -> %s", (text, expected) => {
    expect(looksSecret(text)).toBe(expected);
  });

  test("the action list has no duplicates", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  test("every Phase 5 action has a label in the dashboard (apps/dashboard/src/lib/screenStrings/audit.ts)", () => {
    const phase5 = AUDIT_ACTIONS.slice(AUDIT_ACTIONS.indexOf("lockdown.settingsChanged"));
    expect(phase5.length).toBeGreaterThan(30);
    for (const action of phase5) expect(dashboardAuditLabels, `no label for ${action}`).toContain(`"${action}": "`);
  });
});

// ---------------------------------------------------------------- the screens' queries (plan Step 17 items 4-5)

const page = (numItems: number, cursor: string | null = null) => ({ paginationOpts: { numItems, cursor } });

/** `n` rows for the organization, `at` = base + i, target `targetId` when given. */
async function seedAudit(t: T, orgId: Id<"organizations">, n: number, opts: { targetId?: string; base?: number; label?: string } = {}) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await writeAudit(ctx, {
        orgId,
        actor,
        action: "group.renamed",
        targetType: opts.targetId === undefined ? undefined : "device",
        targetId: opts.targetId,
        targetLabel: opts.targetId === undefined ? undefined : "PC",
        summary: `${opts.label ?? "Row"} ${i}`,
        eventKey: `dev:x:${opts.label ?? "r"}${i}`,
        at: (opts.base ?? 1_000_000) + i,
      });
    }
  });
}

describe("audit:list", () => {
  test("newest first, pages of the asked size follow each other without gaps, and the last one says done", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await seedAudit(t, orgId, 7);
    const viewer = await asMember(t, { role: "viewer", orgId });

    const first = await viewer.as.query(api.audit.list, page(3));
    expect(first.page.map((r) => r.summary)).toEqual(["Row 6", "Row 5", "Row 4"]);
    expect(first.isDone).toBe(false);
    const second = await viewer.as.query(api.audit.list, page(3, first.continueCursor));
    expect(second.page.map((r) => r.summary)).toEqual(["Row 3", "Row 2", "Row 1"]);
    const third = await viewer.as.query(api.audit.list, page(3, second.continueCursor));
    expect(third.page.map((r) => r.summary)).toEqual(["Row 0"]);
    expect(third.isDone).toBe(true);
  });

  test("another organization's rows never appear, and the row carries the shown fields only", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const other = await makeOrg(t, "Other");
    await seedAudit(t, orgId, 2, { label: "Mine" });
    await seedAudit(t, other, 3, { label: "Theirs" });
    const viewer = await asMember(t, { role: "viewer", orgId });

    const r = await viewer.as.query(api.audit.list, page(50));
    expect(r.page.map((x) => x.summary)).toEqual(["Mine 1", "Mine 0"]);
    expect(Object.keys(r.page[0]!).sort()).toEqual(["_id", "action", "actorId", "actorLabel", "actorType", "at", "summary"]);
    const foreign = await asMember(t, { role: "viewer", orgId: other });
    expect((await foreign.as.query(api.audit.list, page(50))).page.map((x) => x.summary)).toEqual(["Theirs 2", "Theirs 1", "Theirs 0"]);
  });

  test("a summary that was withheld on write stays withheld; no event key, hash or secret is returned", async () => {
    auditPolicy.strict = false;
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await t.run((ctx) =>
      writeAudit(ctx, { orgId, actor, action: "member.invited", summary: "Invite code: 7K2M9QX4RZ0A8B6C5D3E1F", eventKey: "dev:abc:secret-key" }),
    );
    const viewer = await asMember(t, { role: "viewer", orgId });
    const r = await viewer.as.query(api.audit.list, page(10));
    expect(r.page[0]?.summary).toBe("(summary withheld)");
    expectNoSecrets(r);
    const text = JSON.stringify(r);
    expect(text).not.toContain("7K2M9QX4RZ0A8B6C5D3E1F");
    expect(text).not.toContain("eventKey");
    expect(text).not.toContain("dev:abc:secret-key");
  });

  test("page size is bounded; a page of 50 reads 50 audit rows plus the member wrapper", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await seedAudit(t, orgId, 60);
    const viewer = await asMember(t, { role: "viewer", orgId });
    await expectCode(viewer.as.query(api.audit.list, page(51)), "invalid_argument");
    await expectCode(viewer.as.query(api.audit.list, page(0)), "invalid_argument");
    const { result, io } = await probe(() => viewer.as.query(api.audit.list, page(50)));
    expect(result.page).toHaveLength(50);
    expect(io.reads).toBeLessThanOrEqual(50 + 6);
    expect(io.readBytes).toBeLessThanOrEqual(40_000);
  });
});

describe("audit:forTarget", () => {
  test("only the rows of that target, newest first, paginated; another organization's rows with the same id never match", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const other = await makeOrg(t, "Other");
    await seedAudit(t, orgId, 5, { targetId: "dev1", label: "Mine", base: 2_000_000 });
    await seedAudit(t, orgId, 2, { targetId: "dev2", label: "Elsewhere", base: 3_000_000 });
    await seedAudit(t, other, 4, { targetId: "dev1", label: "Theirs", base: 4_000_000 });
    const viewer = await asMember(t, { role: "viewer", orgId });

    const first = await viewer.as.query(api.audit.forTarget, { targetId: "dev1", ...page(2) });
    expect(first.page.map((r) => r.summary)).toEqual(["Mine 4", "Mine 3"]);
    expect(first.isDone).toBe(false);
    const rest = await viewer.as.query(api.audit.forTarget, { targetId: "dev1", ...page(10, first.continueCursor) });
    expect(rest.page.map((r) => r.summary)).toEqual(["Mine 2", "Mine 1", "Mine 0"]);
    expect(rest.isDone).toBe(true);
    // The other organization's member sees only their own rows for the same id.
    const foreign = await asMember(t, { role: "viewer", orgId: other });
    const theirs = await foreign.as.query(api.audit.forTarget, { targetId: "dev1", ...page(10) });
    expect(theirs.page.map((r) => r.summary)).toEqual(["Theirs 3", "Theirs 2", "Theirs 1", "Theirs 0"]);
    expectNoSecrets(theirs);
    expect(JSON.stringify(theirs)).not.toContain("Mine");
  });

  test("an unknown id answers an empty page; a missing or oversized id and a bad page size are refused", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const viewer = await asMember(t, { role: "viewer", orgId });
    const none = await viewer.as.query(api.audit.forTarget, { targetId: "nope", ...page(10) });
    expect(none).toMatchObject({ page: [], isDone: true });
    await expectCode(viewer.as.query(api.audit.forTarget, { targetId: "", ...page(10) }), "invalid_argument");
    await expectCode(viewer.as.query(api.audit.forTarget, { targetId: "x".repeat(65), ...page(10) }), "invalid_argument");
    await expectCode(viewer.as.query(api.audit.forTarget, { targetId: "dev1", ...page(51) }), "invalid_argument");
  });
});
