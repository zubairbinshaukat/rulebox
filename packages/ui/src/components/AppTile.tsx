import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

export type AppTileSize = "lg" | "md" | "sm";

export interface AppTileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  name: string;
  description?: string;
  /** Short text shown in the icon block (defaults to the first letter). */
  mono?: string;
  /** Icon shown in the icon block instead of the mono text. */
  icon?: ReactNode;
  /** Shows the small accent dot: the app is open. */
  running?: boolean;
  /** Notification count in the corner. */
  badge?: number;
  /** Default "md" = today's look; lg/sm scale the tile. */
  size?: AppTileSize;
  /** Sets --rb-hue on the icon block for tint tokens. */
  hue?: number;
}

export function AppTile({
  name,
  description,
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
  const iconStyle: CSSProperties | undefined =
    hue !== undefined ? ({ ["--rb-hue" as string]: hue } as CSSProperties) : undefined;

  const cls = ["rb-tile", `rb-tile--${size}`, className ?? ""].filter(Boolean).join(" ");

  return (
    <button type={type} className={cls} title={description} style={style} {...rest}>
      <span className="rb-tile__icon" style={iconStyle}>
        {icon ?? mono ?? name.charAt(0).toUpperCase()}
      </span>
      <span className="rb-tile__text">
        <span className="rb-tile__name">
          <span>{name}</span>
          {running ? <span className="rb-dot" title="Open" /> : null}
        </span>
        {description ? <span className="rb-tile__desc">{description}</span> : null}
      </span>
      {badge ? <span className="rb-badge">{badge}</span> : null}
    </button>
  );
}
