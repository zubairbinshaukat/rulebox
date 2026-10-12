import type { ButtonHTMLAttributes, ReactNode } from "react";

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
}

export function AppTile({
  name,
  description,
  mono,
  icon,
  running = false,
  badge,
  className,
  type = "button",
  ...rest
}: AppTileProps) {
  return (
    <button
      type={type}
      className={["rb-tile", className ?? ""].filter(Boolean).join(" ")}
      title={description}
      {...rest}
    >
      <span className="rb-tile__icon">{icon ?? mono ?? name.charAt(0).toUpperCase()}</span>
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