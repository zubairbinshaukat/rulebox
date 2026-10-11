import type { CSSProperties } from "react";

export interface AvatarProps {
  /** Full name; the initials are derived from it. */
  name: string;
  size?: number;
  className?: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function Avatar({ name, size = 72, className }: AvatarProps) {
  const style: CSSProperties = { width: size, height: size, fontSize: Math.round(size / 3) };
  return (
    <span className={["rb-avatar", className ?? ""].filter(Boolean).join(" ")} style={style} aria-label={name}>
      {initials(name)}
    </span>
  );
}