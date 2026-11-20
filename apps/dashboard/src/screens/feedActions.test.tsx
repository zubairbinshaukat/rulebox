import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { appUpdateStrings } from "../lib/screenStrings/appUpdates";
import { appsStrings } from "../lib/screenStrings/apps";
import { auditStrings } from "../lib/screenStrings/audit";
import { actionLabel } from "../lib/audit";

// Phase 6 Step 12, dashboard part: the feed status line's Approve / Dismiss / Check now / Pause buttons (`feeds:*`) and the Apps
// list's `updateFlag`, against the LIVE data seam with the Convex React hooks mocked (convex/feeds.test.ts covers the backend).
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(Object.entries(req).map(([k, r]) => [k, cx.results[getFunctionName(r.query)]])),
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
import Apps from "./Apps";
import AppEdit from "./AppEdit";

const admin: Me = { email: "admin@x.test", role: "admin", status: "active", orgId: "org", orgName: "Acme", pin: { required: true, set: true }, serverApiVersion: 1 };

function ui(node: ReactNode, role: Me["role"], path: string) {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/apps" element={node} />
            <Route path="/apps/:id" element={node} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  cx.results = {};
  cx.fns = {};
});
afterEach(cleanup);

const s = appUpdateStrings;
const install = { kind: "msi", url: "https://dl.example.com/pos-2.msi", sha256: "ab".repeat(32), sizeBytes: 2000, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: true };
const feed = { kind: "tauri", url: "https://updates.example.com/latest.json", pubkey: "RWTestKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", target: "windows-x86_64-nsis" };
const managed = (feedStatus: Record<string, unknown>) => ({
  _id: "a2",
  name: "POS",
  kind: "desktop",
  archived: false,
  revision: 5,
  createdAt: 1,
  assignments: [],
  fileTypes: [],
  directEmployeeCount: 0,
  groupOptions: [],
  denials30d: [],
  desktop: {
    source: "msi",
    exe: "{ProgramFiles}\\Pos\\pos.exe",
    args: [],
    fileArgTemplate: [],
    resetFolders: [],
    install,
    version: "2.0.0",
    update: { mode: "managed", feed, autoPublish: false, applyWhen: "boot_or_signed_out", rollbackOnFail: true },
  },
  feedStatus,
});
const offered = { status: "ok", failures: 0, lastCheckedAt: Date.now() - 60_000, seenVersion: "2.1.0", pending: { version: "2.1.0", foundAt: Date.now() - 60_000 } };
const calm = { status: "ok", failures: 0, lastCheckedAt: Date.now() - 60_000, seenVersion: "2.0.0" };
const button = (name: string) => screen.getByRole("button", { name });

