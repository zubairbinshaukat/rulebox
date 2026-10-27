import type { GenericDatabaseReader } from "convex/server";
import type { DataModel, Id } from "../_generated/dataModel";
import schema from "../schema";

// Tenant scoping of `ctx.db` (plan 4.6 "orgDb", A15; post-Phase-5 plan 4.3)
// and the I/O probe (A16, post-Phase-5 plan 2.13).
//
// The member and device wrappers hand handlers a `ctx.db` that:
// - `get(id)`: returns null for a row of another organization (a row whose
//   `orgId` differs, or another `organizations` row);
// - `query(t).withIndex(i, r)` on a table with an `orgId` field: throws
//   unless the range's FIRST equality is `orgId == caller's org`, or it is an
//   id field (`deviceId`, `groupId`, ...) whose value this call already saw on
//   a row of the caller's org (`get`, or a scoped query result), or the index
//   is in ALLOWED_CROSS_ORG; `withSearchIndex` must filter `orgId == caller's
//   org`; a query on such a table without an index throws;
// - `insert(t, v)` on such a table throws when `v.orgId` is another org.
// Cost: in-memory checks only. A throw here is a programming error, never an
// answer a client should see (it surfaces as a server error).

/** Tables with an `orgId` field, from the schema itself (new tables are covered automatically). */
export const ORG_TABLES: ReadonlySet<string> = new Set(
  Object.entries(schema.tables)
    .filter(([, t]) => {
      const validator = (t as { validator: { kind: string; fields?: Record<string, unknown> } }).validator;
      return validator.kind === "object" && validator.fields !== undefined && "orgId" in validator.fields;
    })
    .map(([name]) => name),
);

/** Fields holding the id of a row of the same organization. */
const ID_FIELDS = new Set(["deviceId", "groupId", "employeeId", "appId", "scope"]);
/** Arrays of such ids (validated when the row was written, e.g. `fleetChecks.deviceIds`). */
const ID_ARRAY_FIELDS = new Set(["deviceIds", "groupIds"]);

/**
 * Indexes that are cross-organization BY DESIGN, with the reason:
 * - `members.by_user`: a person's memberships (`requireMember`, "has another
 *   active membership" in `members:setDisabled`, step-up resets). The rows
 *   are never returned to the client.
 */
const ALLOWED_CROSS_ORG = new Set(["members.by_user"]);

export class OrgScopeError extends Error {
  constructor(what: string) {
    super(`orgDb: ${what}`);
    this.name = "OrgScopeError";
  }
}

// ---------------------------------------------------------------- probe

export type IoTotals = { reads: number; readBytes: number; writes: number; writeBytes: number; tables: Set<string> };

/**
 * The I/O probe: off in production. Tests switch it on, `reset()` before a
 * call and read `totals` after it (functions run one at a time in tests).
 * Bytes are `JSON.stringify(doc).length`, an approximation of Convex's own
 * accounting.
 */
export const ioProbe = {
  enabled: false,
  totals: emptyTotals(),
  reset(): void {
    this.totals = emptyTotals();
  },
};

function emptyTotals(): IoTotals {
  return { reads: 0, readBytes: 0, writes: 0, writeBytes: 0, tables: new Set() };
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Databases that already count (the wrapper's unscoped layer): an outer layer must not count again. */
const COUNTING = new WeakSet<object>();

function countRead(count: boolean, table: string | null, doc: unknown): void {
  if (!count || !ioProbe.enabled) return;
  if (table !== null) ioProbe.totals.tables.add(table);
  if (doc === null || doc === undefined) return;
  ioProbe.totals.reads++;
  ioProbe.totals.readBytes += sizeOf(doc);
}

function countWrite(count: boolean, table: string | null, value: unknown): void {
  if (!count || !ioProbe.enabled) return;
  ioProbe.totals.writes++;
  ioProbe.totals.writeBytes += sizeOf(value);
  if (table !== null) ioProbe.totals.tables.add(table);
}

// ---------------------------------------------------------------- wrapper

export type OrgScope = {
  orgId: Id<"organizations">;
  /** Ids of rows of this org seen in this call (and the device itself for device wrappers). */
  checked: Set<string>;
};

type AnyDb = GenericDatabaseReader<DataModel>;
type Doc = Record<string, unknown> & { _id: string };

const TABLE_NAMES = Object.keys(schema.tables);

function tableOfId(db: AnyDb, id: string): string | null {
  for (const t of TABLE_NAMES) {
    if (db.normalizeId(t as never, id) !== null) return t;
  }
  return null;
}

function remember(scope: OrgScope | null, doc: unknown): void {
  if (scope === null || doc === null || typeof doc !== "object") return;
  const d = doc as Doc;
  if (d.orgId !== scope.orgId) return; // only rows of the caller's org vouch for ids
  scope.checked.add(d._id);
  for (const f of ID_FIELDS) {
    const value = d[f];
    if (typeof value === "string") scope.checked.add(value);
  }
  for (const f of ID_ARRAY_FIELDS) {
    const value = d[f];
    if (Array.isArray(value)) for (const x of value) if (typeof x === "string") scope.checked.add(x);
  }
}

function seeResult(count: boolean, table: string, scope: OrgScope | null, result: unknown): void {
  const docs: unknown[] = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object" && "page" in result && Array.isArray((result as { page: unknown }).page)
      ? (result as { page: unknown[] }).page
      : [result];
  countRead(count, table, null); // the table was read even when nothing came back
  for (const doc of docs) {
    countRead(count, table, doc);
    remember(scope, doc);
  }
}

/** Records the calls made on an index-range / search-filter builder, and unwraps it again. */
function recorder(builder: object) {
  const calls: { method: string; args: unknown[] }[] = [];
  const targets = new WeakMap<object, object>();
  const wrap = (b: object): object => {
    const p: object = new Proxy(b, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          const next: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
          return next !== null && typeof next === "object" ? wrap(next) : next;
        };
      },
    });
    targets.set(p, b);
    return p;
  };
  return { proxy: wrap(builder), calls, unwrap: (x: unknown) => (x !== null && typeof x === "object" ? (targets.get(x) ?? x) : x) };
}

