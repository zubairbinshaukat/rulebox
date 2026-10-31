// The committed signing vectors (plan Phase 4 Step 8 item 7), checked with Node's
// OpenSSL Ed25519 only: no @noble/ed25519, no Convex code. If the TypeScript
// signer and a second, independent implementation ever disagree about a
// committed vector, this fails. Node environment.

import { spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "crates", "rulebox-policy", "tests", "vectors");
const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
function valid(publicKeyB64, text, signatureB64) {
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyB64, "base64")]), format: "der", type: "spki" });
  return verify(null, Buffer.from(text, "utf8"), key, Buffer.from(signatureB64, "base64"));
}

describe("policy vectors under OpenSSL Ed25519", () => {
  test("signed-v2.json: document, unicode document and endorsement verify", () => {
    const v = read("signed-v2.json");
    expect(valid(v.publicKey, v.payload, v.signature)).toBe(true);
    expect(valid(v.publicKey, v.unicode.payload, v.unicode.signature)).toBe(true);
    expect(valid(v.publicKey, v.endorsement.message, v.endorsement.signature)).toBe(true);
    // The unicode payload really is multi-byte UTF-8 with JSON escapes.
    expect(Buffer.byteLength(v.unicode.payload, "utf8")).toBeGreaterThan(v.unicode.payload.length);
    expect(v.unicode.payload).toContain("\\u0001");
    // The signature is over the bytes: the same text with a different Unicode form does not verify.
    expect(valid(v.publicKey, v.unicode.payload.normalize("NFD"), v.unicode.signature)).toBe(false);
  });

  test("roster-v1.json: entries and snapshot verify", () => {
    const v = read("roster-v1.json");
    for (const e of v.entries) expect(valid(v.publicKey, e.message, e.signature), `epoch ${e.epoch}`).toBe(true);
    expect(valid(v.publicKey, v.snapshot.payload, v.snapshot.signature)).toBe(true);
  });

  test("signed-v2-negative.json: bad_signature cases fail to verify, every other case has a valid signature", () => {
    const v = read("signed-v2-negative.json");
    const [trusted] = v.trustedKeys;
    expect(v.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of v.cases) {
      expect(valid(trusted.publicKey, c.envelope.payload, c.envelope.signature), c.name).toBe(c.reason !== "bad_signature");
    }
    expect(v.cases.filter((c) => c.reason === "bad_signature").map((c) => c.name)).toEqual([
      "flipped_payload_byte",
      "flipped_signature_byte",
      "non_canonical_s",
    ]);
  });
});

describe("gen-policy-vectors.mjs --check", () => {
  test("the committed files are what the real builder produces", () => {
    const r = spawnSync(process.execPath, [join(root, "scripts", "gen-policy-vectors.mjs"), "--check"], { cwd: root, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("signed-v2.json: up to date");
    expect(r.stdout).toContain("signed-v2-negative.json: up to date");
    expect(r.stdout).toContain("roster-v1.json: up to date");
    expect(r.status).toBe(0);
  }, 60_000);
});
