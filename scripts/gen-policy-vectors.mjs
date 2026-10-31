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
//   crates/rulebox-policy/tests/vectors/signed-v2-negative.json  documents the agent must REJECT, each with the reason
//
// Deterministic: Ed25519 signatures are deterministic and the PIN hash uses a
// fixed salt, so a second run writes the same bytes. convex/desired.test.ts
// checks the TypeScript side against these files; the agent (Step 9) checks
// the Rust side. Every signature is also verified (or, for the negative
// cases, shown to be rejected) with Node's OpenSSL Ed25519 (`crypto.verify`),
// an implementation independent of @noble/ed25519.

import { createPublicKey, verify as nodeVerify } from "node:crypto";
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

// Independent check: Node's OpenSSL Ed25519 over the UTF-8 bytes of `text`
// (the public key is wrapped in the fixed SPKI header of an Ed25519 key).
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
function opensslVerifies(publicKeyB64, text, signatureB64) {
  const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyB64, "base64")]), format: "der", type: "spki" });
  return nodeVerify(null, Buffer.from(text, "utf8"), pub, Buffer.from(signatureB64, "base64"));
}
/** Both implementations must agree that `signature` over `text` is valid (`expected` true) or not. */
function crossCheck(what, publicKeyB64, text, signatureB64, expected) {
  const noble = signing.verifyPayload(text, signatureB64, Buffer.from(publicKeyB64, "base64"));
  const openssl = opensslVerifies(publicKeyB64, text, signatureB64);
  if (noble !== expected || openssl !== expected) {
    throw new Error(`${what}: expected ${expected ? "valid" : "invalid"}, @noble/ed25519 says ${noble}, OpenSSL says ${openssl}`);
  }
}

// ---- signed-v2.json
const {
  VECTOR_IDS: ids,
  VECTOR_INPUT: input,
  VECTOR_VERSION: version,
  VECTOR_ISSUED_AT_MS: issuedAtMs,
  VECTOR_UNICODE_INPUT: unicodeInput,
  VECTOR_UNICODE_VERSION: unicodeVersion,
} = vectors;
const doc = desired.buildDeviceDoc(input, version);
const payload = desired.buildPayload({ keyId: key.keyId, orgId: ids.orgId, deviceId: ids.deviceId, version, issuedAtMs, doc });
const signature = signing.signPayload(payload, key.seed);
crossCheck("signed-v2 document", key.publicKeyB64, payload, signature, true);

// The same document with strings that exercise UTF-8 and JSON escaping.
const unicodeDoc = desired.buildDeviceDoc(unicodeInput, unicodeVersion);
const unicodePayload = desired.buildPayload({
  keyId: key.keyId,
  orgId: ids.orgId,
  deviceId: ids.deviceId,
  version: unicodeVersion,
  issuedAtMs,
  doc: unicodeDoc,
});
const unicodeSignature = signing.signPayload(unicodePayload, key.seed);
crossCheck("signed-v2 unicode document", key.publicKeyB64, unicodePayload, unicodeSignature, true);
const endorsementMessage = signing.endorsementMessage(ids.orgId, next.keyId, next.publicKeyB64);
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
  // A second signed document (same key, org and device) whose strings hold
  // accents, CJK, an emoji, a double quote, a backslash, a newline, a tab, U+0001
  // and U+007F: the verifier must hash the UTF-8 bytes of `payload` exactly as
  // given, and a parser must undo the JSON escapes (\", \\, \n, \t, \u0001).
  unicode: {
    note: "Same key, organization and device as above. Strings in `payload` contain non-ASCII text and JSON escapes.",
    version: unicodeVersion,
    payload: unicodePayload,
    signature: unicodeSignature,
    payloadSha256: bytesToHex(sha256(utf8ToBytes(unicodePayload))),
    contentHash: desired.contentHashOf(unicodeDoc),
    orgName: unicodeInput.org.name,
  },
};
crossCheck("endorsement", key.publicKeyB64, endorsementMessage, signedV2.endorsement.signature, true);

