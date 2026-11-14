import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { makeOrg, type T } from "../tests/convex/identity";
import { addWifi, createKeys, giveSealKey, MASTER_A, sealKeyPair, setMaster, setWifiPassphrase } from "../tests/convex/phase5";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { sha256HexSync } from "./lib/crypto";
import { requestPublish } from "./lib/publish";
import { openSealed } from "./lib/sealbox";
import { buildGroupConfig, snapshotGroupConfig } from "./lib/groupConfig";
import { KEEP_GROUP_CONFIGS, MAX_DEVICE_WIFI, MAX_GROUP_EXCEPTIONS } from "./lib/limits";
import { DEFAULT_LOCKDOWN_SETTINGS } from "./lib/lockdownValidators";
import { decodeKey32, verifyPayload } from "./lib/signing";

// `snapshotGroupConfig` (plan 4.14 steps 1-5; Step 10 item 4), the ring pointers the publisher reads, and the whole chain
// into a signed document: a group's configuration -> the device's ring pointer -> the document with the device's own sealed box.

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

async function org(t: T, opts: { noKey?: true } = {}) {
  const orgId = await makeOrg(t, "Acme", opts);
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  return { orgId, groupId };
}

const snapshot = (t: T, groupId: Id<"groups">, reason = "test") =>
  t.run((ctx) => snapshotGroupConfig(ctx, groupId, reason));
const versions = (t: T, groupId: Id<"groups">) =>
  t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", groupId)).collect());
const rollout = (t: T, groupId: Id<"groups">) =>
  t.run((ctx) => ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", groupId)).unique());
const queue = (t: T, orgId: Id<"organizations">) =>
  t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());

