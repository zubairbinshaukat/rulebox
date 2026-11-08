import { afterEach, describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, giveStepUp, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import { base64Encode } from "./lib/crypto";
import { openSecret, platformSecretProblem } from "./lib/platformSecrets";

// Platform secrets (Phase 4b Part C): AES-GCM at rest with the deployment's
// RULEBOX_PLATFORM_KEY, internal-only functions, never in a public answer.

declare const process: { env: Record<string, string | undefined> };

/** A throwaway test master key (bytes 0..31); never a real one. */
const TEST_MASTER_KEY = base64Encode(Uint8Array.from({ length: 32 }, (_, i) => i));
const OTHER_MASTER_KEY = base64Encode(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));

const VALUES = {
  resendApiKey: "re_TestKeyNotReal_0123456789",
  resendFrom: "Rulebox <no-reply@rulebox.test>",
  dashboardOrigin: "https://dashboard.rulebox.test",
};

afterEach(() => {
  delete process.env.RULEBOX_PLATFORM_KEY;
});

async function rowOf(t: T, name: string) {
  return await t.run((ctx) => ctx.db.query("platformSecrets").withIndex("by_name", (q) => q.eq("name", name)).first());
}

async function setAll(t: T) {
  for (const [name, value] of Object.entries(VALUES)) await t.action(internal.platform.setSecret, { name, value });
}

