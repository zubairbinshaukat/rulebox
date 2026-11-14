import { describe, expect, test } from "vitest";
import lockdownRaw from "../crates/rulebox-policy/tests/vectors/lockdown.json?raw";
import { VECTOR_INPUT } from "../tests/convex/vectors";
import { buildDeviceDoc, type DocBroadcast, type Phase5Input } from "./lib/desired";
import type { ConfigDriver, ConfigPrinter, ConfigWifi, DocException, DocLockdown, GroupConfigContent } from "./lib/groupConfig";
import type { SealedBoxValue } from "./lib/lockdownValidators";
import { MAX_ACTIVE_BROADCASTS, MAX_DEVICE_DRIVERS, MAX_DEVICE_PRINTERS, MAX_DEVICE_WIFI, MAX_GROUP_EXCEPTIONS } from "./lib/limits";

// The Phase 5 keys of the desired-state document (plan 4.3; Step 10 item 5), pinned against the vector the Rust side parses
// (`crates/rulebox-policy/tests/vectors/lockdown.json`): the builder must emit exactly those keys, shapes and key order.

type Vector = {
  phase4: Record<string, unknown>;
  phase5Keys: {
    lockdown: DocLockdown;
    wifi: (Omit<ConfigWifi, "hasPassphrase"> & { sealed: SealedBoxValue })[];
    wifiManagedOnly: boolean;
    printers: ConfigPrinter[];
    drivers: ConfigDriver[];
    deviceLock: { lockId: string; message: string; contact: string | null; lockedAtMs: number };
    usbTempAllow: { untilMs: number };
    broadcasts: DocBroadcast[];
    config: { groupId: string; version: number; ring: "pilot" | "early" | "everyone" };
  };
};
const vector = JSON.parse(lockdownRaw) as Vector;
const p5 = vector.phase5Keys;

const NOW = p5.usbTempAllow.untilMs - 1000;

/** The Phase 5 input that must give `phase5Keys` exactly. */
function vectorInput(): Phase5Input {
  const content: GroupConfigContent = {
    lockdown: p5.lockdown,
    wifiManagedOnly: p5.wifiManagedOnly,
    wifi: p5.wifi.map((w) => ({ id: w.id, ssid: w.ssid, hidden: w.hidden, security: w.security, autoConnect: w.autoConnect, revision: w.revision, hasPassphrase: true })),
    printers: p5.printers,
    drivers: p5.drivers,
  };
  return {
    config: { groupId: p5.config.groupId, version: p5.config.version, ring: p5.config.ring, content },
    sealed: Object.fromEntries(p5.wifi.map((w) => [w.id, w.sealed])),
    deviceLock: p5.deviceLock,
    usbTempAllowUntilMs: p5.usbTempAllow.untilMs,
    broadcasts: p5.broadcasts,
    nowMs: NOW,
  };
}

const PHASE5_KEYS = ["lockdown", "wifi", "wifiManagedOnly", "printers", "drivers", "deviceLock", "usbTempAllow", "broadcasts", "config"];
const phase5Part = (doc: Record<string, unknown>) => Object.fromEntries(PHASE5_KEYS.filter((k) => k in doc).map((k) => [k, doc[k]]));

