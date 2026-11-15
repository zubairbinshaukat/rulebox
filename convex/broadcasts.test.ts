import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice } from "../tests/convex/devices";
import { asMember, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { createKeys, MASTER_A, setMaster } from "../tests/convex/phase5";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { MAX_ACTIVE_BROADCASTS, MAX_ORG_ACTIVE_BROADCASTS } from "./lib/limits";

// Device lock and broadcasts on the server (Phase 5 Step 15, plan 4.17): lock / unlock, send / cancel / list, the
// signed document (lock, <= 5 newest live broadcasts, expiry and cancellation filtered at publish), the active cap,
// the acknowledgement counters.

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
  setMaster(MASTER_A);
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
  setMaster(undefined);
});
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const HOUR = 3_600_000;

async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t, "Acme", { noKey: true });
  await createKeys(t, orgId);
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  const device = await enrollDevice(t, orgId, { groupId, name: "Desk 1" });
  const other = await enrollDevice(t, orgId, { groupId, name: "Desk 2" });
  const adm = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, adm);
  const view = await asMember(t, { role: "viewer", orgId });
  await drain(t);
  return { t, orgId, groupId, device, other, admin: adm.as, viewer: view.as };
}
type Env = Awaited<ReturnType<typeof setup>>;

type DocBroadcast = { id: string; style: string; title: string; body: string; expiresAtMs: number | null; ackRequired: boolean; issuedAtMs: number };
type Doc = { deviceLock: { lockId: string; message: string; contact: string | null; lockedAtMs: number } | null; broadcasts: DocBroadcast[] };

/** The device's newest signed document (what the agent verifies and applies). */
async function docOf(t: T, d: { deviceId: Id<"devices">; secret: string }): Promise<Doc> {
  const head = await t.query(api.devices.headState, { deviceId: d.deviceId, deviceSecret: d.secret });
  if (head.kind !== "ok" || head.head === null) throw new Error("no head");
  const env = await t.query(api.devices.fetchDesired, { deviceId: d.deviceId, deviceSecret: d.secret, version: head.head.version });
  const doc = (JSON.parse(env.payload) as { doc: Partial<Doc> }).doc;
  // A PC with no Phase 5 data at all gets the Phase 4 document: no lock, no broadcasts.
  return { deviceLock: doc.deviceLock ?? null, broadcasts: doc.broadcasts ?? [] };
}
/** The clock of the test moves the member sessions out too, so a broadcast "expires" by moving its expiry into the past. */
const expire = (e: Env, title: string) =>
  e.t.run(async (ctx) => {
    for (const b of await ctx.db.query("broadcasts").collect()) if (b.title === title) await ctx.db.patch(b._id, { expiresAt: Date.now() - 1 });
  });
const audits = (e: Env) => e.t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((a) => a.action));
const sendTo = (e: Env, over: Record<string, unknown> = {}) =>
  e.admin.mutation(api.broadcasts.send, {
    target: { kind: "group" as const, id: e.groupId },
    style: "banner" as const,
    title: "Maintenance",
    body: "The network is down tonight.",
    ackRequired: false,
    ...over,
  });

