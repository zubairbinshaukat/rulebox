import { useState } from "react";
import { Button, Pill } from "@rulebox/ui";
import { usePromoteAll, usePromoteRollout } from "../../data";
import { RINGS, type Ring, type RolloutRow, type RolloutView } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { FormError } from "../../components/FormError";
import { RoleGate } from "../../components/RoleGate";
import { formatDate } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { RollbackDialog } from "./RollbackDialog";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";
import { useRun } from "./useRun";

/**
 * What each ring follows (plan 4.14: three pointers at configuration versions, each with the reason and date of its version), the
 * stage in flight highlighted, and the buttons that move it: Promote, Promote all (asks first) and Roll back (a major action).
 * Resume is on the paused banner. A viewer sees the pointers only.
 */
export function PointersCard({ groupId, rollout, view }: { groupId: string; rollout: RolloutRow; view: RolloutView }) {
  const promote = usePromoteRollout();
  const promoteAll = usePromoteAll();
  const toast = useToast();
  const { busy, error, run, clear } = useRun();
  const [confirmAll, setConfirmAll] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const p = rollout.pointers;
  const halted = rollout.state === "halted";
  const live = rollout.enabled && !halted;
  const canEarly = live && p.pilot !== p.early;
  const canEveryone = live && p.early !== p.everyone;
  const canAll = live && view.stage !== null;
  const note = halted ? s.actionsHalted : !rollout.enabled ? s.actionsOff : !canAll ? s.actionsNothing : null;

  return (
    <Card title={s.pointersTitle} sub={rollout.enabled ? s.pointersLead : s.pointersLeadOff}>
      <div className="dash-form">
        <ul className="dash-roll__rings" aria-label={s.pointersTitle}>
          {RINGS.map((ring) => (
            <RingRow key={ring} ring={ring} version={p[ring]} view={view} inFlight={view.stage?.ring === ring} />
          ))}
        </ul>
        <RoleGate minRole="admin">
          <div className="dash-roll__actions">
            <div className="dash-form__actions">
              {canEarly ? (
                <Button
                  disabled={busy !== null}
                  aria-busy={busy === "early"}
                  onClick={() => void run("early", () => promote({ groupId, to: "early", expectedRevision: rollout.revision }), () => toast(s.promotedToast))}
                >
                  {s.promoteEarly}
                </Button>
              ) : null}
              {canEveryone ? (
                <Button
                  disabled={busy !== null}
                  aria-busy={busy === "everyone"}
                  onClick={() => void run("everyone", () => promote({ groupId, to: "everyone", expectedRevision: rollout.revision }), () => toast(s.promotedToast))}
                >
                  {s.promoteEveryone}
                </Button>
              ) : null}
              {canAll ? (
                <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmAll(true)}>
                  {s.promoteAll}
                </Button>
              ) : null}
              <Button variant="ghost" disabled={busy !== null} onClick={() => setRollingBack(true)}>
                {s.rollback}
              </Button>
            </div>
            {note ? <p className="dash-muted">{note}</p> : null}
            <FormError error={error} onReload={clear} describe={(e) => rolloutErrorMessage(e)} />
          </div>
        </RoleGate>
      </div>
      <ConfirmDialog
        open={confirmAll}
        title={s.promoteAllTitle}
        body={s.promoteAllBody(p.pilot)}
        confirmLabel={s.promoteAllConfirm}
        onConfirm={() => promoteAll({ groupId, expectedRevision: rollout.revision })}
        onDone={() => toast(s.promotedToast)}
        onClose={() => setConfirmAll(false)}
        describeError={(e) => rolloutErrorMessage(e)}
      />
      <RollbackDialog open={rollingBack} groupId={groupId} rollout={rollout} versions={view.versions} onClose={() => setRollingBack(false)} />
    </Card>
  );
}

function RingRow({ ring, version, view, inFlight }: { ring: Ring; version: number; view: RolloutView; inFlight: boolean }) {
  const info = view.versions.find((v) => v.version === version);
  return (
    <li className="dash-roll__ring" data-stage={inFlight || undefined}>
      <span className="dash-cell-stack">
        <strong>{s.rings[ring]}</strong>
        <span className="dash-cell-sub">{s.ringHelp[ring]}</span>
      </span>
      <span className="dash-cell-stack dash-roll__ver">
        <strong>{s.version(version)}</strong>
        <span className="dash-cell-sub dash-wrap">{info ? `${info.reason}, ${formatDate(info.createdAt)}` : s.versionUnknown}</span>
      </span>
      {inFlight ? <Pill tone="accent">{s.inFlight}</Pill> : null}
    </li>
  );
}
