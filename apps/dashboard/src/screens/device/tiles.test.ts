import { describe, expect, it } from "vitest";
import type { ApplyReport, DevicePage } from "../../data/types";
import { LAYER_NAMES } from "../../data/types";
import { browsersText, editionName, windowsLine, windowsName } from "./format";
import { kioskPillOf, presenceOf } from "./presence";
import { deviceText as t } from "./strings";
import { overviewTiles } from "./tiles";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const apply = (state: ApplyReport["state"] = "applied", layer?: { name: (typeof LAYER_NAMES)[number]; state: string }): ApplyReport => ({
  state,
  refusal: null,
  layers: Object.fromEntries(LAYER_NAMES.map((n) => [n, { mode: "on", state: layer?.name === n ? layer.state : "applied" }])) as ApplyReport["layers"],
  appliedVersion: 1,
  lkgVersion: null,
  configVersion: 1,
  updatedAt: NOW,
});

const page = (over: Partial<DevicePage> = {}): DevicePage => ({
  _id: "d1",
  name: "Front desk",
  revision: 1,
  revoked: false,
  kioskEnabled: true,
  enrolledAt: NOW - 5 * HOUR,
  group: { _id: "g1", name: "Sales" },
  displayMode: "auto",
  groupDisplayMode: "auto",
  presence: { online: true, since: NOW - HOUR },
  report: { agentVersion: "0.4.1", os: "Windows 11", osEdition: "Core", appliedVersion: 3, diskFreeGb: 183, ramMb: 3900, kioskPhase: "applied", updatedAt: NOW - 60_000, outOfSupport: false },
  outOfSupport: false,
  latestVersion: 3,
  planState: "ok",
  flags: { noGroup: false, revoked: false, rotateCredential: false },
  lock: null,
  ring: "everyone",
  usbAllowUntil: null,
  protection: null,
  lockdownCapable: true,
  apply: apply(),
  failedInstalls: { count: 0, more: false, names: [] },
  network: { wifiFailed: 0, printersFailed: 0 },
  ...over,
});

const tile = (p: DevicePage, id: string) => overviewTiles(p, NOW).find((x) => x.id === id)!;

describe("overview tiles", () => {
  it("a healthy PC: up to date, working, no failures, its disk and memory", () => {
    const tiles = overviewTiles(page(), NOW);
    expect(tiles.map((x) => [x.id, x.value, x.tone])).toEqual([
      ["settings", t.tile.upToDate, "ok"],
      ["protection", t.tile.working, "ok"],
      ["apps", t.tile.noFailures, "ok"],
      ["disk", "183 GB", "neutral"],
      ["memory", "4 GB", "neutral"],
    ]);
    expect(tiles.every((x) => x.tab === undefined)).toBe(true);
    expect(tiles.filter((x) => x.wide).map((x) => x.id)).toEqual(["memory"]);
  });

  it("settings: Updating while the PC is behind (and when it arrives), Not sent yet before the first publish", () => {
    const behind = page({ latestVersion: 4 });
    expect(tile(behind, "settings")).toMatchObject({ value: t.tile.updating, tone: "neutral", sub: t.tile.arrivesSoon });
    expect(tile(page({ latestVersion: 4, presence: { online: false, since: 1 } }), "settings").sub).toBe(t.tile.arrivesLater);
    expect(tile(page({ latestVersion: null }), "settings").value).toBe(t.tile.notSent);
  });

  it("protection: partly working for a failed or partial layer, not applied when refused, a link to its tab when it is not fine", () => {
    expect(tile(page({ apply: apply("applied", { name: "machine", state: "partial" }) }), "protection")).toMatchObject({ value: t.tile.partly, tone: "warn", tab: "protection" });
    expect(tile(page({ apply: apply("refused") }), "protection")).toMatchObject({ value: t.tile.notApplied, tone: "danger", tab: "protection" });
    expect(tile(page({ apply: apply("rolledBack") }), "protection").value).toBe(t.tile.notApplied);
    expect(tile(page({ apply: null }), "protection")).toMatchObject({ value: t.tile.notReported, tone: "neutral" });
    expect(tile(page({ apply: null, lockdownCapable: false }), "protection")).toMatchObject({ value: t.tile.notApplied, sub: t.tile.needsNewerRulebox, tab: "protection" });
  });

  it("apps: the failed count links to the Apps tab; 10+ when the range was full", () => {
    expect(tile(page({ failedInstalls: { count: 2, more: false, names: ["A", "B"] } }), "apps")).toMatchObject({ value: "2 failed", tone: "warn", tab: "apps" });
    expect(tile(page({ failedInstalls: { count: 10, more: true, names: [] } }), "apps").value).toBe("10+ failed");
  });

  it("disk: warns below 2 GB or on the agent's low_disk warning; memory says Lite mode", () => {
    const low = page({ report: { ...page().report!, diskFreeGb: 1 } });
    expect(tile(low, "disk")).toMatchObject({ value: "1 GB", tone: "warn", sub: t.tile.lowDisk });
    const lite = page({
      report: {
        ...page().report!,
        compat: { os: { build: 26100, ubr: 1, displayVersion: "24H2", editionId: "Core", productType: 1, arch: "x86_64", sMode: false, domainJoined: false, entraJoined: false, ramMb: 3900, systemDiskFreeGb: 183 }, blockers: [], warnings: ["low_disk"], liteMode: true },
      },
    });
    expect(tile(lite, "disk").tone).toBe("warn");
    expect(tile(lite, "memory").sub).toBe(t.tile.lite);
  });

  it("a PC that never reported shows dashes, and a PC that is off says how old what it shows is", () => {
    const silent = overviewTiles(page({ report: null, apply: null, lockdownCapable: null, latestVersion: null }), NOW);
    expect(silent.filter((x) => x.id !== "memory").map((x) => x.value)).toEqual([t.tile.none, t.tile.none, t.tile.none, t.tile.none]);
    const off = page({ presence: { online: false, since: NOW - 3 * HOUR }, report: { ...page().report!, updatedAt: NOW - 3 * HOUR } });
    expect(tile(off, "apps").sub).toContain("Last known");
    expect(tile(page(), "apps").sub).toBeUndefined();
  });
});

