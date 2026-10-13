import { LogoMotion } from "./LogoMotion";

export interface SpinnerProps {
  /** Mark size in px (passed to LogoMotion). */
  size?: number;
  className?: string;
}

/** Loading spinner: LogoMotion loading animation, no wordmark. */
export function Spinner({ size = 48, className }: SpinnerProps) {
  const cls = ["rb-spinner", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={cls} role="status" aria-label="Loading">
      <LogoMotion animation="loading" wordmark={false} size={size} />
    </div>
  );
}
