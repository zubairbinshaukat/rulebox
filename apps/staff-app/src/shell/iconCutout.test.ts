import { describe, expect, it } from "vitest";

import { analyzePixels, type Pixels } from "./iconAnalysis";
import { cropSquare, cutoutBounds, iconFit, LOGO_MARGIN, makeCutout, MAX_CUTOUT_SIDE, recolorFor, type Cutout } from "./iconCutout";
import { readPng } from "./testPng";

type Rgba = [number, number, number, number];

function icon(size: number, paint: (x: number, y: number) => Rgba): Pixels {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) data.set(paint(x, y), (y * size + x) * 4);
  return { width: size, height: size, data };
}

const here = import.meta.url;
const shipped = (name: string) => readPng(new URL(["..", "..", "..", "agent", "assets", "icons", `${name}.png`].join("/"), here));

/** `cut` composited over a flat plate colour: what a small icon looks like on that plate. */
function over(cut: Cutout, plate: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(cut.side * cut.side * 3);
  for (let i = 0; i < cut.side * cut.side; i += 1) {
    const a = (cut.data[i * 4 + 3] ?? 0) / 255;
    for (let c = 0; c < 3; c += 1) out[i * 3 + c] = (cut.data[i * 4 + c] ?? 0) * a + (plate[c] ?? 0) * (1 - a);
  }
  return out;
}

describe("cropSquare", () => {
  it("is a square centred on the logo's box, with the margin on each side of its longer side", () => {
    const square = cropSquare({ bounds: { left: 0.25, top: 0.4, right: 0.75, bottom: 0.6 } }, { width: 200, height: 100 });
    // The box is 100 x 20 px, so the longer side is 100 px and the square is 100 / (1 - 2 * margin).
    expect(square?.side).toBeCloseTo(100 / (1 - 2 * LOGO_MARGIN), 6);
    expect((square?.x ?? 0) + (square?.side ?? 0) / 2).toBeCloseTo(100, 6);
    expect((square?.y ?? 0) + (square?.side ?? 0) / 2).toBeCloseTo(50, 6);
  });

  it("has nothing to crop without a logo box", () => {
    expect(cropSquare({ bounds: null }, { width: 10, height: 10 })).toBeNull();
  });
});

describe("makeCutout", () => {
  const disc = (x: number, y: number, r = 20) => (x - 40) ** 2 + (y - 40) ** 2 <= r * r;
  // A small disc in a big padded square, like a catalogue icon.
  const padded = icon(128, (x, y) => (disc(x - 24, y - 24, 14) ? [20, 20, 20, 255] : [242, 240, 230, 255]));

  it("enlarges a small logo in a padded keyed icon to fill the box", () => {
    const analysis = analyzePixels(padded);
    expect(analysis.kind).toBe("keyed");
    const cut = makeCutout(padded, analysis);
    expect(cut).not.toBeNull();
    const box = cutoutBounds(cut as Cutout);
    expect(box).not.toBeNull();
    const width = (box?.right ?? 0) - (box?.left ?? 0);
    expect(width).toBeGreaterThan(0.9);
    expect(width).toBeLessThan(0.97);
    // The logo is centred and its background is clear.
    expect(((box?.left ?? 0) + (box?.right ?? 0)) / 2).toBeCloseTo(0.5, 1);
    expect(cut?.data[3]).toBe(0);
  });

  it("is a square, keeps the logo's aspect ratio and never exceeds 256 px", () => {
    const wide = icon(512, (x, y) => (x > 100 && x < 400 && y > 230 && y < 290 ? [10, 80, 200, 255] : [0, 0, 0, 0]));
    const cut = makeCutout(wide, analyzePixels({ ...wide, data: wide.data }));
    expect(cut?.side).toBe(MAX_CUTOUT_SIDE);
    const box = cutoutBounds(cut as Cutout);
    const w = (box?.right ?? 0) - (box?.left ?? 0);
    const h = (box?.bottom ?? 0) - (box?.top ?? 0);
    // 300 x 60 px in the source: 5 to 1, still, and it spans most of the width.
    expect(w / h).toBeCloseTo(5, 0);
    expect(w).toBeGreaterThan(0.9);
  });

  it("an icon that is a picture has no cut-out", () => {
    const picture = icon(64, (x) => [Math.round((x / 64) * 255), 90, 160, 255]);
    expect(makeCutout(picture, analyzePixels(picture))).toBeNull();
  });

  it("picks the picture fit from the cut-out and the kind", () => {
    expect(iconFit({ kind: "keyed", cutout: "blob:x" })).toBe("logo");
    expect(iconFit({ kind: "transparent", cutout: "blob:x" })).toBe("logo");
    expect(iconFit({ kind: "transparent" })).toBe("inset");
    expect(iconFit({ kind: "keyed" })).toBe("cover");
    expect(iconFit({ kind: "opaque" })).toBe("cover");
    expect(iconFit(undefined)).toBe("cover");
  });
});

