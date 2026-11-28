import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { demoApi, demoAuditApi, demoDevicesApi, demoEmployeesApi } from "./hooks";
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

  it("Wi-Fi networks (Step 13): create, edit, set a password, delete; the password is never kept; the rules follow the server", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const list = renderHook(() => demoApi.useNetworks());
    const first = (await ready(list.result)).data.wifi;
    expect(first.map((w) => w.name)).toEqual(["Back office (hidden)", "Shop floor", "Training room"]);
    // No row, whatever its security, carries more than the fact that a password is set.
    expect(JSON.stringify(first)).not.toMatch(/passphrase"?:\s*"/i);

    const save = renderHook(() => demoApi.useSaveWifi()).result.current;
    const setPassphrase = renderHook(() => demoApi.useSetWifiPassphrase()).result.current;
    const groupId = db().groups[0]!._id;
    const input = { name: "Guest", ssid: "Café-Gäste", hidden: false, security: "wpa2Personal" as const, autoConnect: true, groupIds: [groupId] };
    const created = await save(input);
    expect(created.revision).toBe(1);
    expect(db().audit.some((e) => e.action === "wifi.created" && e.targetId === created.id)).toBe(true);
    const detail = renderHook(() => demoApi.useWifiDetail(created.id));
    expect((await ready(detail.result)).data).toMatchObject({ hasPassphrase: false, passphraseSetAt: null, groupIds: [groupId], groupCount: 1 });

    // Rules: 32 BYTES of SSID (not characters), control characters, groups, stale edits.
    expect(await save({ ...input, ssid: "é".repeat(17) }).catch((e) => e)).toMatchObject({ code: "invalid_argument", field: "ssid" });
    expect(await save({ ...input, ssid: "a\nb" }).catch((e) => e)).toMatchObject({ code: "invalid_argument", field: "ssid" });
    expect(await save({ ...input, name: "  " }).catch((e) => e)).toMatchObject({ code: "invalid_argument", field: "name" });
    expect(await save({ ...input, groupIds: ["nope"] }).catch((e) => e)).toMatchObject({ code: "not_found" });
    expect(await save({ ...input, id: created.id, expectedRevision: 9 }).catch((e) => e)).toMatchObject({ code: "stale_edit" });
    const eleven = db().groups.slice(0, 11).map((g) => g._id);
    expect(eleven).toHaveLength(11);
    // Step 20b: more than 10 groups is fine (the server snapshots the rest in scheduled batches); more than 100 is refused.
    expect(await save({ ...input, groupIds: Array.from({ length: 101 }, (_, i) => `g${i}`) }).catch((e) => e)).toMatchObject({ code: "invalid_argument", field: "groupIds", detail: "too_many" });
    const wide = await save({ ...input, name: "Wide", groupIds: eleven });
    expect(wide).toMatchObject({ revision: 1 });
    expect(await save({ ...input, id: wide.id, expectedRevision: 1, name: "Wide", groupIds: [...eleven.slice(1, 11)] })).toEqual({ id: wide.id, revision: 2 });
    expect(await save({ ...input, id: wide.id, expectedRevision: 2, name: "Wide", groupIds: [...eleven.slice(1, 11)] })).toEqual({ id: wide.id, revision: 2 }); // nothing changed: allowed

    // No change: no new revision. A change bumps it and audits.
    expect(await save({ ...input, id: created.id, expectedRevision: 1 })).toEqual({ id: created.id, revision: 1 });
    expect(await save({ ...input, id: created.id, expectedRevision: 1, hidden: true })).toEqual({ id: created.id, revision: 2 });
    expect(db().audit.some((e) => e.action === "wifi.updated" && e.targetId === created.id)).toBe(true);

    // The password: validated, stored as a fact only, the revision moves, the audit row says nothing about the text.
    expect(await setPassphrase({ id: created.id, passphrase: "short", expectedRevision: 2 }).catch((e) => e)).toMatchObject({ code: "invalid_argument", field: "passphrase", detail: "length" });
    expect(await setPassphrase({ id: created.id, passphrase: "pässwörd-123", expectedRevision: 2 }).catch((e) => e)).toMatchObject({ field: "passphrase", detail: "characters" });
    const secret = "correct horse battery";
    expect(await setPassphrase({ id: created.id, passphrase: secret, expectedRevision: 2 })).toEqual({ revision: 3 });
    expect(await setPassphrase({ id: created.id, passphrase: "a".repeat(64), expectedRevision: 3 })).toEqual({ revision: 4 });
    expect(await setPassphrase({ id: created.id, passphrase: secret, expectedRevision: 3 }).catch((e) => e)).toMatchObject({ code: "stale_edit" });
    const row = db().wifi.find((w) => w._id === created.id)!;
    expect(row.hasPassphrase).toBe(true);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(db().audit)).not.toContain(secret);
    const openId = (await save({ ...input, name: "Open", security: "open" as const })).id;
    expect(await setPassphrase({ id: openId, passphrase: secret, expectedRevision: 1 }).catch((e) => e)).toMatchObject({ code: "invalid_argument", field: "id", detail: "open" });

    // Counts follow the assigned groups; delete removes the profile and its group chips.
    const counts = (await ready(renderHook(() => demoApi.useWifiDetail(created.id)).result)).data.counts;
    expect(counts.applied + counts.failed + counts.waiting + counts.unsupported).toBe(counts.sampled);
    await renderHook(() => demoApi.useDeleteWifi()).result.current({ id: created.id });
    expect(db().wifi.some((w) => w._id === created.id)).toBe(false);
    expect(db().audit.some((e) => e.action === "wifi.deleted" && e.targetId === created.id)).toBe(true);
    expect(await renderHook(() => demoApi.useDeleteWifi()).result.current({ id: created.id }).catch((e) => e)).toMatchObject({ code: "not_found" });
    // Every demo write waits ~300 ms like a network call: this test makes about twenty.
  }, 30_000);

  it("Wi-Fi networks: a viewer reads but cannot write; at most 50 networks", async () => {
    resetDemo();
    signInAs("auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test");
    const input = { name: "X", ssid: "X", hidden: false, security: "open" as const, autoConnect: true, groupIds: [] };
    expect(errorCodeOf(await renderHook(() => demoApi.useSaveWifi()).result.current(input).catch((e) => e))).toBe("forbidden");
    expect(errorCodeOf(await renderHook(() => demoApi.useSetWifiPassphrase()).result.current({ id: db().wifi[0]!._id, passphrase: "correct horse", expectedRevision: 1 }).catch((e) => e))).toBe("forbidden");
    expect((await ready(renderHook(() => demoApi.useNetworks()).result)).data.wifi).toHaveLength(3);
    signInAs("owner@demo.rulebox.test");
    const save = renderHook(() => demoApi.useSaveWifi()).result.current;
    while (db().wifi.length < 50) db().wifi.push({ ...db().wifi[0]!, _id: `fill${db().wifi.length}`, groupIds: [] });
    expect(await save(input).catch((e) => e)).toMatchObject({ code: "too_large", detail: "wifi" });
  });

  it("printers (Step 14): create, edit, delete; the driver must be approved; names and defaults are unique; the rules follow the server", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const list = (await ready(renderHook(() => demoApi.useNetworks()).result)).data;
    expect(list.printers.map((p) => p.name)).toEqual(["Front desk", "Office laser", "Warehouse label printer"]);
    expect(list.approvedDrivers).toEqual(["Microsoft IPP Class Driver", "Microsoft PCL6 Class Driver", "Microsoft PS Class Driver", "Generic / Text Only", "Brother HL-L2350DW series"]);

    const save = renderHook(() => demoApi.useSavePrinter()).result.current;
    // The first group is where "Front desk" is already the default; the second has no default printer.
    const [g1, g2] = db().groups.map((g) => g._id);
    const input = { name: "Reception", kind: "ipp" as const, address: "ipp://10.0.30.5/ipp/print", driver: "Microsoft IPP Class Driver", groupIds: [g2!], defaultForGroupIds: [] as string[] };
    const created = await save(input);
    expect(created.revision).toBe(1);
    expect(db().audit.some((e) => e.action === "printer.created" && e.targetId === created.id)).toBe(true);
    expect((await ready(renderHook(() => demoApi.usePrinterDetail(created.id)).result)).data).toMatchObject({ groupIds: [g2], defaultForGroupIds: [], port: null, queue: null });

    const bad = async (over: object) => ((await save({ ...input, ...over }).catch((e) => e)) as { code: string; field?: string; detail?: string });
    expect(await bad({ driver: "HP Evil Driver" })).toMatchObject({ code: "invalid_argument", field: "driver", detail: "not_approved" });
    expect(await bad({ address: "ipp://u:p@10.0.0.1/ipp/print" })).toMatchObject({ field: "address", detail: "credentials" });
    expect(await bad({ kind: "raw", address: "10.0.0.1", port: 70000 })).toMatchObject({ field: "port" });
    expect(await bad({ kind: "lpr", address: "10.0.0.1" })).toMatchObject({ field: "queue", detail: "required" });
    expect(await bad({ name: "A\\B" })).toMatchObject({ field: "name", detail: "characters" });
    expect(await bad({ name: "front DESK" })).toMatchObject({ field: "name", detail: "taken" });
    expect(await bad({ defaultForGroupIds: [g1!] })).toMatchObject({ field: "defaultForGroupIds", detail: "not_assigned" });
    expect(await bad({ groupIds: ["nope"] })).toMatchObject({ code: "not_found" });
    // "Front desk" is already the default of its group: a second default there is refused.
    const front = db().printers.find((p) => p.name === "Front desk")!;
    const frontGroup = front.defaultForGroupIds[0]!;
    expect(await bad({ name: "Second", groupIds: [frontGroup], defaultForGroupIds: [frontGroup] })).toMatchObject({ field: "defaultForGroupIds", detail: "taken" });
    expect(await save({ ...input, id: created.id, expectedRevision: 9 }).catch((e) => e)).toMatchObject({ code: "stale_edit" });
    const eleven = db().groups.slice(0, 11).map((g) => g._id);
    expect(await bad({ name: "Wide", groupIds: Array.from({ length: 101 }, (_, i) => `g${i}`) })).toMatchObject({ code: "invalid_argument", field: "groupIds", detail: "too_many" });
    expect(eleven).toHaveLength(11); // more than 10 groups is fine now (Step 20b)

    // No change: no new revision. A change bumps it and audits.
    expect(await save({ ...input, id: created.id, expectedRevision: 1 })).toEqual({ id: created.id, revision: 1 });
    expect(await save({ ...input, id: created.id, expectedRevision: 1, name: "Reception desk", defaultForGroupIds: [g2!] })).toEqual({ id: created.id, revision: 2 });
    expect(db().audit.some((e) => e.action === "printer.updated" && e.targetId === created.id)).toBe(true);
    const raw = await save({ name: "Labels", kind: "raw", address: "10.0.30.6", port: 9101, driver: "generic / text only", groupIds: [], defaultForGroupIds: [] });
    expect(db().printers.find((p) => p._id === raw.id)).toMatchObject({ port: 9101, queue: null, driver: "Generic / Text Only" });

    // Deleting a group takes it out of the printers; delete removes the printer.
    await renderHook(() => demoApi.useDeletePrinter()).result.current({ id: created.id });
    expect(db().printers.some((p) => p._id === created.id)).toBe(false);
    expect(db().audit.some((e) => e.action === "printer.deleted" && e.targetId === created.id)).toBe(true);
    expect(await renderHook(() => demoApi.useDeletePrinter()).result.current({ id: created.id }).catch((e) => e)).toMatchObject({ code: "not_found" });
  }, 30_000);

  it("printers: a viewer reads but cannot write; at most 100 printers", async () => {
    resetDemo();
    signInAs("auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test");
    const input = { name: "X", kind: "raw" as const, address: "10.0.0.9", driver: "Generic / Text Only", groupIds: [], defaultForGroupIds: [] };
    expect(errorCodeOf(await renderHook(() => demoApi.useSavePrinter()).result.current(input).catch((e) => e))).toBe("forbidden");
    expect(errorCodeOf(await renderHook(() => demoApi.useDeletePrinter()).result.current({ id: db().printers[0]!._id }).catch((e) => e))).toBe("forbidden");
    expect((await ready(renderHook(() => demoApi.useNetworks()).result)).data.printers).toHaveLength(3);
    signInAs("owner@demo.rulebox.test");
    while (db().printers.length < 100) db().printers.push({ ...db().printers[0]!, _id: `fill${db().printers.length}`, name: `Fill ${db().printers.length}`, groupIds: [], defaultForGroupIds: [] });
    expect(await renderHook(() => demoApi.useSavePrinter()).result.current(input).catch((e) => e)).toMatchObject({ code: "too_large", detail: "printers" });
  });

  it("drivers (Step 14b): create, edit, retry, delete; the rules follow the server; delivered names reach the printer picker", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const list = (await ready(renderHook(() => demoApi.useNetworks()).result)).data;
    expect(list.drivers.map((d) => d.name)).toEqual(["Brother laser printer driver", "Flatbed scanner"]);
    expect(list.addedDrivers).toEqual([]);

    const save = renderHook(() => demoApi.useSaveDriver()).result.current;
    const [g1, g2] = db().groups.map((g) => g._id);
    const input = {
      name: "Zebra labels",
      kind: "inf" as const,
      deviceClass: "printer" as const,
      url: "https://downloads.example.test/zebra.zip",
      sha256: "AB".repeat(32),
      sizeBytes: 1000,
      inf: "zebra\\zd.inf",
      silentArgs: [] as string[],
      successExitCodes: [] as number[],
      provides: ["ZDesigner ZD420", "zdesigner zd420", "  "],
      groupIds: [g2!],
    };
    const created = await save(input);
    expect(created.revision).toBe(1);
    expect(db().drivers.find((d) => d._id === created.id)).toMatchObject({ sha256: "ab".repeat(32), provides: ["ZDesigner ZD420"], inf: "zebra\\zd.inf" });
    expect(db().audit.some((e) => e.action === "driver.created" && e.targetId === created.id)).toBe(true);
    expect((await ready(renderHook(() => demoApi.useNetworks()).result)).data.approvedDrivers).toContain("ZDesigner ZD420");

    const bad = async (over: object) => (await save({ ...input, ...over }).catch((e) => e)) as { code: string; field?: string; detail?: string };
    expect(await bad({ name: "" })).toMatchObject({ field: "name", detail: "empty" });
    expect(await bad({ name: "brother LASER printer driver" })).toMatchObject({ field: "name", detail: "taken" });
    expect(await bad({ url: "http://x.test/a.zip" })).toMatchObject({ field: "url", detail: "scheme" });
    expect(await bad({ sha256: "abc" })).toMatchObject({ field: "sha256", detail: "format" });
    expect(await bad({ sizeBytes: 5 * 1024 * 1024 * 1024 })).toMatchObject({ field: "sizeBytes" });
    expect(await bad({ inf: "..\\evil.inf" })).toMatchObject({ field: "inf", detail: "path" });
    expect(await bad({ inf: "zd.txt" })).toMatchObject({ field: "inf", detail: "extension" });
    expect(await bad({ kind: "exe", inf: undefined })).toMatchObject({ field: "silentArgs", detail: "required" });
    expect(await bad({ inf: "x.inf", kind: "msi" })).toMatchObject({ field: "inf", detail: "not_allowed" });
    expect(await bad({ kind: "exe", inf: undefined, silentArgs: ["/S"], successExitCodes: Array.from({ length: 9 }, (_, i) => i) })).toMatchObject({ field: "successExitCodes" });
    expect(await bad({ provides: Array.from({ length: 11 }, (_, i) => `n${i}`) })).toMatchObject({ field: "provides", detail: "count" });
    expect(await bad({ groupIds: ["nope"] })).toMatchObject({ code: "not_found" });
    expect(await bad({ name: "Wide", groupIds: Array.from({ length: 101 }, (_, i) => `g${i}`) })).toMatchObject({ code: "invalid_argument", field: "groupIds", detail: "too_many" });
    expect(await save({ ...input, id: created.id, expectedRevision: 9 }).catch((e) => e)).toMatchObject({ code: "stale_edit" });

    // No change: no new revision. A change bumps it and audits. Retry bumps it too.
    expect(await save({ ...input, id: created.id, expectedRevision: 1 })).toEqual({ id: created.id, revision: 1 });
    expect(await save({ ...input, id: created.id, expectedRevision: 1, groupIds: [g1!, g2!] })).toEqual({ id: created.id, revision: 2 });
    expect(db().audit.some((e) => e.action === "driver.updated" && e.targetId === created.id)).toBe(true);
    await renderHook(() => demoApi.useRetryDriver()).result.current({ id: created.id });
    expect(db().drivers.find((d) => d._id === created.id)!.revision).toBe(3);
    expect(db().audit.some((e) => e.action === "driver.retried" && e.targetId === created.id)).toBe(true);
    const exe = await save({ ...input, name: "Scanner two", kind: "exe", inf: undefined, silentArgs: ["/S"], successExitCodes: [3010, 0, 3010] });
    expect((await ready(renderHook(() => demoApi.useDriverDetail(exe.id)).result)).data).toMatchObject({ kind: "exe", inf: null, silentArgs: ["/S"], successExitCodes: [3010] });

    // Deleting a group takes it out of the drivers; delete removes the driver.
    await renderHook(() => demoApi.useDeleteDriver()).result.current({ id: created.id });
    expect(db().drivers.some((d) => d._id === created.id)).toBe(false);
    expect(db().audit.some((e) => e.action === "driver.deleted" && e.targetId === created.id)).toBe(true);
    expect(await renderHook(() => demoApi.useDeleteDriver()).result.current({ id: created.id }).catch((e) => e)).toMatchObject({ code: "not_found" });
  }, 30_000);

  it("drivers: a viewer reads but cannot write; at most 50 drivers", async () => {
    resetDemo();
    signInAs("auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test");
    const input = { name: "X", kind: "msi" as const, deviceClass: "other" as const, url: "https://x.test/a.msi", sha256: "a".repeat(64), sizeBytes: 0, silentArgs: [], successExitCodes: [], provides: [], groupIds: [] };
    expect(errorCodeOf(await renderHook(() => demoApi.useSaveDriver()).result.current(input).catch((e) => e))).toBe("forbidden");
    expect(errorCodeOf(await renderHook(() => demoApi.useDeleteDriver()).result.current({ id: db().drivers[0]!._id }).catch((e) => e))).toBe("forbidden");
    expect(errorCodeOf(await renderHook(() => demoApi.useRetryDriver()).result.current({ id: db().drivers[0]!._id }).catch((e) => e))).toBe("forbidden");
    expect(errorCodeOf(await renderHook(() => demoApi.useSetApprovedPrinterDrivers()).result.current({ names: ["A"] }).catch((e) => e))).toBe("forbidden");
    expect((await ready(renderHook(() => demoApi.useNetworks()).result)).data.drivers).toHaveLength(2);
    signInAs("owner@demo.rulebox.test");
    while (db().drivers.length < 50) db().drivers.push({ ...db().drivers[0]!, _id: `fill${db().drivers.length}`, name: `Fill ${db().drivers.length}`, groupIds: [] });
    expect(await renderHook(() => demoApi.useSaveDriver()).result.current(input).catch((e) => e)).toMatchObject({ code: "too_large", detail: "drivers" });
  });

  it("approved printer drivers (Step 14b): the admin list is trimmed, deduplicated, without inbox names, at most 20; printers may then use a name", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const set = renderHook(() => demoApi.useSetApprovedPrinterDrivers()).result.current;
    expect(await set({ names: [" HP Universal ", "hp universal", "Generic / Text Only", "Canon UFR II"] })).toEqual({ addedDrivers: ["HP Universal", "Canon UFR II"] });
    expect(db().audit.some((e) => e.action === "printers.driversChanged")).toBe(true);
    const net = (await ready(renderHook(() => demoApi.useNetworks()).result)).data;
    expect(net.addedDrivers).toEqual(["HP Universal", "Canon UFR II"]);
    expect(net.approvedDrivers).toContain("Canon UFR II");
    const before = db().audit.length;
    await set({ names: ["HP Universal", "Canon UFR II"] });
    expect(db().audit.length).toBe(before);
    expect(await set({ names: [" "] }).catch((e) => e)).toMatchObject({ field: "names", detail: "empty" });
    expect(await set({ names: ["x".repeat(101)] }).catch((e) => e)).toMatchObject({ field: "names", detail: "length" });
    expect(await set({ names: Array.from({ length: 21 }, (_, i) => `Driver ${i}`) }).catch((e) => e)).toMatchObject({ code: "too_large", detail: "names" });
    const save = renderHook(() => demoApi.useSavePrinter()).result.current;
    const ok = await save({ name: "Canon one", kind: "raw", address: "10.0.0.9", driver: "canon ufr ii", groupIds: [], defaultForGroupIds: [] });
    expect(db().printers.find((p) => p._id === ok.id)!.driver).toBe("Canon UFR II");
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
describe("demo device lock and broadcasts (Phase 5 Step 15)", () => {
  it("lock replaces, the same text writes nothing, unlock removes it and both are audited; a revoked PC cannot be locked", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const lock = renderHook(() => demoApi.useLockDevice()).result.current;
    const unlock = renderHook(() => demoApi.useUnlockDevice()).result.current;
    const d = db().devices.find((x) => !x.revoked)!;
    const first = await lock({ deviceId: d._id, message: "  Call IT  ", contact: " ext 1 " });
    expect(db().locks.get(d._id)).toMatchObject({ lockId: first.lockId, message: "Call IT", contact: "ext 1" });
    const audits = () => db().audit.filter((e) => e.action === "device.locked").length;
    const before = audits();
    expect(await lock({ deviceId: d._id, message: "Call IT", contact: "ext 1" })).toEqual(first);
    expect(audits()).toBe(before);
    const second = await lock({ deviceId: d._id, message: "Call IT now" });
    expect(second.lockId).not.toBe(first.lockId);
    expect(db().locks.get(d._id)!.contact).toBeUndefined();
    const detail = renderHook(() => demoApi.useDeviceDetail(d._id));
    expect((await ready(detail.result)).data.lock).toMatchObject({ lockId: second.lockId, message: "Call IT now" });
    await unlock({ deviceId: d._id });
    expect(db().locks.has(d._id)).toBe(false);
    expect(db().audit.some((e) => e.action === "device.unlocked")).toBe(true);
    await expect(lock({ deviceId: d._id, message: "  " })).rejects.toSatisfy((e) => errorCodeOf(e) === "invalid_argument");
    const revoked = db().devices.find((x) => x.revoked);
    if (revoked) await expect(lock({ deviceId: revoked._id, message: "x" })).rejects.toSatisfy((e) => errorCodeOf(e) === "conflict");
  });

  it("send validates, counts the group's PCs, caps live messages at 20 and cancel frees a place; the list is newest first", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const send = renderHook(() => demoApi.useSendBroadcast()).result.current;
    const cancel = renderHook(() => demoApi.useCancelBroadcast()).result.current;
    const group = db().groups[0]!;
    const input = { target: { kind: "group" as const, id: group._id }, style: "banner" as const, title: "T", body: "B", ackRequired: true };
    await expect(send({ ...input, title: " " })).rejects.toSatisfy((e) => errorCodeOf(e) === "invalid_argument");
    await expect(send({ ...input, expiresAt: Date.now() - 1 })).rejects.toSatisfy((e) => errorCodeOf(e) === "invalid_argument");
    const sent = await send(input);
    expect(sent.targetCount).toBe(Math.min(db().devices.filter((x) => x.groupId === group._id && !x.revoked).length, 500));
    expect(db().audit.some((e) => e.action === "broadcast.sent" && e.targetId === sent.id)).toBe(true);
    const list = renderHook(() => demoApi.useBroadcastsPage({ numItems: 10, cursor: null }));
    const page = await ready(list.result);
    expect(page.items[0]!._id).toBe(sent.id);
    expect(page.items.map((b) => b.createdAt)).toEqual([...page.items.map((b) => b.createdAt)].sort((x, y) => y - x));

    let live = db().broadcasts.filter((b) => b.cancelledAt === null && (b.expiresAt === null || b.expiresAt > Date.now())).length;
    for (; live < 20; live++) await send(input);
    await expect(send(input)).rejects.toSatisfy((e) => errorCodeOf(e) === "too_large");
    await cancel({ id: sent.id });
    expect(db().broadcasts.find((b) => b._id === sent.id)!.cancelledAt).not.toBeNull();
    await expect(send(input)).resolves.toBeDefined();
  }, 30_000);
});
describe("demo: data of the group, messages, audit and file-type pages (UI pass, other-pages O3)", () => {
  const groupNamed = (name: string) => db().groups.find((g) => g.name === name)!;

  it("the group page's data: rollout state and trial-run date from the fixtures, null without rows, the archived flag of each assignment", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const detail = async (name: string) => (await ready(renderHook(() => demoApi.useGroupDetail(groupNamed(name)._id)).result)).data;
    const counter = await detail("Pharmacy counter");
    expect(counter.rollout).toEqual({ enabled: true, state: "rolling" });
    expect(Date.now() - counter.lockdownAuditSince!).toBeGreaterThan(14 * 86_400_000); // the trial-run warning shows
    expect((await detail("Back office")).rollout).toEqual({ enabled: true, state: "halted" });
    expect((await detail("Front desk")).rollout).toEqual({ enabled: false, state: "idle" });
    expect((await detail("Front desk")).lockdownAuditSince).toBeLessThan(Date.now());
    expect(counter.assignments.every((a) => a.archived === false)).toBe(true);
    // An archived app that is still assigned.
    const night = await detail("Warehouse & Receiving — Night Shift Team B (temp)");
    expect(night.assignments.find((a) => a.appName === "Old scheduler")).toMatchObject({ archived: true });
    // A group without rows: null, null.
    const created = await renderHook(() => demoApi.useCreateGroup()).result.current({ name: "Brand new" });
    const fresh = (await ready(renderHook(() => demoApi.useGroupDetail(created)).result)).data;
    expect(fresh.rollout).toBeNull();
    expect(fresh.lockdownAuditSince).toBeNull();
  });

  it("broadcasts:live keeps timed and never-ending messages, drops cancelled ones, and leaves an expired one for the screen's clock", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const send = renderHook(() => demoApi.useSendBroadcast()).result.current;
    const cancel = renderHook(() => demoApi.useCancelBroadcast()).result.current;
    const base = { target: { kind: "group" as const, id: db().groups[0]!._id }, style: "banner" as const, body: "B", ackRequired: false };
    const fixtureLive = db().broadcasts.filter((b) => b.cancelledAt === null).length;
    const forever = await send({ ...base, title: "Forever" });
    const timed = await send({ ...base, title: "Timed", expiresAt: Date.now() + 3_600_000 });
    const gone = await send({ ...base, title: "Cancelled" });
    await cancel({ id: gone.id });
    db().broadcasts.find((b) => b._id === timed.id)!.expiresAt = Date.now() - 1; // it ran out
    const live = renderHook(() => demoApi.useLiveBroadcasts());
    const rows = (await ready(live.result)).data;
    const ids = rows.map((b) => b._id);
    expect(ids).toContain(forever.id);
    expect(ids).toContain(timed.id); // returned; hidden by the screen's own clock
    expect(ids).not.toContain(gone.id);
    expect(rows).toHaveLength(fixtureLive + 2);
    expect(rows[0]!.createdAt).toBeGreaterThanOrEqual(rows[rows.length - 1]!.createdAt);
    expect(rows.find((b) => b._id === forever.id)!.target.name).toBe(db().groups[0]!.name);
  });

  it("audit: `since` keeps the rows at or after it; `targetId` keeps one item's rows; both together; the newest first", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const all = db().audit;
    const mid = [...all].sort((a, b) => a.at - b.at)[Math.floor(all.length / 2)]!.at;
    const since = renderHook(() => demoAuditApi.useAuditScreen({ numItems: 50, cursor: null, since: mid }));
    const rows = (await ready(since.result)).items;
    expect(rows.length).toBe(Math.min(50, all.filter((e) => e.at >= mid).length)); // one page of 50
    expect(rows.every((e) => e.at >= mid)).toBe(true);
    expect(rows.map((e) => e.at)).toEqual([...rows.map((e) => e.at)].sort((a, b) => b - a));

    const target = all.find((e) => e.targetId !== undefined)!.targetId!;
    const one = renderHook(() => demoAuditApi.useAuditScreen({ numItems: 50, cursor: null, targetId: target }));
    const ofTarget = (await ready(one.result)).items;
    expect(ofTarget.length).toBe(Math.min(50, all.filter((e) => e.targetId === target).length));
    expect(ofTarget.every((e) => e.targetId === target)).toBe(true);

    const future = Date.now() + 1; // a stable argument, like the screen's start of the day
    const both = renderHook(() => demoAuditApi.useAuditScreen({ numItems: 50, cursor: null, targetId: target, since: future }));
    expect((await ready(both.result)).items).toEqual([]);
  });

  it("file types: setMany adds and moves the rules with ONE audit row, a refused extension refuses all, and the same call again writes nothing", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const setMany = renderHook(() => demoApi.useSetFileHandlers()).result.current;
    const app = db().apps.find((a) => a.kind === "desktop" && !a.archived && (a.desktop?.fileArgTemplate.length ?? 0) > 0)!;
    const before = db().fileHandlers.length;
    const audits = () => db().audit.filter((e) => e.action === "fileHandler.set").length;
    const a0 = audits();
    await setMany({ extensions: ["JPG", ".jpeg", ".png", ".jpg"], appId: app._id });
    expect(db().fileHandlers.filter((f) => f.appId === app._id).map((f) => f.extension)).toEqual(expect.arrayContaining([".jpg", ".jpeg", ".png"]));
    expect(db().fileHandlers.length).toBeGreaterThanOrEqual(before);
    expect(audits()).toBe(a0 + 1);
    await setMany({ extensions: [".jpg", ".png"], appId: app._id });
    expect(audits()).toBe(a0 + 1); // nothing to change
    const rules = db().fileHandlers.length;
    await expect(setMany({ extensions: [".pdf", ".exe"], appId: app._id })).rejects.toSatisfy((e) => errorCodeOf(e) === "invalid_argument");
    await expect(setMany({ extensions: [], appId: app._id })).rejects.toSatisfy((e) => errorCodeOf(e) === "invalid_argument");
    expect(db().fileHandlers.length).toBe(rules);
  });
});
describe("demo rollout rings and rollback (Phase 5 Step 16)", () => {
  const VIEWER = "auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test";
  const group = (name: string) => db().groups.find((g) => g.name === name)!;
  const view = async (groupId: string) => {
    const hook = renderHook(() => demoApi.useRolloutView(groupId));
    return (await ready(hook.result)).data;
  };
  const rollRow = (name: string) => db().rollouts.get(group(name)._id)!;
  const hooks = () => ({
    enable: renderHook(() => demoApi.useSetRolloutEnabled()).result.current,
    auto: renderHook(() => demoApi.useSetAutoPromote()).result.current,
    rings: renderHook(() => demoApi.useSetRings()).result.current,
    promote: renderHook(() => demoApi.usePromoteRollout()).result.current,
    promoteAll: renderHook(() => demoApi.usePromoteAll()).result.current,
    rollback: renderHook(() => demoApi.useRollback()).result.current,
    resume: renderHook(() => demoApi.useResumeRollout()).result.current,
  });
  const code = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => errorCodeOf(e));
  const detail = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as { detail?: string }).detail ?? null);

  it("seeds a rolling group, a halted one, one with rings off and one with no configuration yet", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const rolling = await view(group("Pharmacy counter")._id);
    expect(rolling.rollout).toMatchObject({ enabled: true, state: "rolling", pointers: { pilot: 8, early: 7, everyone: 7 } });
    expect(rolling.stage).toEqual({ ring: "pilot", version: 8 });
    expect(rolling.versions.map((v) => v.version)).toEqual([8, 7, 6, 5, 4]);
    expect(rolling.devices.map((d) => [d.name, d.ring])).toEqual([["COUNTER-01", "pilot"], ["COUNTER-02", "pilot"], ["COUNTER-03", "pilot"]]);
    const halted = await view(group("Back office")._id);
    expect(halted.rollout).toMatchObject({ state: "halted", haltReason: "failure_rate" });
    const off = await view(group("Front desk")._id);
    expect(off.rollout?.enabled).toBe(false);
    expect(off.stage).toBeNull();
    expect(off.devices).toHaveLength(100);
    expect(off.devicesTruncated).toBe(true);
    const none = await view(group("Training room")._id);
    expect(none.rollout).toBeNull();
    expect(none.versions).toEqual([]);
  });

  it("counts the stage's applied, failed and waiting PCs from their reports, and nothing when no stage is in flight", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const h = renderHook(() => demoApi.useRolloutHealth(group("Pharmacy counter")._id));
    expect((await ready(h.result)).data).toMatchObject({ stage: { ring: "pilot", version: 8 }, ringSize: 3, applied: 1, failed: 1, partial: 0, waiting: 1, pilotRolledBack: false, ringCapped: false });
    const idle = renderHook(() => demoApi.useRolloutHealth(group("Front desk")._id));
    expect((await ready(idle.result)).data).toMatchObject({ stage: null, ringSize: 0, applied: 0, failed: 0, waiting: 0 });
  });

  it("turning rings on needs a pilot PC; turning them off moves every ring to the newest version; both are audited", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const { enable, rings } = hooks();
    const front = group("Front desk");
    expect(await detail(enable({ groupId: front._id, enabled: true, expectedRevision: 1 }))).toBe("no_pilot_devices");
    const pc = db().devices.find((d) => d.groupId === front._id && !d.revoked)!;
    const moved = await rings({ groupId: front._id, deviceIds: [pc._id], ring: "pilot", expectedRevision: 1 });
    expect(moved).toEqual({ revision: 2, changed: 1 });
    expect(await rings({ groupId: front._id, deviceIds: [pc._id], ring: "pilot", expectedRevision: 2 })).toEqual({ revision: 2, changed: 0 });
    expect(await enable({ groupId: front._id, enabled: true, expectedRevision: 2 })).toEqual({ revision: 3 });
    expect(db().audit.some((e) => e.action === "rollout.enabled")).toBe(true);
    // With rings on, the last pilot PC may not leave the pilot ring.
    expect(await detail(rings({ groupId: front._id, deviceIds: [pc._id], ring: "everyone", expectedRevision: 3 }))).toBe("no_pilot_devices");
    expect(rollRow("Front desk").enabled).toBe(true);

    const counter = rollRow("Pharmacy counter");
    const counterId = group("Pharmacy counter")._id;
    expect(await enable({ groupId: counterId, enabled: false, expectedRevision: counter.revision })).toEqual({ revision: 4 });
    expect(counter).toMatchObject({ enabled: false, state: "idle", pointers: { pilot: 8, early: 8, everyone: 8 } });
    expect(db().audit.some((e) => e.action === "rollout.disabled")).toBe(true);
  });

  it("refuses a wrong revision (stale_edit) and every write for a viewer", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const h = hooks();
    const id = group("Pharmacy counter")._id;
    expect(await code(h.promote({ groupId: id, to: "early", expectedRevision: 1 }))).toBe("stale_edit");
    expect(await code(h.promoteAll({ groupId: id, expectedRevision: 0 }))).toBe("stale_edit");
    signInAs(VIEWER);
    expect(await code(h.promote({ groupId: id, to: "early", expectedRevision: 3 }))).toBe("forbidden");
    expect(await code(h.enable({ groupId: id, enabled: false, expectedRevision: 3 }))).toBe("forbidden");
    expect(await code(h.rollback({ groupId: id, toVersion: 7, rings: ["pilot"], expectedRevision: 3 }))).toBe("forbidden");
    // A viewer may read.
    expect((await view(id)).rollout?.revision).toBe(3);
  });

  it("promotes pilot to early to everyone, refuses when nothing is left to promote or the rollout is halted, and resume clears a halt", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const { promote, promoteAll, resume } = hooks();
    const id = group("Pharmacy counter")._id;
    const row = rollRow("Pharmacy counter");
    expect(await detail(promote({ groupId: id, to: "everyone", expectedRevision: row.revision }))).toBe("nothing_to_promote");
    await promote({ groupId: id, to: "early", expectedRevision: row.revision });
    expect(row).toMatchObject({ pointers: { pilot: 8, early: 8, everyone: 7 }, state: "rolling" });
    await promote({ groupId: id, to: "everyone", expectedRevision: row.revision });
    expect(row).toMatchObject({ pointers: { pilot: 8, early: 8, everyone: 8 }, state: "idle", stageStartedAt: null });
    expect(await detail(promoteAll({ groupId: id, expectedRevision: row.revision }))).toBe("nothing_to_promote");
    expect(db().audit.filter((e) => e.action === "rollout.promoted")).toHaveLength(2);

    const off = group("Front desk")._id;
    expect(await detail(promote({ groupId: off, to: "early", expectedRevision: rollRow("Front desk").revision }))).toBe("rings_disabled");

    const halted = group("Back office")._id;
    const hrow = rollRow("Back office");
    expect(await detail(promote({ groupId: halted, to: "early", expectedRevision: hrow.revision }))).toBe("halted");
    expect(await detail(promoteAll({ groupId: halted, expectedRevision: hrow.revision }))).toBe("halted");
    await resume({ groupId: halted, expectedRevision: hrow.revision });
    expect(hrow).toMatchObject({ state: "rolling", haltReason: null });
    expect(hrow.stageStartedAt).not.toBeNull();
    expect(await detail(resume({ groupId: halted, expectedRevision: hrow.revision }))).toBe("not_halted");
    await promoteAll({ groupId: halted, expectedRevision: hrow.revision });
    expect(hrow).toMatchObject({ pointers: { pilot: 4, early: 4, everyone: 4 }, state: "idle" });
    expect(db().audit.some((e) => e.action === "rollout.resumed")).toBe(true);
  });

  it("rolls the chosen rings back to a version that is kept: halted with a reason when the rings then differ, idle when they agree; a missing version is refused", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const { rollback } = hooks();
    const id = group("Pharmacy counter")._id;
    const row = rollRow("Pharmacy counter");
    expect(await detail(rollback({ groupId: id, toVersion: 99, rings: ["pilot"], expectedRevision: row.revision }))).toBe("version_missing");
    expect(await code(rollback({ groupId: id, toVersion: 6, rings: [], expectedRevision: row.revision }))).toBe("invalid_argument");
    // The same pointers again: no write.
    const before = row.revision;
    expect(await rollback({ groupId: id, toVersion: 8, rings: ["pilot"], expectedRevision: before })).toEqual({ revision: before });
    await rollback({ groupId: id, toVersion: 6, rings: ["pilot"], expectedRevision: before });
    expect(row).toMatchObject({ pointers: { pilot: 6, early: 7, everyone: 7 }, state: "halted", haltReason: "rolled_back" });
    expect(db().audit.some((e) => e.action === "rollout.rolledBack")).toBe(true);
    await rollback({ groupId: id, toVersion: 6, rings: ["pilot", "early", "everyone"], expectedRevision: row.revision });
    expect(row).toMatchObject({ pointers: { pilot: 6, early: 6, everyone: 6 }, state: "idle", haltReason: null });

    // With rings off every ring goes back, whichever rings were asked for.
    const off = rollRow("Front desk");
    await rollback({ groupId: group("Front desk")._id, toVersion: 3, rings: ["pilot"], expectedRevision: off.revision });
    expect(off.pointers).toEqual({ pilot: 3, early: 3, everyone: 3 });
  });

  it("rollback is a major action: it asks for a fresh step-up", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const m = db().members.find((x) => x.email === "owner@demo.rulebox.test")!;
    // Verified, but long enough ago that only the unlocked level is met.
    const stale = Date.now() - 10 * 60_000;
    setSession({ memberId: m._id, createdAt: stale, stepUp: { verifiedAt: stale, lastActiveAt: Date.now(), method: "actionPin" } });
    const { rollback, promote } = hooks();
    const id = group("Pharmacy counter")._id;
    const row = rollRow("Pharmacy counter");
    expect(await code(rollback({ groupId: id, toVersion: 6, rings: ["pilot"], expectedRevision: row.revision }))).toBe("step_up_required");
    expect(row.pointers.pilot).toBe(8);
    // An ordinary rollout write needs only the unlocked level.
    await expect(promote({ groupId: id, to: "early", expectedRevision: row.revision })).resolves.toBeDefined();
  });

  it("saves the automatic promotion settings in one write, validates them, and writes nothing when nothing changed", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const { auto } = hooks();
    const id = group("Pharmacy counter")._id;
    const row = rollRow("Pharmacy counter");
    const base = { groupId: id, enabled: true, bakeHours: 48, maxFailurePct: 5, autoRollback: false, expectedRevision: row.revision };
    for (const bakeHours of [0, 169, 2.5]) expect(await code(auto({ ...base, bakeHours }))).toBe("invalid_argument");
    for (const maxFailurePct of [0, 101, 1.5]) expect(await code(auto({ ...base, maxFailurePct }))).toBe("invalid_argument");
    const saved = await auto(base);
    expect(row).toMatchObject({ autoPromote: { enabled: true, bakeHours: 48, maxFailurePct: 5 }, autoRollback: false });
    expect(await auto({ ...base, expectedRevision: saved.revision })).toEqual(saved);
    expect(db().audit.filter((e) => e.action === "rollout.settingsChanged")).toHaveLength(1);
  });

  it("puts PCs in rings: only PCs of the group, never a revoked one, at most 100 at a time", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const { rings } = hooks();
    const front = group("Front desk");
    const row = rollRow("Front desk");
    const mine = db().devices.filter((d) => d.groupId === front._id && !d.revoked);
    const other = db().devices.find((d) => d.groupId === group("Pharmacy counter")._id)!;
    expect(await code(rings({ groupId: front._id, deviceIds: [], ring: "early", expectedRevision: row.revision }))).toBe("invalid_argument");
    expect(await code(rings({ groupId: front._id, deviceIds: mine.slice(0, 101).map((d) => d._id), ring: "early", expectedRevision: row.revision }))).toBe("invalid_argument");
    expect(await code(rings({ groupId: front._id, deviceIds: [other._id], ring: "early", expectedRevision: row.revision }))).toBe("invalid_argument");
    const revoked = db().devices.find((d) => d.groupId === front._id && d.revoked)!;
    expect(await detail(rings({ groupId: front._id, deviceIds: [revoked._id], ring: "early", expectedRevision: row.revision }))).toBe("device revoked");
    await rings({ groupId: front._id, deviceIds: mine.slice(0, 3).map((d) => d._id), ring: "early", expectedRevision: row.revision });
    expect(mine.slice(0, 3).every((d) => d.ring === "early")).toBe(true);
    expect(db().audit.some((e) => e.action === "device.ringChanged")).toBe(true);
    await rings({ groupId: front._id, deviceIds: [mine[0]!._id], ring: "everyone", expectedRevision: row.revision });
    expect(mine[0]!.ring).toBeUndefined();
  }, 15_000);
});

