import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";

// The paginated lists of Step 17 against the mocked Convex React hooks: which
// function and arguments each hook uses. The backend is covered by
// convex/audit.test.ts and convex/apps.test.ts.
const cx = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: true },
  paged: [] as { name: string; args: unknown; initialNumItems: number }[],
  pageResults: [] as unknown[],
  pageStatus: "Exhausted" as string,
  loadMore: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => cx.auth,
  usePaginatedQuery: (ref: FunctionReference<"query">, args: unknown, opts: { initialNumItems: number }) => {
    cx.paged.push({ name: getFunctionName(ref), args, initialNumItems: opts.initialNumItems });
    return { results: cx.pageResults, status: cx.pageStatus, isLoading: false, loadMore: cx.loadMore };
  },
}));

import { liveAppsApi } from "../apps/live";
import { liveAuditApi } from "./live";

beforeEach(() => {
  cx.auth = { isLoading: false, isAuthenticated: true };
  cx.paged = [];
  cx.pageResults = [];
  cx.pageStatus = "Exhausted";
  cx.loadMore.mockClear();
});

const entry = { _id: "e1", at: 5, actorType: "member", actorLabel: "owner@acme.test", action: "group.renamed", summary: "Renamed" };

describe("audit lists", () => {
  it("the log is audit:list in pages of 50 and offers Load more while pages remain", () => {
    cx.pageResults = [entry];
    cx.pageStatus = "CanLoadMore";
    const { result } = renderHook(() => liveAuditApi.useAuditScreen());
    expect(cx.paged.at(-1)).toEqual({ name: "audit:list", args: {}, initialNumItems: 50 });
    if (result.current.status !== "ready") throw new Error("expected ready");
    expect(result.current.items).toEqual([entry]);
    expect(result.current.canLoadMore).toBe(true);
    result.current.loadMore();
    expect(cx.loadMore).toHaveBeenCalledWith(50);
  });

  it("a history is audit:forTarget of that id in pages of 10", () => {
    const { result } = renderHook(() => liveAuditApi.useHistory("dev1"));
    expect(cx.paged.at(-1)).toEqual({ name: "audit:forTarget", args: { targetId: "dev1" }, initialNumItems: 10 });
    expect(result.current).toMatchObject({ status: "ready", items: [], canLoadMore: false });
  });

  it("nothing is asked until the session is confirmed; the first page is loading", () => {
    cx.auth = { isLoading: true, isAuthenticated: false };
    renderHook(() => liveAuditApi.useAuditScreen());
    renderHook(() => liveAuditApi.useHistory("dev1"));
    expect(cx.paged.length).toBeGreaterThan(0);
    expect(cx.paged.every((p) => p.args === "skip")).toBe(true);
    cx.auth = { isLoading: false, isAuthenticated: true };
    cx.pageStatus = "LoadingFirstPage";
    expect(renderHook(() => liveAuditApi.useAuditScreen()).result.current.status).toBe("loading");
  });
});

describe("app install lists", () => {
  it("are apps:installs of the app in the chosen state, paginated", () => {
    cx.pageResults = [{ _id: "i1", deviceId: "d1", deviceName: "Front desk", state: "failed", attempts: 3, updatedAt: 9 }];
    const { result } = renderHook(() => liveAppsApi.useAppInstalls("a1", "failed"));
    expect(cx.paged.at(-1)).toEqual({ name: "apps:installs", args: { appId: "a1", state: "failed" }, initialNumItems: 50 });
    expect(result.current).toMatchObject({ status: "ready", items: [{ deviceName: "Front desk", state: "failed" }] });
    cx.auth = { isLoading: true, isAuthenticated: false };
    renderHook(() => liveAppsApi.useAppInstalls("a1", "failed"));
    expect(cx.paged.at(-1)?.args).toBe("skip");
  });
});