describe("fleet:lock / fleet:unlock", () => {
  test("lock puts the lock in the document (lockId = the row id), audits, and shows on the device page", async () => {
    const e = await setup();
    const { lockId } = await e.admin.mutation(api.fleet.lock, { deviceId: e.device.deviceId, message: "Call IT.\nThanks.", contact: " Front desk " });
    const row = await e.t.run((ctx) => ctx.db.query("deviceLocks").collect());
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ _id: lockId, lockId, message: "Call IT.\nThanks.", contact: "Front desk", deviceId: e.device.deviceId });
    await drain(e.t);
    expect((await docOf(e.t, e.device)).deviceLock).toMatchObject({ lockId, message: "Call IT.\nThanks.", contact: "Front desk" });
    // Only that PC.
    expect((await docOf(e.t, e.other)).deviceLock).toBeNull();
    expect(await audits(e)).toContain("device.locked");
    const page = await e.viewer.query(api.fleet.get, { deviceId: e.device.deviceId });
    expect(page.lock).toMatchObject({ lockId, message: "Call IT.\nThanks.", contact: "Front desk" });
  });

  test("the same text again writes nothing; other text replaces the lock with a new lockId; without contact it is dropped", async () => {
    const e = await setup();
    const first = await e.admin.mutation(api.fleet.lock, { deviceId: e.device.deviceId, message: "Locked", contact: "Ext 1" });
    await drain(e.t);
    const writes = (await audits(e)).filter((a) => a === "device.locked").length;
    const same = await e.admin.mutation(api.fleet.lock, { deviceId: e.device.deviceId, message: "  Locked ", contact: "Ext 1" });
    expect(same).toEqual(first);
    expect((await audits(e)).filter((a) => a === "device.locked")).toHaveLength(writes);

    const second = await e.admin.mutation(api.fleet.lock, { deviceId: e.device.deviceId, message: "Locked again", contact: "   " });
    expect(second.lockId).not.toBe(first.lockId);
    const rows = await e.t.run((ctx) => ctx.db.query("deviceLocks").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contact).toBeUndefined();
    await drain(e.t);
    expect((await docOf(e.t, e.device)).deviceLock).toMatchObject({ lockId: second.lockId, message: "Locked again", contact: null });
  });

  test("unlock deletes the lock, publishes a document without it and audits; unlocking an unlocked PC writes nothing", async () => {
    const e = await setup();
    await e.admin.mutation(api.fleet.lock, { deviceId: e.device.deviceId, message: "Locked" });
    await drain(e.t);
    expect((await docOf(e.t, e.device)).deviceLock).not.toBeNull();
    await e.admin.mutation(api.fleet.unlock, { deviceId: e.device.deviceId });
    expect(await e.t.run((ctx) => ctx.db.query("deviceLocks").collect())).toHaveLength(0);
    await drain(e.t);
    expect((await docOf(e.t, e.device)).deviceLock).toBeNull();
    expect(await audits(e)).toContain("device.unlocked");
    const before = (await audits(e)).length;
    await e.admin.mutation(api.fleet.unlock, { deviceId: e.device.deviceId });
    expect(await audits(e)).toHaveLength(before);
  });

  test("text rules: empty, too long and control characters are refused; 300 / 100 characters are fine; a viewer cannot lock", async () => {
    const e = await setup();
    const lock = (over: Record<string, unknown>) => e.admin.mutation(api.fleet.lock, { deviceId: e.device.deviceId, message: "Locked", ...over });
    await expect(lock({ message: "   " })).rejects.toThrow(/invalid_argument/);
    await expect(lock({ message: "m".repeat(301) })).rejects.toThrow(/invalid_argument/);
    await expect(lock({ message: "bad\u0007text" })).rejects.toThrow(/invalid_argument/);
    await expect(lock({ contact: "c".repeat(101) })).rejects.toThrow(/invalid_argument/);
    await expect(lock({ contact: "two\nlines" })).rejects.toThrow(/invalid_argument/);
    await expect(lock({ message: "m".repeat(300), contact: "c".repeat(100) })).resolves.toBeDefined();
    await expect(e.viewer.mutation(api.fleet.lock, { deviceId: e.device.deviceId, message: "x" })).rejects.toThrow(/forbidden/);
  });

  test("a revoked PC cannot be locked, but an existing lock can still be removed; removing the PC deletes its lock", async () => {
    const e = await setup();
    await e.admin.mutation(api.fleet.lock, { deviceId: e.other.deviceId, message: "Locked" });
    const owner = await asMember(e.t, { role: "owner", orgId: e.orgId });
    await giveStepUp(e.t, owner);
    await owner.as.mutation(api.fleet.revoke, { deviceId: e.other.deviceId });
    await expect(e.admin.mutation(api.fleet.lock, { deviceId: e.other.deviceId, message: "Again" })).rejects.toThrow(/conflict/);
    await e.admin.mutation(api.fleet.unlock, { deviceId: e.other.deviceId });
    expect(await e.t.run((ctx) => ctx.db.query("deviceLocks").collect())).toHaveLength(0);
  });
});

