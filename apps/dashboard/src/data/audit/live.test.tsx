import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";

// The server-driven lists of Phase 4b against the mocked Convex React hooks: which function and arguments each
// hook subscribes to. ONE page per subscription (`paginationOpts`), never `usePaginatedQuery` (not even mocked
// here, so using it would throw). The backend is covered by convex/audit.test.ts, apps.test.ts, listing.test.ts.
const cx = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: true },
  requests: [] as { name: string; args: unknown }[],
  results: {} as Record<string, unknown>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => cx.auth,
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        const name = getFunctionName(r.query);
        cx.requests.push({ name, args: r.args });
        return [k, cx.results[name]];
      }),
    ),
}));

import { liveAppsApi } from "../apps/live";
import { liveEnrollmentApi } from "../enrollment/live";
import { liveMembersApi } from "../members/live";
import { liveAuditApi } from "./live";

beforeEach(() => {
  cx.auth = { isLoading: false, isAuthenticated: true };
  cx.requests = [];
  cx.results = {};
});

const last = (name: string) => cx.requests.filter((r) => r.name === name).at(-1);
const page = (rows: unknown[], extra: object = {}) => ({ page: rows, isDone: true, continueCursor: `c:${rows.length}`, ...extra });
const entry = { _id: "e1", at: 5, actorType: "member", actorLabel: "owner@acme.test", action: "group.renamed", summary: "Renamed" };
const first = { numItems: 10, cursor: null };

describe("audit lists", () => {
  it("the log is one page of audit:list by time; Next is the cursor of the page", () => {
    cx.results["audit:list"] = page([entry], { isDone: false, continueCursor: "CUR" });
    const { result } = renderHook(() => liveAuditApi.useAuditScreen({ numItems: 10, cursor: null, sort: { key: "at", dir: "desc" } }));
    expect(last("audit:list")?.args).toEqual({ paginationOpts: first, sort: { key: "at", dir: "desc" } });
    expect(result.current).toMatchObject({ status: "ready", items: [entry], isDone: false, continueCursor: "CUR", total: null, busy: false });
  });

  it("whatever sort or search is asked for, the audit log sends only the time sort (and no search)", () => {
    renderHook(() => liveAuditApi.useAuditScreen({ numItems: 25, cursor: "CUR", sort: { key: "name", dir: "asc" }, search: "x" }));
    expect(last("audit:list")?.args).toEqual({ paginationOpts: { numItems: 25, cursor: "CUR" }, sort: { key: "at", dir: "asc" } });
  });

  it("a history is audit:forTarget of that id", () => {
    const { result } = renderHook(() => liveAuditApi.useHistory("dev1", { numItems: 10, cursor: null }));
    expect(last("audit:forTarget")?.args).toEqual({ targetId: "dev1", paginationOpts: first, sort: { key: "at", dir: "desc" } });
    expect(result.current.status).toBe("loading");
  });

  it("nothing is asked until the session is confirmed", () => {
    cx.auth = { isLoading: true, isAuthenticated: false };
    renderHook(() => liveAuditApi.useAuditScreen({ numItems: 10, cursor: null }));
    renderHook(() => liveAuditApi.useHistory("dev1", { numItems: 10, cursor: null }));
    expect(cx.requests).toEqual([]);
  });

  it("while the next page loads, the previous rows stay (busy); another target drops them", () => {
    cx.results["audit:forTarget"] = page([entry]);
    const { result, rerender } = renderHook(({ id, cursor }) => liveAuditApi.useHistory(id, { numItems: 10, cursor }), { initialProps: { id: "dev1", cursor: null as string | null } });
    expect(result.current).toMatchObject({ status: "ready", busy: false });
    cx.results["audit:forTarget"] = undefined;
    rerender({ id: "dev1", cursor: "c:1" });
    expect(result.current).toMatchObject({ status: "ready", busy: true, items: [entry] });
    rerender({ id: "dev2", cursor: null });
    expect(result.current.status).toBe("loading");
  });
});

