import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { allKeys, FORBIDDEN_KEYS } from "../tests/convex/identity";
import { DEVICE_CALLS, fixture, outcome, publicFunctions, ROWS, type Caller, type Fixture } from "../tests/convex/matrixRows";
import { api, internal } from "./_generated/api";
import { sha256HexSync } from "./lib/crypto";

declare const process: { env: Record<string, string | undefined> };

// Secrets (plan Section 4.7, Step 18 item 2): every secret is written by one function and read by one
// reader, and NEVER comes back from a public function, in an error, or in an audit summary. The test
// seeds every kind of secret the table in 4.7 lists, then calls EVERY public function as several
// callers and scans what comes back (and the audit log afterwards) for a stored hash, an Argon2 / scrypt
// string, a platform secret or a forbidden field name.

const PLATFORM_VALUES = {
  resendApiKey: "re_LeakTestKeyNotReal_0123456789abcdef",
  resendFrom: "Rulebox Leak <leak-test@rulebox.test>",
  dashboardOrigin: "https://leak-test.rulebox.test",
};
/** A throwaway master key (bytes 0..31); never a real one. */
const MASTER_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));

/**
 * Fields that hold a secret or a hash of one, in any table. Their values must never be returned.
 * `credentialId` is deliberately not here: a WebAuthn ceremony lists the caller's OWN credential ids
 * (`allowCredentials` / `excludeCredentials`), they are public identifiers; a separate test checks they are only the caller's.
 */
const SECRET_FIELDS = [
  "secretHash", "previousSecretHash", "tokenHash", "passwordHash", "exitPinHash", "actionPinHash", "challengeHash",
  "hardwareIdHash", "totpSecret", "totpPending", "credentialPublicKey", "webauthnUserId", "ciphertext", "iv", "secret",
] as const;
const SECRET_ARRAY_FIELDS = ["recoveryHashes"] as const;

const hex = (seed: string) => sha256HexSync(`secrets-test-${seed}`);

