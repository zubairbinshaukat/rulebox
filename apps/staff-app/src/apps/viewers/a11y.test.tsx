import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { call } from "../../lib/tauri";
import { expectNoAxeViolations } from "../../test/axe";
import { CsvTable } from "./CsvTable";
import ImageViewer from "./ImageViewer";
import { TextBody } from "./TextBody";
import { ViewerBanner, ViewerLoading, ViewerMessage } from "./ViewerMessage";

vi.mock("../../lib/tauri", () => ({ call: vi.fn(), isTauri: () => true }));

beforeAll(() => {
  // A layout for jsdom: the picture stage is 800 x 600, and its observer reports once on observe.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: (entries: unknown[]) => void) {}
      observe(target: Element) {
        this.callback([
          {
            target,
            contentRect: { width: 800, height: 600 },
            borderBoxSize: [{ inlineSize: 800, blockSize: 600 }],
          },
        ]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.mocked(call).mockReset();
});

describe("viewer messages", () => {
  it("say a problem as an alert, loading as a status, and a notice banner as a status", async () => {
    const { container } = render(
      <>
        <ViewerMessage title="This file can't be shown." detail="a.pdf" />
        <ViewerLoading label="Loading PDF…" />
        <ViewerBanner>Showing the first part of this sheet.</ViewerBanner>
      </>,
    );
    expect(screen.getByRole("alert").textContent).toContain("This file can't be shown.");
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Loading PDF…"), "Showing the first part of this sheet."]),
    );
    await expectNoAxeViolations(container);
  });
});

describe("text and table viewers", () => {
  it("a short text is a focusable, named region with a visible-focus class", async () => {
    const { container } = render(<TextBody text={"line one\nline two"} />);
    const text = screen.getByLabelText("File contents");
    expect(text.tabIndex).toBe(0);
    expect(text.className).toContain("rb-focus-inset");
    await expectNoAxeViolations(container);
  });

  it("a CSV is a read-only table (not a grid that promises cell navigation), reachable for scrolling", async () => {
    const { container } = render(<CsvTable rows={[["Name", "Total"], ["Maya", "3"]]} />);
    const table = screen.getByRole("table", { name: "Table" });
    expect(table.tabIndex).toBe(0);
    expect(screen.queryByRole("grid")).toBeNull();
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getAllByRole("cell")).toHaveLength(4);
    await expectNoAxeViolations(container);
  });

  it("a spreadsheet's A, B, C header is hidden from screen readers (it is not data)", () => {
    render(<CsvTable letters rows={[["x", "y"]]} />);
    expect(screen.queryByText("A")).not.toBeNull();
    expect(screen.getByText("A").closest('[aria-hidden="true"]')).toBeTruthy();
  });
});

describe("picture viewer", () => {
  beforeEach(() => {
    vi.mocked(call).mockImplementation(async (cmd: string) =>
      cmd === "fs_image_info" ? { width: 4000, height: 3000 } : undefined,
    );
  });

  it("has a named toolbar and a focusable picture that says which keys work", async () => {
    const { container } = render(<ImageViewer path="Pictures/team.png" />);
    const toolbar = await screen.findByRole("toolbar", { name: "Picture" });
    for (const name of ["Zoom out (-)", "Zoom in (+)", "Fit to window (0)", "Actual size (1)"]) {
      const button = within(toolbar).getByRole("button", { name });
      // Plain actions, not toggles.
      expect(button.hasAttribute("aria-pressed")).toBe(false);
    }
    const picture = screen.getByRole("img", { name: /team\.png/ });
    expect(picture.tabIndex).toBe(0);
    expect(picture.getAttribute("aria-label")).toMatch(/arrow keys move/);
    await expectNoAxeViolations(container);
  });

  it("zooms with + and pans with the arrow keys, so a drag is not the only way", async () => {
    const user = userEvent.setup();
    render(<ImageViewer path="Pictures/team.png" />);
    const picture = await screen.findByRole("img", { name: /team\.png/ });
    const shown = () => picture.querySelector("img")?.style.transform ?? "";
    await waitFor(() => expect(shown()).not.toBe(""));

    picture.focus();
    await user.keyboard("1"); // actual size: 4000 x 3000 in an 800 x 600 stage, so there is room to pan
    const actual = shown();
    expect(actual).toContain("scale(1)");
    await user.keyboard("{ArrowLeft}");
    const panned = shown();
    expect(panned).not.toBe(actual);
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(shown()).not.toBe(panned);
    await user.keyboard("0");
    expect(shown()).not.toContain("scale(1)");
  });
});
