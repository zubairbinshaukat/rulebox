import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { demoApi, demoDevicesApi, demoEmployeesApi } from "./hooks";
import { db, resetDemo, setControls, setSession, simulateConcurrentEdit, simulatePublishTrouble } from "./store";
import { errorCodeOf } from "../../lib/errors";

/** Signed in, MFA passed and step-up verified just now (writes need an unlocked session). */
function signInAs(email: string) {
  const m = db().members.find((x) => x.email === email)!;
  const now = Date.now();
  setSession({ memberId: m._id, mfaVerified: true, createdAt: now, stepUp: { verifiedAt: now, lastActiveAt: now, method: "actionPin" } });
}

describe("demo data layer", () => {
  it("paginates 50 at a time and reports exhaustion", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const { result } = renderHook(() => demoEmployeesApi.useEmployeesScreen({}));
    await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 3000 });
    const total = db().employees.length; // 140
    let loaded = 50;
    while (true) {
      const r = result.current;
      if (r.status !== "ready") throw new Error("not ready");
      expect(r.items).toHaveLength(Math.min(loaded, total));
      if (!r.canLoadMore) break;
      act(() => r.loadMore());
      loaded += 50;
      await waitFor(() => {
        const s = result.current;
        expect(s.status === "ready" && !s.isLoadingMore && s.items.length === Math.min(loaded, total)).toBe(true);
      }, { timeout: 3000 });
    }
    expect(loaded).toBeGreaterThanOrEqual(total);
  });

  it("refuses a save after someone else's edit (stale_edit)", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const { result } = renderHook(() => demoApi.useUpdateSettings());
    const revision = db().org.revision;
    simulateConcurrentEdit();
    const error = await result.current({ expectedRevision: revision, name: "X", settings: db().org.settings }).catch((e) => e);
    expect(errorCodeOf(error)).toBe("stale_edit");
    const before = db().org.revision;
    await expect(result.current({ expectedRevision: before, name: "X", settings: db().org.settings })).resolves.toEqual({ revision: before + 1, changed: ["name"] });
    expect(db().org.name).toBe("X");
    // Nothing changed: no write, same revision (settings:update).
    await expect(result.current({ expectedRevision: before + 1, name: "X", settings: db().org.settings })).resolves.toEqual({ revision: before + 1, changed: [] });
  });

  it("follows the server's settings, exit PIN and group rules", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const update = renderHook(() => demoApi.useUpdateSettings()).result.current;
    const s = db().org.settings;
    const bad = await update({ expectedRevision: db().org.revision, name: db().org.name, settings: { ...s, adminExit: { enabled: true, hotkey: "Alt+Tab" } } }).catch((e) => e);
    expect(bad).toMatchObject({ code: "invalid_argument", field: "adminExit.hotkey", detail: "UnknownToken" });
    const ok = await update({ expectedRevision: db().org.revision, name: db().org.name, settings: { ...s, adminExit: { enabled: true, hotkey: "alt+f4" } } });
    expect(ok.changed).toEqual(["adminExit"]);
    expect(db().org.settings.adminExit.hotkey).toBe("Alt+F4");

    const setPin = renderHook(() => demoApi.useSetExitPin()).result.current;
    expect(await setPin({ pin: "111111" }).catch((e) => e)).toMatchObject({ code: "invalid_argument", field: "pin", detail: "all digits the same" });
    await setPin({ pin: "246813" });
    expect(db().org.exitPinSetAt).toBeGreaterThan(0);

    const create = renderHook(() => demoApi.useCreateGroup()).result.current;
    expect(await create({ name: "Front desk" }).catch((e) => e)).toMatchObject({ code: "conflict", field: "name" });
    db().org.plan.limits.maxGroups = db().groups.length;
    expect(await create({ name: "One too many" }).catch((e) => e)).toMatchObject({ code: "plan_limit", detail: "groups" });

    const del = renderHook(() => demoApi.useDeleteGroup()).result.current;
    const front = db().groups.find((g) => g.name === "Front desk")!;
    const refused: unknown = await del({ groupId: front._id }).catch((e) => e);
    expect(refused).toMatchObject({ code: "has_dependents" });
    expect((refused as { detail?: string }).detail).toContain("devices");
  });

  it("refuses writes from viewers (forbidden)", async () => {
    resetDemo();
    signInAs("auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test");
    const { result } = renderHook(() => demoApi.useCreateGroup());
    const error = await result.current({ name: "Nope" }).catch((e) => e);
    expect(errorCodeOf(error)).toBe("forbidden");
  });

  it("queues writes while disconnected and sends them on reconnect", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    setControls({ offline: true });
    const { result } = renderHook(() => demoApi.useCreateGroup());
    let done = false;
    const p = result.current({ name: "Queued group" }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 700));
    expect(done).toBe(false);
    setControls({ offline: false });
    await p;
    expect(db().groups.some((g) => g.name === "Queued group")).toBe(true);
  });

  it("caps group counts at 501 (shown as 500+)", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const { result } = renderHook(() => demoApi.useGroupsScreen());
    await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 3000 });
    const r = result.current;
    if (r.status !== "ready") throw new Error();
    expect(r.data.find((g) => g.name === "Front desk")!.deviceCount).toBe(501);
  });
});

