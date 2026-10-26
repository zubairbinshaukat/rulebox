import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256HexSync } from "./lib/crypto";
import { checkDevice, settleRotation } from "./lib/deviceAuth";
import schema from "./schema";
import { modules } from "./test.setup";

// The Phase 2 wire contract (plan 5.1): names, arguments and answers of
// enrollment:enroll, devices:desiredState, devices:heartbeat and
// devices:unenroll are unchanged by the move onto the wrappers.

const SECRET = "device-secret-0123456789";
const TOKEN = "ABCDEFGHJKMNPQRSTVWX";

async function seed(t: T) {
  const orgId = await makeOrg(t);
  const tokenId = await t.run((ctx) =>
    ctx.db.insert("enrollmentTokens", {
      orgId,
      tokenHash: sha256HexSync(TOKEN),
      expiresAt: Date.now() + 3_600_000,
      usesLeft: 1,
      createdAt: Date.now(),
    }),
  );
  return { orgId, tokenId };
}

const enrollArgs = {
  token: TOKEN,
  deviceSecretHash: sha256HexSync(SECRET),
  deviceName: "  Front desk PC  ",
  agentVersion: "0.4.0",
  compat: { blockers: [] },
};

describe("enrollment:enroll", () => {
  test("enrolls once, retries idempotently, then refuses a used-up token", async () => {
    const t = convexTest(schema, modules);
    const { orgId, tokenId } = await seed(t);
    const first = await t.mutation(api.enrollment.enroll, enrollArgs);
    expect(Object.keys(first).sort()).toEqual(["deviceId", "deviceName", "orgId", "serverTimeMs"]);
    expect(first.orgId).toBe(orgId);
    expect(first.deviceName).toBe("Front desk PC");
    const again = await t.mutation(api.enrollment.enroll, enrollArgs);
    expect(again.deviceId).toBe(first.deviceId);
    const token = await t.run((ctx) => ctx.db.get(tokenId));
    expect(token?.usesLeft).toBe(0);
    const status = await t.run((ctx) =>
      ctx.db.query("deviceStatus").withIndex("by_device", (q) => q.eq("deviceId", first.deviceId)).first(),
    );
    expect(status?.orgId).toBe(orgId);
    await expect(
      t.mutation(api.enrollment.enroll, { ...enrollArgs, deviceSecretHash: sha256HexSync("other") }),
    ).rejects.toMatchObject({ data: { code: "token_used_up" } });
  });

  test("wire error codes stay as in Phase 2", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await expect(t.mutation(api.enrollment.enroll, { ...enrollArgs, token: "nope" })).rejects.toMatchObject({
      data: { code: "token_invalid" },
    });
    await expect(
      t.mutation(api.enrollment.enroll, { ...enrollArgs, deviceSecretHash: "xyz" }),
    ).rejects.toMatchObject({ data: { code: "invalid_request" } });
  });
});

async function enrolled(t: T): Promise<Id<"devices">> {
  await seed(t);
  return (await t.mutation(api.enrollment.enroll, enrollArgs)).deviceId;
}

describe("devices (Phase 2 agent functions)", () => {
  test("desiredState answers unknownDevice for a wrong secret or garbage id, ok otherwise", async () => {
    const t = convexTest(schema, modules);
    const deviceId = await enrolled(t);
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: "wrong" })).toEqual({
      kind: "unknownDevice",
    });
    expect(await t.query(api.devices.desiredState, { deviceId: "garbage", deviceSecret: SECRET })).toEqual({
      kind: "unknownDevice",
    });
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET })).toEqual({
      kind: "ok",
      desired: null,
    });
  });

  test("desiredState returns the newest Phase 2 document, device scope first", async () => {
    const t = convexTest(schema, modules);
    const deviceId = await enrolled(t);
    const device = await t.run((ctx) => ctx.db.get(deviceId));
    await t.run(async (ctx) => {
      await ctx.db.insert("desiredStates", { orgId: device!.orgId, scope: deviceId, version: 1, doc: { kioskEnabled: false } });
      await ctx.db.insert("desiredStates", { orgId: device!.orgId, scope: deviceId, version: 2, doc: { kioskEnabled: true } });
    });
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET })).toEqual({
      kind: "ok",
      desired: { version: 2, doc: { kioskEnabled: true }, signature: null },
    });
  });

  test("heartbeat writes the device row only on change; rejected for a wrong secret", async () => {
    const t = convexTest(schema, modules);
    const deviceId = await enrolled(t);
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: "wrong" })).toEqual({ kind: "rejected" });
    const status = { agentVersion: "0.4.0", kioskPhase: "applied", diskFreeGb: 30, compat: null };
    const first = await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET, status });
    expect(first).toMatchObject({ kind: "ok", nextPingInMs: 300_000 });
    const before = await t.run((ctx) => ctx.db.get(deviceId));
    expect(before?.kioskPhase).toBe("applied");
    expect(before?.compat).toBeUndefined();
    await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET, status });
    const after = await t.run((ctx) => ctx.db.get(deviceId));
    expect(after?._creationTime).toBe(before?._creationTime);
    expect(after).toEqual(before);
  });

  test("unenroll revokes; afterwards desiredState answers revoked and unenroll rejected", async () => {
    const t = convexTest(schema, modules);
    const deviceId = await enrolled(t);
    expect(await t.mutation(api.devices.unenroll, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "ok" });
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "revoked" });
    expect(await t.mutation(api.devices.unenroll, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "rejected" });
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "rejected" });
  });
});

describe("checkDevice with credential rotation (plan 4.6)", () => {
  test("old and new secret both work until the new one is used in a mutation", async () => {
    const t = convexTest(schema, modules);
    const deviceId = await enrolled(t);
    const NEW = "new-device-secret-9876543210";
    await t.run((ctx) =>
      ctx.db.patch(deviceId, { previousSecretHash: sha256HexSync(SECRET), secretHash: sha256HexSync(NEW) }),
    );
    const viaOld = await t.run((ctx) => checkDevice(ctx, { deviceId, deviceSecret: SECRET }));
    expect(viaOld).toMatchObject({ kind: "ok", matched: "previous" });
    // A query never settles; a mutation with the new secret does.
    await t.run(async (ctx) => settleRotation(ctx, await checkDevice(ctx, { deviceId, deviceSecret: SECRET })));
    expect((await t.run((ctx) => ctx.db.get(deviceId)))?.previousSecretHash).toBeDefined();
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: NEW })).toMatchObject({ kind: "ok" });
    expect((await t.run((ctx) => ctx.db.get(deviceId)))?.previousSecretHash).toBeUndefined();
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET })).toEqual({
      kind: "unknownDevice",
    });
  });
});