function checkIndexRange(table: string, index: string, calls: { method: string; args: unknown[] }[], scope: OrgScope): void {
  if (ALLOWED_CROSS_ORG.has(`${table}.${index}`)) return;
  const first = calls[0];
  if (first === undefined || first.method !== "eq") {
    throw new OrgScopeError(`${table}.${index} needs an equality on orgId or a checked id first`);
  }
  const [field, value] = first.args as [string, unknown];
  if (field === "orgId") {
    if (value !== scope.orgId) throw new OrgScopeError(`${table}.${index}: another organization's range`);
    return;
  }
  if (ID_FIELDS.has(field) && typeof value === "string" && scope.checked.has(value)) return;
  throw new OrgScopeError(`${table}.${index}: ${field} was not checked in this organization`);
}

function wrapQuery(q: object, table: string, scope: OrgScope | null, indexed: boolean, count: boolean): object {
  const scoped = scope !== null && ORG_TABLES.has(table);
  return new Proxy(q, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        let nowIndexed = indexed;
        if (prop === "withIndex") {
          nowIndexed = true;
          if (scoped) {
            const [index, range] = args as [string, ((q: object) => object) | undefined];
            args = [
              index,
              (b: object) => {
                const r = recorder(b);
                const out = range === undefined ? r.proxy : range(r.proxy);
                checkIndexRange(table, index, r.calls, scope);
                return r.unwrap(out);
              },
            ];
          }
        } else if (prop === "withSearchIndex") {
          nowIndexed = true;
          if (scoped) {
            const [index, filter] = args as [string, (q: object) => object];
            args = [
              index,
              (b: object) => {
                const r = recorder(b);
                const out = filter(r.proxy);
                const org = r.calls.find((c) => c.method === "eq" && c.args[0] === "orgId");
                if (org === undefined || org.args[1] !== scope.orgId) {
                  throw new OrgScopeError(`${table}.${index}: search must filter orgId == caller's org`);
                }
                return r.unwrap(out);
              },
            ];
          }
        } else if (scoped && !indexed) {
          throw new OrgScopeError(`${table}: query without an index`);
        }
        const result: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result instanceof Promise) {
          return result.then((r: unknown) => {
            seeResult(count, table, scoped ? scope : null, r);
            return r;
          });
        }
        if (result !== null && typeof result === "object" && typeof (result as { take?: unknown }).take === "function") {
          return wrapQuery(result, table, scope, nowIndexed, count);
        }
        return result;
      };
    },
  });
}

/**
 * `db` scoped to `scope.orgId` (null = probe only, no scoping) and counted by
 * the I/O probe when it is on. Works for readers and writers.
 */
export function scopedDb<DB extends AnyDb>(db: DB, scope: OrgScope | null): DB {
  const count = ioProbe.enabled && !COUNTING.has(db);
  if (scope === null && !count) return db;
  const tableOf = (args: unknown[], withTable: number): string | null =>
    args.length >= withTable ? (args[0] as string) : count ? tableOfId(db, args[0] as string) : null;
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const fn = value as (...a: unknown[]) => unknown;
      switch (prop) {
        case "get":
          return async (...args: unknown[]) => {
            const id = (args.length >= 2 ? args[1] : args[0]) as string;
            const doc = (await fn.apply(target, args)) as Doc | null;
            const table = args.length >= 2 ? (args[0] as string) : count || scope !== null ? tableOfId(target, id) : null;
            countRead(count, table, doc);
            if (doc === null || scope === null) return doc;
            if ("orgId" in doc && doc.orgId !== scope.orgId) return null;
            if (table === "organizations" && doc._id !== scope.orgId) return null;
            remember(scope, doc);
            return doc;
          };
        case "query":
          return (table: string) => wrapQuery(fn.call(target, table) as object, table, scope, false, count);
        case "insert":
          return async (table: string, doc: Record<string, unknown>) => {
            if (scope !== null && ORG_TABLES.has(table) && doc.orgId !== scope.orgId) {
              throw new OrgScopeError(`insert into ${table} for another organization`);
            }
            countWrite(count, table, doc);
            const id = (await fn.call(target, table, doc)) as string;
            if (scope !== null) scope.checked.add(id);
            return id;
          };
        case "patch":
        case "replace":
          return async (...args: unknown[]) => {
            countWrite(count, tableOf(args, 3), args[args.length - 1]);
            return await fn.apply(target, args);
          };
        case "delete":
          return async (...args: unknown[]) => {
            countWrite(count, tableOf(args, 2), null);
            return await fn.apply(target, args);
          };
        default:
          return fn.bind(target);
      }
    },
  });
  if (count) COUNTING.add(proxy);
  return proxy;
}
