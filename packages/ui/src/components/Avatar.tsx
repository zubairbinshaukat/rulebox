import type { CSSProperties } from "react";

export interface AvatarProps {
  /** Full name; the initials are derived from it. */
  name: string;
  size?: number;
  className?: string;
  /**
   * The name is already written next to the avatar (or the avatar sits in a
   * button that has its own label): hide the initials from screen readers
   * instead of reading the name twice.
   */
  decorative?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function Avatar({ name, size = 72, className, decorative = false }: AvatarProps) {
  const style: CSSProperties = { width: size, height: size, fontSize: Math.round(size / 3) };
  return (
    <span
      className={["rb-avatar", className ?? ""].filter(Boolean).join(" ")}
      style={style}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
    >
      {initials(name)}
    </span>
  );
}
