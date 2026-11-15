import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import sealRaw from "../crates/rulebox-policy/tests/vectors/seal.json?raw";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice } from "../tests/convex/devices";
import { asMember, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { createKeys, giveSealKey, MASTER_A, setMaster } from "../tests/convex/phase5";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { base64Decode } from "./lib/crypto";
import { MAX_NETWORK_GROUPS, MAX_WIFI_PROFILES } from "./lib/limits";
import { openSealed } from "./lib/sealbox";
import { checkPassphrase } from "./wifi";

// Wi-Fi profiles on the server (Phase 5 Step 13, plan 4.15, 4.20): save / delete / list / detail, the passphrase
// action, the publisher's sealing flow and the guarantee that no plaintext passphrase is ever returned or stored.

const PASS = "correct horse battery";

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
  setMaster(MASTER_A);
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
  setMaster(undefined);
});
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t, "Acme", { noKey: true });
  await createKeys(t, orgId);
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  const adm = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, adm);
  const view = await asMember(t, { role: "viewer", orgId });
  return { t, orgId, groupId, admin: adm.as, viewer: view.as };
}
type Env = Awaited<ReturnType<typeof setup>>;

const profile = (groupIds: Id<"groups">[], over: Partial<{ name: string; ssid: string; security: "open" | "wpa2Personal" | "wpa3Personal" | "wpa2Wpa3Personal" }> = {}) => ({
  name: "Staff",
  ssid: "Acme-Staff",
  hidden: false,
  security: "wpa2Personal" as const,
  autoConnect: true,
  groupIds,
  ...over,
});

async function fetchDoc(t: T, d: { deviceId: Id<"devices">; secret: string }) {
  const head = await t.query(api.devices.headState, { deviceId: d.deviceId, deviceSecret: d.secret });
  if (head.kind !== "ok" || head.head === null) throw new Error("no head");
  const env = await t.query(api.devices.fetchDesired, { deviceId: d.deviceId, deviceSecret: d.secret, version: head.head.version });
  const payload = JSON.parse(env.payload) as {
    doc: { wifi?: { id: string; ssid: string; revision: number; sealed: { v: number; keyId: string; epk: string; nonce: string; ct: string } | null }[] };
  };
  return { version: head.head.version, raw: env.payload, wifi: payload.doc.wifi ?? [] };
}

const profiles = (e: Env) => e.t.run((ctx) => ctx.db.query("wifiProfiles").collect());
const sealedRows = (e: Env) => e.t.run((ctx) => ctx.db.query("deviceSealedSecrets").collect());