describe("AppEdit: the feed status line's buttons", () => {
  it("an offered version has Approve and Dismiss: each sends the app and its revision; Approve toasts and takes the new revision", async () => {
    cx.results["apps:get"] = managed(offered);
    const approve = vi.fn(async () => ({ revision: 6 }));
    const dismiss = vi.fn(async () => ({ revision: 5 }));
    cx.fns["feeds:approve"] = approve;
    cx.fns["feeds:dismiss"] = dismiss;
    ui(<AppEdit />, "admin", "/apps/a2");
    expect(await screen.findByText(s.feedStatusPending("2.1.0"))).toBeTruthy();
    fireEvent.click(button(s.feedApprove));
    await waitFor(() => expect(approve).toHaveBeenCalledWith({ appId: "a2", expectedRevision: 5 }));
    expect(await screen.findByText(s.feedApproved("2.1.0"))).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: s.feedDismiss }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith({ appId: "a2", expectedRevision: 6 }));
    expect(await screen.findByText(s.feedDismissed("2.1.0"))).toBeTruthy();
  });

  it("a stale_edit on Approve is one plain sentence under the line", async () => {
    cx.results["apps:get"] = managed(offered);
    cx.fns["feeds:approve"] = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    ui(<AppEdit />, "admin", "/apps/a2");
    fireEvent.click(await screen.findByRole("button", { name: s.feedApprove }));
    expect(await screen.findByText(s.feedStale)).toBeTruthy();
  });

  it("nothing offered: no Approve or Dismiss; Check now sends only the app and says what it found; the answer 'pending' names the version", async () => {
    cx.results["apps:get"] = managed(calm);
    const check = vi.fn(async () => ({ result: "pending", status: "ok", version: "2.1.0" }));
    cx.fns["feeds:checkNow"] = check;
    ui(<AppEdit />, "admin", "/apps/a2");
    await screen.findByText(s.feedStatusWorking);
    expect(screen.queryByRole("button", { name: s.feedApprove })).toBeNull();
    expect(screen.queryByRole("button", { name: s.feedDismiss })).toBeNull();
    fireEvent.click(button(s.feedCheckNow));
    await waitFor(() => expect(check).toHaveBeenCalledWith({ appId: "a2" }));
    expect(await screen.findByText(s.feedChecked.pending("2.1.0"))).toBeTruthy();
  });

  it("Check now's refusals: too soon (rate_limited) and paused (conflict) each have their own sentence", async () => {
    cx.results["apps:get"] = managed(calm);
    cx.fns["feeds:checkNow"] = vi.fn().mockRejectedValue(new ConvexError({ code: "rate_limited", retryAfterMs: 300000 }));
    ui(<AppEdit />, "admin", "/apps/a2");
    fireEvent.click(await screen.findByRole("button", { name: s.feedCheckNow }));
    expect(await screen.findByText(s.feedCheckTooSoon)).toBeTruthy();
    cx.fns["feeds:checkNow"] = vi.fn().mockRejectedValue(new ConvexError({ code: "conflict", detail: "paused" }));
    fireEvent.click(button(s.feedCheckNow));
    expect(await screen.findByText(s.feedCheckPaused)).toBeTruthy();
  });

  it("Pause sends paused: true; a paused feed offers Resume (paused: false) and no Check now", async () => {
    cx.results["apps:get"] = managed(calm);
    const setPaused = vi.fn(async () => null);
    cx.fns["feeds:setPaused"] = setPaused;
    ui(<AppEdit />, "admin", "/apps/a2");
    fireEvent.click(await screen.findByRole("button", { name: s.feedPause }));
    await waitFor(() => expect(setPaused).toHaveBeenCalledWith({ appId: "a2", paused: true }));
    cleanup();
    cx.results["apps:get"] = managed({ status: "paused", failures: 0, lastCheckedAt: Date.now() - 60_000 });
    ui(<AppEdit />, "admin", "/apps/a2");
    await screen.findByText(s.feedStatusProblem.paused);
    expect((button(s.feedCheckNow) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button(s.feedResume));
    await waitFor(() => expect(setPaused).toHaveBeenCalledWith({ appId: "a2", paused: false }));
  });

  it("a viewer sees the status line and none of the buttons", async () => {
    cx.results["apps:get"] = managed(offered);
    ui(<AppEdit />, "viewer", "/apps/a2");
    await screen.findByText(s.feedStatusPending("2.1.0"));
    for (const name of [s.feedApprove, s.feedDismiss, s.feedCheckNow, s.feedPause]) expect(screen.queryByRole("button", { name })).toBeNull();
  });
});

describe("Apps list: updateFlag", () => {
  it("shows 'Update waiting' and 'Feed problem' next to the app, and nothing for an app without a flag", () => {
    cx.results["apps:list"] = {
      page: [
        { _id: "a1", name: "Docs", kind: "web", archived: false, groupCount: 0, groupCountMore: false, summary: null },
        { _id: "a2", name: "POS", kind: "desktop", source: "msi", archived: false, groupCount: 1, groupCountMore: false, summary: null, updateFlag: "available" },
        { _id: "a3", name: "Mail", kind: "desktop", source: "exe", archived: false, groupCount: 1, groupCountMore: false, summary: null, updateFlag: "feed_error" },
      ],
      isDone: true,
      continueCursor: "c:3",
    };
    ui(<Apps />, "viewer", "/apps");
    expect(screen.getByText(appsStrings.updateFlag.available)).toBeTruthy();
    expect(screen.getByText(appsStrings.updateFlag.feed_error)).toBeTruthy();
    expect(screen.getAllByText(/^(Update waiting|Feed problem)$/)).toHaveLength(2);
  });
});

describe("audit label", () => {
  it("app.feedRejected has a plain label (convex/audit.test.ts checks every Phase 5 and 6 action has one)", () => {
    expect(auditStrings.actions["app.feedRejected"]).toBe("Vendor update refused");
    expect(actionLabel("app.feedRejected")).toBe("Vendor update refused");
  });
});
