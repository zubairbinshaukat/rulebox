import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CsvTable } from "./CsvTable";
import { TextBody } from "./TextBody";
import { columnCount, columnLetter } from "./tableLogic";
import { splitLines, WINDOWED_ABOVE_LINES } from "./textLogic";

// jsdom has no layout: show the first 30 rows the way a real window would.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 30) }, (_, index) => ({
        index,
        start: index * estimateSize(),
        size: estimateSize(),
        end: (index + 1) * estimateSize(),
        key: index,
        lane: 0,
      })),
    getTotalSize: () => count * estimateSize(),
    scrollToIndex: () => undefined,
  }),
}));

describe("CSV and spreadsheet cells are text", () => {
  const evil = `=cmd|' /C calc'!A0`;

  it("shows a formula-looking value as the characters it is, with no markup", () => {
    render(<CsvTable rows={[["Name", "Total"], [evil, "=1+1"], ['<img src=x onerror="alert(1)">', "@SUM(A1)"]]} />);
    const cells = screen.getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toContain(evil);
    expect(cells).toContain("=1+1");
    expect(cells).toContain('<img src=x onerror="alert(1)">');
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
  });

  it("lets the widest row decide the columns and pads short rows", () => {
    render(<CsvTable rows={[["a", "b", "c"], ["1"]]} />);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getAllByRole("cell")).toHaveLength(6);
    expect(columnCount([["a"], ["a", "b", "c"], []])).toBe(3);
    expect(columnCount([])).toBe(0);
  });

  it("says so when the file is empty", () => {
    render(<CsvTable rows={[]} />);
    expect(screen.getByText("This file is empty.")).toBeTruthy();
  });

  it("names spreadsheet columns A, B ... Z, AA, AB", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual([
      "A",
      "B",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
    render(<CsvTable rows={[["x", "y"]]} letters />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("B")).toBeTruthy();
  });
});

describe("text is shown as text, in a window when it is long", () => {
  it("splits on any line ending", () => {
    expect(splitLines("a\r\nb\nc\rd")).toEqual(["a", "b", "c", "d"]);
    expect(splitLines("")).toEqual([]);
  });

  it("puts a short text in one block as text, never as markup", () => {
    const { container } = render(<TextBody text={'<b>bold</b> <script>alert(1)</script>\nline 2'} />);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe('<b>bold</b> <script>alert(1)</script>\nline 2');
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps only the rows in view above 5,000 lines", () => {
    const text = Array.from({ length: WINDOWED_ABOVE_LINES + 1 }, (_, n) => `line ${n}`).join("\n");
    const { container } = render(<TextBody text={text} />);
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.getByLabelText("File contents")).toBeTruthy();
    expect(container.querySelectorAll("div[style*='translateY']").length).toBe(30);
    expect(screen.getByText("line 0")).toBeTruthy();
    expect(screen.queryByText("line 4000")).toBeNull();
  });

  it("stays one block at exactly 5,000 lines", () => {
    const text = Array.from({ length: WINDOWED_ABOVE_LINES }, (_, n) => `line ${n}`).join("\n");
    const { container } = render(<TextBody text={text} />);
    expect(container.querySelector("pre")).not.toBeNull();
  });
});
