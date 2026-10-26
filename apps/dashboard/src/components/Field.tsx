import { useId, type ReactNode } from "react";
import IconDanger from "~icons/solar/danger-circle-linear";
import { strings } from "../lib/strings";

/** Props a field passes to its control so label, hint and error are linked. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  required?: boolean;
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
}

/** Label, input slot, hint and error with `aria-describedby` (Section 16). */
export function Field({ label, hint, error, optional, required, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={["dash-field", className ?? ""].filter(Boolean).join(" ")}>
      <label className="dash-field__label" htmlFor={id}>
        {label}
        {optional ? <span className="dash-field__optional"> ({strings.common.optional})</span> : null}
      </label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {error ? (
        <p className="dash-field__error" id={errorId}>
          <IconDanger aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
      {hint ? (
        <p className="dash-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A group of related controls (checkbox lists, radios) with a legend. */
export function FieldSet({
  legend,
  hint,
  error,
  children,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className="dash-field" aria-describedby={[error ? `${id}-e` : null, hint ? `${id}-h` : null].filter(Boolean).join(" ") || undefined}>
      <legend className="dash-field__label">{legend}</legend>
      {hint ? (
        <p className="dash-field__hint" id={`${id}-h`}>
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p className="dash-field__error" id={`${id}-e`}>
          <IconDanger aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