describe("the shipped icons (apps/agent/assets/icons) fill their small icon box", () => {
  it("only a logo that would vanish on a theme is recoloured: the black Z on dark, not the wallet or the lavender Z", async () => {
    const recolors: Record<string, string | undefined> = {};
    for (const name of ["zubyr", "batwa", "zahras-pos"]) recolors[name] = recolorFor(analyzePixels(await shipped(name)).luma);
    expect(recolors).toEqual({ zubyr: "dark-logo", batwa: undefined, "zahras-pos": undefined });
    expect(recolorFor(0.9)).toBe("light-logo");
    expect(recolorFor(0.3)).toBeUndefined();
  });

  it("Zubyr recoloured for the dark theme (inverted, as the CSS filter does) is a light Z with no box and no dark rim", async () => {
    const cut = makeCutout(await shipped("zubyr"), analyzePixels(await shipped("zubyr"))) as Cutout;
    const inverted: Cutout = { side: cut.side, data: cut.data.map((v, i) => (i % 4 === 3 ? v : 255 - v)) };
    // The dark theme's surface, roughly (oklch 0.215 0.024 258).
    const plate: [number, number, number] = [26, 30, 40];
    const onDark = over(inverted, plate);
    let light = 0;
    for (let i = 0; i < onDark.length; i += 3) {
      // Every pixel is the plate or lighter: no darker fringe of the old black round the light Z.
      expect(onDark[i] ?? 0).toBeGreaterThanOrEqual(plate[0] - 1);
      if ((onDark[i] ?? 0) > 200) light += 1;
    }
    expect(light / (cut.side * cut.side)).toBeGreaterThan(0.3);
    // No box: the corners are the plate itself.
    expect([onDark[0], onDark[1], onDark[2]]).toEqual(plate);
  });

  for (const name of ["zubyr", "batwa", "zahras-pos"]) {
    it(`${name}: the logo's box fills at least 90% of the output`, async () => {
      const source = await shipped(name);
      const analysis = analyzePixels(source);
      const cut = makeCutout(source, analysis);
      expect(cut, `${name} is cut out`).not.toBeNull();
      const box = cutoutBounds(cut as Cutout);
      const w = (box?.right ?? 0) - (box?.left ?? 0);
      const h = (box?.bottom ?? 0) - (box?.top ?? 0);
      expect(Math.max(w, h)).toBeGreaterThanOrEqual(0.9);
      expect(Math.max(w, h)).toBeLessThanOrEqual(0.97);
      // Well centred, and the output is crisp (at 2x of the biggest small icon) and square.
      expect(((box?.left ?? 0) + (box?.right ?? 0)) / 2).toBeGreaterThan(0.45);
      expect(((box?.left ?? 0) + (box?.right ?? 0)) / 2).toBeLessThan(0.55);
      expect(cut?.side).toBeGreaterThanOrEqual(128);
      expect(cut?.side).toBeLessThanOrEqual(MAX_CUTOUT_SIDE);
      // No square of the old background: all four corners are transparent.
      const last = (cut?.side ?? 1) - 1;
      for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]] as const) {
        expect(cut?.data[(y * (cut?.side ?? 1) + x) * 4 + 3], `${name} corner ${x},${y}`).toBe(0);
      }
    });
  }

  it("Zubyr: the Z keeps its black and leaves no cream halo on a dark plate", async () => {
    const cut = makeCutout(await shipped("zubyr"), analyzePixels(await shipped("zubyr"))) as Cutout;
    const black = over(cut, [0, 0, 0]);
    // Every pixel is the Z's own near-black or the plate: no cream edge shows on the dark plate.
    let brightest = 0;
    for (const v of black) brightest = Math.max(brightest, v);
    expect(brightest).toBeLessThan(60);
    // On the cream plate (the icon's own background) the Z is still black with no ring round it.
    const cream = over(cut, [242, 240, 230]);
    let darkPixels = 0;
    for (let i = 0; i < cream.length; i += 3) if ((cream[i] ?? 255) < 80) darkPixels += 1;
    expect(darkPixels / (cut.side * cut.side)).toBeGreaterThan(0.3);
    expect(cream[0]).toBe(242);
    // The Z's own pixels are reproduced: no pixel is lighter than cream or off its hue.
    for (let i = 0; i < cream.length; i += 3) expect(cream[i] ?? 0).toBeLessThanOrEqual(243);
  });

  it("Batwa: the wallet keeps its purple and the lavender square is gone", async () => {
    const source = await shipped("batwa");
    const cut = makeCutout(source, analyzePixels(source)) as Cutout;
    const side = cut.side;
    expect(cut.data[3]).toBe(0);
    const centre = (Math.floor(side / 2) * side + Math.floor(side / 2)) * 4;
    expect(cut.data[centre + 3]).toBe(255);
    // Purple: more blue than red, and not the pale lavender of the background.
    expect(cut.data[centre + 2]).toBeGreaterThan(cut.data[centre] ?? 0);
    expect(cut.data[centre] ?? 255).toBeLessThan(200);
    // Over a white plate no lavender tint is left round the wallet (the rim blends to white).
    const white = over(cut, [255, 255, 255]);
    expect(white[0]).toBe(255);
  });

  it("Zahras POS: the transparent Z keeps both its colours (lavender Z, orange sparkle)", async () => {
    const source = await shipped("zahras-pos");
    const cut = makeCutout(source, analyzePixels(source)) as Cutout;
    let orange = 0;
    let lavender = 0;
    for (let i = 0; i < cut.side * cut.side; i += 1) {
      const [r, g, b, a] = [cut.data[i * 4] ?? 0, cut.data[i * 4 + 1] ?? 0, cut.data[i * 4 + 2] ?? 0, cut.data[i * 4 + 3] ?? 0];
      if (a < 250) continue;
      if (r > 220 && g > 150 && g < 190 && b < 150) orange += 1;
      if (b > 190 && r > 150 && r < 200 && g < 170) lavender += 1;
    }
    expect(orange).toBeGreaterThan(50);
    expect(lavender).toBeGreaterThan(500);
  });
});
