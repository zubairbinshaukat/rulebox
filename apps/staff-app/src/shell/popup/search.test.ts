import { describe, expect, it } from "vitest";

import { matchesSearch } from "./search";

describe("matchesSearch", () => {
  it("folds case and diacritics", () => {
    expect(matchesSearch("Café Orders", "cafe")).toBe(true);
    expect(matchesSearch("Notepad", "NOTE")).toBe(true);
    expect(matchesSearch("Zoë", "zoe")).toBe(true);
    expect(matchesSearch("My files", "")).toBe(true);
    expect(matchesSearch("My files", "  my f")).toBe(true);
    expect(matchesSearch("Notepad", "word")).toBe(false);
  });
});
