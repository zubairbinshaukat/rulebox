import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { EnrollmentCodeRow, Me, PlanScreen } from "../data/types";
import { MeContext } from "../lib/member";
import { RULEBOX_RELEASES_URL } from "../lib/links";
import { setStepUpHandler } from "../lib/stepUpRetry";
import { strings } from "../lib/strings";
import { pickOption, selectedText } from "../test/select";

// Phase 4 Step 6 and the UI-pass "Add a PC" screen: the page against the LIVE data seam with the Convex React hooks mocked. Queries
// answer from `cx.results[<name>]`, the list page from `cx.paged` (an Error is returned, as `useQueries` does; the status "CanLoadMore"
// means the server has more rows after this page), mutations / actions call `cx.fns[<name>]`. `cx.asked` records every query that was
// really subscribed (a skipped one never reaches `useQueries`).
type Paged = { results: unknown[]; status: string } | Error;
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
  paged: null as unknown,
  pagedArgs: [] as unknown[],
  asked: [] as string[],
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        const name = getFunctionName(r.query);
        cx.asked.push(name);
        if (name !== "enrollmentCodes:list") return [k, cx.results[name]];
        cx.pagedArgs.push(r.args);
        const p = cx.paged as Paged;
        if (p instanceof Error) return [k, p];
        if (p.status === "LoadingFirstPage") return [k, undefined];
        return [k, { page: p.results, isDone: p.status === "Exhausted", continueCursor: `c:${p.results.length}` }];
      }),
    ),
  useQuery: () => undefined,
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

import { ToastProvider } from "../app/Toasts";
import Enrollment from "./Enrollment";
import { LAST_GROUP_KEY, autoLabel, codeBlocks, displayState, labelProblem, untilText } from "./enrollment/model";
import { enrollText as s } from "./enrollment/strings";
import { planLimitMessage, plan as planText } from "./settings/strings";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}
const where = () => screen.getByTestId("where").textContent;

function tree(role: Me["role"], path = "/enrollment") {
  return (
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/enrollment" element={<Enrollment />} />
            <Route path="/devices" element={<p>devices page</p>} />
            <Route path="/devices/:id" element={<p>device page</p>} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>
  );
}
const ui = (role: Me["role"] = "admin", path = "/enrollment") => render(tree(role, path));

const freePlan: PlanScreen = {
  plan: "free",
  status: "active",
  limits: {
    maxDevices: 2,
    maxEmployees: 25,
    maxApps: 20,
    maxGroups: 3,
    maxMembers: 2,
    auditRetentionDays: 30,
    storageQuotaBytes: 1024 ** 3,
    maxUploadBytes: 500 * 1024 ** 2,
    watchMode: true,
    maxEnrollmentCodesActive: 5,
  },
  usage: { devices: 0, employees: 0, apps: 0, groups: 2, members: 1, enrollmentCodes: 0 },
  pingIntervalMs: 1_800_000,
};

const groupRow = (id: string, name: string) => ({ _id: id, name, revision: 0, createdAt: 1, devices: { count: 0, more: false }, employees: { count: 0, more: false } });

const NOW = Date.UTC(2026, 9, 27, 10, 0, 10);
const row = (i: number, over: Partial<EnrollmentCodeRow> = {}): EnrollmentCodeRow => ({
  _id: `tok${i}`,
  label: `PC ${i}`,
  groupId: "g1",
  groupName: "Front desk",
  usesLeft: 3,
  usesTotal: 5,
  expiresAt: Date.now() + 86_400_000,
  createdAt: Date.now() - 60_000,
  state: "active",
  createdByEmail: "admin@x.test",
  ...over,
});

const ready = (results: unknown[], status = "Exhausted") => ({ results, status });

