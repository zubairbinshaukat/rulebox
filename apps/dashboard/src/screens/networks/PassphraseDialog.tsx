import { Button } from "@rulebox/ui";
import { useSetWifiPassphrase } from "../../data";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { PasswordInput } from "../../components/PasswordInput";
import { serverFieldError } from "../../components/serverField";
import { toAppError } from "../../lib/errors";
import { useForm } from "../../lib/useForm";
import { passphraseProblem } from "../../lib/wifiRules";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { networksStrings as s } from "./strings";

/**
 * Sets or replaces the Wi-Fi password (`wifi:setPassphrase`, an action: the server encrypts it). The typed text lives only in
 * this dialog's form state: it is never put in the URL, storage, a toast or an error sentence, and it is gone when the dialog
 * closes (the dialog is unmounted, not hidden). Nothing the server answers contains it, so nothing here can show it again.
 */
export function PassphraseDialog({
  id,
  revision,
  replacing,
  onSaved,
  onClose,
  onReload,
}: {
  id: string;
  revision: number;
  replacing: boolean;
  onSaved: (revision: number) => void;
  onClose: () => void;
  /** After a `stale_edit`: the page reloads the profile (the dialog closes, what was typed is dropped). */
  onReload: () => void;
}) {
  const setPassphrase = useSetWifiPassphrase();
  const toast = useToast();
  const f = useForm({ passphrase: "" }, (x) => {
    const problem = passphraseProblem(x.passphrase);
    return { passphrase: problem === null ? undefined : s.passphraseProblems[problem] };
  });
  // A refusal for the password field is shown under it, in our own words (never the server's text).
  const fieldError = f.errors.passphrase ?? serverFieldError(f.serverError, "passphrase", () => s.passphraseServerRefused);
  return (
    <Modal
      open
      title={replacing ? s.passphraseTitleReplace : s.passphraseTitleSet}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          const r = await setPassphrase({ id, passphrase: x.passphrase, expectedRevision: revision });
          onSaved(r.revision);
          toast(s.passphraseSaved);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : replacing ? s.replacePassphrase : s.setPassphrase}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <p className="dash-dialog__lead">{s.passphraseLead}</p>
        <Field label={s.passphraseField} hint={s.passphraseHint} error={fieldError} required>
          {(p) => (
            <PasswordInput
              {...p}
              autoComplete="new-password"
              autoCorrect="off"
              data-lpignore="true"
              value={f.values.passphrase}
              onChange={(e) => f.set("passphrase", e.target.value)}
            />
          )}
        </Field>
        <FormError
          error={f.serverError}
          fields={["passphrase"]}
          describe={(e) => {
            const a = toAppError(e);
            if (!a) return null;
            // An open network has no password to set (the card hides the button; this covers a profile that changed meanwhile).
            if (a.code === "invalid_argument" && a.field === "id") return s.passphraseOpen;
            return s.describeError(a.code, a.detail);
          }}
          onReload={() => {
            onClose();
            onReload();
          }}
        />
      </div>
    </Modal>
  );
}
