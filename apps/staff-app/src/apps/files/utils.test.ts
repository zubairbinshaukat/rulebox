// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Entry } from "@rulebox/types";

import { AUDIO_EXTS, DOC_EXTS, IMAGE_EXTS, VIDEO_EXTS, filterEntriesBySection } from "./utils";

const RUST = readFileSync(new URL("../../../src-tauri/src/files/types.rs", import.meta.url), "utf8");

/** The quoted strings of one `const NAME: &[&str] = &[ ... ];` in types.rs. */
function rustList(name: string): string[] {
  const body = new RegExp(`${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(RUST)?.[1];
  if (body === undefined) {
    throw new Error(`${name} not found in types.rs`);
  }
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const file = (name: string): Entry => ({ name, path: name, kind: "file", size: 1, modifiedMs: 1 });

describe("file kinds keep in step with the backend (PRD 7.3: one rule)", () => {
  const sorted = (set: Set<string>) => [...set].sort();

  it("the extension lists equal FileKind's lists in types.rs", () => {
    expect(sorted(DOC_EXTS)).toEqual(rustList("DOCUMENT_EXTS"));
    expect(sorted(AUDIO_EXTS)).toEqual(rustList("AUDIO_EXTS"));
    expect(sorted(VIDEO_EXTS)).toEqual(rustList("VIDEO_EXTS"));
    expect(sorted(IMAGE_EXTS)).toEqual(rustList("IMAGE_EXTS"));
  });

  it("no kind lists an extension the backend deny-list refuses to open", () => {
    const deny = new Set(rustList("DENY"));
    for (const set of [DOC_EXTS, AUDIO_EXTS, VIDEO_EXTS, IMAGE_EXTS]) {
      for (const ext of set) {
        expect(deny.has(ext), ext).toBe(false);
      }
    }
  });

  it("a category hides a renamed executable and an SVG, also among search results", () => {
    const entries = [file("notes.txt"), file("notes.exe"), file("logo.svg"), file("pic.png")];
    expect(filterEntriesBySection(entries, "documents").map((e) => e.name)).toEqual(["notes.txt"]);
    expect(filterEntriesBySection(entries, "images").map((e) => e.name)).toEqual(["pic.png"]);
  });

  it("a place (All files) still shows every file, so it can be renamed or deleted", () => {
    const entries = [file("notes.exe"), file("notes.txt")];
    expect(filterEntriesBySection(entries, "all")).toEqual(entries);
  });
});
