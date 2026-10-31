#!/usr/bin/env node
// Policy signing key helper (plan Phase 4, Section 4.5). Run by the Owner, on
// their own machine, once per key:
//
//   node scripts/policy-key.mjs generate --out .tmp/policy-key.seed
//   node scripts/policy-key.mjs public   --in  .tmp/policy-key.seed
//
// `generate` makes a new Ed25519 key with Node's crypto
// (`generateKeyPairSync("ed25519")`), writes ONLY the standard-base64 32-byte
// seed (one line) to the file, refuses to overwrite an existing file, and
// prints the key id and the public key, NEVER the seed. `public` prints the
// key id and public key of an existing seed file.
//
// Then: set the file's only line as the deployment's RULEBOX_POLICY_KEY (or
// RULEBOX_POLICY_KEY_NEXT for a rotation), delete the file, and register the
// key in the dashboard (Settings -> Signing). The seed must never be
// committed, pasted into a chat or logged.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** base64url (JWK) -> standard base64 with padding. */
function b64urlToB64(text) {
  return Buffer.from(text, "base64url").toString("base64");
}

/** Key id (first 16 hex of SHA-256 of the raw public key) and standard-base64 public key of a seed. */
export function keyInfoOfSeed(seedB64) {
  const seed = Buffer.from(seedB64.trim(), "base64");
  if (seed.length !== 32 || seed.toString("base64") !== seedB64.trim()) {
    throw new Error("the seed must be standard base64 of exactly 32 bytes");
  }
  // PKCS#8 wrapper of a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const pub = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  const raw = Buffer.from(b64urlToB64(pub.export({ format: "jwk" }).x), "base64");
  return { keyId: createHash("sha256").update(raw).digest("hex").slice(0, 16), publicKey: raw.toString("base64") };
}

/** A new random seed (standard base64, 32 bytes). */
export function generateSeed() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return b64urlToB64(privateKey.export({ format: "jwk" }).d);
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** CLI. Returns the process exit code; `out` / `err` receive the lines it prints. */
export function main(argv, out = console.log, err = console.error) {
  const [command] = argv;
  if (command === "generate") {
    const path = arg(argv, "--out");
    if (path === undefined) {
      err("usage: node scripts/policy-key.mjs generate --out <file>");
      return 2;
    }
    const seed = generateSeed();
    try {
      // "wx": fail when the file exists (never overwrite a key).
      writeFileSync(path, `${seed}\n`, { flag: "wx", mode: 0o600 });
    } catch (e) {
      err(e?.code === "EEXIST" ? `refusing to overwrite ${path}` : `could not write ${path}`);
      return 1;
    }
    const info = keyInfoOfSeed(seed);
    out(`Wrote the seed to ${path} (keep it secret; delete it after setting the env var).`);
    out(`Key id:     ${info.keyId}`);
    out(`Public key: ${info.publicKey}`);
    return 0;
  }
  if (command === "public") {
    const path = arg(argv, "--in");
    if (path === undefined) {
      err("usage: node scripts/policy-key.mjs public --in <file>");
      return 2;
    }
    let info;
    try {
      info = keyInfoOfSeed(readFileSync(path, "utf8"));
    } catch {
      err(`${path} does not hold a seed (standard base64 of 32 bytes)`);
      return 1;
    }
    out(`Key id:     ${info.keyId}`);
    out(`Public key: ${info.publicKey}`);
    return 0;
  }
  err("usage: node scripts/policy-key.mjs generate --out <file> | public --in <file>");
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
