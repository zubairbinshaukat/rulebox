import { Input } from "@rulebox/ui";
import { Field } from "../../../components/Field";
import type { ReleaseFields } from "../releaseRules";
import { updates as s } from "../strings";
import type { FieldProblems } from "./model";

/**
 * "Advanced: use your own build": today's four fields. They are the same state as the picker: picking a release fills them, editing
 * one turns the selection into "Your own build". Every field has its (i); a problem is shown under its field.
 */
export function CustomBuild({
  fields,
  problems,
  serverProblem,
  disabled,
  open,
  onToggle,
  onEdit,
}: {
  fields: ReleaseFields;
  problems: FieldProblems;
  /** The server's refusal of a field (`release.version`, ...), by the key of `ReleaseFields`. */
  serverProblem: (key: keyof ReleaseFields) => string | null;
  disabled: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  onEdit: (key: keyof ReleaseFields, value: string) => void;
}) {
  return (
    <details className="dash-advanced upd__adv" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>{s.advanced}</summary>
      <div className="dash-advanced__body">
        <p className="dash-muted upd__adv-lead">{s.advancedLead}</p>
        <div className="dash-form-grid">
          <Field label={s.versionLabel} info={s.versionInfo} error={problems.version ?? serverProblem("version")} required>
            {(p) => (
              <Input
                {...p}
                className="dash-mono"
                value={fields.version}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => onEdit("version", e.target.value)}
              />
            )}
          </Field>
          <Field label={s.sizeLabel} info={s.sizeInfo} error={problems.size ?? serverProblem("size")} required>
            {(p) => (
              <Input
                {...p}
                className="dash-mono"
                inputMode="numeric"
                value={fields.size}
                disabled={disabled}
                autoComplete="off"
                onChange={(e) => onEdit("size", e.target.value)}
              />
            )}
          </Field>
          <Field className="dash-form-grid__full" label={s.urlLabel} info={s.urlInfo} error={problems.url ?? serverProblem("url")} required>
            {(p) => (
              <Input
                {...p}
                type="url"
                className="dash-mono"
                value={fields.url}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                placeholder="https://"
                onChange={(e) => onEdit("url", e.target.value)}
              />
            )}
          </Field>
          <Field className="dash-form-grid__full" label={s.shaLabel} info={s.shaInfo} error={problems.sha256 ?? serverProblem("sha256")} required>
            {(p) => (
              <Input
                {...p}
                className="dash-mono"
                value={fields.sha256}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                maxLength={80}
                onChange={(e) => onEdit("sha256", e.target.value)}
              />
            )}
          </Field>
        </div>
      </div>
    </details>
  );
}
