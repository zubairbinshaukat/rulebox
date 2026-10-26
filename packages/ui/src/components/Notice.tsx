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

/** The tone in words, so it is never told by colour alone. */
const TONE_WORD: Partial<Record<NoticeTone, string>> = {
  success: "Success",
  warning: "Warning",
  danger: "Error",
};

export function Notice({
  tone = "neutral",
  title,
  detail,
  onDismiss,
  className,
  icon,
}: NoticeProps) {
  const cls = ["rb-notice", `rb-notice--${tone}`, className ?? ""].filter(Boolean).join(" ");
  const word = TONE_WORD[tone];

  return (
    // A problem interrupts (alert); everything else waits its turn (status).
    <div className={cls} role={tone === "danger" || tone === "warning" ? "alert" : "status"}>
      {icon ? (
        <span className="rb-notice__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="rb-notice__text">
        <div className="rb-notice__title">
          {word ? <span className="rb-sr-only">{word}: </span> : null}
          {title}
        </div>
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
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}
