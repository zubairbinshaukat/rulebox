import type { ButtonHTMLAttributes, ReactNode } from "react";

export type IconButtonSize = 32 | 38 | 44;

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  /** Required: used as aria-label and title (tooltip). */
  label: string;
  size?: IconButtonSize;
  /**
   * Makes this a toggle button: `true` is pressed, `false` is not. Leave it out
   * for a plain action button, so a screen reader does not call it a toggle.
   */
  active?: boolean;
  children?: ReactNode;
}

export function IconButton({
  label,
  size = 38,
  active,
  className,
  type = "button",
  children,
  ...rest
}: IconButtonProps) {
  const cls = [
    "rb-icon-btn",
    `rb-icon-btn--${size}`,
    active ? "rb-icon-btn--active" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} className={cls} aria-label={label} title={label} aria-pressed={active} {...rest}>
      {children}
    </button>
  );
}
