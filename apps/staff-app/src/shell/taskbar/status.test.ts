import { describe, expect, it } from "vitest";

import { batteryLine, msUntilNextMinute, networkLabel } from "./status";

describe("battery line", () => {
  it("matches the three cases", () => {
    expect(
      batteryLine({ percent: 86, charging: true, minutesLeft: null }),
    ).toBe("86% · Charging");
    expect(
      batteryLine({ percent: 40, charging: false, minutesLeft: 130 }),
    ).toBe("On battery · 2 h 10 min left");
    expect(batteryLine(null)).toBeNull();
    expect(
      batteryLine({ percent: null, charging: false, minutesLeft: null }),
    ).toBeNull();
  });
});

describe("network label", () => {
  it("names the three states", () => {
    expect(networkLabel("internet")).toBe("Connected to the internet");
    expect(networkLabel("local")).toBe("Connected, no internet");
    expect(networkLabel("none")).toBe("No network");
  });
});

describe("clock timer", () => {
  it("waits until the next minute", () => {
    expect(msUntilNextMinute(new Date(2026, 9, 14, 11, 16, 0, 0))).toBe(60_000);
    expect(msUntilNextMinute(new Date(2026, 9, 14, 11, 16, 30, 0))).toBe(30_000);
    expect(msUntilNextMinute(new Date(2026, 9, 14, 11, 16, 59, 500))).toBe(500);
  });
});
