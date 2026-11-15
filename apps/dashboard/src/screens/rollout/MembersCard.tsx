import { useState } from "react";
import { Button, Checkbox, Pill } from "@rulebox/ui";
import { useSetRings } from "../../data";
import { RINGS, type Ring, type RolloutRow, type RolloutView } from "../../data/types";
import { Card } from "../../components/Card";
import { FormError } from "../../components/FormError";
import { RoleGate } from "../../components/RoleGate";
import { useCan } from "../../lib/member";
import { useToast } from "../../lib/toast";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";
import { useRun } from "./useRun";

const TONE: Record<Ring, "accent" | "neutral" | "success"> = { pilot: "accent", early: "success", everyone: "neutral" };

/**
 * The group's PCs (the first 100) with their ring, and "Put selected PCs in: Pilot / Early / Everyone" (plan 4.14). With rings on, the
 * pilot ring may not end up empty: the server says `no_pilot_devices`, shown in words. A viewer sees the list only.
 */
export function MembersCard({ groupId, rollout, view }: { groupId: string; rollout: RolloutRow; view: RolloutView }) {
  const setRings = useSetRings();
  const canAct = useCan("admin");
  const toast = useToast();
  const { busy, error, run, clear } = useRun();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // A PC that is no longer listed (moved or removed elsewhere) cannot stay selected.
  const listed = new Set(view.devices.map((d) => d._id));
  const selected = [...picked].filter((id) => listed.has(id));
  const allShown = view.devices.length > 0 && selected.length === view.devices.length;

  function toggle(id: string, on: boolean) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function put(ring: Ring) {
    void run(
      ring,
      async () => {
        const r = await setRings({ groupId, deviceIds: selected, ring, expectedRevision: rollout.revision });
        toast(s.ringChanged(r.changed));
        setPicked(new Set());
      },
    );
  }

  return (
    <Card title={s.membersTitle} sub={s.membersLead}>
      <div className="dash-form">
        {view.devices.length === 0 ? <p className="dash-muted">{s.membersNone}</p> : null}
        {canAct && view.devices.length > 0 ? (
          <div className="dash-roll__bar">
            <Checkbox
              label={s.selectAll}
              checked={allShown}
              onChange={(e) => setPicked(e.target.checked ? new Set(view.devices.map((d) => d._id)) : new Set())}
            />
            <span className="dash-muted" role="status">
              {s.selected(selected.length)}
            </span>
          </div>
        ) : null}
        <ul className="dash-roll__members" aria-label={s.membersTitle}>
          {view.devices.map((d) => (
            <li key={d._id} className="dash-roll__member">
              {canAct ? (
                <Checkbox label={d.name} aria-label={s.selectPc(d.name)} checked={picked.has(d._id)} onChange={(e) => toggle(d._id, e.target.checked)} />
              ) : (
                <span className="dash-truncate">{d.name}</span>
              )}
              <Pill tone={TONE[d.ring]}>{s.rings[d.ring]}</Pill>
            </li>
          ))}
        </ul>
        {view.devicesTruncated ? <p className="dash-muted">{s.membersTruncated}</p> : null}
        <RoleGate minRole="admin">
          {view.devices.length > 0 ? (
            <div className="dash-roll__put" role="group" aria-label={s.putIn}>
              <span className="dash-muted">{s.putIn}</span>
              {RINGS.map((ring) => (
                <Button key={ring} variant="ghost" className="dash-btn--sm" disabled={selected.length === 0 || busy !== null} aria-busy={busy === ring} onClick={() => put(ring)}>
                  {s.rings[ring]}
                </Button>
              ))}
            </div>
          ) : null}
          <FormError error={error} onReload={clear} describe={(e) => rolloutErrorMessage(e, "rings")} />
        </RoleGate>
      </div>
    </Card>
  );
}
