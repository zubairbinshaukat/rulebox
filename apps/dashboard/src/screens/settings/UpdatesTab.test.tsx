import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { Me } from "../../data/types";
import { MeContext } from "../../lib/member";
import { setStepUpHandler } from "../../lib/stepUpRetry";
import { strings } from "../../lib/strings";

// Settings → Updates against the LIVE data seam with the Convex React hooks mocked (as `step5.test.tsx`): every query answers from
// `cx.results[<function name>]`, every mutation calls `cx.fns[<function name>]`. Covers the states of the card and the rules of the
// form, not the backend (`convex/ruleboxRelease.test.ts`).
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
  queried: [] as { name: string; args: Record<string, unknown> }[],
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        cx.queried.push({ name: getFunctionName(r.query), args: r.args as Record<string, unknown> });
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

import { ToastProvider } from "../../app/Toasts";
import UpdatesTab from "./UpdatesTab";
import { updates as s } from "./strings";

const owner: Me = {
  email: "owner@x.test",
  role: "owner",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function ui(role: Me["role"] = "owner") {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...owner, role }}>
        <MemoryRouter>
          <UpdatesTab />
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

const SHA = "a".repeat(64);
const RELEASE = { version: "0.1.1", url: "https://dl.example.com/Rulebox-0.1.1-x64.msi", sha256: SHA, sizeBytes: 31_000_000 };
const screenData = (release: typeof RELEASE | null, revision = 4) => ({ revision, release });

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const field = (label: string) => screen.getByLabelText(new RegExp(escape(label))) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: s.setRelease }));

function fillValid(over: Partial<Record<"version" | "url" | "sha256" | "size", string>> = {}) {
  type(s.versionLabel, over.version ?? "0.1.2");
  type(s.urlLabel, over.url ?? "https://dl.example.com/Rulebox-0.1.2-x64.msi");
  type(s.shaLabel, over.sha256 ?? "B".repeat(64));
  type(s.sizeLabel, over.size ?? "31500000");
}

let offHandler: (() => void) | null = null;
beforeEach(() => {
  cx.results = {};
  cx.fns = {};
  cx.queried = [];
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  offHandler?.();
  offHandler = null;
  cleanup();
});

describe("Settings → Updates states (ruleboxRelease:get)", () => {
  it("loading: a skeleton, no card yet; one query, no arguments", () => {
    ui();
    expect(screen.queryByText(s.currentTitle)).toBeNull();
    expect(cx.queried.every((q) => q.name === "ruleboxRelease:get")).toBe(true);
    expect(cx.queried.every((q) => Object.keys(q.args).length === 0)).toBe(true);
  });

  it("error: the region says so and offers Try again", () => {
    cx.results["ruleboxRelease:get"] = new ConvexError({ code: "internal" });
    ui();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.common.tryAgain })).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.setRelease })).toBeNull();
  });

  it("empty: no release set says what that means; the owner gets a blank form and no Stop button", () => {
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(screen.getByText(s.noneTitle)).toBeTruthy();
    expect(screen.getByText(s.noneBody)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.stop })).toBeNull();
    for (const l of [s.versionLabel, s.urlLabel, s.shaLabel, s.sizeLabel]) expect(field(l).value).toBe("");
  });

  it("a release is shown in full and fills the form for the owner", () => {
    cx.results["ruleboxRelease:get"] = screenData(RELEASE);
    ui();
    const card = screen.getByRole("region", { name: s.currentTitle });
    expect(within(card).getByText("0.1.1")).toBeTruthy();
    expect(within(card).getByText(RELEASE.url)).toBeTruthy();
    expect(within(card).getByText(SHA)).toBeTruthy();
    expect(within(card).getByText(/31,000,000 bytes/)).toBeTruthy();
    expect(field(s.versionLabel).value).toBe("0.1.1");
    expect(field(s.sizeLabel).value).toBe("31000000");
    expect(screen.getByRole("button", { name: s.stop })).toBeTruthy();
  });

  it.each(["admin", "viewer"] as const)("a %s sees the release but cannot change it", (role) => {
    cx.results["ruleboxRelease:get"] = screenData(RELEASE);
    ui(role);
    expect(screen.getByText(RELEASE.url)).toBeTruthy();
    expect(screen.getByText(s.ownerOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.setRelease })).toBeNull();
    expect(screen.queryByRole("button", { name: s.stop })).toBeNull();
    expect(screen.queryByLabelText(new RegExp(s.versionLabel))).toBeNull();
  });
});

