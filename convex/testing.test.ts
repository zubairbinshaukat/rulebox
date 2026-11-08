/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { TEST_KEY } from "../tests/convex/keys";
import { asMember, expectCode, makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SYSTEM_ACTOR, writeAudit } from "./lib/audit";
import { codeHash } from "./lib/crypto";
import * as testing from "./testing";
import source from "./testing.ts?raw";

declare const process: { env: Record<string, string | undefined> };

const PIN = "482913";

beforeEach(() => {
  process.env.RULEBOX_ALLOW_TEST_SEED = "1";
});
afterEach(() => {
  delete process.env.RULEBOX_ALLOW_TEST_SEED;
  vi.useRealTimers();
});

type Kind = "mutation" | "action";

/** One call per export of testing.ts, with arguments that pass validation. */
function calls(orgId: Id<"organizations">): Record<string, { kind: Kind; run: (t: T) => Promise<unknown> }> {
  return {
    seedE2E: { kind: "action", run: (t) => t.action(internal.testing.seedE2E, { runId: "guard" }) },
    registerSeedKey: { kind: "mutation", run: (t) => t.mutation(internal.testing.registerSeedKey, { orgId }) },
    setKnownPin: { kind: "action", run: (t) => t.action(internal.testing.setKnownPin, { orgId, email: "a@acme.test", pin: PIN }) },
    storeKnownPin: {
      kind: "mutation",
      run: (t) => t.mutation(internal.testing.storeKnownPin, { orgId, email: "a@acme.test", hash: "$argon2id$x" }),
    },
    seedDevice: { kind: "mutation", run: (t) => t.mutation(internal.testing.seedDevice, { orgId, secret: "x".repeat(20) }) },
    seedFleet: { kind: "mutation", run: (t) => t.mutation(internal.testing.seedFleet, { count: 1 }) },
    simulateEdit: { kind: "mutation", run: (t) => t.mutation(internal.testing.simulateEdit, { orgId }) },
    deleteOrg: { kind: "mutation", run: (t) => t.mutation(internal.testing.deleteOrg, { orgId }) },
  };
}

describe("testing.ts guard", () => {
  test("every export refuses with forbidden unless RULEBOX_ALLOW_TEST_SEED is 1", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "E2E guard");
    const table = calls(orgId);
    // The table covers every export: a new function without a guard test fails here.
    expect(Object.keys(table).sort()).toEqual(Object.keys(testing).sort());

    for (const value of [undefined, "0", "true", "yes"]) {
      if (value === undefined) delete process.env.RULEBOX_ALLOW_TEST_SEED;
      else process.env.RULEBOX_ALLOW_TEST_SEED = value;
      for (const [name, call] of Object.entries(table)) {
        await expectCode(call.run(t), "forbidden").catch((e: unknown) => {
          throw new Error(`${name} with RULEBOX_ALLOW_TEST_SEED=${String(value)}: ${String(e)}`);
        });
      }
    }
    // Nothing was written by the refused calls.
    const rows = await t.run(async (ctx) => ({
      orgs: await ctx.db.query("organizations").collect(),
      devices: await ctx.db.query("devices").collect(),
    }));
    expect(rows.orgs.map((o) => o.name)).toEqual(["E2E guard"]);
    expect(rows.devices).toHaveLength(0);
  });

  test("every handler starts with the allowTestSeed() call", () => {
    const handlers = source.split("handler: async").slice(1);
    const exports = source.match(/^export const \w+ = internal(Mutation|Action)\(/gm) ?? [];
    expect(handlers.length).toBe(exports.length);
    expect(handlers.length).toBeGreaterThanOrEqual(8);
    for (const chunk of handlers) {
      const body = /=>\s*\{\s*(\S+)/.exec(chunk);
      expect(body?.[1]).toBe("allowTestSeed();");
    }
  });

  test("the functions are internal, not public", () => {
    for (const name of Object.keys(testing)) {
      expect((testing as unknown as Record<string, { isInternal?: boolean }>)[name]!.isInternal, name).toBe(true);
    }
  });

  test("an organization that is not a test organization is refused", async () => {
    const t = await setupAuth();
    const real = await makeOrg(t, "Acme");
    for (const name of ["registerSeedKey", "storeKnownPin", "seedDevice", "simulateEdit", "deleteOrg"]) {
      await expectCode(calls(real)[name]!.run(t), "forbidden");
    }
    await expectCode(calls(real).setKnownPin!.run(t), "forbidden");
    expect(await t.run((ctx) => ctx.db.get(real))).not.toBeNull();
  });
});

