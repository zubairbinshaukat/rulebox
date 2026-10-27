import { useRef, type ReactNode } from "react";
import { Button, Input } from "@rulebox/ui";
import { Field, type FieldControlProps } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { strings } from "../lib/strings";
import { stepUpMessage } from "../lib/stepup/messages";
import { newPinError, pinInput } from "../lib/stepup/pin";
import { sec } from "../lib/stepup/strings";
import { useForm } from "../lib/useForm";

function PinField({
  p,
  value,
  onChange,
  autoFocus,
}: {
  p: FieldControlProps;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <Input
      {...p}
      autoFocus={autoFocus}
      type="password"
      inputMode="numeric"
      pattern="[0-9]*"
      // A new PIN: not something a password manager should generate or save.
      autoComplete="off"
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore=""
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      maxLength={12}
      className="dash-mono su-factor__pin"
      value={value}
      onChange={(e) => onChange(pinInput(e.target.value))}
    />
  );
}

/**
 * New action PIN + repeat, with the server's rules mirrored (`lib/stepup/pin.ts`).
 * `onSave` is the call (wrapped in the step-up retry where a change needs a
 * fresh confirmation). Values live only in this form and go when it unmounts.
 */
export function SetPinForm({
  onSave,
  submitLabel,
  extraActions,
  autoFocus,
}: {
  onSave: (pin: string) => Promise<void>;
  submitLabel: string;
  extraActions?: ReactNode;
  autoFocus?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const f = useForm({ pin: "", repeat: "" }, (x) => ({
    pin: newPinError(x.pin) ?? undefined,
    repeat: x.repeat !== x.pin ? strings.validate.pinsDiffer : undefined,
  }));
  return (
    <form
      ref={form}
      className="dash-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void f.submit(async (x) => {
          await onSave(x.pin);
          f.reset({ pin: "", repeat: "" });
        }, form.current);
      }}
    >
      <Field label={sec.newPin} hint={sec.setupPinLead} error={f.errors.pin} required>
        {(p) => <PinField p={p} autoFocus={autoFocus} value={f.values.pin} onChange={(v) => f.set("pin", v)} />}
      </Field>
      <Field label={sec.repeatPin} error={f.errors.repeat} required>
        {(p) => <PinField p={p} value={f.values.repeat} onChange={(v) => f.set("repeat", v)} />}
      </Field>
      {f.serverError ? <InlineNotice tone="danger" alert title={stepUpMessage(f.serverError)} /> : null}
      <div className="dash-form__actions">
        <Button type="submit" className="dash-btn--accent" disabled={f.pending} aria-busy={f.pending}>
          {f.pending ? sec.savingPin : submitLabel}
        </Button>
        {extraActions}
      </div>
    </form>
  );
}
