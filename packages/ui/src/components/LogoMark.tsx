import { LOGO_BOX, LOGO_CELLS, LOGO_OFF_OPACITY, LOGO_VIEWBOX } from "../brand/geometry";

export interface LogoMarkProps {
  size?: number;
  /** Hide the blocked dots. Use below ~40 px (taskbar, title bars). */
  compact?: boolean;
  /** Accessible name; omit when the logo sits next to the "Rulebox" text. */
  label?: string;
  className?: string;
}

export function LogoMark({ size = 32, compact = size < 40, label, className }: LogoMarkProps) {
  const cells = compact ? LOGO_CELLS.filter((c) => c.on) : LOGO_CELLS;
  return (
    <svg
      className={["rb-logo", className ?? ""].filter(Boolean).join(" ")}
      viewBox={`0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}`}
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <rect
        x={LOGO_BOX.x}
        y={LOGO_BOX.y}
        width={LOGO_BOX.size}
        height={LOGO_BOX.size}
        rx={LOGO_BOX.rx}
        fill="none"
        stroke="var(--rb-ink)"
        strokeWidth={LOGO_BOX.stroke}
      />
      {cells.map((c) => (
        <rect
          key={`${c.row}-${c.col}`}
          x={c.x}
          y={c.y}
          width={c.size}
          height={c.size}
          rx={c.rx}
          fill={c.leg ? "var(--rb-brand)" : c.on ? "var(--rb-ink)" : "var(--rb-muted)"}
          opacity={c.on ? undefined : LOGO_OFF_OPACITY}
        />
      ))}
    </svg>
  );
}
