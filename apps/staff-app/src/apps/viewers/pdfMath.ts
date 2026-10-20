/** Sizing rules for the PDF viewer. Pure, so the limits of the plan are tested. */

export const MIN_PDF_ZOOM = 0.5;
export const MAX_PDF_ZOOM = 2;
const ZOOM_STEP = 0.25;
/** No canvas gets more pixels than this (6 megapixels), whatever the zoom. */
export const MAX_CANVAS_PIXELS = 6_000_000;
/** Device pixels are used up to 1.5 per CSS pixel, no more. */
export const MAX_PIXEL_RATIO = 1.5;
/** The widest page margin that is left around a page when it is fitted to the width. */
export const PAGE_GAP = 16;

export interface PageSize {
  width: number;
  height: number;
}

export function clampPdfZoom(zoom: number): number {
  return Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, zoom));
}

/** The next round zoom above or below this one: 50% .. 200% in steps of 25%. */
export function stepPdfZoom(zoom: number, direction: 1 | -1): number {
  const steps = zoom / ZOOM_STEP;
  const next = direction === 1 ? Math.floor(steps + 1e-9) + 1 : Math.ceil(steps - 1e-9) - 1;
  return clampPdfZoom(next * ZOOM_STEP);
}

/** The zoom at which a page of `page.width` points fills `available` pixels. */
export function fitWidthZoom(available: number, page: PageSize): number {
  if (available <= 0 || page.width <= 0) {
    return 1;
  }
  return clampPdfZoom((available - PAGE_GAP * 2) / page.width);
}

/**
 * The scale to draw a canvas at, in device pixels per PDF point: the zoom
 * times the pixel ratio (at most 1.5), reduced when the page would need more
 * than 6 megapixels.
 */
export function canvasScale(zoom: number, page: PageSize, pixelRatio: number): number {
  const wanted = zoom * Math.min(Math.max(pixelRatio, 1), MAX_PIXEL_RATIO);
  const pixels = page.width * wanted * (page.height * wanted);
  if (pixels <= MAX_CANVAS_PIXELS) {
    return wanted;
  }
  return wanted * Math.sqrt(MAX_CANVAS_PIXELS / pixels);
}

/** The page nearest the middle of the view, 1-based. `tops[i]` is where page i + 1 starts. */
export function currentPage(tops: readonly number[], heights: readonly number[], scrollTop: number, view: number): number {
  const middle = scrollTop + view / 2;
  let best = 0;
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i] ?? 0;
    if (top <= middle) {
      best = i;
    } else {
      break;
    }
    if (middle < top + (heights[i] ?? 0)) {
      return i + 1;
    }
  }
  return best + 1;
}