describe("demo devices (plan Step 7)", () => {
  it("rows and the detail carry the presence transition: online PCs, offline since, revoked", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const list = renderHook(() => demoDevicesApi.useDevicesScreen({}));
    await waitFor(() => expect(list.result.current.status).toBe("ready"), { timeout: 3000 });
    const r = list.result.current;
    if (r.status !== "ready") throw new Error();
    const online = r.items.find((d) => d.presence.online)!;
    expect(online.revoked).toBe(false);
    const revoked = r.items.find((d) => d.revoked)!;
    expect(revoked.presence.online).toBe(false);
    const detail = renderHook(() => demoApi.useDeviceDetail(online._id));
    await waitFor(() => expect(detail.result.current.status).toBe("ready"), { timeout: 3000 });
    const d = detail.result.current;
    expect(d.status === "ready" && d.data.presence.online).toBe(true);
  });

  it("search is the list's own argument", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const name = db().devices[0]!.name;
    const list = renderHook(() => demoDevicesApi.useDevicesScreen({ search: name.slice(0, 5) }));
    await waitFor(() => expect(list.result.current.status).toBe("ready"), { timeout: 3000 });
    const r = list.result.current;
    expect(r.status === "ready" && r.items.some((d) => d.name === name)).toBe(true);
    expect(r.status === "ready" && r.items.every((d) => d.name.toLowerCase().includes(name.slice(0, 5).toLowerCase()))).toBe(true);
  });

  it("kiosk, move and rename check the revision; remove needs a revoked PC (conflict)", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const d = db().devices.find((x) => !x.revoked && x.groupId)!;
    const kiosk = renderHook(() => demoApi.useSetKiosk()).result.current;
    expect(await kiosk({ deviceId: d._id, expectedRevision: d.revision + 1, enabled: false }).catch((e) => e)).toMatchObject({ code: "stale_edit" });
    const before = d.revision;
    await kiosk({ deviceId: d._id, expectedRevision: before, enabled: false });
    expect(d.kioskEnabled).toBe(false);
    expect(d.revision).toBe(before + 1);
    const remove = renderHook(() => demoApi.useRemoveDevice()).result.current;
    expect(await remove({ deviceId: d._id }).catch((e) => e)).toMatchObject({ code: "conflict" });
    await renderHook(() => demoApi.useRevokeDevice()).result.current({ deviceId: d._id });
    await remove({ deviceId: d._id });
    expect(db().devices.some((x) => x._id === d._id)).toBe(false);
  });

  it("check now: admins only, up to 50 PCs, one a minute; online PCs answer", async () => {
    resetDemo();
    signInAs("auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test");
    const viewerCheck = renderHook(() => demoApi.useCheckNow()).result.current;
    expect(await viewerCheck({ deviceIds: [db().devices[0]!._id] }).catch((e) => e)).toMatchObject({ code: "forbidden" });

    signInAs("owner@demo.rulebox.test");
    const check = renderHook(() => demoApi.useCheckNow()).result.current;
    expect(await check({ deviceIds: [] }).catch((e) => e)).toMatchObject({ code: "invalid_argument", field: "deviceIds" });
    expect(await check({ deviceIds: db().devices.slice(0, 51).map((x) => x._id) }).catch((e) => e)).toMatchObject({ code: "invalid_argument" });
    const online = [...db().onlineIds][0]!;
    const off = db().devices.find((x) => !db().onlineIds.has(x._id))!;
    const { checkId } = await check({ deviceIds: [online, off._id] });
    expect(await check({ deviceIds: [online] }).catch((e) => e)).toMatchObject({ code: "rate_limited" });
    const result = renderHook(() => demoApi.useCheckResult(checkId));
    await waitFor(() => expect(result.result.current.status).toBe("ready"), { timeout: 3000 });
    const r = result.result.current;
    expect(r.status === "ready" && r.data.items).toEqual([
      { deviceId: online, answered: true },
      { deviceId: off._id, answered: false },
    ]);
  });

  it("watch mode extends only by two minutes or more", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const id = [...db().onlineIds][0]!;
    const watch = renderHook(() => demoApi.useWatchDevice()).result.current;
    const first = await watch({ deviceId: id });
    expect(first.fastUntil).toBeGreaterThan(Date.now());
    await expect(watch({ deviceId: id })).resolves.toEqual(first);
  });
});
describe("demo: Step 17 follow-ups", () => {
  it("lists the PCs without a group for groupId none, and badges plan states", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const { result } = renderHook(() => demoDevicesApi.useDevicesScreen({ groupId: "none" }));
    await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 3000 });
    const r = result.current;
    if (r.status !== "ready") throw new Error();
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((d) => d.groupId === undefined)).toBe(true);
    expect(r.items.length).toBe(db().devices.filter((d) => !d.groupId).length);

    const all = renderHook(() => demoDevicesApi.useDevicesScreen({ search: "WAREHOUSE-01" }));
    await waitFor(() => expect(all.result.current.status).toBe("ready"), { timeout: 3000 });
    const row = all.result.current.status === "ready" ? all.result.current.items[0] : undefined;
    expect(row?.planState).toBe("overLimit");
  });

  it("publish failed and a waiting roster update show on the overview and keys, and Publish again clears both", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    simulatePublishTrouble("publish");
    simulatePublishTrouble("roster");
    const overview = renderHook(() => demoApi.useOverview());
    await waitFor(() => expect(overview.result.current.status).toBe("ready"), { timeout: 3000 });
    if (overview.result.current.status !== "ready") throw new Error();
    expect(overview.result.current.data.publishFailedAt).not.toBeNull();
    expect(overview.result.current.data.rosterPending).toBe(true);

    const again = renderHook(() => demoApi.usePublishAgain()).result.current;
    await again();
    expect(db().publishFailedAt).toBeUndefined();
    expect(db().rosterPending).toBe(false);
    await waitFor(() => {
      const o = overview.result.current;
      expect(o.status === "ready" && o.data.publishFailedAt === null && !o.data.rosterPending).toBe(true);
    });
  });

  it("Publish again is for Owners and needs a key on the deployment", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    db().env.key = false;
    const again = renderHook(() => demoApi.usePublishAgain()).result.current;
    expect(errorCodeOf(await again().catch((e) => e))).toBe("not_ready");
    resetDemo();
    signInAs("auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test");
    const asViewer = renderHook(() => demoApi.usePublishAgain()).result.current;
    expect(errorCodeOf(await asViewer().catch((e) => e))).toBe("forbidden");
  });

  it("the install summary says capped when a state has more results than the server reads", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    // The default fixtures stay under the cap (a PC has one result per app), so add enough results for one app.
    const app = db().apps.find((a) => a.kind === "desktop")!;
    const device = db().devices[0]!;
    for (let n = 0; n < 1100; n++) db().installs.push({ _id: `ins_x${n}`, deviceId: device._id, appId: app._id, state: "installed", attempts: 1, updatedAt: Date.now() });
    const big = renderHook(() => demoApi.useAppInstallSummary(app._id));
    await waitFor(() => expect(big.result.current.status).toBe("ready"), { timeout: 3000 });
    if (big.result.current.status !== "ready") throw new Error();
    expect(big.result.current.data.installed).toBe(1001);
    expect(big.result.current.data.capped).toBe(true);

    resetDemo();
    const small = renderHook(() => demoApi.useAppInstallSummary(app._id));
    await waitFor(() => expect(small.result.current.status).toBe("ready"), { timeout: 3000 });
    if (small.result.current.status !== "ready") throw new Error();
    expect(small.result.current.data.capped).toBeUndefined();
  });
});