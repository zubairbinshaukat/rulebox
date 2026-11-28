import { useState } from "react";
import { Button, Checkbox, NativeSelect } from "@rulebox/ui";
import { useRollback } from "../../data";
import { RINGS, type Ring, type RolloutRow, type RolloutView } from "../../data/types";
import { Field, FieldSet } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { formatDate } from "../../lib/format";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";

/**
 * Roll the group back (plan 4.14): pick an older version and the rings that go back to it. With rings off every PC goes back, so the
 * ring list is not asked for. A major action: `useRollback` opens the step-up dialog and retries once. The current settings are not
 * touched: the next edit takes a new version.
 */
export function RollbackDialog({
  open,
  groupId,
  rollout,
  versions,
  onClose,
}: {
  open: boolean;
  groupId: string;
  rollout: RolloutRow;
  versions: RolloutView["versions"];
  onClose: () => void;
}) {
  if (!open) return null;
  return <Inner groupId={groupId} rollout={rollout} versions={versions} onClose={onClose} />;
}

function Inner({ groupId, rollout, versions, onClose }: { groupId: string; rollout: RolloutRow; versions: RolloutView["versions"]; onClose: () => void }) {
  const rollback = useRollback();
  const toast = useToast();
  // The newest version older than the newest one any ring follows; else the newest kept.
  const newest = Math.max(rollout.pointers.pilot, rollout.pointers.early, rollout.pointers.everyone);
  const [version, setVersion] = useState(String((versions.find((v) => v.version < newest) ?? versions[0])?.version ?? ""));
  const [rings, setRings] = useState<Record<Ring, boolean>>({ pilot: true, early: true, everyone: true });
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const chosen = RINGS.filter((r) => rings[r]);
  const ringsProblem = rollout.enabled && chosen.length === 0;
  const none = versions.length === 0;

  function submit() {
    setTouched(true);
    if (none || ringsProblem || pending) return;
    setPending(true);
    setError(null);
    rollback({ groupId, toVersion: Number(version), rings: rollout.enabled ? chosen : [...RINGS], expectedRevision: rollout.revision }).then(
      () => {
        toast(s.rolledBackToast);
        onClose();
      },
      (e) => {
        setPending(false);
        setError(e);
      },
    );
  }

  return (
    <Modal
      open
      title={s.rollbackTitle}
      onClose={() => !pending && onClose()}
      onSubmit={submit}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={pending || none} aria-busy={pending}>
            {pending ? s.rollingBack : s.rollbackConfirm}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <p className="dash-dialog__lead">{s.rollbackLead}</p>
        {none ? (
          <p className="dash-muted">{s.rollbackNoVersions}</p>
        ) : (
          <Field label={s.rollbackVersion}>
            {(p) => (
              <NativeSelect {...p} value={version} onChange={(e) => setVersion(e.target.value)}>
                {versions.map((v) => (
                  <option key={v.version} value={String(v.version)}>
                    {s.rollbackVersionOption(v.version, v.reason, formatDate(v.createdAt))}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        {rollout.enabled ? (
          <FieldSet legend={s.rollbackRings} hint={s.rollbackRingsHint} error={touched && ringsProblem ? s.rollbackRingsProblem : null}>
            <div className="dash-checks dash-checks--inline">
              {RINGS.map((r) => (
                <Checkbox key={r} label={s.rings[r]} checked={rings[r]} onChange={(e) => setRings((cur) => ({ ...cur, [r]: e.target.checked }))} />
              ))}
            </div>
          </FieldSet>
        ) : (
          <p className="dash-muted">{s.rollbackRingsOff}</p>
        )}
        <FormError error={error} describe={(e) => rolloutErrorMessage(e)} />
      </div>
    </Modal>
  );
}
