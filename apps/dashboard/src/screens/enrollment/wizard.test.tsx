import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { Me } from "../../data/types";
import { MeContext } from "../../lib/member";
import { ToastProvider } from "../../app/Toasts";

// The "Add a PC" wizard, step 2 and 3 (UI pass, enrollment plan 3 and 9): what the progress query shows. The live data seam with the
// Convex React hooks mocked; `cx.results["enrollmentCodes:progress"]` is the server's answer, changed between renders to play a PC
// joining. Step 1 and the code itself are in `screens/step6.test.tsx`.
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
  asked: [] as { name: string; args: unknown }[],
  // Like Convex, the same answer is the same object (a new one on every render would loop).
  page: { page: [] as unknown[], isDone: true, continueCursor: "c:0" },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        const name = getFunctionName(r.query);
        cx.asked.push({ name, args: r.args });
        if (name === "enrollmentCodes:list") return [k, cx.page];
        return [k, cx.results[name]];
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

import Enrollment from "../Enrollment";
import { enrollText as s } from "./strings";

const me: Me = {
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

function tree(path: string, role: Me["role"] = "admin") {
  return (
    <ToastProvider>
      <MeContext.Provider value={{ ...me, role }}>
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

const group = (id: string, name: string) => ({ _id: id, name, revision: 0, createdAt: 1, devices: { count: 0, more: false }, employees: { count: 0, more: false } });

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
const pc = (i: number, over: Record<string, unknown> = {}) => ({ _id: `d${i}`, name: `FRONT-DESK-0${i}`, enrolledAt: Date.now() - 120_000, online: false, ...over });

const WATCH = "/enrollment?watch=tok1";
const step = (name: string) => screen.getByRole("list", { name: s.stepsLabel }).querySelector(`li[aria-current="step"]`)?.textContent?.includes(name) ?? false;

beforeEach(() => {
  cx.results = { "groups:list": [group("g1", "Front desk")], "enrollmentCodes:progress": progress() };
  cx.fns = {};
  cx.asked = [];
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const progressAsked = () => cx.asked.filter((a) => a.name === "enrollmentCodes:progress");

describe("step 2: waiting for the PC (a code watched by ?watch, without its code)", () => {
  it("asks for the progress of exactly that row, shows step 2 and 'Waiting for the PC…'", () => {
    render(tree(WATCH));
    expect(progressAsked().at(-1)?.args).toEqual({ tokenId: "tok1" });
    expect(screen.getByRole("heading", { name: s.installHeading })).toBeTruthy();
    expect(step(s.steps.install)).toBe(true);
    expect(screen.getByText(s.waiting)).toBeTruthy();
    expect(screen.getByText(s.waitingSub)).toBeTruthy();
    // The code is never shown again.
    expect(screen.getByText(s.hiddenNow)).toBeTruthy();
    expect(screen.queryByTestId("code-blocks")).toBeNull();
    expect(screen.queryByRole("button", { name: s.copy })).toBeNull();
  });

  it("while it loads: a skeleton, nothing wrong; a failure: Try again inside the panel only", () => {
    delete cx.results["enrollmentCodes:progress"];
    render(tree(WATCH));
    expect(screen.getByRole("heading", { name: s.installHeading })).toBeTruthy();
    expect(screen.getAllByRole("status", { name: /loading/i }).length).toBeGreaterThan(0);
  });

  it("a network error shows Try again in the panel; the list beside it keeps working", () => {
    cx.results["enrollmentCodes:progress"] = new ConvexError({ code: "internal" });
    render(tree(WATCH));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: s.aside })).toBeTruthy();
  });

  it("a code that is not this organization's: 'This code isn't available.' and ?watch is dropped", async () => {
    cx.results["enrollmentCodes:progress"] = new ConvexError({ code: "not_found" });
    render(tree(WATCH));
    await waitFor(() => expect(where()).toBe("/enrollment"));
    expect(screen.getByText(s.gone)).toBeTruthy();
    // An admin is back at step 1.
    expect(screen.getByRole("button", { name: s.create })).toBeTruthy();
  });

  it("expired while waiting: 'This code expired.' and a button to make a new one with the same settings", () => {
    cx.results["enrollmentCodes:progress"] = progress({ expiresAt: Date.now() - 1_000 });
    render(tree(WATCH));
    expect(screen.getByText(s.expired)).toBeTruthy();
    expect(screen.queryByText(s.waiting)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: s.newCode }));
    expect(where()).toBe("/enrollment");
    expect(screen.getByRole("button", { name: s.create })).toBeTruthy();
  });

  it("revoked by someone else: 'This code was revoked.'", () => {
    cx.results["enrollmentCodes:progress"] = progress({ revoked: true });
    render(tree(WATCH));
    expect(screen.getByText(s.revokedNow)).toBeTruthy();
    expect(screen.getByRole("button", { name: s.newCode })).toBeTruthy();
  });

  it("a viewer can watch but not make codes", () => {
    cx.results["enrollmentCodes:progress"] = progress({ revoked: true });
    render(tree(WATCH, "viewer"));
    expect(screen.getByText(s.revokedNow)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.newCode })).toBeNull();
  });
});

