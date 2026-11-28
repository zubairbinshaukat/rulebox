/**
 * QR codes, made in this browser (UI pass, enrollment plan 3.4): the "QR code" button of Add a PC shows the enrollment code, and
 * nothing else, as a picture a phone can scan. The encoder (`qrcode-generator`, MIT, bundled: offline-first) is imported only when a code
 * is drawn, so it is a chunk of its own that the first page never loads. Nothing here stores or logs the text.
 */

/** Error correction: M (about 15 % can be damaged) is plenty for a screen. The ~80 character enrollment code fits version 6 (41 modules). */
export type QrLevel = "L" | "M" | "Q" | "H";

/** The quiet zone every QR code needs around it, in modules (the specification asks for 4). */
export const QR_QUIET_ZONE = 4;

export interface QrCode {
  /** Modules per side, without the quiet zone (17 + 4 x version). */
  size: number;
  /** Side of the picture in modules, quiet zone included: the SVG's `viewBox` is `0 0 viewBox viewBox`. */
  viewBox: number;
  /** One path of the dark modules (runs of modules in a row): `M x y h w v1 h-w z` per run. Empty for no dark module. */
  path: string;
}

interface Factory {
  (typeNumber: number, level: QrLevel): { addData(data: string): void; make(): void; getModuleCount(): number; isDark(row: number, col: number): boolean };
}

/** The encoder, however the bundler wraps its CommonJS export (`default` or the module itself). */
async function loadEncoder(): Promise<Factory> {
  const mod = (await import("qrcode-generator")) as unknown as { default?: Factory } & Factory;
  return mod.default ?? mod;
}

/** Turns a matrix of dark modules (rows of columns) into the path of `QrCode`, offset by the quiet zone. Pure. */
export function qrPath(isDark: (row: number, col: number) => boolean, size: number, margin = QR_QUIET_ZONE): string {
  const parts: string[] = [];
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!isDark(row, col)) {
        col++;
        continue;
      }
      let end = col;
      while (end < size && isDark(row, end)) end++;
      parts.push(`M${col + margin} ${row + margin}h${end - col}v1h-${end - col}z`);
      col = end;
    }
  }
  return parts.join("");
}

/**
 * The QR code of `text` (UTF-8 bytes; the smallest version that fits). Throws when the text is too long for any version at this level
 * (more than ~2,300 bytes at M) or when the encoder cannot be loaded (the caller shows its own sentence: "Copy the code instead").
 */
export async function makeQr(text: string, level: QrLevel = "M"): Promise<QrCode> {
  const factory = await loadEncoder();
  const qr = factory(0, level);
  // The encoder writes one byte per character (Latin-1): hand it the UTF-8 bytes as characters, so any text comes out as UTF-8.
  qr.addData(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""));
  qr.make();
  const size = qr.getModuleCount();
  return { size, viewBox: size + 2 * QR_QUIET_ZONE, path: qrPath((r, c) => qr.isDark(r, c), size) };
}

/**
 * The code as an SVG document for `aria-label`led display or a download. Black on white on purpose (not theme tokens): scanners need
 * the contrast and a light quiet zone also in the dark theme.
 */
export function qrSvg(qr: QrCode, label: string): string {
  const safe = label.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.viewBox} ${qr.viewBox}" role="img" aria-label="${safe}" shape-rendering="crispEdges">` +
    `<rect width="${qr.viewBox}" height="${qr.viewBox}" fill="#fff"/><path d="${qr.path}" fill="#000"/></svg>`
  );
}
