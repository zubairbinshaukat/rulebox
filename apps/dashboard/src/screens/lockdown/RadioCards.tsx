import { useId, type ReactNode } from "react";
import { Pill } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-linear";

export interface RadioCardOption<T extends string> {
  value: T;
  title: string;
  /** One short line under the title. */
  lead?: string;
  /** A small pill after the title ("Recommended"). */
  badge?: string;
  /** What this choice does, as short points (shown from a card width of about 200 px). */
  points?: readonly string[];
  icon?: ReactNode;
}

export interface RadioCardsProps<T extends string> {
  /** `level`: tall cards with points and a strength meter. `mode`: short cards in a row. */
  variant: "level" | "mode";
  /** The id of the heading that names the group. */
  labelledBy: string;
  /** The chosen option, or `null` when none is (a "Custom" level, mixed modes): nothing is checked. */
  value: T | null;
  options: readonly RadioCardOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** The option that is nearest to a custom setup: marked with a dashed edge. */
  nearest?: T | null;
  className?: string;
}

/**
 * Radio buttons drawn as cards. Real `<input type="radio">` elements, so arrow keys, Tab and the screen reader's "1 of 3" work without code;
 * the card is the label. A card lays out by its own width (container queries in `lockdown.css`): three across, or stacked rows on a phone.
 */
export function RadioCards<T extends string>({ variant, labelledBy, value, options, onChange, disabled, nearest, className }: RadioCardsProps<T>) {
  const name = useId();
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={["lk-rc", `lk-rc--${variant}`, className ?? ""].filter(Boolean).join(" ")}>
      {options.map((o, index) => {
        const checked = value === o.value;
        const id = `${name}-${o.value}`;
        return (
          <label key={o.value} className="lk-rc__card" data-checked={checked || undefined} data-near={(!checked && nearest === o.value) || undefined} data-disabled={disabled || undefined}>
            <input
              type="radio"
              className="lk-rc__input"
              name={name}
              value={o.value}
              checked={checked}
              disabled={disabled}
              aria-labelledby={`${id}-t`}
              aria-describedby={o.lead ? `${id}-d` : undefined}
              onChange={() => onChange(o.value)}
            />
            <span className="lk-rc__head">
              {o.icon ? (
                <span className="lk-rc__icon" aria-hidden="true">
                  {o.icon}
                </span>
              ) : null}
              <span className="lk-rc__name">
                <span id={`${id}-t`} className="lk-rc__title">
                  {o.title}
                </span>
                {o.badge ? (
                  <Pill tone="accent" className="lk-rc__badge">
                    {o.badge}
                  </Pill>
                ) : null}
              </span>
              <span className="lk-rc__mark" aria-hidden="true" />
            </span>
            {o.lead ? (
              <span id={`${id}-d`} className="lk-rc__lead">
                {o.lead}
              </span>
            ) : null}
            {o.points ? (
              <span className="lk-rc__points">
                {o.points.map((p) => (
                  <span key={p} className="lk-rc__point">
                    <IconCheck aria-hidden="true" />
                    {p}
                  </span>
                ))}
              </span>
            ) : null}
            {variant === "level" ? (
              <span className="lk-rc__meter" aria-hidden="true">
                {options.map((_, i) => (
                  <span key={i} data-on={i <= index || undefined} />
                ))}
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}
