// Test-only device helpers (plan Step 7). Outside convex/ so they are never pushed.

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { sha256HexSync } from "../../convex/lib/crypto";
import { ioProbe, type IoTotals } from "../../convex/lib/orgDb";
import type { T } from "./identity";

/** A fresh random 20-character Crockford token (the agent's format). */
export function newToken(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 20; i++) out += alphabet.charAt(Math.floor(Math.random() * 32));
  return out;
}

/**
 * Enroll a device through `enrollment:enroll` (the agent's real call) with a
 * known secret. Returns its id.
 */
export async function enrollDevice(
  t: T,
  orgId: Id<"organizations">,
  opts: { secret?: string; groupId?: Id<"groups">; name?: string } = {},
): Promise<{ deviceId: Id<"devices">; secret: string }> {
  const secret = opts.secret ?? `secret-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const token = newToken();
  await t.run((ctx) =>
    ctx.db.insert("enrollmentTokens", {
      orgId,
      tokenHash: sha256HexSync(token),
      expiresAt: Date.now() + 3_600_000,
      usesLeft: 1,
      groupId: opts.groupId,
      createdAt: Date.now(),
    }),
  );
  const r = await t.mutation(api.enrollment.enroll, {
    token,
    deviceSecretHash: sha256HexSync(secret),
    deviceName: opts.name ?? "PC",
    agentVersion: "0.4.0",
    compat: { blockers: [] },
  });
  return { deviceId: r.deviceId, secret };
}

/**
 * A device row exactly as a Phase 2 / Step 6 deployment holds it (the dev
 * deployment's real VM device has this shape): credentials and the 12 status
 * fields on `devices`, a `deviceStatus` row, and none of the Step 7 rows.
 */
export async function legacyDevice(
  t: T,
  orgId: Id<"organizations">,
  opts: { secret: string; revoked?: boolean; lastSeenAt?: number; groupId?: Id<"groups">; status?: boolean },
): Promise<Id<"devices">> {
  return await t.run(async (ctx) => {
    const tok = await ctx.db.insert("enrollmentTokens", {
      orgId,
      tokenHash: sha256HexSync(`legacy-${Math.random()}`),
      expiresAt: 0,
      usesLeft: 0,
      createdAt: 0,
    });
    const deviceId = await ctx.db.insert("devices", {
      orgId,
      groupId: opts.groupId,
      name: "RULEBOX",
      secretHash: sha256HexSync(opts.secret),
      revoked: opts.revoked === true,
      enrolledAt: Date.now() - 86_400_000,
      enrollmentTokenId: tok,
      ...(opts.status === false
        ? {}
        : {
            agentVersion: "0.0.0",
            os: "Windows",
            osBuild: "26300.9457",
            osEdition: "Professional",
            ramMb: 4094,
            diskFreeGb: 31,
            kioskPhase: "applied",
            appliedVersion: 1,
            shellHealth: "ok",
            compat: { blockers: [], liteMode: true },
          }),
    });
    await ctx.db.insert("deviceStatus", { deviceId, lastSeenAt: opts.lastSeenAt ?? Date.now() });
    return deviceId;
  });
}

/** Run `f` with the I/O probe on and return what it read and wrote. */
export async function probe<R>(f: () => Promise<R>): Promise<{ result: R; io: IoTotals }> {
  ioProbe.enabled = true;
  ioProbe.reset();
  try {
    const result = await f();
    return { result, io: ioProbe.totals };
  } finally {
    ioProbe.enabled = false;
  }
}

/** All rows of the Step 7 per-device tables for one device. */
export async function deviceRows(t: T, deviceId: Id<"devices">) {
  return await t.run(async (ctx) => ({
    device: await ctx.db.get(deviceId),
    cred: await ctx.db.query("deviceCredentials").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique(),
    liveness: await ctx.db.query("deviceLiveness").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique(),
    presence: await ctx.db.query("devicePresence").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique(),
    summary: await ctx.db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique(),
    report: await ctx.db.query("deviceReports").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique(),
  }));
}

export async function orgStatsOf(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}

export async function onlineCount(t: T, orgId: Id<"organizations">): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("orgPresence").withIndex("by_org_shard", (q) => q.eq("orgId", orgId)).take(16);
    return rows.reduce((s, r) => s + r.online, 0);
  });
}