/** A code in the exact format of `formatEnrollmentCode` (RBX1. + base64url, no padding). */
const CODE = `RBX1.${btoa("https://peaceful-peccary-48.convex.cloud#0123456789ABCDEFGHJK").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

/** What `enrollmentCodes:progress` returns: a code waiting for its first PC. */
const progress = (over: Record<string, unknown> = {}) => ({
  label: "Front desk · 28 Nov",
  groupId: "g1",
  groupName: "Front desk",
  usesTotal: 1,
  usesLeft: 1,
  expiresAt: Date.now() + 86_400_000,
  revoked: false,
  joined: 0,
  pcs: [],
  download: null,
  ...over,
});

beforeEach(() => {
  cx.results = { "groups:list": [groupRow("g1", "Front desk"), groupRow("g2", "Office")], "settings:plan": freePlan, "enrollmentCodes:progress": progress() };
  cx.fns = {};
  cx.paged = ready([]);
  cx.pagedArgs = [];
  cx.asked = [];
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

let offHandler: (() => void) | null = null;
afterEach(() => {
  offHandler?.();
  offHandler = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const createBtn = () => screen.getByRole("button", { name: s.create });
const created = (over: Record<string, unknown> = {}) => ({ code: CODE, expiresAt: Date.now() + 86_400_000, tokenId: "tok_new", ...over });

/** Click Create code (with whatever the form holds) and wait for step 2. */
async function createCode(fn = vi.fn(async () => created())) {
  cx.fns["enrollmentCodes:create"] = fn;
  fireEvent.click(createBtn());
  // Step 2 while no PC has joined, step 3 once one has.
  await screen.findByRole("heading", { name: new RegExp(`^(${s.installHeading}|Your PCs? (is|are) (joining|ready))$`) });
  return fn;
}

describe("Add a PC: the list of codes (enrollmentCodes:list), always cards", () => {
  it("loading shows skeleton cards, no cards and no empty sentence", () => {
    cx.paged = ready([], "LoadingFirstPage");
    ui();
    expect(screen.queryByRole("list", { name: s.listCaption })).toBeNull();
    expect(screen.queryByText(s.emptyTitle)).toBeNull();
  });

  it("asks for one page of 10, newest first, with nowMs rounded to the minute", () => {
    ui();
    const args = cx.pagedArgs[0] as { nowMs: number; paginationOpts: unknown; sort: unknown };
    expect(args.nowMs % 60_000).toBe(0);
    expect(Date.now() - args.nowMs).toBeLessThan(60_000);
    expect(args.paginationOpts).toEqual({ numItems: 10, cursor: null });
    expect(args.sort).toEqual({ key: "created", dir: "desc" });
  });

  it("empty: one quiet line", () => {
    ui();
    expect(screen.getByText(s.emptyTitle)).toBeTruthy();
  });

  it("an error shows Try again, which subscribes again", async () => {
    cx.paged = new ConvexError({ code: "forbidden" });
    ui();
    expect(screen.getByText(strings.common.regionFailed)).toBeTruthy();
    expect(screen.getByText(strings.errors.forbidden)).toBeTruthy();
    cx.paged = ready([row(1)]);
    fireEvent.click(screen.getByRole("button", { name: strings.common.tryAgain }));
    expect(await screen.findByRole("list", { name: s.listCaption })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("cards: state badge (colour + text), '2 of 5 used', relative expiry, the group under the name, Revoke only while active", async () => {
    cx.paged = ready([
      row(1, { usesLeft: 3, usesTotal: 5, expiresAt: Date.now() + 2 * 86_400_000 + 60_000 }),
      row(2, { state: "usedUp", usesLeft: 0, usesTotal: 1 }),
      row(3, { state: "expired", expiresAt: Date.now() - 3 * 86_400_000 }),
      row(4, { state: "revoked", label: undefined, groupName: undefined, groupId: undefined, usesLeft: 5 }),
    ]);
    ui();
    const list = await screen.findByRole("list", { name: s.listCaption });
    expect(within(list).getAllByText("2 of 5 used").length).toBe(2);
    expect(within(list).getByText("1 of 1 used")).toBeTruthy();
    expect(within(list).getByText("0 of 5 used")).toBeTruthy();
    for (const [state, tone] of [
      ["Active", "success"],
      ["Used up", "neutral"],
      ["Expired", "warning"],
      ["Revoked", "danger"],
    ] as const) {
      expect(within(list).getByText(state).closest(".rb-pill")!.className).toContain(`rb-pill--${tone}`);
    }
    expect(within(list).getByText("in 2 days")).toBeTruthy();
    expect(within(list).getByText("3 days ago")).toBeTruthy();
    expect(within(list).getAllByText("Front desk").length).toBe(3);
    expect(within(list).getByText(s.unlabeled)).toBeTruthy();
    expect(within(list).getAllByRole("button", { name: /^Revoke/ }).length).toBe(1);
    // "See progress" for a code that works or has PCs behind it; a code that never got a PC and is dead has nothing to show.
    expect(within(list).getAllByRole("button", { name: /^See progress/ }).length).toBe(3);
  });

  it("the sort control (cards have no headers) sorts on the server; Next opens the next page with the server's cursor", async () => {
    cx.paged = ready(Array.from({ length: 10 }, (_, i) => row(i)), "CanLoadMore");
    const view = ui();
    await screen.findByRole("list", { name: s.listCaption });
    expect(screen.getByText(strings.pager.page(1))).toBeTruthy();
    expect(screen.queryByText(/records/)).toBeNull();
    pickOption(strings.table.sortSelect, "Expires: newest first");
    expect(cx.pagedArgs.at(-1)).toMatchObject({ sort: { key: "expires", dir: "desc" }, paginationOpts: { numItems: 10, cursor: null } });
    expect(where()).toBe("/enrollment?sort=expires&dir=desc");
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect((cx.pagedArgs.at(-1) as { paginationOpts: unknown }).paginationOpts).toEqual({ numItems: 10, cursor: "c:10" });
    expect(screen.getByText(strings.pager.page(2))).toBeTruthy();

    cx.paged = ready(Array.from({ length: 4 }, (_, i) => row(100 + i)));
    view.rerender(tree("admin", "/enrollment"));
    expect((screen.getByRole("button", { name: strings.pager.next }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: strings.pager.previous }));
    expect((cx.pagedArgs.at(-1) as { paginationOpts: unknown }).paginationOpts).toEqual({ numItems: 10, cursor: null });
  });

  it("viewer: read-only (no Create, no Revoke), the viewer sentence instead of the wizard", async () => {
    cx.paged = ready([row(1)]);
    ui("viewer");
    expect(screen.queryByRole("button", { name: s.create })).toBeNull();
    expect(screen.queryByRole("button", { name: s.idleAction })).toBeNull();
    expect(screen.getByText(s.viewerIdle)).toBeTruthy();
    await screen.findByRole("list", { name: s.listCaption });
    expect(screen.queryByRole("button", { name: /^Revoke/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^See progress/ })).toBeTruthy();
  });
});

describe("stale clock and expiry labels", () => {
  it("a code expiring on screen turns 'Expired' (and loses Revoke) on its own clock; nowMs moves once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    cx.paged = ready([row(1, { expiresAt: NOW + 20_000 })]);
    ui();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("list", { name: s.listCaption })).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke PC 1" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(30_000)); // 10:00:40, same minute
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke PC 1" })).toBeNull();
    const minutes = () => [...new Set(cx.pagedArgs.map((a) => (a as { nowMs: number }).nowMs))];
    expect(minutes()).toEqual([Date.UTC(2026, 9, 27, 10, 0)]);
    act(() => vi.advanceTimersByTime(30_000)); // 10:01:10
    expect(minutes()).toEqual([Date.UTC(2026, 9, 27, 10, 0), Date.UTC(2026, 9, 27, 10, 1)]);
  });
});

describe("Step 1: create a code (enrollmentCodes.create)", () => {
  it("with the defaults it is one click: the first group by name, one PC, one day, an automatic name; nothing is subscribed to progress yet", async () => {
    ui();
    const create = await createCode();
    expect(create).toHaveBeenCalledWith({ groupId: "g1", uses: 1, ttlMinutes: 1440, label: expect.stringMatching(/^Front desk · \d{1,2} [A-Z][a-z]{2}$/) });
    await waitFor(() => expect(where()).toBe("/enrollment?watch=tok_new"));
  });

  it("step 1 and the closed wizard never subscribe to the progress query; step 2 does", async () => {
    cx.results["enrollmentCodes:progress"] = progress({ joined: 1, usesLeft: 0, pcs: [{ _id: "d1", name: "PC-1", enrolledAt: Date.now(), online: true }] });
    ui();
    expect(cx.asked).not.toContain("enrollmentCodes:progress");
    await createCode();
    expect(cx.asked).toContain("enrollmentCodes:progress");
    cx.asked = [];
    fireEvent.click(screen.getByRole("button", { name: s.done }));
    expect(screen.getByRole("button", { name: s.idleAction })).toBeTruthy();
    expect(where()).toBe("/enrollment");
    cx.asked = [];
    fireEvent.click(screen.getByRole("button", { name: s.idleAction }));
    expect(cx.asked).not.toContain("enrollmentCodes:progress");
  });

  it("the group: the one used last in this browser; ?group= from the group page wins over the first by name; else the first by name", () => {
    localStorage.setItem(LAST_GROUP_KEY, "g2");
    const a = ui();
    expect(selectedText(s.group)).toBe("Office");
    a.unmount();
    localStorage.clear();
    const b = ui("admin", "/enrollment?group=g2");
    expect(selectedText(s.group)).toBe("Office");
    b.unmount();
    ui();
    expect(selectedText(s.group)).toBe("Front desk");
  });

  it("a chosen group, a number of PCs and a lifetime are sent as typed; the group is remembered as an id", async () => {
    ui();
    pickOption(s.group, "Office");
    fireEvent.click(screen.getByRole("button", { name: s.more }));
    fireEvent.click(screen.getByRole("button", { name: s.more }));
    expect((screen.getByLabelText(s.uses) as HTMLInputElement).value).toBe("3");
    fireEvent.click(screen.getByText(s.advanced));
    pickOption(s.expiry, "7 days");
    fireEvent.change(screen.getByLabelText(new RegExp(`^${s.label}`)), { target: { value: "  Reception  " } });
    expect(screen.getByText(s.summary(3, "7 days"))).toBeTruthy();
    const create = await createCode();
    expect(create).toHaveBeenCalledWith({ groupId: "g2", uses: 3, ttlMinutes: 10080, label: "Reception" });
    expect(localStorage.getItem(LAST_GROUP_KEY)).toBe("g2");
  });

  it("the stepper stays between 1 and 100; typing is cleaned and clamped when you leave the field", () => {
    ui();
    const input = screen.getByLabelText(s.uses) as HTMLInputElement;
    expect((screen.getByRole("button", { name: s.fewer }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "4x2" } });
    expect(input.value).toBe("42");
    fireEvent.change(input, { target: { value: "500" } });
    fireEvent.blur(input);
    expect(input.value).toBe("100");
    expect((screen.getByRole("button", { name: s.more }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("1");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(input.value).toBe("1");
  });

  it("the lifetimes are the four presets of the plan: 15 minutes, 1 hour, 1 day, 7 days", async () => {
    ui();
    fireEvent.click(screen.getByText(s.advanced));
    fireEvent.click(screen.getByLabelText(s.expiry));
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["15 minutes", "1 hour", "1 day", "7 days"]);
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "15 minutes" }));
    const create = await createCode();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ ttlMinutes: 15 }));
  });

  it("a name that is too long is refused before sending, under its field, and opens More options", async () => {
    const create = vi.fn();
    cx.fns["enrollmentCodes:create"] = create;
    ui();
    fireEvent.click(screen.getByText(s.advanced));
    fireEvent.change(screen.getByLabelText(new RegExp(`^${s.label}`)), { target: { value: "x".repeat(65) } });
    fireEvent.click(createBtn());
    expect(screen.getByText(s.labelInvalid)).toBeTruthy();
    await act(async () => undefined);
    expect(create).not.toHaveBeenCalled();
  });

  it("the server's invalid_argument is shown under its field and opens More options", async () => {
    cx.fns["enrollmentCodes:create"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "ttlMinutes" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "label" }));
    ui();
    fireEvent.click(createBtn());
    const ttlErr = await screen.findByText(s.ttlRange);
    expect(ttlErr.closest("p")!.id).toBeTruthy();
    expect(screen.getByLabelText(s.expiry).getAttribute("aria-describedby")).toContain(ttlErr.closest("p")!.id);
    expect(screen.getByText(s.expiry).closest("details")!.open).toBe(true);
    fireEvent.click(createBtn());
    expect(await screen.findByText(s.labelInvalid)).toBeTruthy();
    // Under the field only, not twice.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a double click creates one code", async () => {
    let resolve!: (v: unknown) => void;
    const create = vi.fn(() => new Promise((r) => (resolve = r)));
    cx.fns["enrollmentCodes:create"] = create;
    ui();
    fireEvent.click(createBtn());
    fireEvent.click(screen.getByRole("button", { name: s.creating }));
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => resolve(created()));
  });

  it("plan limit: the plan's numbers, 'See your codes' moves to the list; no upgrade button", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "plan_limit", detail: "enrollmentCodes" });
    });
    cx.results["settings:plan"] = { ...freePlan, usage: { ...freePlan.usage, enrollmentCodes: 5 } };
    ui();
    // At the limit the form says so before the click.
    expect(screen.getByText(new RegExp(s.usage(5, 5, "Free")))).toBeTruthy();
    fireEvent.click(createBtn());
    const message = planLimitMessage("enrollmentCodes", "free", 5);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(message).toBe("Your Free plan allows 5 active enrollment codes, and all are in use. Contact us to upgrade.");
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: s.seeCodes }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: s.aside }));
  });

  it("plan limit without the plan loaded: the general plan-limit sentence", async () => {
    delete cx.results["settings:plan"];
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "plan_limit", detail: "enrollmentCodes" });
    });
    ui();
    fireEvent.click(createBtn());
    expect(await screen.findByText("Your plan's limit of active enrollment codes is reached. Contact us to upgrade.")).toBeTruthy();
  });

  it("suspended organization: the suspended sentence, and no 'See your codes'", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "plan_limit", detail: "suspended" });
    });
    ui();
    fireEvent.click(createBtn());
    expect(await screen.findByText(planText.suspended)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.seeCodes })).toBeNull();
  });

  it("the plan's PC limit is full: a warning above Create, and creating is still allowed", async () => {
    cx.results["settings:plan"] = { ...freePlan, usage: { ...freePlan.usage, devices: 2 } };
    ui();
    expect(screen.getByText(s.planFull)).toBeTruthy();
    expect((createBtn() as HTMLButtonElement).disabled).toBe(false);
    await createCode();
  });

  it("a group of another organization (or deleted): not_found → 'This group no longer exists.'", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "not_found" });
    });
    ui();
    fireEvent.click(createBtn());
    expect(await screen.findByText(s.groupGoneError)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: s.installHeading })).toBeNull();
  });

  it("not_ready (deployment URL the agent refuses): its own sentence", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "not_ready", detail: "this deployment's URL cannot be used for enrollment" });
    });
    ui();
    fireEvent.click(createBtn());
    expect(await screen.findByText(s.notReady)).toBeTruthy();
  });

  it("a locked session: the step-up dialog, then one retry", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required", detail: "unlocked" }))
      .mockResolvedValueOnce(created());
    cx.fns["enrollmentCodes:create"] = create;
    const handler = vi.fn(async () => true);
    offHandler = setStepUpHandler(handler);
    ui();
    fireEvent.click(createBtn());
    expect(await screen.findByRole("heading", { name: s.installHeading })).toBeTruthy();
    expect(handler).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("no group yet: 'Your PCs need a group first' with a name to give, then the form; nothing sent for the code before", async () => {
    cx.results["groups:list"] = [];
    const makeGroup = vi.fn(async () => ({ groupId: "g9" }));
    cx.fns["groups:create"] = makeGroup;
    const view = ui();
    expect(screen.getByText(s.firstGroup)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.create })).toBeNull();
    expect((screen.getByLabelText(s.firstGroupName) as HTMLInputElement).value).toBe(s.firstGroupDefault);
    fireEvent.change(screen.getByLabelText(s.firstGroupName), { target: { value: "Tills" } });
    fireEvent.click(screen.getByRole("button", { name: s.firstGroupCreate }));
    await waitFor(() => expect(makeGroup).toHaveBeenCalledWith({ name: "Tills" }));
    cx.results["groups:list"] = [groupRow("g9", "Tills")];
    view.rerender(tree("admin"));
    expect(selectedText(s.group)).toBe("Tills");
    expect(createBtn()).toBeTruthy();
  });
});

describe("Step 2: the code, shown once", () => {
  it("large, in blocks; Copy copies the exact code; never stored, in the URL or the console", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
    ui();
    await createCode();
    const heading = screen.getByRole("heading", { name: s.installHeading });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    const blocks = screen.getByTestId("code-blocks");
    expect(blocks.textContent).toBe(CODE);
    expect(blocks.textContent).not.toMatch(/\s/);
    expect(blocks.querySelector(".addpc-blocks__b")!.textContent).toBe("RBX1.");
    expect(screen.getByText(s.worksFor(1, untilText(Date.now() + 86_400_000, Date.now())))).toBeTruthy();
    for (const line of s.how) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByRole("button", { name: `About ${s.needsLabel.toLowerCase()}` })).toBeTruthy();

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole("button", { name: s.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE));
    expect(await screen.findByRole("button", { name: s.copied })).toBeTruthy();

    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie + where();
    expect(stored).not.toContain(CODE.slice(5, 25));
    for (const spy of logs) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(CODE.slice(5, 25));
  });

  it("the copy fallback (not a secure context) selects the code and says Ctrl+C", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    ui();
    await createCode();
    fireEvent.click(screen.getByRole("button", { name: s.copy }));
    expect(await screen.findByText(s.copyManual)).toBeTruthy();
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(CODE));
  });

  it("Download goes to the organization's own build when it set one", async () => {
    cx.results["enrollmentCodes:progress"] = progress({ download: { version: "0.1.0", url: "https://dl.example.test/Rulebox-0.1.0-x64.msi", sizeBytes: 31_000_000 } });
    ui();
    await createCode();
    const link = screen.getByRole("link", { name: s.download });
    expect(link.getAttribute("href")).toBe("https://dl.example.test/Rulebox-0.1.0-x64.msi");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("Download falls back to the releases page when no build is set or the link is not https; the link can be copied", async () => {
    cx.results["enrollmentCodes:progress"] = progress({ download: { version: "0.1.0", url: "http://insecure.example.test/x.msi", sizeBytes: 1 } });
    ui();
    await createCode();
    expect(screen.getByRole("link", { name: s.download }).getAttribute("href")).toBe(RULEBOX_RELEASES_URL);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole("button", { name: s.copyLink }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RULEBOX_RELEASES_URL));
  });
  it("the QR button opens the QR dialog for the code", async () => {
    ui();
    await createCode();
    fireEvent.click(screen.getByRole("button", { name: s.qr }));
    const dialog = await screen.findByRole("dialog", { name: s.qrTitle });
    expect(await within(dialog).findByRole("img", { name: s.qrLabel })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.close }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("'Install without clicks' (for IT) holds the two commands and the warning about logs and history", async () => {
    cx.results["enrollmentCodes:progress"] = progress({ download: { version: "0.1.0", url: "https://dl.example.test/a.msi", sizeBytes: 1 } });
    ui();
    await createCode();
    fireEvent.click(screen.getByText(s.silentTitle));
    expect(screen.getByText(`msiexec /i Rulebox-0.1.0-x64.msi /qn ENROLLCODE=${CODE}`)).toBeTruthy();
    expect(screen.getByText(`rulebox-agent enroll ${CODE}`)).toBeTruthy();
    expect(screen.getByText(s.silentWarn)).toBeTruthy();
  });

  it("leaving the page, 'Add another PC' and 'Done' all drop the code; a reload shows progress without it", async () => {
    cx.results["enrollmentCodes:progress"] = progress({ joined: 1, usesTotal: 2, usesLeft: 1, pcs: [{ _id: "d1", name: "PC-1", enrolledAt: Date.now(), online: true }] });
    const view = ui();
    await createCode();
    expect(document.body.textContent).toContain(CODE.slice(5, 25));
    fireEvent.click(screen.getByRole("button", { name: s.another }));
    expect(screen.getByRole("button", { name: s.create })).toBeTruthy();
    expect(document.body.textContent).not.toContain(CODE.slice(5, 25));
    expect(where()).toBe("/enrollment");

    await createCode();
    view.unmount();
    expect(document.body.textContent).not.toContain(CODE.slice(5, 25));
    // "Reload" with the address that was in the bar.
    cx.results["enrollmentCodes:progress"] = progress();
    ui("admin", "/enrollment?watch=tok_new");
    expect(screen.getByText(s.hiddenNow)).toBeTruthy();
    expect(document.body.textContent).not.toContain(CODE.slice(5, 25));
    expect(screen.queryByRole("button", { name: s.copy })).toBeNull();
    expect(screen.queryByText(s.silentTitle)).toBeNull();
  });
});

describe("Revoke (enrollmentCodes.revoke, major)", () => {
  it("confirm (type the label), fresh step-up, one retry, toast", async () => {
    cx.paged = ready([row(1)]);
    const revoke = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required", detail: "fresh" }))
      .mockResolvedValueOnce(null);
    cx.fns["enrollmentCodes:revoke"] = revoke;
    const handler = vi.fn(async () => true);
    offHandler = setStepUpHandler(handler);
    ui();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke PC 1" }));
    const dialog = screen.getByRole("dialog", { name: s.revokeTitle });
    const confirm = within(dialog).getByRole("button", { name: strings.common.revoke }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "PC 1" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(handler).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenLastCalledWith({ tokenId: "tok1" });
    expect(screen.getByText(s.revoked)).toBeTruthy();
  });

  it("cancelling the step-up keeps the dialog open with the reason; nothing is revoked", async () => {
    cx.paged = ready([row(1, { label: undefined })]);
    const revoke = vi.fn(async () => {
      throw new ConvexError({ code: "step_up_required", detail: "fresh" });
    });
    cx.fns["enrollmentCodes:revoke"] = revoke;
    offHandler = setStepUpHandler(async () => false);
    ui();
    fireEvent.click(await screen.findByRole("button", { name: `Revoke ${s.unlabeled}` }));
    const dialog = screen.getByRole("dialog", { name: s.revokeTitle });
    // Unlabeled: nothing to type.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.revoke }));
    expect(await within(dialog).findByText(strings.errors.stepUpRequired)).toBeTruthy();
    expect(revoke).toHaveBeenCalledOnce();
    expect(screen.queryByText(s.revoked)).toBeNull();
  });

  it("Cancel closes the dialog without calling the server", async () => {
    cx.paged = ready([row(1)]);
    const revoke = vi.fn();
    cx.fns["enrollmentCodes:revoke"] = revoke;
    ui();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke PC 1" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: strings.common.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("See progress", () => {
  it("a card's 'See progress' shows its progress without the code and puts only the row id in the address", async () => {
    cx.paged = ready([row(1)]);
    ui();
    fireEvent.click(await screen.findByRole("button", { name: s.seeProgressNamed("PC 1") }));
    expect(where()).toBe("/enrollment?watch=tok1");
    expect(await screen.findByText(s.hiddenNow)).toBeTruthy();
    expect(screen.getByText(s.waiting)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: s.installHeading })));
  });
});

describe("enrollment rules (model)", () => {
  it("labels: 64 characters counted as the server does (code points), no control characters", () => {
    expect(labelProblem("😀".repeat(64))).toBeNull();
    expect(labelProblem("😀".repeat(65))).toBe(s.labelInvalid);
    expect(labelProblem("a\tb")).toBe(s.labelInvalid);
    expect(labelProblem("   ")).toBeNull();
  });

  it("the blocks join back to the exact code (the agent accepts no spaces inside it)", () => {
    expect(codeBlocks(CODE).join("")).toBe(CODE);
    expect(codeBlocks(CODE)[0]).toBe("RBX1.");
    expect(codeBlocks(CODE).slice(1).every((b) => b.length <= 4 && !/\s/.test(b))).toBe(true);
  });

  it("displayState: only an active code can turn expired on the client", () => {
    expect(displayState({ state: "active", expiresAt: 10 }, 10)).toBe("expired");
    expect(displayState({ state: "active", expiresAt: 11 }, 10)).toBe("active");
    expect(displayState({ state: "revoked", expiresAt: 1 }, 10)).toBe("revoked");
    expect(displayState({ state: "usedUp", expiresAt: 1 }, 10)).toBe("usedUp");
  });

  it("untilText: today, tomorrow, else the date, with the local time", () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
    const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { timeStyle: "short" });
    expect(untilText(at(28, 18), at(28, 9))).toBe(`today ${time(at(28, 18))}`);
    expect(untilText(at(29, 7, 12), at(28, 23, 59))).toBe(`tomorrow ${time(at(29, 7, 12))}`);
    expect(untilText(new Date(2026, 11, 5, 14, 5).getTime(), at(28, 9))).toMatch(/^5 Dec /);
  });

  it("autoLabel keeps to the server's 64 characters", () => {
    expect(Array.from(autoLabel("G".repeat(100), Date.now())).length).toBeLessThanOrEqual(64);
  });
});
