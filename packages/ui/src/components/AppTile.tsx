import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

export type AppTileSize = "lg" | "md" | "sm";

export interface AppTileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  name: string;
  description?: string;
  /**
   * The app's own icon (a web app's icon). Drawn on a light plate, with a
   * large faded copy in the tile's corner. Wins over `glyph`.
   */
  imageSrc?: string;
  /** A Solar glyph, drawn white on a gradient square in the app's `hue`. */
  glyph?: ReactNode;
  /** Short text shown in a soft tinted square (defaults to the first letter). */
  mono?: string;
  /** Icon shown in the soft tinted square instead of the mono text. */
  icon?: ReactNode;
  /** Shows the small accent dot: the app is open. */
  running?: boolean;
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
  glyph,
  mono,
  icon,
  running = false,
  badge,
  size = "md",
  hue,
  className,
  type = "button",
  style,
  ...rest
}: AppTileProps) {
  const art = imageSrc ? "image" : glyph ? "glyph" : "tint";
  const iconStyle: CSSProperties | undefined =
    hue !== undefined ? ({ ["--rb-hue" as string]: hue } as CSSProperties) : undefined;
  const cls = ["rb-tile", `rb-tile--${size}`, className ?? ""].filter(Boolean).join(" ");
  const count = badge && badge > 0 ? (badge > 99 ? "99+" : String(badge)) : null;

  return (
    <button type={type} className={cls} title={description} style={style} {...rest}>
      {imageSrc ? (
        <span className="rb-tile__clip" aria-hidden>
          <img className="rb-tile__mark" src={imageSrc} alt="" draggable={false} />
        </span>
      ) : null}
      <span className="rb-tile__top">
        <span className={`rb-tile__icon rb-tile__icon--${art}`} style={iconStyle} aria-hidden>
          {art === "image" ? (
            <img className="rb-tile__img" src={imageSrc} alt="" draggable={false} />
          ) : art === "glyph" ? (
            glyph
          ) : (
            (icon ?? mono ?? name.charAt(0).toUpperCase())
          )}
        </span>
        {count ? (
          <span className="rb-tile__count" aria-label={`${count} new`}>
            {count}
          </span>
        ) : null}
      </span>
      <span className="rb-tile__text">
        <span className="rb-tile__name">
          <span>{name}</span>
          {running ? <span className="rb-dot" title="Open" /> : null}
        </span>
        {description ? <span className="rb-tile__desc">{description}</span> : null}
      </span>
    </button>
  );
}
