import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { demoApi } from "./hooks";
import { db, resetDemo, setControls, setSession, simulateConcurrentEdit } from "./store";
import { errorCodeOf } from "../../lib/errors";

function signInAs(email: string) {
  const m = db().members.find((x) => x.email === email)!;
  setSession({ memberId: m._id, mfaVerified: true });
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
    await expect(result.current({ expectedRevision: db().org.revision, name: "X", settings: db().org.settings })).resolves.toBeUndefined();
    expect(db().org.name).toBe("X");
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
