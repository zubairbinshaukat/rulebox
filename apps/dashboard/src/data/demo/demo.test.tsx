import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { demoApi } from "./hooks";
import { db, resetDemo, setControls, setSession, simulateConcurrentEdit } from "./store";
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
    const { result } = renderHook(() => demoApi.useEmployeesScreen({}));
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
