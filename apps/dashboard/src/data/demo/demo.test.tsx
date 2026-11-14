import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { demoApi, demoDevicesApi, demoEmployeesApi } from "./hooks";
import { db, resetDemo, setControls, setSession, simulateConcurrentEdit, simulatePublishTrouble } from "./store";
import { errorCodeOf } from "../../lib/errors";

/** Signed in and step-up verified just now (writes need an unlocked session). */
function signInAs(email: string) {
  const m = db().members.find((x) => x.email === email)!;
  const now = Date.now();
  setSession({ memberId: m._id, createdAt: now, stepUp: { verifiedAt: now, lastActiveAt: now, method: "actionPin" } });
}

/** One page of the first query (page 1 of 50 unless said otherwise). */
const Q = { numItems: 50, cursor: null as string | null };

async function ready<T extends { status: string }>(result: { current: T }): Promise<Extract<T, { status: "ready" }>> {
  await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 4000 });
  return result.current as Extract<T, { status: "ready" }>;
}

describe("demo lists follow the server-driven list contract", () => {
  it("pages by cursor with the requested page size, and reports the last page", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const total = db().employees.length;
    const { result, rerender } = renderHook(({ cursor }) => demoEmployeesApi.useEmployeesScreen({ numItems: 25, cursor }), { initialProps: { cursor: null as string | null } });
    const seen: string[] = [];
    let page = await ready(result);
    for (;;) {
      expect(page.items.length).toBeLessThanOrEqual(25);
      seen.push(...page.items.map((e) => e._id));
      if (page.isDone) break;
      const cursor = page.continueCursor;
      rerender({ cursor });
      await waitFor(() => expect(result.current.status === "ready" && result.current.continueCursor !== cursor).toBe(true), { timeout: 4000 });
      page = await ready(result);
    }
    // Every employee exactly once: no row is lost or repeated between pages.
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("sorts on the server by the key and direction asked for, ties by id", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const asc = renderHook(() => demoDevicesApi.useDevicesScreen({ ...Q, sort: { key: "name", dir: "asc" } }));
    const desc = renderHook(() => demoDevicesApi.useDevicesScreen({ ...Q, sort: { key: "name", dir: "desc" } }));
    const a = (await ready(asc.result)).items.map((d) => d.name);
    const d = (await ready(desc.result)).items.map((x) => x.name);
    expect(a).toEqual([...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    expect(d).toEqual([...d].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0)));
    expect(a[0]).not.toBe(d[0]);
    const newest = renderHook(() => demoDevicesApi.useDevicesScreen(Q));
    const times = (await ready(newest.result)).items.map((x) => x.enrolledAt);
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it("the last page is the same list read in the opposite order with total mod pageSize rows", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const count = renderHook(() => demoDevicesApi.useDevicesCount({}));
    await waitFor(() => expect(count.result.current).toBe(db().devices.length), { timeout: 4000 });
    const total = db().devices.length;
    const size = 25;
    const sort = { key: "name", dir: "asc" as const };
    const last = renderHook(() => demoDevicesApi.useDevicesScreen({ numItems: total % size || size, cursor: null, sort: { ...sort, dir: "desc" } }));
    const rows = (await ready(last.result)).items.map((x) => x.name).reverse();
    const everything = renderHook(() => demoDevicesApi.useDevicesScreen({ numItems: 50, cursor: null, sort }));
    expect(rows).toHaveLength(total % size || size);
    // The tail of the ascending order is what the reverse read returns once the screen reverses it.
    const all = db().devices.map((x) => x.name).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    expect(rows).toEqual(all.slice(total - rows.length));
    expect((await ready(everything.result)).items).toHaveLength(50);
  });

  it("a search is ordered by relevance (sort ignored) and has no total; counts are null for one group", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const search = renderHook(() => demoDevicesApi.useDevicesScreen({ ...Q, search: "warehouse", sort: { key: "name", dir: "desc" } }));
    const names = (await ready(search.result)).items.map((x) => x.name);
    expect(names.length).toBeGreaterThan(1);
    expect(names[0]!.toLowerCase().startsWith("warehouse")).toBe(true);
    const counts = [
      renderHook(() => demoDevicesApi.useDevicesCount({ search: "warehouse" })),
      renderHook(() => demoDevicesApi.useDevicesCount({ groupId: db().groups[0]!._id })),
      renderHook(() => demoDevicesApi.useDevicesCount({ groupId: "none" })),
      renderHook(() => demoEmployeesApi.useEmployeesCount({})),
      renderHook(() => demoEmployeesApi.useEmployeesCount({ search: "a" })),
    ];
    await waitFor(() => expect(counts.every((c) => c.result.current !== undefined)).toBe(true), { timeout: 4000 });
    expect(counts.map((c) => c.result.current)).toEqual([null, null, db().devices.filter((d) => !d.groupId).length, db().employees.length, null]);
  });

  it("groups are a bounded list: offset cursors, the exact total in the page, contains-search", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const groups = db().groups.length;
    expect(groups).toBeGreaterThanOrEqual(12);
    const first = renderHook(() => demoApi.useGroupsPage({ numItems: 10, cursor: null }));
    const p1 = await ready(first.result);
    expect(p1).toMatchObject({ total: groups, isDone: false, continueCursor: "o:10" });
    expect(p1.items.map((g) => g.name)).toEqual([...p1.items.map((g) => g.name)].sort((x, y) => (x < y ? -1 : 1)));
    const second = renderHook(() => demoApi.useGroupsPage({ numItems: 10, cursor: "o:10" }));
    const p2 = await ready(second.result);
    expect(p2.items).toHaveLength(groups - 10);
    expect(p2.isDone).toBe(true);
    const found = renderHook(() => demoApi.useGroupsPage({ numItems: 10, cursor: null, search: "RECEPT" }));
    const f = await ready(found.result);
    expect(f.items.map((g) => g.name)).toEqual(["Reception"]);
    expect(f.total).toBe(1);
    const bad = renderHook(() => demoApi.useGroupsPage({ numItems: 10, cursor: null, sort: { key: "devices", dir: "asc" } }));
    await waitFor(() => expect(bad.result.current.status).toBe("error"), { timeout: 4000 });
  });

  it("a group's members are listed in the order they were added only; the picker is a bounded search", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const front = db().groups.find((g) => g.name === "Front desk")!;
    const named = renderHook(() => demoEmployeesApi.useEmployeesScreen({ ...Q, groupId: front._id, sort: { key: "name", dir: "asc" } }));
    await waitFor(() => expect(named.result.current.status).toBe("error"), { timeout: 4000 });
    const pick = renderHook(() => demoEmployeesApi.useEmployeePicker("mar"));
    await waitFor(() => expect(pick.result.current.status).toBe("ready"), { timeout: 4000 });
    const p = pick.result.current;
    expect(p.status === "ready" && p.data.rows.length > 0 && p.data.rows.length <= 50).toBe(true);
    expect(renderHook(() => demoEmployeesApi.useEmployeePicker("  ")).result.current).toEqual({ status: "ready", data: { rows: [], capped: false } });
  });
});

