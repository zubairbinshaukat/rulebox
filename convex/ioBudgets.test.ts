import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { probe } from "../tests/convex/devices";
import { asMember, makeOrg } from "../tests/convex/identity";
import { INTERNAL_CALLS, internalEnv, UNMEASURED, type InternalCase } from "../tests/convex/ioInternal";
import { LARGE, seedLargeOrg } from "../tests/convex/largeOrg";
import { MASTER_A, setMaster } from "../tests/convex/phase5";
import { DEVICE_CALLS, expectedFor, fixture, type Fixture, internalFunctions, outcome, publicFunctions, ROWS, type Caller, type Row } from "../tests/convex/matrixRows";
import { api } from "./_generated/api";
import { sha256HexSync } from "./lib/crypto";
import { IO_BUDGETS } from "./ioBudgets";

declare const process: { env: Record<string, string | undefined> };

// The I/O probe and budgets (plan Step 18 item 9, A16). The wrappers count every document a
// public function reads and writes (`lib/orgDb.ts`, always on in tests); this test seeds the
// large-org fixture (200 PCs, 300 employees, 30 apps, 10 groups, 500 audit rows) plus a second
// organization, calls EVERY public function with the probe on, and fails a function without a
// row in `ioBudgets.ts` or one over its budget. It also checks the "never subscribe" list
// (post-Phase-5 plan 2.5) for the functions the dashboard subscribes to.
//
// INTERNAL functions (scheduler, actions' helpers, CLI, `testing:*` seed helpers, maintenance
// stages) are budgeted the same way: `internalQuery` / `internalMutation` come from
// `lib/functions.ts`, which counts their `ctx.db` with the same probe, so an internal action's
// number is the sum of the internal queries and mutations it calls. `tests/convex/ioInternal.ts`
// has one call per internal function (or a reason it cannot run: `UNMEASURED`); a function with
// neither, or without a row, fails the completeness test.

/** Convex Auth's own entry points (public and its internal `store`): not ours to budget (covered by auth.test.ts). */
const NOT_OURS = new Set(["auth:signIn", "auth:signOut", "auth:isAuthenticated", "auth:store"]);

/**
 * Tables a live (subscribed) query must not read (post-Phase-5 plan 2.5), with the functions
 * allowed to by design and why.
 */
const NEVER_SUBSCRIBE = ["deviceLiveness", "desiredBodies", "desiredStates", "rateLimits", "authRefreshTokens", "employeeLockouts"];
const SUBSCRIBE_EXCEPTIONS: Record<string, string[]> = {
  // The single watched row of a device page, and the <= 60 s "Check now" result.
  "fleet:liveness": ["deviceLiveness"],
  "fleet:checkResult": ["deviceLiveness"],
  // One lockout row of one employee on the employee's own page.
  "employees:get": ["employeeLockouts"],
  // The agent's own Phase 2 subscription (an alias of the signed head): reads the newest body once per new head,
  // or the Phase 2 `desiredStates` row of a device that has no head yet. Not a dashboard screen.
  "devices:desiredState": ["desiredBodies", "desiredStates"],
};

/**
 * Public actions whose matrix row stops at an early refusal (the matrix only proves who may call):
 * these calls run to completion, so the row measures the internal queries and mutations they reach.
 * Other actions stay ESTIMATE in `ioBudgets.ts` (they need WebAuthn, Convex Auth's own credentials
 * or an Argon2 PIN hash), built from the internal rows measured below.
 */
const COMPLETE_CALLS: Record<string, (f: Fixture) => Promise<() => Promise<unknown>>> = {
  "employees:setPassword": async (f) => () => f.accessor.admin.action(api.employees.setPassword, { employeeId: f.employeeId, password: "12345678" }),
  // Phase 5 Step 10: the Owner moves the deployment key into the organization's own keys (a throwaway master key is set).
  "keys:migrateFromEnv": async (f) => {
    setMaster(MASTER_A);
    return () => f.accessor.owner.action(api.keys.migrateFromEnv, {});
  },
  "account:redeemPinReset": async (f) => {
    const m = await asMember(f.t, { role: "viewer", orgId: f.orgId }); // a session created just now is "fresh"
    await f.t.run((ctx) =>
      ctx.db.insert("pinResets", { userId: m.userId, tokenHash: sha256HexSync("io-token"), createdAt: Date.now(), expiresAt: Date.now() + 1_800_000 }),
    );
    return () => m.as.action(api.account.redeemPinReset, { token: "io-token", newPin: "731942" });
  },
};

