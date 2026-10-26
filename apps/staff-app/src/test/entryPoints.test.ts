import { describe, expect, it } from "vitest";

import appsHtml from "../../apps.html?raw";
import exitHtml from "../../exit.html?raw";
import shellHtml from "../../shell.html?raw";

/**
 * The three HTML pages the Staff App loads (shell, built-in apps, admin exit).
 * Each must declare its language and have a title of its own: a screen reader
 * announces both when a window opens, and Windows shows the title in task lists.
 * The shell and app pages replace the title once they know the screen or file.
 */
const PAGES = ["shell.html", "apps.html", "exit.html"] as const;
const HTML: Record<(typeof PAGES)[number], string> = {
  "shell.html": shellHtml,
  "apps.html": appsHtml,
  "exit.html": exitHtml,
};

function read(page: (typeof PAGES)[number]): string {
  return HTML[page];
}

describe("html entry points", () => {
  for (const page of PAGES) {
    it(`${page} declares a language, a viewport and a title`, () => {
      const html = read(page);
      expect(html).toMatch(/<html lang="en">/);
      expect(html).toMatch(/<meta name="viewport"/);
      expect(html).toMatch(/<title>[^<]*Rulebox[^<]*<\/title>/);
    });
  }

  it("the app window and the administrator exit are not both just 'Rulebox'", () => {
    const titles = PAGES.map((page) => /<title>([^<]*)<\/title>/.exec(read(page))![1]);
    expect(new Set(titles).size).toBe(3);
  });

  it("none of them loads anything from the network", () => {
    for (const page of PAGES) {
      expect(read(page)).not.toMatch(/(?:src|href)="https?:/);
    }
  });
});
