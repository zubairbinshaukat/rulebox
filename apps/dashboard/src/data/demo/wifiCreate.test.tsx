import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { demoApi } from "./hooks";
import { db, resetDemo, setSession } from "./store";
import { errorCodeOf } from "../../lib/errors";

// The demo twin of `wifi:createWithPassphrase`: the checks of `saveWifi` and `setPassphrase`, one store change, the password dropped.

function signInAs(email: string) {
  const m = db().members.find((x) => x.email === email)!;
  const now = Date.now();
  setSession({ memberId: m._id, createdAt: now, stepUp: { verifiedAt: now, lastActiveAt: now, method: "actionPin" } });
}

const SECRET = "correct horse battery";

describe("useCreateWifiWithPassphrase (demo)", () => {
  beforeEach(() => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
  });
  afterEach(() => resetDemo());

  const make = () => renderHook(() => demoApi.useCreateWifiWithPassphrase()).result.current;
  const input = (over: Record<string, unknown> = {}) => ({
    name: "Guest",
    ssid: "Café-Gäste",
    hidden: false,
    security: "wpa2Personal" as const,
    autoConnect: true,
    groupIds: [db().groups[0]!._id],
    passphrase: SECRET,
    ...over,
  });

  it("makes a secured network that already has its password: revision 2, one store change, two audit rows, no password anywhere", async () => {
    const before = db().wifi.length;
    const created = await make()(input());
    expect(created).toEqual({ id: expect.any(String), revision: 2 });
    expect(db().wifi).toHaveLength(before + 1);
    const row = db().wifi.find((w) => w._id === created.id)!;
    expect(row).toMatchObject({ name: "Guest", ssid: "Café-Gäste", security: "wpa2Personal", hasPassphrase: true, revision: 2, groupIds: [db().groups[0]!._id] });
    expect(row.passphraseSetAt).toEqual(expect.any(Number));
    const audit = db().audit.filter((e) => e.targetId === created.id).map((e) => e.action);
    expect(audit).toEqual(["wifi.created", "wifi.passphraseSet"]);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(db().audit)).not.toContain(SECRET);

    // The list says "Password set" at once, and the profile can be edited with the revision it returned.
    const list = renderHook(() => demoApi.useNetworks());
    await waitFor(() => expect(list.result.current.status).toBe("ready"), { timeout: 4000 });
    const listed = list.result.current.status === "ready" ? list.result.current.data.wifi.find((w) => w._id === created.id) : undefined;
    expect(listed).toMatchObject({ hasPassphrase: true, revision: 2 });
    const save = renderHook(() => demoApi.useSaveWifi()).result.current;
    expect(await save({ id: created.id, expectedRevision: 2, name: "Guest 2", ssid: "Café-Gäste", hidden: false, security: "wpa2Personal", autoConnect: true, groupIds: row.groupIds })).toEqual({ id: created.id, revision: 3 });
  }, 15_000);

  it("refuses with the server's codes, fields and details, and writes nothing", async () => {
    const create = make();
    const before = { wifi: db().wifi.length, audit: db().audit.length };
    const bad = async (over: Record<string, unknown>) => (await create(input(over)).catch((e: unknown) => e)) as unknown;
    expect(await bad({ name: "  " })).toMatchObject({ code: "invalid_argument", field: "name" });
    expect(await bad({ ssid: "é".repeat(17) })).toMatchObject({ code: "invalid_argument", field: "ssid" });
    expect(await bad({ ssid: "a\nb" })).toMatchObject({ code: "invalid_argument", field: "ssid" });
    expect(await bad({ security: "open" })).toMatchObject({ code: "invalid_argument", field: "security", detail: "open" });
    expect(await bad({ groupIds: Array.from({ length: 101 }, (_, i) => `g${i}`) })).toMatchObject({ code: "invalid_argument", field: "groupIds", detail: "too_many" });
    expect(await bad({ passphrase: "short" })).toMatchObject({ code: "invalid_argument", field: "passphrase", detail: "length" });
    expect(await bad({ passphrase: "pässwörd-123" })).toMatchObject({ code: "invalid_argument", field: "passphrase", detail: "characters" });
    expect(await bad({ passphrase: "" })).toMatchObject({ code: "invalid_argument", field: "passphrase", detail: "length" });
    expect(await bad({ groupIds: ["nope"] })).toMatchObject({ code: "not_found" });
    expect(db().wifi).toHaveLength(before.wifi);
    expect(db().audit).toHaveLength(before.audit);
    // A 64-digit key and 8 characters are fine.
    expect((await create(input({ name: "Hex", passphrase: "a".repeat(64), groupIds: [] }))).revision).toBe(2);
    expect((await create(input({ name: "Eight", passphrase: "12345678", groupIds: [] }))).revision).toBe(2);
  }, 30_000);

  it("a viewer is refused; at 50 networks it is too_large", async () => {
    while (db().wifi.length < 50) db().wifi.push({ ...db().wifi[0]!, _id: `fill${db().wifi.length}`, groupIds: [] });
    expect(await make()(input()).catch((e: unknown) => e)).toMatchObject({ code: "too_large", detail: "wifi" });
    signInAs("auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test");
    expect(errorCodeOf(await make()(input()).catch((e: unknown) => e))).toBe("forbidden");
  }, 15_000);
});
