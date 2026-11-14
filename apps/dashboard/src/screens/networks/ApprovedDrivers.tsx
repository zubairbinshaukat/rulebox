import { useState } from "react";
import { Button, Input } from "@rulebox/ui";
import { useSetApprovedPrinterDrivers } from "../../data";
import type { DriverRow } from "../../data/types";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { toAppError } from "../../lib/errors";
import { MAX_ADDED_NAMES, addedNameProblem, dedupeNames } from "../../lib/driverRules";
import { useCan } from "../../lib/member";
import { INBOX_DRIVERS } from "../../lib/printerRules";
import { useToast } from "../../lib/toast";
import { networksStrings as s } from "./strings";

/**
 * Approved printer drivers (Step 14b, owner decision 2a): the built-in Windows class drivers (read-only), the names an admin added
 * (chips with an add field and one Save, `networks:setApprovedPrinterDrivers`) and the names delivered drivers provide (read-only).
 * The list comes from `networks:list`: no query of its own.
 */
export function ApprovedDrivers({ added, drivers }: { added: string[]; drivers: DriverRow[] }) {
  const canAct = useCan("admin");
  // A change from the server (a save here, or another admin's) starts the draft over from what the server has.
  return <ApprovedForm key={JSON.stringify(added)} added={added} drivers={drivers} canAct={canAct} />;
}

function ApprovedForm({ added, drivers, canAct }: { added: string[]; drivers: DriverRow[]; canAct: boolean }) {
  const save = useSetApprovedPrinterDrivers();
  const toast = useToast();
  const [names, setNames] = useState<string[]>(added);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirty = JSON.stringify(names) !== JSON.stringify(added);
  const delivered = dedupeNames(drivers.flatMap((d) => d.provides));

  const add = () => {
    const name = draft.trim();
    const p = addedNameProblem(name);
    if (p !== null) return setProblem(s.approvedProblems[p]);
    if (INBOX_DRIVERS.some((x) => x.toLowerCase() === name.toLowerCase())) return setProblem(s.approvedBuiltInName);
    if (names.some((x) => x.toLowerCase() === name.toLowerCase())) return setProblem(s.approvedDuplicate);
    if (names.length >= MAX_ADDED_NAMES) return setProblem(s.approvedLimit);
    setProblem(null);
    setNames([...names, name]);
    setDraft("");
  };

  return (
    <Card title={s.approvedTitle} sub={s.approvedLead}>
      <div className="dash-stack">
        <div>
          <p className="dash-cell-sub">{s.approvedBuiltIn}</p>
          <span className="dash-net__chips">
            {INBOX_DRIVERS.map((n) => (
              <span key={n} className="dash-chip">
                {n}
              </span>
            ))}
          </span>
        </div>
        <div>
          <p className="dash-cell-sub">{s.approvedAdded}</p>
          {names.length === 0 ? (
            <p className="dash-muted">{s.approvedNone}</p>
          ) : (
            <ul className="dash-net__chips" aria-label={s.approvedAdded}>
              {names.map((n) => (
                <li key={n} className="dash-chip">
                  {n}
                  {canAct ? (
                    <button type="button" className="dash-chip__remove" aria-label={s.approvedRemove(n)} onClick={() => setNames(names.filter((x) => x !== n))}>
                      ×
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        {delivered.length > 0 ? <p className="dash-cell-sub">{s.driverDeliveredLine(delivered.join(", "))}</p> : null}
        {canAct ? (
          <form
            className="dash-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim() !== "") return add();
              if (!dirty || pending) return;
              setPending(true);
              setError(null);
              save({ names })
                .then(() => toast(s.approvedSaved))
                .catch(setError)
                .finally(() => setPending(false));
            }}
          >
            <Field label={s.approvedField} hint={s.approvedFieldHint} error={problem}>
              {(p) => (
                <div className="dash-row">
                  <Input {...p} value={draft} autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
                  <Button type="button" variant="ghost" onClick={add}>
                    {s.approvedAdd}
                  </Button>
                </div>
              )}
            </Field>
            <FormError error={error} describe={(e) => { const a = toAppError(e); return a ? s.describeError(a.code, a.detail) : null; }} />
            <div className="dash-form__actions">
              <Button type="submit" disabled={!dirty || pending} aria-busy={pending}>
                {s.approvedSave}
              </Button>
              {dirty ? <span className="dash-form__status">{s.approvedUnsaved}</span> : null}
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
