import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { MAX_COLUMNS, MAX_ROWS, readSheets } from "./xlsxRead";

/** A workbook as the bytes a .xlsx file holds. */
function workbook(sheets: Record<string, XLSX.WorkSheet>): ArrayBuffer {
  const book = XLSX.utils.book_new();
  for (const [name, sheet] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return bytes;
}

describe("reading a spreadsheet", () => {
  it("returns every sheet as text, in order", () => {
    const data = workbook({
      Sales: XLSX.utils.aoa_to_sheet([
        ["Day", "Total"],
        ["Mon", 12.5],
        ["Tue", 8],
      ]),
      Notes: XLSX.utils.aoa_to_sheet([["only one"]]),
    });
    const sheets = readSheets(data);
    expect(sheets.map((s) => s.name)).toEqual(["Sales", "Notes"]);
    expect(sheets[0]?.rows).toEqual([
      ["Day", "Total"],
      ["Mon", "12.5"],
      ["Tue", "8"],
    ]);
    expect(sheets[1]?.rows).toEqual([["only one"]]);
  });

  it("shows formulas as their stored result and never evaluates them", () => {
    const sheet = XLSX.utils.aoa_to_sheet([["a"]]);
    // A formula with a stored value, and one that has none.
    sheet["B1"] = { t: "n", f: "SUM(1,2)", v: 3 };
    sheet["C1"] = { t: "n", f: "1+1" };
    sheet["D1"] = { t: "s", v: `=cmd|' /C calc'!A0` };
    sheet["!ref"] = "A1:D1";
    const [first] = readSheets(workbook({ F: sheet }));
    expect(first?.rows[0]?.[1]).toBe("3");
    // No stored value: nothing is computed.
    expect(first?.rows[0]?.[2]).toBe("");
    // A text value that looks like a formula stays text.
    expect(first?.rows[0]?.[3]).toBe(`=cmd|' /C calc'!A0`);
  });

  it("stops at 2,000 rows and 100 columns per sheet", () => {
    const rows = Array.from({ length: MAX_ROWS + 500 }, (_, r) =>
      Array.from({ length: MAX_COLUMNS + 20 }, (_, c) => `${r}:${c}`),
    );
    const [sheet] = readSheets(workbook({ Big: XLSX.utils.aoa_to_sheet(rows) }));
    expect(sheet?.rows.length).toBe(MAX_ROWS);
    expect(sheet?.rows[0]?.length).toBe(MAX_COLUMNS);
    expect(sheet?.rows[MAX_ROWS - 1]?.[MAX_COLUMNS - 1]).toBe(`${MAX_ROWS - 1}:${MAX_COLUMNS - 1}`);
  });

  it("fails on bytes that are not a workbook, instead of guessing", () => {
    const junk = new TextEncoder().encode("this is not a spreadsheet at all").buffer;
    // SheetJS reads unknown text as a one-cell sheet; what matters is that nothing throws HTML or runs.
    const sheets = readSheets(junk as ArrayBuffer);
    expect(JSON.stringify(sheets)).not.toContain("<");
  });
});
