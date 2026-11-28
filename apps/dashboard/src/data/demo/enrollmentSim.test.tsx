import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { demoEnrollmentApi } from "./hooks";
import { DEMO_PC_TIMELINE, simulatedPcIds, simulatePcFor, stopSimulation } from "./enrollmentSim";
import { db, resetDemo, setSession } from "./store";
import { pcStage, progressState } from "../../screens/enrollment/model";
import { errorCodeOf } from "../../lib/errors";

// The demo twin of `enrollmentCodes:create` / `progress`: the code row id comes back with the code, and one simulated PC joins it
// (6 s joined, 8 s online, 10 s applying, 14 s applied), cleared on revoke and on reset.

function signInAs(email: string) {
  const m = db().members.find((x) => x.email === email)!;
  const now = Date.now();
  setSession({ memberId: m._id, createdAt: now, stepUp: { verifiedAt: now, lastActiveAt: now, method: "actionPin" } });
}

/** A usable code made directly in the store (the timeline tests do not wait for the demo's simulated network delay). */
function addCode(over: Partial<ReturnType<typeof db>["tokens"][number]> = {}) {
  const row = {
    _id: `tok_test_${db().tokens.length}`,
    label: "Front desk · 28 Nov",
    groupId: db().groups[0]!._id,
    usesLeft: 1,
    usesTotal: 1,
    expiresAt: Date.now() + 24 * 3_600_000,
    revoked: false,
    createdAt: Date.now(),
    ...over,
  };
  db().tokens.push(row);
  return row;
}

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("create returns the row id and starts one simulated PC", () => {
  afterEach(() => resetDemo());

  it("the answer carries code, expiry and tokenId (the row of the new code, never the code)", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const create = renderHook(() => demoEnrollmentApi.useCreateEnrollmentCode()).result.current;
    const groupId = db().groups[0]!._id;
    const made = await create({ groupId, uses: 2, ttlMinutes: 60, label: "Front desk · 28 Nov" });
    expect(made).toEqual({ code: expect.stringMatching(/^RBX1\./), expiresAt: expect.any(Number), tokenId: expect.any(String) });
    const row = db().tokens.find((t) => t._id === made.tokenId)!;
    expect(row).toMatchObject({ usesLeft: 2, usesTotal: 2, groupId, label: "Front desk · 28 Nov" });
    expect(made.tokenId).not.toContain(made.code);
    expect(JSON.stringify(db().tokens)).not.toContain(made.code);
  }, 15_000);
});

describe("the simulated PC", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDemo();
    signInAs("owner@demo.rulebox.test");
  });
  afterEach(() => {
    resetDemo();
    vi.useRealTimers();
  });

  it("joins at 6 s, is online at 8 s, applies at 10 s and is ready at 14 s; each step re-runs the progress query", async () => {
    const code = addCode();
    const before = db().devices.length;
    simulatePcFor(code._id);
    const progress = renderHook(() => demoEnrollmentApi.useEnrollmentProgress(code._id));
    await advance(1_000); // the query settles (a simulated round trip)
    expect(progress.result.current).toMatchObject({
      status: "ready",
      data: { joined: 0, usesLeft: 1, usesTotal: 1, pcs: [], revoked: false, label: "Front desk · 28 Nov", groupName: db().groups[0]!.name },
    });

    await advance(DEMO_PC_TIMELINE.joins - 1_000 - 1);
    expect(db().devices).toHaveLength(before);
    await advance(1);
    expect(db().devices).toHaveLength(before + 1);
    const joined = progress.result.current;
    if (joined.status !== "ready") throw new Error("not ready");
    expect(joined.data).toMatchObject({ joined: 1, usesLeft: 0 });
    expect(joined.data.pcs).toEqual([{ _id: expect.any(String), name: "DEMO-PC-01", enrolledAt: expect.any(Number), online: false }]);
    expect(pcStage(joined.data.pcs[0]!)).toBe("joined");
    expect(progressState(joined.data, Date.now())).toBe("usedUp");
    const device = db().devices.find((d) => d.name === "DEMO-PC-01")!;
    expect(device).toMatchObject({ groupId: code.groupId, revoked: false });
    expect(db().audit.some((e) => e.action === "device.enrolled" && e.targetId === device._id)).toBe(true);
    expect(simulatedPcIds(code._id)).toEqual([device._id]);

    await advance(DEMO_PC_TIMELINE.online - DEMO_PC_TIMELINE.joins);
    const online = progress.result.current;
    if (online.status !== "ready") throw new Error("not ready");
    expect(online.data.pcs[0]).toMatchObject({ online: true });
    expect(pcStage(online.data.pcs[0]!)).toBe("online");

    await advance(DEMO_PC_TIMELINE.applying - DEMO_PC_TIMELINE.online);
    const applying = progress.result.current;
    if (applying.status !== "ready") throw new Error("not ready");
    expect(applying.data.pcs[0]).toMatchObject({ online: true, kioskPhase: "applying" });
    expect(pcStage(applying.data.pcs[0]!)).toBe("settingUp");

    await advance(DEMO_PC_TIMELINE.applied - DEMO_PC_TIMELINE.applying);
    const applied = progress.result.current;
    if (applied.status !== "ready") throw new Error("not ready");
    expect(applied.data.pcs[0]).toMatchObject({ online: true, kioskPhase: "applied" });
    expect(pcStage(applied.data.pcs[0]!)).toBe("ready");
    expect(db().reports.get(device._id)).toMatchObject({ kioskPhase: "applied" });
    expect(db().onlineIds.has(device._id)).toBe(true);

    // Nothing more happens, and the next demo PC gets the next number.
    await advance(60_000);
    expect(db().devices).toHaveLength(before + 1);
    const second = addCode();
    simulatePcFor(second._id);
    await advance(DEMO_PC_TIMELINE.joins);
    expect(db().devices.some((d) => d.name === "DEMO-PC-02")).toBe(true);
  });

  it("a revoked code gets no PC: stopping cancels what is pending, and a PC that already joined stays as it is", async () => {
    const early = addCode();
    simulatePcFor(early._id);
    await advance(3_000);
    stopSimulation(early._id);
    const before = db().devices.length;
    await advance(30_000);
    expect(db().devices).toHaveLength(before);
    expect(simulatedPcIds(early._id)).toEqual([]);

    const late = addCode();
    simulatePcFor(late._id);
    await advance(DEMO_PC_TIMELINE.online);
    stopSimulation(late._id);
    await advance(30_000);
    const device = db().devices.find((d) => d.name === "DEMO-PC-01")!;
    expect(db().onlineIds.has(device._id)).toBe(true);
    expect(db().reports.get(device._id)?.kioskPhase).toBeUndefined(); // it never got to applying
  });

  it("the revoke hook stops it, and a code that is revoked, used up or expired when the timer fires gets no PC", async () => {
    const code = addCode({ usesLeft: 3, usesTotal: 3 });
    simulatePcFor(code._id);
    const before = db().devices.length;
    const revoke = renderHook(() => demoEnrollmentApi.useRevokeEnrollmentCode()).result.current;
    const done = revoke({ tokenId: code._id });
    await advance(5_000);
    await done;
    expect(db().tokens.find((t) => t._id === code._id)!.revoked).toBe(true);
    await advance(30_000);
    expect(db().devices).toHaveLength(before);

    for (const over of [{ revoked: true }, { usesLeft: 0 }, { expiresAt: Date.now() + 1_000 }]) {
      const c = addCode(over);
      simulatePcFor(c._id);
      await advance(DEMO_PC_TIMELINE.joins + 100);
      expect(simulatedPcIds(c._id)).toEqual([]);
    }
    expect(db().devices).toHaveLength(before);
  });

  it("a reset clears the timers and starts the numbering again", async () => {
    const code = addCode();
    simulatePcFor(code._id);
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const before = db().devices.length;
    await advance(30_000);
    expect(db().devices).toHaveLength(before);
    expect(simulatedPcIds(code._id)).toEqual([]);
    const fresh = addCode();
    simulatePcFor(fresh._id);
    await advance(DEMO_PC_TIMELINE.joins);
    expect(db().devices.some((d) => d.name === "DEMO-PC-01")).toBe(true);
  });
});

