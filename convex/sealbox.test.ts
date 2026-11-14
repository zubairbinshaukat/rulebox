import { afterEach, describe, expect, test } from "vitest";
import sealRaw from "../crates/rulebox-policy/tests/vectors/seal.json?raw";
import { MASTER_A, setMaster } from "../tests/convex/phase5";
import { base64Decode, base64Encode } from "./lib/crypto";
import { masterKeys, openWrappedRow, wrapSecret } from "./lib/keyring";
import type { SealedBoxValue } from "./lib/lockdownValidators";
import { decodeSealPublicKey, decryptAtRest, encryptAtRest, MAX_SEAL_PLAINTEXT, openSealed, sealForDevice, sealKeyIdOf, sealWith } from "./lib/sealbox";

// Sealed boxes `rulebox.seal/1` (Phase 5 Step 10, plan 4.18): the TypeScript side must produce, byte for byte, what
// `crates/rulebox-policy/tests/vectors/seal.json` pins (the Rust side opens exactly these), and open what Rust seals.

type Case = {
  name: string;
  orgId: string;
  deviceId: string;
  profileId: string;
  plaintext: string;
  ephemeralSecret: string;
  nonceBytes: string;
  box: SealedBoxValue;
};
type Negative = { name: string; reason: string; orgId: string; deviceId: string; profileId: string; box: SealedBoxValue };
const vector = JSON.parse(sealRaw) as {
  deviceSecret: string;
  devicePublic: string;
  keyId: string;
  cases: Case[];
  negative: Negative[];
};
const deviceSecret = base64Decode(vector.deviceSecret)!;
const devicePublic = base64Decode(vector.devicePublic)!;
const ctx = { runAction: null };

afterEach(() => setMaster(undefined));

describe("seal.json (shared with the agent)", () => {
  test("the vector's own key id is the id of the device's public key", () => {
    expect(sealKeyIdOf(devicePublic)).toBe(vector.keyId);
    expect(vector.cases.length).toBeGreaterThanOrEqual(3);
  });

  test.each(vector.cases.map((c) => [c.name, c] as const))("%s: sealing with the vector's randomness gives the committed box, byte for byte", (_n, c) => {
    const box = sealWith({
      plaintext: c.plaintext,
      devicePublic,
      ephemeralSecret: base64Decode(c.ephemeralSecret)!,
      nonce: base64Decode(c.nonceBytes)!,
      ids: { orgId: c.orgId, deviceId: c.deviceId, profileId: c.profileId },
    });
    expect(box).not.toBeNull();
    expect(JSON.stringify(box)).toBe(JSON.stringify(c.box)); // equal values AND the same key order
    // ...and the device's private key opens it (the mirror of the Rust `open_sealed`).
    expect(openSealed(c.box, deviceSecret, { orgId: c.orgId, deviceId: c.deviceId, profileId: c.profileId })).toBe(c.plaintext);
  });

  test.each(vector.negative.map((c) => [c.name, c] as const))("negative %s: the box does not open", (_n, c) => {
    expect(openSealed(c.box, deviceSecret, { orgId: c.orgId, deviceId: c.deviceId, profileId: c.profileId })).toBeNull();
  });

  test("a fresh seal (random ephemeral key and nonce) differs every time, opens, and never shows the plaintext", () => {
    const ids = { orgId: "org_a", deviceId: "dev_a", profileId: "wifi_a" };
    const pub = base64Encode(devicePublic);
    const a = sealForDevice(ctx, "hunter2 hunter2", pub, ids)!;
    const b = sealForDevice(ctx, "hunter2 hunter2", pub, ids)!;
    expect(a.ct).not.toBe(b.ct);
    expect(a.epk).not.toBe(b.epk);
    expect(openSealed(a, deviceSecret, ids)).toBe("hunter2 hunter2");
    expect(JSON.stringify(a)).not.toContain("hunter2");
    // Another org, device or profile id does not open it.
    for (const other of [{ ...ids, orgId: "org_b" }, { ...ids, deviceId: "dev_b" }, { ...ids, profileId: "wifi_b" }]) {
      expect(openSealed(a, deviceSecret, other)).toBeNull();
    }
  });

  test("refusals: an id with `|`, an empty id, a plaintext over the limit, a malformed or low-order device key", () => {
    const pub = base64Encode(devicePublic);
    const ok = { orgId: "o", deviceId: "d", profileId: "p" };
    expect(sealForDevice(ctx, "x", pub, ok)).not.toBeNull();
    expect(sealForDevice(ctx, "x", pub, { ...ok, profileId: "a|b" })).toBeNull();
    expect(sealForDevice(ctx, "x", pub, { ...ok, deviceId: "" })).toBeNull();
    expect(sealForDevice(ctx, "p".repeat(MAX_SEAL_PLAINTEXT + 1), pub, ok)).toBeNull();
    expect(sealForDevice(ctx, "x", base64Encode(new Uint8Array(31)), ok)).toBeNull();
    expect(sealForDevice(ctx, "x", base64Encode(new Uint8Array(32)), ok)).toBeNull();
    // A low-order point (u = 1) would give an all-zero shared secret.
    const lowOrder = new Uint8Array(32);
    lowOrder[0] = 1;
    expect(sealForDevice(ctx, "x", base64Encode(lowOrder), ok)).toBeNull();
    expect(decodeSealPublicKey("not base64 !!")).toBeNull();
  });
});

describe("encryption at rest", () => {
  function sealingKey() {
    setMaster(MASTER_A);
    expect(masterKeys().active).not.toBeNull();
    const wrapped = wrapSecret(ctx, new Uint8Array(32).fill(9), { orgId: "org_a", purpose: "sealing", keyId: "k1k1k1k1k1k1k1k1" })!;
    return openWrappedRow({ ...wrapped, keyId: "k1k1k1k1k1k1k1k1" }, "org_a", "sealing")!;
  }

  test("round trip; the org, profile or revision it was written for is part of the key; the key id must match", () => {
    const key = sealingKey();
    const bind = { orgId: "org_a", profileId: "wifi_a", revision: 3 };
    const box = encryptAtRest(ctx, key, "correct horse", bind);
    expect(box.keyId).toBe("k1k1k1k1k1k1k1k1");
    expect(box.sealed).not.toContain("correct");
    expect(decryptAtRest(key, box, bind)).toBe("correct horse");
    for (const other of [{ ...bind, orgId: "org_b" }, { ...bind, profileId: "wifi_b" }, { ...bind, revision: 4 }]) {
      expect(decryptAtRest(key, box, other)).toBeNull();
    }
    expect(decryptAtRest(key, { ...box, keyId: "another" }, bind)).toBeNull();
    const raw = base64Decode(box.sealed)!;
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(decryptAtRest(key, { ...box, sealed: base64Encode(raw) }, bind)).toBeNull();
    expect(decryptAtRest(key, { ...box, sealed: "AAAA" }, bind)).toBeNull();
  });

  test("two encryptions of the same passphrase differ (a random nonce each time)", () => {
    const key = sealingKey();
    const bind = { orgId: "org_a", profileId: "wifi_a", revision: 1 };
    expect(encryptAtRest(ctx, key, "same", bind).sealed).not.toBe(encryptAtRest(ctx, key, "same", bind).sealed);
  });

  test("the opened key shows no secret in JSON or a log line (non-enumerable)", () => {
    const key = sealingKey();
    expect(JSON.stringify(key)).toBe(JSON.stringify({ keyId: "k1k1k1k1k1k1k1k1", status: "active" }));
    expect(String(Object.keys(key))).not.toContain("secret");
  });
});
