import { useState } from "react";
import { Pill, Switch } from "@rulebox/ui";
import { useSetRolloutEnabled } from "../../data";
import type { RolloutRow } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { FormError } from "../../components/FormError";
import { useCan } from "../../lib/member";
import { useToast } from "../../lib/toast";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";
import { useRun } from "./useRun";

/**
 * The rings switch (plan 4.14): on needs a PC in the pilot ring (`conflict` `no_pilot_devices`); off asks first, because every ring then
 * gets the newest version at once. A viewer sees the state only.
 */
export function RingsCard({ groupId, rollout }: { groupId: string; rollout: RolloutRow }) {
  const setEnabled = useSetRolloutEnabled();
  const canAct = useCan("admin");
  const toast = useToast();
  const { busy, error, run, clear } = useRun();
  const [confirmOff, setConfirmOff] = useState(false);

  return (
    <Card
      title={s.ringsTitle}
      sub={s.ringsLead}
      actions={<Pill tone={rollout.enabled ? "success" : "neutral"}>{rollout.enabled ? s.ringsOn : s.ringsOff}</Pill>}
    >
      <div className="dash-form">
        {canAct ? (
          <Switch
            checked={rollout.enabled}
            label={s.ringsSwitch}
            disabled={busy !== null}
            onChange={(on) => {
              if (!on) {
                setConfirmOff(true);
                return;
              }
              void run("on", () => setEnabled({ groupId, enabled: true, expectedRevision: rollout.revision }), () => toast(s.ringsOnToast));
            }}
          />
        ) : null}
        {!rollout.enabled ? <p className="dash-muted">{s.ringsOffNote}</p> : null}
        <FormError error={error} onReload={clear} describe={(e) => rolloutErrorMessage(e, "enable")} />
      </div>
      <ConfirmDialog
        open={confirmOff}
        title={s.ringsOffTitle}
        body={s.ringsOffBody}
        confirmLabel={s.ringsOffConfirm}
        onConfirm={() => setEnabled({ groupId, enabled: false, expectedRevision: rollout.revision })}
        onDone={() => toast(s.ringsOffToast)}
        onClose={() => setConfirmOff(false)}
        describeError={(e) => rolloutErrorMessage(e)}
      />
    </Card>
  );
}
