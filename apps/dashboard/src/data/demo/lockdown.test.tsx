import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { demoApi } from "./hooks";
import { demoLockdownApi } from "./lockdown";
import { db, resetDemo, setRoleOverride, setSession } from "./store";
import { DEFAULT_LOCKDOWN_SETTINGS } from "../types";
import { LAYER_STATES, REFUSAL_CODES, layerDetailText, refusalText } from "../../screens/lockdown/codes";

// The demo twin of the lockdown functions (Phase 5 Step 19): the fixtures show every layer state and refusal code, and the
// mutations apply the server's rules (role, revision, the fresh step-up of a mode change, the refusals).

/** Signed in; `fresh: false` = verified 6 minutes ago and active now (unlocked, not fresh). */
function signIn(fresh = true) {
  const m = db().members.find((x) => x.role === "owner")!;
  const now = Date.now();
  setSession({ memberId: m._id, createdAt: now, stepUp: { verifiedAt: fresh ? now : now - 6 * 60_000, lastActiveAt: now, method: "actionPin" } });
}

function start(fresh = true) {
  resetDemo();
  setRoleOverride(null);
  signIn(fresh);
}

async function ready<T extends { status: string }>(result: { current: T }): Promise<Extract<T, { status: "ready" }>> {
  await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 4000 });
  return result.current as Extract<T, { status: "ready" }>;
}

const failure = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; detail?: string; field?: string }) => ({ code: e.code, detail: e.detail, field: e.field }));
const group = (name: string) => db().groups.find((g) => g.name === name)!;

describe("demo fixtures", () => {
  it("show every refusal code and every layer state on some PC, each with a sentence", () => {
    start();
    const reports = [...db().applyDetails.values()];
    const refusals = new Set(reports.filter((r) => r.state === "refused").map((r) => r.refusal));
    for (const code of REFUSAL_CODES) expect(refusals, code).toContain(code);
    const states = new Set(reports.flatMap((r) => Object.values(r.layers).map((l) => l.state)));
    for (const state of ["ok", "partial", "failed", "unsupported", "restartPending", "auditFirst"]) {
      expect(states, state).toContain(state);
      expect(LAYER_STATES[state]).toBeTruthy();
    }
    expect(new Set(reports.map((r) => r.state))).toEqual(new Set(["applied", "partial", "failed", "refused", "rolledBack"]));
    // No fixture code falls back to "Code: ...".
    for (const r of reports) {
      if (r.refusal !== null) expect(layerDetailText(r.refusal) ?? refusalText(r.refusal), r.refusal).not.toMatch(/^Code:/);
      for (const l of Object.values(r.layers)) if (l.detail !== undefined) expect(layerDetailText(l.detail), l.detail).not.toMatch(/^Code:/);
    }
    expect(db().findings.filter((f) => f.status === "new").length).toBeGreaterThan(10);
    expect(db().oldAgents.size).toBe(1);
  });

  it("the overview warns about long audits, paused rollouts and PCs that did not apply the policy (three names each)", async () => {
    start();
    const o = (await ready(renderHook(() => demoApi.useOverview()).result)).data.lockdown!;
    expect(o.auditOverdue.map((g) => g.name)).toEqual(["Pharmacy counter"]);
    expect(o.halted.map((g) => g.name)).toEqual(["Back office"]);
    expect(o.notApplied).toHaveLength(3);
    expect(o.notAppliedMore).toBe(true);
  });

  it("the device page carries the ring, the apply report and the protection", async () => {
    start();
    const d = db().devices.find((x) => x.name === "COUNTER-02")!;
    const detail = (await ready(renderHook(() => demoLockdownApi.useDeviceLockdown(d._id)).result)).data;
    expect(detail).toMatchObject({ ring: "pilot", groupId: d.groupId, revoked: false, rolloutRevision: 3, usbAllowUntil: null, lockdownCapable: true });
    expect(detail.apply?.layers.performance).toEqual({ mode: "on", state: "partial", detail: "no_printing_ignored" });
    expect(detail.protection?.bitLocker).toBe("off");
    const old = db().devices.find((x) => x.name === "LOANER-03")!;
    expect((await ready(renderHook(() => demoLockdownApi.useDeviceLockdown(old._id)).result)).data.lockdownCapable).toBe(false);
  });
});

