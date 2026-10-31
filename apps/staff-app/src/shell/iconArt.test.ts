import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadIconArt, peekIconArt, resetIconArt } from "./iconArt";

type Rgba = [number, number, number, number];

/** The icon's picture as a function of the position (0 to 1): the fake canvas rasterises it at any size. */
let painter: (u: number, v: number) => Rgba = () => [0, 0, 0, 0];
let readFails = false;
let noContext = false;
let imageLoads = 0;
let failImage = false;
let naturalSide = 256;
/** Every canvas the code made: its size and what was put on it last. */
let canvases: { width: number; height: number; put?: { width: number; height: number; data: Uint8ClampedArray } }[] = [];
let blobs = 0;

class FakeImage {
  crossOrigin = "";
  decoding = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  get naturalWidth() {
    return naturalSide;
  }
  get naturalHeight() {
    return naturalSide;
  }
  set src(_value: string) {
    imageLoads += 1;
    queueMicrotask(() => (failImage ? this.onerror?.() : this.onload?.()));
  }
}

function raster(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(painter((x + 0.5) / width, (y + 0.5) / height), (y * width + x) * 4);
  }
  return { width, height, data };
}

/** A small disc in a padded square: a logo on a flat background. */
const disc = (u: number, v: number) => (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.2 ** 2;

beforeEach(() => {
  resetIconArt();
  imageLoads = 0;
  failImage = false;
  readFails = false;
  noContext = false;
  naturalSide = 256;
  canvases = [];
  blobs = 0;
  painter = (u, v) => (disc(u, v) ? [20, 20, 20, 255] : [242, 240, 230, 255]);
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (noContext) return null;
    const canvas = { width: this.width, height: this.height } as (typeof canvases)[number];
    canvases.push(canvas);
    return {
      drawImage: vi.fn(),
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        if (readFails) throw new DOMException("tainted", "SecurityError");
        return raster(w, h);
      },
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      clearRect: vi.fn(),
      putImageData: (image: { width: number; height: number; data: Uint8ClampedArray }) => {
        canvas.put = image;
      },
    };
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["png"])));
  URL.createObjectURL = vi.fn(() => `blob:art-${++blobs}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadIconArt", () => {
  it("reads an icon once, keys its background out and keeps a mask and a logo cut-out", async () => {
    const art = await loadIconArt("http://rbicon.localhost/app:aa");
    expect(art).toEqual({ kind: "keyed", tone: "dark", edge: "rgb(242 240 230)", mask: "blob:art-1", cutout: "blob:art-2", recolor: "dark-logo" });
    expect(peekIconArt("http://rbicon.localhost/app:aa")).toBe(art);
  });

  it("crops the cut-out from the original bitmap: a square, bigger than the 128 px copy, at most 256 px", async () => {
    await loadIconArt("http://rbicon.localhost/app:crop");
    // The working copy (128), the original (256, read for the crop) and the cut-out's own canvas.
    const sizes = canvases.map((c) => c.width);
    expect(sizes).toContain(128);
    expect(sizes).toContain(256);
    const cutout = canvases.find((c) => c.put && c.put.width !== 128);
    expect(cutout).toBeDefined();
    const side = (cutout?.put as { width: number; height: number }).width;
    expect((cutout?.put as { width: number; height: number }).height).toBe(side);
    // The disc (0.4 of the side) plus 6.5% each side of its box: about 0.4 / 0.87 of 256 px, kept at full resolution.
    expect(side).toBeGreaterThanOrEqual(100);
    expect(side).toBeLessThanOrEqual(256);
  });

  it("the cut-out's logo fills at least 90% of its box and its background is clear", async () => {
    await loadIconArt("http://rbicon.localhost/app:fill");
    const put = canvases.map((c) => c.put).find((p) => p && p.width !== 128 && p.width === p.height && p.data.some((v) => v > 0));
    expect(put).toBeDefined();
    const { width, data } = put as { width: number; data: Uint8ClampedArray };
    let min = width;
    let max = -1;
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((data[(y * width + x) * 4 + 3] ?? 0) < 48) continue;
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
    }
    expect((max - min + 1) / width).toBeGreaterThanOrEqual(0.9);
    expect(data[3]).toBe(0);
  });

  it("decodes each icon once, however many tiles and buttons ask", async () => {
    const [a, b, c] = await Promise.all([
      loadIconArt("http://rbicon.localhost/app:bb"),
      loadIconArt("http://rbicon.localhost/app:bb"),
      loadIconArt("http://rbicon.localhost/app:bb"),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(imageLoads).toBe(1);
    await loadIconArt("http://rbicon.localhost/app:bb");
    expect(imageLoads).toBe(1);
    await loadIconArt("http://rbicon.localhost/app:cc");
    expect(imageLoads).toBe(2);
  });

  it("makes no mask and no cut-out for an icon without a silhouette (a picture)", async () => {
    painter = (u) => [Math.round(u * 255), 80, 160, 255];
    const art = await loadIconArt("http://rbicon.localhost/app:dd");
    expect(art.kind).toBe("opaque");
    expect(art.mask).toBeUndefined();
    expect(art.cutout).toBeUndefined();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("treats a transparent logo as a silhouette on its own alpha, and cuts it out too", async () => {
    painter = (u, v) => (disc(u, v) ? [200, 160, 240, 255] : [0, 0, 0, 0]);
    const art = await loadIconArt("http://rbicon.localhost/app:ee");
    expect(art).toEqual({ kind: "transparent", tone: "light", mask: "blob:art-1", cutout: "blob:art-2" });
  });

  it("keeps the art without a cut-out when the cut-out cannot be made", async () => {
    // The first getImageData (the 128 px copy) works, the second (the original) is refused.
    let reads = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return {
        drawImage: vi.fn(),
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          reads += 1;
          if (reads > 1) throw new DOMException("tainted", "SecurityError");
          return raster(w, h);
        },
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        clearRect: vi.fn(),
        putImageData: vi.fn(),
      };
    } as never);
    const art = await loadIconArt("http://rbicon.localhost/app:nocut");
    expect(art).toEqual({ kind: "keyed", tone: "dark", edge: "rgb(242 240 230)", mask: "blob:art-1" });
  });

  it("is unknown, never an error, when the image or the canvas cannot be read", async () => {
    failImage = true;
    expect((await loadIconArt("http://rbicon.localhost/app:f1")).kind).toBe("unknown");
    failImage = false;
    readFails = true;
    expect((await loadIconArt("http://rbicon.localhost/app:f2")).kind).toBe("unknown");
    readFails = false;
    noContext = true;
    expect((await loadIconArt("http://rbicon.localhost/app:f3")).kind).toBe("unknown");
  });

  it("analyses a copy of at most 128 px, so a big icon costs no more, and crops from at most 512 px", async () => {
    naturalSide = 1024;
    const created = vi.spyOn(document, "createElement");
    await loadIconArt("http://rbicon.localhost/app:big");
    const made = created.mock.results.map((r) => r.value).filter((el) => el instanceof HTMLCanvasElement) as HTMLCanvasElement[];
    expect(made[0]?.width).toBe(128);
    expect(made[0]?.height).toBe(128);
    expect(made[1]?.width).toBe(512);
    expect(Math.max(...made.map((m) => m.width))).toBeLessThanOrEqual(512);
  });
});
