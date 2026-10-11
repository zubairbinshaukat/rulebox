import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "ghost" | "danger-ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Square 46px button, for icon-only use (e.g. the sign-in arrow). */
  icon?: boolean;
}

export function Button({
  variant = "primary",
  icon = false,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = ["rb-btn", `rb-btn--${variant}`, icon ? "rb-btn--icon" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={cls} {...rest} />;
}