/** Column 0 is A, 25 is Z, 26 is AA. */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** The widest row decides the columns. */
export function columnCount(rows: readonly (readonly string[])[]): number {
  return rows.reduce((most, row) => Math.max(most, row.length), 0);
}
