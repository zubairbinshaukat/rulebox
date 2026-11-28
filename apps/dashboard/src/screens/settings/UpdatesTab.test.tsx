import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { Me } from "../../data/types";
import type { GithubRelease, GithubReleasesResult } from "../../data/release/api";
import { CLIENT_CACHE_MS, REFRESH_LOCK_MS, resetGithubReleasesClient } from "../../data/release/githubRunner";
import { MeContext } from "../../lib/member";
import { setStepUpHandler } from "../../lib/stepUpRetry";
import { strings } from "../../lib/strings";

// Settings → Rulebox updates against the LIVE data seam with the Convex React hooks mocked (as `step5.test.tsx`): every query answers from
// `cx.results[<function name>]`, every mutation and action calls `cx.fns[<function name>]`. Covers the states of the screen and the rules
// of the fields, not the backend (`convex/ruleboxRelease.test.ts`).
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

const REPO = "https://github.com/zubairbinshaukat/rulebox";
const SHA = "a".repeat(64);
const RELEASE = { version: "0.1.1", url: `${REPO}/releases/download/v0.1.1/Rulebox-0.1.1-x64.msi`, sha256: SHA, sizeBytes: 31_000_000 };
const screenData = (release: typeof RELEASE | null, revision = 4) => ({ revision, release });

function gh(version: string, over: Partial<GithubRelease> = {}, digit = "3"): GithubRelease {
  const tag = over.tag ?? `v${version}`;
  const name = `Rulebox-${version}-x64.msi`;
  return {
    tag,
    title: `Rulebox ${tag.slice(1)}`,
    version,
    prerelease: false,
    publishedAt: Date.UTC(2026, 10, 25),
    pageUrl: `${REPO}/releases/tag/${tag}`,
    notes: "",
    notesTruncated: false,
    signed: true,
    msi: { name, url: `${REPO}/releases/download/${tag}/${name}`, sizeBytes: 38_400_000, sha256: digit.repeat(64) },
    problem: null,
    ...over,
  };
}
const LIST = [
  gh("0.3.0", { notes: "## What's new\n\nFaster sign-in.\n\n- One\n- Two\n- Three" }),
  gh("0.3.0", { tag: "v0.3.0-rc1", prerelease: true, title: "Rulebox 0.3.0-rc1" }, "4"),
  gh("0.2.1", {}, "5"),
  gh("0.2.0", { msi: null, problem: "no_checksums" }),
];
const ok = (releases: GithubRelease[] = LIST, over: Partial<Extract<GithubReleasesResult, { status: "ok" }>> = {}): GithubReleasesResult => ({
  status: "ok",
  repoUrl: REPO,
  checkedAt: Date.now(),
  stale: false,
  releases,
  ...over,
});
const serve = (result: GithubReleasesResult | (() => Promise<GithubReleasesResult>)) => {
  const fn = vi.fn<(args?: unknown) => Promise<GithubReleasesResult>>(async () => (typeof result === "function" ? await result() : result));
  cx.fns["ruleboxRelease:githubReleases"] = fn;
  return fn;
};

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const main = (version: string) => screen.getByRole("button", { name: s.mainAction(version) });
const confirmDialog = async (version: string) => {
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(s.confirmTitle(version))).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: s.confirmButton }));
};

let offHandler: (() => void) | null = null;
beforeEach(() => {
  cx.results = {};
  cx.fns = {};
  cx.queried = [];
  resetGithubReleasesClient();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  offHandler?.();
  offHandler = null;
  cleanup();
  vi.useRealTimers();
});

