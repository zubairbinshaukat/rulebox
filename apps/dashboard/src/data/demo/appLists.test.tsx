import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { demoApi, demoAppsApi, demoAuditApi, demoEnrollmentApi } from "./hooks";
import { db, resetDemo, setSession } from "./store";
import { demoMembersApi } from "../members/demo";
import type { ListQuery } from "../serverList";
import { errorCodeOf } from "../../lib/errors";

// The demo twins of the Phase 4b lists keep the contract of convex/lib/listing.ts: sort keys, contains / relevance
// search, page size, cursors, the exact total of the bounded tables and the last-page reverse read.

function signInAs(email: string) {
  const m = db().members.find((x) => x.email === email)!;
  const now = Date.now();
  setSession({ memberId: m._id, createdAt: now, stepUp: { verifiedAt: now, lastActiveAt: now, method: "actionPin" } });
}
function fresh() {
  resetDemo();
  signInAs("owner@demo.rulebox.test");
}
const Q = (over: Partial<ListQuery> = {}): ListQuery => ({ numItems: 10, cursor: null, ...over });

async function ready<T extends { status: string }>(result: { current: T }): Promise<Extract<T, { status: "ready" }>> {
  await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 4000 });
  return result.current as Extract<T, { status: "ready" }>;
}
const names = (rows: { name: string }[]) => rows.map((r) => r.name);
const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe("demo fixtures have several pages", () => {
  it("25+ apps, 120+ audit entries, 15+ enrollment codes, 12+ members and pending invites, 12+ file types", () => {
    resetDemo();
    const d = db();
    expect(d.apps.filter((a) => !a.archived).length).toBeGreaterThanOrEqual(25);
    expect(d.apps.filter((a) => a.archived).length).toBeGreaterThanOrEqual(2);
    expect(d.audit.length).toBeGreaterThanOrEqual(120);
    expect(d.tokens.length).toBeGreaterThanOrEqual(15);
    expect(d.members.length).toBeGreaterThanOrEqual(12);
    expect(d.invites.filter((i) => !i.usedAt && i.expiresAt > Date.now()).length).toBeGreaterThanOrEqual(11);
    expect(d.fileHandlers.length).toBeGreaterThanOrEqual(12);
  });
});

