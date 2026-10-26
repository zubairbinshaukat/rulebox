import type { ReactNode } from "react";
import IconInfo from "~icons/solar/info-circle-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import IconDanger from "~icons/solar/danger-circle-linear";
import IconCheck from "~icons/solar/check-circle-linear";

export type InlineNoticeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const ICONS = {
  neutral: IconInfo,
  accent: IconInfo,
  success: IconCheck,
  warning: IconWarn,
  danger: IconDanger,
} as const;

/**
 * An in-content notice with an optional action (packages/ui `Notice` has no
 * action slot). `alert` = announce immediately (errors after an action).
 */
export function InlineNotice({
  tone = "neutral",
  title,
  detail,
  action,
  alert = false,
}: {
  tone?: InlineNoticeTone;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  alert?: boolean;
}) {
  const Icon = ICONS[tone];
  return (
    <div className={`dash-notice dash-notice--${tone}`} role={alert ? "alert" : "status"}>
      <span className="dash-notice__icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="dash-notice__text">
        <p className="dash-notice__title">{title}</p>
        {detail ? <p className="dash-notice__detail">{detail}</p> : null}
      </div>
      {action ? <div className="dash-notice__action">{action}</div> : null}
    </div>
  );
}
