/** Zoom and pan maths for the image viewer. Pure, so the rules are tested. */

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
const STEP = 1.25;

export interface Size {
  w: number;
  h: number;
}

/** Where the image sits: its top-left corner in the view, and its scale. */
export interface Placement {
  scale: number;
  x: number;
  y: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The scale at which the whole image fits the view. Small images are not enlarged. */
export function fitScale(view: Size, image: Size): number {
  if (image.w <= 0 || image.h <= 0 || view.w <= 0 || view.h <= 0) {
    return 1;
  }
  return clampZoom(Math.min(view.w / image.w, view.h / image.h, 1));
}

/** The image centred in the view at `scale`. */
export function centered(view: Size, image: Size, scale: number): Placement {
  return { scale, x: (view.w - image.w * scale) / 2, y: (view.h - image.h * scale) / 2 };
}

/** One zoom-in or zoom-out step. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  return clampZoom(direction === 1 ? scale * STEP : scale / STEP);
}

/**
 * Zoom by `factor` around a point of the view (the pointer, or the view's
 * centre) so that the part of the image under it stays where it is.
 */
export function zoomAt(placement: Placement, factor: number, point: { x: number; y: number }): Placement {
  const scale = clampZoom(placement.scale * factor);
  const ratio = scale / placement.scale;
  return {
    scale,
    x: point.x - (point.x - placement.x) * ratio,
    y: point.y - (point.y - placement.y) * ratio,
  };
}

/**
 * Keeps at least `keep` pixels of the image inside the view, so it can never
 * be dragged out of reach.
 */
export function clampPan(placement: Placement, view: Size, image: Size, keep = 64): Placement {
  const w = image.w * placement.scale;
  const h = image.h * placement.scale;
  const x = Math.min(view.w - Math.min(keep, w), Math.max(Math.min(keep, w) - w, placement.x));
  const y = Math.min(view.h - Math.min(keep, h), Math.max(Math.min(keep, h) - h, placement.y));
  return { scale: placement.scale, x, y };
}

export function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
