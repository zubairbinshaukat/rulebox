import type { ReactNode } from "react";

export type NoticeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface NoticeProps {
  tone?: NoticeTone;
  title: string;
  detail?: string;
  onDismiss?: () => void;
  className?: string;
  icon?: ReactNode;
}

export function Notice({
  tone = "neutral",
  title,
  detail,
  onDismiss,
  className,
  icon,
}: NoticeProps) {
  const cls = ["rb-notice", `rb-notice--${tone}`, className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={cls} role="status">
      {icon ? <span className="rb-notice__icon">{icon}</span> : null}
      <div className="rb-notice__text">
        <div className="rb-notice__title">{title}</div>
        {detail ? <div className="rb-notice__detail">{detail}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="rb-notice__dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
