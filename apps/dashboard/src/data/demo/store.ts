/**
 * The demo backend: one in-memory database, reactive like Convex (every
 * subscribed screen re-computes after a write), with simulated latency,
 * connection loss (writes queue until the connection is back, as the Convex
 * client does), failing queries and a stale-edit trigger.
 *
 * Nothing here is used when `VITE_DEMO` is not "1".
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppError } from "../../lib/errors";
import { readStorage, writeStorage } from "../../lib/storage";
import { PAGE_SIZE, type ErrorCode, type PagedState, type QueryState, type Role } from "../types";
import { pingIntervalFor, seed, type DbAudit, type DbMember, type DemoDb } from "../fixtures/seed";

// ---------------------------------------------------------------- state

export interface DemoControls {
  slow: boolean;
  offline: boolean;
  failQueries: boolean;
}

interface Session {
  memberId: string;
  mfaVerified: boolean;
}

const SESSION_KEY = "rulebox.demo.session";
const CONTROLS_KEY = "rulebox.demo.controls";

function loadSession(): Session | null {
  const raw = readStorage(SESSION_KEY, "session");
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    return typeof s.memberId === "string" ? s : null;
  } catch {
    return null;
  }
}

function loadControls(): DemoControls {
  const base = { slow: false, offline: false, failQueries: false };
  const raw = readStorage(CONTROLS_KEY, "session");
  if (!raw) return base;
  try {
    // Connection loss is never restored on reload: it would look like a bug.
    return { ...base, ...(JSON.parse(raw) as Partial<DemoControls>), offline: false };
  } catch {
    return base;
  }
}

const state = {
  db: /* @__PURE__ */ seed(),
  version: 0,
  controls: /* @__PURE__ */ loadControls(),
  session: /* @__PURE__ */ loadSession(),
  /** Role override from the demo controls ("View as"). */
  roleOverride: (/* @__PURE__ */ readStorage("rulebox.demo.role", "session") as Role | null) ?? null,
  failedSignIns: 0,
};

const listeners = new Set<() => void>();
const connectionWaiters: (() => void)[] = [];

function notify() {
  state.version++;
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getVersion(): number {
  return state.version;
}

export function db(): DemoDb {
  return state.db;
}

export function controls(): DemoControls {
  return state.controls;
}

export function setControls(patch: Partial<DemoControls>) {
  state.controls = { ...state.controls, ...patch };
  writeStorage(CONTROLS_KEY, JSON.stringify(state.controls), "session");
  if (!state.controls.offline) {
    const waiting = connectionWaiters.splice(0);
    for (const w of waiting) w();
  }
  notify();
}

export function resetDemo() {
  state.db = seed();
  state.failedSignIns = 0;
  const owner = state.db.members.find((m) => m.role === "owner");
  if (state.session && !state.db.members.some((m) => m._id === state.session!.memberId) && owner) {
    setSession({ memberId: owner._id, mfaVerified: true });
  }
  notify();
}

export function session(): Session | null {
  return state.session;
}

export function setSession(s: Session | null) {
  state.session = s;
  writeStorage(SESSION_KEY, s ? JSON.stringify(s) : null, "session");
  notify();
}

export function setRoleOverride(role: Role | null) {
  state.roleOverride = role;
  writeStorage("rulebox.demo.role", role, "session");
  notify();
}

export function roleOverride(): Role | null {
  return state.roleOverride;
}

export function bumpFailedSignIns(): number {
  state.failedSignIns++;
  return state.failedSignIns;
}

export function clearFailedSignIns() {
  state.failedSignIns = 0;
}

/** The signed-in member with the demo role override applied. */
export function currentMember(): DbMember | null {
  const s = state.session;
  if (!s) return null;
  const m = state.db.members.find((x) => x._id === s.memberId);
  if (!m) return null;
  return state.roleOverride ? { ...m, role: state.roleOverride } : m;
}

// ---------------------------------------------------------------- timing

export function latency(): number {
  const base = state.controls.slow ? 1800 : 260;
  return base + Math.floor(Math.random() * (state.controls.slow ? 900 : 240));
}

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function whenConnected(): Promise<void> {
  if (!state.controls.offline) return Promise.resolve();
  return new Promise((r) => connectionWaiters.push(r));
}

export function fail(code: ErrorCode, extra: { field?: string; retryAfterMs?: number; detail?: string } = {}): never {
  throw new AppError({ code, ...extra });
}

export function newId(prefix: string): string {
  return `${prefix}_${(state.db.nextId++).toString(36).padStart(4, "0")}`;
}

// ---------------------------------------------------------------- writes

const RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };

export interface MutationCtx {
  db: DemoDb;
  me: DbMember;
  now: number;
  audit: (e: Omit<DbAudit, "_id" | "at" | "actorType" | "actorId" | "actorLabel">) => void;
}

/**
 * A member mutation: waits for the connection (queued like Convex), waits a
 * moment, checks the role, runs `fn` against the database and notifies every
 * subscribed screen.
 */