describe("seedE2E and setKnownPin", () => {
  test("creates the E2E org with an owner invite and the signing key", async () => {
    const t = await setupAuth();
    const r = await t.action(internal.testing.seedE2E, { runId: "Run-1" });
    expect(r.orgName).toBe("E2E Run-1");
    expect(r.ownerEmail).toBe("e2e-run-1@example.test");
    expect(r.keyId).toBe(TEST_KEY.keyId);
    const rows = await t.run(async (ctx) => ({
      org: await ctx.db.get(r.orgId),
      invite: await ctx.db
        .query("invites")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", codeHash(r.inviteCode)))
        .unique(),
      keys: await ctx.db.query("policyKeys").withIndex("by_org_status", (q) => q.eq("orgId", r.orgId).eq("status", "active")).collect(),
    }));
    expect(rows.org?.name).toBe("E2E Run-1");
    expect(rows.invite).toMatchObject({ orgId: r.orgId, role: "owner", email: r.ownerEmail });
    expect(rows.keys).toHaveLength(1);
    // A second run is a second organization, not a conflict.
    const again = await t.action(internal.testing.seedE2E, { runId: "run-2", ownerEmail: "o@example.test" });
    expect(again.orgId).not.toBe(r.orgId);
  });

  test("a run id with odd characters is refused", async () => {
    const t = await setupAuth();
    await expectCode(t.action(internal.testing.seedE2E, { runId: "a b" }), "invalid_argument");
    await expectCode(t.action(internal.testing.seedE2E, { runId: "" }), "invalid_argument");
  });

  test("setKnownPin sets a PIN the member can unlock with", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "E2E pin");
    const m = await asMember(t, { role: "owner", orgId, email: "owner@acme.test" });
    await t.action(internal.testing.setKnownPin, { orgId, email: "Owner@Acme.test", pin: PIN });
    await expectCode(m.as.action(api.stepUp.verifyActionPin, { pin: "135790" }), "step_up_invalid");
    const ok = await m.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect(ok.freshUntil).toBeGreaterThan(ok.verifiedAt);
    // Changing it again replaces the old one.
    await t.action(internal.testing.setKnownPin, { orgId, email: "owner@acme.test", pin: "975310" });
    await expectCode(m.as.action(api.stepUp.verifyActionPin, { pin: PIN }), "step_up_invalid");
  });

  test("setKnownPin refuses a weak PIN and an unknown member", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "E2E pin2");
    await asMember(t, { role: "owner", orgId, email: "owner@acme.test" });
    await expectCode(t.action(internal.testing.setKnownPin, { orgId, email: "owner@acme.test", pin: "123456" }), "invalid_argument");
    await expectCode(t.action(internal.testing.setKnownPin, { orgId, email: "nobody@acme.test", pin: PIN }), "not_found");
  });
});

describe("seedDevice, seedFleet, simulateEdit", () => {
  test("seedDevice makes a device that authenticates with its known secret", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "E2E dev");
    const secret = "known-device-secret-01";
    const { deviceId } = await t.mutation(internal.testing.seedDevice, { orgId, secret, name: "PC A" });
    const ping = await t.mutation(api.devices.ping, { deviceId, deviceSecret: secret });
    expect(ping.nextPingInMs).toBeGreaterThan(0);
    await expectCode(
      t.mutation(api.devices.ping, { deviceId, deviceSecret: "wrong-device-secret-01" }),
      "device_rejected",
    );
    const stats = await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    expect(stats).toMatchObject({ deviceCount: 1, noGroupDeviceCount: 1 });
    await expectCode(t.mutation(internal.testing.seedDevice, { orgId, secret }), "conflict");
    await expectCode(t.mutation(internal.testing.seedDevice, { orgId, secret: "short" }), "invalid_argument");
  });

  test("seedDevice puts a device in a group of the same org only", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "E2E grp");
    const other = await makeOrg(t, "E2E other");
    const [g, foreign] = await t.run(async (ctx) => [
      await ctx.db.insert("groups", { orgId, name: "Front", revision: 0, createdAt: 1 }),
      await ctx.db.insert("groups", { orgId: other, name: "Back", revision: 0, createdAt: 1 }),
    ]);
    const { deviceId } = await t.mutation(internal.testing.seedDevice, { orgId, secret: "group-device-secret-01", groupId: g });
    expect((await t.run((ctx) => ctx.db.get(deviceId)))?.groupId).toBe(g);
    await expectCode(
      t.mutation(internal.testing.seedDevice, { orgId, secret: "group-device-secret-02", groupId: foreign }),
      "not_found",
    );
  });

  test("seedFleet makes a separate Load test org with known secrets", async () => {
    const t = await setupAuth();
    const r = await t.mutation(internal.testing.seedFleet, { count: 5, runId: "lt1" });
    expect(r.devices).toHaveLength(5);
    expect(r.keyId).toBe(TEST_KEY.keyId);
    const org = await t.run((ctx) => ctx.db.get(r.orgId));
    expect(org?.name).toBe("Load test lt1");
    const stats = await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", r.orgId)).unique());
    expect(stats?.deviceCount).toBe(5);
    const first = r.devices[0]!;
    expect(first.secret).toBe(`fleet-${r.orgId}-1`);
    const ping = await t.mutation(api.devices.ping, { deviceId: first.deviceId, deviceSecret: first.secret });
    expect(ping.nextPingInMs).toBeGreaterThan(0);
    await expectCode(t.mutation(internal.testing.seedFleet, { count: 0 }), "invalid_argument");
    await expectCode(t.mutation(internal.testing.seedFleet, { count: 201 }), "invalid_argument");
    await expectCode(t.mutation(internal.testing.seedFleet, { count: 1, runId: "bad id" }), "invalid_argument");
  });

  test("simulateEdit flips offlineDays and bumps the revision", async () => {
    const t = await setupAuth();
    const { orgId } = await t.mutation(internal.testing.seedFleet, { count: 1 });
    const a = await t.mutation(internal.testing.simulateEdit, { orgId });
    const b = await t.mutation(internal.testing.simulateEdit, { orgId });
    expect(a.offlineDays).not.toBe(b.offlineDays);
    expect(b.revision).toBe(a.revision + 1);
    expect((await t.run((ctx) => ctx.db.get(orgId)))?.revision).toBe(b.revision);
  });
});

