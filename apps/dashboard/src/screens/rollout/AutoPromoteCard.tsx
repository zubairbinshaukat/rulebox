import { useState } from "react";
import { Button, Input, Switch } from "@rulebox/ui";
import { useSetAutoPromote } from "../../data";
import type { RolloutRow } from "../../data/types";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { useCan } from "../../lib/member";
import { bakeProblem, draftChanged, draftOf, failureProblem, type AutoPromoteDraft, type WholeProblem } from "../../lib/rolloutRules";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";

/**
 * Automatic promotion (plan 4.14): off by default; bake time 1-168 hours, failure percentage 1-100 that halts the rollout, and whether
 * a halt returns the pilot ring to the early version. One save sends all four. A viewer reads a sentence instead of a form.
 */
export function AutoPromoteCard({ groupId, rollout }: { groupId: string; rollout: RolloutRow }) {
  const canAct = useCan("admin");
  const [formKey, setFormKey] = useState(0);
  const a = rollout.autoPromote;
  return (
    <Card title={s.autoTitle} sub={s.autoLead}>
      {canAct ? (
        // A fresh form (the saved values again) after "Reload" on a stale edit.
        <AutoForm key={formKey} groupId={groupId} rollout={rollout} onReload={() => setFormKey((k) => k + 1)} />
      ) : (
        <p className="dash-muted">{s.autoReadOnly(a.enabled, a.bakeHours, a.maxFailurePct, rollout.autoRollback)}</p>
      )}
    </Card>
  );
}

function messageOf(problem: WholeProblem, range: string): string {
  return problem === "range" ? range : s.whole[problem];
}

function AutoForm({ groupId, rollout, onReload }: { groupId: string; rollout: RolloutRow; onReload: () => void }) {
  const save = useSetAutoPromote();
  const toast = useToast();
  const [draft, setDraft] = useState<AutoPromoteDraft>(() => draftOf(rollout));
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const bake = bakeProblem(draft.bake);
  const pct = failureProblem(draft.pct);
  const changed = draftChanged(draft, rollout);

  function submit() {
    setTouched(true);
    if (bake || pct || pending || !changed) return;
    setPending(true);
    setError(null);
    save({
      groupId,
      enabled: draft.enabled,
      bakeHours: Number(draft.bake.trim()),
      maxFailurePct: Number(draft.pct.trim()),
      autoRollback: draft.autoRollback,
      expectedRevision: rollout.revision,
    }).then(
      () => {
        setPending(false);
        setTouched(false);
        toast(s.autoSaved);
      },
      (e) => {
        setPending(false);
        setError(e);
      },
    );
  }

  return (
    <form
      className="dash-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="dash-net__switch">
        <Switch checked={draft.enabled} onChange={(on) => setDraft((d) => ({ ...d, enabled: on }))} label={s.autoSwitch} disabled={pending} />
        <span className="dash-cell-sub">{s.autoSwitchHint}</span>
      </div>
      <Field label={s.autoBake} hint={s.autoBakeHint} error={touched && bake ? messageOf(bake, s.bakeRange) : null} required>
        {(p) => <Input {...p} value={draft.bake} inputMode="numeric" autoComplete="off" onChange={(e) => setDraft((d) => ({ ...d, bake: e.target.value }))} />}
      </Field>
      <Field label={s.autoPct} hint={s.autoPctHint} error={touched && pct ? messageOf(pct, s.pctRange) : null} required>
        {(p) => <Input {...p} value={draft.pct} inputMode="numeric" autoComplete="off" onChange={(e) => setDraft((d) => ({ ...d, pct: e.target.value }))} />}
      </Field>
      <div className="dash-net__switch">
        <Switch checked={draft.autoRollback} onChange={(on) => setDraft((d) => ({ ...d, autoRollback: on }))} label={s.autoRollback} disabled={pending} />
        <span className="dash-cell-sub">{s.autoRollbackHint}</span>
      </div>
      <FormError error={error} onReload={onReload} describe={(e) => rolloutErrorMessage(e)} />
      <div className="dash-form__actions">
        <Button type="submit" disabled={pending || !changed} aria-busy={pending}>
          {pending ? strings.common.saving : s.autoSave}
        </Button>
        <Button variant="ghost" disabled={pending || !changed} onClick={() => setDraft(draftOf(rollout))}>
          {s.autoReset}
        </Button>
        {changed ? <span className="dash-form__status">{strings.common.unsavedHint}</span> : null}
      </div>
    </form>
  );
}