describe("broadcasts:send", () => {
  test("the group's PCs get it in their document, text kept literally; the other organization's never", async () => {
    const e = await setup();
    const sent = await sendTo(e, { title: "<b>Hi</b>", body: "a <script>alert(1)</script> &amp; line\nbreak", style: "fullscreen", ackRequired: true });
    expect(sent.targetCount).toBe(2);
    await drain(e.t);
    for (const d of [e.device, e.other]) {
      const doc = await docOf(e.t, d);
      expect(doc.broadcasts).toEqual([
        { id: sent.id, style: "fullscreen", title: "<b>Hi</b>", body: "a <script>alert(1)</script> &amp; line\nbreak", expiresAtMs: null, ackRequired: true, issuedAtMs: expect.any(Number) },
      ]);
    }
    expect(await audits(e)).toContain("broadcast.sent");

    const otherOrg = await makeOrg(e.t, "Other");
    const theirGroup = await e.t.run((ctx) => ctx.db.insert("groups", { orgId: otherOrg, name: "X", revision: 0, createdAt: Date.now() }));
    await expect(sendTo(e, { target: { kind: "group", id: theirGroup } })).rejects.toThrow(/not_found/);
  });

  test("a PC target reaches only that PC; a revoked PC cannot be a target", async () => {
    const e = await setup();
    const sent = await sendTo(e, { target: { kind: "device", id: e.device.deviceId }, title: "Just you" });
    expect(sent.targetCount).toBe(1);
    await drain(e.t);
    expect((await docOf(e.t, e.device)).broadcasts.map((b) => b.title)).toEqual(["Just you"]);
    expect((await docOf(e.t, e.other)).broadcasts).toEqual([]);

    const owner = await asMember(e.t, { role: "owner", orgId: e.orgId });
    await giveStepUp(e.t, owner);
    await owner.as.mutation(api.fleet.revoke, { deviceId: e.other.deviceId });
    await expect(sendTo(e, { target: { kind: "device", id: e.other.deviceId } })).rejects.toThrow(/conflict/);
  });

  test("validation: title / body rules, expiry must be in the future and within a year", async () => {
    const e = await setup();
    await expect(sendTo(e, { title: "" })).rejects.toThrow(/invalid_argument/);
    await expect(sendTo(e, { title: "t".repeat(81) })).rejects.toThrow(/invalid_argument/);
    await expect(sendTo(e, { body: "  " })).rejects.toThrow(/invalid_argument/);
    await expect(sendTo(e, { body: "b".repeat(501) })).rejects.toThrow(/invalid_argument/);
    await expect(sendTo(e, { body: "tab\there" })).rejects.toThrow(/invalid_argument/);
    await expect(sendTo(e, { expiresAt: Date.now() - 1 })).rejects.toThrow(/invalid_argument/);
    await expect(sendTo(e, { expiresAt: Date.now() + 366 * 24 * HOUR })).rejects.toThrow(/invalid_argument/);
    await expect(sendTo(e, { expiresAt: Number.NaN })).rejects.toThrow();
    await expect(sendTo(e, { title: "t".repeat(80), body: "b".repeat(500), expiresAt: Date.now() + HOUR })).resolves.toBeDefined();
    await expect(e.viewer.mutation(api.broadcasts.send, { target: { kind: "group", id: e.groupId }, style: "banner", title: "x", body: "y", ackRequired: false })).rejects.toThrow(/forbidden/);
  });

  test("a document carries the 5 newest live broadcasts, newest first by issue time", async () => {
    const e = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push((await sendTo(e, { title: `Message ${i}` })).id);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await drain(e.t);
    const doc = await docOf(e.t, e.device);
    expect(doc.broadcasts).toHaveLength(MAX_ACTIVE_BROADCASTS);
    expect(doc.broadcasts.map((b) => b.title).sort()).toEqual(["Message 2", "Message 3", "Message 4", "Message 5", "Message 6"]);
  });

  test("a group's and a PC's broadcasts are merged, newest 5 overall", async () => {
    const e = await setup();
    await sendTo(e, { title: "Old group" });
    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < 5; i++) {
      await sendTo(e, { target: { kind: "device", id: e.device.deviceId }, title: `Mine ${i}` });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await sendTo(e, { title: "New group" });
    await drain(e.t);
    const titles = (await docOf(e.t, e.device)).broadcasts.map((b) => b.title).sort();
    expect(titles).toEqual(["Mine 1", "Mine 2", "Mine 3", "Mine 4", "New group"]);
    expect((await docOf(e.t, e.other)).broadcasts.map((b) => b.title).sort()).toEqual(["New group", "Old group"]);
  });

  test("expiry is filtered at publish: an expired broadcast is dropped by the next document, a live one stays", async () => {
    const e = await setup();
    await sendTo(e, { title: "Short", expiresAt: Date.now() + HOUR });
    await sendTo(e, { title: "Long", expiresAt: Date.now() + 48 * HOUR });
    await sendTo(e, { title: "Forever" });
    await drain(e.t);
    expect((await docOf(e.t, e.device)).broadcasts.map((b) => b.title).sort()).toEqual(["Forever", "Long", "Short"]);
    await expire(e, "Short");
    // Anything that republishes the PC makes a document without the expired one.
    await e.admin.mutation(api.fleet.lock, { deviceId: e.device.deviceId, message: "Locked" });
    await drain(e.t);
    expect((await docOf(e.t, e.device)).broadcasts.map((b) => b.title).sort()).toEqual(["Forever", "Long"]);
  });

  test("at most 20 live broadcasts per organization: expired and cancelled ones do not count", async () => {
    const e = await setup();
    const ids: Id<"broadcasts">[] = [];
    for (let i = 0; i < MAX_ORG_ACTIVE_BROADCASTS - 2; i++) ids.push((await sendTo(e, { title: `Forever ${i}` })).id);
    const short = await sendTo(e, { title: "Short", expiresAt: Date.now() + HOUR });
    await sendTo(e, { title: "Timed", expiresAt: Date.now() + 10 * HOUR });
    await expect(sendTo(e, { title: "One too many" })).rejects.toThrow(/too_large/);
    // A cancelled one frees a place.
    await e.admin.mutation(api.broadcasts.cancel, { id: ids[0]! });
    await expect(sendTo(e, { title: "Fits now" })).resolves.toBeDefined();
    await expect(sendTo(e, { title: "Full again" })).rejects.toThrow(/too_large/);
    // An expired one frees a place too.
    await e.t.run((ctx) => ctx.db.patch(short.id, { expiresAt: Date.now() - 1 }));
    await expect(sendTo(e, { title: "After expiry" })).resolves.toBeDefined();
  });
});