describe("networks:saveWifi", () => {
  test("creates (revision 1), audits, snapshots the group; a repeat of the same values writes nothing", async () => {
    const e = await setup();
    const made = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId]));
    expect(made.revision).toBe(1);
    const versions = await e.t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", e.groupId)).collect());
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]!.config).wifi).toEqual([expect.objectContaining({ id: made.id, ssid: "Acme-Staff", hasPassphrase: false })]);
    const audit = await e.t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((a) => a.action)).toContain("wifi.created");

    await drain(e.t);
    const same = await e.admin.mutation(api.networks.saveWifi, { ...profile([e.groupId]), id: made.id, expectedRevision: 1 });
    expect(same).toEqual({ id: made.id, revision: 1 });
    expect(await e.t.run((ctx) => ctx.db.query("groupConfigs").collect())).toHaveLength(1);
    expect((await e.t.run((ctx) => ctx.db.query("auditLog").collect())).filter((a) => a.action === "wifi.updated")).toHaveLength(0);
  });

  test("an update bumps the revision; a stale edit, a missing expectedRevision and a viewer are refused", async () => {
    const e = await setup();
    const { id } = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId]));
    const r = await e.admin.mutation(api.networks.saveWifi, { ...profile([e.groupId], { ssid: "Acme-Staff-2" }), id, expectedRevision: 1 });
    expect(r.revision).toBe(2);
    await expect(e.admin.mutation(api.networks.saveWifi, { ...profile([e.groupId]), id, expectedRevision: 1 })).rejects.toThrow(/stale_edit/);
    await expect(e.admin.mutation(api.networks.saveWifi, { ...profile([e.groupId]), id })).rejects.toThrow(/invalid_argument/);
    await expect(e.viewer.mutation(api.networks.saveWifi, profile([e.groupId]))).rejects.toThrow(/forbidden/);
    await expect(e.viewer.mutation(api.networks.deleteWifi, { id })).rejects.toThrow(/forbidden/);
  });

  test("validation: name, SSID bytes and characters, groups of another organization", async () => {
    const e = await setup();
    const bad = async (over: Parameters<typeof profile>[1], groups = [e.groupId]) =>
      e.admin.mutation(api.networks.saveWifi, profile(groups, over));
    await expect(bad({ name: "  " })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ name: "x".repeat(61) })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ ssid: "" })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ ssid: "a".repeat(33) })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ ssid: "é".repeat(17) })).rejects.toThrow(/invalid_argument/); // 34 bytes
    await expect(bad({ ssid: "bad\u0007name" })).rejects.toThrow(/invalid_argument/);
    await bad({ ssid: "é".repeat(16) }); // exactly 32 bytes
    await bad({ ssid: "A&B <\"it's\">", name: "Specials" }); // XML characters are fine here (the agent escapes)
    const other = await makeOrg(e.t, "Other");
    const foreign = await e.t.run((ctx) => ctx.db.insert("groups", { orgId: other, name: "Theirs", revision: 0, createdAt: Date.now() }));
    await expect(bad({}, [foreign])).rejects.toThrow(/not_found/);
  });

  test("limits: 50 profiles per organization, at most 100 groups in one save (more groups are NOT refused any more: they are snapshotted in batches)", async () => {
    const e = await setup();
    await e.t.run(async (ctx) => {
      for (let i = 0; i < MAX_WIFI_PROFILES; i++) {
        await ctx.db.insert("wifiProfiles", { orgId: e.orgId, name: `N${i}`, ssid: `N${i}`, hidden: false, security: "open", autoConnect: true, groupIds: [], revision: 1, createdAt: 1 });
      }
    });
    await expect(e.admin.mutation(api.networks.saveWifi, profile([]))).rejects.toThrow(/too_large/);
    const e2 = await setup();
    const groups = await e2.t.run(async (ctx) => {
      const ids: Id<"groups">[] = [];
      for (let i = 0; i < MAX_NETWORK_GROUPS + 1; i++) ids.push(await ctx.db.insert("groups", { orgId: e2.orgId, name: `G${i}`, revision: 0, createdAt: 1 }));
      return ids;
    });
    await expect(e2.admin.mutation(api.networks.saveWifi, profile(groups))).rejects.toThrow(/too_many/);
    await e2.admin.mutation(api.networks.saveWifi, profile(groups.slice(0, 11)));
  });

  test("switching to an open network drops the stored passphrase and its boxes", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    await giveSealKey(e.t, dev.deviceId);
    const { id } = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId]));
    await e.admin.action(api.wifi.setPassphrase, { id, passphrase: PASS, expectedRevision: 1 });
    await drain(e.t);
    expect(await sealedRows(e)).toHaveLength(1);
    await e.admin.mutation(api.networks.saveWifi, { ...profile([e.groupId], { security: "open" }), id, expectedRevision: 2 });
    await drain(e.t); // the scheduled `networks:purgeSealed`
    const row = (await profiles(e))[0]!;
    expect(row.passphrase).toBeUndefined();
    expect(row.passphraseRev).toBeUndefined();
    expect(await sealedRows(e)).toHaveLength(0);
  });
});

describe("wifi:setPassphrase", () => {
  test("validation: length, characters, 64 hex, open networks, stale edits, roles", async () => {
    const e = await setup();
    const { id } = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId]));
    const set = (passphrase: string, expectedRevision = 1) => e.admin.action(api.wifi.setPassphrase, { id, passphrase, expectedRevision });
    await expect(set("1234567")).rejects.toThrow(/invalid_argument/);
    await expect(set("x".repeat(64))).rejects.toThrow(/invalid_argument/); // 64 characters must be hex
    await expect(set("passphrase with é")).rejects.toThrow(/invalid_argument/);
    await expect(set("tab\tin it 123")).rejects.toThrow(/invalid_argument/);
    await expect(set(PASS, 7)).rejects.toThrow(/stale_edit/);
    await expect(e.viewer.action(api.wifi.setPassphrase, { id, passphrase: PASS, expectedRevision: 1 })).rejects.toThrow(/forbidden/);
    expect((await set("12345678")).revision).toBe(2);
    expect((await set("a".repeat(63), 2)).revision).toBe(3);
    expect((await set("0123456789abcdef".repeat(4), 3)).revision).toBe(4);
    const open = await e.admin.mutation(api.networks.saveWifi, profile([], { security: "open", name: "Guest", ssid: "Guest" }));
    await expect(e.admin.action(api.wifi.setPassphrase, { id: open.id, passphrase: PASS, expectedRevision: 1 })).rejects.toThrow(/invalid_argument/);
    expect(() => checkPassphrase("A".repeat(8))).not.toThrow();
  });

  test("without a sealing key the action answers not_ready and stores nothing", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { noKey: true }); // no createKeys
    const adm = await asMember(t, { role: "admin", orgId });
    await giveStepUp(t, adm);
    const { id } = await adm.as.mutation(api.networks.saveWifi, profile([]));
    await expect(adm.as.action(api.wifi.setPassphrase, { id, passphrase: PASS, expectedRevision: 1 })).rejects.toThrow(/not_ready/);
    expect((await t.run((ctx) => ctx.db.get(id)))!.passphrase).toBeUndefined();
  });

  test("another organization's profile is not found", async () => {
    const e = await setup();
    const { id } = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId]));
    const other = await makeOrg(e.t, "Other");
    const adm = await asMember(e.t, { role: "admin", orgId: other });
    await giveStepUp(e.t, adm);
    await expect(adm.as.action(api.wifi.setPassphrase, { id, passphrase: PASS, expectedRevision: 1 })).rejects.toThrow(/not_found/);
    await expect(adm.as.mutation(api.networks.deleteWifi, { id })).rejects.toThrow(/not_found/);
    await expect(adm.as.query(api.networks.wifiDetail, { id })).rejects.toThrow(/not_found/);
    expect((await adm.as.query(api.networks.list, {})).wifi).toEqual([]);
  });
});

