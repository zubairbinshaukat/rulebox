import type { SelectHTMLAttributes } from "react";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  /** 40 px high instead of 46 px (filter bars). */
  compact?: boolean;
};

/** A styled native `<select>`: keyboard, screen readers and phones keep their own behaviour. */
export function Select({ className, compact = false, children, ...rest }: SelectProps) {
  const cls = ["rb-select", compact ? "rb-select--compact" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      <select className="rb-select__control" {...rest}>
        {children}
      </select>
      <svg className="rb-select__chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