describe("demo data layer", () => {
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

  it("web app permissions (Step 11): fixtures carry 30-day counts, a save follows apps:setPermissions, new sites allow printing", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const pos = db().apps.find((a) => a.name === "Point of Sale")!;
    const detail = renderHook(() => demoApi.useAppDetail(pos._id));
    expect((await ready(detail.result)).data.denials30d).toEqual([{ kind: "microphone", count: 41 }, { kind: "camera", count: 12 }]);
    const reader = db().apps.find((a) => a.kind === "desktop")!;
    expect((await ready(renderHook(() => demoApi.useAppDetail(reader._id)).result)).data.denials30d).toEqual([]);

    const save = renderHook(() => demoApi.useSetAppPermissions()).result.current;
    const next = { ...pos.web!.permissions, microphone: true };
    expect(await save({ appId: pos._id, expectedRevision: pos.revision + 5, permissions: next }).catch((e) => e)).toMatchObject({ code: "stale_edit" });
    const before = pos.revision;
    expect(await save({ appId: pos._id, expectedRevision: before, permissions: next })).toEqual({ revision: before + 1 });
    expect(db().apps.find((a) => a._id === pos._id)!.web!.permissions.microphone).toBe(true);
    expect(db().audit.some((e) => e.action === "app.permissionsChanged" && e.targetId === pos._id)).toBe(true);
    // the same permissions again: nothing changes
    expect(await save({ appId: pos._id, expectedRevision: before + 1, permissions: next })).toEqual({ revision: before + 1 });
    // a program has none; a viewer cannot save
    expect(await save({ appId: reader._id, expectedRevision: reader.revision, permissions: next }).catch((e) => e)).toMatchObject({ code: "invalid_argument", field: "appId" });

    const create = renderHook(() => demoApi.useCreateWebApp()).result.current;
    const id = await create({ name: "Meet", url: "https://meet.example.com", allowedDomains: [] });
    expect(db().apps.find((a) => a._id === id)!.web!.permissions).toMatchObject({ printing: true, camera: false, notifications: true });

    signInAs("auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test");
    expect(errorCodeOf(await save({ appId: pos._id, expectedRevision: before + 1, permissions: { ...next, camera: true } }).catch((e) => e))).toBe("forbidden");
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
    const list = renderHook(() => demoDevicesApi.useDevicesScreen(Q));
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
    const list = renderHook(() => demoDevicesApi.useDevicesScreen({ ...Q, search: name.slice(0, 5) }));
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
    const { result } = renderHook(() => demoDevicesApi.useDevicesScreen({ ...Q, groupId: "none" }));
    await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 3000 });
    const r = result.current;
    if (r.status !== "ready") throw new Error();
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((d) => d.groupId === undefined)).toBe(true);
    expect(r.items.length).toBe(db().devices.filter((d) => !d.groupId).length);

    const all = renderHook(() => demoDevicesApi.useDevicesScreen({ ...Q, search: "WAREHOUSE-01" }));
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