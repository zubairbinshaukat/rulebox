import { describe, expect, test } from "vitest";
import rosterRaw from "../crates/rulebox-policy/tests/vectors/roster-v1.json?raw";
import signedRaw from "../crates/rulebox-policy/tests/vectors/signed-v2.json?raw";
import { TEST_KEY, TEST_KEY_2 } from "../tests/convex/keys";
import {
  ROSTER_VECTOR_CHANGES,
  VECTOR_IDS,
  VECTOR_INPUT,
  VECTOR_ISSUED_AT_MS,
  VECTOR_PIN,
  VECTOR_PIN_HASH,
  VECTOR_VERSION,
} from "../tests/convex/vectors";
import { verifySecret } from "./lib/argon";
import { sha256HexSync } from "./lib/crypto";
import {
  buildCatalog,
  buildDeviceDoc,
  buildPayload,
  contentHashOf,
  type BuildInput,
} from "./lib/desired";
import { buildRosterSnapshot, buildSnapshotPayload, rosterEntryMessage, signRosterEntry } from "./lib/roster";
import { decodeKey32, endorsementMessage, signPayload, verifyPayload } from "./lib/signing";
import { DEFAULT_ORG_SETTINGS } from "./lib/validators";

// The document builder (plan 4.4, Step 8 items 2 and 7) and the committed
// vectors the agent verifies in Step 9. Regenerate the vectors with
// `node scripts/gen-policy-vectors.mjs` when the format changes on purpose.

type SignedVector = {
  publicKey: string;
  keyId: string;
  version: number;
  payload: string;
  signature: string;
  orgId: string;
  deviceId: string;
  payloadSha256: string;
  contentHash: string;
  endorsement: { keyId: string; publicKey: string; byKeyId: string; message: string; signature: string };
};
type RosterVector = {
  publicKey: string;
  keyId: string;
  orgId: string;
  groupId: string;
  entries: { epoch: number; employeeId: string; credentialRevision: number | null; message: string; signature: string; keyId: string }[];
  snapshot: { epoch: number; payload: string; signature: string; keyId: string };
};
const signed = JSON.parse(signedRaw) as SignedVector;
const rosterVector = JSON.parse(rosterRaw) as RosterVector;

const payloadOf = (input: BuildInput, version = VECTOR_VERSION) =>
  buildPayload({
    keyId: TEST_KEY.keyId,
    orgId: VECTOR_IDS.orgId,
    deviceId: VECTOR_IDS.deviceId,
    version,
    issuedAtMs: VECTOR_ISSUED_AT_MS,
    doc: buildDeviceDoc(input, version),
  });

function shuffled<T>(xs: T[]): T[] {
  return [...xs].reverse();
}

describe("signed-v2.json (shared with the agent, Step 9)", () => {
  test("the builder reproduces the committed payload byte for byte, and signPayload its signature", () => {
    const payload = payloadOf(VECTOR_INPUT);
    expect(payload).toBe(signed.payload);
    expect(signPayload(payload, TEST_KEY.seed)).toBe(signed.signature);
    expect(signed.publicKey).toBe(TEST_KEY.publicKeyB64);
    expect(signed.keyId).toBe(TEST_KEY.keyId);
    expect(signed.version).toBe(VECTOR_VERSION);
    expect(signed.payloadSha256).toBe(sha256HexSync(signed.payload));
    expect(signed.contentHash).toBe(contentHashOf(buildDeviceDoc(VECTOR_INPUT, VECTOR_VERSION)));
    expect(verifyPayload(signed.payload, signed.signature, decodeKey32(signed.publicKey)!)).toBe(true);
  });

  test("the payload names its key, organization, device and version; the PIN hash verifies", async () => {
    const p = JSON.parse(signed.payload) as Record<string, unknown> & { doc: Record<string, unknown> };
    expect(Object.keys(p)).toEqual(["format", "keyId", "orgId", "deviceId", "version", "issuedAtMs", "doc"]);
    expect(p).toMatchObject({ format: "rulebox.desired/2", keyId: signed.keyId, orgId: signed.orgId, deviceId: signed.deviceId, version: 7 });
    expect(p.doc.version).toBe(7);
    expect((p.doc.adminExit as { pinHash: string }).pinHash).toBe(VECTOR_PIN_HASH);
    expect(await verifySecret(VECTOR_PIN, VECTOR_PIN_HASH)).toBe(true);
  });

  test("the endorsement in the vector verifies with the active key", () => {
    const e = signed.endorsement;
    expect(e).toMatchObject({ keyId: TEST_KEY_2.keyId, publicKey: TEST_KEY_2.publicKeyB64, byKeyId: TEST_KEY.keyId });
    expect(e.message).toBe(endorsementMessage(e.keyId, e.publicKey));
    expect(verifyPayload(e.message, e.signature, TEST_KEY.publicKey)).toBe(true);
  });
});

