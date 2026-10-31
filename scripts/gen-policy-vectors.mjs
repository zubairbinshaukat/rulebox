#!/usr/bin/env node
// Signing test vectors (plan Phase 4 Step 8 item 7, A6).
//
//   node scripts/gen-policy-vectors.mjs           write the vectors
//   node scripts/gen-policy-vectors.mjs --check   exit 1 when a committed vector differs
//
// Builds the fixed input of tests/convex/vectors.ts with the REAL builder
// (convex/lib/desired.ts, roster.ts, signing.ts, loaded with Node's type
// stripping) and signs it with the RFC 8032 section 7.1 TEST 1 seed, a
// published test key that is never used anywhere else. Output:
//
//   crates/rulebox-policy/tests/vectors/signed-v2.json  one signed document + an endorsement
//   crates/rulebox-policy/tests/vectors/roster-v1.json  three roster entries + a snapshot
//
// Deterministic: Ed25519 signatures are deterministic and the PIN hash uses a
// fixed salt, so a second run writes the same bytes. convex/desired.test.ts
// checks the TypeScript side against these files; the agent (Step 9) checks
// the Rust side.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { argon2id } from "hash-wasm";

// The Convex sources import siblings without an extension ("./crypto"), as the
// Convex bundler allows; resolve those to the .ts (or .js) file.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || /\.[cm]?[jt]s$/.test(specifier)) throw error;
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        return next(`${specifier}.js`, context);
      }
    }
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(join(root, rel)).href);

const desired = await load("convex/lib/desired.ts");
const signing = await load("convex/lib/signing.ts");
const roster = await load("convex/lib/roster.ts");
const keys = await load("tests/convex/keys.ts");
const vectors = await load("tests/convex/vectors.ts");

// The PIN hash in the fixed input must be what its fixed salt gives.
const pinHash = await argon2id({
  password: vectors.VECTOR_PIN,
  salt: new TextEncoder().encode(vectors.VECTOR_PIN_SALT),
  memorySize: 19456,
  iterations: 2,
  parallelism: 1,
  hashLength: 32,
  outputType: "encoded",
});
if (pinHash !== vectors.VECTOR_PIN_HASH) throw new Error("VECTOR_PIN_HASH does not match its salt; update tests/convex/vectors.ts");

const key = keys.TEST_KEY;
const next = keys.TEST_KEY_2;
const NOTE =
  "TEST VECTOR. Signed with the RFC 8032 section 7.1 TEST 1 seed (published, not secret). Never trust this key outside tests.";

// ---- signed-v2.json
const { VECTOR_IDS: ids, VECTOR_INPUT: input, VECTOR_VERSION: version, VECTOR_ISSUED_AT_MS: issuedAtMs } = vectors;
const doc = desired.buildDeviceDoc(input, version);
const payload = desired.buildPayload({ keyId: key.keyId, orgId: ids.orgId, deviceId: ids.deviceId, version, issuedAtMs, doc });
const signature = signing.signPayload(payload, key.seed);
if (!signing.verifyPayload(payload, signature, key.publicKey)) throw new Error("self-check failed");
const endorsementMessage = signing.endorsementMessage(next.keyId, next.publicKeyB64);
const signedV2 = {
  note: NOTE,
  publicKey: key.publicKeyB64,
  keyId: key.keyId,
  version,
  payload,
  signature,
  // Additive (for the Step 9 tests): who the document is for, and the head's check values.
  orgId: ids.orgId,
  deviceId: ids.deviceId,
  payloadSha256: bytesToHex(sha256(utf8ToBytes(payload))),
  contentHash: desired.contentHashOf(doc),
  endorsement: {
    keyId: next.keyId,
    publicKey: next.publicKeyB64,
    byKeyId: key.keyId,
    message: endorsementMessage,
    signature: signing.signPayload(endorsementMessage, key.seed),
  },
};

// ---- roster-v1.json
let epoch = 0;
const entries = vectors.ROSTER_VECTOR_CHANGES.map((c) => {
  epoch++;
  const e = { orgId: ids.orgId, groupId: ids.groupId, epoch, employeeId: c.employeeId, credentialRevision: c.credentialRevision };
  return {
    epoch,
    employeeId: c.employeeId,
    credentialRevision: c.credentialRevision,
    message: roster.rosterEntryMessage(e),
    signature: roster.signRosterEntry(e, key),
    keyId: key.keyId,
  };
});
const members = roster.buildRosterSnapshot([], vectors.ROSTER_VECTOR_CHANGES);
const snapshotPayload = roster.buildSnapshotPayload({ keyId: key.keyId, orgId: ids.orgId, groupId: ids.groupId, epoch, members });
const rosterV1 = {
  note: NOTE,
  publicKey: key.publicKeyB64,
  keyId: key.keyId,
  orgId: ids.orgId,
  groupId: ids.groupId,
  entries,
  snapshot: { epoch, payload: snapshotPayload, signature: signing.signPayload(snapshotPayload, key.seed), keyId: key.keyId },
};

const outDir = join(root, "crates", "rulebox-policy", "tests", "vectors");
const files = { "signed-v2.json": signedV2, "roster-v1.json": rosterV1 };
const check = process.argv.includes("--check");
let differ = 0;
mkdirSync(outDir, { recursive: true });
for (const [name, value] of Object.entries(files)) {
  const path = join(outDir, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    } catch {
      current = "";
    }
    if (current !== text) {
      console.error(`${name}: differs from what the builder produces`);
      differ++;
    } else {
      console.log(`${name}: up to date`);
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${join("crates", "rulebox-policy", "tests", "vectors", name)}`);
  }
}
if (differ > 0) process.exit(1);
