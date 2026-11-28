import { useState } from "react";
import { Link, useParams } from "react-router";
import { InfoTip } from "@rulebox/ui";
import IconRocket from "~icons/solar/rocket-2-linear";
import IconUndo from "~icons/solar/undo-left-linear";
import IconPower from "~icons/solar/power-linear";
import { useRolloutView } from "../data";
import type { RolloutView } from "../data/types";
import { EmptyState } from "../components/EmptyState";
import { MoreMenu, type MoreMenuItem } from "../components/MoreMenu";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { useCan } from "../lib/member";
import { AutoPromoteCard } from "./rollout/AutoPromoteCard";
import { HaltedBanner } from "./rollout/HaltedBanner";
import { MembersCard } from "./rollout/MembersCard";
import { Pipeline } from "./rollout/Pipeline";
import { RolloutDialogs, type RolloutDialog } from "./rollout/RolloutDialogs";
import { previousChange } from "./rollout/stages";
import { rolloutStrings as s } from "./rollout/strings";
import { TurnOnCard } from "./rollout/TurnOnCard";
import "./rollout/rollout.css";

/**
 * `/groups/:id/rollout` (UI pass, `docs/plans/ui-pass/other-pages.md` section 3): the group's staged rollout as three connected stages
 * (First, Early, Everyone) with the next action on the stage that is testing; "Turn on" first asks which PCs go first; "Moves on by
 * itself" is Off / Careful / Quick with the numbers under Advanced; the group's PCs and their stage; "Undo the last change" in a dialog.
 * `rollouts:groupView` is the quiet query; the health numbers are their own subscription (`rollouts:health`), only while a stage is in
 * flight (the stage's card mounts it). Admins change things, viewers read.
 */
export default function Rollout() {
  const { id = "" } = useParams();
  const view = useRolloutView(id);
  const back = { to: `/groups/${id}`, label: view.status === "ready" ? view.data.groupName : s.backFallback };
  return (
    <div className="dash-page ro-page">
      {view.status !== "ready" ? <PageHeader title={view.status === "loading" ? s.loadingTitle : s.title} back={back} /> : null}
      <QueryRegion state={view} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={5} /></div>}>
        {(v) => <Body groupId={id} v={v} back={back} />}
      </QueryRegion>
    </div>
  );
}

function Body({ groupId, v, back }: { groupId: string; v: RolloutView; back: { to: string; label: string } }) {
  const r = v.rollout;
  const canAct = useCan("admin");
  const [dialog, setDialog] = useState<RolloutDialog | null>(null);
  const halted = r?.state === "halted";
  const items: MoreMenuItem[] =
    r === null || !canAct
      ? []
      : [
          { label: s.sendEveryoneNow, onSelect: () => setDialog("everyone"), hidden: v.stage === null || halted },
          { label: s.undo, icon: <IconUndo aria-hidden="true" />, onSelect: () => setDialog("undo"), hidden: previousChange(r, v.versions) === undefined },
          { label: s.turnOff, icon: <IconPower aria-hidden="true" />, onSelect: () => setDialog("off"), hidden: !r.enabled },
        ];
  return (
    <>
      <PageHeader
        back={back}
        title={s.title}
        lead={
          <>
            {s.lead(v.groupName)} <InfoTip label={s.leadInfoLabel}>{s.leadInfo}</InfoTip>
          </>
        }
        actions={<MoreMenu items={items} label={s.moreLabel} />}
      />
      {r === null ? (
        <div className="dash-card dash-card--pad">
          <EmptyState
            icon={<IconRocket />}
            title={s.noneTitle}
            body={s.noneBody}
            action={
              <Link to={back.to} className="rb-btn rb-btn--ghost">
                {s.noneAction}
              </Link>
            }
          />
        </div>
      ) : (
        <>
          {halted ? <HaltedBanner groupId={groupId} rollout={r} /> : null}
          {r.enabled ? (
            <>
              <Pipeline groupId={groupId} rollout={r} view={v} onAction={setDialog} />
              <div className="dash-split ro-split">
                <div className="dash-split__main">
                  <MembersCard groupId={groupId} rollout={r} view={v} />
                </div>
                <div className="dash-split__aside">
                  <AutoPromoteCard groupId={groupId} rollout={r} />
                </div>
              </div>
            </>
          ) : (
            <>
              <TurnOnCard view={v} onTurnOn={() => setDialog("first")} />
              <MembersCard groupId={groupId} rollout={r} view={v} />
            </>
          )}
          <RolloutDialogs dialog={dialog} groupId={groupId} rollout={r} view={v} onClose={() => setDialog(null)} />
        </>
      )}
    </>
  );
}
