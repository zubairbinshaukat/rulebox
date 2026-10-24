import { describe, expect, it } from "vitest";
import type { AppEntry } from "@rulebox/types";

import { GLYPH_HUES, glyphFor, hueFor } from "./appArt";

function app(name: string, extra: Partial<AppEntry> = {}): AppEntry {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: null,
    kind: { type: "web", url: "https://x.invalid", allowedDomains: [], permissions: {} as never },
    iconKey: null,
    iconUrl: null,
    hue: null,
    pinnedTaskbar: false,
    pinnedDesktop: true,
    badge: null,
    ...extra,
  } as AppEntry;
}

describe("glyphFor", () => {
  it("picks a glyph from the app's name", () => {
    expect(glyphFor(app("Mail"))).toBe("mail");
    expect(glyphFor(app("Meetings"))).toBe("calendar");
    expect(glyphFor(app("Team chat"))).toBe("chat");
    expect(glyphFor(app("Visitor pass"))).toBe("badge");
    expect(glyphFor(app("Orders"))).toBe("bag");
    expect(glyphFor(app("Accounts"))).toBe("card");
    expect(glyphFor(app("Videos"))).toBe("video");
  });

  it("prefers a known iconKey, and the Files tool is always the folder", () => {
    expect(glyphFor(app("Mail", { iconKey: "chart" }))).toBe("chart");
    expect(glyphFor(app("Whatever", { iconKey: "not-a-glyph" }))).toBe("globe");
    expect(glyphFor(app("My files", { id: "files", kind: { type: "builtin", tool: "files" } }))).toBe("folder");
  });

  it("falls back by kind", () => {
    expect(glyphFor(app("Zyx"))).toBe("globe");
    expect(glyphFor(app("Zyx", { kind: { type: "desktop" } as AppEntry["kind"] }))).toBe("widget");
  });

  it("does not match words inside other words", () => {
    // "Roomba" is not a room.
    expect(glyphFor(app("Roomba"))).toBe("globe");
  });
});

describe("hueFor", () => {
  it("uses the app's own hue first, then the glyph's", () => {
    expect(hueFor(app("Mail", { hue: 200 }))).toBe(200);
    expect(hueFor(app("Mail", { hue: 380 }))).toBe(20);
    expect(hueFor(app("Mail"))).toBe(GLYPH_HUES.mail);
  });
});
