import { useState } from "react";
import { Button, Checkbox, Input, Pill, Select } from "@rulebox/ui";
import { useSetRings } from "../../data";
import { RINGS, type Ring, type RolloutRow, type RolloutView } from "../../data/types";
import { FormError } from "../../components/FormError";
import { useCan } from "../../lib/member";
import { useToast } from "../../lib/toast";
import { RoSection } from "./Section";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";
import { useRun } from "./useRun";

const TONE: Record<Ring, "accent" | "neutral" | "success"> = { pilot: "accent", early: "success", everyone: "neutral" };

/** Show a search box above the list once there are more PCs than this. */
const SEARCH_FROM = 10;

const STAGE_OPTIONS = RINGS.map((ring) => ({ value: ring, label: s.stages[ring] }));

/**
 * "Which PCs go first": the group's PCs (the first 100) as a list of tiles with their stage, and for an admin a bar that appears when
 * PCs are ticked: "Move to [First] [Move]". With the staged rollout on, First may not end up empty: the server says
 * `no_pilot_devices`, shown in words. A viewer sees the list only.
 */
export function MembersCard({ groupId, rollout, view }: { groupId: string; rollout: RolloutRow; view: RolloutView }) {
  const setRings = useSetRings();
  const canAct = useCan("admin");
  const toast = useToast();
  const { busy, error, run, clear } = useRun();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState<Ring>("pilot");
  const [find, setFind] = useState("");
  const text = find.trim().toLowerCase();
  const shown = text === "" ? view.devices : view.devices.filter((d) => d.name.toLowerCase().includes(text));
  // A PC that is no longer listed (moved or removed elsewhere) cannot stay selected.
  const listed = new Set(view.devices.map((d) => d._id));
  const selected = [...picked].filter((id) => listed.has(id));
  const allShown = shown.length > 0 && shown.every((d) => picked.has(d._id));

  function toggle(id: string, on: boolean) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function move() {
    void run("move", async () => {
      const r = await setRings({ groupId, deviceIds: selected, ring: target, expectedRevision: rollout.revision });
      toast(s.ringChanged(r.changed));
      setPicked(new Set());
    });
  }

  return (
    <RoSection title={s.membersTitle} info={s.membersInfo} infoLabel={s.membersInfoLabel} className="ro-members">
      {view.devices.length === 0 ? <p className="ro-note">{s.membersNone}</p> : null}
      {view.devices.length > 0 ? (
        <>
          {canAct || view.devices.length > SEARCH_FROM ? (
            <div className="ro-members__bar">
              {canAct ? (
                <Checkbox
                  label={s.selectAll}
                  checked={allShown}
                  onChange={(e) =>
                    setPicked((cur) => {
                      const next = new Set(cur);
                      for (const d of shown) {
                        if (e.target.checked) next.add(d._id);
                        else next.delete(d._id);
                      }
                      return next;
                    })
                  }
                />
              ) : null}
              {view.devices.length > SEARCH_FROM ? (
                <Input type="search" className="ro-members__find" aria-label={s.membersFind} placeholder={s.membersFind} value={find} autoComplete="off" onChange={(e) => setFind(e.target.value)} />
              ) : null}
            </div>
          ) : null}
          <ul className="ro-members__list" aria-label={s.membersTitle}>
            {shown.map((d) => (
              <li key={d._id} className="ro-pc" data-picked={picked.has(d._id) || undefined}>
                {canAct ? (
                  <Checkbox label={<span className="dash-truncate">{d.name}</span>} aria-label={s.selectPc(d.name)} checked={picked.has(d._id)} onChange={(e) => toggle(d._id, e.target.checked)} />
                ) : (
                  <span className="dash-truncate">{d.name}</span>
                )}
                <Pill tone={TONE[d.ring]}>{s.stages[d.ring]}</Pill>
              </li>
            ))}
          </ul>
          {shown.length === 0 ? <p className="ro-note">{s.membersNoMatch}</p> : null}
        </>
      ) : null}
      {view.devicesTruncated ? <p className="ro-note">{s.membersTruncated}</p> : null}
      {canAct && selected.length > 0 ? (
        <div className="ro-move dash-enter" role="group" aria-label={s.move}>
          <span className="ro-move__count" role="status">
            {s.selected(selected.length)}
          </span>
          <span className="ro-move__to">
            <span id="ro-move-to">{s.moveTo}</span>
            <Select compact aria-labelledby="ro-move-to" className="ro-move__select" value={target} onChange={(v) => setTarget(v as Ring)} options={STAGE_OPTIONS} disabled={busy !== null} />
          </span>
          <Button disabled={busy !== null} aria-busy={busy === "move"} onClick={move}>
            {busy === "move" ? s.moving : s.move}
          </Button>
        </div>
      ) : null}
      {canAct ? <FormError error={error} onReload={clear} describe={(e) => rolloutErrorMessage(e, "rings")} /> : null}
    </RoSection>
  );
}
