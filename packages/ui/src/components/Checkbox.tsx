import type { InputHTMLAttributes, ReactNode } from "react";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  /** Second line under the label. */
  hint?: ReactNode;
}

/** A native checkbox with a styled box; the whole row is the click target. */
export function Checkbox({ label, hint, className, ...rest }: CheckboxProps) {
  return (
    <label className={["rb-checkbox", className ?? ""].filter(Boolean).join(" ")} data-disabled={rest.disabled || undefined}>
      <input type="checkbox" className="rb-checkbox__input" {...rest} />
      <span className="rb-checkbox__box" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="rb-checkbox__text">
        <span className="rb-checkbox__label">{label}</span>
        {hint ? <span className="rb-checkbox__hint">{hint}</span> : null}
      </span>
    </label>
  );
}
