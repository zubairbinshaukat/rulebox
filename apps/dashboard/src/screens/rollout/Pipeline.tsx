import { Button, InfoTip, Pill, type PillTone } from "@rulebox/ui";
import IconUndo from "~icons/solar/undo-left-linear";
import IconClock from "~icons/solar/clock-circle-linear";
import { usePromoteRollout } from "../../data";
import { RINGS, type RolloutRow, type RolloutView } from "../../data/types";
import { FormError } from "../../components/FormError";
import { RoleGate } from "../../components/RoleGate";
import { formatDate, formatDuration } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { useToast } from "../../lib/toast";
import { StageHealth } from "./StageHealth";
import { changeOf, movesOnAt, nextStage, previousChange, stageCounts, stageStates, type StageState } from "./stages";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";
import { useRun } from "./useRun";

const TONE: Record<StageState, PillTone> = { done: "success", testing: "accent", waiting: "neutral", paused: "danger" };

export type PipelineAction = "everyone" | "undo";

/**
 * The three stages as connected cards (First, Early, Everyone): what each has, its state, and on the stage that is testing how its PCs
 * are doing and the one next action ("Send to Early PCs" / "Send to everyone"). "Send to everyone now" and "Undo the last change" sit
 * under the stages (and in the page's More menu). Version numbers are not in the cards: they are in "Technical details" and in the
 * `title` of a change. A viewer sees the stages and no buttons.
 */
export function Pipeline({
  groupId,
  rollout,
  view,
  onAction,
}: {
  groupId: string;
  rollout: RolloutRow;
  view: RolloutView;
  onAction: (action: PipelineAction) => void;
}) {
  const promote = usePromoteRollout();
  const toast = useToast();
  const now = useNow(60_000);
  const { busy, error, run, clear } = useRun();
  const states = stageStates(rollout, view.stage);
  const { counts, truncated } = stageCounts(view);
  const halted = rollout.state === "halted";
  const next = halted ? null : nextStage(view.stage);
  const hasPrevious = previousChange(rollout, view.versions) !== undefined;
  const movesAt = movesOnAt(rollout, view.stage);

  function send(to: "early" | "everyone") {
    void run(to, () => promote({ groupId, to, expectedRevision: rollout.revision }), () => toast(s.sentToast));
  }

  return (
    <section className="ro-pipe-wrap" aria-label={s.stagesLabel}>
      <ol className="ro-pipe">
        {RINGS.map((ring, i) => {
          const state = states[ring];
          const active = view.stage?.ring === ring;
          const change = changeOf(view.versions, rollout.pointers[ring]);
          const previous = i > 0 ? s.stages[RINGS[i - 1]!] : null;
          return (
            <li key={ring} className="ro-stage" data-ring={ring} data-state={state} data-passed={state === "done" || undefined}>
              <div className="ro-stage__top">
                <span className="ro-stage__num" aria-hidden="true">
                  {i + 1}
                </span>
                <h3 className="ro-stage__name">{s.stages[ring]}</h3>
                <InfoTip label={s.stageHelpLabel(s.stages[ring])}>{s.stageHelp[ring]}</InfoTip>
              </div>
              <div className="ro-stage__state">
                <Pill tone={TONE[state]} dot={state === "testing"}>
                  {s.stageStates[state]}
                </Pill>
                <span className="ro-stage__count">{s.stageCount(counts[ring], truncated)}</span>
              </div>
              <p className="ro-stage__has" title={s.versionTitle(rollout.pointers[ring])}>
                <span className="ro-stage__haslabel">{s.hasLabel[state]}</span>
                {change ? (
                  <>
                    <strong className="ro-stage__change">{change.reason}</strong>
                    <span className="ro-stage__date">{formatDate(change.createdAt)}</span>
                  </>
                ) : (
                  <span className="ro-stage__date">{s.unknownChange}</span>
                )}
              </p>
              {state === "waiting" && previous ? (
                <p className="ro-stage__wait">
                  <IconClock aria-hidden="true" />
                  <span>{s.waitsFor(previous)}</span>
                </p>
              ) : null}
              {active ? (
                <div className="ro-stage__live">
                  <StageHealth groupId={groupId} />
                  {state === "testing" && movesAt !== null ? (
                    <p className="ro-stage__auto">
                      <IconClock aria-hidden="true" />
                      <span>{movesAt - now > 60_000 ? s.movesOnIn(formatDuration(movesAt - now)) : s.movesOnSoon}</span>
                    </p>
                  ) : null}
                  <RoleGate minRole="admin">
                    {state === "testing" && next !== null ? (
                      <Button className="ro-stage__send" disabled={busy !== null} aria-busy={busy === next} onClick={() => send(next)}>
                        {next === "early" ? s.sendEarly : s.sendEveryone}
                      </Button>
                    ) : null}
                  </RoleGate>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <RoleGate minRole="admin">
        {(view.stage !== null && !halted) || hasPrevious ? (
          <div className="ro-pipe__actions">
            {view.stage !== null && !halted ? (
              <Button variant="ghost" disabled={busy !== null} onClick={() => onAction("everyone")}>
                {s.sendEveryoneNow}
              </Button>
            ) : null}
            {hasPrevious ? (
              <Button variant="ghost" disabled={busy !== null} onClick={() => onAction("undo")}>
                <IconUndo aria-hidden="true" />
                {s.undo}
              </Button>
            ) : null}
          </div>
        ) : null}
        <FormError error={error} onReload={clear} describe={(e) => rolloutErrorMessage(e)} />
      </RoleGate>
      {view.stage === null ? <p className="ro-note ro-pipe__level">{s.allLevel}</p> : null}
      <details className="dash-advanced ro-tech">
        <summary>{s.technical}</summary>
        <div className="dash-advanced__body">
          <ul className="ro-tech__list">
            {RINGS.map((ring) => (
              <li key={ring}>{s.technicalVersion(s.stages[ring], rollout.pointers[ring])}</li>
            ))}
          </ul>
        </div>
      </details>
    </section>
  );
}