// ---- roster-v1.json
let epoch = 0;
const entries = vectors.ROSTER_VECTOR_CHANGES.map((c) => {
  epoch++;
  const e = { orgId: ids.orgId, groupId: ids.groupId, epoch, employeeId: c.employeeId, credentialRevision: c.credentialRevision };
  return {
    epoch,
    employeeId: c.employeeId,
    credentialRevision: c.credentialRevision,
    message: roster.rosterEntryMessage({ ...e, keyId: key.keyId }),
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

for (const e of rosterV1.entries) crossCheck(`roster entry ${e.epoch}`, key.publicKeyB64, e.message, e.signature, true);
crossCheck("roster snapshot", key.publicKeyB64, rosterV1.snapshot.payload, rosterV1.snapshot.signature, true);

// ---- signed-v2-negative.json
// Documents the agent must reject. Every case names the FIRST check of the
// procedure below that fails; the checks run in this order, so a case never
// fails for two reasons. All the "valid signature" cases are signed by the
// trusted TEST 1 key.
const PROCEDURE = [
  "1. unknown_key: envelope.keyId is not one of trustedKeys.",
  "2. bad_signature: the Ed25519 signature (standard base64, 64 bytes) over the UTF-8 bytes of envelope.payload does not verify under that key with STRICT rules (ed25519-dalek verify_strict: S must be canonical, small-order points refused).",
  "3. key_id_mismatch: payload.keyId differs from envelope.keyId.",
  "4. wrong_org: payload.orgId differs from expected.orgId.",
  "5. wrong_device: payload.deviceId differs from expected.deviceId.",
  "6. version_mismatch: payload.version differs from envelope.version or from expected.version, or payload.doc.version differs from payload.version.",
];
const OTHER_ORG = "org_test_vector_other";
const OTHER_DEVICE = "dev_test_vector_other";
const expectedVersion = version;
const goodPayload = (over = {}) =>
  desired.buildPayload({
    keyId: key.keyId,
    orgId: ids.orgId,
    deviceId: ids.deviceId,
    version: expectedVersion,
    issuedAtMs,
    doc: desired.buildDeviceDoc(input, over.version ?? expectedVersion),
    ...over,
  });
const flipByte = (b64, index) => {
  const bytes = Buffer.from(b64, "base64");
  bytes[index] ^= 0x01;
  return bytes.toString("base64");
};
// Ed25519 group order L; a signature with S + L is the same signature to a
// verifier that does not check S < L (malleability), and invalid to a strict one.
const GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
function nonCanonicalS(b64) {
  const bytes = Buffer.from(b64, "base64");
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(bytes[i]);
  s += GROUP_ORDER;
  if (s >= 2n ** 256n) throw new Error("S + L does not fit in 32 bytes");
  for (let i = 32; i < 64; i++) {
    bytes[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return bytes.toString("base64");
}
const flipAt = payload.indexOf("Acme Test"); // first byte of the organization name
if (flipAt < 0) throw new Error("expected the organization name in the payload");
const withDocVersion = (n) => {
  const p = JSON.parse(payload);
  p.doc.version = n;
  return JSON.stringify(p);
};
const sign = (text) => signing.signPayload(text, key.seed);
const envelopeOf = (text, over = {}) => ({ keyId: key.keyId, version: expectedVersion, payload: text, signature: sign(text), ...over });

const olderPayload = goodPayload({ version: expectedVersion - 1 });
const docMismatchPayload = withDocVersion(expectedVersion - 1);
const negativeCases = [
  {
    name: "flipped_payload_byte",
    reason: "bad_signature",
    detail: `The valid envelope with byte ${flipAt} of the payload XOR 0x01 ("A" of the organization name becomes "@"); the signature is the original one.`,
    envelope: envelopeOf(payload, { payload: payload.slice(0, flipAt) + String.fromCharCode(payload.charCodeAt(flipAt) ^ 1) + payload.slice(flipAt + 1), signature }),
    signatureValid: false,
  },
  {
    name: "flipped_signature_byte",
    reason: "bad_signature",
    detail: "The valid envelope with byte 40 of the 64-byte signature (inside S) XOR 0x01.",
    envelope: envelopeOf(payload, { signature: flipByte(signature, 40) }),
    signatureValid: false,
  },
  {
    name: "non_canonical_s",
    reason: "bad_signature",
    detail: "The valid signature with S replaced by S + L (L = the group order). Lax verifiers accept it; a strict verifier must not.",
    envelope: envelopeOf(payload, { signature: nonCanonicalS(signature) }),
    signatureValid: false,
  },
  {
    name: "wrong_key_id",
    reason: "unknown_key",
    detail: `A valid signed document whose envelope names the key ${next.keyId} (a real key, but not in trustedKeys).`,
    envelope: envelopeOf(payload, { keyId: next.keyId }),
    signatureValid: true,
  },
  {
    name: "key_id_mismatch",
    reason: "key_id_mismatch",
    detail: `The envelope names the trusted key, but the signed payload says keyId ${next.keyId}.`,
    envelope: envelopeOf(goodPayload({ keyId: next.keyId })),
    signatureValid: true,
  },
  {
    name: "wrong_org_id",
    reason: "wrong_org",
    detail: `A valid document signed for the organization ${OTHER_ORG}.`,
    envelope: envelopeOf(goodPayload({ orgId: OTHER_ORG })),
    signatureValid: true,
  },
  {
    name: "wrong_device_id",
    reason: "wrong_device",
    detail: `A valid document signed for the device ${OTHER_DEVICE}.`,
    envelope: envelopeOf(goodPayload({ deviceId: OTHER_DEVICE })),
    signatureValid: true,
  },
  {
    name: "version_older_than_expected",
    reason: "version_mismatch",
    detail: `A valid document of version ${expectedVersion - 1} presented as version ${expectedVersion - 1}, while the head said ${expectedVersion} (a replayed older document).`,
    envelope: envelopeOf(olderPayload, { version: expectedVersion - 1 }),
    signatureValid: true,
  },
  {
    name: "version_envelope_vs_payload",
    reason: "version_mismatch",
    detail: `The envelope says version ${expectedVersion}, the signed payload is version ${expectedVersion - 1}.`,
    envelope: envelopeOf(olderPayload),
    signatureValid: true,
  },
  {
    name: "version_doc_vs_payload",
    reason: "version_mismatch",
    detail: `payload.version is ${expectedVersion} but payload.doc.version is ${expectedVersion - 1} (signed that way).`,
    envelope: envelopeOf(docMismatchPayload),
    signatureValid: true,
  },
];
for (const c of negativeCases) {
  crossCheck(`negative case ${c.name}`, key.publicKeyB64, c.envelope.payload, c.envelope.signature, c.signatureValid);
}
const signedV2Negative = {
  note: NOTE,
  description:
    "Every case is a document envelope the agent must REJECT with the given reason. Check them in the order of `procedure`; `reason` is the first check that fails. Only the trusted key below is trusted.",
  procedure: PROCEDURE,
  reasons: ["unknown_key", "bad_signature", "key_id_mismatch", "wrong_org", "wrong_device", "version_mismatch"],
  trustedKeys: [{ keyId: key.keyId, publicKey: key.publicKeyB64 }],
  expected: { orgId: ids.orgId, deviceId: ids.deviceId, version: expectedVersion },
  cases: negativeCases.map(({ name, reason, detail, envelope }) => ({ name, reason, detail, envelope })),
};

const outDir = join(root, "crates", "rulebox-policy", "tests", "vectors");
const files = { "signed-v2.json": signedV2, "signed-v2-negative.json": signedV2Negative, "roster-v1.json": rosterV1 };
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
