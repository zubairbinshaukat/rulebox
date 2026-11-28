import { useId, useState } from "react";
import { Button, InfoTip, Input, Switch } from "@rulebox/ui";
import { useSetAutoPromote } from "../../data";
import type { RolloutRow } from "../../data/types";
import { ChoiceCards } from "../../components/ChoiceCards";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { useCan } from "../../lib/member";
import { bakeProblem, draftChanged, draftOf, failureProblem, type AutoPromoteDraft, type WholeProblem } from "../../lib/rolloutRules";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { RoSection } from "./Section";
import { applyMode, modeOf, type AutoMode } from "./stages";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";

/**
 * "Moves on by itself": Off, Careful or Quick (two presets of the bake time and the failure share; "Custom" shows when the saved numbers
 * match neither). The numbers and "send the first PCs back when it stops" are under Advanced. One save sends all four values, as before.
 * A viewer reads one sentence instead of the form.
 */
export function AutoPromoteCard({ groupId, rollout }: { groupId: string; rollout: RolloutRow }) {
  const canAct = useCan("admin");
  const [formKey, setFormKey] = useState(0);
  const a = rollout.autoPromote;
  return (
    <RoSection title={s.autoTitle} info={s.autoInfo} infoLabel={s.autoInfoLabel} className="ro-auto">
      {canAct ? (
        // A fresh form (the saved values again) after "Reload" on a stale edit.
        <AutoForm key={formKey} groupId={groupId} rollout={rollout} onReload={() => setFormKey((k) => k + 1)} />
      ) : (
        <p className="ro-auto__read">
          {s.autoReadOnly(modeOf(draftOf(rollout)), a.bakeHours, a.maxFailurePct)} {a.enabled ? s.autoReadOnlyBack(rollout.autoRollback) : ""}
        </p>
      )}
    </RoSection>
  );
}

function messageOf(problem: WholeProblem, range: string): string {
  return problem === "range" ? range : s.whole[problem];
}

function AutoForm({ groupId, rollout, onReload }: { groupId: string; rollout: RolloutRow; onReload: () => void }) {
  const save = useSetAutoPromote();
  const toast = useToast();
  const headingId = useId();
  const [draft, setDraft] = useState<AutoPromoteDraft>(() => draftOf(rollout));
  const [touched, setTouched] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const bake = bakeProblem(draft.bake);
  const pct = failureProblem(draft.pct);
  const changed = draftChanged(draft, rollout);
  const mode = modeOf(draft);

  function submit() {
    setTouched(true);
    if (bake || pct) {
      setAdvancedOpen(true);
      return;
    }
    if (pending || !changed) return;
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

  const modeHint = mode === "custom" ? s.autoCustomHint(draft.bake.trim(), draft.pct.trim()) : s.autoModeHint[mode];
  const options: { value: AutoMode; label: string; hint: string }[] = [
    { value: "off", label: s.autoModes.off, hint: s.autoModeHint.off },
    { value: "careful", label: s.autoModes.careful, hint: s.autoModeHint.careful },
    { value: "quick", label: s.autoModes.quick, hint: s.autoModeHint.quick },
  ];
  // "Custom" is a fourth card only while the numbers match neither preset: it is where the Advanced numbers end up.
  if (mode === "custom") options.push({ value: "custom", label: s.autoModes.custom, hint: modeHint });

  return (
    <form
      className="dash-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <span id={headingId} className="rb-sr-only">
        {s.autoChoose}
      </span>
      <ChoiceCards<AutoMode>
        aria-labelledby={headingId}
        columns={options.length > 3 ? 2 : 3}
        value={mode}
        disabled={pending}
        options={options}
        onChange={(m) => setDraft((d) => applyMode(d, m))}
      />
      <details className="dash-advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary>{s.autoAdvanced}</summary>
        <div className="dash-advanced__body">
          <div className="ro-auto__numbers">
            <Field label={s.autoBake} info={s.autoBakeInfo} error={touched && bake ? messageOf(bake, s.bakeRange) : null} required>
              {(p) => <Input {...p} className="ro-num" value={draft.bake} inputMode="numeric" autoComplete="off" onChange={(e) => setDraft((d) => ({ ...d, bake: e.target.value }))} />}
            </Field>
            <Field label={s.autoPct} info={s.autoPctInfo} error={touched && pct ? messageOf(pct, s.pctRange) : null} required>
              {(p) => <Input {...p} className="ro-num" value={draft.pct} inputMode="numeric" autoComplete="off" onChange={(e) => setDraft((d) => ({ ...d, pct: e.target.value }))} />}
            </Field>
          </div>
          <div className="ro-auto__switch">
            <Switch checked={draft.autoRollback} onChange={(on) => setDraft((d) => ({ ...d, autoRollback: on }))} label={s.autoBack} disabled={pending} />
            <InfoTip label={s.autoBackInfoLabel}>{s.autoBackInfo}</InfoTip>
          </div>
        </div>
      </details>
      <FormError error={error} onReload={onReload} describe={(e) => rolloutErrorMessage(e)} />
      {changed ? (
        <div className="dash-form__actions ro-auto__actions dash-enter">
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? strings.common.saving : s.autoSave}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => setDraft(draftOf(rollout))}>
            {s.autoReset}
          </Button>
          <span className="dash-form__status">{strings.common.unsavedHint}</span>
        </div>
      ) : null}
    </form>
  );
}
