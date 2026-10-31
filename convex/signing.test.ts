import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { makeOrg } from "../tests/convex/identity";
import {
  insertKeyRow,
  RFC8032_TEST1_PUBLIC_HEX,
  RFC8032_TEST1_SIG_HEX,
  setSeeds,
  TEST_KEY,
  TEST_KEY_2,
  TEST_SEED_2_B64,
  TEST_SEED_B64,
} from "../tests/convex/keys";
import { base64Decode, base64Encode } from "./lib/crypto";
import {
  decodeKey32,
  endorsementMessage,
  envPublicKey,
  fingerprintOf,
  keyIdOf,
  loadOrgSigningKey,
  signPayload,
  verifyPayload,
} from "./lib/signing";

// Ed25519 signing (plan 4.5, Step 8 items 1 and 9). Only the published RFC
// 8032 test keys are used (tests/convex/keys.ts).

afterEach(() => setSeeds(TEST_SEED_B64));

function flip(text: string, at: number): string {
  const c = text.charCodeAt(at);
  return text.slice(0, at) + String.fromCharCode(c ^ 1) + text.slice(at + 1);
}

function flipSignatureByte(sigB64: string, index: number): string {
  const bytes = base64Decode(sigB64)!;
  bytes[index] = bytes[index]! ^ 0x01;
  return base64Encode(bytes);
}

describe("primitives", () => {
  test("RFC 8032 7.1 test 1: public key and the signature of the empty message", () => {
    expect(bytesToHex(TEST_KEY.publicKey)).toBe(RFC8032_TEST1_PUBLIC_HEX);
    expect(bytesToHex(base64Decode(signPayload("", TEST_KEY.seed))!)).toBe(RFC8032_TEST1_SIG_HEX);
    expect(verifyPayload("", base64Encode(hexToBytes(RFC8032_TEST1_SIG_HEX)), TEST_KEY.publicKey)).toBe(true);
  });

  test("key id = first 16 hex of SHA-256 of the raw public key; fingerprint in groups of 4", () => {
    expect(keyIdOf(TEST_KEY.publicKey)).toBe("21fe31dfa154a261");
    expect(TEST_KEY.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf("21fe31dfa154a261")).toBe("21fe 31df a154 a261");
  });

  test("sign / verify round trip; a flipped byte in payload or signature, or another key, fails", () => {
    const payload = '{"format":"rulebox.desired/2","doc":{"kioskEnabled":true}}';
    const sig = signPayload(payload, TEST_KEY.seed);
    expect(base64Decode(sig)).toHaveLength(64);
    expect(signPayload(payload, TEST_KEY.seed)).toBe(sig); // deterministic
    expect(verifyPayload(payload, sig, TEST_KEY.publicKey)).toBe(true);
    for (let i = 0; i < payload.length; i += 7) expect(verifyPayload(flip(payload, i), sig, TEST_KEY.publicKey)).toBe(false);
    for (const i of [0, 31, 32, 63]) expect(verifyPayload(payload, flipSignatureByte(sig, i), TEST_KEY.publicKey)).toBe(false);
    expect(verifyPayload(payload, sig, TEST_KEY_2.publicKey)).toBe(false);
    expect(verifyPayload(payload, signPayload(payload, TEST_KEY_2.seed), TEST_KEY.publicKey)).toBe(false);
  });

  test("malformed signatures and keys are false, never a throw", () => {
    const payload = "x";
    expect(verifyPayload(payload, "", TEST_KEY.publicKey)).toBe(false);
    expect(verifyPayload(payload, "not base64!", TEST_KEY.publicKey)).toBe(false);
    expect(verifyPayload(payload, base64Encode(new Uint8Array(63)), TEST_KEY.publicKey)).toBe(false);
    expect(verifyPayload(payload, signPayload(payload, TEST_KEY.seed), new Uint8Array(31))).toBe(false);
    expect(verifyPayload(payload, base64Encode(new Uint8Array(64)), new Uint8Array(32))).toBe(false);
  });

  test("strict base64: one spelling per value", () => {
    for (const n of [0, 1, 2, 3, 31, 32, 64]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff);
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    }
    expect(base64Encode(TEST_KEY.publicKey)).toBe(TEST_KEY.publicKeyB64);
    expect(base64Decode("QQ")).toBeNull(); // no padding
    expect(base64Decode("QR==")).toBeNull(); // non-zero trailing bits
    expect(base64Decode("Q===")).toBeNull();
    expect(base64Decode("QQ==")).toEqual(new Uint8Array([0x41]));
    expect(decodeKey32(TEST_SEED_B64)).toEqual(TEST_KEY.seed);
    expect(decodeKey32("AAAA")).toBeNull();
  });

  test("endorsement message format; it verifies with the endorsing key only", () => {
    const msg = endorsementMessage(TEST_KEY_2.keyId, TEST_KEY_2.publicKeyB64);
    expect(msg).toBe(`rulebox.key-endorsement/1\n${TEST_KEY_2.keyId}\n${TEST_KEY_2.publicKeyB64}`);
    const sig = signPayload(msg, TEST_KEY.seed);
    expect(verifyPayload(msg, sig, TEST_KEY.publicKey)).toBe(true);
    expect(verifyPayload(msg, sig, TEST_KEY_2.publicKey)).toBe(false);
  });
});

