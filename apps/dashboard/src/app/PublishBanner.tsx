import { Button } from "@rulebox/ui";
import IconDanger from "~icons/solar/danger-circle-linear";
import { useOverview } from "../data";
import { formatDate } from "../lib/format";
import { useCan } from "../lib/member";
import { messageFor } from "../lib/errors";
import { publishErrorMessage, usePublishAgainFlow } from "../lib/publish";
import { strings } from "../lib/strings";

const s = strings.publish;

/**
 * Shown on every screen while the last publish failed (`publishFailedAt` of `overview:get`, which
 * the Overview shares): PCs keep their last policy and nothing new reaches them. An Owner gets the
 * "Publish again" button (progress and a refusal show right here); others are told to ask one.
 */
export function PublishBanner() {
  const overview = useOverview();
  const isOwner = useCan("owner");
  const { run, pending, error } = usePublishAgainFlow();
  if (overview.status !== "ready" || overview.data.publishFailedAt === null) return null;
  const when = formatDate(overview.data.publishFailedAt);
  return (
    <div className="dash-banner dash-banner--danger" role="alert">
      <span className="dash-banner__icon" aria-hidden="true">
        <IconDanger />
      </span>
      <p className="dash-banner__text">
        <strong>{s.bannerTitle}</strong>
        {isOwner ? s.bannerBody(when) : s.bannerBodyViewer(when)}
      </p>
      {isOwner ? (
        <Button variant="ghost" className="dash-btn--sm" disabled={pending} aria-busy={pending} onClick={run}>
          {pending ? s.publishing : s.again}
        </Button>
      ) : null}
      {error ? <p className="dash-banner__error">{publishErrorMessage(error) ?? messageFor(error)}</p> : null}
    </div>
  );
}