describe("step 3: the PC appears by itself", () => {
  it("the first PC that joins turns the page into step 3 (no click), with the stage it is at", () => {
    const view = render(tree(WATCH));
    expect(step(s.steps.install)).toBe(true);
    cx.results["enrollmentCodes:progress"] = progress({ joined: 1, usesLeft: 0, pcs: [pc(1)] });
    view.rerender(tree(WATCH));
    expect(step(s.steps.done)).toBe(true);
    expect(screen.getByRole("heading", { name: s.joinedHeading(1, false) })).toBeTruthy();
    const row = screen.getByText("FRONT-DESK-01").closest("li")!;
    expect(within(row).getByText("2 minutes ago")).toBeTruthy();
    expect(within(row).getByText(new RegExp(s.notOnlineYet))).toBeTruthy();
    // The stage list: Joined is where it is.
    const track = within(row).getByRole("list", { name: s.stagesLabel("FRONT-DESK-01", s.stages.joined) });
    expect(track.querySelector('li[aria-current="step"]')!.textContent).toBe(s.stages.joined);
    expect(within(row).getByRole("link", { name: `${s.openPc}: FRONT-DESK-01` }).getAttribute("href")).toBe("/devices/d1");
  });

  it("online, setting up, ready: the stage moves, the heading says 'ready' only when every PC is", () => {
    const view = render(tree(WATCH));
    const at = (p: Record<string, unknown>, name: string, text: string) => {
      cx.results["enrollmentCodes:progress"] = progress({ joined: 1, usesLeft: 0, pcs: [pc(1, p)] });
      view.rerender(tree(WATCH));
      const row = screen.getByText("FRONT-DESK-01").closest("li")!;
      expect(row.querySelector('li[aria-current="step"]')?.textContent ?? "ready").toContain(text);
      expect(row.getAttribute("data-stage")).toBe(name);
    };
    at({ online: true }, "online", s.stages.online);
    at({ online: true, kioskPhase: "applying" }, "settingUp", s.stages.settingUp);
    expect(screen.getByRole("heading", { name: s.joinedHeading(1, false) })).toBeTruthy();
    at({ online: true, kioskPhase: "applied" }, "ready", "ready");
    expect(screen.getByRole("heading", { name: s.joinedHeading(1, true) })).toBeTruthy();
    // Ready: all four stages ticked.
    expect(screen.getByText("FRONT-DESK-01").closest("li")!.querySelectorAll('.addpc-stage[data-state="done"]').length).toBe(4);
  });

  it("a PC that failed to set up: 'Needs attention', a link to its page", () => {
    cx.results["enrollmentCodes:progress"] = progress({ joined: 1, usesLeft: 0, pcs: [pc(1, { online: true, kioskPhase: "failed" })] });
    render(tree(WATCH));
    const link = screen.getByRole("link", { name: s.stages.needsAttention });
    expect(link.getAttribute("href")).toBe("/devices/d1");
  });

  it("several PCs: 'n of m joined', 'All PCs joined.' when used up, at most ten named and 'and n more'", () => {
    const pcs = Array.from({ length: 10 }, (_, i) => pc(i + 1, { _id: `d${i + 1}`, name: `PC-${i + 1}` }));
    cx.results["enrollmentCodes:progress"] = progress({ usesTotal: 12, usesLeft: 0, joined: 12, pcs });
    render(tree(WATCH));
    expect(screen.getByRole("progressbar", { name: s.joinedOf(12, 12) })).toBeTruthy();
    expect(screen.getByText(s.allJoined)).toBeTruthy();
    expect(screen.getAllByText(/^PC-\d+$/).length).toBe(10);
    const more = screen.getByRole("link", { name: s.morePcs(2) });
    expect(more.getAttribute("href")).toBe("/devices");
  });

  it("a code for five PCs with two joined: the bar, and still a working code (this screen holds it only right after creating it)", async () => {
    cx.results["groups:list"] = [group("g1", "Front desk")];
    cx.results["enrollmentCodes:progress"] = progress({ usesTotal: 5, usesLeft: 5 });
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => ({ code: "RBX1.AAAABBBBCCCC", expiresAt: Date.now() + 3_600_000, tokenId: "tok1" }));
    const view = render(tree("/enrollment"));
    fireEvent.click(screen.getByRole("button", { name: s.create }));
    await screen.findByTestId("code-blocks");
    cx.results["enrollmentCodes:progress"] = progress({ usesTotal: 5, usesLeft: 3, joined: 2, pcs: [pc(2), pc(1)] });
    view.rerender(tree("/enrollment?watch=tok1"));
    expect(screen.getByRole("progressbar", { name: s.joinedOf(2, 5) })).toBeTruthy();
    expect(screen.getByText(s.stillWorks(3))).toBeTruthy();
    expect(screen.getByTestId("code-blocks").textContent).toBe("RBX1.AAAABBBBCCCC");
    expect(screen.queryByText(s.allJoined)).toBeNull();
  });

  it("without the code (reload) step 3 shows no code and no next-PC strip", () => {
    cx.results["enrollmentCodes:progress"] = progress({ usesTotal: 5, usesLeft: 3, joined: 2, pcs: [pc(2), pc(1)] });
    render(tree(WATCH));
    expect(screen.queryByTestId("code-blocks")).toBeNull();
    expect(screen.queryByText(s.stillWorks(3))).toBeNull();
  });

  it("'Add another PC' goes back to step 1; 'Done' closes the wizard to its quiet card, which opens step 1 again", () => {
    cx.results["enrollmentCodes:progress"] = progress({ joined: 1, usesLeft: 0, pcs: [pc(1)] });
    render(tree(WATCH));
    fireEvent.click(screen.getByRole("button", { name: s.done }));
    expect(where()).toBe("/enrollment");
    expect(screen.getByRole("heading", { name: s.idleTitle })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.idleAction }));
    expect(screen.getByRole("button", { name: s.create })).toBeTruthy();
  });

  it("a viewer sees the PCs and Done, not 'Add another PC'", () => {
    cx.results["enrollmentCodes:progress"] = progress({ joined: 1, usesLeft: 0, pcs: [pc(1)] });
    render(tree(WATCH, "viewer"));
    expect(screen.getByText("FRONT-DESK-01")).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.another })).toBeNull();
    expect(screen.getByRole("button", { name: s.done })).toBeTruthy();
  });

  it("a PC rows' joined time keeps its own clock (relative, with the exact time on hover)", () => {
    cx.results["enrollmentCodes:progress"] = progress({ joined: 1, usesLeft: 0, pcs: [pc(1)] });
    render(tree(WATCH));
    const time = screen.getByText("2 minutes ago");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("title")).toBeTruthy();
  });
});

describe("the wizard when it is closed or cannot be used", () => {
  it("a viewer meets one sentence instead of the wizard, and nothing is subscribed to progress", () => {
    render(tree("/enrollment", "viewer"));
    expect(screen.getByText(s.viewerIdle)).toBeTruthy();
    expect(progressAsked().length).toBe(0);
  });

  it("an admin lands straight in step 1; the progress query is not asked", () => {
    render(tree("/enrollment"));
    expect(step(s.steps.create)).toBe(true);
    expect(screen.getByRole("button", { name: s.create })).toBeTruthy();
    expect(progressAsked().length).toBe(0);
  });

  it("the list of codes is one subscription of its own, with no progress in it", () => {
    render(tree("/enrollment"));
    expect(cx.asked.some((a) => a.name === "enrollmentCodes:list")).toBe(true);
  });
});
