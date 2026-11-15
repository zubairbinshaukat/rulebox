import { useParams } from "react-router";
import { Button } from "@rulebox/ui";
import IconRocket from "~icons/solar/rocket-2-linear";
import { useResumeRollout, useRolloutView } from "../data";
import type { RolloutRow, RolloutView } from "../data/types";
import { EmptyState } from "../components/EmptyState";
import { FormError } from "../components/FormError";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { useCan } from "../lib/member";
import { knownHaltReason } from "../lib/rolloutRules";
import { useToast } from "../lib/toast";
import { AutoPromoteCard } from "./rollout/AutoPromoteCard";
import { HealthCard, IdleHealthCard } from "./rollout/HealthCard";
import { MembersCard } from "./rollout/MembersCard";
import { PointersCard } from "./rollout/PointersCard";
import { RingsCard } from "./rollout/RingsCard";
import { rolloutErrorMessage, rolloutStrings as s } from "./rollout/strings";
import { useRun } from "./rollout/useRun";

/**
 * `/groups/:id/rollout` (plan 4.14, 4.20): rings on or off, what each ring follows, how the stage in flight is going, promotion,
 * rollback, automatic promotion and the group's PCs with their ring. `rollouts:groupView` is the quiet query; the health numbers are
 * their own subscription (`rollouts:health`), only while a stage is in flight. Admins change things, viewers read.
 */
export default function Rollout() {
  const { id = "" } = useParams();
  const view = useRolloutView(id);
  const back = { to: `/groups/${id}`, label: s.back };
  return (
    <div className="dash-page">
      {view.status !== "ready" ? <PageHeader title={view.status === "loading" ? s.loadingTitle : s.title} back={back} /> : null}
      <QueryRegion state={view} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={5} /></div>}>
        {(v) => <Body groupId={id} v={v} back={back} />}
      </QueryRegion>
    </div>
  );
}

function Body({ groupId, v, back }: { groupId: string; v: RolloutView; back: { to: string; label: string } }) {
  const r = v.rollout;
  return (
    <>
      <PageHeader back={back} title={<span className="dash-wrap">{s.titleFor(v.groupName)}</span>} lead={s.lead} />
      {r === null ? (
        <div className="dash-card dash-card--pad">
          <EmptyState icon={<IconRocket />} title={s.noneTitle} body={s.noneBody} />
        </div>
      ) : (
        <>
          {r.state === "halted" ? <HaltedBanner groupId={groupId} rollout={r} /> : null}
          <RingsCard groupId={groupId} rollout={r} />
          <PointersCard groupId={groupId} rollout={r} view={v} />
          {v.stage !== null ? <HealthCard groupId={groupId} /> : r.enabled ? <IdleHealthCard /> : null}
          <AutoPromoteCard groupId={groupId} rollout={r} />
          <MembersCard groupId={groupId} rollout={r} view={v} />
        </>
      )}
    </>
  );
}

/** The red banner of a halted rollout, with the reason in words and Resume for an admin. */
function HaltedBanner({ groupId, rollout }: { groupId: string; rollout: RolloutRow }) {
  const resume = useResumeRollout();
  const canAct = useCan("admin");
  const toast = useToast();
  const { busy, error, run, clear } = useRun();
  const reason = knownHaltReason(rollout.haltReason);
  return (
    <div className="dash-form">
      <InlineNotice
        tone="danger"
        alert
        title={s.haltedTitle}
        detail={`${reason ? s.haltReasons[reason] : s.haltGeneric} ${s.haltedHint}`}
        action={
          canAct ? (
            <Button
              variant="ghost"
              className="dash-btn--sm"
              disabled={busy !== null}
              aria-busy={busy !== null}
              onClick={() => void run("resume", () => resume({ groupId, expectedRevision: rollout.revision }), () => toast(s.resumedToast))}
            >
              {s.resume}
            </Button>
          ) : undefined
        }
      />
      <FormError error={error} onReload={clear} describe={(e) => rolloutErrorMessage(e)} />
    </div>
  );
}
