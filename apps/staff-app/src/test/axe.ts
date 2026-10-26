import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe-core on `root` and fails with a readable list when it finds a
 * violation. jsdom has no layout or painting, so two kinds of rule cannot run
 * and are left to other checks: colour contrast (see `contrast.test.ts` for the
 * design tokens) and "all content in a landmark" (the shell windows are single
 * screens, and the landmark rule needs a full page).
 */
export async function expectNoAxeViolations(root: Element = document.body): Promise<void> {
  const results = await axe.run(root, {
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  const report = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n` +
      violation.nodes.map((node) => `    ${node.html.slice(0, 160)}`).join("\n"),
  );
  expect(report, report.join("\n")).toEqual([]);
}
