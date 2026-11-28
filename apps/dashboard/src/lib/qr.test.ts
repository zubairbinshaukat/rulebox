import { describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";
import { makeQr, qrPath, QR_QUIET_ZONE, qrSvg } from "./qr";

// An enrollment code: "RBX1." + base64url("https://<deployment>.convex.cloud#<20 characters>"), about 80 characters.
const CODE = `RBX1.${btoa("https://happy-animal-123.convex.cloud#0123456789ABCDEFGHJK").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

/** The dark modules of a path made by `qrPath`, as "row,col" keys without the quiet zone. */
function darkSet(path: string, margin = QR_QUIET_ZONE): Set<string> {
  const out = new Set<string>();
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const col = Number(m[1]) - margin;
    const row = Number(m[2]) - margin;
    for (let i = 0; i < Number(m[3]); i++) out.add(`${row},${col + i}`);
  }
  return out;
}

describe("makeQr", () => {
  it("an enrollment code (~80 characters) fits version 5 (37 modules per side); a longer deployment name version 6 (41)", async () => {
    expect(CODE.length).toBe(83);
    const qr = await makeQr(CODE);
    expect(qr.size).toBe(37);
    expect(qr.viewBox).toBe(37 + 2 * QR_QUIET_ZONE);
    // 90 characters: over the 84 bytes of version 5 at level M.
    expect((await makeQr(`${CODE}1234567`)).size).toBe(41);
  });

  it("the same text gives the same picture, another text another one", async () => {
    const a = await makeQr(CODE);
    const b = await makeQr(CODE);
    expect(b).toEqual(a);
    expect((await makeQr(`${CODE.slice(0, -1)}X`)).path).not.toBe(a.path);
  });

  it("the path is exactly the encoder's own modules, shifted by the quiet zone", async () => {
    const qr = await makeQr(CODE);
    const reference = qrcode(0, "M");
    reference.addData(CODE);
    reference.make();
    expect(reference.getModuleCount()).toBe(qr.size);
    const expected = new Set<string>();
    for (let r = 0; r < qr.size; r++) for (let c = 0; c < qr.size; c++) if (reference.isDark(r, c)) expected.add(`${r},${c}`);
    expect(darkSet(qr.path)).toEqual(expected);
    expect(expected.size).toBeGreaterThan(300); // a real picture, not an empty one
  });

  it("has the three finder squares and keeps the quiet zone empty", async () => {
    const qr = await makeQr(CODE);
    const dark = darkSet(qr.path);
    const last = qr.size - 1;
    for (const [r, c] of [
      [0, 0],
      [0, last],
      [last, 0],
    ] as const) {
      const dr = r === 0 ? 1 : -1;
      const dc = c === 0 ? 1 : -1;
      // the 7 x 7 ring is dark, its inner ring is light, the 3 x 3 centre is dark
      for (let i = 0; i < 7; i++) {
        expect(dark.has(`${r},${c + dc * i}`)).toBe(true);
        expect(dark.has(`${r + dr * 6},${c + dc * i}`)).toBe(true);
      }
      expect(dark.has(`${r + dr},${c + dc}`)).toBe(false);
      expect(dark.has(`${r + dr * 3},${c + dc * 3}`)).toBe(true);
    }
    for (const m of qr.path.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(Number(m[2])).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(Number(m[1]) + Number(m[3])).toBeLessThanOrEqual(QR_QUIET_ZONE + qr.size);
    }
  });

  it("a higher error correction level needs more modules", async () => {
    const m = await makeQr(CODE, "M");
    const h = await makeQr(CODE, "H");
    expect(h.size).toBeGreaterThan(m.size);
  });

  it("any text works as UTF-8, and a text that is far too long throws", async () => {
    expect((await makeQr("Grüße 😀")).size).toBeGreaterThanOrEqual(21);
    await expect(makeQr("x".repeat(5000))).rejects.toThrow();
  });
});

describe("qrPath", () => {
  it("merges runs in a row and offsets by the margin", () => {
    // ##.#
    // ....
    // .###
    const grid = ["##.#", "....", ".###", "...."];
    expect(qrPath((r, c) => grid[r]![c] === "#", 4, 2)).toBe("M2 2h2v1h-2zM5 2h1v1h-1zM3 4h3v1h-3z");
    expect(qrPath(() => false, 3)).toBe("");
  });
});

describe("qrSvg", () => {
  it("is an image with its label, black on white", async () => {
    const qr = await makeQr(CODE);
    const svg = qrSvg(qr, "QR code of the enrollment code");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="QR code of the enrollment code"');
    expect(svg).toContain(`viewBox="0 0 ${qr.viewBox} ${qr.viewBox}"`);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
    expect(svg).toContain(`d="${qr.path}"`);
    expect(svg).not.toContain(CODE); // the picture never carries the code as text
  });

  it("escapes the label", async () => {
    const svg = qrSvg({ size: 1, viewBox: 9, path: "" }, 'a "b" <c> & d');
    expect(svg).toContain('aria-label="a &quot;b&quot; &lt;c&gt; &amp; d"');
  });

  it("is deterministic", async () => {
    const qr = await makeQr(CODE);
    expect(qrSvg(qr, "x")).toBe(qrSvg(await makeQr(CODE), "x"));
  });
});
