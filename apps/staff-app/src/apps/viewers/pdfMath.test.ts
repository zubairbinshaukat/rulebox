import { describe, expect, it } from "vitest";

import {
  canvasScale,
  clampPdfZoom,
  currentPage,
  fitWidthZoom,
  MAX_CANVAS_PIXELS,
  PAGE_GAP,
  stepPdfZoom,
} from "./pdfMath";

const letter = { width: 612, height: 792 };

describe("PDF zoom", () => {
  it("stays between 50% and 200% in steps of 25%", () => {
    expect(clampPdfZoom(0.1)).toBe(0.5);
    expect(clampPdfZoom(9)).toBe(2);
    expect(stepPdfZoom(1, 1)).toBe(1.25);
    expect(stepPdfZoom(1, -1)).toBe(0.75);
    expect(stepPdfZoom(0.5, -1)).toBe(0.5);
    expect(stepPdfZoom(2, 1)).toBe(2);
    // From a fitted, odd zoom the next step lands on a round value.
    expect(stepPdfZoom(1.13, 1)).toBe(1.25);
    expect(stepPdfZoom(1.13, -1)).toBe(1);
  });

  it("fits a page to the width, leaving the page margin on both sides", () => {
    expect(fitWidthZoom(612 + PAGE_GAP * 2, letter)).toBe(1);
    expect(fitWidthZoom(10_000, letter)).toBe(2);
    expect(fitWidthZoom(100, letter)).toBe(0.5);
    expect(fitWidthZoom(0, letter)).toBe(1);
  });
});

describe("PDF canvas size", () => {
  it("uses at most 1.5 device pixels per CSS pixel", () => {
    expect(canvasScale(1, letter, 1)).toBe(1);
    expect(canvasScale(1, letter, 1.5)).toBe(1.5);
    expect(canvasScale(1, letter, 3)).toBe(1.5);
    expect(canvasScale(1, letter, 0.5)).toBe(1);
  });

  it("never draws more than 6 megapixels, whatever the zoom or page size", () => {
    for (const zoom of [0.5, 1, 1.5, 2]) {
      for (const page of [letter, { width: 612 * 4, height: 792 * 4 }, { width: 10_000, height: 10_000 }]) {
        for (const ratio of [1, 1.25, 1.5, 2, 3]) {
          const scale = canvasScale(zoom, page, ratio);
          const pixels = page.width * scale * (page.height * scale);
          expect(pixels).toBeLessThanOrEqual(MAX_CANVAS_PIXELS * 1.0001);
        }
      }
    }
    // A big page at 200% really is reduced.
    const big = { width: 2000, height: 2000 };
    expect(canvasScale(2, big, 1.5)).toBeLessThan(3);
  });
});

describe("which page is in the middle of the window", () => {
  // Three pages 100 tall with a 16 gap, starting at 16.
  const tops = [16, 132, 248];
  const heights = [100, 100, 100];

  it("finds the page under the middle of the view", () => {
    expect(currentPage(tops, heights, 0, 100)).toBe(1);
    expect(currentPage(tops, heights, 100, 100)).toBe(2);
    expect(currentPage(tops, heights, 230, 100)).toBe(3);
  });

  it("falls back to the nearest page in a gap and past the end", () => {
    expect(currentPage(tops, heights, 100, 20)).toBe(1);
    expect(currentPage(tops, heights, 5000, 100)).toBe(3);
    expect(currentPage([], [], 0, 100)).toBe(1);
  });
});