describe("the sealing flow through the publisher", () => {
  test("passphrase -> the document without a box -> `seal:forDevices` -> the document WITH the box only that device opens; an SSID edit reseals and still decrypts", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const kp = await giveSealKey(e.t, dev.deviceId);
    const { id } = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId]));
    await drain(e.t);
    expect((await fetchDoc(e.t, dev)).wifi).toEqual([expect.objectContaining({ id, ssid: "Acme-Staff", revision: 1, sealed: null })]);

    const set = await e.admin.action(api.wifi.setPassphrase, { id, passphrase: PASS, expectedRevision: 1 });
    expect(set).toEqual({ revision: 2 });
    await drain(e.t); // publish (no box yet) -> seal:forDevices -> storeSealed -> publish again
    const a = await fetchDoc(e.t, dev);
    const box = a.wifi[0]!.sealed!;
    expect(a.wifi[0]!.revision).toBe(2);
    expect(box).toMatchObject({ v: 1, keyId: kp.keyId });
    expect(openSealed(box, kp.secret, { orgId: e.orgId, deviceId: dev.deviceId, profileId: id })).toBe(PASS);
    expect(openSealed(box, kp.secret, { orgId: e.orgId, deviceId: "other", profileId: id })).toBeNull();
    expect(a.raw).not.toContain(PASS);
    const rows = await sealedRows(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "wifi", targetId: id, targetRevision: 2 });

    // A non-passphrase edit bumps the revision: a new box for revision 3, and the stored passphrase still opens.
    await e.admin.mutation(api.networks.saveWifi, { ...profile([e.groupId], { ssid: "Acme-Staff-New" }), id, expectedRevision: 2 });
    await drain(e.t);
    const b = await fetchDoc(e.t, dev);
    expect(b.version).toBeGreaterThan(a.version);
    expect(b.wifi[0]).toMatchObject({ ssid: "Acme-Staff-New", revision: 3 });
    expect(openSealed(b.wifi[0]!.sealed!, kp.secret, { orgId: e.orgId, deviceId: dev.deviceId, profileId: id })).toBe(PASS);
    const row = (await profiles(e))[0]!;
    expect(row).toMatchObject({ revision: 3, passphraseRev: 2 });
    expect((await sealedRows(e))[0]).toMatchObject({ targetRevision: 3 });
  });

  test("a device without a sealing key gets the profile without a box, nothing is sealed, and nothing loops", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId }); // no sealPublicKey
    const { id } = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId]));
    await e.admin.action(api.wifi.setPassphrase, { id, passphrase: PASS, expectedRevision: 1 });
    await drain(e.t);
    const doc = await fetchDoc(e.t, dev);
    expect(doc.wifi).toEqual([expect.objectContaining({ id, sealed: null })]);
    expect(await sealedRows(e)).toHaveLength(0);
    // Publishing again changes nothing (no new version): the run ended.
    await e.t.run(async (ctx) => {
      const { requestPublish } = await import("./lib/publish");
      await requestPublish(ctx, e.orgId, { deviceIds: [dev.deviceId] });
    });
    await drain(e.t);
    expect((await fetchDoc(e.t, dev)).version).toBe(doc.version);
  });

  test("deleting a profile removes it from the documents, deletes its boxes and publishes a new version", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    await giveSealKey(e.t, dev.deviceId);
    const keep = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId], { name: "Keep", ssid: "Keep" }));
    const gone = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId], { name: "Gone", ssid: "Gone" }));
    await e.admin.action(api.wifi.setPassphrase, { id: gone.id, passphrase: PASS, expectedRevision: 1 });
    await drain(e.t);
    const before = await fetchDoc(e.t, dev);
    expect(before.wifi.map((w) => w.id).sort()).toEqual([keep.id, gone.id].sort());
    expect(await sealedRows(e)).toHaveLength(1);

    await e.admin.mutation(api.networks.deleteWifi, { id: gone.id });
    await drain(e.t);
    const after = await fetchDoc(e.t, dev);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.wifi.map((w) => w.id)).toEqual([keep.id]);
    expect(await sealedRows(e)).toHaveLength(0);
    expect((await e.t.run((ctx) => ctx.db.query("auditLog").collect())).map((a) => a.action)).toContain("wifi.deleted");
    // Deleting the last profile is allowed even when a group wants managed networks only (the agent refuses that document).
    await e.admin.mutation(api.networks.deleteWifi, { id: keep.id });
    expect((await e.admin.query(api.networks.list, {})).wifi).toEqual([]);
  });
});

