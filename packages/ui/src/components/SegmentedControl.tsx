import type { KeyboardEvent } from "react";

import { rovingKeyDown } from "../roving";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label"?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  // Arrow keys move the focus and select, as native radio buttons do.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = rovingKeyDown(e, '[role="radio"]', "both");
    const picked = target?.dataset.value as T | undefined;
    if (picked !== undefined) onChange(picked);
  }

  return (
    <div className="rb-seg" role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
