import { describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { formatEnrollmentCode, isAgentAcceptableUrl, sha256HexSync } from "./lib/crypto";
import { MINUTE_MS } from "./lib/limits";

// Enrollment codes (plan Step 6 + amendments A1, A7, A9) and the plan checks
// in enrollment:enroll.

// ---------------------------------------------------------------- the agent's parser rules
// A TS copy of apps/agent/src/enroll_code.rs `parse` (prefix, base64url
// without padding, `<url>#<token>`, https host[:port] only, 20 Crockford chars).

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64UrlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = B64URL.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

function agentParse(code: string): { convexUrl: string; token: string } | string {
  const trimmed = code.trim();
  if (!trimmed.startsWith("RBX1.")) return "BadPrefix";
  const bytes = base64UrlDecode(trimmed.slice(5));
  if (bytes === null) return "BadEncoding";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "BadEncoding";
  }
  const hash = text.indexOf("#");
  if (hash < 0) return "Malformed";
  const convexUrl = text.slice(0, hash);
  const token = text.slice(hash + 1);
  const authority = convexUrl.startsWith("https://") ? convexUrl.slice(8) : null;
  if (authority === null || authority === "" || /[/?#@\s[\]]/.test(authority)) return "BadUrl";
  const [host, port, ...rest] = authority.split(":");
  if (rest.length > 0 || host === undefined || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/.test(host)) return "BadUrl";
  if (port !== undefined && !(/^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return "BadUrl";
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(token)) return "BadToken";
  return { convexUrl, token };
}

function tokenOf(code: string): string {
  const parsed = agentParse(code);
  if (typeof parsed === "string") throw new Error(`agent would refuse the code: ${parsed}`);
  return parsed.token;
}

// ---------------------------------------------------------------- fixtures

async function admin(t: T, orgId: Id<"organizations">, stepUp: "fresh" | "stale" = "fresh") {
  const m = await asMember(t, { role: "admin", mfa: true, orgId });
  if (stepUp === "fresh") await giveStepUp(t, m);
  else await giveStepUp(t, m, { verifiedAgoMs: 6 * MINUTE_MS, activeAgoMs: 0 });
  return m;
}

async function group(t: T, orgId: Id<"organizations">, name = "Front desk"): Promise<Id<"groups">> {
  return await t.run((ctx) => ctx.db.insert("groups", { orgId, name, revision: 0, createdAt: Date.now() }));
}

async function stats(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}

async function audit(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(100));
}

async function devices(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("devices").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(100));
}

let secretCounter = 0;
function enrollArgs(token: string, over: Record<string, unknown> = {}) {
  return {
    token,
    deviceSecretHash: sha256HexSync(`secret-${++secretCounter}`),
    deviceName: "Front desk PC",
    hardwareIdHash: sha256HexSync("machine-guid"),
    agentVersion: "0.4.0",
    compat: { blockers: [] },
    ...over,
  };
}

async function setPlanStatus(t: T, orgId: Id<"organizations">, status: "active" | "suspended") {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
    await ctx.db.patch(row!._id, { status });
  });
}

const page = { paginationOpts: { numItems: 50, cursor: null } };

// ---------------------------------------------------------------- tests

describe("code format", () => {
  test("formatEnrollmentCode is RBX1. + base64url without padding, as the agent's Rust test builds it", () => {
    for (const url of ["https://abc.convex.cloud", "https://a.convex.cloud", "https://convex.example.org:3210"]) {
      const text = `${url}#0123456789ABCDEFGHJK`;
      const expected = "RBX1." + btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(formatEnrollmentCode(url, "0123456789ABCDEFGHJK")).toBe(expected);
      expect(agentParse(expected)).toEqual({ convexUrl: url, token: "0123456789ABCDEFGHJK" });
    }
    expect(isAgentAcceptableUrl("https://abc.convex.cloud")).toBe(true);
    for (const bad of ["http://abc.convex.cloud", "https://abc.convex.cloud/", "https://abc.convex.cloud/x", "https://u@abc.convex.cloud", "not a url"]) {
      expect(isAgentAcceptableUrl(bad), bad).toBe(false);
    }
  });
});