describe("roster-v1.json (A6)", () => {
  test("entries: exact messages, signatures verify; snapshot = the members left", () => {
    expect(rosterVector.keyId).toBe(TEST_KEY.keyId);
    expect(rosterVector.entries.map((e) => e.credentialRevision)).toEqual([3, 1, null]);
    rosterVector.entries.forEach((e, i) => {
      const entry = { orgId: rosterVector.orgId, groupId: rosterVector.groupId, epoch: i + 1, employeeId: e.employeeId, credentialRevision: e.credentialRevision };
      expect(e.message).toBe(rosterEntryMessage(entry));
      expect(e.signature).toBe(signRosterEntry(entry, TEST_KEY));
      expect(verifyPayload(e.message, e.signature, TEST_KEY.publicKey)).toBe(true);
    });
    expect(rosterVector.entries[2]!.message.endsWith("\nremoved")).toBe(true);
    const members = buildRosterSnapshot([], ROSTER_VECTOR_CHANGES);
    expect(members).toEqual([[VECTOR_IDS.employeeId, 3]]);
    const payload = buildSnapshotPayload({ keyId: TEST_KEY.keyId, orgId: rosterVector.orgId, groupId: rosterVector.groupId, epoch: 3, members });
    expect(rosterVector.snapshot).toEqual({ epoch: 3, payload, signature: signPayload(payload, TEST_KEY.seed), keyId: TEST_KEY.keyId });
    expect(verifyPayload(rosterVector.snapshot.payload, rosterVector.snapshot.signature, TEST_KEY.publicKey)).toBe(true);
  });
});

