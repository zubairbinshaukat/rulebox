import { describe, expect, it } from "vitest";

import { analyzePixels, type Pixels } from "./iconAnalysis";
import { readPng } from "./testPng";

type Rgba = [number, number, number, number];

/** A `size` x `size` icon: every pixel is `paint(x, y)`. */
function icon(size: number, paint: (x: number, y: number) => Rgba): Pixels {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) data.set(paint(x, y), (y * size + x) * 4);
  }
  return { width: size, height: size, data };
}

const SIZE = 64;
const inCircle = (x: number, y: number, r = 20) => (x - 32) ** 2 + (y - 32) ** 2 <= r * r;
const inRing = (x: number, y: number) => inCircle(x, y, 22) && !inCircle(x, y, 10);
const at = (alpha: Uint8Array | null, x: number, y: number) => (alpha ? alpha[y * SIZE + x] : undefined);

describe("analyzePixels", () => {
  it("a logo on clear pixels is transparent and its alpha is the silhouette", () => {
    const result = analyzePixels(icon(SIZE, (x, y) => (inCircle(x, y) ? [200, 160, 240, 255] : [0, 0, 0, 0])));
    expect(result.kind).toBe("transparent");
    expect(at(result.alpha, 32, 32)).toBe(255);
    expect(at(result.alpha, 1, 1)).toBe(0);
    expect(result.edge).toBeNull();
  });

  it("tells a light logo (dark plate) from a dark one (light plate)", () => {
    const light = analyzePixels(icon(SIZE, (x, y) => (inCircle(x, y) ? [240, 230, 255, 255] : [0, 0, 0, 0])));
    const dark = analyzePixels(icon(SIZE, (x, y) => (inCircle(x, y) ? [20, 20, 30, 255] : [0, 0, 0, 0])));
    expect(light.tone).toBe("light");
    expect(dark.tone).toBe("dark");
  });

  it("keeps the soft edge of a transparent logo", () => {
    const result = analyzePixels(
      icon(SIZE, (x, y) => (inCircle(x, y) ? [0, 0, 0, 255] : inCircle(x, y, 21) ? [0, 0, 0, 90] : [0, 0, 0, 0])),
    );
    expect(result.kind).toBe("transparent");
    const rim = Array.from(result.alpha ?? []).filter((a) => a > 0 && a < 255);
    expect(rim.length).toBeGreaterThan(0);
  });

  it("a logo on a flat opaque square is keyed: the background becomes clear, the logo stays", () => {
    const result = analyzePixels(icon(SIZE, (x, y) => (inCircle(x, y) ? [20, 20, 20, 255] : [242, 240, 230, 255])));
    expect(result.kind).toBe("keyed");
    expect(at(result.alpha, 1, 1)).toBe(0);
    expect(at(result.alpha, 62, 62)).toBe(0);
    expect(at(result.alpha, 32, 32)).toBe(255);
    expect(result.edge).toBe("rgb(242 240 230)");
  });

  it("clears the hole of a letter that the edge cannot reach", () => {
    const result = analyzePixels(icon(SIZE, (x, y) => (inRing(x, y) ? [30, 20, 100, 255] : [250, 250, 250, 255])));
    expect(result.kind).toBe("keyed");
    expect(at(result.alpha, 32, 32)).toBe(0); // inside the ring
    expect(at(result.alpha, 32, 32 - 16)).toBe(255); // the ring itself
  });

  it("keys a light background out of a light logo's edge softly, not as a hard cut", () => {
    const result = analyzePixels(
      icon(SIZE, (x, y) => (inCircle(x, y) ? [20, 20, 20, 255] : inCircle(x, y, 22) ? [140, 140, 140, 255] : [255, 255, 255, 255])),
    );
    expect(result.kind).toBe("keyed");
    // The grey anti-alias ring is not the background (distance above the reach): it stays.
    expect(at(result.alpha, 32 + 21, 32)).toBe(255);
  });

  it("a plate with clear rounded corners is keyed, not transparent", () => {
    const corner = (x: number, y: number) => Math.min(x, SIZE - 1 - x) + Math.min(y, SIZE - 1 - y) < 6;
    const result = analyzePixels(
      icon(SIZE, (x, y) => (corner(x, y) ? [0, 0, 0, 0] : inCircle(x, y) ? [255, 255, 255, 255] : [99, 72, 235, 255])),
    );
    expect(result.kind).toBe("keyed");
    expect(at(result.alpha, 0, 0)).toBe(0);
    expect(at(result.alpha, 32, 32)).toBe(255);
    expect(at(result.alpha, 5, 32)).toBe(0); // the plate colour on the edge
  });

  it("a picture without a flat border is opaque: no silhouette", () => {
    const gradient = analyzePixels(icon(SIZE, (x) => [Math.round((x / SIZE) * 255), 90, 160, 255]));
    expect(gradient.kind).toBe("opaque");
    expect(gradient.alpha).toBeNull();
    expect(gradient.edge).toBeNull();
    const noise = analyzePixels(icon(SIZE, (x, y) => [(x * 37 + y * 11) % 256, (x * 5 + y * 91) % 256, (x * 71) % 256, 255]));
    expect(noise.kind).toBe("opaque");
  });

  it("one flat colour with no logo, or an empty image, has nothing to draw", () => {
    expect(analyzePixels(icon(SIZE, () => [10, 120, 90, 255])).kind).toBe("opaque");
    expect(analyzePixels(icon(SIZE, () => [0, 0, 0, 0])).kind).toBe("opaque");
    expect(analyzePixels({ width: 1, height: 1, data: [1, 2, 3, 255] }).kind).toBe("opaque");
  });

  it("reports the logo's bounding box (fractions of the image), for transparent and keyed icons", () => {
    // A 40 x 40 disc centred at (32, 32) in a 64 px icon spans 12..52 (inclusive 12 and 52).
    const transparent = analyzePixels(icon(SIZE, (x, y) => (inCircle(x, y) ? [200, 160, 240, 255] : [0, 0, 0, 0])));
    expect(transparent.bounds?.left).toBeCloseTo(12 / SIZE, 6);
    expect(transparent.bounds?.right).toBeCloseTo(53 / SIZE, 6);
    expect(transparent.bounds?.top).toBeCloseTo(12 / SIZE, 6);
    expect(transparent.bounds?.bottom).toBeCloseTo(53 / SIZE, 6);
    const keyed = analyzePixels(icon(SIZE, (x, y) => (inCircle(x, y) ? [20, 20, 20, 255] : [242, 240, 230, 255])));
    expect(keyed.bounds).toEqual(transparent.bounds);
    expect(keyed.background).toEqual([242, 240, 230]);
    expect(transparent.background).toBeNull();
  });

  it("ignores a faint shadow when it boxes the logo, and a picture has no box", () => {
    const shadow = analyzePixels(
      icon(SIZE, (x, y) => (inCircle(x, y, 14) ? [0, 0, 0, 255] : inCircle(x, y, 28) ? [0, 0, 0, 30] : [0, 0, 0, 0])),
    );
    expect(shadow.kind).toBe("transparent");
    expect(shadow.bounds?.left).toBeCloseTo(18 / SIZE, 6);
    expect(analyzePixels(icon(SIZE, (x) => [Math.round((x / SIZE) * 255), 90, 160, 255])).bounds).toBeNull();
  });

  it("is deterministic", () => {
    const pixels = icon(SIZE, (x, y) => (inCircle(x, y) ? [20, 20, 20, 255] : [242, 240, 230, 255]));
    expect(analyzePixels(pixels)).toEqual(analyzePixels(pixels));
  });
});

