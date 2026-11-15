import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me, RolloutHealth, RolloutRow, RolloutView } from "../data/types";
import { formatDate } from "../lib/format";
import { MeContext } from "../lib/member";
import { bakeProblem, draftChanged, draftOf, failureProblem, knownHaltReason, wholeProblem } from "../lib/rolloutRules";
import { setStepUpHandler } from "../lib/stepUpRetry";
import { strings } from "../lib/strings";
import { actionLabel } from "../lib/audit";
import { groupStrings } from "../lib/screenStrings/group";
import { rolloutErrorMessage, rolloutStrings as s } from "./rollout/strings";

// Phase 5 Step 16 screen (`/groups/:id/rollout`: rings, pointers, health, promote, rollback, automatic promotion, the PCs' rings)
// against the LIVE data seam with the Convex React hooks mocked, like step15.test.tsx.
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  queried: [] as { name: string; args: unknown }[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        cx.queried.push({ name: getFunctionName(r.query), args: r.args });
        return [k, cx.results[getFunctionName(r.query)]];
      }),
    ),
  useQuery: () => undefined,
  useAction: (ref: FunctionReference<"action">) => fnFor(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));

type Mock = ((args?: unknown) => Promise<unknown>) & { withOptimisticUpdate: () => Mock };
const stable = new Map<string, Mock>();
function fnFor(name: string): Mock {
  let f = stable.get(name);
  if (!f) {
    const call = ((args?: unknown) => {
      const impl = cx.fns[name];
      if (!impl) throw new Error(`no mock for ${name}`);
      return impl(args);
    }) as Mock;
    call.withOptimisticUpdate = () => call;
    f = call;
    stable.set(name, f);
  }
  return f;
}

import { ToastProvider } from "../app/Toasts";
import GroupDetail from "./GroupDetail";
import Rollout from "./Rollout";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme Pharmacy",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function ui(role: Me["role"] = "admin", path = "/groups/g1/rollout", node: ReactNode = <Rollout />) {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/groups/:id/rollout" element={node} />
            <Route path="/groups/:id" element={node} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

const NOW = Date.now();
const DAY = 86_400_000;
const VERSIONS = [
  { version: 8, reason: "Label printer assigned", createdAt: NOW - 1 * DAY },
  { version: 7, reason: "Lockdown settings changed", createdAt: NOW - 3 * DAY },
  { version: 6, reason: "App assigned", createdAt: NOW - 5 * DAY },
];

const row = (over: Partial<RolloutRow> = {}): RolloutRow => ({
  enabled: true,
  pointers: { pilot: 8, early: 7, everyone: 7 },
  autoPromote: { enabled: false, bakeHours: 24, maxFailurePct: 10 },
  autoRollback: true,
  state: "rolling",
  haltReason: null,
  stageStartedAt: NOW - 3_600_000,
  revision: 3,
  ...over,
});

const view = (over: Partial<RolloutView> = {}): RolloutView => ({
  groupName: "Pharmacy counter",
  rollout: row(),
  versions: VERSIONS,
  stage: { ring: "pilot", version: 8 },
  devices: [
    { _id: "d1", name: "COUNTER-01", ring: "pilot" },
    { _id: "d2", name: "COUNTER-02", ring: "pilot" },
    { _id: "d3", name: "COUNTER-03", ring: "everyone" },
  ],
  devicesTruncated: false,
  ...over,
});

const health = (over: Partial<RolloutHealth> = {}): RolloutHealth => ({
  stage: { ring: "pilot", version: 8 },
  ringSize: 2,
  ringCapped: false,
  applied: 1,
  failed: 0,
  partial: 0,
  waiting: 1,
  pilotRolledBack: false,
  reportsCapped: false,
  ...over,
});

const conflict = (detail: string) => new ConvexError({ code: "conflict", detail });
const revision = { revision: 4 };

function show(v: RolloutView, h: RolloutHealth = health()) {
  cx.results["rollouts:groupView"] = v;
  cx.results["rollouts:health"] = h;
}

let offHandler: (() => void) | null = null;