/** The caller whose call reaches the handler: the first of admin / owner / viewer that the matrix lets in, else the owner. */
function callerFor(row: Row): Caller {
  return (["admin", "owner", "viewer"] as const).find((c) => expectedFor(row, c) === "ok") ?? "owner";
}

describe("I/O budgets (plan Step 18 item 9)", () => {
  // Recovery codes need the server pepper (lib/recoveryCodes.ts), as in the matrix.
  // Scheduled functions (publish runs, mail, follow-up batches) must not run inside the probe window:
  // they belong to other functions, and the probe is global. Fake timers keep them queued; the
  // fixture's own are drained before the probe, the call's own are never run.
  beforeEach(() => {
    process.env.RULEBOX_RECOVERY_PEPPER = "io-budget-test-recovery-pepper-0123456789";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RULEBOX_RECOVERY_PEPPER;
    setMaster(undefined); // `keys:migrateFromEnv` runs complete with a throwaway master key
  });

  test("every public AND internal function has a row, and every row names one", async () => {
    const pub = await publicFunctions();
    const internal = await internalFunctions();
    expect([...pub.keys()].filter((n) => internal.has(n))).toEqual([]);
    const fns = new Map([...pub, ...internal]);
    const names = [...fns.keys()].filter((n) => !NOT_OURS.has(n));
    expect(names.filter((n) => IO_BUDGETS[n] === undefined)).toEqual([]);
    expect(Object.keys(IO_BUDGETS).filter((n) => !fns.has(n))).toEqual([]);
    // Every internal function is either run below or has a reason it is not; no stale entries.
    expect([...internal.keys()].filter((n) => !NOT_OURS.has(n) && INTERNAL_CALLS[n] === undefined && UNMEASURED[n] === undefined)).toEqual([]);
    expect([...Object.keys(INTERNAL_CALLS), ...Object.keys(UNMEASURED)].filter((n) => !internal.has(n))).toEqual([]);
    expect(Object.keys(UNMEASURED).filter((n) => INTERNAL_CALLS[n] !== undefined)).toEqual([]);
    // A subscribed function is a query (a mutation or action cannot be subscribed).
    expect(Object.entries(IO_BUDGETS).filter(([n, b]) => b.live === true && fns.get(n)?.isQuery !== true).map(([n]) => n)).toEqual([]);
    // A function without writes in its budget is not a mutation, and one with writes is not a query.
    expect(Object.entries(IO_BUDGETS).filter(([n, b]) => fns.get(n)?.isQuery === true && b.maxWrites > 0).map(([n]) => n)).toEqual([]);
  });

  const rows = ROWS.filter((r) => !NOT_OURS.has(r.name));
  test.each(rows.map((r) => [r.name, r] as const))(
    "%s stays within its budget on the large-org fixture",
    async (name, row) => {
      const budget = IO_BUDGETS[name];
      const f = await fixture();
      await seedLargeOrg(f.t, f.orgId, LARGE);
      // A second organization with data of its own (identical names): nothing of it may be read.
      await seedLargeOrg(f.t, await makeOrg(f.t, "Second"), { devices: 20, employees: 30, apps: 5, groups: 3, audit: 50 });

      await f.t.finishAllScheduledFunctions(vi.runAllTimers); // the fixture's own follow-ups (publish runs, ...)
      const device = DEVICE_CALLS[name] ?? COMPLETE_CALLS[name];
      const run = device !== undefined ? await device(f) : () => row.call(f.accessor[callerFor(row)], f);
      const { result, io } = await probe(() => outcome(run()));

      if (process.env.IO_REPORT !== undefined) {
        // `IO_REPORT=1`: print what every function measured (to write honest rows).
        console.log(`IO ${name} [${result.result}] reads ${io.reads}/${budget?.maxReads} ${io.readBytes}/${budget?.maxReadBytes}B writes ${io.writes}/${budget?.maxWrites} ${io.writeBytes}/${budget?.maxWriteBytes}B tables ${[...io.tables].join(",")}`);
      }
      expect(budget, `${name} needs a row in convex/ioBudgets.ts`).toBeDefined();
      const b = budget!;
      expect({ reads: io.reads <= b.maxReads, readBytes: io.readBytes <= b.maxReadBytes, writes: io.writes <= b.maxWrites, writeBytes: io.writeBytes <= b.maxWriteBytes }, `${name}: reads ${io.reads}/${b.maxReads}, ${io.readBytes}/${b.maxReadBytes} B, writes ${io.writes}/${b.maxWrites}, ${io.writeBytes}/${b.maxWriteBytes} B (${result.result})`).toEqual({
        reads: true,
        readBytes: true,
        writes: true,
        writeBytes: true,
      });

      if (b.live === true) {
        const allowed = SUBSCRIBE_EXCEPTIONS[name] ?? [];
        const touched = NEVER_SUBSCRIBE.filter((tbl) => io.tables.has(tbl) && !allowed.includes(tbl));
        expect(touched, `${name} is subscribed but reads a never-subscribe table`).toEqual([]);
      }
    },
    60_000,
  );
});

