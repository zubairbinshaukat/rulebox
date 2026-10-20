// Reading a workbook as text. Used by the worker; kept apart so it can be tested.
import * as XLSX from "xlsx";

export const MAX_ROWS = 2000;
export const MAX_COLUMNS = 100;

export interface SheetData {
  name: string;
  rows: string[][];
}

export type WorkerReply = { ok: true; sheets: SheetData[] } | { ok: false };

/** The sheets of a workbook as text, capped at 2,000 rows by 100 columns each. */
export function readSheets(data: ArrayBuffer): SheetData[] {
  const workbook = XLSX.read(data, {
    type: "array",
    // Rows past the cap are never parsed.
    sheetRows: MAX_ROWS,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    bookVBA: false,
    bookFiles: false,
    password: undefined,
  });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = sheet
      ? XLSX.utils
          .sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true })
          .slice(0, MAX_ROWS)
          .map((row) => row.slice(0, MAX_COLUMNS).map((cell) => String(cell ?? "")))
      : [];
    return { name, rows };
  });
}
