/*
 * Home page images that are preloaded from <head>: one place for the widths and the
 * `sizes` that the component drawing the image and HomePreloads.astro (the
 * <link rel="preload">) must agree on, or the preload fetches a file the page
 * never uses.
 *
 * `sizes` names the width the photo is LAID OUT at (measured in Chromium at 1x,
 * 2026-11-28), not its resting size: in the
 * scrubbed layout the stage is scaled down to 0.73 to 0.91 at rest and grows
 * back as you scroll, so the file must still hold the laid-out width.
 *   up to 600px     the small card: 56% of the viewport (215px at 390, 337 at 600)
 *   601 to 959px    the backdrop fills the stage: 94% (719px at 768, 842 at 900)
 *   960 to 1439px   scrubbed layout, right column: about 52% (449 at 960, 646 at
 *                   1280, 739 at 1440)
 *   1440px and up   the column stops growing: 765px
 */
export const HERO_WIDTHS = [360, 480, 640, 800, 960, 1280, 1600];
export const HERO_SIZES = "(max-width: 600px) 56vw, (max-width: 959px) 94vw, (max-width: 1439px) 52vw, 765px";
export const HERO_QUALITY = 55;
/** Viewports where the photo is a visible part of the first screen and can be the LCP:
 *  tablets, and wide screens that scrub (motion allowed). On phones it sits below the
 *  fold; with reduced motion on wide screens it is not drawn at all. */
export const HERO_PRELOAD_MEDIA = "(min-width: 601px) and (max-width: 959px), (min-width: 960px) and (prefers-reduced-motion: no-preference)";

/** `sizes` of the preloader's logo cube (Preloader.astro draws it 150px wide; see the note there on why 140px). */
export const CUBE_SIZES = "140px";



