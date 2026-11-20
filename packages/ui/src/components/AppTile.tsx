import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

export type AppTileSize = "lg" | "md" | "sm";

/**
 * What the shell found out about an app's own icon (`apps/staff-app/src/shell/iconArt.ts`):
 *  - `transparent` / `keyed`: a logo on clear pixels or on a flat background; drawn as its `cutout`
 *    (background removed, scaled up to span the box) with no box of its own.
 *  - `opaque`: a picture; it fills the rounded box edge to edge.
 *  - `unknown`: not read; drawn like `opaque`.
 * `mask` is the logo's silhouette (an image URL whose alpha is the shape) for the large
 * faded copy in the corner; without one the corner shows the `glyph`.
 */
export interface AppTileImageArt {
  kind: "transparent" | "keyed" | "opaque" | "unknown";
  /** A light logo gets a dark plate, a dark one a light plate (`transparent` only). */
  tone?: "light" | "dark";
  /** The icon's flat background colour, behind the image so no fringe shows. */
  edge?: string;
  mask?: string;
  /**
   * The logo cut out of its background and cropped to fill a square, in its real colours
   * (an image URL). The small icon draws this, `contain`, on a plate of the icon's colour,
   * so the logo reaches almost the box edges. Without one a `keyed` / `opaque` icon is
   * drawn `cover`, a `transparent` one inset on its plate.
   */
  cutout?: string;
  /** The logo vanishes on one theme's surface (a black Z on dark): that theme recolours it (no box). */
  recolor?: "dark-logo" | "light-logo";
}

export interface AppTileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  name: string;
  description?: string;
  /**
   * The app's own icon (a web app's icon). Wins over `glyph`. Drawn full-bleed in
   * the rounded box (a transparent logo sits on a plate), with a large faded
   * silhouette of the logo in the tile's corner (see `imageArt`).
   */
  imageSrc?: string;
  /** The analysis of `imageSrc`. Undefined while it is pending: no corner copy yet. */
  imageArt?: AppTileImageArt;
  /** A Solar glyph, drawn white on a gradient square in the app's `hue`. */
  glyph?: ReactNode;
  /** Short text shown in a soft tinted square (defaults to the first letter). */
  mono?: string;
  /** Icon shown in the soft tinted square instead of the mono text. */
  icon?: ReactNode;
  /** Shows the small accent dot: the app is open. */
  running?: boolean;
  /** Shows a small "Paused" mark: the app's window was closed for being idle; opening it starts fresh (Phase 6 Step 19). */
  paused?: boolean;
  /** Notification count in the corner. */
  badge?: number;
  /** Default "md"; lg/sm scale the art and the text. */
  size?: AppTileSize;
  /** The app's colour (oklch hue, 0-360) for the art. */
  hue?: number;
}

export function AppTile({
  name,
  description,
  imageSrc,
  imageArt,
  glyph,
  mono,
  icon,
  running = false,
  paused = false,
  badge,
  size = "md",
  hue,
  className,
  type = "button",
  style,
  ...rest
}: AppTileProps) {
  const art = imageSrc ? "image" : glyph ? "glyph" : "tint";
  // The faded corner copy: the logo's silhouette when the icon has one, else the glyph. An icon
  // whose analysis is pending shows none (it would pop in), and its own opaque background is
  // never drawn there.
  const mark = imageSrc ? (imageArt?.mask ? "mask" : imageArt && glyph ? "glyph" : null) : glyph ? "glyph" : null;
  const iconData = imageSrc
    ? {
        "data-icon-kind": imageArt?.kind ?? "pending",
        "data-icon-tone": imageArt?.tone,
        "data-icon-fit": imageArt?.cutout ? "logo" : imageArt?.kind === "transparent" ? "inset" : "cover",
        "data-icon-recolor": imageArt?.cutout ? imageArt.recolor : undefined,
      }
    : {};
  const iconStyle = imageSrc && imageArt?.edge && !imageArt.cutout ? ({ ["--rb-icon-edge" as string]: imageArt.edge } as CSSProperties) : undefined;
  // On the card itself, so the art, its corner copy and the glow share it.
  const tileStyle: CSSProperties | undefined =
    hue !== undefined ? ({ ["--rb-hue" as string]: hue, ...style } as CSSProperties) : style;
  const cls = ["rb-tile", `rb-tile--${size}`, className ?? ""].filter(Boolean).join(" ");
  const count = badge && badge > 0 ? (badge > 99 ? "99+" : String(badge)) : null;

  return (
    <button type={type} className={cls} title={description} style={tileStyle} {...rest}>
      <span className="rb-tile__clip" aria-hidden>
        {mark === "mask" ? (
          <span
            className="rb-tile__mark rb-tile__mark--mask"
            style={{ ["--rb-mark-url" as string]: `url("${imageArt?.mask}")` } as CSSProperties}
          />
        ) : mark === "glyph" ? (
          <span className="rb-tile__mark rb-tile__mark--glyph">{glyph}</span>
        ) : null}
      </span>
      <span className="rb-tile__top">
        <span className={`rb-tile__icon rb-tile__icon--${art}`} style={iconStyle} {...iconData} aria-hidden>
          {art === "image" ? (
            <img className="rb-tile__img" src={imageArt?.cutout ?? imageSrc} alt="" draggable={false} />
          ) : art === "glyph" ? (
            glyph
          ) : (
            (icon ?? mono ?? name.charAt(0).toUpperCase())
          )}
        </span>
        {count ? (
          <>
            <span className="rb-tile__count" aria-hidden="true">
              {count}
            </span>
            <span className="rb-sr-only">, {count} new</span>
          </>
        ) : null}
      </span>
      <span className="rb-tile__text">
        <span className="rb-tile__name">
          <span>{name}</span>
          {running ? (
            <>
              <span className="rb-dot" aria-hidden="true" />
              <span className="rb-sr-only">, open</span>
            </>
          ) : paused ? (
            <span className="rb-tile__paused" data-testid="tile-paused">
              Paused
              <span className="rb-sr-only">, closed to save memory; opens fresh</span>
            </span>
          ) : null}
        </span>
        {description ? <span className="rb-tile__desc">{description}</span> : null}
      </span>
    </button>
  );
}
