import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { Me, RolloutHealth, RolloutRow, RolloutView } from "../../data/types";
import { MeContext } from "../../lib/member";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";
import { applyMode, modeOf, movesOnAt, nextStage, previousChange, stageCounts, stageStates } from "./stages";
import { draftOf } from "../../lib/rolloutRules";

// The rollout page (UI pass, other-pages plan section 3, step O6) against the LIVE data seam with the Convex React hooks mocked:
// queries answer from `cx.results`, writes call `cx.fns` (convex/rollouts.test.ts covers the backend).
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  queried: [] as string[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        cx.queried.push(getFunctionName(r.query));
        return [k, cx.results[getFunctionName(r.query)]];
      }),
    ),
  useQuery: () => undefined,
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", isLoading: false, loadMore: () => undefined }),
  useAction: (ref: FunctionReference<"action">) => fnFor(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));

const stable = new Map<string, (args?: unknown) => Promise<unknown>>();
function fnFor(name: string) {
  let f = stable.get(name);
  if (!f) {
    f = (args?: unknown) => {
      const impl = cx.fns[name];
      if (!impl) throw new Error(`no mock for ${name}`);
      return impl(args);
    };
    stable.set(name, f);
  }
  return f;
}

import { ToastProvider } from "../../app/Toasts";
import Rollout from "../Rollout";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function page(role: Me["role"] = "admin") {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={["/groups/g1/rollout"]}>
          <Routes>
            <Route path="/groups/:id/rollout" element={<Rollout />} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

const HOUR = 3_600_000;
const NOW = Date.now();

const row = (over: Partial<RolloutRow> = {}): RolloutRow => ({
  enabled: true,
  pointers: { pilot: 8, early: 7, everyone: 7 },
  autoPromote: { enabled: false, bakeHours: 24, maxFailurePct: 10 },
  autoRollback: true,
  state: "rolling",
  haltReason: null,
  stageStartedAt: NOW - 3 * HOUR,
  revision: 3,
  ...over,
});

const versions = [
  { version: 8, reason: "Label printer assigned", createdAt: NOW - 1 * 24 * HOUR },
  { version: 7, reason: "Lockdown settings changed", createdAt: NOW - 3 * 24 * HOUR },
  { version: 6, reason: "App assigned", createdAt: NOW - 5 * 24 * HOUR },
];

const pcs = (rings: ("pilot" | "early" | "everyone")[]) => rings.map((ring, i) => ({ _id: `d${i + 1}`, name: `PC-${i + 1}`, ring }));

function view(over: Partial<RolloutView> = {}): RolloutView {
  return {
    groupName: "Counter",
    rollout: row(),
    versions,
    stage: { ring: "pilot", version: 8 },
    devices: pcs(["pilot", "early", "everyone", "everyone"]),
    devicesTruncated: false,
    ...over,
  };
}

const health: RolloutHealth = {
  stage: { ring: "pilot", version: 8 },
  ringSize: 3,
  ringCapped: false,
  applied: 1,
  failed: 1,
  partial: 0,
  waiting: 1,
  pilotRolledBack: false,
  reportsCapped: false,
};

beforeEach(() => {
  cleanup();
  cx.results = { "rollouts:groupView": view(), "rollouts:health": health };
  cx.queried = [];
  cx.fns = {};
});

describe("the stage rules", () => {
  it("states: the stage in flight tests, the ones behind it wait, the ones before it are through; halted pauses it", () => {
    const r = row();
    expect(stageStates(r, { ring: "pilot", version: 8 })).toEqual({ pilot: "testing", early: "waiting", everyone: "waiting" });
    expect(stageStates(r, { ring: "early", version: 8 })).toEqual({ pilot: "done", early: "testing", everyone: "waiting" });
    expect(stageStates(r, null)).toEqual({ pilot: "done", early: "done", everyone: "done" });
    expect(stageStates(row({ state: "halted" }), { ring: "pilot", version: 8 }).pilot).toBe("paused");
    expect(nextStage({ ring: "pilot", version: 8 })).toBe("early");
    expect(nextStage({ ring: "early", version: 8 })).toBe("everyone");
    expect(nextStage(null)).toBeNull();
  });

  it("counts PCs per stage and flags the truncated list", () => {
    expect(stageCounts(view())).toEqual({ counts: { pilot: 1, early: 1, everyone: 2 }, truncated: false });
    expect(stageCounts(view({ devicesTruncated: true })).truncated).toBe(true);
  });

  it("the previous change is the newest one older than the newest any stage follows", () => {
    expect(previousChange(row(), versions)?.version).toBe(7);
    expect(previousChange(row({ pointers: { pilot: 6, early: 6, everyone: 6 } }), versions)).toBeUndefined();
  });

  it("presets: Careful is 24 h and 10 %, Quick 4 h and 20 %, anything else on is Custom, Off keeps the numbers", () => {
    const d = draftOf(row());
    expect(modeOf(d)).toBe("off");
    expect(applyMode(d, "careful")).toMatchObject({ enabled: true, bake: "24", pct: "10" });
    expect(applyMode(d, "quick")).toMatchObject({ enabled: true, bake: "4", pct: "20" });
    expect(modeOf(applyMode(d, "quick"))).toBe("quick");
    expect(modeOf({ ...d, enabled: true, bake: "12", pct: "60" })).toBe("custom");
    expect(applyMode({ ...d, enabled: true, bake: "12", pct: "60" }, "off")).toMatchObject({ enabled: false, bake: "12", pct: "60" });
  });

  it("moves on at the start plus the bake time, only while testing with auto on", () => {
    const on = row({ autoPromote: { enabled: true, bakeHours: 10, maxFailurePct: 10 }, stageStartedAt: 1000 });
    expect(movesOnAt(on, { ring: "pilot", version: 8 })).toBe(1000 + 10 * HOUR);
    expect(movesOnAt(on, null)).toBeNull();
    expect(movesOnAt(row({ ...on, state: "halted" }), { ring: "pilot", version: 8 })).toBeNull();
    expect(movesOnAt(row(), { ring: "pilot", version: 8 })).toBeNull();
  });

  it("refusals keep their words with the new stage names", () => {
    expect(rolloutErrorMessage(new ConvexError({ code: "conflict", detail: "no_pilot_devices" }), "enable")).toBe(s.noPilotEnable);
    expect(rolloutErrorMessage(new ConvexError({ code: "conflict", detail: "no_pilot_devices" }), "rings")).toBe(s.noPilotRings);
    expect(s.haltReasons.rolled_back).toBe("Someone undid the change.");
  });
});

describe("Rollout, stages off", () => {
  beforeEach(() => {
    cx.results["rollouts:groupView"] = view({ rollout: row({ enabled: false, state: "idle", pointers: { pilot: 8, early: 8, everyone: 8 } }), stage: null, devices: pcs(["everyone", "everyone", "everyone"]) });
  });

  it("shows one card with Turn on instead of the stages, and never subscribes to the health numbers", async () => {
    page();
    expect(await screen.findByText(s.heroTitle)).toBeTruthy();
    expect(screen.getByRole("button", { name: s.turnOn })).toBeTruthy();
    expect(screen.queryByLabelText(s.stagesLabel)).toBeNull();
    expect(cx.queried).not.toContain("rollouts:health");
  });

  it("Turn on asks which PCs go first with the first PC ticked, then sets First and turns the rollout on with the returned revision", async () => {
    const setRings = vi.fn(async () => ({ revision: 9, changed: 1 }));
    const setEnabled = vi.fn(async () => ({ revision: 10 }));
    cx.fns["rollouts:setRings"] = setRings;
    cx.fns["rollouts:setEnabled"] = setEnabled;
    page();
    fireEvent.click(await screen.findByRole("button", { name: s.turnOn }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(s.firstTitle)).toBeTruthy();
    expect((within(dialog).getByRole("checkbox", { name: "PC-1" }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole("checkbox", { name: "PC-2" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "PC-2" }));
    fireEvent.click(within(dialog).getByRole("button", { name: s.firstConfirm }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalled());
    expect(setRings).toHaveBeenCalledWith({ groupId: "g1", deviceIds: ["d1", "d2"], ring: "pilot", expectedRevision: 3 });
    expect(setEnabled).toHaveBeenCalledWith({ groupId: "g1", enabled: true, expectedRevision: 9 });
    expect(setRings.mock.invocationCallOrder[0]!).toBeLessThan(setEnabled.mock.invocationCallOrder[0]!);
  });

  it("skips the PC change when First already has the ticked PCs, and says so in words when the server refuses", async () => {
    cx.results["rollouts:groupView"] = view({ rollout: row({ enabled: false, state: "idle" }), stage: null, devices: pcs(["pilot", "everyone"]) });
    const setRings = vi.fn();
    cx.fns["rollouts:setRings"] = setRings;
    cx.fns["rollouts:setEnabled"] = vi.fn().mockRejectedValue(new ConvexError({ code: "conflict", detail: "no_pilot_devices" }));
    page();
    fireEvent.click(await screen.findByRole("button", { name: s.turnOn }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: s.firstConfirm }));
    expect(await within(dialog).findByText(s.noPilotEnable)).toBeTruthy();
    expect(setRings).not.toHaveBeenCalled();
  });

  it("a group with no PCs gets the reason instead of a working button", async () => {
    cx.results["rollouts:groupView"] = view({ rollout: row({ enabled: false, state: "idle" }), stage: null, devices: [] });
    page();
    expect((await screen.findByRole("button", { name: s.turnOn }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(s.turnOnNoPcs)).toBeTruthy();
  });

  it("a group with no configuration yet links back to the group", async () => {
    cx.results["rollouts:groupView"] = view({ rollout: null, versions: [], stage: null });
    page();
    expect(await screen.findByText(s.noneTitle)).toBeTruthy();
    expect(screen.getByRole("link", { name: s.noneAction }).getAttribute("href")).toBe("/groups/g1");
  });
});

describe("Rollout, a change testing on First", () => {
  it("draws three stages with their states, the PC counts and the change each has; version numbers stay out of the main text", async () => {
    page();
    await screen.findByText(s.stageStates.testing);
    const items = screen.getAllByRole("listitem").filter((li) => li.classList.contains("ro-stage"));
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText(s.stages.pilot)).toBeTruthy();
    expect(within(items[0]!).getByText(s.stageStates.testing)).toBeTruthy();
    expect(within(items[0]!).getByText("1 PC")).toBeTruthy();
    expect(within(items[0]!).getByText("Label printer assigned")).toBeTruthy();
    expect(within(items[1]!).getByText(s.stageStates.waiting)).toBeTruthy();
    expect(within(items[1]!).getByText("Lockdown settings changed")).toBeTruthy();
    expect(within(items[2]!).getByText("2 PCs")).toBeTruthy();
    // The version is a tooltip title and sits in Technical details, never in a card's words.
    expect(items[0]!.querySelector(".ro-stage__has")?.getAttribute("title")).toBe(s.versionTitle(8));
    expect(within(items[0]!).queryByText(/version/i)).toBeNull();
    expect(screen.getByText(s.technicalVersion(s.stages.pilot, 8))).toBeTruthy();
    // The health of the testing stage is its own subscription.
    expect(cx.queried).toContain("rollouts:health");
    expect(within(items[0]!).getByText(s.progressLabel(1, 3))).toBeTruthy();
  });

  it("Send to Early PCs is on the stage that is testing and sends the revision", async () => {
    const promote = vi.fn(async () => ({ revision: 4 }));
    cx.fns["rollouts:promote"] = promote;
    page();
    fireEvent.click(await screen.findByRole("button", { name: s.sendEarly }));
    await waitFor(() => expect(promote).toHaveBeenCalledWith({ groupId: "g1", to: "early", expectedRevision: 3 }));
    expect(await screen.findByText(s.sentToast)).toBeTruthy();
  });

  it("with Early testing the action is Send to everyone", async () => {
    cx.results["rollouts:groupView"] = view({ rollout: row({ pointers: { pilot: 8, early: 8, everyone: 7 } }), stage: { ring: "early", version: 8 } });
    cx.results["rollouts:health"] = { ...health, stage: { ring: "early", version: 8 } };
    const promote = vi.fn(async () => ({ revision: 4 }));
    cx.fns["rollouts:promote"] = promote;
    page();
    fireEvent.click(await screen.findByRole("button", { name: s.sendEveryone }));
    await waitFor(() => expect(promote).toHaveBeenCalledWith({ groupId: "g1", to: "everyone", expectedRevision: 3 }));
    expect(screen.queryByRole("button", { name: s.sendEarly })).toBeNull();
  });

  it("Send to everyone now asks first, then sends everything on", async () => {
    const promoteAll = vi.fn(async () => ({ revision: 4 }));
    cx.fns["rollouts:promoteAll"] = promoteAll;
    page();
    fireEvent.click(await screen.findByRole("button", { name: s.sendEveryoneNow }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(s.sendEveryoneBody)).toBeTruthy();
    expect(promoteAll).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: s.sendEveryoneConfirm }));
    await waitFor(() => expect(promoteAll).toHaveBeenCalledWith({ groupId: "g1", expectedRevision: 3 }));
  });

  it("a change nobody is testing shows every stage up to date, no health subscription and no send button", async () => {
    cx.results["rollouts:groupView"] = view({ rollout: row({ pointers: { pilot: 8, early: 8, everyone: 8 }, state: "idle" }), stage: null });
    page();
    expect(await screen.findByText(s.allLevel)).toBeTruthy();
    expect(screen.getAllByText(s.stageStates.done)).toHaveLength(3);
    expect(cx.queried).not.toContain("rollouts:health");
    expect(screen.queryByRole("button", { name: s.sendEarly })).toBeNull();
  });

  it("says when it moves on by itself", async () => {
    cx.results["rollouts:groupView"] = view({ rollout: row({ autoPromote: { enabled: true, bakeHours: 24, maxFailurePct: 10 } }) });
    page();
    expect(await screen.findByText(/Moves on by itself in .* if nothing fails\./)).toBeTruthy();
  });

  it("a viewer reads the stages and the numbers and sees no buttons", async () => {
    page("viewer");
    await screen.findByText(s.stageStates.testing);
    expect(screen.queryByRole("button", { name: s.sendEarly })).toBeNull();
    expect(screen.queryByRole("button", { name: s.undo })).toBeNull();
    expect(screen.queryByRole("button", { name: s.moreLabel })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText(s.autoReadOnly("off", 24, 10))).toBeTruthy();
  });
});

describe("Rollout, paused", () => {
  beforeEach(() => {
    cx.results["rollouts:groupView"] = view({ rollout: row({ state: "halted", haltReason: "failure_rate", stageStartedAt: null }) });
  });

  it("shows the reason in words, hides the send buttons and resumes with the revision", async () => {
    const resume = vi.fn(async () => ({ revision: 4 }));
    cx.fns["rollouts:resume"] = resume;
    page();
    expect(await screen.findByText(s.haltedTitle)).toBeTruthy();
    expect(screen.getByText(new RegExp(s.haltReasons.failure_rate))).toBeTruthy();
    expect(screen.getByText(s.stageStates.paused)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.sendEarly })).toBeNull();
    expect(screen.queryByRole("button", { name: s.sendEveryoneNow })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: s.resume }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith({ groupId: "g1", expectedRevision: 3 }));
  });
});