describe("Settings → Updates form (ruleboxRelease:set)", () => {
  it("each bad value is named under its field, linked to it, and nothing is sent", async () => {
    cx.results["ruleboxRelease:get"] = screenData(null);
    const set = vi.fn();
    cx.fns["ruleboxRelease:set"] = set;
    ui();
    fillValid({ version: "banana", url: "http://dl.example.com/a.msi", sha256: "abc", size: "12 MB" });
    submit();
    await act(async () => undefined);
    expect(screen.getByText(s.problems.versionNotOrdered)).toBeTruthy();
    expect(screen.getByText(s.problems.urlHttps)).toBeTruthy();
    expect(screen.getByText(s.problems.shaFormat)).toBeTruthy();
    expect(screen.getByText(s.problems.sizeNumber)).toBeTruthy();
    const err = screen.getByText(s.problems.shaFormat);
    expect(field(s.shaLabel).getAttribute("aria-describedby")).toContain(err.closest("p")!.id);
    expect(field(s.shaLabel).getAttribute("aria-invalid")).toBe("true");
    expect(set).not.toHaveBeenCalled();

    // Live after the first attempt: fixing a field clears its sentence.
    type(s.shaLabel, SHA);
    expect(screen.queryByText(s.problems.shaFormat)).toBeNull();
  });

  it("empty fields, userinfo in the address, an oversize file and a too-long version are refused too", async () => {
    cx.results["ruleboxRelease:get"] = screenData(null);
    const set = vi.fn();
    cx.fns["ruleboxRelease:set"] = set;
    ui();
    submit();
    await act(async () => undefined);
    for (const text of [s.problems.versionEmpty, s.problems.urlEmpty, s.problems.shaEmpty, s.problems.sizeEmpty]) expect(screen.getByText(text)).toBeTruthy();
    fillValid({ version: "1".repeat(41), url: "https://user:pw@dl.example.com/a.msi", size: String(1024 ** 3 + 1) });
    expect(screen.getByText(s.problems.versionLength)).toBeTruthy();
    expect(screen.getByText(s.problems.urlHttps)).toBeTruthy();
    expect(screen.getByText(s.problems.sizeRange)).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it("a valid release is sent trimmed with the hash in lower case and the loaded revision; the form then shows it saved", async () => {
    cx.results["ruleboxRelease:get"] = screenData(RELEASE, 7);
    const set = vi.fn().mockResolvedValue({ revision: 8 });
    cx.fns["ruleboxRelease:set"] = set;
    ui();
    fillValid({ version: " 0.1.2 ", url: " https://dl.example.com/Rulebox-0.1.2-x64.msi ", sha256: ` ${"B".repeat(64)} `, size: " 31500000 " });
    submit();
    await waitFor(() => expect(set).toHaveBeenCalledOnce());
    expect(set.mock.calls[0]![0]).toEqual({
      expectedRevision: 7,
      release: { version: "0.1.2", url: "https://dl.example.com/Rulebox-0.1.2-x64.msi", sha256: "b".repeat(64), sizeBytes: 31_500_000 },
    });
    expect(await screen.findByText(s.saved)).toBeTruthy();
    expect(field(s.shaLabel).value).toBe("b".repeat(64));
    expect(screen.queryByText(strings.common.unsavedHint)).toBeNull();
  });

  it("the same release again is not sent", async () => {
    cx.results["ruleboxRelease:get"] = screenData(RELEASE);
    const set = vi.fn();
    cx.fns["ruleboxRelease:set"] = set;
    ui();
    type(s.shaLabel, SHA.toUpperCase());
    submit();
    expect(await screen.findByText(s.noChange)).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it("the server's refusal of a field shows under that field (it is the authority)", async () => {
    cx.results["ruleboxRelease:get"] = screenData(null);
    cx.fns["ruleboxRelease:set"] = vi.fn(async () => {
      throw new ConvexError({ code: "invalid_argument", field: "release.url" });
    });
    ui();
    fillValid();
    submit();
    const err = await screen.findByText(s.problems.serverRefused);
    expect(field(s.urlLabel).getAttribute("aria-describedby")).toContain(err.closest("p")!.id);
  });

  it("a stale edit says so and Reload brings the current release back into the form", async () => {
    cx.results["ruleboxRelease:get"] = screenData(RELEASE, 2);
    cx.fns["ruleboxRelease:set"] = vi.fn(async () => {
      throw new ConvexError({ code: "stale_edit" });
    });
    ui();
    type(s.versionLabel, "0.9.0");
    submit();
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.reload }));
    await waitFor(() => expect(field(s.versionLabel).value).toBe("0.1.1"));
    expect(screen.queryByText(strings.common.staleTitle)).toBeNull();
  });

  it("setting the release goes through the step-up dialog, then retries once", async () => {
    cx.results["ruleboxRelease:get"] = screenData(null, 1);
    const set = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required", detail: "fresh" }))
      .mockResolvedValueOnce({ revision: 2 });
    cx.fns["ruleboxRelease:set"] = set;
    const handler = vi.fn(async () => true);
    offHandler = setStepUpHandler(handler);
    ui();
    fillValid();
    submit();
    expect(await screen.findByText(s.saved)).toBeTruthy();
    expect(handler).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[1]![0]).toMatchObject({ expectedRevision: 1 });
  });

  it("cancelling the step-up dialog leaves the form as typed, with the reason", async () => {
    cx.results["ruleboxRelease:get"] = screenData(null);
    cx.fns["ruleboxRelease:set"] = vi.fn(async () => {
      throw new ConvexError({ code: "step_up_required", detail: "fresh" });
    });
    offHandler = setStepUpHandler(async () => false);
    ui();
    fillValid();
    submit();
    expect(await screen.findByText(strings.errors.stepUpRequired)).toBeTruthy();
    expect(field(s.versionLabel).value).toBe("0.1.2");
  });

  it("Stop updating asks first, then clears the release with the loaded revision", async () => {
    cx.results["ruleboxRelease:get"] = screenData(RELEASE, 5);
    const set = vi.fn().mockResolvedValue({ revision: 6 });
    cx.fns["ruleboxRelease:set"] = set;
    ui();
    fireEvent.click(screen.getByRole("button", { name: s.stop }));
    const dialog = screen.getByRole("dialog");
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: s.stop }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ expectedRevision: 5, release: null }));
    expect(await screen.findByText(s.cleared)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
