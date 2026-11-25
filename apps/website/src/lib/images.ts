/*
 * Responsive photo sources, built at compile time with astro:assets (sharp).
 * One AVIF srcset plus a WebP fallback, each at its own quality: AVIF holds
 * up well at ~60, WebP needs ~80 to look clean. <Picture> only takes one
 * quality for every format, which is why this helper exists.
 *
 * Callers pass `sizes` for the width the image is DRAWN at, not the width of
 * its box: with object-fit: cover a 3:2 photo in a tall box is drawn wider
 * than the box (box height x 1.5), and a `sizes` that names the box width
 * makes the browser pick a file that is then upscaled and looks soft.
 */
import { getImage } from "astro:assets";
import type { ImageMetadata } from "astro";

export const AVIF_QUALITY = 60;
export const WEBP_QUALITY = 80;

export interface PhotoSources {
  avif: string;
  webp: string;
  /** Smallest WebP: the <img src> for the rare browser without srcset. */
  fallback: string;
  width: number;
  height: number;
}

export async function photoSources(src: ImageMetadata, widths: number[]): Promise<PhotoSources> {
  // Never ask for more pixels than the source has.
  const ws = [...new Set(widths.map((w) => Math.min(w, src.width)))].sort((a, b) => a - b);
  const [avif, webp, fallback] = await Promise.all([
    getImage({ src, widths: ws, format: "avif", quality: AVIF_QUALITY }),
    getImage({ src, widths: ws, format: "webp", quality: WEBP_QUALITY }),
    getImage({ src, width: ws[0], format: "webp", quality: WEBP_QUALITY }),
  ]);
  return {
    avif: avif.srcSet.attribute,
    webp: webp.srcSet.attribute,
    fallback: fallback.src,
    width: src.width,
    height: src.height,
  };
}
