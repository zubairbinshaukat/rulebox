import { describe, expect, it } from "vitest";
import { notesBlocks, plainInline } from "./releaseNotes";

describe("notesBlocks", () => {
  it("headings, bullets and paragraphs, markers stripped", () => {
    const text = [
      "## What's new",
      "",
      "Faster **sign-in** and `kiosk` fixes.",
      "More on the same paragraph.",
      "",
      "### Fixes",
      "- Printing on __shared__ PCs",
      "* Offline sign-in *works* again",
      "1. Numbered item",
      "  - nested item",
      "",
      "Full changelog: [v0.2.1...v0.3.0](https://github.com/x/y/compare/v0.2.1...v0.3.0)",
    ].join("\n");
    expect(notesBlocks(text)).toEqual([
      { kind: "heading", level: 2, text: "What's new" },
      { kind: "paragraph", text: "Faster sign-in and kiosk fixes. More on the same paragraph." },
      { kind: "heading", level: 3, text: "Fixes" },
      { kind: "bullet", text: "Printing on shared PCs" },
      { kind: "bullet", text: "Offline sign-in works again" },
      { kind: "bullet", text: "Numbered item" },
      { kind: "bullet", text: "nested item" },
      { kind: "paragraph", text: "Full changelog: v0.2.1...v0.3.0" },
    ]);
  });

  it("# is level 1, deeper than three is level 3, a closing # run is dropped", () => {
    expect(notesBlocks("# One #\n###### Six")).toEqual([
      { kind: "heading", level: 1, text: "One" },
      { kind: "heading", level: 3, text: "Six" },
    ]);
  });

  it("scripts, images, links and HTML become plain text or nothing; no tag survives", () => {
    const blocks = notesBlocks(
      [
        "<script>alert(1)</script>Safe text",
        "![logo](https://evil.example.com/x.png) after image",
        "[click me](javascript:alert(1)) and <b>bold</b> and <img src=x onerror=alert(1)>",
        "<style>body{display:none}</style>",
        "<!-- a comment --> visible",
        "<https://example.com/page>",
      ].join("\n\n"),
    );
    expect(blocks).toEqual([
      { kind: "paragraph", text: "Safe text" },
      { kind: "paragraph", text: "after image" },
      { kind: "paragraph", text: "click me and bold and" },
      { kind: "paragraph", text: "visible" },
      { kind: "paragraph", text: "https://example.com/page" },
    ]);
    const all = JSON.stringify(blocks);
    expect(all).not.toMatch(/<|javascript:|onerror|alert/);
  });

  it("an unterminated script or comment swallows only what follows it", () => {
    expect(notesBlocks("before <script>alert(1)")).toEqual([{ kind: "paragraph", text: "before" }]);
    expect(notesBlocks("before <!-- never closed")).toEqual([{ kind: "paragraph", text: "before" }]);
  });

  it("task boxes, block quotes, code fences and rules are dropped, their text kept", () => {
    expect(notesBlocks("- [x] done item\n- [ ] open item\n> quoted words\n```\nconst a = 1;\n```\n---\n***\nend")).toEqual([
      { kind: "bullet", text: "done item" },
      { kind: "bullet", text: "open item" },
      { kind: "paragraph", text: "quoted words" },
      { kind: "paragraph", text: "const a = 1;" },
      { kind: "paragraph", text: "end" },
    ]);
  });

  it("entities that would hide markup stay text: &lt;script&gt; is shown as the characters", () => {
    expect(notesBlocks("Use &lt;b&gt; &amp; more")).toEqual([{ kind: "paragraph", text: "Use <b> & more" }]);
  });

  it("empty, blank or marker-only notes give no blocks; CRLF is read like LF", () => {
    expect(notesBlocks("")).toEqual([]);
    expect(notesBlocks("  \n\n \n")).toEqual([]);
    expect(notesBlocks("##\n- \n**")).toEqual([{ kind: "paragraph", text: "**" }]);
    expect(notesBlocks("a\r\n\r\n- b")).toEqual([
      { kind: "paragraph", text: "a" },
      { kind: "bullet", text: "b" },
    ]);
  });

  it("underscores inside words (file names) and a lone star are kept", () => {
    expect(plainInline("use snake_case_name and 2 * 3 = 6")).toBe("use snake_case_name and 2 * 3 = 6");
    expect(plainInline("Rulebox-0.3.0-x64.msi")).toBe("Rulebox-0.3.0-x64.msi");
  });
});