describe("enrollmentCodes:create", () => {
  test("the code parses under the agent's rules, is shown once and stored only as a hash", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const groupId = await group(t, orgId);
    const a = await admin(t, orgId);
    const before = Date.now();
    const { code, expiresAt } = await a.as.action(api.enrollmentCodes.create, { groupId, uses: 3, ttlMinutes: 60, label: " Branch 4 " });

    const parsed = agentParse(code);
    expect(parsed).toEqual({ convexUrl: "https://happy-animal-123.convex.cloud", token: expect.any(String) });
    const token = tokenOf(code);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60 * MINUTE_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * MINUTE_MS);

    const rows = await t.run((ctx) => ctx.db.query("enrollmentTokens").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(10));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ tokenHash: sha256HexSync(token), usesLeft: 3, usesTotal: 3, groupId, label: "Branch 4", createdBy: a.memberId });
    expect(JSON.stringify(row)).not.toContain(token);
    expect((await stats(t, orgId))?.activeEnrollmentCodes).toBe(1);

    // Audit: created, no code, no token, no hash.
    const log = await audit(t, orgId);
    expect(log.map((r) => r.action)).toEqual(["enrollment.codeCreated"]);
    expectNoSecrets(log, [code, token, row.tokenHash]);
    expect(log[0]!.summary).toBe("Created an enrollment code for the group Front desk: 3 uses, valid 1 hour(s)");

    // Listed without the code or the hash.
    const list = await a.as.query(api.enrollmentCodes.list, { ...page, nowMs: Date.now() });
    expectNoSecrets(list, [code, token, row.tokenHash]);
    expect(list.page).toEqual([
      expect.objectContaining({ label: "Branch 4", groupName: "Front desk", usesLeft: 3, usesTotal: 3, state: "active", createdByEmail: a.email }),
    ]);
  });

  test("two codes are different; bounds and label are validated", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const groupId = await group(t, orgId);
    const a = await admin(t, orgId);
    const one = await a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 15 });
    const two = await a.as.action(api.enrollmentCodes.create, { groupId, uses: 100, ttlMinutes: 10_080 });
    expect(tokenOf(one.code)).not.toBe(tokenOf(two.code));
    for (const bad of [
      { uses: 0, ttlMinutes: 60 },
      { uses: 101, ttlMinutes: 60 },
      { uses: 1.5, ttlMinutes: 60 },
      { uses: 1, ttlMinutes: 14 },
      { uses: 1, ttlMinutes: 10_081 },
      { uses: 1, ttlMinutes: 60.5 },
    ]) {
      await expectCode(a.as.action(api.enrollmentCodes.create, { groupId, ...bad }), "invalid_argument");
    }
    await expectCode(a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 60, label: "x".repeat(65) }), "invalid_argument");
    await expectCode(a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 60, label: "a\u0007b" }), "invalid_argument");
    // Nothing of the refused calls was stored.
    expect((await stats(t, orgId))?.activeEnrollmentCodes).toBe(2);
  });

  test("viewer is refused; a group of another organization is not_found; a group is required", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const other = await makeOrg(t, "Other");
    const foreignGroup = await group(t, other);
    const viewer = await asMember(t, { role: "viewer", orgId });
    await giveStepUp(t, viewer);
    const groupId = await group(t, orgId);
    await expectCode(viewer.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 60 }), "forbidden");
    const a = await admin(t, orgId);
    await expectCode(a.as.action(api.enrollmentCodes.create, { groupId: foreignGroup, uses: 1, ttlMinutes: 60 }), "not_found");
    await expectCode(a.as.action(api.enrollmentCodes.create, { groupId: "garbage", uses: 1, ttlMinutes: 60 }), "not_found");
    expect(await t.run((ctx) => ctx.db.query("enrollmentTokens").take(10))).toHaveLength(0);
  });

  test("free plan: the sixth active code is refused; revoked, used-up and expired codes free a slot", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Free", { plan: "free" });
    const groupId = await group(t, orgId);
    const a = await admin(t, orgId);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push(await a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 15 }));
    await expectCode(a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 15 }), "plan_limit");
    expect((await stats(t, orgId))?.activeEnrollmentCodes).toBe(5);

    // Revoke one: a slot is free.
    const listed = await a.as.query(api.enrollmentCodes.list, { ...page, nowMs: Date.now() });
    await a.as.mutation(api.enrollmentCodes.revoke, { tokenId: listed.page[0]!._id });
    expect((await stats(t, orgId))?.activeEnrollmentCodes).toBe(4);
    await a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 15 });
    await expectCode(a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 15 }), "plan_limit");

    // Use one up (one device, under the free maxDevices of 2): a slot is free.
    await t.mutation(api.enrollment.enroll, enrollArgs(tokenOf(codes[0]!.code)));
    expect((await stats(t, orgId))?.activeEnrollmentCodes).toBe(4);
    await a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 15 });

    // Expire every code: the counter still says 5, the recount at the limit frees them.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("enrollmentTokens").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(20)) {
        await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
      }
    });
    expect((await stats(t, orgId))?.activeEnrollmentCodes).toBe(5);
    await a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 15 });
    expect((await stats(t, orgId))?.activeEnrollmentCodes).toBe(1);
  });

  test("a suspended organization cannot create codes but can revoke them", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Free", { plan: "free" });
    const groupId = await group(t, orgId);
    const a = await admin(t, orgId);
    const { code } = await a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 60 });
    await setPlanStatus(t, orgId, "suspended");
    await expectCode(a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 60 }), "plan_limit");
    // Enrolling into a suspended organization is refused too.
    await expect(t.mutation(api.enrollment.enroll, enrollArgs(tokenOf(code)))).rejects.toMatchObject({
      data: { code: "plan_limit", detail: "suspended" },
    });
    const listed = await a.as.query(api.enrollmentCodes.list, { ...page, nowMs: Date.now() });
    await a.as.mutation(api.enrollmentCodes.revoke, { tokenId: listed.page[0]!._id });
    expect((await stats(t, orgId))?.activeEnrollmentCodes).toBe(0);
  });
});