describe("what the PC reports, in plain words", () => {
  it("names the Windows edition as people know it", () => {
    expect(editionName("Core")).toBe("Home");
    expect(editionName("CoreSingleLanguage")).toBe("Home");
    expect(editionName("Professional")).toBe("Pro");
    expect(editionName("IoTEnterprise")).toBe("IoT Enterprise");
    expect(editionName("Enterprise")).toBe("Enterprise");
    expect(editionName("ServerStandard")).toBe("ServerStandard");
    expect(editionName(undefined)).toBeNull();
  });

  it("Windows name and line: edition once, the feature update when known, the version from the build when the name is missing", () => {
    const r = page().report!;
    expect(windowsName(r)).toBe("Windows 11 Home");
    expect(windowsName({ ...r, os: "Windows 11 Pro", osEdition: "Professional" })).toBe("Windows 11 Pro");
    expect(windowsName({ ...r, os: undefined, osBuild: "19045", osEdition: undefined })).toBe("Windows 10");
    expect(windowsName(null)).toBeNull();
    expect(windowsLine(r)).toBe("Windows 11 Home");
  });

  it("browsers: names them, says none found, and says nothing for an older agent", () => {
    expect(browsersText(undefined)).toBeNull();
    const os = { build: 1, ubr: 1, displayVersion: "", editionId: "", productType: 1, arch: "", sMode: false, domainJoined: false, entraJoined: false, ramMb: 1, systemDiskFreeGb: 1 };
    expect(browsersText({ os, blockers: [], warnings: [], liteMode: false })).toBeNull();
    expect(browsersText({ os, blockers: [], warnings: [], liteMode: false, browsers: { edge: true, chrome: false } })).toBe("Edge");
    expect(browsersText({ os, blockers: [], warnings: [], liteMode: false, browsers: { edge: false, chrome: false } })).toBe(t.browsersNone);
  });
});

describe("header pills", () => {
  it("presence: online with the last contact, offline since, last seen, never connected, and no claim while liveness has not answered", () => {
    const live = (lastContactAt: number | null) => ({ lastContactAt, online: true, fastUntil: null });
    expect(presenceOf(page(), live(NOW - 10_000), NOW)).toMatchObject({ tone: "success", label: t.onlineAgo(t.justNow) });
    expect(presenceOf(page(), live(NOW - 5 * 60_000), NOW).label).toMatch(/^Online · 5 minutes ago$/);
    expect(presenceOf(page(), null, NOW).label).toBe(t.online);
    const off = page({ presence: { online: false, since: NOW - 3 * 24 * HOUR } });
    expect(presenceOf(off, live(null), NOW)).toMatchObject({ tone: "neutral", label: t.offlineSince("3 days ago") });
    const never = page({ presence: { online: false, since: null } });
    expect(presenceOf(never, live(null), NOW).label).toBe(t.notConnected);
    expect(presenceOf(never, null, NOW).label).toBe(t.offline);
    expect(presenceOf(never, live(NOW - 2 * HOUR), NOW).label).toBe(t.offlineLastSeen("2 hours ago"));
  });

  it("kiosk: off is a warning, failed is a problem, applied is on, a disconnected PC says so", () => {
    expect(kioskPillOf(page())).toEqual({ tone: "success", label: t.kioskOn });
    expect(kioskPillOf(page({ kioskEnabled: false }))).toEqual({ tone: "warning", label: t.kioskOff });
    expect(kioskPillOf(page({ report: { ...page().report!, kioskPhase: "failed" } }))).toEqual({ tone: "danger", label: t.kioskProblem });
    expect(kioskPillOf(page({ report: null }))).toEqual({ tone: "neutral", label: t.kioskWaiting });
    expect(kioskPillOf(page({ revoked: true }))).toEqual({ tone: "danger", label: t.disconnected });
  });
});
