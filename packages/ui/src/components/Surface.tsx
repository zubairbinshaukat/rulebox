import type { HTMLAttributes, ReactNode } from "react";

export type SurfaceKind = "popover" | "bar" | "window";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  kind: SurfaceKind;
  children?: ReactNode;
}

/** Frosted container used by popups, the taskbar and windows. */
export function Surface({ kind, className, children, ...rest }: SurfaceProps) {
  const cls = ["rb-surface", `rb-surface--${kind}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