describe("lockdown.json (shared with the agent)", () => {
  test("the builder emits every Phase 5 key of the vector, in the vector's order, byte for byte", () => {
    const doc = buildDeviceDoc({ ...VECTOR_INPUT, phase5: vectorInput() }, 7);
    expect(Object.keys(doc).filter((k) => PHASE5_KEYS.includes(k))).toEqual(Object.keys(p5));
    expect(JSON.stringify(phase5Part(doc))).toBe(JSON.stringify(p5));
    // The Phase 5 keys come after the Phase 4 ones, which are untouched.
    const keys = Object.keys(doc);
    expect(keys.indexOf("offlineDays")).toBeLessThan(keys.indexOf("lockdown"));
    const phase4 = buildDeviceDoc(VECTOR_INPUT, 7);
    expect(JSON.stringify(Object.fromEntries(Object.entries(doc).filter(([k]) => !PHASE5_KEYS.includes(k))))).toBe(JSON.stringify(phase4));
  });

  test("drivers (Step 14b): every field in the contract's key order, an empty list when the configuration has none or predates drivers", () => {
    const driver: ConfigDriver = {
      id: "drv_1",
      name: "Front desk driver",
      kind: "inf",
      url: "https://downloads.example.test/front.zip",
      sha256: "a".repeat(64),
      sizeBytes: 1000,
      inf: "Drivers/front.inf",
      silentArgs: [],
      successExitCodes: [],
      revision: 3,
    };
    const base = vectorInput();
    const withDrivers = (drivers: ConfigDriver[] | undefined): Phase5Input => ({ ...base, config: { ...base.config!, content: { ...base.config!.content, drivers } } });
    const doc = buildDeviceDoc({ ...VECTOR_INPUT, phase5: withDrivers([driver]) }, 7);
    expect(JSON.stringify(doc.drivers)).toBe(
      '[{"id":"drv_1","name":"Front desk driver","kind":"inf","url":"https://downloads.example.test/front.zip","sha256":"' +
        "a".repeat(64) +
        '","sizeBytes":1000,"inf":"Drivers/front.inf","silentArgs":[],"successExitCodes":[],"revision":3}]',
    );
    expect(buildDeviceDoc({ ...VECTOR_INPUT, phase5: withDrivers(undefined) }, 7).drivers).toEqual([]);
    expect(() => buildDeviceDoc({ ...VECTOR_INPUT, phase5: withDrivers(Array.from({ length: MAX_DEVICE_DRIVERS + 1 }, (_, i) => ({ ...driver, id: `d${i}` }))) }, 7)).toThrow();
  });

  test("no Phase 5 input: the document is the Phase 4 document byte for byte (no new key)", () => {
    const doc = buildDeviceDoc(VECTOR_INPUT, 7);
    for (const k of PHASE5_KEYS) expect(k in doc, k).toBe(false);
  });

  test("a device without a group configuration still gets its live keys: lock, USB window (null when over), broadcasts", () => {
    const input = { ...vectorInput(), config: null };
    const doc = buildDeviceDoc({ ...VECTOR_INPUT, phase5: input }, 7);
    expect(Object.keys(doc).filter((k) => PHASE5_KEYS.includes(k))).toEqual(["deviceLock", "usbTempAllow", "broadcasts"]);
    const over = buildDeviceDoc({ ...VECTOR_INPUT, phase5: { ...input, nowMs: p5.usbTempAllow.untilMs + 1 } }, 7);
    expect(over.usbTempAllow).toBeNull();
    const none = buildDeviceDoc({ ...VECTOR_INPUT, phase5: { ...input, deviceLock: null, usbTempAllowUntilMs: null, broadcasts: [] } }, 7);
    expect(none.deviceLock).toBeNull();
    expect(none.usbTempAllow).toBeNull();
    expect(none.broadcasts).toEqual([]);
  });

  test("a Wi-Fi profile without a box yet carries `sealed: null` (the agent reports waiting_for_key); only the device's own boxes are used", () => {
    const input = { ...vectorInput(), sealed: {} };
    const doc = buildDeviceDoc({ ...VECTOR_INPUT, phase5: input }, 7);
    expect((doc.wifi as { sealed: unknown }[])[0]!.sealed).toBeNull();
    // A box under another profile id is ignored.
    const other = buildDeviceDoc({ ...VECTOR_INPUT, phase5: { ...input, sealed: { some_other_profile: p5.wifi[0]!.sealed } } }, 7);
    expect((other.wifi as { sealed: unknown }[])[0]!.sealed).toBeNull();
    // The sealed box is the only secret-bearing field and holds ciphertext only.
    expect(JSON.stringify(buildDeviceDoc({ ...VECTOR_INPUT, phase5: vectorInput() }, 7).wifi)).not.toMatch(/passphrase|password/i);
  });

  test("broadcasts are sorted by id", () => {
    const b = (id: string): DocBroadcast => ({ ...p5.broadcasts[0]!, id });
    const doc = buildDeviceDoc({ ...VECTOR_INPUT, phase5: { ...vectorInput(), broadcasts: [b("c"), b("a"), b("b")] } }, 7);
    expect((doc.broadcasts as DocBroadcast[]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  test("limits: the builder throws (the publisher records a failed publish) instead of writing a document the agent would refuse", () => {
    const base = vectorInput();
    const build = (p: Phase5Input) => () => buildDeviceDoc({ ...VECTOR_INPUT, phase5: p }, 7);
    const ex = (i: number): DocException => ({ ...p5.lockdown.exceptions[0]!, id: `ex${i}` });
    const withConfig = (patch: Partial<GroupConfigContent>): Phase5Input => ({ ...base, config: { ...base.config!, content: { ...base.config!.content, ...patch } } });
    expect(build(withConfig({ lockdown: { ...p5.lockdown, exceptions: Array.from({ length: MAX_GROUP_EXCEPTIONS }, (_, i) => ex(i)) } }))).not.toThrow();
    expect(build(withConfig({ lockdown: { ...p5.lockdown, exceptions: Array.from({ length: MAX_GROUP_EXCEPTIONS + 1 }, (_, i) => ex(i)) } }))).toThrow();
    expect(build(withConfig({ wifi: Array.from({ length: MAX_DEVICE_WIFI + 1 }, (_, i) => ({ ...base.config!.content.wifi[0]!, id: `w${i}` })) }))).toThrow();
    expect(build(withConfig({ printers: Array.from({ length: MAX_DEVICE_PRINTERS + 1 }, (_, i) => ({ ...p5.printers[0]!, id: `p${i}` })) }))).toThrow();
    const many = Array.from({ length: MAX_ACTIVE_BROADCASTS + 1 }, (_, i) => ({ ...p5.broadcasts[0]!, id: `b${i}` }));
    expect(build({ ...base, broadcasts: many })).toThrow();
    expect(build({ ...base, deviceLock: { ...p5.deviceLock, message: "m".repeat(301) } })).toThrow();
    expect(build({ ...base, deviceLock: { ...p5.deviceLock, contact: "c".repeat(101) } })).toThrow();
    expect(build({ ...base, deviceLock: { ...p5.deviceLock, message: "m".repeat(300), contact: "c".repeat(100) } })).not.toThrow();
  });

  test("the document stays inside the plan's size bound with every limit full (worst <= 64 KB of Phase 5 keys)", () => {
    const base = vectorInput();
    const content: GroupConfigContent = {
      ...base.config!.content,
      lockdown: { ...p5.lockdown, exceptions: Array.from({ length: MAX_GROUP_EXCEPTIONS }, (_, i) => ({ ...p5.lockdown.exceptions[0]!, id: `exception_${String(i).padStart(30, "0")}` })) },
      wifi: Array.from({ length: MAX_DEVICE_WIFI }, (_, i) => ({ ...base.config!.content.wifi[0]!, id: `wifi_${i}`, ssid: "S".repeat(32) })),
      printers: Array.from({ length: MAX_DEVICE_PRINTERS }, (_, i) => ({ ...p5.printers[0]!, id: `printer_${i}` })),
    };
    const sealed = Object.fromEntries(content.wifi.map((w) => [w.id, p5.wifi[0]!.sealed]));
    const broadcasts = Array.from({ length: MAX_ACTIVE_BROADCASTS }, (_, i) => ({ ...p5.broadcasts[0]!, id: `b${i}`, title: "t".repeat(80), body: "b".repeat(500) }));
    const doc = buildDeviceDoc({ ...VECTOR_INPUT, phase5: { ...base, config: { ...base.config!, content }, sealed, broadcasts } }, 7);
    const bytes = new TextEncoder().encode(JSON.stringify(phase5Part(doc))).length;
    expect(bytes).toBeLessThanOrEqual(65_536);
  });
});