beforeEach(() => {
  cx.results = {};
  cx.queried = [];
  cx.fns = {};
  show(view());
});
afterEach(() => {
  offHandler?.();
  offHandler = null;
  cleanup();
});

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const noButton = (name: string | RegExp) => expect(screen.queryByRole("button", { name })).toBeNull();

describe("the rules of the form", () => {
  it("accept whole numbers in range only", () => {
    expect(wholeProblem("", 1, 168)).toBe("empty");
    expect(wholeProblem("  ", 1, 168)).toBe("empty");
    expect(wholeProblem("2.5", 1, 168)).toBe("notWhole");
    expect(wholeProblem("-3", 1, 168)).toBe("notWhole");
    expect(wholeProblem("abc", 1, 168)).toBe("notWhole");
    expect(bakeProblem("0")).toBe("range");
    expect(bakeProblem("1")).toBeNull();
    expect(bakeProblem("168")).toBeNull();
    expect(bakeProblem("169")).toBe("range");
    expect(failureProblem("0")).toBe("range");
    expect(failureProblem("100")).toBeNull();
    expect(failureProblem("101")).toBe("range");
  });

  it("know the halt codes, and compare a draft with the saved settings", () => {
    expect(knownHaltReason("failure_rate")).toBe("failure_rate");
    expect(knownHaltReason("something_new")).toBeNull();
    expect(knownHaltReason(null)).toBeNull();
    const r = row();
    expect(draftChanged(draftOf(r), r)).toBe(false);
    expect(draftChanged({ ...draftOf(r), bake: "25" }, r)).toBe(true);
    expect(draftChanged({ ...draftOf(r), autoRollback: false }, r)).toBe(true);
  });

  it("put each refusal into words, the same conflict differently for rings and for turning rings on", () => {
    expect(rolloutErrorMessage(conflict("no_pilot_devices"), "enable")).toBe(s.noPilotEnable);
    expect(rolloutErrorMessage(conflict("no_pilot_devices"), "rings")).toBe(s.noPilotRings);
    expect(rolloutErrorMessage(conflict("halted"))).toBe(s.halted);
    expect(rolloutErrorMessage(conflict("rings_disabled"))).toBe(s.ringsDisabled);
    expect(rolloutErrorMessage(conflict("nothing_to_promote"))).toBe(s.nothingToPromote);
    expect(rolloutErrorMessage(conflict("version_missing"))).toBe(s.versionMissing);
    expect(rolloutErrorMessage(conflict("not_halted"))).toBe(s.notHalted);
    expect(rolloutErrorMessage(conflict("something else"))).toBeNull();
    expect(rolloutErrorMessage(new Error("boom"))).toBeNull();
  });

  it("label every audit action of the rollout (the new settings one too)", () => {
    for (const a of ["rollout.enabled", "rollout.disabled", "rollout.promoted", "rollout.autoPromoted", "rollout.halted", "rollout.resumed", "rollout.rolledBack", "rollout.settingsChanged", "device.ringChanged"]) {
      expect(actionLabel(a), a).not.toBe(a);
    }
  });
});

