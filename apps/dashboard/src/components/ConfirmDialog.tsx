import { useState, type ReactNode } from "react";
import { Button, Input } from "@rulebox/ui";
import { strings } from "../lib/strings";
import { Field } from "./Field";
import { FormError } from "./FormError";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  /** Destructive: red button. */
  danger?: boolean;
  /** Typed confirmation: the user types this exact text (usually the item's name). */
  typeToConfirm?: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  /** Called after a successful confirm, before closing (navigate away, toast). */
  onDone?: () => void;
}

/**
 * Confirmation for risky actions. Destructive ones (revoke, remove, delete,
 * archive) pass `typeToConfirm`; the button stays disabled until the text
 * matches. The dialog stays open with the error if the server refuses.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  // A fresh inner component per opening resets the typed text and errors.
  return <ConfirmInner {...props} />;
}

function ConfirmInner({ title, body, confirmLabel, danger, typeToConfirm, onConfirm, onClose, onDone }: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const matches = !typeToConfirm || typed.trim() === typeToConfirm.trim();

  async function submit() {
    setTouched(true);
    if (!matches || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onDone?.();
      onClose();
    } catch (e) {
      setError(e);
      setPending(false);
    }
  }

  return (
    <Modal
      open
      title={title}
      onClose={() => !pending && onClose()}
      onSubmit={submit}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button
            type="submit"
            variant="primary"
            className={danger ? "dash-btn--danger" : undefined}
            disabled={pending || !matches}
            aria-busy={pending}
          >
            {pending ? strings.common.saving : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        {body ? <div className="dash-dialog__lead">{body}</div> : null}
        {typeToConfirm ? (
          <Field
            label={strings.confirm.typeName(typeToConfirm)}
            error={touched && !matches ? strings.validate.typeToConfirm : null}
          >
            {(p) => (
              <Input
                {...p}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
              />
            )}
          </Field>
        ) : null}
        <FormError error={error} />
      </div>
    </Modal>
  );
}
