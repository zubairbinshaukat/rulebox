import { useRef, useState, type ReactNode } from "react";
import { Button, Input } from "@rulebox/ui";
import { useResetStepUpWithRecoveryCode } from "../data/stepup";
import { Field } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { toAppError } from "../lib/errors";
import { stepUpMessage } from "../lib/stepup/messages";
import { newPinError } from "../lib/stepup/pin";
import { sec } from "../lib/stepup/strings";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";
import { SignOutAndIn } from "./Reauthenticate";
import { PinField } from "./SetPinForm";
import "./stepup.css";

/**
 * "Use a recovery code" on the lock screen and in Settings → Security: one
 * unused recovery code AND the new PIN, sent together (`stepUp:resetWithRecoveryCode`
 * sets the PIN in the same step). Needs a password sign-in under 15 minutes old;
 * when it is older the person is asked to sign in again. Values live only in
 * this form.
 */
export function RecoveryReset({ onDone, extraActions }: { onDone: () => void; extraActions?: ReactNode }) {
  const reset = useResetStepUpWithRecoveryCode();
  const [reauth, setReauth] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const f = useForm({ code: "", pin: "", repeat: "" }, (x) => ({
    code: v.recoveryCode(x.code) ?? undefined,
    pin: newPinError(x.pin) ?? undefined,
    repeat: x.repeat !== x.pin ? strings.validate.pinsDiffer : undefined,
  }));

  if (reauth) {
    return (
      <div className="dash-form">
        <InlineNotice tone="warning" title={sec.reauthTitle} detail={sec.reauthLead} />
        <SignOutAndIn />
      </div>
    );
  }

  return (
    <form
      ref={form}
      className="dash-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void f.submit(async (x) => {
          try {
            await reset({ code: v.normalizeRecoveryCode(x.code), newPin: x.pin });
          } catch (err) {
            const app = toAppError(err);
            if (app?.code === "step_up_setup_required" && app.detail === "reauthenticate") setReauth(true);
            // A refused code and PIN are not kept in the fields (the person types them again).
            f.set("code", "");
            f.set("pin", "");
            f.set("repeat", "");
            throw err;
          }
          f.reset({ code: "", pin: "", repeat: "" });
          onDone();
        }, form.current);
      }}
    >
      <p className="dash-muted">{sec.recoveryUseLead}</p>
      <Field label={sec.recoveryCode} error={f.errors.code} required>
        {(p) => (
          <Input
            {...p}
            autoFocus
            className="dash-mono"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={12}
            value={f.values.code}
            onChange={(e) => f.set("code", e.target.value)}
            style={{ maxWidth: 240 }}
          />
        )}
      </Field>
      <Field label={sec.newPin} hint={sec.setupPinLead} error={f.errors.pin} required>
        {(p) => <PinField p={p} value={f.values.pin} onChange={(val) => f.set("pin", val)} />}
      </Field>
      <Field label={sec.repeatPin} error={f.errors.repeat} required>
        {(p) => <PinField p={p} value={f.values.repeat} onChange={(val) => f.set("repeat", val)} />}
      </Field>
      {f.serverError ? <InlineNotice tone="danger" alert title={stepUpMessage(f.serverError)} /> : null}
      <div className="dash-form__actions">
        <Button type="submit" className="dash-btn--accent" disabled={f.pending} aria-busy={f.pending}>
          {f.pending ? sec.recoveryUseSaving : sec.recoveryUseSubmit}
        </Button>
        {extraActions}
      </div>
    </form>
  );
}
