import { describe, expect, it } from "vitest";
import { parseWhen, sinceFor } from "./since";

describe("the When filter of the audit log", () => {
  const noon = new Date(2026, 10, 28, 12, 30, 15); // 28 Nov 2026, local time

  it("all time has no start", () => {
    expect(sinceFor("all", noon)).toBeUndefined();
  });

  it("starts at midnight of a local day: today, 6 days back (7 days with today), 29 days back (30 days)", () => {
    expect(sinceFor("today", noon)).toBe(new Date(2026, 10, 28).getTime());
    expect(sinceFor("7d", noon)).toBe(new Date(2026, 10, 22).getTime());
    expect(sinceFor("30d", noon)).toBe(new Date(2026, 9, 30).getTime());
  });

  it("is the same number all day, so the live query does not change every minute", () => {
    expect(sinceFor("7d", new Date(2026, 10, 28, 0, 0, 1))).toBe(sinceFor("7d", new Date(2026, 10, 28, 23, 59, 59)));
  });

  it("counts days on the calendar across the end of a month and a year", () => {
    expect(sinceFor("7d", new Date(2027, 0, 3, 9))).toBe(new Date(2026, 11, 28).getTime());
  });

  it("reads the URL value; anything else is all time", () => {
    expect(parseWhen("today")).toBe("today");
    expect(parseWhen("7d")).toBe("7d");
    expect(parseWhen("30d")).toBe("30d");
    expect(parseWhen("90d")).toBe("all");
    expect(parseWhen(undefined)).toBe("all");
    expect(parseWhen("")).toBe("all");
  });
});
