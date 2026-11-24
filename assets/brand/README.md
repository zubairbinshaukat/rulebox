# Rulebox brand assets

The logo is a soft deep-teal cube with a glowing amber keyhole.

- **Master:** `source/logo-cube-master.png` (1254 px 3D render, transparent).
  It is the source of every raster file. Never edit it; replace it with a new
  render and run the generator.
- **Flat mark:** `packages/ui/src/brand/geometry.ts`, the same cube traced as
  three flat faces and the keyhole, for 16-32 px (the render turns to mush
  there).
- **Generator:** `scripts/build-brand.mjs` (run `pnpm gen:brand`). Every other
  file here is generated; do not edit them by hand.

| File | Use it for |
|---|---|
| `rulebox-mark.svg` | Flat mark (vector), for favicons and anything 32 px or smaller |
| `rulebox.ico` | Windows icon: flat mark at 16-32 px, render at 48-256 px |
| `png/rulebox-mark-{16,24,32}.png` | Flat mark as PNG |
| `png/rulebox-cube-{48..512}.png` | The render, cropped square, transparent |
| `png/rulebox-tile-512.png` | The render on an opaque paper square (stores, iOS) |
| `installer/banner.bmp`, `installer/dialog.bmp` | WiX installer dialog bitmaps |

The generator also writes the copies the apps need:

- `packages/ui/src/brand/cube/` + `cube-still.ts`, `cube-motion.ts`: WebP
  images and layers (cube with the keyhole dark, keyhole light, highlight
  mask) for `<LogoMark>` and `<LogoMotion>`
- `apps/dashboard/public/`, `apps/website/public/`: `favicon.svg` (flat
  mark), `favicon.ico`, `apple-touch-icon.png` (render on paper); the website
  also gets `icon-512.png`
- `apps/staff-app/src-tauri/icons/`: the Tauri icons

Inside the apps, use `<LogoMark>` from `@rulebox/ui` instead of these files: it
picks the render or the flat mark by size. For the splash, loading,
open-desktop and lock animations use `<LogoMotion>`.

Colours: cube teal `#0b6970`, keyhole amber `#f2a12a` (`--rb-brand`, logo
accents only; the UI accent stays teal).