describe("enrollmentCodes:list and revoke", () => {
  test("states from the client minute, newest first, page size bounded, no hash", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const groupId = await group(t, orgId);
    const a = await admin(t, orgId);
    const used = await a.as.action(api.enrollmentCodes.create, { groupId, uses: 1, ttlMinutes: 60, label: "used" });
    await a.as.action(api.enrollmentCodes.create, { groupId, uses: 2, ttlMinutes: 15, label: "short" });
    await a.as.action(api.enrollmentCodes.create, { groupId, uses: 2, ttlMinutes: 60, label: "revoked" });
    await a.as.action(api.enrollmentCodes.create, { groupId, uses: 2, ttlMinutes: 60, label: "open" });
    await t.mutation(api.enrollment.enroll, enrollArgs(tokenOf(used.code)));
    const first = await a.as.query(api.enrollmentCodes.list, { ...page, nowMs: Date.now() });
    const byLabel = (rows: typeof first.page) => Object.fromEntries(rows.map((r) => [r.label, r.state]));
    await a.as.mutation(api.enrollmentCodes.revoke, { tokenId: first.page.find((r) => r.label === "revoked")!._id });

    // 20 minutes later on the client's clock, the 15-minute code is expired.
    const later = await a.as.query(api.enrollmentCodes.list, { ...page, nowMs: Date.now() + 20 * MINUTE_MS });
    expect(later.page.map((r) => r.label)).toEqual(["open", "revoked", "short", "used"]);
    expect(byLabel(later.page)).toEqual({ open: "active", revoked: "revoked", short: "expired", used: "usedUp" });
    expect(later.page.find((r) => r.label === "used")).toMatchObject({ usesLeft: 0, usesTotal: 1 });
    expectNoSecrets(later);
    // A viewer may read it too.
    const viewer = await asMember(t, { role: "viewer", orgId });
    expect((await viewer.as.query(api.enrollmentCodes.list, { ...page, nowMs: Date.now() })).page).toHaveLength(4);
    await expectCode(a.as.query(api.enrollmentCodes.list, { paginationOpts: { numItems: 51, cursor: null }, nowMs: Date.now() }), "invalid_argument");
    // Paging works.
    const p1 = await a.as.query(api.enrollmentCodes.list, { paginationOpts: { numItems: 3, cursor: null }, nowMs: Date.now() });
    const p2 = await a.as.query(api.enrollmentCodes.list, { paginationOpts: { numItems: 3, cursor: p1.continueCursor }, nowMs: Date.now() });
    expect([...p1.page, ...p2.page].map((r) => r.label)).toEqual(["open", "revoked", "short", "used"]);
    expect(p2.isDone).toBe(true);
  });

  test("revoke needs a fresh step-up, audits, is idempotent; a revoked code is refused by enroll", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const groupId = await group(t, orgId);
    const a = await admin(t, orgId);
    const { code } = await a.as.action(api.enrollmentCodes.create, { groupId, uses: 5, ttlMinutes: 60, label: "Lobby" });
    const tokenId = (await a.as.query(api.enrollmentCodes.list, { ...page, nowMs: Date.now() })).page[0]!._id;
    const stale = await admin(t, orgId, "stale");
    await expectCode(stale.as.mutation(api.enrollmentCodes.revoke, { tokenId }), "step_up_required");
    const viewer = await asMember(t, { role: "viewer", orgId });
    await giveStepUp(t, viewer);
    await expectCode(viewer.as.mutation(api.enrollmentCodes.revoke, { tokenId }), "forbidden");
    // Another organization's admin: not_found (existence not confirmed).
    const foreign = await admin(t, await makeOrg(t, "Other"));
    await expectCode(foreign.as.mutation(api.enrollmentCodes.revoke, { tokenId }), "not_found");

    await a.as.mutation(api.enrollmentCodes.revoke, { tokenId });
    await a.as.mutation(api.enrollmentCodes.revoke, { tokenId });
    const log = await audit(t, orgId);
    expect(log.map((r) => r.action)).toEqual(["enrollment.codeCreated", "enrollment.codeRevoked"]);
    expect(log[1]!.summary).toBe("Revoked the enrollment code Lobby");
    expect((await stats(t, orgId))?.activeEnrollmentCodes).toBe(0);
    await expect(t.mutation(api.enrollment.enroll, enrollArgs(tokenOf(code)))).rejects.toMatchObject({ data: { code: "token_revoked" } });
    expect(await devices(t, orgId)).toHaveLength(0);
  });
});

