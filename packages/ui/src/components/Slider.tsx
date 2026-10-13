import type { ChangeEvent } from "react";

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  disabled?: boolean;
  className?: string;
}

/** Native range input, styled. */
export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  disabled = false,
  className,
}: SliderProps) {
  const cls = ["rb-slider", className ?? ""].filter(Boolean).join(" ");
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    onChange(Number(e.target.value));
  }

  return (
    <label className={cls} data-disabled={disabled || undefined}>
      <span className="rb-slider__label">{label}</span>
      <input
        type="range"
        className="rb-slider__input"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={handleChange}
        style={{ ["--rb-slider-pct" as string]: `${pct}%` }}
      />
      <span className="rb-slider__value" aria-hidden="true">
        {value}
      </span>
    </label>
  );
}