describe("app lists", () => {
  it("apps:list asks for the tab, the sort and one page; apps:count is a query of its own", () => {
    cx.results["apps:count"] = { total: 12 };
    const list = renderHook(() => liveAppsApi.useAppsScreen({ archived: false, numItems: 25, cursor: "CUR", sort: { key: "name", dir: "asc" } }));
    const count = renderHook(() => liveAppsApi.useAppsCount({ archived: false }));
    expect(last("apps:list")?.args).toEqual({ archived: false, paginationOpts: { numItems: 25, cursor: "CUR" }, sort: { key: "name", dir: "asc" } });
    expect(last("apps:count")?.args).toEqual({ archived: false });
    expect(count.result.current).toBe(12);
    expect(list.result.current.status).toBe("loading");
  });

  it("a search is sent trimmed and the sort is left out (relevance order); the count carries the search too", () => {
    renderHook(() => liveAppsApi.useAppsScreen({ archived: true, numItems: 10, cursor: null, sort: { key: "name", dir: "desc" }, search: "  pos  " }));
    renderHook(() => liveAppsApi.useAppsCount({ archived: true, search: "  pos  " }));
    expect(last("apps:list")?.args).toEqual({ archived: true, paginationOpts: first, search: "pos" });
    expect(last("apps:count")?.args).toEqual({ archived: true, search: "pos" });
  });

  it("the count is undefined while it loads and null when the server has none", () => {
    expect(renderHook(() => liveAppsApi.useAppsCount({ archived: false })).result.current).toBeUndefined();
    cx.results["apps:count"] = { total: null };
    expect(renderHook(() => liveAppsApi.useAppsCount({ archived: true })).result.current).toBeNull();
  });

  it("install lists are apps:installs of the app in the chosen state, by time", () => {
    cx.results["apps:installs"] = page([{ _id: "i1", deviceId: "d1", deviceName: "Front desk", state: "failed", attempts: 3, updatedAt: 9 }]);
    const { result } = renderHook(() => liveAppsApi.useAppInstalls("a1", "failed", { numItems: 10, cursor: null }));
    expect(last("apps:installs")?.args).toEqual({ appId: "a1", state: "failed", paginationOpts: first, sort: { key: "updated", dir: "desc" } });
    expect(result.current).toMatchObject({ status: "ready", items: [{ deviceName: "Front desk", state: "failed" }] });
  });

  it("file types are fileHandlers:page with the sort and the search", () => {
    cx.results["fileHandlers:page"] = page([], { total: 0, continueCursor: "o:0" });
    const { result } = renderHook(() => liveAppsApi.useFileTypesPage({ numItems: 10, cursor: "o:10", sort: { key: "app", dir: "desc" }, search: "pdf" }));
    expect(last("fileHandlers:page")?.args).toEqual({ paginationOpts: { numItems: 10, cursor: "o:10" }, sort: { key: "app", dir: "desc" }, search: "pdf" });
    expect(result.current).toMatchObject({ status: "ready", total: 0 });
  });
});

describe("enrollment and members lists", () => {
  it("enrollment codes: nowMs is the minute, the sort is created or expires, no search", () => {
    renderHook(() => liveEnrollmentApi.useEnrollmentScreen(120_000, { numItems: 10, cursor: null, sort: { key: "expires", dir: "asc" }, search: "x" }));
    expect(last("enrollmentCodes:list")?.args).toEqual({ nowMs: 120_000, paginationOpts: first, sort: { key: "expires", dir: "asc" } });
  });

  it("members:page and members:invitesPage return their exact total inside the page", () => {
    cx.results["members:page"] = page([{ _id: "m1" }], { total: 14, continueCursor: "o:1", isDone: false });
    cx.results["members:invitesPage"] = page([], { total: 0, continueCursor: "o:0" });
    const members = renderHook(() => liveMembersApi.useMembersPage({ numItems: 10, cursor: null, sort: { key: "role", dir: "asc" }, search: "sam" }));
    const invites = renderHook(() => liveMembersApi.useInvitesPage(60_000, { numItems: 10, cursor: null, sort: { key: "created", dir: "desc" } }));
    expect(last("members:page")?.args).toEqual({ paginationOpts: first, sort: { key: "role", dir: "asc" }, search: "sam" });
    expect(last("members:invitesPage")?.args).toEqual({ nowMs: 60_000, paginationOpts: first, sort: { key: "created", dir: "desc" } });
    expect(members.result.current).toMatchObject({ status: "ready", total: 14, isDone: false });
    expect(invites.result.current).toMatchObject({ status: "ready", total: 0 });
  });
});