describe("useEnrollmentProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDemo();
    signInAs("owner@demo.rulebox.test");
  });
  afterEach(() => {
    resetDemo();
    vi.useRealTimers();
  });

  it("null subscribes to nothing: the state stays loading", async () => {
    const progress = renderHook(() => demoEnrollmentApi.useEnrollmentProgress(null));
    await advance(5_000);
    expect(progress.result.current).toEqual({ status: "loading" });
  });

  it("an unknown or deleted code is not_found; a viewer may read a code", async () => {
    const missing = renderHook(() => demoEnrollmentApi.useEnrollmentProgress("tok_nope"));
    await advance(1_000);
    const state = missing.result.current;
    expect(state.status).toBe("error");
    if (state.status === "error") expect(errorCodeOf(state.error)).toBe("not_found");

    const code = addCode();
    signInAs("auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test");
    const viewer = renderHook(() => demoEnrollmentApi.useEnrollmentProgress(code._id));
    await advance(1_000);
    expect(viewer.result.current.status).toBe("ready");
  });

  it("the download is the organization's release when one is set, else a made-up build (live: null = none, the screen links to GitHub)", async () => {
    const code = addCode();
    const first = renderHook(() => demoEnrollmentApi.useEnrollmentProgress(code._id));
    await advance(1_000);
    expect(first.result.current).toMatchObject({ status: "ready", data: { download: { version: "0.1.0", url: "https://example.invalid/Rulebox-0.1.0-x64.msi", sizeBytes: 31_000_000 } } });

    db().org.ruleboxRelease = { version: "0.4.0", url: "https://github.com/x/y/releases/download/v0.4.0/Rulebox-0.4.0-x64.msi", sha256: "a".repeat(64), sizeBytes: 5 };
    const second = renderHook(() => demoEnrollmentApi.useEnrollmentProgress(code._id));
    await advance(1_000);
    const data = second.result.current.status === "ready" ? second.result.current.data : null;
    expect(data?.download).toEqual({ version: "0.4.0", url: "https://github.com/x/y/releases/download/v0.4.0/Rulebox-0.4.0-x64.msi", sizeBytes: 5 }); // never the hash
  });

  it("works with real timers too (the screens' own tests do not fake them)", async () => {
    vi.useRealTimers();
    const code = addCode();
    const progress = renderHook(() => demoEnrollmentApi.useEnrollmentProgress(code._id));
    await waitFor(() => expect(progress.result.current.status).toBe("ready"), { timeout: 4_000 });
  });
});