describe("the rollout screen", () => {
  it("shows what each ring follows with the version's reason and date, and marks the stage in flight", () => {
    ui();
    expect(screen.getByRole("heading", { level: 1, name: s.titleFor("Pharmacy counter") })).toBeTruthy();
    const list = screen.getByRole("list", { name: s.pointersTitle });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText(s.rings.pilot)).toBeTruthy();
    expect(within(rows[0]!).getByText(s.version(8))).toBeTruthy();
    expect(within(rows[0]!).getByText(`Label printer assigned, ${formatDate(VERSIONS[0]!.createdAt)}`)).toBeTruthy();
    expect(within(rows[1]!).getByText(s.version(7))).toBeTruthy();
    expect(within(rows[1]!).getByText(`Lockdown settings changed, ${formatDate(VERSIONS[1]!.createdAt)}`)).toBeTruthy();
    expect(within(rows[2]!).getByText(s.version(7))).toBeTruthy();
    // Only the pilot ring is getting the newest version now.
    expect(rows[0]!.getAttribute("data-stage")).toBe("true");
    expect(rows[1]!.getAttribute("data-stage")).toBeNull();
    expect(within(rows[0]!).getByText(s.inFlight)).toBeTruthy();
    expect(within(rows[2]!).queryByText(s.inFlight)).toBeNull();
  });

  it("subscribes to the quiet view and to the health of the stage, each with the group id", () => {
    ui();
    expect(cx.queried.find((q) => q.name === "rollouts:groupView")?.args).toEqual({ groupId: "g1" });
    expect(cx.queried.find((q) => q.name === "rollouts:health")?.args).toEqual({ groupId: "g1" });
  });

  it("says the numbers of the stage in flight and that no pilot PC has applied the version yet", () => {
    show(view(), health({ applied: 0, failed: 0, partial: 0, waiting: 2 }));
    ui();
    const card = screen.getByRole("heading", { name: s.healthTitle }).closest("section")!;
    expect(within(card).getByText(s.healthFor("Pilot", 8))).toBeTruthy();
    expect(within(card).getByText(new RegExp(s.ringSize(2)))).toBeTruthy();
    for (const label of [s.applied, s.failed, s.partial, s.waiting]) expect(within(card).getByText(label)).toBeTruthy();
    expect(within(card).getByText(s.noPilotApplied)).toBeTruthy();
    cleanup();
    show(view(), health({ applied: 1, failed: 1, partial: 2, waiting: 3, ringSize: 7 }));
    ui();
    const again = screen.getByRole("heading", { name: s.healthTitle }).closest("section")!;
    expect(within(again).queryByText(s.noPilotApplied)).toBeNull();
    expect(within(again).getByText(s.waiting).nextElementSibling?.textContent).toBe("3");
    expect(within(again).getByText(s.failed).nextElementSibling?.textContent).toBe("1");
  });

  it("says when the ring is larger than the numbers cover, when reports may be incomplete and when a pilot PC rolled back", () => {
    show(view(), health({ ringCapped: true, reportsCapped: true, pilotRolledBack: true, ringSize: 200 }));
    ui();
    expect(screen.getByText(s.ringCapped(200))).toBeTruthy();
    expect(screen.getByText(s.reportsCapped)).toBeTruthy();
    expect(screen.getByText(s.pilotRolledBack)).toBeTruthy();
  });

  it("an early stage is not the pilot case: no 'no pilot PC' note, the early ring is marked", () => {
    show(
      view({ rollout: row({ pointers: { pilot: 8, early: 8, everyone: 7 } }), stage: { ring: "early", version: 8 } }),
      health({ stage: { ring: "early", version: 8 }, applied: 0, waiting: 3, ringSize: 3 }),
    );
    ui();
    expect(screen.queryByText(s.noPilotApplied)).toBeNull();
    expect(screen.getByText(s.healthFor("Early", 8))).toBeTruthy();
    const rows = within(screen.getByRole("list", { name: s.pointersTitle })).getAllByRole("listitem");
    expect(rows[1]!.getAttribute("data-stage")).toBe("true");
    expect(rows[0]!.getAttribute("data-stage")).toBeNull();
  });

  it("with rings on and nothing in flight, says so and subscribes to no health", () => {
    show(view({ rollout: row({ pointers: { pilot: 8, early: 8, everyone: 8 }, state: "idle" }), stage: null }));
    ui();
    expect(screen.getByText(s.healthNone)).toBeTruthy();
    expect(cx.queried.some((q) => q.name === "rollouts:health")).toBe(false);
    noButton(s.promoteEarly);
    noButton(s.promoteEveryone);
    noButton(s.promoteAll);
    expect(screen.getByText(s.actionsNothing)).toBeTruthy();
    // A rollback stays possible.
    expect(button(s.rollback)).toBeTruthy();
  });

  it("with rings off: the switch is off, nothing to promote, no health, and the rollback is still there", () => {
    show(view({ rollout: row({ enabled: false, pointers: { pilot: 8, early: 8, everyone: 8 }, state: "idle" }), stage: null }));
    ui();
    expect((screen.getByRole("switch", { name: s.ringsSwitch }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(s.ringsOffNote)).toBeTruthy();
    expect(screen.getByText(s.actionsOff)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: s.healthTitle })).toBeNull();
    expect(cx.queried.some((q) => q.name === "rollouts:health")).toBe(false);
    noButton(s.promoteEarly);
    expect(button(s.rollback)).toBeTruthy();
  });

  it("a group with no configuration version yet explains that rings start once it has one", () => {
    show(view({ rollout: null, versions: [], stage: null }));
    ui();
    expect(screen.getByText(s.noneTitle)).toBeTruthy();
    expect(screen.getByText(s.noneBody)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(cx.queried.some((q) => q.name === "rollouts:health")).toBe(false);
  });

  it("shows a loading state, then an error with Try again when the view cannot be read", () => {
    cx.results = {};
    ui();
    expect(screen.getByRole("status", { name: strings.app.loading })).toBeTruthy();
    cleanup();
    cx.results["rollouts:groupView"] = new ConvexError({ code: "not_found" });
    ui();
    expect(screen.getByText(strings.common.regionFailed)).toBeTruthy();
    expect(screen.getByRole("link", { name: s.back })).toBeTruthy();
  });

  it("the health region fails on its own: the rest of the screen stays", () => {
    cx.results["rollouts:health"] = new Error("boom");
    ui();
    expect(screen.getByText(strings.common.regionFailed)).toBeTruthy();
    expect(button(s.rollback)).toBeTruthy();
    expect(screen.getByRole("switch", { name: s.ringsSwitch })).toBeTruthy();
  });
});

