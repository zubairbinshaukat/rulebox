import { useId, type ReactNode } from "react";
import { InfoTip } from "@rulebox/ui";
import IconDanger from "~icons/solar/danger-circle-linear";
import { strings } from "../lib/strings";

/** Props a field passes to its control so label, hint and error are linked. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

/** The (i) button's name: "About <label>" for a text label, else `infoLabel`, else a generic one. */
function infoName(label: ReactNode, infoLabel?: string): string {
  return infoLabel ?? (typeof label === "string" ? `About ${label}` : "More information");
}

export interface FieldProps {
  label: ReactNode;
  /** The one short line a user needs to act (shown under the control). */
  hint?: ReactNode;
  /** The longer explanation, in an (i) tooltip next to the label. Never put an error here. */
  info?: ReactNode;
  /** Accessible name of the (i) button when `label` is not a string. */
  infoLabel?: string;
  error?: string | null;
  optional?: boolean;
  required?: boolean;
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
}

/** Label, input slot, hint and error with `aria-describedby` (Section 16). */
export function Field({ label, hint, info, infoLabel, error, optional, required, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  const labelEl = (
    <label className="dash-field__label" htmlFor={id}>
      {label}
      {optional ? <span className="dash-field__optional"> ({strings.common.optional})</span> : null}
    </label>
  );
  return (
    <div className={["dash-field", className ?? ""].filter(Boolean).join(" ")}>
      {info ? (
        // The tip sits beside the <label>, not inside it, so the label's accessible name stays clean.
        <div className="rb-labelrow">
          {labelEl}
          <InfoTip label={infoName(label, infoLabel)}>{info}</InfoTip>
        </div>
      ) : (
        labelEl
      )}
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
  info,
  infoLabel,
  error,
  children,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  /** The longer explanation, in an (i) tooltip next to the legend. */
  info?: ReactNode;
  infoLabel?: string;
  error?: string | null;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset
      className="dash-field"
      aria-labelledby={info ? `${id}-l` : undefined}
      aria-describedby={[error ? `${id}-e` : null, hint ? `${id}-h` : null].filter(Boolean).join(" ") || undefined}
    >
      {info ? (
        // The fieldset is named by the legend text alone, not by the (i) button inside the legend.
        <legend className="dash-field__label">
          <span className="rb-labelrow">
            <span id={`${id}-l`}>{legend}</span>
            <InfoTip label={infoName(legend, infoLabel)}>{info}</InfoTip>
          </span>
        </legend>
      ) : (
        <legend className="dash-field__label">{legend}</legend>
      )}
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
