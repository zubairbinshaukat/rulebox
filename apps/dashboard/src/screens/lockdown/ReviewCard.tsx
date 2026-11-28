import { Link } from "react-router";
import { Pill } from "@rulebox/ui";
import IconList from "~icons/solar/checklist-minimalistic-linear";
import type { Id } from "../../data/types";
import { LkSection } from "./Section";
import { lockdownStrings as s } from "./strings";

/**
 * "Programs to review": how many programs the trial run found that nobody decided on yet, and the way to the list. The count is the
 * organization's (as before: `lockdown:groupView.openFindings`, capped); the link carries the group so the Allow dialog preselects it.
 */
export function ReviewCard({ groupId, count, more, className }: { groupId: Id; count: number; more: boolean; className?: string }) {
  return (
    <LkSection
      title={s.reviewTitle}
      className={["lk-review", className ?? ""].filter(Boolean).join(" ")}
      actions={
        count > 0 ? (
          <Pill tone="accent" className="lk-review__count">
            {s.reviewCount(count, more)}
          </Pill>
        ) : null
      }
    >
      <div className="lk-review__body">
        <span className="lk-review__icon" aria-hidden="true">
          <IconList />
        </span>
        <p className="lk-review__lead">{count > 0 ? s.reviewLead : s.reviewNone}</p>
        <Link className="rb-btn rb-btn--ghost dash-btn--sm lk-review__link" to={`/lockdown/findings?group=${encodeURIComponent(groupId)}`}>
          {s.reviewOpen}
        </Link>
      </div>
    </LkSection>
  );
}