describe("loadOrgSigningKey (A11: the only signing entry point)", () => {
  test("missing or malformed env seed: missing", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    for (const value of [undefined, "", "AAAA", `${TEST_SEED_B64.slice(0, -2)}`, ` ${TEST_SEED_B64}x`]) {
      setSeeds(value);
      expect(await t.run((ctx) => loadOrgSigningKey(ctx, orgId, "active"))).toEqual({ ok: false, reason: "missing" });
    }
    setSeeds(TEST_SEED_B64);
    expect(await t.run((ctx) => loadOrgSigningKey(ctx, orgId, "next"))).toEqual({ ok: false, reason: "missing" });
  });

  test("the env key must be this organization's key in that status, else mismatch", async () => {
    const t = await setupAuth();
    const registered = await makeOrg(t, "A");
    const without = await makeOrg(t, "B", { noKey: true });
    const retired = await makeOrg(t, "C", { noKey: true });
    await insertKeyRow(t, retired, TEST_KEY, "retired");

    const ok = await t.run(async (ctx) => {
      const r = await loadOrgSigningKey(ctx, registered, "active");
      return r.ok ? { keyId: r.key.keyId } : r;
    });
    expect(ok).toEqual({ keyId: TEST_KEY.keyId });
    for (const orgId of [without, retired]) {
      expect(await t.run((ctx) => loadOrgSigningKey(ctx, orgId, "active"))).toEqual({ ok: false, reason: "mismatch" });
    }
    // Another seed on the deployment: org A's registered key no longer matches.
    setSeeds(TEST_SEED_2_B64);
    expect(await t.run((ctx) => loadOrgSigningKey(ctx, registered, "active"))).toEqual({ ok: false, reason: "mismatch" });
    // The env NEXT key is only usable once registered as `next`.
    setSeeds(TEST_SEED_B64, TEST_SEED_2_B64);
    expect(await t.run((ctx) => loadOrgSigningKey(ctx, registered, "next"))).toEqual({ ok: false, reason: "mismatch" });
    await insertKeyRow(t, registered, TEST_KEY_2, "next");
    expect(await t.run(async (ctx) => (await loadOrgSigningKey(ctx, registered, "next")).ok)).toBe(true);
  });

  test("a SigningKey never shows its seed when logged or serialized by mistake", () => {
    const text = JSON.stringify(TEST_KEY) + String(Object.keys(TEST_KEY)) + JSON.stringify({ ...TEST_KEY });
    expect(text.includes("seed")).toBe(false);
    expect(text.includes(TEST_SEED_B64)).toBe(false);
    expect(TEST_KEY.seed).toHaveLength(32); // still usable by the signer
  });

  test("envPublicKey hands out the public half only", () => {
    setSeeds(TEST_SEED_B64, TEST_SEED_2_B64);
    const active = envPublicKey("active");
    expect(active).toEqual({ keyId: TEST_KEY.keyId, publicKey: TEST_KEY.publicKeyB64 });
    const text = JSON.stringify([active, envPublicKey("next")]);
    expect(text.includes(TEST_SEED_B64)).toBe(false);
    expect(text.includes(TEST_SEED_2_B64)).toBe(false);
    setSeeds(undefined);
    expect(envPublicKey("active")).toBeNull();
  });
});
