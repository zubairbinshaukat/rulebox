import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { buildDeviceDoc, contentHashOf, displayKeys, type BuildInput } from "./lib/desired";
import { DEFAULT_ORG_SETTINGS } from "./lib/validators";

// Phase 6 Step 19 (plan 4.14, 4.16): the display-mode override of a group and of a PC, the group's web window cap and idle close,
// their validation, audit and publication as agent-only keys.

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t);
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  const d = await enrollDevice(t, orgId, { groupId });
  const m = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, m);
  await drain(t);
  return { t, orgId, groupId, deviceId: d.deviceId, m };
}

async function docOf(t: T, deviceId: Id<"devices">): Promise<Record<string, unknown>> {
  const head = await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique());
  const body = await t.run((ctx) => ctx.db.get(head!.bodyId));
  return (JSON.parse(body!.payload) as { doc: Record<string, unknown> }).doc;
}

async function audits(t: T, orgId: Id<"organizations">, action: string) {
  const rows = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(100));
  return rows.filter((r) => r.action === action).map((r) => r.summary);
}

const NONE = { displayMode: "auto", webWindowCap: null, webIdleCloseMin: null } as const;

describe("displayKeys (pure): the device's choice wins, `auto` falls through", () => {
  test("override order and key order", () => {
    expect(displayKeys({})).toEqual({});
    expect(displayKeys({ device: "auto", group: "auto" })).toEqual({});
    expect(displayKeys({ group: "lite" })).toEqual({ displayMode: "lite", displayModeSource: "group" });
    expect(displayKeys({ device: "standard", group: "lite" })).toEqual({ displayMode: "standard", displayModeSource: "device" });
    // A PC that chose `auto` follows its group.
    expect(displayKeys({ device: "auto", group: "lite" })).toEqual({ displayMode: "lite", displayModeSource: "group" });
    expect(Object.keys(displayKeys({ device: "lite", webWindowCap: 4, webIdleCloseMin: 0 }))).toEqual([
      "displayMode",
      "displayModeSource",
      "webWindowCap",
      "webIdleCloseMin",
    ]);
    // 0 is a real value (idle close off), not "absent".
    expect(displayKeys({ webIdleCloseMin: 0 })).toEqual({ webIdleCloseMin: 0 });
  });

  test("a document without display settings is the old document, byte for byte; the keys come last", () => {
    const base: BuildInput = {
      org: { _id: "o1", name: "Acme" },
      settings: DEFAULT_ORG_SETTINGS,
      pinHash: null,
      group: null,
      assignments: [],
      apps: [],
      employees: [],
      employeeApps: [],
      fileHandlers: [],
      device: { _id: "d1", kioskEnabled: true },
    };
    const plain = buildDeviceDoc(base, 3);
    expect(buildDeviceDoc({ ...base, display: {} }, 3)).toEqual(plain);
    expect(JSON.stringify(buildDeviceDoc({ ...base, display: {} }, 3))).toBe(JSON.stringify(plain));
    const with_ = buildDeviceDoc({ ...base, display: { group: "lite", webWindowCap: 2 } }, 3);
    expect(Object.keys(with_).slice(-3)).toEqual(["displayMode", "displayModeSource", "webWindowCap"]);
    // The content hash sees it: a changed setting is a new version.
    expect(contentHashOf(with_)).not.toBe(contentHashOf(plain));
  });
});

