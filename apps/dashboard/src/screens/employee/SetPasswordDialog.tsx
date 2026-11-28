import { useId, useState } from "react";
import { Button } from "@rulebox/ui";
import { useSetEmployeePassword } from "../../data";
import type { EmployeeDetail as Detail } from "../../data/types";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { PasswordInput } from "../../components/PasswordInput";
import { generatePassword } from "../../lib/password";
import { employeeStrings as s } from "../../lib/screenStrings/employee";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { useForm } from "../../lib/useForm";
import * as v from "../../lib/validate";
import { GeneratedPassword } from "./GeneratedPassword";

/**
 * A new password for an existing person. It opens with a generated one (Copy, Generate another); "Type my own" shows the two fields
 * with the rule. The password goes only to the action and is gone when the dialog closes.
 */
export function SetPasswordDialog({ d, onClose }: { d: Detail; onClose: () => void }) {
  const setPassword = useSetEmployeePassword();
  const toast = useToast();
  const label = useId();
  const [initial] = useState(() => ({ password: generatePassword(), repeat: "", typed: false }));
  const f = useForm(initial, (x) =>
    x.typed
      ? {
          password: v.employeePassword(x.password, d.username) ?? undefined,
          repeat: v.same(x.password, x.repeat, strings.validate.passwordsDiffer) ?? undefined,
        }
      : {},
  );
  return (
    <Modal
      open
      title={s.setPasswordTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await setPassword({ employeeId: d._id, password: x.password });
          toast(s.passwordSaved);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : s.savePassword}
          </Button>
        </>
      }
    >
      <div className="dash-form emp-dlg">
        <p className="dash-dialog__lead emp-dlg__lead">{s.setPasswordBody}</p>
        {f.values.typed ? (
          <>
            <Field label={strings.auth.newPassword} hint={strings.validate.passwordEmployee} error={f.errors.password} required>
              {(p) => <PasswordInput {...p} autoComplete="new-password" value={f.values.password} onChange={(e) => f.set("password", e.target.value)} />}
            </Field>
            <Field label={strings.auth.repeatPassword} error={f.errors.repeat} required>
              {(p) => <PasswordInput {...p} autoComplete="new-password" value={f.values.repeat} onChange={(e) => f.set("repeat", e.target.value)} />}
            </Field>
            <p className="emp-dlg__switch">
              <button
                type="button"
                className="dash-link emp-linkbtn"
                onClick={() => {
                  f.set("typed", false);
                  f.set("password", generatePassword());
                  f.set("repeat", "");
                }}
              >
                {s.useGenerated}
              </button>
            </p>
          </>
        ) : (
          <div className="dash-field">
            <span className="dash-field__label" id={label}>
              {s.password}
            </span>
            <GeneratedPassword value={f.values.password} labelledBy={label} onGenerate={() => f.set("password", generatePassword())} />
            <p className="dash-field__hint">
              {s.setPasswordCopyFirst}{" "}
              <button
                type="button"
                className="dash-link emp-linkbtn"
                onClick={() => {
                  f.set("typed", true);
                  f.set("password", "");
                }}
              >
                {s.typeOwn}
              </button>
            </p>
          </div>
        )}
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}
