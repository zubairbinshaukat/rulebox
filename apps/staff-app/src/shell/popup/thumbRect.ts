export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The page measures in CSS pixels; DWM draws in physical pixels of the popup's
 * own window. At 125% a 248 x 140 box is 310 x 175 on screen.
 */
export function toPhysical(rect: BoxRect, pixelRatio: number): BoxRect {
  const ratio = pixelRatio > 0 ? pixelRatio : 1;
  const left = Math.round(rect.x * ratio);
  const top = Math.round(rect.y * ratio);
  // Round the far edges, not the sizes, so neighbouring boxes never overlap or leave a gap.
  return {
    x: left,
    y: top,
    width: Math.round((rect.x + rect.width) * ratio) - left,
    height: Math.round((rect.y + rect.height) * ratio) - top,
  };
}