describe("demo lockdown settings", () => {
  it("a group that never saved shows the defaults at revision 0; a plain switch saves without a fresh step-up", async () => {
    start(false);
    const g = group("Training room");
    const view = renderHook(() => demoLockdownApi.useLockdownView(g._id));
    expect((await ready(view.result)).data).toMatchObject({ settings: DEFAULT_LOCKDOWN_SETTINGS, revision: 0, auditSince: null });
    const save = renderHook(() => demoLockdownApi.useSaveLockdown()).result.current;
    expect(await save({ groupId: g._id, settings: { ...DEFAULT_LOCKDOWN_SETTINGS, accessibilityTools: true }, expectedRevision: 0 })).toEqual({ revision: 1 });
    expect(db().lockdown.get(g._id)?.auditSince).not.toBeNull();
    expect(db().audit.at(-1)?.action).toBe("lockdown.settingsChanged");
    // The same again: nothing changes.
    expect(await save({ groupId: g._id, settings: { ...DEFAULT_LOCKDOWN_SETTINGS, accessibilityTools: true }, expectedRevision: 1 })).toEqual({ revision: 1 });
  });

  it("refuses a stale revision, a low lockout threshold, managed networks without a network, and a viewer", async () => {
    start();
    const g = group("Training room");
    const save = renderHook(() => demoLockdownApi.useSaveLockdown()).result.current;
    const D = DEFAULT_LOCKDOWN_SETTINGS;
    expect(await failure(save({ groupId: g._id, settings: { ...D, accessibilityTools: true }, expectedRevision: 7 }))).toMatchObject({ code: "stale_edit" });
    expect(await failure(save({ groupId: g._id, settings: { ...D, machine: { ...D.machine, accountLockout: { threshold: 3, durationMin: 15, windowMin: 15 } } }, expectedRevision: 0 }))).toMatchObject({
      code: "invalid_argument",
      field: "accountLockout.threshold",
    });
    expect(await failure(save({ groupId: g._id, settings: { ...D, wifiManagedOnly: true }, expectedRevision: 0 }))).toMatchObject({ code: "conflict", detail: "managed_networks_empty" });
    setRoleOverride("viewer");
    expect(await failure(save({ groupId: g._id, settings: { ...D, accessibilityTools: true }, expectedRevision: 0 }))).toMatchObject({ code: "forbidden" });
    setRoleOverride(null);
  });

  it("a mode change with a fresh step-up is saved as a layer-mode change and stops the audit clock when nothing audits", async () => {
    start();
    const g = group("Back office");
    const save = renderHook(() => demoLockdownApi.useSaveLockdown()).result.current;
    const D = DEFAULT_LOCKDOWN_SETTINGS;
    const settings = { ...D, appLocker: { mode: "enforce" as const }, appControl: { mode: "off" as const, level: D.appControl.level }, procWatch: { mode: "enforce" as const } };
    expect(await save({ groupId: g._id, settings, expectedRevision: 1 })).toEqual({ revision: 2 });
    expect(db().lockdown.get(g._id)?.auditSince).toBeNull();
    expect(db().audit.at(-1)?.action).toBe("lockdown.layerModeChanged");
  });
});

