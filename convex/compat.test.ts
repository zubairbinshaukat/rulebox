import { describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { deviceRows, probe } from "../tests/convex/devices";
import { makeOrg } from "../tests/convex/identity";
import { api } from "./_generated/api";
import { cleanCompat, cleanWebView2 } from "./lib/compat";
import { sha256HexSync } from "./lib/crypto";
import { MAX_COMPAT_JSON_BYTES } from "./lib/limits";

// Phase 6 Step 6 (plan 4.12): the compatibility report with WebView2, protection level,
// browsers, protected print and low RAM. Stored as `v.any()`; `cleanCompat` bounds what the
// dashboard reads. No new query: the device page reads `deviceReports` as before.

const SECRET = "device-secret-0123456789";
const TOKEN = "ABCDEFGHJKMNPQRSTVWX";

/** What `rulebox-agent compat --json` prints (apps/agent/src/compat.rs `CompatReport`). */
const REPORT = {
  os: {
    build: 26100,
    ubr: 4351,
    displayVersion: "24H2",
    editionId: "CoreSingleLanguage",
    productType: 1,
    arch: "x86_64",
    sMode: false,
    domainJoined: false,
    entraJoined: false,
    ramMb: 3800,
    systemDiskFreeGb: 40,
  },
  blockers: [],
  warnings: ["webview2_missing", "protected_print_on"],
  liteMode: true,
  webview2: { present: false, version: null, source: "none" },
  protection: "reduced",
  layers: { appLocker: false, appControl: true },
  browsers: { edge: true, chrome: false },
  protectedPrint: true,
  lowRam: false,
};

describe("cleanCompat", () => {
  test("the agent's report passes through unchanged", () => {
    expect(cleanCompat(REPORT)).toEqual(REPORT);
    const full = { ...REPORT, webview2: { present: true, version: "130.0.2849.80", source: "machine" }, protection: "full" };
    expect(cleanCompat(full)).toEqual(full);
  });

  test("a report that is not an object is not stored; an older report (no Phase 6 fields) passes", () => {
    for (const bad of [null, undefined, "text", 5, ["a"], true]) expect(cleanCompat(bad)).toBeUndefined();
    const old = { os: REPORT.os, blockers: ["s_mode"], warnings: [], liteMode: false };
    expect(cleanCompat(old)).toEqual(old);
    expect(cleanCompat({})).toEqual({});
  });

  test("a bad Phase 6 field is dropped, the rest of the report stays", () => {
    const messy = {
      ...REPORT,
      webview2: "yes",
      protection: "partial",
      layers: { appLocker: "yes", appControl: true },
      browsers: { edge: true },
      protectedPrint: "no",
      lowRam: 1,
    };
    const clean = cleanCompat(messy)!;
    for (const key of ["webview2", "protection", "layers", "browsers", "protectedPrint", "lowRam"]) expect(key in clean).toBe(false);
    expect(clean.os).toEqual(REPORT.os);
    expect(clean.warnings).toEqual(REPORT.warnings);
    expect(clean.liteMode).toBe(true);
  });

  test("WebView2: only a short version of digits and dots counts as present", () => {
    expect(cleanWebView2({ present: true, version: "131.0.2903.51", source: "machine" })).toEqual({ present: true, version: "131.0.2903.51", source: "machine" });
    expect(cleanWebView2({ present: true, version: "<script>", source: "machine" })).toEqual({ present: false, version: null, source: "none" });
    expect(cleanWebView2({ present: true, version: "1.".repeat(40), source: "machine" })?.present).toBe(false);
    expect(cleanWebView2({ present: true, version: "1.2", source: "elsewhere" })).toEqual({ present: true, version: "1.2", source: "none" });
    expect(cleanWebView2({ present: false, version: "1.2", source: "machine" })?.present).toBe(false);
    expect(cleanWebView2({ version: "1.2" })).toBeUndefined();
  });

  test("blockers and warnings are reduced to short codes, at most 20", () => {
    const codes = Array.from({ length: 30 }, (_, i) => `code_${i}`);
    const clean = cleanCompat({ blockers: ["os_too_old", "C:\\secret path", 5, "x".repeat(100)], warnings: codes })!;
    expect(clean.blockers).toEqual(["os_too_old"]);
    expect(clean.warnings).toEqual(codes.slice(0, 20));
    expect("blockers" in cleanCompat({ blockers: "nope" })!).toBe(false);
  });

  test("a report over 32 KB is not stored; one just under it is", () => {
    expect(cleanCompat({ ...REPORT, extra: "x".repeat(MAX_COMPAT_JSON_BYTES) })).toBeUndefined();
    const room = MAX_COMPAT_JSON_BYTES - JSON.stringify({ ...REPORT, extra: "" }).length - 10;
    const big = cleanCompat({ ...REPORT, extra: "x".repeat(room) });
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(MAX_COMPAT_JSON_BYTES);
  });

  test("the real agent report is far below the cap", () => {
    expect(JSON.stringify(REPORT).length).toBeLessThan(2 * 1024);
  });
});

async function seed(t: Awaited<ReturnType<typeof setupAuth>>) {
  await makeOrg(t).then((orgId) =>
    t.run((ctx) =>
      ctx.db.insert("enrollmentTokens", {
        orgId,
        tokenHash: sha256HexSync(TOKEN),
        expiresAt: Date.now() + 3_600_000,
        usesLeft: 1,
        createdAt: Date.now(),
      }),
    ),
  );
}

describe("the Phase 6 report on the wire", () => {
  test("enrollment stores it, the same status again writes nothing, a change writes the report once", async () => {
    const t = await setupAuth();
    await seed(t);
    const { deviceId } = await t.mutation(api.enrollment.enroll, {
      token: TOKEN,
      deviceSecretHash: sha256HexSync(SECRET),
      deviceName: "Front desk PC",
      agentVersion: "0.4.0",
      compat: REPORT,
    });
    expect((await deviceRows(t, deviceId)).report?.compat).toEqual(REPORT);

    const status = { agentVersion: "0.4.0", osBuild: "26100.4351", osEdition: "CoreSingleLanguage", compat: REPORT };
    // The first full status adds the OS fields; after that an identical status writes nothing.
    await t.mutation(api.deviceApi.report, { deviceId, deviceSecret: SECRET, status });
    const same = await probe(() => t.mutation(api.deviceApi.report, { deviceId, deviceSecret: SECRET, status }));
    expect(same.io.writes).toBe(0);

    const fixed = { ...REPORT, warnings: ["protected_print_on"], webview2: { present: true, version: "131.0.2903.51", source: "machine" } };
    const changed = await probe(() =>
      t.mutation(api.deviceApi.report, { deviceId, deviceSecret: SECRET, status: { ...status, compat: fixed } }),
    );
    // Only the detail row changes: the list row (`deviceSummary`) is not written.
    expect(changed.io.writes).toBe(1);
    expect((await deviceRows(t, deviceId)).report?.compat).toEqual(fixed);
  });

  test("a status with a huge report is accepted but the report is not stored", async () => {
    const t = await setupAuth();
    await seed(t);
    const { deviceId } = await t.mutation(api.enrollment.enroll, {
      token: TOKEN,
      deviceSecretHash: sha256HexSync(SECRET),
      deviceName: "Front desk PC",
      agentVersion: "0.4.0",
      compat: REPORT,
    });
    await t.mutation(api.deviceApi.report, {
      deviceId,
      deviceSecret: SECRET,
      status: { agentVersion: "0.4.0", compat: { ...REPORT, blob: "x".repeat(40_000) } },
    });
    expect((await deviceRows(t, deviceId)).report?.compat).toBeUndefined();
  });
});