export async function runMutation<R>(minRole: Role, fn: (ctx: MutationCtx) => R): Promise<R> {
  await whenConnected();
  await sleep(latency());
  const me = currentMember();
  if (!me) fail("unauthenticated");
  if (me.status === "disabled") fail("forbidden");
  if (RANK[me.role] < RANK[minRole]) fail("forbidden");
  const now = Date.now();
  const ctx: MutationCtx = {
    db: state.db,
    me,
    now,
    audit: (e) =>
      state.db.audit.push({
        _id: newId("aud"),
        at: now,
        actorType: "member",
        actorId: me._id,
        actorLabel: me.email,
        ...e,
      }),
  };
  const result = fn(ctx);
  state.db.pingIntervalMs = pingIntervalFor(state.db.devices.filter((d) => !d.revoked).length);
  notify();
  return result;
}

/**
 * Optimistic toggle (Section 4.13: only toggles): `apply` runs at once, the
 * server call follows; on error `revert` runs and the error is re-thrown.
 */
export async function runOptimistic<R>(
  minRole: Role,
  apply: (db: DemoDb) => void,
  revert: (db: DemoDb) => void,
  fn: (ctx: MutationCtx) => R,
): Promise<R> {
  const me = currentMember();
  if (me && RANK[me.role] >= RANK[minRole]) {
    apply(state.db);
    notify();
  }
  try {
    return await runMutation(minRole, (ctx) => {
      revert(ctx.db);
      return fn(ctx);
    });
  } catch (e) {
    revert(state.db);
    notify();
    throw e;
  }
}

/** `checkRevision` (Step 2): throws `stale_edit` when someone else saved first. */
export function checkRevision(doc: { revision?: number }, expected: number) {
  if ((doc.revision ?? 0) !== expected) fail("stale_edit");
}

/** "Simulate another admin's edit": every editable record gets a new revision. */
export function simulateConcurrentEdit() {
  const d = state.db;
  d.org.revision++;
  for (const list of [d.groups, d.devices, d.employees, d.apps, d.members]) for (const row of list) row.revision++;
  notify();
}

// ---------------------------------------------------------------- reads

function useVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/**
 * A reactive query. `key` identifies the arguments: a new key shows the
 * loading state for one simulated round trip, then the result stays live
 * (re-computed after every write, without a loading state, like Convex).
 */
export function useDemoQuery<T>(key: string, compute: (db: DemoDb) => T): QueryState<T> {
  const version = useVersion();
  const [attempt, setAttempt] = useState(0);
  const fullKey = `${key}#${attempt}`;
  const [settled, setSettled] = useState<{ key: string; failed: boolean } | null>(null);


  useEffect(() => {
    const t = setTimeout(() => setSettled({ key: fullKey, failed: state.controls.failQueries }), latency());
    return () => clearTimeout(t);
  }, [fullKey]);

  const result = useMemo((): { ok: true; data: T } | { ok: false; error: unknown } => {
    try {
      return { ok: true, data: compute(state.db) };
    } catch (error) {
      return { ok: false, error };
    }
    // `version` re-runs the computation after every write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, fullKey]);

  if (!settled || settled.key !== fullKey) return { status: "loading" };
  const retry = () => setAttempt((a) => a + 1);
  if (settled.failed) return { status: "error", error: new Error("Network error (simulated)"), retry };
  if (!result.ok) return { status: "error", error: result.error, retry };
  return { status: "ready", data: result.data };
}

/**
 * A reactive paginated query (`usePaginatedQuery(…, { initialNumItems: 50 })`):
 * "Load more" adds 50; `canLoadMore` is false once everything is loaded.
 */
export function useDemoPaged<T>(key: string, computeAll: (db: DemoDb) => T[]): PagedState<T> {
  const q = useDemoQuery(key, computeAll);
  const [pages, setPages] = useState<{ key: string; count: number; loading: boolean }>({
    key,
    count: PAGE_SIZE,
    loading: false,
  });
  const current = pages.key === key ? pages : { key, count: PAGE_SIZE, loading: false };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (q.status !== "ready") return q;
  const all = q.data;
  return {
    status: "ready",
    items: all.slice(0, current.count),
    canLoadMore: all.length > current.count,
    isLoadingMore: current.loading,
    loadMore: () => {
      if (current.loading) return;
      setPages({ key, count: current.count, loading: true });
      timer.current = setTimeout(() => setPages({ key, count: current.count + PAGE_SIZE, loading: false }), latency());
    },
  };
}

/** For the session hooks: re-renders on every store change. */
export function useStoreVersion(): number {
  return useVersion();
}

// ---------------------------------------------------------------- heartbeat simulation

let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Online demo PCs check in every 20 seconds (only while some screen listens). */
export function startHeartbeats() {
  if (heartbeat || typeof window === "undefined") return;
  heartbeat = setInterval(() => {
    if (state.controls.offline || listeners.size === 0) return;
    const now = Date.now();
    for (const id of state.db.onlineIds) state.db.lastSeen.set(id, now - Math.floor(Math.random() * 15_000));
    notify();
  }, 20_000);
}