describe("the demo icons (apps/agent/assets/icons)", () => {
  // `new URL(<template>, import.meta.url)` would be taken by Vite for an asset import.
  const here = import.meta.url;
  const load = (name: string) => readPng(new URL(["..", "..", "..", "agent", "assets", "icons", `${name}.png`].join("/"), here));
  const share = (alpha: Uint8Array | null) =>
    alpha ? Array.from(alpha).reduce((sum, a) => sum + a, 0) / (255 * alpha.length) : 0;

  it("Zubyr (black Z on a cream square) is keyed and its silhouette is the Z alone", async () => {
    const result = analyzePixels(await load("zubyr"));
    expect(result.kind).toBe("keyed");
    expect(result.edge).toBe("rgb(242 240 230)");
    expect(share(result.alpha)).toBeGreaterThan(0.1);
    expect(share(result.alpha)).toBeLessThan(0.5);
  });

  it("Batwa (a purple wallet on a lavender square) is keyed and the square is gone", async () => {
    const icon = await load("batwa");
    const result = analyzePixels(icon);
    expect(result.kind).toBe("keyed");
    expect(result.edge).toBe("rgb(239 236 254)");
    expect(share(result.alpha)).toBeGreaterThan(0.2);
    expect(share(result.alpha)).toBeLessThan(0.7);
    expect(result.alpha?.[0]).toBe(0);
    expect(result.alpha?.[icon.width * 90 + 90]).toBe(255);
  });

  it("Zahras POS (a lavender Z on clear pixels) is transparent and light", async () => {
    const result = analyzePixels(await load("zahras-pos"));
    expect(result.kind).toBe("transparent");
    expect(result.tone).toBe("light");
    expect(share(result.alpha)).toBeGreaterThan(0.1);
    expect(share(result.alpha)).toBeLessThan(0.6);
  });
});
