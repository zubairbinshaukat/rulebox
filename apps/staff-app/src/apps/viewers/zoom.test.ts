import { describe, expect, it } from "vitest";

import {
  centered,
  clampPan,
  clampZoom,
  fitScale,
  MAX_ZOOM,
  MIN_ZOOM,
  percent,
  stepZoom,
  zoomAt,
} from "./zoom";

describe("image zoom maths", () => {
  const view = { w: 800, h: 600 };

  it("fits a big picture to the window and never enlarges a small one", () => {
    expect(fitScale(view, { w: 1600, h: 1200 })).toBe(0.5);
    expect(fitScale(view, { w: 4000, h: 600 })).toBeCloseTo(0.2);
    expect(fitScale(view, { w: 400, h: 300 })).toBe(1);
    expect(fitScale({ w: 0, h: 0 }, { w: 400, h: 300 })).toBe(1);
    expect(fitScale(view, { w: 0, h: 0 })).toBe(1);
  });

  it("keeps the zoom between 5% and 800%", () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
    let scale = 1;
    for (let i = 0; i < 40; i++) scale = stepZoom(scale, 1);
    expect(scale).toBe(MAX_ZOOM);
    for (let i = 0; i < 80; i++) scale = stepZoom(scale, -1);
    expect(scale).toBe(MIN_ZOOM);
    expect(stepZoom(1, 1)).toBeCloseTo(1.25);
    expect(stepZoom(1.25, -1)).toBeCloseTo(1);
  });

  it("centres the picture", () => {
    expect(centered(view, { w: 400, h: 300 }, 1)).toEqual({ scale: 1, x: 200, y: 150 });
    expect(centered(view, { w: 1600, h: 1200 }, 0.5)).toEqual({ scale: 0.5, x: 0, y: 0 });
  });

  it("zooms around a point so the part under it stays put", () => {
    const start = { scale: 1, x: 100, y: 50 };
    const point = { x: 300, y: 250 };
    // The picture point under the pointer before and after must be the same.
    const before = { x: (point.x - start.x) / start.scale, y: (point.y - start.y) / start.scale };
    const after = zoomAt(start, 2, point);
    expect(after.scale).toBe(2);
    expect((point.x - after.x) / after.scale).toBeCloseTo(before.x);
    expect((point.y - after.y) / after.scale).toBeCloseTo(before.y);
  });

  it("does not move the picture when the zoom is already at its limit", () => {
    const atMax = { scale: MAX_ZOOM, x: 10, y: 20 };
    const same = zoomAt(atMax, 2, { x: 400, y: 300 });
    expect(same).toEqual(atMax);
  });

  it("cannot be dragged out of reach", () => {
    const image = { w: 1000, h: 800 };
    const far = clampPan({ scale: 1, x: 5000, y: -5000 }, view, image);
    expect(far.x).toBeLessThanOrEqual(view.w - 64);
    expect(far.y).toBeGreaterThanOrEqual(64 - image.h);
    const near = clampPan({ scale: 1, x: 10, y: 10 }, view, image);
    expect(near).toEqual({ scale: 1, x: 10, y: 10 });
  });

  it("shows the zoom as a percentage", () => {
    expect(percent(1)).toBe("100%");
    expect(percent(0.255)).toBe("26%");
  });
});