describe("platform secrets", () => {
  test("without the master key nothing can be set and mail is off", async () => {
    const t = await setupAuth();
    await expect(t.action(internal.platform.setSecret, { name: "resendApiKey", value: VALUES.resendApiKey })).rejects.toMatchObject({
      data: { code: "not_ready" },
    });
    expect(await rowOf(t, "resendApiKey")).toBeNull();
    expect(await t.query(internal.platform.status, {})).toMatchObject({ masterKey: false });
    process.env.RULEBOX_PLATFORM_KEY = "not base64 of 32 bytes";
    await expectCode(t.action(internal.platform.setSecret, { name: "resendApiKey", value: VALUES.resendApiKey }), "not_ready");
  });

  test("encryption round trip; the row holds no plaintext; a new IV each time; audited without the value", async () => {
    const t = await setupAuth();
    process.env.RULEBOX_PLATFORM_KEY = TEST_MASTER_KEY;
    await t.action(internal.platform.setSecret, { name: "resendApiKey", value: VALUES.resendApiKey });
    const first = (await rowOf(t, "resendApiKey"))!;
    expect(JSON.stringify(first)).not.toContain(VALUES.resendApiKey);
    expect(await openSecret("resendApiKey", first)).toBe(VALUES.resendApiKey);
    await t.action(internal.platform.setSecret, { name: "resendApiKey", value: VALUES.resendApiKey });
    const second = (await rowOf(t, "resendApiKey"))!;
    expect(second._id).toBe(first._id); // replaced, one row per name
    expect(second.iv).not.toBe(first.iv);
    // The name is bound (additional data): the ciphertext does not open as another name.
    expect(await openSecret("resendFrom", second)).toBeNull();
    // Tampering is detected.
    const flipped = second.ciphertext.startsWith("A") ? "B" + second.ciphertext.slice(1) : "A" + second.ciphertext.slice(1);
    expect(await openSecret("resendApiKey", { ciphertext: flipped, iv: second.iv })).toBeNull();
    // Another master key (or none) opens nothing.
    process.env.RULEBOX_PLATFORM_KEY = OTHER_MASTER_KEY;
    expect(await openSecret("resendApiKey", second)).toBeNull();
    expect((await t.action(internal.platform.checkSecrets, {})).secrets[0]).toMatchObject({ name: "resendApiKey", set: true, decrypts: false });
    delete process.env.RULEBOX_PLATFORM_KEY;
    expect(await openSecret("resendApiKey", second)).toBeNull();
    const log = await t.run((ctx) => ctx.db.query("platformAudit").withIndex("by_at").take(10));
    expect(log.map((r) => r.action)).toEqual(["platform.secretSet", "platform.secretSet"]);
    expect(JSON.stringify(log)).not.toContain(VALUES.resendApiKey);
  });

  test("names are allow-listed and values validated; clear removes one", async () => {
    const t = await setupAuth();
    process.env.RULEBOX_PLATFORM_KEY = TEST_MASTER_KEY;
    await expectCode(t.action(internal.platform.setSecret, { name: "githubToken", value: "x".repeat(20) }), "invalid_argument");
    for (const [name, value] of [
      ["resendApiKey", "has space in it"],
      ["resendApiKey", " re_leading_space_1234"],
      ["resendFrom", "not an address"],
      ["resendFrom", "Name <a@b.c>\r\nBcc: x@y.z"],
      ["dashboardOrigin", "http://dashboard.rulebox.test"],
      ["dashboardOrigin", "https://dashboard.rulebox.test/path"],
    ] as const) {
      await expectCode(t.action(internal.platform.setSecret, { name, value }), "invalid_argument");
    }
    expect(platformSecretProblem("dashboardOrigin", "http://localhost:5173")).toBeNull();
    expect(platformSecretProblem("resendFrom", "no-reply@rulebox.test")).toBeNull();
    await setAll(t);
    const check = await t.action(internal.platform.checkSecrets, {});
    expect(check.masterKey).toBe(true);
    expect(check.secrets.every((s) => s.set && s.decrypts && s.valid)).toBe(true);
    expect(await t.mutation(internal.platform.clearSecret, { name: "resendFrom" })).toBe(true);
    expect(await t.mutation(internal.platform.clearSecret, { name: "resendFrom" })).toBe(false);
    expect((await t.query(internal.platform.status, {})).secrets.find((s) => s.name === "resendFrom")?.set).toBe(false);
    // storeSecret (the CLI's path) refuses a malformed ciphertext or IV.
    await expectCode(t.mutation(internal.platform.storeSecret, { name: "resendFrom", ciphertext: "AAAA", iv: "AAAA" }), "invalid_argument");
  });

  test("never in a public answer: stepUp:status only says whether reset by email is on (account:me says nothing)", async () => {
    const t = await setupAuth();
    process.env.RULEBOX_PLATFORM_KEY = TEST_MASTER_KEY;
    const m = await asMember(t, { role: "owner" });
    await giveStepUp(t, m);
    expect((await m.as.query(api.stepUp.status, {})).pin.resetByEmail).toBe(false);
    await setAll(t);
    const rows = await t.run((ctx) => ctx.db.query("platformSecrets").take(10));
    const secrets = [...Object.values(VALUES), ...rows.flatMap((r) => [r.ciphertext, r.iv])];
    const me = await m.as.query(api.account.me, {});
    // Finding 7: `me` reads no platform row at all, so it does not even say whether mail is on.
    expect(JSON.stringify(me)).not.toContain("resetByEmail");
    expectNoSecrets(me, secrets);
    const status = await m.as.query(api.stepUp.status, {});
    expect(status.pin.resetByEmail).toBe(true);
    expectNoSecrets(status, secrets);
    expectNoSecrets(await m.as.query(api.settings.get, {}), secrets);
    expectNoSecrets(await m.as.query(api.members.page, { paginationOpts: { numItems: 50, cursor: null } }), secrets);
    // Without the master key the flow is off again.
    delete process.env.RULEBOX_PLATFORM_KEY;
    expect((await m.as.query(api.stepUp.status, {})).pin.resetByEmail).toBe(false);
  });

  test("source scan: only the platform modules touch the table, and no public function reads a secret", async () => {
    const sources = {
      ...import.meta.glob("./*.ts", { query: "?raw", import: "default" }),
      ...import.meta.glob("./lib/*.ts", { query: "?raw", import: "default" }),
    };
    const touching: string[] = [];
    for (const [path, load] of Object.entries(sources)) {
      if (path.includes(".test.")) continue;
      const text = (await load()) as string;
      if (/["']platformSecrets["']/.test(text)) touching.push(path);
      // Every reader of a decrypted value is an internal action helper.
      if (/\bgetSecret\(|\bopenSecret\(/.test(text)) {
        expect(["./lib/platformSecrets.ts", "./lib/mail.ts", "./platform.ts", "./account.ts"], path).toContain(path);
      }
    }
    expect(touching.sort()).toEqual(["./lib/platformSecrets.ts", "./platform.ts"]);
  });
});
