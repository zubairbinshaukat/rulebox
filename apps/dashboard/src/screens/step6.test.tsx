import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { EnrollmentCodeRow, Me, PlanScreen } from "../data/types";
import { MeContext } from "../lib/member";
import { setStepUpHandler } from "../lib/stepUpRetry";
import { strings } from "../lib/strings";

// Phase 4 Step 6: the Enrollment screen against the LIVE data seam with the
// Convex React hooks mocked. Queries answer from `cx.results[<name>]`, the
// paginated list from `cx.paged` (an Error is thrown, as usePaginatedQuery
// does), mutations / actions call `cx.fns[<name>]`.
type Paged = { results: unknown[]; status: string; loadMore: (n: number) => void } | Error;
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
  paged: null as unknown,
  pagedArgs: [] as unknown[],
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(Object.entries(req).map(([k, r]) => [k, cx.results[getFunctionName(r.query)]])),
  useQuery: () => undefined,
  usePaginatedQuery: (ref: FunctionReference<"query">, args: unknown, opts: { initialNumItems: number }) => {
    if (getFunctionName(ref) !== "enrollmentCodes:list" || opts.initialNumItems !== 50) throw new Error("unexpected paginated query");
    cx.pagedArgs.push(args);
    const r = cx.paged as Paged;
    if (r instanceof Error) throw r;
    return r;
  },
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
import { codeBlocks, displayState, labelProblem, ttlMinutesOf, validateEnrollForm } from "./enrollment/model";
import { enrollText as s } from "./enrollment/strings";
import { planLimitMessage, plan as planText } from "./settings/strings";
import { usePagedState } from "../data/live/convex";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  mfa: { enrolled: true, required: true, verified: true },
  serverApiVersion: 1,
};

function tree(role: Me["role"]) {
  return (
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={["/enrollment"]}>
          <Routes>
            <Route path="/enrollment" element={<Enrollment />} />
            <Route path="/groups/:id" element={<Link to="/enrollment">back to enrollment</Link>} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>
  );
}
const ui = (role: Me["role"] = "admin") => render(tree(role));

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
  usage: { devices: 0, employees: 0, apps: 0, groups: 2, members: 1, enrollmentCodes: 5 },
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

const ready = (results: unknown[], status = "Exhausted", loadMore: (n: number) => void = () => undefined) => ({ results, status, loadMore });

