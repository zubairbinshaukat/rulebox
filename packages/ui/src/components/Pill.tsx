import type { HTMLAttributes } from "react";

export type PillTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  /** Show a small status dot before the label. */
  dot?: boolean;
}

/** Small rounded status label, e.g. "Online", "Pending", "Failed". */
export function Pill({ tone = "neutral", dot = false, className, children, ...rest }: PillProps) {
  const cls = ["rb-pill", `rb-pill--${tone}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {dot && <span className="rb-pill__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
