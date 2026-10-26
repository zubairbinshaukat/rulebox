export interface ProgressBarProps {
  /** 0–100 */
  value: number;
  label?: string;
  /** Right-aligned text, e.g. "6.2 of 10 GB". */
  detail?: string;
  /** Accessible name when no visible `label` is drawn (e.g. "Storage"). */
  name?: string;
}

/** Thin progress bar (storage quota, installs). Turns warning from 80% and danger from 95% (PRD 7.8). */
export function ProgressBar({ value, label, detail, name }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, value));
  const tone = pct >= 95 ? "danger" : pct >= 80 ? "warning" : "accent";
  return (
    <div className="rb-progress">
      {(label || detail) && (
        <div className="rb-progress__meta">
          <span>{label}</span>
          <span>{detail}</span>
        </div>
      )}
      <div
        className="rb-progress__track"
        role="progressbar"
        aria-label={name ?? label ?? "Progress"}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={detail}
      >
        <div className={`rb-progress__fill rb-progress__fill--${tone}`} style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
    </div>
  );
}
