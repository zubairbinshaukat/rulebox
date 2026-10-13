import { describe, expect, it } from "vitest";

import { greetingFor } from "./greeting";

function at(h: number, m: number): Date {
  return new Date(2026, 0, 1, h, m, 0, 0);
}

describe("greetingFor", () => {
  it("boundaries at 11:59, 12:00, 17:59, 18:00", () => {
    expect(greetingFor(at(11, 59), "Maya")).toBe("Good morning, Maya");
    expect(greetingFor(at(12, 0), "Maya")).toBe("Good afternoon, Maya");
    expect(greetingFor(at(17, 59), "Maya")).toBe("Good afternoon, Maya");
    expect(greetingFor(at(18, 0), "Maya")).toBe("Good evening, Maya");
  });
});