describe("Settings → Rulebox updates: the current target (ruleboxRelease:get)", () => {
  it("loading: a skeleton, no card yet; the target query has no arguments", () => {
    serve(ok());
    ui();
    expect(screen.queryByText(s.currentTitle)).toBeNull();
    expect(cx.queried.every((q) => q.name === "ruleboxRelease:get")).toBe(true);
    expect(cx.queried.every((q) => Object.keys(q.args).length === 0)).toBe(true);
  });

  it("error: the region says so and offers Try again", () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = new ConvexError({ code: "internal" });
    ui();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.common.tryAgain })).toBeTruthy();
  });

  it("none set: says what that means and has no Stop button", () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(screen.getByText(s.noneTitle)).toBeTruthy();
    expect(screen.getByText(s.noneBody)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.stop })).toBeNull();
  });

  it("a release shows its name, size and file name up front; the address, hash and exact bytes are under Technical details", () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(RELEASE);
    ui();
    const card = screen.getByRole("region", { name: s.currentTitle });
    expect(within(card).getByText(s.rulebox("0.1.1"))).toBeTruthy();
    expect(within(card).getByText("Rulebox-0.1.1-x64.msi")).toBeTruthy();
    expect(within(card).getByText(/30 MB/)).toBeTruthy();
    const tech = within(card).getByText(s.technical).closest("details")!;
    expect(tech.hasAttribute("open")).toBe(false);
    expect(within(tech).getByText(RELEASE.url)).toBeTruthy();
    expect(within(tech).getByText(SHA)).toBeTruthy();
    expect(within(tech).getByText("31,000,000 bytes")).toBeTruthy();
    expect(within(card).getByRole("button", { name: s.stop })).toBeTruthy();
  });

  it.each(["admin", "viewer"] as const)("a %s sees the target only: no list, no fields, and the GitHub action is never called", (role) => {
    const call = serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(RELEASE);
    ui(role);
    expect(screen.getByText(s.rulebox("0.1.1"))).toBeTruthy();
    expect(screen.getByText(s.ownerOnly)).toBeTruthy();
    expect(screen.queryByText(s.releasesTitle)).toBeNull();
    expect(screen.queryByText(s.advanced)).toBeNull();
    expect(screen.queryByRole("button", { name: s.stop })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("Stop updating asks first, then clears the release with the loaded revision", async () => {
    serve(ok([]));
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

  it("a replaced installer (same address, other hash) is flagged on the current card and on its row", async () => {
    serve(ok([gh("0.1.1", { tag: "v0.1.1" }, "9")]));
    cx.results["ruleboxRelease:get"] = screenData(RELEASE);
    ui();
    const card = screen.getByRole("region", { name: s.currentTitle });
    await waitFor(() => expect(within(card).getByText(s.changedCurrent)).toBeTruthy());
    expect(screen.getAllByText(s.warnings.changed).length).toBeGreaterThan(0);
  });
});

describe("Settings → Rulebox updates: the releases from GitHub (ruleboxRelease:githubReleases)", () => {
  it("an owner's open calls the action once; the list shows each release with its badges, date and a GitHub link in a new tab", async () => {
    const call = serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(RELEASE);
    ui();
    const group = await screen.findByRole("radiogroup", { name: s.listLabel });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith({});
    expect(within(group).getAllByRole("radio")).toHaveLength(4);
    expect(within(group).getByText(s.newest)).toBeTruthy();
    expect(within(group).getByText(s.testBuild)).toBeTruthy();
    const links = within(group).getAllByRole("link", { name: new RegExp(s.viewOnGithub) });
    expect(links[0]!.getAttribute("href")).toBe(`${REPO}/releases/tag/v0.3.0`);
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("loading: skeleton rows while the call runs", async () => {
    let done: (r: GithubReleasesResult) => void = () => undefined;
    serve(() => new Promise<GithubReleasesResult>((resolve) => (done = resolve)));
    cx.results["ruleboxRelease:get"] = screenData(RELEASE);
    ui();
    expect(screen.getByText(s.releasesTitle)).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("region", { name: s.currentTitle })).toBeTruthy();
    await act(async () => done(ok()));
    expect(await screen.findByRole("radiogroup")).toBeTruthy();
  });

  it("empty: says so, points to Advanced and opens it", async () => {
    serve(ok([]));
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(await screen.findByText(s.emptyTitle)).toBeTruthy();
    expect(screen.getByText(s.emptyBody)).toBeTruthy();
    expect(screen.getByText(s.advanced).closest("details")!.hasAttribute("open")).toBe(true);
  });

  it("unavailable: a plain warning with Try again, Advanced open and usable", async () => {
    serve({ status: "unavailable", reason: "unreachable" });
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(await screen.findByText(s.loadError)).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.common.tryAgain })).toBeTruthy();
    expect(screen.getByText(s.advanced).closest("details")!.hasAttribute("open")).toBe(true);
    expect(field(s.versionLabel)).toBeTruthy();
  });

  it("a call that fails is the same warning (the screen never shows a raw error)", async () => {
    cx.fns["ruleboxRelease:githubReleases"] = async () => {
      throw new Error("network");
    };
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(await screen.findByText(s.loadError)).toBeTruthy();
  });

  it("rate limited: names the time to try again and explains the cause in an (i)", async () => {
    const retryAt = Date.now() + 14 * 60_000;
    serve({ status: "unavailable", reason: "rate_limited", retryAt });
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    const text = await screen.findByText(/GitHub is busy\. Try again after/);
    expect(text.textContent).toContain("Try again after");
    expect(screen.getByRole("button", { name: s.busyInfoLabel })).toBeTruthy();
    expect(screen.queryByText(s.busyInfo)).toBeNull();
  });

  it("stale: the list stays, with a quiet line saying how old it is", async () => {
    serve(ok(LIST, { stale: true, checkedAt: Date.now() - 12 * 60_000 }));
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(await screen.findByText(new RegExp(`^${s.stale}`))).toBeTruthy();
    expect(screen.getByRole("radiogroup")).toBeTruthy();
  });

  it("an unusable release shows why and cannot be picked", async () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(await screen.findByText(s.unusable.no_checksums)).toBeTruthy();
    const radio = screen.getByRole("radio", { name: "Rulebox 0.2.0" }) as HTMLInputElement;
    expect(radio.disabled).toBe(true);
  });

  it("when nothing can be used it says so and points to Advanced", async () => {
    serve(ok([gh("0.2.0", { msi: null, problem: "no_msi" })]));
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(await screen.findByText(s.allUnusable)).toBeTruthy();
  });

  it("the unsigned and test-build badges carry an (i) and the inline warning stays on the page", async () => {
    serve(ok([gh("0.3.0", { signed: false, prerelease: true, tag: "v0.3.0-rc1", title: "Rulebox 0.3.0-rc1" })]));
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(await screen.findByRole("button", { name: `About ${s.unsigned}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `About ${s.testBuild}` })).toBeTruthy();
    expect(screen.queryByText(s.unsignedInfo)).toBeNull();
  });
});

describe("Settings → Rulebox updates: Refresh and the client cache", () => {
  it("Refresh waits 30 s after the first call, then calls with refresh: true and keeps the list on screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const call = serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    expect(await screen.findByRole("radiogroup")).toBeTruthy();
    const button = screen.getByRole("button", { name: s.refresh }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_LOCK_MS + 100);
    });
    expect((screen.getByRole("button", { name: s.refresh }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: s.refresh }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenLastCalledWith({ refresh: true });
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect((screen.getByRole("button", { name: s.refresh }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaving and coming back within 5 minutes does not call again; after 5 minutes it does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const call = serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(null);
    const first = ui();
    await screen.findByRole("radiogroup");
    first.unmount();
    ui();
    expect(await screen.findByRole("radiogroup")).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    cleanup();
    await act(async () => {
      vi.advanceTimersByTime(CLIENT_CACHE_MS + 1000);
    });
    ui();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  });
});

describe("Settings → Rulebox updates: picking and saving", () => {
  it("the newest stable release is preselected when it is newer than the target; the main action names its version", async () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(RELEASE);
    ui();
    const radio = (await screen.findByRole("radio", { name: "Rulebox 0.3.0" })) as HTMLInputElement;
    expect(radio.checked).toBe(true);
    expect(main("0.3.0")).toBeTruthy();
    // The Advanced fields show what was picked: nothing to type.
    expect(field(s.versionLabel).value).toBe("0.3.0");
    expect(field(s.urlLabel).value).toBe(`${REPO}/releases/download/v0.3.0/Rulebox-0.3.0-x64.msi`);
    expect(field(s.shaLabel).value).toBe("3".repeat(64));
    expect(field(s.sizeLabel).value).toBe("38400000");
  });

  it("when the target is already the newest release, nothing is preselected and the screen says so", async () => {
    const list = [gh("0.3.0"), gh("0.2.1", {}, "5")];
    serve(ok(list));
    const m = list[0]!.msi!;
    cx.results["ruleboxRelease:get"] = screenData({ version: "0.3.0", url: m.url, sha256: m.sha256, sizeBytes: m.sizeBytes });
    ui();
    expect(await screen.findByText(s.onNewest)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Update PCs to/ })).toBeNull();
    expect(screen.getAllByText(s.current)).toHaveLength(2);
  });

  it("picking another release moves the selection and its warnings: a test build, and an older version", async () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData({ ...RELEASE, version: "0.2.5" });
    ui();
    await screen.findByRole("radiogroup");
    fireEvent.click(screen.getByRole("radio", { name: "Rulebox 0.3.0-rc1" }));
    expect((screen.getByRole("radio", { name: "Rulebox 0.3.0" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(s.warnings.prerelease)).toBeTruthy();
    expect(field(s.shaLabel).value).toBe("4".repeat(64));
    fireEvent.click(screen.getByRole("radio", { name: "Rulebox 0.2.1" }));
    expect(screen.getByText(s.warnings.older)).toBeTruthy();
    expect(screen.queryByText(s.warnings.prerelease)).toBeNull();
  });

  it("editing an Advanced field turns the pick into your own build: the radio clears and the button follows the typed version", async () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    await screen.findByRole("radiogroup");
    expect((screen.getByRole("radio", { name: "Rulebox 0.3.0" }) as HTMLInputElement).checked).toBe(true);
    type(s.versionLabel, "0.3.1");
    expect(screen.queryAllByRole("radio").some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect(screen.getByText(s.ownBuild)).toBeTruthy();
    expect(main("0.3.1")).toBeTruthy();
    // The other fields keep what the pick filled in.
    expect(field(s.shaLabel).value).toBe("3".repeat(64));
  });

  it("the main action asks first; confirming sends the release with the loaded revision, then the selection is cleared", async () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(RELEASE, 7);
    const set = vi.fn().mockResolvedValue({ revision: 8 });
    cx.fns["ruleboxRelease:set"] = set;
    ui();
    await screen.findByRole("radiogroup");
    fireEvent.click(main("0.3.0"));
    expect(set).not.toHaveBeenCalled();
    await confirmDialog("0.3.0");
    await waitFor(() => expect(set).toHaveBeenCalledOnce());
    expect(set.mock.calls[0]![0]).toEqual({
      expectedRevision: 7,
      release: { version: "0.3.0", url: `${REPO}/releases/download/v0.3.0/Rulebox-0.3.0-x64.msi`, sha256: "3".repeat(64), sizeBytes: 38_400_000 },
    });
    expect(await screen.findByText(s.saved("0.3.0"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Update PCs to/ })).toBeNull();
    expect((screen.getByRole("radio", { name: "Rulebox 0.3.0" }) as HTMLInputElement).checked).toBe(false);
  });

  it("cancelling the confirmation sends nothing", async () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(null);
    const set = vi.fn();
    cx.fns["ruleboxRelease:set"] = set;
    ui();
    await screen.findByRole("radiogroup");
    fireEvent.click(main("0.3.0"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: strings.common.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(set).not.toHaveBeenCalled();
  });

  it("going through the step-up dialog, then retrying once", async () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(null, 1);
    const set = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required", detail: "fresh" }))
      .mockResolvedValueOnce({ revision: 2 });
    cx.fns["ruleboxRelease:set"] = set;
    const handler = vi.fn(async () => true);
    offHandler = setStepUpHandler(handler);
    ui();
    await screen.findByRole("radiogroup");
    fireEvent.click(main("0.3.0"));
    await confirmDialog("0.3.0");
    expect(await screen.findByText(s.saved("0.3.0"))).toBeTruthy();
    expect(handler).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("cancelling the step-up dialog leaves the pick in place, with the reason under the button", async () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(null);
    cx.fns["ruleboxRelease:set"] = vi.fn(async () => {
      throw new ConvexError({ code: "step_up_required", detail: "fresh" });
    });
    offHandler = setStepUpHandler(async () => false);
    ui();
    await screen.findByRole("radiogroup");
    fireEvent.click(main("0.3.0"));
    await confirmDialog("0.3.0");
    expect(await screen.findByText(strings.errors.stepUpRequired)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByRole("radio", { name: "Rulebox 0.3.0" }) as HTMLInputElement).checked).toBe(true);
    expect(main("0.3.0")).toBeTruthy();
  });

  it("a stale edit says so and Reload brings the current target back", async () => {
    serve(ok());
    cx.results["ruleboxRelease:get"] = screenData(RELEASE, 2);
    cx.fns["ruleboxRelease:set"] = vi.fn(async () => {
      throw new ConvexError({ code: "stale_edit" });
    });
    ui();
    await screen.findByRole("radiogroup");
    fireEvent.click(main("0.3.0"));
    await confirmDialog("0.3.0");
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.reload }));
    await waitFor(() => expect(screen.queryByText(strings.common.staleTitle)).toBeNull());
  });
});

describe("Settings → Rulebox updates: Advanced, use your own build", () => {
  async function ownBuild(release: typeof RELEASE | null = null) {
    serve(ok([]));
    cx.results["ruleboxRelease:get"] = screenData(release);
    ui();
    await screen.findByText(s.emptyTitle);
  }
  const fillValid = (over: Partial<Record<"version" | "url" | "sha256" | "size", string>> = {}) => {
    type(s.versionLabel, over.version ?? "0.1.2");
    type(s.urlLabel, over.url ?? "https://dl.example.com/Rulebox-0.1.2-x64.msi");
    type(s.shaLabel, over.sha256 ?? "B".repeat(64));
    type(s.sizeLabel, over.size ?? "31500000");
  };

  it("each bad value is named under its field, linked to it, and nothing is sent", async () => {
    await ownBuild();
    const set = vi.fn();
    cx.fns["ruleboxRelease:set"] = set;
    fillValid({ version: "banana", url: "http://dl.example.com/a.msi", sha256: "abc", size: "12 MB" });
    fireEvent.click(main("banana"));
    await act(async () => undefined);
    expect(screen.getByText(s.problems.versionNotOrdered)).toBeTruthy();
    expect(screen.getByText(s.problems.urlHttps)).toBeTruthy();
    expect(screen.getByText(s.problems.shaFormat)).toBeTruthy();
    expect(screen.getByText(s.problems.sizeNumber)).toBeTruthy();
    const err = screen.getByText(s.problems.shaFormat);
    expect(field(s.shaLabel).getAttribute("aria-describedby")).toContain(err.closest("p")!.id);
    expect(field(s.shaLabel).getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(set).not.toHaveBeenCalled();
    // Live after the first attempt: fixing a field clears its sentence.
    type(s.shaLabel, SHA);
    expect(screen.queryByText(s.problems.shaFormat)).toBeNull();
  });

  it("an oversize file, userinfo in the address and a too-long version are refused too", async () => {
    await ownBuild();
    const set = vi.fn();
    cx.fns["ruleboxRelease:set"] = set;
    fillValid({ version: "1".repeat(41), url: "https://user:pw@dl.example.com/a.msi", size: String(1024 ** 3 + 1) });
    fireEvent.click(main("1".repeat(41)));
    await act(async () => undefined);
    expect(screen.getByText(s.problems.versionLength)).toBeTruthy();
    expect(screen.getByText(s.problems.urlHttps)).toBeTruthy();
    expect(screen.getByText(s.problems.sizeRange)).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it("a valid build is sent trimmed with the hash in lower case; the fields then show it saved", async () => {
    await ownBuild(RELEASE);
    cx.results["ruleboxRelease:get"] = screenData(RELEASE, 7);
    const set = vi.fn().mockResolvedValue({ revision: 8 });
    cx.fns["ruleboxRelease:set"] = set;
    fillValid({ version: " 0.1.2 ", url: " https://dl.example.com/Rulebox-0.1.2-x64.msi ", sha256: ` ${"B".repeat(64)} `, size: " 31500000 " });
    fireEvent.click(main("0.1.2"));
    await confirmDialog("0.1.2");
    await waitFor(() => expect(set).toHaveBeenCalledOnce());
    expect(set.mock.calls[0]![0]).toMatchObject({
      release: { version: "0.1.2", url: "https://dl.example.com/Rulebox-0.1.2-x64.msi", sha256: "b".repeat(64), sizeBytes: 31_500_000 },
    });
    expect(await screen.findByText(s.saved("0.1.2"))).toBeTruthy();
  });

  it("the same release again is not sent", async () => {
    await ownBuild(RELEASE);
    const set = vi.fn();
    cx.fns["ruleboxRelease:set"] = set;
    type(s.shaLabel, SHA.toUpperCase());
    fireEvent.click(main("0.1.1"));
    await confirmDialog("0.1.1");
    expect(await screen.findByText(s.noChange)).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it("the server's refusal of a field shows under that field, in the open disclosure (it is the authority)", async () => {
    await ownBuild();
    cx.fns["ruleboxRelease:set"] = vi.fn(async () => {
      throw new ConvexError({ code: "invalid_argument", field: "release.url" });
    });
    fillValid();
    fireEvent.click(main("0.1.2"));
    await confirmDialog("0.1.2");
    const err = await screen.findByText(s.problems.serverRefused);
    expect(field(s.urlLabel).getAttribute("aria-describedby")).toContain(err.closest("p")!.id);
    expect(screen.getByText(s.advanced).closest("details")!.hasAttribute("open")).toBe(true);
  });

  it("every field has its (i) and the long hints are not on the page", async () => {
    await ownBuild();
    for (const label of [s.versionLabel, s.urlLabel, s.shaLabel, s.sizeLabel]) {
      expect(screen.getByRole("button", { name: `About ${label}` })).toBeTruthy();
    }
    expect(screen.queryByText(s.shaInfo)).toBeNull();
  });
});

describe("Settings → Rulebox updates: release notes are text", () => {
  it("headings, bullets and paragraphs render as text; markup and links in the notes are never live", async () => {
    const notes = "# Big news\n<script>window.__pwned = 1</script>\n<img src=x onerror=alert(1)>\nSee **this** [site](https://evil.example/x)\n- one\n- two\n- three";
    serve(ok([gh("0.3.0", { notes })]));
    cx.results["ruleboxRelease:get"] = screenData(null);
    const { container } = ui();
    await screen.findByRole("radiogroup");
    const body = container.querySelector(".upd-notes__body")!;
    expect(body.querySelector("script, img, a")).toBeNull();
    expect(body.textContent).toContain("Big news");
    expect(body.textContent).toContain("See this site");
    expect(body.querySelectorAll("li")).toHaveLength(3);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(container.querySelector('a[href*="evil.example"]')).toBeNull();
  });

  it("Show notes opens the whole text and flips to Hide notes (aria-expanded)", async () => {
    serve(ok([gh("0.3.0", { notes: "## A\n\nOne.\n\n- two\n- three\n- four" })]));
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    const toggle = await screen.findByRole("button", { name: s.showNotes });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const open = screen.getByRole("button", { name: s.hideNotes });
    expect(open.getAttribute("aria-expanded")).toBe("true");
  });

  it("a release without notes has no notes control", async () => {
    serve(ok([gh("0.3.0", { notes: "" })]));
    cx.results["ruleboxRelease:get"] = screenData(null);
    ui();
    await screen.findByRole("radiogroup");
    expect(screen.queryByRole("button", { name: s.showNotes })).toBeNull();
  });
});
