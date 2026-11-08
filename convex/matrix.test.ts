import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { expectNoSecrets } from "../tests/convex/identity";
import { CALLERS, expectedFor, fixture, outcome, publicFunctions, ROWS, STEP_UP_EXEMPT } from "../tests/convex/matrixRows";
import { MAJOR_ACTIONS } from "./lib/stepUp";
import { modules } from "./test.setup";

declare const process: { env: Record<string, string | undefined> };

describe("authorization matrix (plan 4.6)", () => {
  // Recovery codes need the server pepper (lib/recoveryCodes.ts): `not_ready` without it.
  beforeEach(() => {
    process.env.RULEBOX_RECOVERY_PEPPER = "matrix-test-recovery-pepper-0123456789";
  });
  afterEach(() => {
    delete process.env.RULEBOX_RECOVERY_PEPPER;
  });

  for (const row of ROWS) {
    test(row.name, async () => {
      const f = await fixture();
      const got: Record<string, string> = {};
      const want: Record<string, string> = {};
      for (const caller of CALLERS) {
        const r = await outcome(row.call(f.accessor[caller], f));
        got[caller] = r.result;
        want[caller] = expectedFor(row, caller);
        // Whatever comes back, it never carries a secret (plan 4.7).
        if (row.returnsSecretOnce !== true) expectNoSecrets(r.value, f.storedHashes);
      }
      expect(got).toEqual(want);
    });
  }

  test("every public function has a row (walked from the generated api's modules)", async () => {
    const publicNames = [...(await publicFunctions()).keys()];
    // Convex Auth's own entry points are covered by auth.test.ts.
    const authOwn = ["auth:signIn", "auth:signOut", "auth:isAuthenticated"];
    const covered = new Set([...ROWS.map((r) => r.name), ...authOwn]);
    expect(publicNames.filter((n) => !covered.has(n))).toEqual([]);
    // ...and no row names a function that no longer exists.
    expect(ROWS.map((r) => r.name).filter((n) => !publicNames.includes(n))).toEqual([]);
    expect(new Set(ROWS.map((r) => r.name)).size).toBe(ROWS.length);
    expect(publicNames.length).toBeGreaterThan(15);
  });

  test("every module of the generated api.d.ts was walked", async () => {
    // `api` itself is a Proxy that cannot be enumerated; its type file lists the modules it exposes.
    const raw = import.meta.glob("./_generated/api.d.ts", { query: "?raw", import: "default" });
    const text = (await Object.values(raw)[0]!()) as string;
    const apiModules = [...text.matchAll(/import type \* as (\w+) from "\.\.\/([\w/]+)\.js"/g)].map((m) => m[2]!);
    const loaded = new Set(Object.keys(modules).map((p) => p.replace(/^\.\//, "").replace(/\.[jt]s$/, "")));
    expect(apiModules.length).toBeGreaterThan(20);
    expect(apiModules.filter((m) => !loaded.has(m))).toEqual([]);
    const fns = await publicFunctions();
    const withFunctions = new Set([...fns.keys()].map((n) => n.split(":")[0]));
    // Every non-lib module of the api that exports a public function was reached by the walk.
    for (const m of withFunctions) expect(apiModules, `${m} is missing from api.d.ts (run convex codegen)`).toContain(m);
  });
  // ---- Step-up wiring (plan 4.16): a new function cannot forget it.

  test("every MAJOR_ACTIONS function that exists refuses a step-up older than 5 minutes", async () => {
    const fns = await publicFunctions();
    const existing = Object.entries(MAJOR_ACTIONS)
      .filter(([name, spec]) => spec.when === "always" && fns.has(name))
      .map(([name]) => name);
    expect(existing.length).toBeGreaterThanOrEqual(9);
    for (const name of existing) {
      const row = ROWS.find((r) => r.name === name);
      expect(row, `${name} needs a matrix row`).toBeDefined();
      // The matrix test above runs these expectations against the real functions.
      expect(row!.expect.ownerStale ?? row!.expect.default, name).toBe("step_up_required");
    }
  });

  test("MAJOR_ACTIONS names only real functions, except the Phase 5 ones that do not exist yet", async () => {
    const fns = await publicFunctions();
    const missing = Object.keys(MAJOR_ACTIONS).filter((n) => !fns.has(n)).sort();
    // Pinned: a typo or a rename of a major action fails here instead of silently dropping its step-up.
    expect(missing).toEqual(["fleet:lock", "fleet:unlock", "lockdown:update"]);
    for (const [name, spec] of Object.entries(MAJOR_ACTIONS)) {
      const fn = fns.get(name);
      if (fn === undefined) continue;
      // A major action is a write (mutation or action), never a query.
      expect(fn.isQuery, name).not.toBe(true);
      const row = ROWS.find((r) => r.name === name);
      expect(row, `${name} needs a matrix row`).toBeDefined();
      // Never usable with the step-up of an idle (locked) session, whatever the role.
      if (spec.when === "always") expect(row!.expect.ownerIdle ?? row!.expect.default, `${name} idle`).toBe("step_up_required");
    }
  });

  test("every other member write needs an unlocked session", async () => {
    const fns = await publicFunctions();
    for (const [name, fn] of fns) {
      if (fn.isQuery === true || STEP_UP_EXEMPT.has(name) || name.startsWith("auth:")) continue;
      const row = ROWS.find((r) => r.name === name);
      expect(row, `${name} needs a matrix row`).toBeDefined();
      expect(row!.expect.ownerIdle ?? row!.expect.default, name).toBe("step_up_required");
    }
  });

  test("a `major:` name is the function's own file:name and is in MAJOR_ACTIONS", async () => {
    const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default" });
    let seen = 0;
    for (const [path, load] of Object.entries(sources)) {
      if (path.includes(".test.")) continue;
      const file = path.replace(/^\.\//, "").replace(/\.ts$/, "");
      const text = (await load()) as string;
      for (const m of text.matchAll(/export const (\w+) = member(?:Mutation|Action|Query)\([^)]*major:\s*"([^"]+)"/g)) {
        seen++;
        expect(m[2], `${file}:${m[1]}`).toBe(`${file}:${m[1]}`);
        expect(Object.keys(MAJOR_ACTIONS)).toContain(m[2]);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(9);
  });
});