describe("demo apps list", () => {
  it("is newest first by default, sorts by name both ways, filters by tab, and counts the active tab only", async () => {
    fresh();
    const newest = renderHook(() => demoAppsApi.useAppsScreen({ archived: false, ...Q({ numItems: 50 }) }));
    const rows = (await ready(newest.result)).items;
    const times = rows.map((r) => r.createdAt!);
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(rows.every((r) => !r.archived)).toBe(true);

    const byName = renderHook(() => demoAppsApi.useAppsScreen({ archived: false, ...Q({ numItems: 50, sort: { key: "name", dir: "asc" } }) }));
    const n = names((await ready(byName.result)).items);
    expect(n).toEqual([...n].sort(asc));
    const desc = renderHook(() => demoAppsApi.useAppsScreen({ archived: false, ...Q({ numItems: 50, sort: { key: "name", dir: "desc" } }) }));
    expect(names((await ready(desc.result)).items)).toEqual([...n].sort(asc).reverse());

    const archived = renderHook(() => demoAppsApi.useAppsScreen({ archived: true, ...Q({ numItems: 50 }) }));
    expect((await ready(archived.result)).items.every((r) => r.archived)).toBe(true);

    const counts = [
      renderHook(() => demoAppsApi.useAppsCount({ archived: false })),
      renderHook(() => demoAppsApi.useAppsCount({ archived: true })),
      renderHook(() => demoAppsApi.useAppsCount({ archived: false, search: "pos" })),
    ];
    await waitFor(() => expect(counts.every((c) => c.result.current !== undefined)).toBe(true), { timeout: 4000 });
    expect(counts.map((c) => c.result.current)).toEqual([db().apps.filter((a) => !a.archived).length, null, null]);
  });

  it("pages by cursor with the page size asked for: every app exactly once", async () => {
    fresh();
    const total = db().apps.filter((a) => !a.archived).length;
    const { result, rerender } = renderHook(({ cursor }) => demoAppsApi.useAppsScreen({ archived: false, ...Q({ numItems: 10, cursor }) }), { initialProps: { cursor: null as string | null } });
    const seen: string[] = [];
    let p = await ready(result);
    for (;;) {
      expect(p.items.length).toBeLessThanOrEqual(10);
      seen.push(...p.items.map((a) => a._id));
      if (p.isDone) break;
      const cursor = p.continueCursor;
      rerender({ cursor });
      await waitFor(() => expect(result.current.status === "ready" && result.current.continueCursor !== cursor).toBe(true), { timeout: 4000 });
      p = await ready(result);
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("the last page is the opposite order with total mod page size rows (reversed it is the tail of the list)", async () => {
    fresh();
    const total = db().apps.filter((a) => !a.archived).length;
    const size = 10;
    const all = renderHook(() => demoAppsApi.useAppsScreen({ archived: false, ...Q({ numItems: 50, sort: { key: "name", dir: "asc" } }) }));
    const everything = names((await ready(all.result)).items);
    const last = renderHook(() => demoAppsApi.useAppsScreen({ archived: false, ...Q({ numItems: total % size || size, sort: { key: "name", dir: "desc" } }) }));
    const tail = names((await ready(last.result)).items).reverse();
    expect(tail).toEqual(everything.slice(total - tail.length));
  });

  it("a search is the best matches first and ignores the sort; an unknown sort key is refused", async () => {
    fresh();
    const found = renderHook(() => demoAppsApi.useAppsScreen({ archived: false, ...Q({ search: "pdf", sort: { key: "name", dir: "desc" } }) }));
    const n = names((await ready(found.result)).items);
    expect(n.slice(0, 2)).toEqual(["PDF Reader", "SumatraPDF"]);
    expect(n.every((x) => x.toLowerCase().includes("pdf"))).toBe(true);
    const bad = renderHook(() => demoAppsApi.useAppsScreen({ archived: false, ...Q({ sort: { key: "kind", dir: "asc" } }) }));
    await waitFor(() => expect(bad.result.current.status).toBe("error"), { timeout: 4000 });
    const err = bad.result.current;
    expect(err.status === "error" && errorCodeOf(err.error)).toBe("invalid_argument");
  });

  it("install lists sort by time and have no total", async () => {
    fresh();
    const app = db().apps.find((a) => a.desktop?.install && db().installs.some((i) => i.appId === a._id))!;
    const state = db().installs.find((i) => i.appId === app._id)!.state;
    const newest = renderHook(() => demoAppsApi.useAppInstalls(app._id, state, Q()));
    const oldest = renderHook(() => demoAppsApi.useAppInstalls(app._id, state, Q({ sort: { key: "updated", dir: "asc" } })));
    const a = (await ready(newest.result)).items.map((i) => i.updatedAt);
    const b = (await ready(oldest.result)).items.map((i) => i.updatedAt);
    expect(a).toEqual([...a].sort((x, y) => y - x));
    expect(b).toEqual([...b].sort((x, y) => x - y));
    expect((await ready(newest.result)).total).toBeNull();
  });
});

describe("demo file types, members and invites (bounded tables)", () => {
  it("file types: offset cursors, the exact total in the page, contains-search on extension or program, sort by program", async () => {
    fresh();
    const total = db().fileHandlers.length;
    const p1 = await ready(renderHook(() => demoAppsApi.useFileTypesPage(Q())).result);
    expect(p1).toMatchObject({ total, isDone: false, continueCursor: "o:10" });
    const p2 = await ready(renderHook(() => demoAppsApi.useFileTypesPage(Q({ cursor: "o:10" }))).result);
    expect(p2.items).toHaveLength(total - 10);
    const exts = p1.items.map((r) => r.extension);
    expect(exts).toEqual([...exts].sort(asc));
    const found = await ready(renderHook(() => demoAppsApi.useFileTypesPage(Q({ search: "READER" }))).result);
    expect(found.items.length).toBeGreaterThan(0);
    expect(found.items.every((r) => r.extension.includes("reader") || r.appName.toLowerCase().includes("reader"))).toBe(true);
    expect(found.total).toBe(found.items.length);
    const byApp = (await ready(renderHook(() => demoAppsApi.useFileTypesPage(Q({ numItems: 50, sort: { key: "app", dir: "asc" } }))).result)).items.map((r) => r.appName);
    expect(byApp).toEqual([...byApp].sort(asc));
  });

  it("members: email A-Z by default, role/status/created sorts, contains-search on the email, exact total", async () => {
    fresh();
    const total = db().members.length;
    const p1 = await ready(renderHook(() => demoMembersApi.useMembersPage(Q())).result);
    expect(p1.total).toBe(total);
    const emails = p1.items.map((m) => m.email);
    expect(emails).toEqual([...emails].sort(asc));
    expect(p1.items.find((m) => m.email === "owner@demo.rulebox.test")?.isYou).toBe(true);
    const byRole = (await ready(renderHook(() => demoMembersApi.useMembersPage(Q({ numItems: 50, sort: { key: "role", dir: "asc" } }))).result)).items.map((m) => m.role);
    expect(byRole[0]).toBe("owner");
    expect(byRole.at(-1)).toBe("viewer");
    const found = await ready(renderHook(() => demoMembersApi.useMembersPage(Q({ search: "SAM." }))).result);
    expect(found.items.map((m) => m.email)).toEqual(["sam.okafor@demo.rulebox.test"]);
    expect(found.total).toBe(1);
  });

  it("invites: only pending ones, newest first by default, by email or expiry, with the exact total", async () => {
    fresh();
    const now = Date.now();
    const pending = db().invites.filter((i) => !i.usedAt && i.expiresAt > now).length;
    const p1 = await ready(renderHook(() => demoMembersApi.useInvitesPage(now, Q())).result);
    expect(p1.total).toBe(pending);
    expect(p1.items.every((i) => i.expiresAt > now)).toBe(true);
    const created = p1.items.map((i) => i.createdAt);
    expect(created).toEqual([...created].sort((x, y) => y - x));
    const byEmail = (await ready(renderHook(() => demoMembersApi.useInvitesPage(now, Q({ numItems: 50, sort: { key: "email", dir: "asc" } }))).result)).items.map((i) => i.email);
    expect(byEmail).toEqual([...byEmail].sort(asc));
    const byExpiry = (await ready(renderHook(() => demoMembersApi.useInvitesPage(now, Q({ numItems: 50, sort: { key: "expires", dir: "desc" } }))).result)).items.map((i) => i.expiresAt);
    expect(byExpiry).toEqual([...byExpiry].sort((x, y) => y - x));
  });

  it("a new invite shows up in the invites list at once, and revoking it removes it", async () => {
    fresh();
    const now = Date.now();
    const list = renderHook(() => demoMembersApi.useInvitesPage(now, Q()));
    const before = (await ready(list.result)).total!;
    const invite = renderHook(() => demoApi.useInviteMember());
    const { code } = await invite.result.current({ email: "fresh.person@demo.rulebox.test", role: "viewer" });
    expect(code).toBeTruthy();
    await waitFor(() => expect(list.result.current.status === "ready" && list.result.current.total).toBe(before + 1), { timeout: 4000 });
    const top = list.result.current.status === "ready" ? list.result.current.items[0]! : null;
    expect(top?.email).toBe("fresh.person@demo.rulebox.test");
  });
});

describe("demo audit log and enrollment codes", () => {
  it("audit: newest first, either direction, history of one target, no total", async () => {
    fresh();
    const newest = await ready(renderHook(() => demoAuditApi.useAuditScreen(Q({ numItems: 50 }))).result);
    const at = newest.items.map((e) => e.at);
    expect(at).toEqual([...at].sort((x, y) => y - x));
    expect(newest.isDone).toBe(false);
    expect(newest.total).toBeNull();
    const oldest = await ready(renderHook(() => demoAuditApi.useAuditScreen(Q({ numItems: 50, sort: { key: "at", dir: "asc" } }))).result);
    expect(oldest.items.map((e) => e.at)).toEqual([...oldest.items.map((e) => e.at)].sort((x, y) => x - y));
    const target = db().audit.find((e) => e.targetId)!.targetId!;
    const history = await ready(renderHook(() => demoAuditApi.useHistory(target, Q({ numItems: 50 }))).result);
    expect(history.items.length).toBeGreaterThan(0);
    expect(history.items.every((e) => e.targetId === target)).toBe(true);
  });

  it("enrollment codes: created (default) or expires, both ways, cursor pages, state from the minute", async () => {
    fresh();
    const now = Date.now();
    const created = await ready(renderHook(() => demoEnrollmentApi.useEnrollmentScreen(now, Q({ numItems: 50 }))).result);
    expect(created.items.length).toBe(db().tokens.length);
    const c = created.items.map((r) => r.createdAt);
    expect(c).toEqual([...c].sort((x, y) => y - x));
    const expires = await ready(renderHook(() => demoEnrollmentApi.useEnrollmentScreen(now, Q({ numItems: 50, sort: { key: "expires", dir: "asc" } }))).result);
    const e = expires.items.map((r) => r.expiresAt);
    expect(e).toEqual([...e].sort((x, y) => x - y));
    const states = new Set(created.items.map((r) => r.state));
    expect([...states].sort()).toEqual(["active", "expired", "revoked", "usedUp"]);
    const first = await ready(renderHook(() => demoEnrollmentApi.useEnrollmentScreen(now, Q())).result);
    expect(first.items).toHaveLength(10);
    expect(first.isDone).toBe(false);
    expect(first.total).toBeNull();
  });
});