describe("reads", () => {
  test("list and detail: names, group chips, counts from the apply reports; no secret anywhere", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    await giveSealKey(e.t, dev.deviceId);
    const { id } = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId]));
    await e.admin.action(api.wifi.setPassphrase, { id, passphrase: PASS, expectedRevision: 1 });
    await drain(e.t);
    // One PC reported `applied` for it, another `waiting_for_key`, a third `unsupported`.
    await e.t.run(async (ctx) => {
      const base = {
        orgId: e.orgId,
        appliedVersion: 1,
        config: { groupId: e.groupId, version: 1, ring: "everyone" as const },
        state: "applied" as const,
        layers: Object.fromEntries(["staff", "machine", "appLocker", "appControl", "procWatch", "boot", "performance"].map((k) => [k, { mode: "off", state: "ok" }])),
        printers: [],
        capabilities: [],
        updatedAt: 1,
      };
      const states = [["applied", dev.deviceId], ["waiting_for_key", null], ["unsupported", null], ["failed", null]] as const;
      for (const [i, [state, existing]] of states.entries()) {
        const enrollmentTokenId = (await ctx.db.get(dev.deviceId))!.enrollmentTokenId;
        const deviceId = existing ?? (await ctx.db.insert("devices", { orgId: e.orgId, groupId: e.groupId, name: `P${i}`, enrolledAt: 1, revision: 0, enrollmentTokenId }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await ctx.db.insert("deviceApplyReports", { ...base, layers: base.layers as any, deviceId, wifi: [{ profileId: id, revision: 2, state }], contentHash: `h${i}` });
      }
    });
    const list = await e.viewer.query(api.networks.list, {});
    expect(list.wifi).toEqual([
      expect.objectContaining({ _id: id, name: "Staff", ssid: "Acme-Staff", hasPassphrase: true, revision: 2, groupCount: 1, groups: [{ _id: e.groupId, name: "Sales" }] }),
    ]);
    expect(list.wifi[0]!.passphraseSetAt).toEqual(expect.any(Number));
    const detail = await e.viewer.query(api.networks.wifiDetail, { id });
    expect(detail.counts).toEqual({ applied: 1, failed: 1, waiting: 1, unsupported: 1, sampled: 4, capped: false });
    expect(detail.groupIds).toEqual([e.groupId]);

    // Nothing returned, audited or stored by a query holds the passphrase, a key id, or a box.
    const text = JSON.stringify([list, detail]);
    expect(text).not.toContain(PASS);
    for (const word of ["sealed", "keyId", "wrapped", "ciphertext"]) expect(text).not.toContain(word);
    const stored = await profiles(e);
    expect(JSON.stringify(stored)).not.toContain(PASS);
    expect(JSON.stringify(await e.t.run((ctx) => ctx.db.query("auditLog").collect()))).not.toContain(PASS);
    expect(JSON.stringify(await sealedRows(e))).not.toContain(PASS);
  });

  test("errors never carry the passphrase", async () => {
    const e = await setup();
    const { id } = await e.admin.mutation(api.networks.saveWifi, profile([e.groupId]));
    const secret = "my-secret-passphrase-é"; // not ASCII: refused
    let message = "";
    try {
      await e.admin.action(api.wifi.setPassphrase, { id, passphrase: secret, expectedRevision: 1 });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/invalid_argument/);
    expect(message).not.toContain(secret);
  });
});

describe("seal.json (shared with the agent)", () => {
  test("every committed vector case opens with the server's openSealed", () => {
    const v = JSON.parse(sealRaw) as {
      deviceSecret: string;
      cases: { orgId: string; deviceId: string; profileId: string; plaintext: string; box: Parameters<typeof openSealed>[0] }[];
    };
    const secret = base64Decode(v.deviceSecret)!;
    expect(v.cases.length).toBeGreaterThanOrEqual(3);
    for (const c of v.cases) expect(openSealed(c.box, secret, { orgId: c.orgId, deviceId: c.deviceId, profileId: c.profileId })).toBe(c.plaintext);
  });
});