describe("snapshotGroupConfig", () => {
  test("the first snapshot is version 1: the defaults, pointers all on it, and a publish request for the group; nothing has secrets", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t);
    expect(await snapshot(t, groupId, "first")).toEqual({ changed: true, version: 1 });
    const [v1] = await versions(t, groupId);
    expect(v1).toMatchObject({ version: 1, orgId, groupId, reason: "first" });
    expect(v1!.contentHash).toBe(sha256HexSync(v1!.config));
    const content = JSON.parse(v1!.config) as ReturnType<typeof buildGroupConfig>;
    expect(content.lockdown.appLocker).toEqual({ mode: "audit" });
    expect(content.lockdown.exceptions).toEqual([]);
    expect(content.wifi).toEqual([]);
    expect(await rollout(t, groupId)).toMatchObject({ enabled: false, pointers: { pilot: 1, early: 1, everyone: 1 }, state: "idle", revision: 0 });
    expect(await queue(t, orgId)).toMatchObject({ groupIds: [groupId], allDevices: false });
  });

  test("an unchanged input writes nothing at all (no version, no pointer, no publish request)", async () => {
    const t = await setupAuth();
    const { groupId } = await org(t);
    await snapshot(t, groupId);
    await drain(t);
    const again = await probe(() => snapshot(t, groupId));
    expect(again.result).toEqual({ changed: false, version: 1 });
    expect(again.io.writes).toBe(0);
    expect(await versions(t, groupId)).toHaveLength(1);
  });

  test("a changed input makes version 2; with rings off every pointer moves to it", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t);
    await snapshot(t, groupId);
    await t.run((ctx) =>
      ctx.db.insert("groupLockdown", {
        orgId,
        groupId,
        settings: { ...DEFAULT_LOCKDOWN_SETTINGS, appLocker: { mode: "enforce" }, usb: { ...DEFAULT_LOCKDOWN_SETTINGS.usb, storage: "readOnly" } },
        revision: 0,
      }),
    );
    expect(await snapshot(t, groupId, "enforce")).toEqual({ changed: true, version: 2 });
    expect(await rollout(t, groupId)).toMatchObject({ pointers: { pilot: 2, early: 2, everyone: 2 } });
    const v2 = JSON.parse((await versions(t, groupId))[1]!.config) as ReturnType<typeof buildGroupConfig>;
    expect(v2.lockdown.appLocker).toEqual({ mode: "enforce" });
    expect(v2.lockdown.usb.storage).toBe("readOnly");
  });

  test("with rings enabled only the `pilot` pointer moves and the rollout is `rolling`; a halted rollout stays halted", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t);
    await snapshot(t, groupId);
    const r = (await rollout(t, groupId))!;
    await t.run((ctx) => ctx.db.patch(r._id, { enabled: true }));
    await t.run((ctx) => ctx.db.insert("wifiProfiles", { orgId, name: "A", ssid: "A", hidden: false, security: "open", autoConnect: true, groupIds: [groupId], revision: 1, createdAt: 1 }));
    await snapshot(t, groupId, "wifi");
    expect(await rollout(t, groupId)).toMatchObject({ pointers: { pilot: 2, early: 1, everyone: 1 }, state: "rolling" });
    await t.run((ctx) => ctx.db.patch(r._id, { state: "halted" }));
    await t.run((ctx) => ctx.db.insert("wifiProfiles", { orgId, name: "B", ssid: "B", hidden: false, security: "open", autoConnect: true, groupIds: [groupId], revision: 1, createdAt: 1 }));
    await snapshot(t, groupId, "wifi 2");
    expect(await rollout(t, groupId)).toMatchObject({ pointers: { pilot: 3, early: 1, everyone: 1 }, state: "halted" });
  });

  test("the content is deterministic (sorted by id, same hash for the same inputs) and holds only this group's Wi-Fi and printers", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t);
    const other = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Other", revision: 0, createdAt: 1 }));
    await t.run(async (ctx) => {
      for (const [name, groups] of [["Zed", [groupId]], ["Alpha", [groupId, other]], ["Elsewhere", [other]]] as const) {
        await ctx.db.insert("wifiProfiles", { orgId, name, ssid: name, hidden: false, security: "wpa2Personal", autoConnect: true, groupIds: [...groups], revision: 1, createdAt: 1 });
      }
      await ctx.db.insert("printers", { orgId, name: "Front", kind: "ipp", address: "https://10.0.0.1/ipp", driver: "Microsoft IPP Class Driver", groupIds: [groupId], defaultForGroupIds: [groupId], revision: 1, createdAt: 1 });
      await ctx.db.insert("printers", { orgId, name: "Back", kind: "ipp", address: "https://10.0.0.2/ipp", driver: "Microsoft IPP Class Driver", groupIds: [other], defaultForGroupIds: [], revision: 1, createdAt: 1 });
    });
    await snapshot(t, groupId);
    const c = JSON.parse((await versions(t, groupId))[0]!.config) as ReturnType<typeof buildGroupConfig>;
    expect(c.wifi.map((w) => w.ssid).sort()).toEqual(["Alpha", "Zed"]);
    expect(c.wifi.map((w) => w.id)).toEqual([...c.wifi.map((w) => w.id)].sort());
    expect(c.printers).toHaveLength(1);
    expect(c.printers[0]).toMatchObject({ name: "Front", isDefault: true, port: null, queue: null });
    // Wi-Fi without a passphrase says so; nothing else about secrets is in the frozen content.
    expect(c.wifi.every((w) => w.hasPassphrase === false)).toBe(true);
    expect(JSON.stringify(c)).not.toMatch(/passphrase"\s*:\s*\{/);
  });

  test("another organization's rows never enter a group's configuration", async () => {
    const t = await setupAuth();
    const a = await org(t);
    const b = await org(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("wifiProfiles", { orgId: b.orgId, name: "B-only", ssid: "B-only", hidden: false, security: "open", autoConnect: true, groupIds: [a.groupId], revision: 1, createdAt: 1 });
      await ctx.db.insert("lockdownExceptions", { orgId: b.orgId, rule: { kind: "hash", sha256: "a".repeat(64), layers: ["appLocker"] }, reason: "b", createdAt: 1 });
    });
    await snapshot(t, a.groupId);
    const c = JSON.parse((await versions(t, a.groupId))[0]!.config) as ReturnType<typeof buildGroupConfig>;
    expect(c.wifi).toEqual([]);
    expect(c.lockdown.exceptions).toEqual([]);
  });

  test("exceptions: the group's and the organization-wide ones are both in; more than 200 is refused and nothing is stored", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("lockdownExceptions", { orgId, groupId, rule: { kind: "hash", sha256: "a".repeat(64), layers: ["appLocker"] }, reason: "g", createdAt: 1 });
      await ctx.db.insert("lockdownExceptions", { orgId, rule: { kind: "publisher", publisher: { subject: "CN=Acme" }, layers: ["procWatch"] }, reason: "o", createdAt: 1 });
    });
    await snapshot(t, groupId);
    const c = JSON.parse((await versions(t, groupId))[0]!.config) as ReturnType<typeof buildGroupConfig>;
    expect(c.lockdown.exceptions.map((e) => e.kind).sort()).toEqual(["hash", "publisher"]);

    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_GROUP_EXCEPTIONS; i++) {
        await ctx.db.insert("lockdownExceptions", { orgId, groupId, rule: { kind: "path", path: `{ProgramFiles}\\A${i}\\a.exe`, layers: ["appLocker"] }, reason: "x", createdAt: 1 });
      }
    });
    await expect(snapshot(t, groupId)).rejects.toMatchObject({ data: { code: "invalid_argument", detail: "too_many" } });
    expect(await versions(t, groupId)).toHaveLength(1);
  });

  test("more than 20 Wi-Fi profiles for one group, or a configuration over 256 KiB, is refused", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_DEVICE_WIFI + 1; i++) {
        await ctx.db.insert("wifiProfiles", { orgId, name: `N${i}`, ssid: `N${i}`, hidden: false, security: "open", autoConnect: true, groupIds: [groupId], revision: 1, createdAt: 1 });
      }
    });
    await expect(snapshot(t, groupId)).rejects.toMatchObject({ data: { code: "invalid_argument", detail: "too_many" } });

    const big = await org(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 190; i++) {
        await ctx.db.insert("lockdownExceptions", { orgId: big.orgId, groupId: big.groupId, rule: { kind: "path", path: "{ProgramFiles}\\" + "x".repeat(1500), layers: ["appLocker"] }, reason: "x", createdAt: 1 });
      }
    });
    await expect(snapshot(t, big.groupId)).rejects.toMatchObject({ data: { code: "invalid_argument", detail: "too_large" } });
  });

  test("old versions are pruned (keep 20) but a version a ring pointer still names is kept", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t);
    await snapshot(t, groupId);
    const r = (await rollout(t, groupId))!;
    // Rings on, with `everyone` staying on version 1 while the pilot ring moves ahead.
    await t.run((ctx) => ctx.db.patch(r._id, { enabled: true }));
    for (let i = 0; i < KEEP_GROUP_CONFIGS + 8; i++) {
      await t.run((ctx) => ctx.db.insert("wifiProfiles", { orgId, name: `N${i}`, ssid: `N${i}`, hidden: false, security: "open", autoConnect: true, groupIds: [groupId], revision: 1, createdAt: 1 }));
      await snapshot(t, groupId, `edit ${i}`);
      // Keep every edit under the 20-profile limit.
      if (i % 15 === 14) await t.run(async (ctx) => { for (const w of await ctx.db.query("wifiProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()) await ctx.db.delete(w._id); });
    }
    const kept = (await versions(t, groupId)).map((v) => v.version);
    expect(kept).toContain(1); // `early` and `everyone` still point at it
    expect(kept).toContain(await t.run(async (ctx) => (await ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", groupId)).unique())!.pointers.pilot));
    // The ones in between that nothing references are gone (prune runs 10 per snapshot, below newest - 19).
    expect(kept.length).toBeLessThan(KEEP_GROUP_CONFIGS + 8);
  });
});

describe("the publisher: ring pointers and the whole chain into a signed document", () => {
  test("a device gets the configuration its RING points to, and a pilot device an older/newer one than everyone", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t, { noKey: true });
    await createKeys(t, orgId);
    const pilot = await enrollDevice(t, orgId, { groupId, name: "Pilot" });
    const everyone = await enrollDevice(t, orgId, { groupId, name: "Everyone" });
    await t.run((ctx) => ctx.db.patch(pilot.deviceId, { ring: "pilot" }));
    await snapshot(t, groupId, "v1");
    await drain(t);
    const r = (await rollout(t, groupId))!;
    await t.run((ctx) => ctx.db.patch(r._id, { enabled: true }));
    await t.run((ctx) =>
      ctx.db.insert("groupLockdown", { orgId, groupId, settings: { ...DEFAULT_LOCKDOWN_SETTINGS, appLocker: { mode: "enforce" } }, revision: 0 }),
    );
    await snapshot(t, groupId, "v2"); // only the pilot pointer moves
    await drain(t);
    const docOf = async (d: { deviceId: Id<"devices">; secret: string }) => {
      const head = await t.query(api.devices.headState, { deviceId: d.deviceId, deviceSecret: d.secret });
      if (head.kind !== "ok" || head.head === null) throw new Error("no head");
      const env = await t.query(api.devices.fetchDesired, { deviceId: d.deviceId, deviceSecret: d.secret, version: head.head.version });
      return JSON.parse(env.payload) as { doc: { config: { version: number; ring: string }; lockdown: { appLocker: { mode: string } } } };
    };
    expect((await docOf(pilot)).doc).toMatchObject({ config: { version: 2, ring: "pilot" }, lockdown: { appLocker: { mode: "enforce" } } });
    expect((await docOf(everyone)).doc).toMatchObject({ config: { version: 1, ring: "everyone" }, lockdown: { appLocker: { mode: "audit" } } });
  });

  test("Wi-Fi: org keys -> passphrase at rest -> the device's sealing key -> `seal:forDevices` -> a signed document whose box only that device opens", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t, { noKey: true });
    await createKeys(t, orgId);
    const { deviceId, secret } = await enrollDevice(t, orgId, { groupId });
    const wifi = await addWifi(t, orgId, { groupIds: [groupId], ssid: "Acme-Staff", passphrase: "correct horse battery" });
    await snapshot(t, groupId, "wifi");
    await drain(t);

    const fetchDoc = async () => {
      const head = await t.query(api.devices.headState, { deviceId, deviceSecret: secret });
      if (head.kind !== "ok" || head.head === null) throw new Error("no head");
      const env = await t.query(api.devices.fetchDesired, { deviceId, deviceSecret: secret, version: head.head.version });
      return { env, payload: JSON.parse(env.payload) as { orgId: string; doc: { wifi: { id: string; ssid: string; sealed: { v: number; keyId: string; epk: string; nonce: string; ct: string } | null }[]; config: { groupId: string; version: number } } } };
    };
    // No sealing key yet: the profile is there, its box is not (the agent reports waiting_for_key).
    const before = await fetchDoc();
    expect(before.payload.doc.wifi).toEqual([expect.objectContaining({ id: wifi, ssid: "Acme-Staff", sealed: null })]);

    // The device registers its key: the action seals, the mutation stores the box and asks for a publish of that device.
    const kp = sealKeyPair();
    await t.mutation(api.deviceApi.registerSealKey, { deviceId, deviceSecret: secret, publicKey: kp.publicB64 });
    await drain(t);
    const after = await fetchDoc();
    const box = after.payload.doc.wifi[0]!.sealed!;
    expect(box).toMatchObject({ v: 1, keyId: kp.keyId });
    expect(Object.keys(box)).toEqual(["v", "keyId", "epk", "nonce", "ct"]);
    expect(openSealed(box, kp.secret, { orgId, deviceId, profileId: wifi })).toBe("correct horse battery");
    // Not another device, not another profile, not another org.
    expect(openSealed(box, kp.secret, { orgId, deviceId: "x", profileId: wifi })).toBeNull();
    expect(openSealed(box, sealKeyPair(9).secret, { orgId, deviceId, profileId: wifi })).toBeNull();
    // Neither the document, the head nor any returned value holds the passphrase; the stored box does not either.
    expect(after.env.payload).not.toContain("correct horse");
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("deviceSealedSecrets").collect()))).not.toContain("correct horse");
    // The document verifies with the organization's own key.
    const key = (await t.run((ctx) => ctx.db.query("policyKeys").withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "active")).first()))!;
    expect(verifyPayload(after.env.payload, after.env.signature, decodeKey32(key.publicKey)!)).toBe(true);

    // A new revision of the profile (a new passphrase) is sealed again for the same key.
    await t.run(async (ctx) => {
      const p = (await ctx.db.get(wifi))!;
      await ctx.db.patch(wifi, { revision: p.revision + 1 });
    });
    await setWifiPassphrase(t, orgId, wifi, "another passphrase 1", 2);
    await snapshot(t, groupId, "passphrase");
    await drain(t);
    await t.action(internal.seal.forDevices, { orgId, deviceIds: [deviceId] });
    await drain(t);
    const rotated = await fetchDoc();
    expect(openSealed(rotated.payload.doc.wifi[0]!.sealed!, kp.secret, { orgId, deviceId, profileId: wifi })).toBe("another passphrase 1");
  });

  test("a sealed box is only used for the revision and the sealing key it was made for", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t, { noKey: true });
    await createKeys(t, orgId);
    const { deviceId, secret } = await enrollDevice(t, orgId, { groupId });
    await addWifi(t, orgId, { groupIds: [groupId] });
    const kp = await giveSealKey(t, deviceId);
    await snapshot(t, groupId, "wifi");
    await t.action(internal.seal.forDevices, { orgId, deviceIds: [deviceId] });
    await drain(t);
    const sealedOf = async () => {
      const head = await t.query(api.devices.headState, { deviceId, deviceSecret: secret });
      if (head.kind !== "ok" || head.head === null) throw new Error("no head");
      const env = await t.query(api.devices.fetchDesired, { deviceId, deviceSecret: secret, version: head.head.version });
      return (JSON.parse(env.payload) as { doc: { wifi: { sealed: unknown }[] } }).doc.wifi[0]!.sealed;
    };
    expect(await sealedOf()).not.toBeNull();
    // The device replaced its key: the old box is useless and is not sent. Since Step 13 the publisher also asks for the sealing
    // action, so the NEXT document carries a box for the new key (and the old key opens nothing).
    const other = sealKeyPair(8);
    await t.run((ctx) => ctx.db.patch(deviceId, { sealPublicKey: other.publicB64, sealKeyId: other.keyId }));
    await t.run((ctx) => requestPublish(ctx, orgId, { deviceIds: [deviceId] }));
    await drain(t);
    expect(await sealedOf()).toMatchObject({ keyId: other.keyId });
    expect(kp.keyId).not.toBe(other.keyId);
  });

  test("a PC of another organization never gets a box for this organization's profile", async () => {
    const t = await setupAuth();
    const a = await org(t, { noKey: true });
    const b = await org(t, { noKey: true });
    await createKeys(t, a.orgId);
    await createKeys(t, b.orgId);
    const devB = await enrollDevice(t, b.orgId, { groupId: b.groupId });
    await giveSealKey(t, devB.deviceId);
    await addWifi(t, a.orgId, { groupIds: [a.groupId] });
    await snapshot(t, a.groupId);
    // Asking to seal organization A's profiles for organization B's device does nothing.
    expect(await t.action(internal.seal.forDevices, { orgId: a.orgId, deviceIds: [devB.deviceId] })).toEqual({ sealed: 0, skipped: 0 });
    expect(await t.run((ctx) => ctx.db.query("deviceSealedSecrets").collect())).toEqual([]);
  });

  test("an unreadable passphrase (master key gone) seals nothing and leaks no error text", async () => {
    const t = await setupAuth();
    const { orgId, groupId } = await org(t, { noKey: true });
    await createKeys(t, orgId);
    const { deviceId } = await enrollDevice(t, orgId, { groupId });
    await addWifi(t, orgId, { groupIds: [groupId], passphrase: "very secret value" });
    await giveSealKey(t, deviceId);
    setMaster(undefined);
    const r = await t.action(internal.seal.forDevices, { orgId, deviceIds: [deviceId] });
    expect(r).toEqual({ sealed: 0, skipped: 1 });
    expect(await t.run((ctx) => ctx.db.query("deviceSealedSecrets").collect())).toEqual([]);
  });
});
