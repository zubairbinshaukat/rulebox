import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  /** The primary action (a button or link). Hidden for viewers by the caller's RoleGate. */
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon, title, body, action, compact }: EmptyStateProps) {
  return (
    <div className={["dash-empty", compact ? "dash-empty--compact" : ""].filter(Boolean).join(" ")}>
      {icon ? (
        <span className="dash-empty__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="dash-empty__title">{title}</p>
      {body ? <p className="dash-empty__body">{body}</p> : null}
      {action ? <div className="dash-empty__action">{action}</div> : null}
    </div>
  );
}