describe("the rings switch", () => {
  const off = () => show(view({ rollout: row({ enabled: false, pointers: { pilot: 8, early: 8, everyone: 8 }, state: "idle" }), stage: null }));

  it("turns rings on with the loaded revision", async () => {
    off();
    const setEnabled = vi.fn(async () => revision);
    cx.fns["rollouts:setEnabled"] = setEnabled;
    ui();
    fireEvent.click(screen.getByRole("switch", { name: s.ringsSwitch }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ groupId: "g1", enabled: true, expectedRevision: 3 }));
    expect(await screen.findByText(s.ringsOnToast)).toBeTruthy();
  });

  it("says in words to put a PC in the pilot ring first when the server refuses", async () => {
    off();
    cx.fns["rollouts:setEnabled"] = vi.fn().mockRejectedValue(conflict("no_pilot_devices"));
    ui();
    fireEvent.click(screen.getByRole("switch", { name: s.ringsSwitch }));
    expect(await screen.findByText(s.noPilotEnable)).toBeTruthy();
  });

  it("turning rings off asks first: every ring will get the newest version at once", async () => {
    const setEnabled = vi.fn(async () => revision);
    cx.fns["rollouts:setEnabled"] = setEnabled;
    ui();
    fireEvent.click(screen.getByRole("switch", { name: s.ringsSwitch }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(s.ringsOffBody)).toBeTruthy();
    expect(setEnabled).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: s.ringsOffConfirm }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ groupId: "g1", enabled: false, expectedRevision: 3 }));
    expect(await screen.findByText(s.ringsOffToast)).toBeTruthy();
  });

  it("cancelling the confirmation changes nothing", () => {
    const setEnabled = vi.fn(async () => revision);
    cx.fns["rollouts:setEnabled"] = setEnabled;
    ui();
    fireEvent.click(screen.getByRole("switch", { name: s.ringsSwitch }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: strings.common.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setEnabled).not.toHaveBeenCalled();
  });
});