describe("broadcasts:cancel and broadcasts:list", () => {
  test("cancel drops it from the next document, audits, and a second cancel writes nothing", async () => {
    const e = await setup();
    const a = await sendTo(e, { title: "Keep" });
    const b = await sendTo(e, { title: "Drop" });
    await drain(e.t);
    expect((await docOf(e.t, e.device)).broadcasts).toHaveLength(2);
    await e.admin.mutation(api.broadcasts.cancel, { id: b.id });
    await drain(e.t);
    expect((await docOf(e.t, e.device)).broadcasts.map((x) => x.id)).toEqual([a.id]);
    expect(await audits(e)).toContain("broadcast.cancelled");
    const row = await e.t.run((ctx) => ctx.db.get(b.id));
    const again = await e.admin.mutation(api.broadcasts.cancel, { id: b.id });
    expect(again).toBeNull();
    expect((await e.t.run((ctx) => ctx.db.get(b.id)))!.cancelledAt).toBe(row!.cancelledAt);
    expect((await audits(e)).filter((x) => x === "broadcast.cancelled")).toHaveLength(1);
  });

  test("cancelling a broadcast of a deleted group still works", async () => {
    const e = await setup();
    const a = await sendTo(e, { title: "Gone" });
    await e.t.run(async (ctx) => {
      for (const d of [e.device.deviceId, e.other.deviceId]) await ctx.db.patch(d, { groupId: undefined });
      await ctx.db.delete(e.groupId);
    });
    await expect(e.admin.mutation(api.broadcasts.cancel, { id: a.id })).resolves.toBeNull();
    const page = await e.viewer.query(api.broadcasts.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page[0]).toMatchObject({ title: "Gone", target: { kind: "group", name: null }, cancelledAt: expect.any(Number) });
  });

  test("list is newest first, paginated, with target names and counters; another organization sees none of it", async () => {
    const e = await setup();
    for (let i = 0; i < 5; i++) {
      await sendTo(e, { title: `M${i}`, target: i === 4 ? { kind: "device", id: e.device.deviceId } : { kind: "group", id: e.groupId } });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const first = await e.viewer.query(api.broadcasts.list, { paginationOpts: { numItems: 3, cursor: null } });
    expect(first.page.map((b) => b.title)).toEqual(["M4", "M3", "M2"]);
    expect(first.page[0]).toMatchObject({ target: { kind: "device", name: "Desk 1" }, targetCount: 1, ackCount: 0, cancelledAt: null, expiresAt: null });
    expect(first.page[1]).toMatchObject({ target: { kind: "group", name: "Sales" }, targetCount: 2 });
    const rest = await e.viewer.query(api.broadcasts.list, { paginationOpts: { numItems: 3, cursor: first.continueCursor } });
    expect(rest.page.map((b) => b.title)).toEqual(["M1", "M0"]);
    await expect(e.viewer.query(api.broadcasts.list, { paginationOpts: { numItems: 51, cursor: null } })).rejects.toThrow(/invalid_argument/);

    const otherOrg = await makeOrg(e.t, "Other");
    const stranger = await asMember(e.t, { role: "admin", orgId: otherOrg });
    await giveStepUp(e.t, stranger);
    expect((await stranger.as.query(api.broadcasts.list, { paginationOpts: { numItems: 10, cursor: null } })).page).toEqual([]);
    await expect(stranger.as.mutation(api.broadcasts.cancel, { id: (first.page[0]!)._id })).rejects.toThrow(/not_found/);
  });
});

describe("deviceApi:reportAcks and the counters", () => {
  test("one acknowledgement row and one count per device per broadcast; a repeat and a stranger's broadcast change nothing", async () => {
    const e = await setup();
    const sent = await sendTo(e, { title: "Ack me", ackRequired: true });
    const mine = { deviceId: e.device.deviceId, deviceSecret: e.device.secret };
    const theirs = { deviceId: e.other.deviceId, deviceSecret: e.other.secret };
    const at = Date.now();
    await e.t.mutation(api.deviceApi.reportAcks, { ...mine, acks: [{ broadcastId: sent.id, atMs: at }] });
    await e.t.mutation(api.deviceApi.reportAcks, { ...mine, acks: [{ broadcastId: sent.id, atMs: at }] });
    let page = await e.viewer.query(api.broadcasts.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page[0]).toMatchObject({ ackCount: 1, targetCount: 2 });
    await e.t.mutation(api.deviceApi.reportAcks, { ...theirs, acks: [{ broadcastId: sent.id, atMs: at }] });
    page = await e.viewer.query(api.broadcasts.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page[0]).toMatchObject({ ackCount: 2, targetCount: 2 });
    expect(await e.t.run((ctx) => ctx.db.query("broadcastAcks").collect())).toHaveLength(2);

    // A broadcast aimed at the OTHER device only: this PC's ack is ignored (accepted, nothing written).
    const only = await sendTo(e, { target: { kind: "device", id: e.other.deviceId }, title: "Not yours" });
    await e.t.mutation(api.deviceApi.reportAcks, { ...mine, acks: [{ broadcastId: only.id, atMs: at }] });
    expect(await e.t.run((ctx) => ctx.db.query("broadcastAcks").collect())).toHaveLength(2);
    expect((await e.t.run((ctx) => ctx.db.get(only.id)))!.ackCount).toBe(0);
  });
});