describe("enrollment:enroll (Step 6: plan limits, rate limits, validation)", () => {
  async function freeOrgWithCode(t: T, uses = 10) {
    const orgId = await makeOrg(t, "Free", { plan: "free" });
    const groupId = await group(t, orgId);
    const a = await admin(t, orgId);
    const { code } = await a.as.action(api.enrollmentCodes.create, { groupId, uses, ttlMinutes: 60 });
    return { orgId, groupId, a, token: tokenOf(code) };
  }

  test("a dashboard code enrolls into its group with one device row, one counter bump and one audit row", async () => {
    const t = await setupAuth();
    const { orgId, groupId, token } = await freeOrgWithCode(t);
    const args = enrollArgs(token, { deviceName: "  Front\u0000 desk​\n PC  " });
    const result = await t.mutation(api.enrollment.enroll, args);
    expect(Object.keys(result).sort()).toEqual(["deviceId", "deviceName", "orgId", "serverTimeMs"]);
    expect(result).toMatchObject({ orgId, deviceName: "Front desk PC" });
    const rows = await devices(t, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ groupId, name: "Front desk PC", hardwareIdHash: sha256HexSync("machine-guid") });
    // Identity only on `devices` (Step 7, A2): the credentials have their own row.
    expect(rows[0]!.secretHash).toBeUndefined();
    expect(rows[0]!.revoked).toBeUndefined();
    const cred = await t.run((ctx) => ctx.db.query("deviceCredentials").withIndex("by_device", (q) => q.eq("deviceId", result.deviceId)).unique());
    expect(cred).toMatchObject({ orgId, secretHash: args.deviceSecretHash, state: "active" });
    expect((await stats(t, orgId))?.deviceCount).toBe(1);
    const log = await audit(t, orgId);
    expect(log.map((r) => r.action)).toEqual(["enrollment.codeCreated", "device.enrolled"]);
    expect(log[1]).toMatchObject({ actorType: "device", actorId: result.deviceId, targetId: result.deviceId });
    expectNoSecrets(log, [token, sha256HexSync(token), args.deviceSecretHash]);
  });

  test("the third device of a free organization is refused with plan_limit and nothing is written", async () => {
    const t = await setupAuth();
    const { orgId, token } = await freeOrgWithCode(t);
    const first = enrollArgs(token);
    await t.mutation(api.enrollment.enroll, first);
    await t.mutation(api.enrollment.enroll, enrollArgs(token));
    const tokenRow = async () => await t.run((ctx) => ctx.db.query("enrollmentTokens").withIndex("by_token_hash", (q) => q.eq("tokenHash", sha256HexSync(token))).unique());
    const before = { token: await tokenRow(), stats: await stats(t, orgId), audit: (await audit(t, orgId)).length };
    await expect(t.mutation(api.enrollment.enroll, enrollArgs(token))).rejects.toMatchObject({ data: { code: "plan_limit", detail: "devices" } });
    expect(await devices(t, orgId)).toHaveLength(2);
    expect(await tokenRow()).toEqual(before.token);
    expect(await stats(t, orgId)).toEqual(before.stats);
    expect(await audit(t, orgId)).toHaveLength(before.audit);

    // A retry of an enrolled secret still answers the first result at the limit.
    const again = await t.mutation(api.enrollment.enroll, first);
    expect(again.deviceName).toBe("Front desk PC");
    expect(await devices(t, orgId)).toHaveLength(2);

    // A revoked device frees a slot.
    const secret = "freed-slot-secret";
    const deviceId = await t.run(async (ctx) => {
      // Give the first device a known secret so it can unenroll itself.
      const c = (await ctx.db.query("deviceCredentials").withIndex("by_secret_hash", (q) => q.eq("secretHash", first.deviceSecretHash)).unique())!;
      await ctx.db.patch(c._id, { secretHash: sha256HexSync(secret) });
      return c.deviceId;
    });
    expect(await t.mutation(api.devices.unenroll, { deviceId, deviceSecret: secret })).toEqual({ kind: "ok" });
    expect((await stats(t, orgId))?.deviceCount).toBe(1);
    await t.mutation(api.enrollment.enroll, enrollArgs(token));
    expect((await stats(t, orgId))?.deviceCount).toBe(2);
  });

  test("parallel enrollments never use a code more often than allowed", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t); // custom plan: no device limit
    const groupId = await group(t, orgId);
    const a = await admin(t, orgId);
    const { code } = await a.as.action(api.enrollmentCodes.create, { groupId, uses: 3, ttlMinutes: 60 });
    const token = tokenOf(code);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => t.mutation(api.enrollment.enroll, enrollArgs(token))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ data: { code: "token_used_up" } });
    }
    expect(await devices(t, orgId)).toHaveLength(3);
    expect(await stats(t, orgId)).toMatchObject({ deviceCount: 3, activeEnrollmentCodes: 0 });
  });

  test("enrollPerOrg allows 10 per minute; refused attempts and idempotent retries do not consume it", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const groupId = await group(t, orgId);
    const a = await admin(t, orgId);
    const { code } = await a.as.action(api.enrollmentCodes.create, { groupId, uses: 20, ttlMinutes: 60 });
    const token = tokenOf(code);
    const { code: revokedCode } = await a.as.action(api.enrollmentCodes.create, { groupId, uses: 20, ttlMinutes: 60 });
    const revokedId = (await a.as.query(api.enrollmentCodes.list, { ...page, nowMs: Date.now() })).page[0]!._id;
    await a.as.mutation(api.enrollmentCodes.revoke, { tokenId: revokedId });
    // 15 refused attempts that resolve to this organization: rolled back, nothing consumed.
    for (let i = 0; i < 15; i++) {
      await expectCode(t.mutation(api.enrollment.enroll, enrollArgs(tokenOf(revokedCode))), "token_revoked");
    }
    const first = enrollArgs(token);
    await t.mutation(api.enrollment.enroll, first);
    // Idempotent retries consume only the global bucket.
    for (let i = 0; i < 12; i++) await t.mutation(api.enrollment.enroll, first);
    for (let i = 0; i < 9; i++) await t.mutation(api.enrollment.enroll, enrollArgs(token));
    await expectCode(t.mutation(api.enrollment.enroll, enrollArgs(token)), "rate_limited");
    expect(await devices(t, orgId)).toHaveLength(10);
    // Another organization has its own bucket.
    const other = await freeOrgWithCode(t);
    await t.mutation(api.enrollment.enroll, enrollArgs(other.token));
  });

  test("input validation: malformed input is refused before any read; odd names are cleaned", async () => {
    const t = await setupAuth();
    const { orgId, token } = await freeOrgWithCode(t);
    for (const bad of ["", "nope", token.toLowerCase(), token.slice(0, 19), `${token}I`, `${token}#x`, "A".repeat(33)]) {
      await expectCode(t.mutation(api.enrollment.enroll, enrollArgs(bad)), "token_invalid");
    }
    // Shaped like a token but unknown.
    await expectCode(t.mutation(api.enrollment.enroll, enrollArgs("0".repeat(20))), "token_invalid");
    await expectCode(t.mutation(api.enrollment.enroll, enrollArgs(token, { deviceSecretHash: "xyz" })), "invalid_request");
    await expectCode(t.mutation(api.enrollment.enroll, enrollArgs(token, { hardwareIdHash: "machine-guid" })), "invalid_request");
    await expectCode(t.mutation(api.enrollment.enroll, enrollArgs(token, { deviceName: "x".repeat(1001) })), "invalid_request");
    await expectCode(t.mutation(api.enrollment.enroll, enrollArgs(token, { agentVersion: "1".repeat(65) })), "invalid_request");
    await expectCode(t.mutation(api.enrollment.enroll, enrollArgs(token, { compat: { blob: "x".repeat(40_000) } })), "invalid_request");
    expect(await devices(t, orgId)).toHaveLength(0);
    expect((await audit(t, orgId)).map((r) => r.action)).toEqual(["enrollment.codeCreated"]);

    // hardwareIdHash is optional (the agent leaves it out when unknown); names are cleaned and capped.
    const { hardwareIdHash: _omit, ...withoutHardwareId } = enrollArgs(token, { deviceName: "é".repeat(150) });
    void _omit;
    const long = await t.mutation(api.enrollment.enroll, withoutHardwareId);
    expect(Array.from(long.deviceName)).toHaveLength(100);
    const blank = await t.mutation(api.enrollment.enroll, enrollArgs(token, { deviceName: " \t\u0001 " }));
    expect(blank.deviceName).toBe("Unnamed device");
  });

  test("an expired code is refused with token_expired", async () => {
    const t = await setupAuth();
    const { orgId, token } = await freeOrgWithCode(t);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("enrollmentTokens").withIndex("by_org", (q) => q.eq("orgId", orgId)).first())!;
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    await expectCode(t.mutation(api.enrollment.enroll, enrollArgs(token)), "token_expired");
  });
});