describe("promotion", () => {
  it("while the pilot ring is in flight: Promote to Early (and Promote all), not Promote to Everyone", async () => {
    const promote = vi.fn(async () => revision);
    cx.fns["rollouts:promote"] = promote;
    ui();
    noButton(s.promoteEveryone);
    expect(button(s.promoteAll)).toBeTruthy();
    fireEvent.click(button(s.promoteEarly));
    await waitFor(() => expect(promote).toHaveBeenCalledWith({ groupId: "g1", to: "early", expectedRevision: 3 }));
    expect(await screen.findByText(s.promotedToast)).toBeTruthy();
  });

  it("while the early ring is ahead of everyone: Promote to Everyone, not Promote to Early", async () => {
    show(view({ rollout: row({ pointers: { pilot: 8, early: 8, everyone: 7 } }), stage: { ring: "early", version: 8 } }), health({ stage: { ring: "early", version: 8 } }));
    const promote = vi.fn(async () => revision);
    cx.fns["rollouts:promote"] = promote;
    ui();
    noButton(s.promoteEarly);
    fireEvent.click(button(s.promoteEveryone));
    await waitFor(() => expect(promote).toHaveBeenCalledWith({ groupId: "g1", to: "everyone", expectedRevision: 3 }));
  });

  it("Promote all asks first and then promotes", async () => {
    const promoteAll = vi.fn(async () => revision);
    cx.fns["rollouts:promoteAll"] = promoteAll;
    ui();
    fireEvent.click(button(s.promoteAll));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(s.promoteAllBody(8))).toBeTruthy();
    expect(promoteAll).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: s.promoteAllConfirm }));
    await waitFor(() => expect(promoteAll).toHaveBeenCalledWith({ groupId: "g1", expectedRevision: 3 }));
    expect(await screen.findByText(s.promotedToast)).toBeTruthy();
  });

  it("a refusal is said in words next to the buttons", async () => {
    cx.fns["rollouts:promote"] = vi.fn().mockRejectedValue(conflict("nothing_to_promote"));
    ui();
    fireEvent.click(button(s.promoteEarly));
    expect(await screen.findByText(s.nothingToPromote)).toBeTruthy();
  });

  it("someone else changed the rollout: the usual notice with Reload, and Reload clears it", async () => {
    cx.fns["rollouts:promote"] = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    ui();
    fireEvent.click(button(s.promoteEarly));
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    fireEvent.click(button(strings.common.reload));
    expect(screen.queryByText(strings.common.staleTitle)).toBeNull();
  });
});

describe("a halted rollout", () => {
  const halted = (haltReason: string | null) => show(view({ rollout: row({ state: "halted", haltReason, stageStartedAt: null }), stage: { ring: "pilot", version: 8 } }));

  it.each([
    ["failure_rate", "Too many PCs failed to apply the new configuration."],
    ["pilot_rolled_back", "A pilot PC rolled the new configuration back."],
    ["rolled_back", "An administrator rolled this group back."],
  ])("says why in plain words for %s", (code, text) => {
    halted(code);
    ui();
    const banner = screen.getByText(s.haltedTitle).closest(".dash-notice")!;
    expect(banner.className).toContain("dash-notice--danger");
    expect(banner.textContent).toContain(text);
  });

  it("uses a generic sentence for a code it does not know", () => {
    halted("a_new_reason");
    ui();
    expect(screen.getByText(new RegExp(s.haltGeneric))).toBeTruthy();
  });

  it("offers Resume (and no Promote buttons) and calls resume with the revision", async () => {
    halted("failure_rate");
    const resume = vi.fn(async () => revision);
    cx.fns["rollouts:resume"] = resume;
    ui();
    noButton(s.promoteEarly);
    noButton(s.promoteAll);
    expect(screen.getByText(s.actionsHalted)).toBeTruthy();
    fireEvent.click(button(s.resume));
    await waitFor(() => expect(resume).toHaveBeenCalledWith({ groupId: "g1", expectedRevision: 3 }));
    expect(await screen.findByText(s.resumedToast)).toBeTruthy();
  });

  it("Resume is not there when the rollout is not halted, nor for a viewer", () => {
    ui();
    noButton(s.resume);
    cleanup();
    halted("failure_rate");
    ui("viewer");
    expect(screen.getByText(s.haltedTitle)).toBeTruthy();
    noButton(s.resume);
  });
});

