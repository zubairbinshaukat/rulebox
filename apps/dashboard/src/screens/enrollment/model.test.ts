import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoLabel,
  clampUses,
  DEFAULT_TTL_MINUTES,
  DEFAULT_USES,
  LAST_GROUP_KEY,
  pcStage,
  pickDefaultGroup,
  progressState,
  readLastGroup,
  silentCommand,
  TTL_PRESETS,
  writeLastGroup,
} from "./model";

// The wizard's pure rules (UI pass, enrollment plan 3 and 9).

const NOV_28 = new Date(2026, 10, 28, 14, 5).getTime();

describe("autoLabel", () => {
  it("is the group and the local day", () => {
    expect(autoLabel("Front desk", NOV_28)).toBe("Front desk · 28 Nov");
    expect(autoLabel("Tills", new Date(2026, 0, 3).getTime())).toBe("Tills · 3 Jan");
    expect(autoLabel("Tills", new Date(2026, 11, 31, 23, 59).getTime())).toBe("Tills · 31 Dec");
  });

  it("is never longer than 64 characters: a long group name is cut with an ellipsis", () => {
    const label = autoLabel("G".repeat(100), NOV_28);
    expect(Array.from(label).length).toBeLessThanOrEqual(64);
    expect(label.endsWith("… · 28 Nov")).toBe(true);
    // A name that just fits is kept whole.
    const fits = "x".repeat(64 - " · 28 Nov".length);
    expect(autoLabel(fits, NOV_28)).toBe(`${fits} · 28 Nov`);
    expect(Array.from(autoLabel(`${fits}y`, NOV_28)).length).toBe(64);
  });

  it("counts characters, not UTF-16 units", () => {
    const label = autoLabel("😀".repeat(80), NOV_28);
    expect(Array.from(label).length).toBeLessThanOrEqual(64);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no half a pair
  });

  it("cleans control characters and spaces, and never gives an empty name", () => {
    expect(autoLabel("  Front\u0007\n desk  ", NOV_28)).toBe("Front desk · 28 Nov");
    expect(autoLabel("", NOV_28)).toBe("Code · 28 Nov");
    expect(autoLabel("   ", NOV_28)).toBe("Code · 28 Nov");
  });
});

describe("pickDefaultGroup", () => {
  const groups = [
    { _id: "g2", name: "Office" },
    { _id: "g1", name: "Counter" },
    { _id: "g3", name: "Warehouse" },
  ];

  it("the group used last in this browser, while it still exists", () => {
    expect(pickDefaultGroup(groups, "g3")).toBe("g3");
    expect(pickDefaultGroup(groups, "gone")).toBe("g1");
  });

  it("else the only group, else the first by name, else nothing", () => {
    expect(pickDefaultGroup([{ _id: "only", name: "Zed" }], null)).toBe("only");
    expect(pickDefaultGroup([{ _id: "only", name: "Zed" }], "gone")).toBe("only");
    expect(pickDefaultGroup(groups, null)).toBe("g1"); // Counter
    expect(pickDefaultGroup([], null)).toBeNull();
    expect(pickDefaultGroup([], "g1")).toBeNull();
  });

  it("does not reorder the list it was given", () => {
    const copy = groups.map((g) => g._id);
    pickDefaultGroup(groups, null);
    expect(groups.map((g) => g._id)).toEqual(copy);
  });
});

describe("the last group is kept per browser, as an id", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips", () => {
    expect(readLastGroup()).toBeNull();
    writeLastGroup("g1");
    expect(window.localStorage.getItem(LAST_GROUP_KEY)).toBe("g1");
    expect(readLastGroup()).toBe("g1");
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readLastGroup()).toBeNull();
    expect(() => writeLastGroup("g1")).not.toThrow();
  });
});

describe("silentCommand", () => {
  const code = "RBX1.aHR0cHM6Ly9leGFtcGxlLmNvbnZleC5jbG91ZCMwMTIzNDU2Nzg5QUJDREVGR0hKSw";

  it("msiexec with the hidden ENROLLCODE property, and the agent's own line", () => {
    expect(silentCommand(code, "0.4.0")).toEqual({
      msi: `msiexec /i Rulebox-0.4.0-x64.msi /qn ENROLLCODE=${code}`,
      cli: `rulebox-agent enroll ${code}`,
    });
  });

  it("without a known version the file name has none", () => {
    expect(silentCommand(code).msi).toBe(`msiexec /i Rulebox-x64.msi /qn ENROLLCODE=${code}`);
    expect(silentCommand(code, null).msi).toBe(`msiexec /i Rulebox-x64.msi /qn ENROLLCODE=${code}`);
  });

  it("never asks for a log (the log would contain the code)", () => {
    const { msi } = silentCommand(code, "0.4.0");
    expect(msi).not.toMatch(/\/l/i);
  });
});

describe("the stepper and the defaults", () => {
  it("1 to 100, whole numbers", () => {
    expect(DEFAULT_USES).toBe(1);
    expect(clampUses(0)).toBe(1);
    expect(clampUses(-4)).toBe(1);
    expect(clampUses(1)).toBe(1);
    expect(clampUses(7.4)).toBe(7);
    expect(clampUses(100)).toBe(100);
    expect(clampUses(101)).toBe(100);
    expect(clampUses(Number.NaN)).toBe(1);
    expect(clampUses(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("the lifetimes are the server's presets; the default is one day", () => {
    expect([...TTL_PRESETS]).toEqual([15, 60, 1440, 10080]);
    expect(TTL_PRESETS).toContain(DEFAULT_TTL_MINUTES);
    expect(DEFAULT_TTL_MINUTES).toBe(1440);
  });
});

describe("progressState uses the screen's clock", () => {
  const base = { revoked: false, usesLeft: 1, expiresAt: 10_000 };
  it("revoked beats everything, then used up, then expired", () => {
    expect(progressState(base, 9_999)).toBe("active");
    expect(progressState(base, 10_000)).toBe("expired");
    expect(progressState({ ...base, usesLeft: 0 }, 20_000)).toBe("usedUp");
    expect(progressState({ ...base, revoked: true, usesLeft: 0 }, 1)).toBe("revoked");
    expect(progressState({ ...base, usesLeft: -1 }, 1)).toBe("usedUp");
  });
});

describe("pcStage", () => {
  it("what the PC reported decides, the kiosk phase first", () => {
    expect(pcStage({ online: false })).toBe("joined");
    expect(pcStage({ online: true })).toBe("online");
    expect(pcStage({ online: true, kioskPhase: "applying" })).toBe("settingUp");
    expect(pcStage({ online: true, kioskPhase: "applied" })).toBe("ready");
    expect(pcStage({ online: true, kioskPhase: "failed" })).toBe("needsAttention");
    // Offline again after it was set up: still ready.
    expect(pcStage({ online: false, kioskPhase: "applied" })).toBe("ready");
    // Phases that say nothing yet.
    expect(pcStage({ online: true, kioskPhase: "notApplied" })).toBe("online");
    expect(pcStage({ online: false, kioskPhase: "unknown" })).toBe("joined");
  });
});
