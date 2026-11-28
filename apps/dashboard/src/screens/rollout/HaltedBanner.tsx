import { Button } from "@rulebox/ui";
import { useResumeRollout } from "../../data";
import type { RolloutRow } from "../../data/types";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { useCan } from "../../lib/member";
import { knownHaltReason } from "../../lib/rolloutRules";
import { useToast } from "../../lib/toast";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";
import { useRun } from "./useRun";

/** The red banner of a paused rollout, with the reason in words. Resume is the page's main action for an admin. */
export function HaltedBanner({ groupId, rollout }: { groupId: string; rollout: RolloutRow }) {
  const resume = useResumeRollout();
  const canAct = useCan("admin");
  const toast = useToast();
  const { busy, error, run, clear } = useRun();
  const reason = knownHaltReason(rollout.haltReason);
  return (
    <div className="ro-halted">
      <InlineNotice
        tone="danger"
        alert
        title={s.haltedTitle}
        detail={`${reason ? s.haltReasons[reason] : s.haltGeneric} ${s.haltedHint}`}
        action={
          canAct ? (
            <Button
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
