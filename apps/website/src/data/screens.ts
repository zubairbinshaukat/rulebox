/*
 * Product screenshots: the drawn Staff App screens (components/DesktopMock)
 * rendered to real image files by scripts/screens.mjs, so search engines
 * can index the product (Google Images, the image sitemap, JSON-LD).
 * Files: public/screens/<key>.avif and .webp, 1600 x 1000 (committed).
 *
 * Honesty (Story §1): these are drawn illustrations of the real app's
 * screens. Names, apps and times are examples, and the alt text says so.
 * Plain data only: scripts/screens.mjs imports this file with Node's
 * type stripping.
 */
export type ScreenKey = "desktop" | "signin" | "viewer" | "offline";

export interface Screen {
  key: ScreenKey;
  /** DesktopMock variant that is rendered. */
  variant: ScreenKey;
  name: string;
  alt: string;
}

export const SCREEN_SIZE = { width: 1600, height: 1000 } as const;

export const SCREENS: Record<ScreenKey, Screen> = {
  desktop: {
    key: "desktop",
    variant: "desktop",
    name: "Rulebox staff desktop",
    alt: "Illustration of the Rulebox staff desktop: a greeting, tiles for the approved apps only, and a taskbar with a Start button. Names and apps are examples.",
  },
  signin: {
    key: "signin",
    variant: "signin",
    name: "Rulebox sign-in screen",
    alt: "Illustration of the Rulebox sign-in screen on a shared PC: a large clock, the date and a frosted sign-in card. Names are examples.",
  },
  viewer: {
    key: "viewer",
    variant: "viewer",
    name: "Rulebox built-in PDF viewer",
    alt: "Illustration of the built-in Rulebox PDF viewer: a document open in a window over the staff desktop, with zoom controls. The document is an example.",
  },
  offline: {
    key: "offline",
    variant: "offline",
    name: "Rulebox desktop while offline",
    alt: "Illustration of the Rulebox staff desktop while the PC is offline: an Offline label and a Wi-Fi off icon, with the approved apps still available. Names are examples.",
  },
};

export const screenUrl = (key: ScreenKey, ext: "avif" | "webp" = "webp") => `/screens/${key}.${ext}`;