describe("I/O budgets: internal functions", () => {
  // Mail is mocked (an internal action sends through `fetch`), the recovery pepper and the platform
  // master key are the tests' own, and the `testing:*` guard is open for the run.
  beforeEach(() => {
    process.env.RULEBOX_RECOVERY_PEPPER = "io-budget-test-recovery-pepper-0123456789";
    process.env.RULEBOX_ALLOW_TEST_SEED = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RULEBOX_RECOVERY_PEPPER;
    delete process.env.RULEBOX_ALLOW_TEST_SEED;
    delete process.env.RULEBOX_PLATFORM_KEY;
    // Phase 5 Step 10: the cases that need the keyring set a throwaway master key.
    setMaster(undefined);
    vi.unstubAllGlobals();
  });

  const cases = Object.entries(INTERNAL_CALLS).flatMap(([name, c]) =>
    (Array.isArray(c) ? c : [c]).map((fn: InternalCase, i, all) => [all.length > 1 ? `${name} #${i + 1}` : name, name, fn] as const),
  );
  test.each(cases)(
    "%s stays within its budget on the large-org fixture",
    async (_label, name, setup) => {
      const budget = IO_BUDGETS[name];
      const f = await fixture();
      await seedLargeOrg(f.t, f.orgId, LARGE);
      await seedLargeOrg(f.t, await makeOrg(f.t, "Second"), { devices: 20, employees: 30, apps: 5, groups: 3, audit: 50 });
      const env = await internalEnv(f);
      await f.t.finishAllScheduledFunctions(vi.runAllTimers); // the fixture's own follow-ups (publish runs, ...)
      const run = await setup(env);
      const { result, io } = await probe(() => outcome(run()));
      // The call's own follow-ups (mail, next batch) stay queued: they are other functions' rows.

      if (process.env.IO_REPORT !== undefined) {
        console.log(`IO ${_label} [${result.result}] reads ${io.reads}/${budget?.maxReads} ${io.readBytes}/${budget?.maxReadBytes}B writes ${io.writes}/${budget?.maxWrites} ${io.writeBytes}/${budget?.maxWriteBytes}B tables ${[...io.tables].join(",")}`);
      }
      // The call must really do its work (a refusal would measure the guard, not the function).
      expect(result.result, `${_label} did not run to completion`).toMatch(/^(ok|kind:(check|done|go))$/);
      expect(budget, `${name} needs a row in convex/ioBudgets.ts`).toBeDefined();
      const b = budget!;
      expect({ reads: io.reads <= b.maxReads, readBytes: io.readBytes <= b.maxReadBytes, writes: io.writes <= b.maxWrites, writeBytes: io.writeBytes <= b.maxWriteBytes }, `${_label}: reads ${io.reads}/${b.maxReads}, ${io.readBytes}/${b.maxReadBytes} B, writes ${io.writes}/${b.maxWrites}, ${io.writeBytes}/${b.maxWriteBytes} B`).toEqual({
        reads: true,
        readBytes: true,
        writes: true,
        writeBytes: true,
      });
    },
    120_000,
  );
});