describe("demo device page queries (UI pass 2026-11)", () => {
  const byName = (name: string) => db().devices.find((d) => d.name === name)!;

  it("useDevicePage is the header, Overview and Protection data of one PC: report, head, lock, lockdown fields, failed installs, network counts", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const scanner = byName("OFFICE-SCANNER");
    const page = (await ready(renderHook(() => demoApi.useDevicePage(scanner._id)).result)).data;
    expect(page).toMatchObject({
      name: "OFFICE-SCANNER",
      revoked: false,
      outOfSupport: true,
      group: { name: "Back office" },
      planState: "ok",
      report: { kioskError: "desired_state_untrusted", trustedKeyIds: [] },
      network: { wifiFailed: 1, printersFailed: 0 },
      ring: "everyone",
    });
    expect(page.latestVersion).toBeGreaterThan(0);
    expect(page.protection).toMatchObject({ secureBoot: "off" });
    expect(page.apply?.state).toBe("partial");
    expect("groups" in page || "versions" in page || "rolloutRevision" in page).toBe(false);

    // A failed install of an app the PC's group assigns counts (OFFICE-MANAGER's failed label app is not assigned to its group: it does not); a revoked PC counts nothing.
    expect(page.failedInstalls).toEqual({ count: 1, more: false, names: ["VLC media player"] });
    expect((await ready(renderHook(() => demoApi.useDevicePage(byName("OFFICE-MANAGER")._id)).result)).data.failedInstalls.count).toBe(0);
    const stolen = byName("STOLEN-TABLET");
    expect((await ready(renderHook(() => demoApi.useDevicePage(stolen._id)).result)).data).toMatchObject({ revoked: true, failedInstalls: { count: 0, more: false, names: [] } });
    expect((await ready(renderHook(() => demoApi.useDevicePage(byName("WAREHOUSE-01")._id)).result)).data.planState).toBe("overLimit");
  });

  it("one PC shows the hideAdminTiles warning: the policy is applied, its machine layer is ok with admin_tiles_skipped", () => {
    resetDemo();
    const rows = [...db().applyDetails.entries()].filter(([, a]) => a.layers.machine.detail === "admin_tiles_skipped");
    expect(rows).toHaveLength(1);
    expect(rows[0]![1]).toMatchObject({ state: "applied", layers: { machine: { mode: "on", state: "ok" } } });
  });

  it("settings options, versions and the network tab answer for their PC; the closed versions disclosure loads nothing", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const counter = byName("COUNTER-02");
    const settings = (await ready(renderHook(() => demoDevicesApi.useDeviceSettingsOptions(counter._id)).result)).data;
    expect(settings.groups.map((g) => g.name)).toEqual([...settings.groups.map((g) => g.name)].sort((a, b) => a.localeCompare(b)));
    expect(settings.rolloutRevision).toBe(3);
    const versions = (await ready(renderHook(() => demoDevicesApi.useDeviceVersions(counter._id, true)).result)).data;
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.length).toBeLessThanOrEqual(5);
    const closed = renderHook(() => demoDevicesApi.useDeviceVersions(counter._id, false)).result;
    await new Promise((r) => setTimeout(r, 300));
    expect(closed.current.status).toBe("loading");

    const net = (await ready(renderHook(() => demoDevicesApi.useDeviceNetwork(counter._id)).result)).data;
    expect(net.wifi).toMatchObject([{ name: "Shop floor", state: "working", detail: null }]);
    expect(net.printers.map((p) => [p.name, p.state])).toEqual([
      ["Front desk", "working"],
      ["Warehouse label printer", "waiting"],
    ]);
    expect(net.drivers).toMatchObject([{ name: "Brother laser printer driver", state: "installed" }]);
    const scanner = (await ready(renderHook(() => demoDevicesApi.useDeviceNetwork(byName("OFFICE-SCANNER")._id)).result)).data;
    expect(scanner.wifi[0]).toMatchObject({ name: "Back office (hidden)", state: "failed", detail: "connect_failed" });
    expect(scanner.drivers[0]).toMatchObject({ state: "failed", detail: "hash_mismatch" });
    // A PC without a group has nothing.
    expect((await ready(renderHook(() => demoDevicesApi.useDeviceNetwork(byName("SPARE-LAPTOP-07")._id)).result)).data).toMatchObject({ groupId: null, wifi: [], printers: [], drivers: [] });
  });
});