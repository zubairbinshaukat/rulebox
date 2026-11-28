import { useId, type KeyboardEvent, type ReactNode } from "react";
import { rovingKeyDown } from "@rulebox/ui";
import IconSelected from "~icons/solar/check-circle-bold-duotone";
import "./ChoiceCards.css";

export interface ChoiceOption<T extends string = string> {
  value: T;
  /** The choice in two or three words. */
  label: string;
  /** One short line under the label. */
  hint?: string;
  /** A small drawing or glyph above the label (decorative: the label and hint carry the meaning). */
  art?: ReactNode;
  disabled?: boolean;
}

export interface ChoiceCardsProps<T extends string = string> {
  /** Submitted with a `<form>` through a hidden input; also the prefix of the card ids. */
  name?: string;
  /** The chosen option, or `null` when none is (nothing is checked and the first card takes the Tab stop). */
  value: T | null;
  onChange: (value: T) => void;
  options: readonly ChoiceOption<T>[];
  /** Cards per row when there is room (the group is wider than 420 px). Default: as many as there are options, at most 3. */
  columns?: 2 | 3;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * A short list of choices drawn as large cards: "Banner" or "Full screen", "Everyone" or "Only people I choose".
 * A `radiogroup` with one Tab stop (the chosen card, else the first): the arrow keys move and choose, as native radio
 * buttons do; Home and End jump to the ends. The selected card has an accent edge and a check mark. It lays itself
 * out by its own width: the cards stack under 420 px, side by side above.
 */
export function ChoiceCards<T extends string>({
  name,
  value,
  onChange,
  options,
  columns,
  disabled = false,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
}: ChoiceCardsProps<T>) {
  const prefix = useId();
  const cols = columns ?? (Math.min(options.length, 3) as 2 | 3);
  const enabled = options.filter((o) => !o.disabled);
  const stop = options.find((o) => o.value === value && !o.disabled) ?? enabled[0];

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const target = rovingKeyDown(e, '[role="radio"]', "both");
    const picked = target?.dataset.value as T | undefined;
    if (picked !== undefined && picked !== value) onChange(picked);
  }

  return (
    <div className={["dash-cc", className ?? ""].filter(Boolean).join(" ")}>
      <div
        className="dash-cc__grid"
        role="radiogroup"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        aria-disabled={disabled || undefined}
        data-columns={cols}
        onKeyDown={onKeyDown}
      >
        {options.map((o, i) => {
          const checked = o.value === value;
          const id = `${prefix}-${i}`;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              className="dash-cc__card"
              data-value={o.value}
              data-checked={checked || undefined}
              aria-checked={checked}
              aria-labelledby={`${id}-l`}
              aria-describedby={o.hint ? `${id}-h` : undefined}
              disabled={disabled || o.disabled}
              tabIndex={o === stop ? 0 : -1}
              onClick={() => {
                if (!checked) onChange(o.value);
              }}
            >
              {o.art ? (
                <span className="dash-cc__art" aria-hidden="true">
                  {o.art}
                </span>
              ) : null}
              <span className="dash-cc__text">
                <span id={`${id}-l`} className="dash-cc__label">
                  {o.label}
                </span>
                {o.hint ? (
                  <span id={`${id}-h`} className="dash-cc__hint">
                    {o.hint}
                  </span>
                ) : null}
              </span>
              <span className="dash-cc__check" aria-hidden="true">
                <IconSelected />
              </span>
            </button>
          );
        })}
      </div>
      {name !== undefined ? <input type="hidden" name={name} value={value ?? ""} /> : null}
    </div>
  );
}
