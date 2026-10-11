import type { HTMLAttributes } from "react";

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Smaller radius and shadow, for side panels. */
  size?: "lg" | "md";
}

export function Panel({ size = "lg", className, ...rest }: PanelProps) {
  const cls = ["rb-panel", size === "md" ? "rb-panel--md" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return <div className={cls} {...rest} />;
}