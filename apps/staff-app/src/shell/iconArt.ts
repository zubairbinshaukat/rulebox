import { useEffect, useState } from "react";

import { analyzePixels, type IconKind } from "./iconAnalysis";
import { makeCutout, recolorFor } from "./iconCutout";

/**
 * What the tiles and buttons need to draw an app's own icon (see `iconAnalysis.ts`
 * for the why). Matches `AppTileImageArt` of `@rulebox/ui`.
 */
export interface IconArt {
  /** `unknown` when the pixels could not be read: drawn full-bleed on the app's colour, no silhouette. */
  kind: IconKind | "unknown";
  /** `light` logos get a dark plate, `dark` ones a light plate (only used for `transparent`). */
  tone: "light" | "dark";
  /** The flat background colour of an opaque icon, for the box behind it. */
  edge?: string;
  /** Object URL of the logo's silhouette (a PNG whose alpha is the shape), used as a CSS mask. */
  mask?: string;
  /**
   * Object URL of the logo cut out of its background and cropped to fill a square (see
   * `iconCutout.ts`), in the logo's real colours. The small icons draw this, `contain`, on a
   * plate of the app's colour. Missing for `opaque` and `unknown` icons (they keep `cover`).
   */
  cutout?: string;
  /** The logo vanishes on one theme's surface: that theme recolours it (see `recolorFor`). */
  recolor?: "dark-logo" | "light-logo";
}

/** Longest side of the working copy: the watermark is about 100 px, so this is plenty. */
const WORK_SIDE = 128;
/** The cut-out is cropped from the original bitmap, decoded at up to this many px a side. */
const SOURCE_SIDE = 512;
/** The cache holds at most this many icons (a catalogue has a few dozen). */
const CACHE_LIMIT = 64;

const UNKNOWN: IconArt = { kind: "unknown", tone: "dark" };

const pending = new Map<string, Promise<IconArt>>();
const resolved = new Map<string, IconArt>();

function remember(url: string, art: IconArt) {
  if (resolved.size >= CACHE_LIMIT) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) {
      resolved.delete(oldest);
      pending.delete(oldest);
    }
  }
  resolved.set(url, art);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // The `rbicon` protocol answers with `Access-Control-Allow-Origin` for the app's own
    // pages, which is what lets the canvas below be read.
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("icon did not load"));
    image.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function readArt(url: string): Promise<IconArt> {
  const image = await loadImage(url);
  const scale = Math.min(1, WORK_SIDE / Math.max(image.naturalWidth, image.naturalHeight, 1));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return UNKNOWN;
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const analysis = analyzePixels(pixels);
  const art: IconArt = { kind: analysis.kind, tone: analysis.tone };
  if (analysis.edge) art.edge = analysis.edge;
  if (analysis.alpha) {
    // The silhouette: black pixels whose alpha is the shape. Only the alpha is used (CSS mask).
    const out = context.createImageData(width, height);
    for (let i = 0; i < width * height; i += 1) out.data[i * 4 + 3] = analysis.alpha[i] ?? 0;
    context.clearRect(0, 0, width, height);
    context.putImageData(out, 0, 0);
    const blob = await toBlob(canvas);
    if (blob) art.mask = URL.createObjectURL(blob);
  }
  // A failed cut-out only means the small icons keep the original picture.
  const cutout = await readCutout(image, analysis).catch(() => null);
  if (cutout) {
    art.cutout = cutout;
    const recolor = recolorFor(analysis.luma);
    if (recolor) art.recolor = recolor;
  }
  return art;
}

/** The logo cropped from the original bitmap (not from the 128 px copy), as an object URL. */
async function readCutout(image: HTMLImageElement, analysis: ReturnType<typeof analyzePixels>): Promise<string | null> {
  if (analysis.kind === "opaque") return null;
  const scale = Math.min(1, SOURCE_SIDE / Math.max(image.naturalWidth, image.naturalHeight, 1));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) return null;
  sourceContext.drawImage(image, 0, 0, width, height);
  const cut = makeCutout(sourceContext.getImageData(0, 0, width, height), analysis);
  if (!cut) return null;
  const canvas = document.createElement("canvas");
  canvas.width = cut.side;
  canvas.height = cut.side;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const out = context.createImageData(cut.side, cut.side);
  out.data.set(cut.data);
  context.putImageData(out, 0, 0);
  const blob = await toBlob(canvas);
  return blob ? URL.createObjectURL(blob) : null;
}

/**
 * Analyse an icon once and remember the answer by its URL (an app icon's URL is
 * made from its content hash, so the URL is the icon's identity). Never rejects:
 * an unreadable icon is `unknown`.
 */
export function loadIconArt(url: string): Promise<IconArt> {
  const hit = pending.get(url);
  if (hit) return hit;
  const started = readArt(url)
    .catch(() => UNKNOWN)
    .then((art) => {
      remember(url, art);
      return art;
    });
  pending.set(url, started);
  return started;
}

/** The answer if it is already known (no work, no flicker on a remount). */
export function peekIconArt(url: string): IconArt | undefined {
  return resolved.get(url);
}

/** Forget everything (tests). */
export function resetIconArt() {
  pending.clear();
  resolved.clear();
}

/**
 * The analysis of `url`: `undefined` until it is known (draw no watermark yet),
 * then the art. One decode per icon for the whole page, nothing per frame.
 */
export function useIconArt(url: string | null | undefined): IconArt | undefined {
  const [state, setState] = useState<{ url: string; art: IconArt } | null>(null);
  useEffect(() => {
    if (!url || peekIconArt(url)) return;
    let live = true;
    void loadIconArt(url).then((art) => {
      if (live) setState({ url, art });
    });
    return () => {
      live = false;
    };
  }, [url]);
  if (!url) return undefined;
  return peekIconArt(url) ?? (state?.url === url ? state.art : undefined);
}