describe("Moves on by itself", () => {
  const saveButton = () => screen.getByRole("button", { name: "Save" });

  it("Careful and Quick send their numbers in one save", async () => {
    const setAuto = vi.fn(async () => ({ revision: 4 }));
    cx.fns["rollouts:setAutoPromote"] = setAuto;
    page();
    expect((await screen.findByRole("radio", { name: s.autoModes.off })).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: s.autoModes.careful }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(setAuto).toHaveBeenCalledWith({ groupId: "g1", enabled: true, bakeHours: 24, maxFailurePct: 10, autoRollback: true, expectedRevision: 3 }));
    setAuto.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: s.autoModes.quick }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(setAuto).toHaveBeenCalledWith({ groupId: "g1", enabled: true, bakeHours: 4, maxFailurePct: 20, autoRollback: true, expectedRevision: 3 }));
  });

  it("saved numbers that match no preset show Custom; Off keeps them", async () => {
    cx.results["rollouts:groupView"] = view({ rollout: row({ autoPromote: { enabled: true, bakeHours: 12, maxFailurePct: 60 } }) });
    const setAuto = vi.fn(async () => ({ revision: 4 }));
    cx.fns["rollouts:setAutoPromote"] = setAuto;
    page();
    const custom = await screen.findByRole("radio", { name: s.autoModes.custom });
    expect(custom.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(s.autoCustomHint("12", "60"))).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: s.autoModes.off }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(setAuto).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, bakeHours: 12, maxFailurePct: 60 })));
  });

  it("the numbers are under Advanced and a wrong one is refused in words before anything is sent", async () => {
    const setAuto = vi.fn();
    cx.fns["rollouts:setAutoPromote"] = setAuto;
    page();
    await screen.findByRole("radio", { name: s.autoModes.off });
    fireEvent.click(screen.getByRole("radio", { name: s.autoModes.careful }));
    fireEvent.change(screen.getByLabelText(s.autoBake), { target: { value: "0" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(s.bakeRange)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(s.autoBake), { target: { value: "abc" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(s.whole.notWhole)).toBeTruthy();
    expect(setAuto).not.toHaveBeenCalled();
  });
});

describe("Which PCs go first", () => {
  it("ticking PCs shows the move bar; Move sends the chosen stage with the revision", async () => {
    const setRings = vi.fn(async () => ({ revision: 4, changed: 2 }));
    cx.fns["rollouts:setRings"] = setRings;
    page();
    fireEvent.click(await screen.findByLabelText(s.selectPc("PC-3")));
    fireEvent.click(screen.getByLabelText(s.selectPc("PC-4")));
    expect(screen.getByText(s.selected(2))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.move }));
    await waitFor(() => expect(setRings).toHaveBeenCalledWith({ groupId: "g1", deviceIds: ["d3", "d4"], ring: "pilot", expectedRevision: 3 }));
    expect(await screen.findByText(s.ringChanged(2))).toBeTruthy();
  });

  it("emptying First is refused in words", async () => {
    cx.fns["rollouts:setRings"] = vi.fn().mockRejectedValue(new ConvexError({ code: "conflict", detail: "no_pilot_devices" }));
    page();
    fireEvent.click(await screen.findByLabelText(s.selectPc("PC-1")));
    fireEvent.click(screen.getByRole("button", { name: s.move }));
    expect(await screen.findByText(s.noPilotRings)).toBeTruthy();
  });
});