describe("groups:setDisplay", () => {
  test("saves, audits `group.displayModeChanged`, bumps the revision and republishes the group's PCs as agent-only keys", async () => {
    const { t, orgId, groupId, deviceId, m } = await setup();
    expect(await docOf(t, deviceId)).not.toHaveProperty("displayMode");
    const r = await m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 0, displayMode: "lite", webWindowCap: 2, webIdleCloseMin: 15 });
    expect(r).toEqual({ revision: 1 });
    await drain(t);
    const doc = await docOf(t, deviceId);
    expect(doc).toMatchObject({ displayMode: "lite", displayModeSource: "group", webWindowCap: 2, webIdleCloseMin: 15 });
    expect(await audits(t, orgId, "group.displayModeChanged")).toEqual([
      "Changed the display settings of the group Sales: display mode Lite, at most 2 web windows, idle close after 15 min",
    ]);
    const row = await m.as.query(api.groups.get, { groupId });
    expect(row.group).toMatchObject({ displayMode: "lite", webWindowCap: 2, webIdleCloseMin: 15, revision: 1 });
  });

  test("the same values again: no write, no audit, no publish; `auto` and null clear the fields", async () => {
    const { t, orgId, groupId, m } = await setup();
    await m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 0, displayMode: "standard", webWindowCap: 5, webIdleCloseMin: 0 });
    await drain(t);
    const { result, io } = await probe(() =>
      m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 1, displayMode: "standard", webWindowCap: 5, webIdleCloseMin: 0 }),
    );
    expect(result).toEqual({ revision: 1 });
    expect(io.writes).toBe(0);
    expect(await audits(t, orgId, "group.displayModeChanged")).toHaveLength(1);
    expect(await m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 1, ...NONE })).toEqual({ revision: 2 });
    const g = await t.run((ctx) => ctx.db.get(groupId));
    expect(g).not.toHaveProperty("displayMode");
    expect(g).not.toHaveProperty("webWindowCap");
    expect(g).not.toHaveProperty("webIdleCloseMin");
    expect(await audits(t, orgId, "group.displayModeChanged")).toHaveLength(2);
  });

  test("the cost is the budget's: 3 writes at most (group, audit, publish queue)", async () => {
    const { groupId, m } = await setup();
    const { io } = await probe(() => m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 0, displayMode: "lite", webWindowCap: null, webIdleCloseMin: null }));
    expect(io.writes).toBeLessThanOrEqual(3);
  });

  test("values the agent would refuse the whole document for are refused here", async () => {
    const { groupId, m } = await setup();
    const call = (over: Record<string, unknown>, expectedRevision = 0) =>
      m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision, ...NONE, ...over } as never);
    for (const cap of [0, 13, 1.5, -1]) await expectCode(call({ webWindowCap: cap }), "invalid_argument");
    for (const min of [1, 4, 241, 5.5, -3]) await expectCode(call({ webIdleCloseMin: min }), "invalid_argument");
    expect(await call({ webWindowCap: 1 })).toEqual({ revision: 1 });
    expect(await call({ webWindowCap: 12 }, 1)).toEqual({ revision: 2 });
    expect(await call({ webIdleCloseMin: 5 }, 2)).toEqual({ revision: 3 });
    expect(await call({ webIdleCloseMin: 240 }, 3)).toEqual({ revision: 4 });
  });

  test("a stale edit is refused; a viewer cannot change it", async () => {
    const { t, orgId, groupId, m } = await setup();
    await m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 0, displayMode: "lite", webWindowCap: null, webIdleCloseMin: null });
    await expectCode(m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 0, ...NONE }), "stale_edit");
    const viewer = await asMember(t, { role: "viewer", orgId });
    await expectCode(viewer.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 1, ...NONE }), "forbidden");
  });
});

describe("fleet:setDisplayMode", () => {
  test("the PC's own choice wins over its group's; `auto` hands it back to the group; each change audits `device.displayModeChanged`", async () => {
    const { t, orgId, groupId, deviceId, m } = await setup();
    await m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 0, displayMode: "lite", webWindowCap: null, webIdleCloseMin: null });
    await drain(t);
    expect(await docOf(t, deviceId)).toMatchObject({ displayMode: "lite", displayModeSource: "group" });

    expect(await m.as.mutation(api.fleet.setDisplayMode, { deviceId, expectedRevision: 0, displayMode: "standard" })).toEqual({ revision: 1 });
    await drain(t);
    expect(await docOf(t, deviceId)).toMatchObject({ displayMode: "standard", displayModeSource: "device" });
    const detail = await m.as.query(api.fleet.get, { deviceId });
    expect(detail).toMatchObject({ displayMode: "standard", groupDisplayMode: "lite" });

    expect(await m.as.mutation(api.fleet.setDisplayMode, { deviceId, expectedRevision: 1, displayMode: "auto" })).toEqual({ revision: 2 });
    await drain(t);
    expect(await docOf(t, deviceId)).toMatchObject({ displayMode: "lite", displayModeSource: "group" });
    expect(await audits(t, orgId, "device.displayModeChanged")).toEqual([
      expect.stringContaining("to Standard"),
      expect.stringContaining("to automatic (by memory)"),
    ]);
  });

  test("unchanged = no write and no publish; a stale edit is refused; a revoked PC is refused", async () => {
    const { t, deviceId, m } = await setup();
    const { result, io } = await probe(() => m.as.mutation(api.fleet.setDisplayMode, { deviceId, expectedRevision: 0, displayMode: "auto" }));
    expect(result).toEqual({ revision: 0 });
    expect(io.writes).toBe(0);
    await m.as.mutation(api.fleet.setDisplayMode, { deviceId, expectedRevision: 0, displayMode: "lite" });
    await expectCode(m.as.mutation(api.fleet.setDisplayMode, { deviceId, expectedRevision: 0, displayMode: "standard" }), "stale_edit");
    await m.as.mutation(api.fleet.revoke, { deviceId });
    await expectCode(m.as.mutation(api.fleet.setDisplayMode, { deviceId, expectedRevision: 1, displayMode: "standard" }), "conflict");
    void t;
  });

  test("a PC with its own choice and a group with none: only the PC's keys; the group's cap and idle close still reach it", async () => {
    const { t, groupId, deviceId, m } = await setup();
    await m.as.mutation(api.fleet.setDisplayMode, { deviceId, expectedRevision: 0, displayMode: "lite" });
    await m.as.mutation(api.groups.setDisplay, { groupId, expectedRevision: 0, displayMode: "auto", webWindowCap: 6, webIdleCloseMin: 45 });
    await drain(t);
    expect(await docOf(t, deviceId)).toMatchObject({ displayMode: "lite", displayModeSource: "device", webWindowCap: 6, webIdleCloseMin: 45 });
  });
});
