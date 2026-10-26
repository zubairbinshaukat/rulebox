import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { makeOrg } from "../tests/convex/identity";
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
});