describe("demo findings", () => {
  it("pages one status, last seen first", async () => {
    start();
    const first = await ready(renderHook(() => demoLockdownApi.useFindingsPage({ status: "new", numItems: 10, cursor: null })).result);
    expect(first.items).toHaveLength(10);
    expect(first.isDone).toBe(false);
    const times = first.items.map((f) => f.lastSeenAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const ignored = await ready(renderHook(() => demoLockdownApi.useFindingsPage({ status: "ignored", numItems: 10, cursor: null })).result);
    expect(ignored.items.every((f) => f.status === "ignored")).toBe(true);
  });

  it("allow, ignore and remove follow the server's rules", async () => {
    start();
    const allow = renderHook(() => demoLockdownApi.useAllowFinding()).result.current;
    const ignore = renderHook(() => demoLockdownApi.useIgnoreFinding()).result.current;
    const remove = renderHook(() => demoLockdownApi.useRemoveException()).result.current;
    const g = group("Front desk");
    const signed = db().findings.find((f) => f.fileName === "updater.exe")!;
    const unsigned = db().findings.find((f) => f.fileName === "portable-notes.exe")!;
    const appControl = db().findings.find((f) => f.layer === "appControl")!;
    expect(await failure(allow({ findingId: unsigned._id, kind: "publisher", groupIds: [g._id] }))).toMatchObject({ code: "conflict", detail: "no_signer" });
    expect(await failure(allow({ findingId: unsigned._id, kind: "hash", groupIds: [g._id] }))).toMatchObject({ code: "conflict", detail: "no_hash" });
    expect(await failure(allow({ findingId: appControl._id, kind: "publisher", groupIds: [g._id] }))).toMatchObject({ code: "conflict", detail: "app_control_finding" });
    expect(await failure(allow({ findingId: signed._id, kind: "path", folder: "{ProgramFiles}\\Acme", groupIds: [g._id] }))).toMatchObject({ code: "conflict", detail: "path_not_admin_only" });
    // 11 groups at once (ids are checked after the count, as on the server).
    const eleven = Array.from({ length: 11 }, (_, i) => `group-${i}`);
    expect(await failure(allow({ findingId: signed._id, kind: "publisher", groupIds: eleven }))).toMatchObject({ code: "too_large", detail: "groups" });

    expect(await allow({ findingId: signed._id, kind: "publisher", groupIds: [g._id], reason: "Needed" })).toEqual({ added: 1 });
    expect(signed.status).toBe("allowed");
    expect(await allow({ findingId: signed._id, kind: "publisher", groupIds: [g._id] })).toEqual({ added: 0 });
    expect(await failure(ignore({ findingId: signed._id }))).toMatchObject({ code: "conflict", detail: "already_allowed" });
    const row = db().exceptions.find((e) => e.findingId === signed._id)!;
    await remove({ exceptionId: row._id });
    expect(signed.status).toBe("new");
    await ignore({ findingId: unsigned._id });
    expect(unsigned.status).toBe("ignored");
  });
});

describe("demo Allow USB", () => {
  it("1 to 8 whole hours, 0 ends it, a revoked PC is refused", async () => {
    start();
    const allowUsb = renderHook(() => demoLockdownApi.useAllowUsb()).result.current;
    const d = db().devices.find((x) => x.name === "COUNTER-01")!;
    expect(await failure(allowUsb({ deviceId: d._id, hours: 9 }))).toMatchObject({ code: "invalid_argument", field: "hours" });
    expect(await allowUsb({ deviceId: d._id, hours: 0 })).toEqual({ until: null });
    const { until } = await allowUsb({ deviceId: d._id, hours: 8 });
    expect(until).toBeGreaterThan(Date.now() + 7 * 3_600_000);
    expect(db().usbAllow.get(d._id)).toBe(until);
    expect(await allowUsb({ deviceId: d._id, hours: 0 })).toEqual({ until: null });
    expect(db().usbAllow.has(d._id)).toBe(false);
    const revoked = db().devices.find((x) => x.revoked)!;
    expect(await failure(allowUsb({ deviceId: revoked._id, hours: 1 }))).toMatchObject({ code: "conflict" });
  });
});
