# Rulebox brand assets

Every file here is **generated**. Do not edit them by hand.

- Shape and colors: `packages/ui/src/brand/geometry.ts`
- Generator: `scripts/build-brand.mjs` (run `pnpm gen:brand`)

| File | Use it for |
|---|---|
| `rulebox-mark.svg` | Outlined logo that follows the viewer's light or dark theme |
| `rulebox-mark-light.svg` | Outlined logo for light backgrounds |
| `rulebox-mark-dark.svg` | Outlined logo for dark backgrounds |
| `rulebox-mark-compact.svg` | Outlined logo without the small dots, for sizes under 40 px |
| `rulebox-icon.svg` | App icon: white and green on a dark tile |
| `rulebox-icon-compact.svg` | App icon without the small dots, for sizes under 48 px |
| `rulebox.ico` | Windows icon (16 to 256 px) |
| `png/rulebox-icon-*.png` | App icon at fixed sizes, 16 to 1024 px |
| `png/rulebox-mark-*-512.png` | Outlined logo as PNG, where SVG is not accepted |

The generator also writes the copies the apps need:

- `apps/dashboard/public/`: `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`
- `apps/staff-app/src-tauri/icons/`: the Tauri icons

Inside the apps, use the `<LogoMark>` component from `@rulebox/ui` instead of
these files. It draws the same shape and follows the theme tokens. For the
splash, loading, open-desktop and lock animations use `<LogoMotion>`.

Brand green: `#12b76a` (`--rb-brand`).