/** A code in the exact format of `formatEnrollmentCode` (RBX1. + base64url, no padding). */
const CODE = `RBX1.${btoa("https://peaceful-peccary-48.convex.cloud#0123456789ABCDEFGHJK").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

beforeEach(() => {
  cx.results = { "groups:list": [groupRow("g1", "Front desk"), groupRow("g2", "Office")], "settings:plan": freePlan };
  cx.fns = {};
  cx.paged = ready([]);
  cx.pagedArgs = [];
});

let offHandler: (() => void) | null = null;
afterEach(() => {
  offHandler?.();
  offHandler = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function openCreate() {
  fireEvent.click(screen.getAllByRole("button", { name: s.create })[0]!);
  return screen.getByRole("dialog");
}

function fillCreate(dialog: HTMLElement, v: { group?: string; uses?: string; label?: string }) {
  if (v.group !== undefined) fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${s.group}`)), { target: { value: v.group } });
  if (v.uses !== undefined) fireEvent.change(within(dialog).getByLabelText(new RegExp(s.uses)), { target: { value: v.uses } });
  if (v.label !== undefined) fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${s.label}`)), { target: { value: v.label } });
}

describe("Enrollment list (enrollmentCodes:list)", () => {
  it("loading shows skeleton rows, no table and no empty state", () => {
    cx.paged = ready([], "LoadingFirstPage");
    ui();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(s.emptyTitle)).toBeNull();
  });

  it("asks for a page of 50 with nowMs rounded to the minute", () => {
    ui();
    const args = cx.pagedArgs[0] as { nowMs: number };
    expect(args.nowMs % 60_000).toBe(0);
    expect(Date.now() - args.nowMs).toBeLessThan(60_000);
  });

  it("empty: 'No codes yet.' with the create action", () => {
    ui();
    expect(screen.getByText(s.emptyTitle)).toBeTruthy();
    expect(screen.getByText(s.emptyBody)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: s.create }).length).toBe(2);
  });

  it("an error shows Try again, which subscribes again", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    cx.paged = new ConvexError({ code: "forbidden" });
    ui();
    expect(screen.getByText(strings.common.regionFailed)).toBeTruthy();
    expect(screen.getByText(strings.errors.forbidden)).toBeTruthy();
    cx.paged = ready([row(1)]);
    fireEvent.click(screen.getByRole("button", { name: strings.common.tryAgain }));
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("rows: state badge (colour + text), '2 of 5 used', relative expiry, group link, creator", () => {
    cx.paged = ready([
      row(1, { usesLeft: 3, usesTotal: 5, expiresAt: Date.now() + 2 * 86_400_000 + 60_000 }),
      row(2, { state: "usedUp", usesLeft: 0, usesTotal: 1 }),
      row(3, { state: "expired", expiresAt: Date.now() - 3 * 86_400_000 }),
      row(4, { state: "revoked", label: undefined, groupName: undefined, usesLeft: 5 }),
    ]);
    ui();
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("2 of 5 used").length).toBe(2);
    expect(within(table).getByText("1 of 1 used")).toBeTruthy();
    expect(within(table).getByText("0 of 5 used")).toBeTruthy();
    for (const [state, tone] of [
      ["Active", "success"],
      ["Used up", "neutral"],
      ["Expired", "warning"],
      ["Revoked", "danger"],
    ] as const) {
      expect(within(table).getByText(state).closest(".rb-pill")!.className).toContain(`rb-pill--${tone}`);
    }
    expect(within(table).getByText("in 2 days")).toBeTruthy();
    expect(within(table).getByText("3 days ago")).toBeTruthy();
    expect(within(table).getAllByRole("link", { name: "Front desk" }).length).toBe(3);
    expect(within(table).getByText(s.groupGone)).toBeTruthy();
    expect(within(table).getByText(s.unlabeled)).toBeTruthy();
    // Only the active code can be revoked.
    expect(within(table).getAllByRole("button", { name: /^Revoke/ }).length).toBe(1);
  });

  it("Load more asks for 50 more until exhausted and renders exactly the pages loaded", () => {
    const loadMore = vi.fn();
    const first = Array.from({ length: 50 }, (_, i) => row(i));
    cx.paged = ready(first, "CanLoadMore", loadMore);
    const view = ui();
    expect(screen.getAllByRole("row").length).toBe(51); // header + 50
    fireEvent.click(screen.getByRole("button", { name: strings.common.loadMore }));
    expect(loadMore).toHaveBeenCalledWith(50);

    cx.paged = ready(first, "LoadingMore");
    view.rerender(tree("admin"));
    expect((screen.getByRole("button", { name: strings.common.loadingMore }) as HTMLButtonElement).disabled).toBe(true);

    cx.paged = ready([...first, ...Array.from({ length: 12 }, (_, i) => row(100 + i))]);
    view.rerender(tree("admin"));
    expect(screen.getAllByRole("row").length).toBe(63);
    expect(screen.queryByRole("button", { name: strings.common.loadMore })).toBeNull();
    expect(screen.getByText(strings.common.endOfList)).toBeTruthy();
  });

  it("viewer: read-only (no Create, no Revoke) and the viewer's empty sentence", () => {
    ui("viewer");
    expect(screen.queryByRole("button", { name: s.create })).toBeNull();
    expect(screen.getByText(s.emptyBodyViewer)).toBeTruthy();
    cx.paged = ready([row(1)]);
    const view = render(tree("viewer"));
    expect(within(view.container).queryByRole("button", { name: /^Revoke/ })).toBeNull();
    expect(within(view.container).queryByRole("columnheader", { name: strings.common.actions })).toBeNull();
  });

  it("no groups: an admin is sent to create one first and Create is disabled", () => {
    cx.results["groups:list"] = [];
    ui();
    expect(screen.getByText(s.noGroups)).toBeTruthy();
    for (const b of screen.getAllByRole("button", { name: s.create })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("stale clock and expiry labels", () => {
  it("a code expiring on screen turns 'Expired' (and loses Revoke) on its own clock; nowMs moves once a minute", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    cx.paged = ready([row(1, { expiresAt: NOW + 20_000 })]);
    ui();
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

  it("after Load more the minute stops moving (a new nowMs would reset the pages)", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    cx.paged = ready(Array.from({ length: 50 }, (_, i) => row(i)), "CanLoadMore", vi.fn());
    ui();
    fireEvent.click(screen.getByRole("button", { name: strings.common.loadMore }));
    act(() => vi.advanceTimersByTime(120_000));
    expect(new Set(cx.pagedArgs.map((a) => (a as { nowMs: number }).nowMs)).size).toBe(1);
  });

  it("usePagedState keeps the rows on screen while a new minute's first page loads", () => {
    const rows = [row(1)];
    const { result, rerender } = renderHook(({ r }) => usePagedState(r as never, 50), {
      initialProps: { r: { results: [], status: "LoadingFirstPage", loadMore: () => undefined } as unknown },
    });
    expect(result.current.status).toBe("loading");
    rerender({ r: { results: rows, status: "Exhausted", loadMore: () => undefined } });
    rerender({ r: { results: [], status: "LoadingFirstPage", loadMore: () => undefined } });
    expect(result.current.status === "ready" && result.current.items).toBe(rows);
  });
});

describe("Create a code (enrollmentCodes.create)", () => {
  it("the code is shown once: large, in blocks, Copy copies the exact code, never stored or logged", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
    const expiresAt = Date.now() + 86_400_000;
    const create = vi.fn(async () => ({ code: CODE, expiresAt }));
    cx.fns["enrollmentCodes:create"] = create;
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { group: "g2", uses: "3", label: "  Reception  " });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(create).toHaveBeenCalledWith({ groupId: "g2", uses: 3, ttlMinutes: 1440, label: "Reception" });

    const panel = screen.getByRole("region", { name: s.codeTitle });
    expect(within(panel).getByText(s.codeOnce)).toBeTruthy();
    const blocks = panel.querySelectorAll(".dash-onetime__code > span");
    expect([...blocks].map((b) => b.textContent).join("")).toBe(CODE);
    expect(blocks[0]!.textContent).toBe("RBX1.");
    expect((within(panel).getByLabelText(s.codeLabel) as HTMLInputElement).value).toBe(CODE);
    expect(within(panel).getByText(new RegExp(s.codeFor(3, "Office")))).toBeTruthy();
    expect(within(panel).getByText(s.codeHowTo)).toBeTruthy();
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: s.codeTitle }));
    expect(screen.getByText(s.created)).toBeTruthy();

    // Copy: the async clipboard in a secure context, with "Copied".
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(within(panel).getByRole("button", { name: strings.common.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE));
    expect(await within(panel).findAllByText(strings.common.copied)).toBeTruthy();

    // Never in storage, the URL or the console.
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie + window.location.href;
    expect(stored).not.toContain(CODE.slice(5, 25));
    for (const spy of logs) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(CODE.slice(5, 25));
  });

  it("the copy fallback (not a secure context) selects the code and says Ctrl+C", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => ({ code: CODE, expiresAt: Date.now() + 3_600_000 }));
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    const panel = await screen.findByRole("region", { name: s.codeTitle });
    fireEvent.click(within(panel).getByRole("button", { name: strings.common.copy }));
    expect(await within(panel).findByText(strings.common.copyFailed)).toBeTruthy();
    const input = within(panel).getByLabelText(s.codeLabel) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("closing the panel drops the code; leaving the page and coming back does not show it", async () => {
    cx.paged = ready([row(1)]);
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => ({ code: CODE, expiresAt: Date.now() + 3_600_000 }));
    ui();
    let dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    await screen.findByRole("region", { name: s.codeTitle });
    fireEvent.click(screen.getByRole("button", { name: s.codeDone }));
    expect(screen.queryByRole("region", { name: s.codeTitle })).toBeNull();
    expect(document.body.innerHTML).not.toContain(CODE.slice(5));

    // Create again, then leave the route (the screen unmounts) and come back.
    dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    await screen.findByRole("region", { name: s.codeTitle });
    fireEvent.click(screen.getByRole("link", { name: "Front desk" }));
    expect(document.body.innerHTML).not.toContain(CODE.slice(5));
    fireEvent.click(screen.getByRole("link", { name: "back to enrollment" }));
    expect(screen.getByRole("heading", { level: 1, name: s.title })).toBeTruthy();
    expect(screen.queryByRole("region", { name: s.codeTitle })).toBeNull();
    expect(document.body.innerHTML).not.toContain(CODE.slice(5));
  });

  it("group is required (several groups, no preselection); uses, custom expiry and label are checked before sending", async () => {
    const create = vi.fn();
    cx.fns["enrollmentCodes:create"] = create;
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { uses: "0", label: "x".repeat(65) });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${s.expiry}`)), { target: { value: "custom" } });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${s.customAmount}`)), { target: { value: "10" } });
    fireEvent.change(within(dialog).getByLabelText(s.customUnit), { target: { value: "minutes" } });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    expect(within(dialog).getByText(strings.validate.pickGroup)).toBeTruthy();
    expect(within(dialog).getByText(strings.validate.integerRange(1, 100))).toBeTruthy();
    expect(within(dialog).getAllByText(s.ttlRange).length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getByText(s.labelInvalid)).toBeTruthy();
    await act(async () => undefined);
    expect(create).not.toHaveBeenCalled();
  });

  it("a custom expiry is sent in minutes", async () => {
    const create = vi.fn(async () => ({ code: CODE, expiresAt: Date.now() + 2 * 86_400_000 }));
    cx.fns["enrollmentCodes:create"] = create;
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${s.expiry}`)), { target: { value: "custom" } });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${s.customAmount}`)), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText(s.customUnit), { target: { value: "days" } });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ groupId: "g1", uses: 1, ttlMinutes: 2880, label: undefined }));
  });

  it("the server's invalid_argument is shown under its field (aria-describedby)", async () => {
    cx.fns["enrollmentCodes:create"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "uses" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "ttlMinutes" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "label" }));
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    const submit = () => fireEvent.click(within(dialog).getByRole("button", { name: s.create }));

    submit();
    const usesErr = await within(dialog).findByText(strings.validate.integerRange(1, 100));
    const uses = within(dialog).getByLabelText(new RegExp(s.uses));
    expect(uses.getAttribute("aria-describedby")).toContain(usesErr.closest("p")!.id);

    submit();
    const ttlErr = await within(dialog).findByText(s.ttlRange);
    expect(within(dialog).getByLabelText(new RegExp(`^${s.expiry}`)).getAttribute("aria-describedby")).toContain(ttlErr.closest("p")!.id);

    submit();
    const labelErr = await within(dialog).findByText(s.labelInvalid);
    expect(within(dialog).getByLabelText(new RegExp(`^${s.label}`)).getAttribute("aria-describedby")).toContain(labelErr.closest("p")!.id);
    // Shown under the field only, not twice.
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("plan limit: 'Contact us to upgrade.' with the plan's numbers, no upgrade button", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "plan_limit", detail: "enrollmentCodes" });
    });
    ui();
    const dialog = await openCreate();
    expect(within(dialog).getByText(s.usage(5, 5, "Free"))).toBeTruthy();
    fillCreate(dialog, { group: "g1" });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    const message = planLimitMessage("enrollmentCodes", "free", 5);
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(message).toBe("Your Free plan allows 5 active enrollment codes, and all are in use. Contact us to upgrade.");
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
  });

  it("plan limit without the plan loaded: the general plan-limit sentence", async () => {
    delete cx.results["settings:plan"];
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "plan_limit", detail: "enrollmentCodes" });
    });
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    expect(await within(dialog).findByText("Your plan's limit of active enrollment codes is reached. Contact us to upgrade.")).toBeTruthy();
  });

  it("suspended organization: the suspended sentence", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "plan_limit", detail: "suspended" });
    });
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    expect(await within(dialog).findByText(planText.suspended)).toBeTruthy();
  });

  it("a group of another organization (or deleted): not_found → 'This group no longer exists.'", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "not_found" });
    });
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    expect(await within(dialog).findByText(s.groupGoneError)).toBeTruthy();
    expect(screen.queryByRole("region", { name: s.codeTitle })).toBeNull();
  });

  it("not_ready (deployment URL the agent refuses): its own sentence", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "not_ready", detail: "this deployment's URL cannot be used for enrollment" });
    });
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    expect(await within(dialog).findByText(s.notReady)).toBeTruthy();
  });

  it("a locked session: the step-up dialog, then one retry", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required", detail: "unlocked" }))
      .mockResolvedValueOnce({ code: CODE, expiresAt: Date.now() + 900_000 });
    cx.fns["enrollmentCodes:create"] = create;
    const handler = vi.fn(async () => true);
    offHandler = setStepUpHandler(handler);
    ui();
    const dialog = await openCreate();
    fillCreate(dialog, { group: "g1" });
    fireEvent.click(within(dialog).getByRole("button", { name: s.create }));
    expect(await screen.findByRole("region", { name: s.codeTitle })).toBeTruthy();
    expect(handler).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
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
    fireEvent.click(screen.getByRole("button", { name: "Revoke PC 1" }));
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
    fireEvent.click(screen.getByRole("button", { name: `Revoke ${s.unlabeled}` }));
    const dialog = screen.getByRole("dialog", { name: s.revokeTitle });
    // Unlabeled: nothing to type.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.revoke }));
    expect(await within(dialog).findByText(strings.errors.stepUpRequired)).toBeTruthy();
    expect(revoke).toHaveBeenCalledOnce();
    expect(screen.queryByText(s.revoked)).toBeNull();
  });

  it("Cancel closes the dialog without calling the server", () => {
    cx.paged = ready([row(1)]);
    const revoke = vi.fn();
    cx.fns["enrollmentCodes:revoke"] = revoke;
    ui();
    fireEvent.click(screen.getByRole("button", { name: "Revoke PC 1" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: strings.common.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("enrollment rules (model)", () => {
  it("lifetimes: presets, custom units, bounds 15 min – 7 days", () => {
    const base = { groupId: "g", uses: "1", customAmount: "", customUnit: "hours" as const, label: "" };
    expect(ttlMinutesOf({ ...base, ttl: "60" })).toBe(60);
    expect(ttlMinutesOf({ ...base, ttl: "custom", customAmount: "3", customUnit: "hours" })).toBe(180);
    expect(ttlMinutesOf({ ...base, ttl: "custom", customAmount: "1.5" })).toBeNull();
    expect(validateEnrollForm({ ...base, ttl: "custom", customAmount: "15", customUnit: "minutes" }).ttl).toBeUndefined();
    expect(validateEnrollForm({ ...base, ttl: "custom", customAmount: "14", customUnit: "minutes" }).ttl).toBe(s.ttlRange);
    expect(validateEnrollForm({ ...base, ttl: "custom", customAmount: "7", customUnit: "days" }).ttl).toBeUndefined();
    expect(validateEnrollForm({ ...base, ttl: "custom", customAmount: "169", customUnit: "hours" }).ttl).toBe(s.ttlRange);
    expect(validateEnrollForm({ ...base, ttl: "60", uses: "100" }).uses).toBeUndefined();
    expect(validateEnrollForm({ ...base, ttl: "60", uses: "101" }).uses).toBeDefined();
    expect(validateEnrollForm({ ...base, ttl: "60", uses: "2.5" }).uses).toBeDefined();
  });

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
});