describe("rollback", () => {
  const open = () => {
    ui();
    fireEvent.click(button(s.rollback));
    return screen.getByRole("dialog");
  };

  it("explains what it does, lists the versions newest first, and checks every ring", () => {
    const dialog = open();
    expect(within(dialog).getByText(s.rollbackLead)).toBeTruthy();
    const select = within(dialog).getByLabelText(s.rollbackVersion) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["8", "7", "6"]);
    expect(select.options[0]!.textContent).toBe(s.rollbackVersionOption(8, "Label printer assigned", formatDate(VERSIONS[0]!.createdAt)));
    // The default is the newest version older than the newest one a ring follows.
    expect(select.value).toBe("7");
    for (const ring of ["Pilot", "Early", "Everyone"]) expect((within(dialog).getByRole("checkbox", { name: ring }) as HTMLInputElement).checked).toBe(true);
  });

  it("rolls the chosen rings back to the chosen version, with the loaded revision", async () => {
    const rollback = vi.fn(async () => revision);
    cx.fns["rollouts:rollback"] = rollback;
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText(s.rollbackVersion), { target: { value: "6" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Everyone" }));
    fireEvent.click(within(dialog).getByRole("button", { name: s.rollbackConfirm }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith({ groupId: "g1", toVersion: 6, rings: ["pilot", "early"], expectedRevision: 3 }));
    expect(await screen.findByText(s.rolledBackToast)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("wants at least one ring", () => {
    const rollback = vi.fn();
    cx.fns["rollouts:rollback"] = rollback;
    const dialog = open();
    for (const ring of ["Pilot", "Early", "Everyone"]) fireEvent.click(within(dialog).getByRole("checkbox", { name: ring }));
    fireEvent.click(within(dialog).getByRole("button", { name: s.rollbackConfirm }));
    expect(within(dialog).getByText(s.rollbackRingsProblem)).toBeTruthy();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("with rings off all three are implied: no checklist, every ring is sent", async () => {
    show(view({ rollout: row({ enabled: false, pointers: { pilot: 8, early: 8, everyone: 8 }, state: "idle" }), stage: null }));
    const rollback = vi.fn(async () => revision);
    cx.fns["rollouts:rollback"] = rollback;
    const dialog = open();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).getByText(s.rollbackRingsOff)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: s.rollbackConfirm }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith({ groupId: "g1", toVersion: 7, rings: ["pilot", "early", "everyone"], expectedRevision: 3 }));
  });

  it("a major action: the step-up dialog opens, and the call is retried exactly once", async () => {
    const rollback = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required", detail: "fresh" }))
      .mockResolvedValueOnce(revision);
    cx.fns["rollouts:rollback"] = rollback;
    const handler = vi.fn(async () => true);
    offHandler = setStepUpHandler(handler);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: s.rollbackConfirm }));
    expect(await screen.findByText(s.rolledBackToast)).toBeTruthy();
    expect(handler).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledTimes(2);
  });

  it("cancelling the step-up keeps the dialog open with the reason; nothing is rolled back", async () => {
    const rollback = vi.fn(async () => {
      throw new ConvexError({ code: "step_up_required", detail: "fresh" });
    });
    cx.fns["rollouts:rollback"] = rollback;
    offHandler = setStepUpHandler(async () => false);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: s.rollbackConfirm }));
    expect(await within(dialog).findByText(strings.errors.stepUpRequired)).toBeTruthy();
    expect(rollback).toHaveBeenCalledOnce();
    expect(screen.queryByText(s.rolledBackToast)).toBeNull();
  });

  it("a version that is gone is said in words", async () => {
    cx.fns["rollouts:rollback"] = vi.fn().mockRejectedValue(conflict("version_missing"));
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: s.rollbackConfirm }));
    expect(await within(dialog).findByText(s.versionMissing)).toBeTruthy();
  });

  it("with no version kept there is nothing to choose and nothing to send", () => {
    show(view({ versions: [] }));
    const dialog = open();
    expect(within(dialog).getByText(s.rollbackNoVersions)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: s.rollbackConfirm }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("automatic promotion", () => {
  const card = () => screen.getByRole("heading", { name: s.autoTitle }).closest("section")!;
  const bake = () => within(card()).getByLabelText(new RegExp(`^${esc(s.autoBake)}`)) as HTMLInputElement;
  const pct = () => within(card()).getByLabelText(new RegExp(`^${esc(s.autoPct)}`)) as HTMLInputElement;
  const save = () => within(card()).getByRole("button", { name: s.autoSave }) as HTMLButtonElement;

  it("starts from the saved settings (off, 24 hours, 10 percent, pilot goes back) and has nothing to save", () => {
    ui();
    expect(within(card()).getByRole("switch", { name: s.autoSwitch }).getAttribute("aria-checked")).toBe("false");
    expect(bake().value).toBe("24");
    expect(pct().value).toBe("10");
    expect(within(card()).getByRole("switch", { name: s.autoRollback }).getAttribute("aria-checked")).toBe("true");
    expect(save().disabled).toBe(true);
  });

  it.each([
    ["0", "bake"],
    ["169", "bake"],
    ["", "bake"],
    ["2.5", "bake"],
    ["0", "pct"],
    ["101", "pct"],
    ["abc", "pct"],
  ])("refuses %s for the %s field before calling the server", (text, field) => {
    const setAutoPromote = vi.fn();
    cx.fns["rollouts:setAutoPromote"] = setAutoPromote;
    ui();
    fireEvent.change(field === "bake" ? bake() : pct(), { target: { value: text } });
    fireEvent.click(save());
    expect(within(card()).getByText(field === "bake" ? (text === "" ? s.whole.empty : text === "2.5" ? s.whole.notWhole : s.bakeRange) : text === "abc" ? s.whole.notWhole : s.pctRange)).toBeTruthy();
    expect(setAutoPromote).not.toHaveBeenCalled();
  });

  it("saves all four values in one call, with the loaded revision, and the edge values pass", async () => {
    const setAutoPromote = vi.fn(async () => revision);
    cx.fns["rollouts:setAutoPromote"] = setAutoPromote;
    ui();
    fireEvent.click(within(card()).getByRole("switch", { name: s.autoSwitch }));
    fireEvent.change(bake(), { target: { value: "168" } });
    fireEvent.change(pct(), { target: { value: " 1 " } });
    fireEvent.click(within(card()).getByRole("switch", { name: s.autoRollback }));
    fireEvent.click(save());
    await waitFor(() =>
      expect(setAutoPromote).toHaveBeenCalledWith({ groupId: "g1", enabled: true, bakeHours: 168, maxFailurePct: 1, autoRollback: false, expectedRevision: 3 }),
    );
    expect(setAutoPromote).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(s.autoSaved)).toBeTruthy();
  });

  it("a server refusal of a field is said in words", async () => {
    cx.fns["rollouts:setAutoPromote"] = vi.fn().mockRejectedValue(new ConvexError({ code: "invalid_argument", field: "bakeHours" }));
    ui();
    fireEvent.change(bake(), { target: { value: "48" } });
    fireEvent.click(save());
    expect(await within(card()).findByText(s.badBake)).toBeTruthy();
  });

  it("a stale edit offers Reload, which puts the saved values back", async () => {
    cx.fns["rollouts:setAutoPromote"] = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    ui();
    fireEvent.change(bake(), { target: { value: "48" } });
    fireEvent.click(save());
    expect(await within(card()).findByText(strings.common.staleTitle)).toBeTruthy();
    fireEvent.click(within(card()).getByRole("button", { name: strings.common.reload }));
    expect(bake().value).toBe("24");
    expect(within(card()).queryByText(strings.common.staleTitle)).toBeNull();
  });
});

describe("the PCs of the group", () => {
  const card = () => screen.getByRole("heading", { name: s.membersTitle }).closest("section")!;

  it("lists each PC with its ring", () => {
    ui();
    const rows = within(within(card()).getByRole("list", { name: s.membersTitle })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("COUNTER-01")).toBeTruthy();
    expect(within(rows[0]!).getByText("Pilot")).toBeTruthy();
    expect(within(rows[2]!).getByText("Everyone")).toBeTruthy();
  });

  it("says when only the first 100 are shown", () => {
    show(view({ devicesTruncated: true }));
    ui();
    expect(screen.getByText(s.membersTruncated)).toBeTruthy();
    cleanup();
    show(view());
    ui();
    expect(screen.queryByText(s.membersTruncated)).toBeNull();
  });

  it("puts the selected PCs in a ring with one call, and clears the selection", async () => {
    const setRings = vi.fn(async () => ({ revision: 4, changed: 2 }));
    cx.fns["rollouts:setRings"] = setRings;
    ui();
    const put = within(card()).getByRole("group", { name: s.putIn });
    // Nothing selected: nothing to put anywhere.
    expect((within(put).getByRole("button", { name: s.rings.early }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card()).getByRole("checkbox", { name: s.selectPc("COUNTER-02") }));
    fireEvent.click(within(card()).getByRole("checkbox", { name: s.selectPc("COUNTER-03") }));
    expect(within(card()).getByText(s.selected(2))).toBeTruthy();
    fireEvent.click(within(put).getByRole("button", { name: s.rings.early }));
    await waitFor(() => expect(setRings).toHaveBeenCalledWith({ groupId: "g1", deviceIds: ["d2", "d3"], ring: "early", expectedRevision: 3 }));
    expect(await screen.findByText(s.ringChanged(2))).toBeTruthy();
    expect(within(card()).getByText(s.selected(0))).toBeTruthy();
  });

  it("selects every PC shown, and clears them again", () => {
    ui();
    fireEvent.click(within(card()).getByRole("checkbox", { name: s.selectAll }));
    expect(within(card()).getByText(s.selected(3))).toBeTruthy();
    fireEvent.click(within(card()).getByRole("checkbox", { name: s.selectAll }));
    expect(within(card()).getByText(s.selected(0))).toBeTruthy();
  });

  it("says that rings are on and the pilot ring would be empty when the server refuses", async () => {
    cx.fns["rollouts:setRings"] = vi.fn().mockRejectedValue(conflict("no_pilot_devices"));
    ui();
    fireEvent.click(within(card()).getByRole("checkbox", { name: s.selectAll }));
    fireEvent.click(within(within(card()).getByRole("group", { name: s.putIn })).getByRole("button", { name: s.rings.everyone }));
    expect(await within(card()).findByText(s.noPilotRings)).toBeTruthy();
  });

  it("a stale edit shows the usual notice", async () => {
    cx.fns["rollouts:setRings"] = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    ui();
    fireEvent.click(within(card()).getByRole("checkbox", { name: s.selectPc("COUNTER-01") }));
    fireEvent.click(within(within(card()).getByRole("group", { name: s.putIn })).getByRole("button", { name: s.rings.pilot }));
    expect(await within(card()).findByText(strings.common.staleTitle)).toBeTruthy();
  });

  it("a group with no PCs says so", () => {
    show(view({ devices: [] }));
    ui();
    expect(within(card()).getByText(s.membersNone)).toBeTruthy();
    expect(within(card()).queryByRole("group", { name: s.putIn })).toBeNull();
  });
});

describe("a viewer", () => {
  it("sees the rollout, the numbers and the PCs, but no switch, no button and no form", () => {
    ui("viewer");
    expect(screen.getByRole("heading", { level: 1, name: s.titleFor("Pharmacy counter") })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: s.pointersTitle })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(s.healthFor("Pilot", 8))).toBeTruthy();
    expect(screen.getByText("COUNTER-01")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const name of [s.promoteEarly, s.promoteEveryone, s.promoteAll, s.rollback, s.resume, s.autoSave, s.rings.pilot, s.rings.early, s.rings.everyone]) noButton(name);
    expect(screen.getByText(s.autoReadOnly(false, 24, 10, true))).toBeTruthy();
    // The state is still told.
    expect(screen.getByText(s.ringsOn)).toBeTruthy();
  });
});

describe("the group page", () => {
  it("links to the rollout screen, for admins and viewers alike", () => {
    cx.results["groups:get"] = {
      group: { _id: "g1", name: "Pharmacy counter", revision: 0, createdAt: 1, devices: { count: 3, more: false }, employees: { count: 0, more: false } },
      apps: [],
    };
    ui("viewer", "/groups/g1", <GroupDetail />);
    const link = screen.getByRole("link", { name: groupStrings.rollout });
    expect(link.getAttribute("href")).toBe("/groups/g1/rollout");
    cleanup();
    ui("admin", "/groups/g1", <GroupDetail />);
    expect(screen.getByRole("link", { name: groupStrings.rollout }).getAttribute("href")).toBe("/groups/g1/rollout");
  });
});