describe("Undo the last change", () => {
  it("goes back to the previous change, on every stage, in one click", async () => {
    const rollback = vi.fn(async () => ({ revision: 4 }));
    cx.fns["rollouts:rollback"] = rollback;
    page();
    fireEvent.click(await screen.findByRole("button", { name: s.undo }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(s.undoLead)).toBeTruthy();
    // The previous change (version 7), not the newest.
    expect(within(dialog).getByText("Lockdown settings changed")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: s.undoConfirm }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith({ groupId: "g1", toVersion: 7, rings: ["pilot", "early", "everyone"], expectedRevision: 3 }));
  });

  it("Advanced lets an admin pick another change and the stages that go back", async () => {
    const rollback = vi.fn(async () => ({ revision: 4 }));
    cx.fns["rollouts:rollback"] = rollback;
    page();
    fireEvent.click(await screen.findByRole("button", { name: s.undo }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText(s.undoPick));
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp("App assigned") }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: s.stages.everyone }));
    fireEvent.click(within(dialog).getByRole("button", { name: s.undoConfirm }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith({ groupId: "g1", toVersion: 6, rings: ["pilot", "early"], expectedRevision: 3 }));
  });

  it("with no stage ticked it asks for one instead of sending", async () => {
    const rollback = vi.fn();
    cx.fns["rollouts:rollback"] = rollback;
    page();
    fireEvent.click(await screen.findByRole("button", { name: s.undo }));
    const dialog = await screen.findByRole("dialog");
    for (const r of [s.stages.pilot, s.stages.early, s.stages.everyone]) fireEvent.click(within(dialog).getByRole("checkbox", { name: r }));
    fireEvent.click(within(dialog).getByRole("button", { name: s.undoConfirm }));
    expect(await within(dialog).findByText(s.undoStagesProblem)).toBeTruthy();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("is not offered when no older change is kept", async () => {
    cx.results["rollouts:groupView"] = view({ rollout: row({ pointers: { pilot: 6, early: 6, everyone: 6 }, state: "idle" }), stage: null });
    page();
    await screen.findByText(s.allLevel);
    expect(screen.queryByRole("button", { name: s.undo })).toBeNull();
  });
});

describe("Turn off", () => {
  it("is in the More menu, asks first, and then turns the rollout off", async () => {
    const setEnabled = vi.fn(async () => ({ revision: 4 }));
    cx.fns["rollouts:setEnabled"] = setEnabled;
    page();
    fireEvent.click(await screen.findByRole("button", { name: s.moreLabel }));
    fireEvent.click(screen.getByRole("menuitem", { name: s.turnOff }));
    const dialog = await screen.findByRole("dialog");
    expect(setEnabled).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: s.turnOffConfirm }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ groupId: "g1", enabled: false, expectedRevision: 3 }));
  });
});
