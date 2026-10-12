import type { ReactNode } from "react";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  /** Small line under the value, e.g. "+2 today". */
  hint?: ReactNode;
}

/** Dashboard number card: icon, big value, label. */
export function StatCard({ label, value, icon, hint }: StatCardProps) {
  return (
    <div className="rb-stat">
      {icon && <div className="rb-stat__icon">{icon}</div>}
      <div className="rb-stat__value">{value}</div>
      <div className="rb-stat__label">{label}</div>
      {hint && <div className="rb-stat__hint">{hint}</div>}
    </div>
  );
}
