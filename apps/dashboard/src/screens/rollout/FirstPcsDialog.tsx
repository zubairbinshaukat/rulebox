import { useState } from "react";
import { Button, Checkbox, Input } from "@rulebox/ui";
import { useSetRings, useSetRolloutEnabled } from "../../data";
import type { RolloutRow, RolloutView } from "../../data/types";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";

/** Show a search box above the list once there are more PCs than this. */
const SEARCH_FROM = 8;

/**
 * "Turn on": which PCs get changes first? The group's PCs (the first 100 `groupView` lists), the PCs already in First ticked, else the
 * first PC. Confirm is two calls the server already has, one after the other: `setRings` (the PCs that are new in First; the ones
 * unticked go back to Everyone) with the revision each returns, then `setEnabled`. Nothing changes on the server's side.
 */
export function FirstPcsDialog({ open, groupId, rollout, view, onClose }: { open: boolean; groupId: string; rollout: RolloutRow; view: RolloutView; onClose: () => void }) {
  if (!open) return null;
  return <Inner groupId={groupId} rollout={rollout} view={view} onClose={onClose} />;
}

function Inner({ groupId, rollout, view, onClose }: { groupId: string; rollout: RolloutRow; view: RolloutView; onClose: () => void }) {
  const setRings = useSetRings();
  const setEnabled = useSetRolloutEnabled();
  const toast = useToast();
  const inFirst = view.devices.filter((d) => d.ring === "pilot").map((d) => d._id);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(inFirst.length > 0 ? inFirst : view.devices.slice(0, 1).map((d) => d._id)));
  const [find, setFind] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const text = find.trim().toLowerCase();
  const shown = text === "" ? view.devices : view.devices.filter((d) => d.name.toLowerCase().includes(text));

  function toggle(id: string, on: boolean) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function submit() {
    if (pending || picked.size === 0) return;
    setPending(true);
    setError(null);
    try {
      let revision = rollout.revision;
      const before = new Set(inFirst);
      const added = [...picked].filter((id) => !before.has(id));
      const removed = inFirst.filter((id) => !picked.has(id));
      // PCs that leave First first, so First is never empty by mistake; the new ones next; each call returns the revision for the next.
      if (removed.length > 0) revision = (await setRings({ groupId, deviceIds: removed, ring: "everyone", expectedRevision: revision })).revision;
      if (added.length > 0) revision = (await setRings({ groupId, deviceIds: added, ring: "pilot", expectedRevision: revision })).revision;
      await setEnabled({ groupId, enabled: true, expectedRevision: revision });
      toast(s.turnedOnToast);
      onClose();
    } catch (e) {
      setError(e);
      setPending(false);
    }
  }

  return (
    <Modal
      open
      title={s.firstTitle}
      onClose={() => !pending && onClose()}
      onSubmit={() => void submit()}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={pending || picked.size === 0} aria-busy={pending}>
            {pending ? s.firstWorking : s.firstConfirm}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <p className="dash-dialog__lead">{s.firstLead}</p>
        {view.devices.length > SEARCH_FROM ? <Input type="search" aria-label={s.firstFind} placeholder={s.firstFind} value={find} autoComplete="off" onChange={(e) => setFind(e.target.value)} /> : null}
        <ul className="ro-pick" aria-label={s.firstTitle}>
          {shown.map((d) => (
            <li key={d._id} className="ro-pick__row" data-picked={picked.has(d._id) || undefined}>
              <Checkbox label={<span className="dash-truncate">{d.name}</span>} checked={picked.has(d._id)} onChange={(e) => toggle(d._id, e.target.checked)} />
            </li>
          ))}
          {shown.length === 0 ? <li className="ro-note">{s.firstNone}</li> : null}
        </ul>
        {view.devicesTruncated ? <p className="ro-note">{s.membersTruncated}</p> : null}
        <p className="ro-note" role="status">
          {s.firstPick(picked.size)}
        </p>
        <FormError error={error} describe={(e) => rolloutErrorMessage(e, "enable")} />
      </div>
    </Modal>
  );
}