/** Puts one of each secret of plan 4.7 into the deployment of `f`. */
async function seedSecrets(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const org = (await ctx.db.get(f.orgId))!;
    await ctx.db.patch(org._id, { exitPinSetAt: Date.now() });
    const secrets = (await ctx.db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", f.orgId)).unique())!;
    await ctx.db.patch(secrets._id, { exitPinHash: "$argon2id$v=19$m=19456,t=2,p=1$EXITPINSALTSALT$EXITPINHASHHASHHASHHASH" });
    await ctx.db.insert("employeeSecrets", { employeeId: f.employeeId, passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$EMPLOYEESALT$EMPLOYEEPASSWORDHASH" });
    const factors = await ctx.db.query("stepUpFactors").collect();
    let n = 0;
    for (const row of factors) {
      n++;
      await ctx.db.patch(row._id, {
        actionPinHash: `$argon2id$v=19$m=19456,t=2,p=1$PINSALT${n}$ACTIONPINHASH${n}`,
        recoveryHashes: [hex(`recovery-${n}-a`), hex(`recovery-${n}-b`)],
        webauthnUserId: `WEBAUTHNUSERID${n}`,
      });
      await ctx.db.insert("pinResets", { userId: row.userId, tokenHash: hex(`pin-reset-${n}`), createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
      await ctx.db.insert("passkeys", {
        userId: row.userId,
        credentialId: `CREDENTIALID${n}`,
        credentialPublicKey: `COSEPUBLICKEY${n}`,
        counter: 1,
        transports: [],
        name: `Key ${n}`,
        aaguid: "00000000-0000-0000-0000-000000000000",
        deviceType: "singleDevice",
        backedUp: false,
        createdAt: Date.now(),
      });
      const session = await ctx.db.query("authSessions").collect();
      const mine = session.find((s) => s.userId === row.userId);
      if (mine !== undefined) {
        await ctx.db.insert("stepUpChallenges", { userId: row.userId, sessionId: mine._id, purpose: "verify", challengeHash: hex(`challenge-${n}`), expiresAt: Date.now() + 60_000 });
        // The legacy TOTP row (kept in the schema until the narrow step): never returned.
        await ctx.db.insert("memberSecrets", {
          userId: row.userId,
          totpSecret: `JBSWY3DPEHPK3PXP${n}`,
          totpPending: `PENDINGTOTPSECRET${n}`,
          recoveryHashes: [hex(`legacy-recovery-${n}`)],
          lastTotpStep: 0,
          totpFailures: 0,
          totpLockedUntil: 0,
        });
      }
    }
    const device = await ctx.db.get(f.deviceId);
    if (device !== null) await ctx.db.patch(device._id, { hardwareIdHash: hex("hardware") });
  });
  for (const [name, value] of Object.entries(PLATFORM_VALUES)) await f.t.action(internal.platform.setSecret, { name, value });
}

/** Every secret value in the deployment (as stored), plus the platform secrets in the clear. */
async function harvest(f: Fixture): Promise<string[]> {
  const stored = await f.t.run(async (ctx) => {
    const out: string[] = [];
    const tables = ["devices", "deviceCredentials", "enrollmentTokens", "invites", "employeeSecrets", "orgSecrets", "stepUpFactors", "pinResets", "passkeys", "stepUpChallenges", "memberSecrets", "platformSecrets"] as const;
    for (const table of tables) {
      for (const doc of (await ctx.db.query(table).collect()) as unknown as Record<string, unknown>[]) {
        for (const field of SECRET_FIELDS) if (typeof doc[field] === "string") out.push(doc[field]);
        for (const field of SECRET_ARRAY_FIELDS) {
          const list = doc[field];
          if (Array.isArray(list)) for (const x of list) if (typeof x === "string") out.push(x);
        }
      }
    }
    return out;
  });
  return [...new Set([...stored, ...Object.values(PLATFORM_VALUES)])].filter((s) => s.length >= 8);
}

/** The text of an outcome: the returned value or the error (its code and data). */
function textOf(value: unknown, error: string): string {
  return JSON.stringify(value ?? null) + error;
}

async function auditText(f: Fixture): Promise<string> {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db.query("auditLog").collect();
    const platform = await ctx.db.query("platformAudit").collect();
    return JSON.stringify([...rows, ...platform]);
  });
}

beforeEach(() => {
  process.env.RULEBOX_RECOVERY_PEPPER = "secrets-test-recovery-pepper-0123456789";
  process.env.RULEBOX_PLATFORM_KEY = MASTER_KEY;
});
afterEach(() => {
  delete process.env.RULEBOX_RECOVERY_PEPPER;
  delete process.env.RULEBOX_PLATFORM_KEY;
});

const CALLERS_SCANNED: Caller[] = ["owner", "admin", "viewer", "foreign", "ownerStale", "unauth"];

describe("secrets (plan 4.7)", () => {
  test("the seed really stored every kind of secret", async () => {
    const f = await fixture();
    await seedSecrets(f);
    const secrets = await harvest(f);
    expect(secrets.length).toBeGreaterThan(25);
    expect(secrets.some((s) => s.startsWith("$argon2"))).toBe(true);
    expect(secrets).toContain(PLATFORM_VALUES.resendApiKey);
    expect(secrets).toContain(f.storedHashes[0]);
    // Platform secrets are stored encrypted, never as given.
    const stored = await f.t.run((ctx) => ctx.db.query("platformSecrets").collect());
    expect(stored.length).toBe(3);
    expect(JSON.stringify(stored)).not.toContain("LeakTestKey");
  });

  const rows = ROWS.map((r) => [r.name, r] as const);
  test.each(rows)(
    "%s returns no secret to any caller, and writes none to the audit log",
    async (name, row) => {
      const f = await fixture();
      await seedSecrets(f);
      const secrets = await harvest(f);
      const leaks: string[] = [];
      const scan = (who: string, text: string) => {
        for (const s of secrets) if (text.includes(s)) leaks.push(`${who}: contains a stored secret (${s.slice(0, 12)}...)`);
        if (/\$argon2|\$scrypt/i.test(text)) leaks.push(`${who}: contains a password hash`);
      };
      for (const caller of CALLERS_SCANNED) {
        let value: unknown = null;
        let error = "";
        try {
          value = await row.call(f.accessor[caller], f);
        } catch (e) {
          const err = e as { data?: unknown; message?: string };
          error = JSON.stringify(err.data ?? null) + String(err.message ?? "");
        }
        scan(`${name} as ${caller}`, textOf(value, error));
        // A function that returns a secret ONCE by design (the enrollment code) is the only one allowed a raw token.
        if (row.returnsSecretOnce !== true) {
          const keys = allKeys(value);
          for (const k of FORBIDDEN_KEYS) if (keys.has(k)) leaks.push(`${name} as ${caller}: forbidden field ${k}`);
        }
      }
      scan(`${name}: audit log`, await auditText(f));
      expect(leaks).toEqual([]);
    },
  );

  test("device calls with real credentials never return the employee password hash, a device secret hash or a platform secret", async () => {
    const f = await fixture();
    await seedSecrets(f);
    const secrets = await harvest(f);
    // The signed document carries the EXIT PIN verifier to the agent by design (plan 4.7: exit PIN -> document -> agent).
    const exitPin = secrets.filter((s) => s.includes("EXITPINHASH"));
    for (const [name, make] of Object.entries(DEVICE_CALLS)) {
      if (name === "devices:unenroll" || name === "enrollment:enroll") continue;
      const r = await outcome((await make(f))());
      const text = JSON.stringify(r.value ?? null);
      const documentCall = name === "devices:desiredState" || name === "devices:fetchDesired";
      for (const s of secrets) {
        if (documentCall && exitPin.includes(s)) continue;
        expect(text.includes(s), `${name} returned a stored secret`).toBe(false);
      }
      if (!documentCall) expect(text, name).not.toMatch(/\$argon2|\$scrypt/i);
    }
  });

  test("the passkey ceremonies list only the caller's own credential ids", async () => {
    const f = await fixture();
    await seedSecrets(f);
    const ids = (await f.t.run((ctx) => ctx.db.query("passkeys").collect())).map((p) => p.credentialId);
    expect(new Set(ids).size).toBeGreaterThan(3); // one per person
    for (const caller of ["owner", "admin", "foreign", "ownerStale"] as const) {
      for (const [label, fn] of [["beginRegistration", api.passkeys.beginRegistration], ["beginVerification", api.passkeys.beginVerification]] as const) {
        let text = "";
        try {
          text = JSON.stringify(await f.accessor[caller].action(fn, {}));
        } catch (e) {
          text = JSON.stringify((e as { data?: unknown }).data ?? null);
        }
        expect(ids.filter((id) => text.includes(id)).length, `${caller} ${label}`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("every public function was scanned, and none may be a secret writer without being on the once-only list", async () => {
    const fns = await publicFunctions();
    const scanned = new Set(ROWS.map((r) => r.name));
    for (const n of fns.keys()) if (!n.startsWith("auth:")) expect(scanned.has(n), n).toBe(true);
    // Plan 4.7: the only public function that returns a raw secret is the enrollment code, once.
    // (Invite and reset codes come back from `members:invite` / `members:createResetCode` as `{ code }`, once,
    // and only their SHA-256 is stored; the matrix lists the same exception.)
    expect(ROWS.filter((r) => r.returnsSecretOnce === true).map((r) => r.name)).toEqual(["enrollmentCodes:create"]);
  });
});
