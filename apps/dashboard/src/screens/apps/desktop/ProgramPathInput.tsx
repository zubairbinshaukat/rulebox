import { useRef, useState } from "react";
import { Button, Input, Select } from "@rulebox/ui";
import { Field } from "../../../components/Field";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import * as v from "../../../lib/validate";
import { friendlyPath } from "./model";

const t = appAddStrings.program;
const ROOTS = Object.keys(t.roots);

/**
 * "Program to start": the .exe the PC runs when an employee opens the app, as a folder picker plus the rest of the path
 * (`VideoLAN\VLC\vlc.exe`). The saved value is the same path template as before (`{ProgramFiles}\...`), so nothing changes behind it.
 * It shows as one line with a Change button when the path is known (a popular app, winget's install folder, a saved app) and opens by
 * itself, required, when it is not. A portable program has no such input: its path is fixed.
 */
export function ProgramPathInput({
  value,
  onChange,
  error,
  hint,
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  error?: string;
  /** "Usually under Program Files\Vendor." */
  hint?: string;
  disabled?: boolean;
}) {
  const known = v.exePath(value, false) === null;
  const [open, setOpen] = useState(!known);
  const rest = useRef<HTMLInputElement>(null);
  const root = ROOTS.find((r) => value.startsWith(r)) ?? ROOTS[0]!;
  const tail = value.startsWith(root) ? value.slice(root.length) : "";

  if (!open && known && !error) {
    return (
      <div className="apps-starts">
        <span className="apps-starts__label">{appAddStrings.lines.starts}</span>
        <span className="apps-starts__path dash-mono" title={value}>
          {friendlyPath(value)}
        </span>
        {!disabled ? (
          <Button
            type="button"
            variant="ghost"
            className="dash-btn--sm"
            aria-label={`${appAddStrings.lines.startsChange}: ${t.label}`}
            onClick={() => {
              setOpen(true);
              queueMicrotask(() => rest.current?.focus());
            }}
          >
            {appAddStrings.lines.startsChange}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <Field label={t.label} hint={error ? undefined : (hint ?? t.hint)} info={t.info} error={error} required className="apps-program">
      {(p) => (
        <div className="apps-program__row">
          <Select
            compact
            className="apps-program__root"
            aria-label={t.folder}
            value={root}
            disabled={disabled}
            onChange={(r) => onChange(`${r}${tail}`)}
            options={ROOTS.map((r) => ({ value: r, label: t.roots[r]! }))}
          />
          <span className="apps-program__sep" aria-hidden="true">
            \
          </span>
          <Input
            {...p}
            ref={rest}
            className="dash-mono apps-program__rest"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            placeholder={t.restPlaceholder}
            value={tail}
            disabled={disabled}
            onChange={(e) => onChange(`${root}${e.target.value.replace(/^[\\/]+/, "")}`)}
          />
        </div>
      )}
    </Field>
  );
}