describe("deleteOrg", () => {
  test("removes the org and everything under it in bounded batches, and leaves other orgs alone", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const keep = await makeOrg(t, "E2E keep");
    const keeper = await asMember(t, { role: "owner", orgId: keep, email: "keep@acme.test" });
    await t.mutation(internal.testing.seedDevice, { orgId: keep, secret: "keep-device-secret-01" });

    const fleet = await t.mutation(internal.testing.seedFleet, { count: 100, runId: "del" });
    const member = await asMember(t, { role: "owner", orgId: fleet.orgId, email: "del@acme.test" });
    await t.run(async (ctx) => {
      await ctx.db.insert("stepUpFactors", { userId: member.userId, pinFailures: 0, pinFailuresTotal: 0, pinLockedUntil: 0 });
      await writeAudit(ctx, { orgId: fleet.orgId, actor: SYSTEM_ACTOR, action: "org.settingsChanged", summary: "x" });
    });

    let runs = 0;
    let deleted = 0;
    for (;;) {
      const r = await t.mutation(internal.testing.deleteOrg, { orgId: fleet.orgId });
      runs++;
      deleted += r.deleted;
      expect(r.deleted).toBeLessThanOrEqual(401);
      if (r.done) break;
      expect(runs).toBeLessThan(50);
    }
    // 100 devices with ~6 rows each cannot fit one 400-row batch.
    expect(runs).toBeGreaterThan(1);
    expect(deleted).toBeGreaterThan(600);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const left = await t.run(async (ctx) => {
      const byOrg = (table: "devices" | "deviceCredentials" | "deviceLiveness" | "deviceSummary" | "deviceReports" | "orgStats" | "orgPlans" | "orgSecrets" | "groups" | "members" | "auditLog" | "enrollmentTokens" | "policyKeys" | "orgPresence") =>
        ctx.db.query(table).filter((q) => q.eq(q.field("orgId"), fleet.orgId)).collect();
      return {
        org: await ctx.db.get(fleet.orgId),
        user: await ctx.db.get(member.userId),
        factor: await ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", member.userId)).first(),
        rows: await Promise.all(
          (["devices", "deviceCredentials", "deviceLiveness", "deviceSummary", "deviceReports", "orgStats", "orgPlans", "orgSecrets", "groups", "members", "auditLog", "enrollmentTokens", "policyKeys", "orgPresence"] as const).map(
            async (table) => [table, (await byOrg(table)).length] as const,
          ),
        ),
      };
    });
    expect(left.org).toBeNull();
    expect(left.user).toBeNull();
    expect(left.factor).toBeNull();
    for (const [table, n] of left.rows) expect(n, table).toBe(0);

    // The other test org is untouched.
    const kept = await t.run(async (ctx) => ({
      org: await ctx.db.get(keep),
      devices: await ctx.db.query("devices").withIndex("by_org", (q) => q.eq("orgId", keep)).collect(),
      user: await ctx.db.get(keeper.userId),
    }));
    expect(kept.org).not.toBeNull();
    expect(kept.devices).toHaveLength(1);
    expect(kept.user).not.toBeNull();

    // Deleting again is a no-op.
    expect(await t.mutation(internal.testing.deleteOrg, { orgId: fleet.orgId })).toEqual({ done: true, deleted: 0 });
  }, 60_000);
});
