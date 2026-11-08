// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css =
  readFileSync(new URL("../../../../packages/ui/src/components.css", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../../../../packages/ui/src/components-staff.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector list contains `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[,\\n])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "m").exec(css);
  return match?.[1] ?? "";
}

describe("hover states in the Files window and the My files panel", () => {
  it.each([".rb-file-row:hover", ".rb-nav-btn:hover", ".rb-crumb:hover"])("%s tints the background", (selector) => {
    expect(rule(selector)).toMatch(/background:\s*color-mix/);
  });

  it("a hovered card and a hovered panel row change colour, not only the pointer", () => {
    expect(rule(".rb-file-card:hover:not([aria-selected=\"true\"])")).toMatch(/background:/);
    expect(rule(".rb-panel-row:hover")).toMatch(/background:\s*var\(--rb-accent-soft\)/);
  });

  it("a selected row keeps its tint and shows a line on hover", () => {
    expect(rule(".rb-file-row[aria-selected=\"true\"]:hover")).toMatch(/box-shadow:/);
  });

  it("hover is static: nothing here transitions or animates a colour", () => {
    const block = css.slice(css.indexOf("Files: rows, cards"), css.indexOf("/* Dialog */"));
    expect(block).not.toMatch(/transition|animation/);
  });
});