describe("buildDeviceDoc rules (plan 4.4)", () => {
  test("canonical: shuffled input arrays give the same bytes; key order is fixed", () => {
    const shuffledInput: BuildInput = {
      ...VECTOR_INPUT,
      assignments: shuffled(VECTOR_INPUT.assignments),
      apps: shuffled(VECTOR_INPUT.apps),
      employees: shuffled([...VECTOR_INPUT.employees, { _id: "emp_a_disabled", disabled: true }]),
      employeeApps: shuffled([...VECTOR_INPUT.employeeApps, { employeeId: "emp_a_disabled", appId: VECTOR_IDS.desktopAppId }]),
      fileHandlers: shuffled([...VECTOR_INPUT.fileHandlers, { extension: ".zzz", appId: "app_not_in_catalog" }]),
    };
    expect(payloadOf(shuffledInput)).toBe(signed.payload);
    const doc = buildDeviceDoc(VECTOR_INPUT, 1);
    expect(Object.keys(doc)).toEqual([
      "kioskEnabled", "apps", "allowedSites", "fileHandlers", "storage", "branding", "version",
      "adminExit", "power", "orgName", "catalog", "rosterGroupId", "offlineDays",
    ]);
    expect(doc.apps).toEqual(["files", VECTOR_IDS.desktopAppId, VECTOR_IDS.webAppId]);
    expect(doc.allowedSites).toEqual([]);
  });

  test("adminExit (rule 2): omitted when enabled without a PIN; disabled without the hash; with the hash when set", () => {
    const base = { ...VECTOR_INPUT, settings: DEFAULT_ORG_SETTINGS };
    expect("adminExit" in buildDeviceDoc({ ...base, pinHash: null })).toBe(false);
    expect(buildDeviceDoc({ ...base, pinHash: VECTOR_PIN_HASH }).adminExit).toEqual({
      enabled: true,
      hotkey: "Ctrl+Shift+F12",
      pinHash: VECTOR_PIN_HASH,
    });
    const off = { ...DEFAULT_ORG_SETTINGS, adminExit: { enabled: false, hotkey: "Ctrl+Alt+K" } };
    for (const pinHash of [null, VECTOR_PIN_HASH]) {
      const doc = buildDeviceDoc({ ...base, settings: off, pinHash });
      expect(doc.adminExit).toEqual({ enabled: false, hotkey: "Ctrl+Alt+K" });
      expect(JSON.stringify(doc)).not.toContain("$argon2");
    }
  });

  test("the Staff-App part of the document (the Phase 2 DesiredState keys) never holds the PIN hash", () => {
    const doc = buildDeviceDoc(VECTOR_INPUT, 3);
    const staffPart = Object.fromEntries(
      ["kioskEnabled", "apps", "allowedSites", "fileHandlers", "storage", "branding", "version"].map((k) => [k, doc[k]]),
    );
    expect(JSON.stringify(staffPart)).not.toContain("$argon2");
  });

  test("no group: only Files, no roster group; file rules only for apps in the catalogue", () => {
    const doc = buildDeviceDoc({ ...VECTOR_INPUT, group: null }, 1);
    expect(doc.apps).toEqual(["files"]);
    expect(doc.rosterGroupId).toBeNull();
    expect(doc.fileHandlers).toEqual({});
    expect((doc.catalog as { id: string; pinnedTaskbar: boolean; audience: string }[])[0]).toMatchObject({
      id: "files",
      pinnedTaskbar: true,
      audience: "everyone",
    });
  });

  test("catalogue (plan 4.8): archived apps out; direct web grants in as `selected`; direct desktop grants out; disabled employees count for nothing", () => {
    const input: BuildInput = {
      ...VECTOR_INPUT,
      assignments: [],
      apps: [
        ...VECTOR_INPUT.apps,
        { _id: "app_archived", name: "Old", kind: "web", archived: true, revision: 1, web: VECTOR_INPUT.apps[0]!.web },
      ],
      employees: [
        { _id: "emp_b", disabled: false },
        { _id: "emp_a", disabled: false },
        { _id: "emp_off", disabled: true },
      ],
      employeeApps: [
        { employeeId: "emp_b", appId: VECTOR_IDS.webAppId },
        { employeeId: "emp_a", appId: VECTOR_IDS.webAppId },
        { employeeId: "emp_off", appId: VECTOR_IDS.webAppId },
        { employeeId: "emp_a", appId: VECTOR_IDS.desktopAppId },
        { employeeId: "emp_a", appId: "app_archived" },
      ],
    };
    const catalog = buildCatalog(input);
    expect(catalog.map((c) => c.id)).toEqual(["files", VECTOR_IDS.webAppId]);
    expect(catalog[1]).toMatchObject({ audience: "selected", pinnedTaskbar: false, pinnedDesktop: false, employeeIds: ["emp_a", "emp_b"] });
  });

  test("contentHash ignores the version; any content change changes it", () => {
    const a = buildDeviceDoc(VECTOR_INPUT, 1);
    const b = buildDeviceDoc(VECTOR_INPUT, 2);
    expect(contentHashOf(a)).toBe(contentHashOf(b));
    const kioskOff = buildDeviceDoc({ ...VECTOR_INPUT, device: { ...VECTOR_INPUT.device, kioskEnabled: false } }, 1);
    expect(contentHashOf(kioskOff)).not.toBe(contentHashOf(a));
  });

  test("reserved `relocate` (A13) is the last key and only when given", () => {
    expect("relocate" in buildDeviceDoc(VECTOR_INPUT)).toBe(false);
    const doc = buildDeviceDoc({ ...VECTOR_INPUT, relocate: { url: "https://x.example.test", deviceId: "d2", notBefore: 5 } });
    expect(Object.keys(doc).at(-1)).toBe("relocate");
  });

  test("buildPayload refuses a document whose version differs", () => {
    expect(() =>
      buildPayload({ keyId: "k", orgId: "o", deviceId: "d", version: 2, issuedAtMs: 0, doc: buildDeviceDoc(VECTOR_INPUT, 1) }),
    ).toThrow();
  });
});
