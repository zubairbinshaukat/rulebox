import type { ButtonHTMLAttributes, ReactNode } from "react";

export type IconButtonSize = 32 | 38 | 44;

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  /** Required: used as aria-label and title (tooltip). */
  label: string;
  size?: IconButtonSize;
  active?: boolean;
  children?: ReactNode;
}

export function IconButton({
  label,
  size = 38,
  active = false,
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
