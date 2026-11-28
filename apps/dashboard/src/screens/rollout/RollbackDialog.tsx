import { useState } from "react";
import { Button, Checkbox, InfoTip, Select } from "@rulebox/ui";
import { useRollback } from "../../data";
import { RINGS, type Ring, type RolloutRow, type RolloutView } from "../../data/types";
import { Field, FieldSet } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { formatDate } from "../../lib/format";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { previousChange } from "./stages";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";

/**
 * "Undo the last change" (PRD 24.3: one click). The PCs of every stage go back to the change before the newest one; nothing to choose.
 * Under Advanced: another change to go back to (newest first, the version number only as a hint) and which stages go back (only asked
 * with the staged rollout on: with it off every PC goes back). A major action: `useRollback` opens the step-up dialog and retries once.
 * The group's current settings are not touched: the next edit takes a new version.
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
  const previous = previousChange(rollout, versions);
  const [version, setVersion] = useState(String(previous?.version ?? ""));
  const [stages, setStages] = useState<Record<Ring, boolean>>({ pilot: true, early: true, everyone: true });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const target = sorted.find((v) => String(v.version) === version);
  const chosen = RINGS.filter((r) => stages[r]);
  const stagesProblem = rollout.enabled && chosen.length === 0;
  const none = previous === undefined || target === undefined;

  function submit() {
    if (none || pending) return;
    if (stagesProblem) {
      setAdvancedOpen(true);
      return;
    }
    setPending(true);
    setError(null);
    rollback({ groupId, toVersion: target.version, rings: rollout.enabled ? chosen : [...RINGS], expectedRevision: rollout.revision }).then(
      () => {
        toast(s.undoToast);
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
      title={s.undoTitle}
      onClose={() => !pending && onClose()}
      onSubmit={submit}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={pending || none} aria-busy={pending}>
            {pending ? s.undoWorking : s.undoConfirm}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <p className="dash-dialog__lead ro-lead">
          {s.undoLead}
          <InfoTip label={s.undoInfoLabel}>{s.undoInfo}</InfoTip>
        </p>
        {none ? (
          <p className="ro-note">{s.undoNothing}</p>
        ) : (
          <div className="ro-undo">
            <span className="ro-undo__label">{s.undoGoesBack}</span>
            <strong className="ro-undo__change" title={s.versionTitle(target.version)}>
              {target.reason}
            </strong>
            <span className="ro-undo__date">{formatDate(target.createdAt)}</span>
          </div>
        )}
        {previous !== undefined ? (
          <details
            className="dash-advanced"
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
          >
            <summary>{s.undoAdvanced}</summary>
            <div className="dash-advanced__body">
              <Field label={s.undoPick}>
                {(p) => (
                  <Select
                    {...p}
                    value={version}
                    onChange={setVersion}
                    options={sorted.map((v) => ({
                      value: String(v.version),
                      label: s.undoPickOption(v.reason, formatDate(v.createdAt)),
                      hint: s.undoPickHint(v.version),
                    }))}
                  />
                )}
              </Field>
              {rollout.enabled ? (
                <FieldSet legend={s.undoStages} hint={s.undoStagesHint} error={stagesProblem ? s.undoStagesProblem : null}>
                  <div className="dash-checks dash-checks--inline">
                    {RINGS.map((r) => (
                      <Checkbox key={r} label={s.stages[r]} checked={stages[r]} onChange={(e) => setStages((cur) => ({ ...cur, [r]: e.target.checked }))} />
                    ))}
                  </div>
                </FieldSet>
              ) : (
                <p className="ro-note">{s.undoStagesOff}</p>
              )}
            </div>
          </details>
        ) : null}
        <FormError error={error} describe={(e) => rolloutErrorMessage(e)} />
      </div>
    </Modal>
  );
}
