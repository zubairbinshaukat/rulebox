// scripts/policy-key.mjs (plan Phase 4 Step 8). Node environment. Uses only
// the published RFC 8032 test seed and throwaway keys in a temporary folder
// that is deleted afterwards.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { generateSeed, keyInfoOfSeed, main } from "./policy-key.mjs";

const RFC8032_TEST1_SEED_B64 = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex").toString("base64");

let dir = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function run(argv) {
  const lines = [];
  const code = main(argv, (l) => lines.push(l), (l) => lines.push(l));
  return { code, text: lines.join("\n") };
}

describe("policy-key.mjs", () => {
  test("key id and public key of the RFC 8032 test 1 seed (same as convex/lib/signing.ts)", () => {
    expect(keyInfoOfSeed(RFC8032_TEST1_SEED_B64)).toEqual({
      keyId: "21fe31dfa154a261",
      publicKey: Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex").toString("base64"),
    });
  });

  test("malformed seeds are refused", () => {
    expect(() => keyInfoOfSeed("AAAA")).toThrow();
    expect(() => keyInfoOfSeed(Buffer.alloc(31).toString("base64"))).toThrow();
    expect(() => keyInfoOfSeed(`${RFC8032_TEST1_SEED_B64.slice(0, -1)}!`)).toThrow();
  });

  test("generate writes only the seed, prints the public half, never the seed, and never overwrites", () => {
    dir = mkdtempSync(join(tmpdir(), "rulebox-policy-key-test-"));
    const path = join(dir, "policy-key.seed");
    const first = run(["generate", "--out", path]);
    expect(first.code).toBe(0);
    const content = readFileSync(path, "utf8");
    expect(content).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    const seed = content.trim();
    expect(first.text.includes(seed)).toBe(false);
    const info = keyInfoOfSeed(seed);
    expect(first.text).toContain(info.keyId);
    expect(first.text).toContain(info.publicKey);

    const again = run(["generate", "--out", path]);
    expect(again.code).toBe(1);
    expect(again.text).toContain("refusing to overwrite");
    expect(readFileSync(path, "utf8")).toBe(content);

    const pub = run(["public", "--in", path]);
    expect(pub.code).toBe(0);
    expect(pub.text).toContain(info.keyId);
    expect(pub.text.includes(seed)).toBe(false);
  });

  test("two generated seeds differ; usage errors exit 2", () => {
    expect(generateSeed()).not.toBe(generateSeed());
    expect(run([]).code).toBe(2);
    expect(run(["generate"]).code).toBe(2);
    expect(run(["public"]).code).toBe(2);
  });
});
