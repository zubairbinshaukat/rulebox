import { useState } from "react";
import { Button, Select } from "@rulebox/ui";
import { useSetGroupDisplay } from "../../data";
import { IDLE_CLOSE_RANGE, WEB_WINDOW_CAP_RANGE, type DisplayChoice, type GroupDetail } from "../../data/types";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { InlineNotice } from "../../components/Notice";
import { RoleGate } from "../../components/RoleGate";
import { useToast } from "../../lib/toast";
import { messageFor } from "../../lib/errors";
import { strings } from "../../lib/strings";
import { displayStrings as s } from "../../lib/screenStrings/display";
import { IdleCloseOptions, ModeOptions } from "./options";

/** The group's display settings (`groups:setDisplay`): mode, web window limit and idle close. Everyone reads them; admins change them. */
export function GroupDisplayCard({ g }: { g: GroupDetail }) {
  const set = useSetGroupDisplay();
  const toast = useToast();
  const saved = { mode: g.displayMode ?? "auto", cap: g.webWindowCap ?? null, idle: g.webIdleCloseMin ?? null };
  const [mode, setMode] = useState<DisplayChoice>(saved.mode);
  const [cap, setCap] = useState<number | null>(saved.cap);
  const [idle, setIdle] = useState<number | null>(saved.idle);
  const [pending, setPending] = useState(false);
  const changed = mode !== saved.mode || cap !== saved.cap || idle !== saved.idle;
  const capValues = Array.from({ length: WEB_WINDOW_CAP_RANGE.max - WEB_WINDOW_CAP_RANGE.min + 1 }, (_, i) => WEB_WINDOW_CAP_RANGE.min + i);

  return (
    <Card title={s.title} sub={s.groupLead}>
      <RoleGate
        minRole="admin"
        fallback={
          <p className="dash-muted">
            {s.mode}: {saved.mode === "lite" ? s.modeLite : saved.mode === "standard" ? s.modeStandard : s.modeAuto}
          </p>
        }
      >
        <form
          className="dash-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!changed || pending) return;
            setPending(true);
            set({ groupId: g._id, expectedRevision: g.revision, displayMode: mode, webWindowCap: cap, webIdleCloseMin: idle }).then(
              () => {
                setPending(false);
                toast(s.saved);
              },
              (err) => {
                setPending(false);
                toast(messageFor(err), "danger");
              },
            );
          }}
        >
          <Field label={s.mode} hint={mode === "auto" ? s.autoNote : undefined}>
            {(p) => (
              <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as DisplayChoice)}>
                <ModeOptions />
              </Select>
            )}
          </Field>
          {mode === "standard" ? <InlineNotice tone="warning" title={s.standardOnSmallGroup} /> : null}
          <Field label={s.windowCap} hint={s.windowCapHint}>
            {(p) => (
              <Select {...p} value={cap === null ? "" : String(cap)} onChange={(e) => setCap(e.target.value === "" ? null : Number(e.target.value))}>
                <option value="">{s.capDefault}</option>
                {capValues.map((n) => (
                  <option key={n} value={n}>
                    {s.capOption(n)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={s.idleClose} hint={s.idleCloseHint}>
            {(p) => (
              <Select {...p} value={idle === null ? "" : String(idle)} onChange={(e) => setIdle(e.target.value === "" ? null : Number(e.target.value))}>
                <IdleCloseOptions current={idle} min={IDLE_CLOSE_RANGE.min} max={IDLE_CLOSE_RANGE.max} />
              </Select>
            )}
          </Field>
          <div className="dash-row">
            <Button type="submit" disabled={!changed || pending} aria-busy={pending}>
              {pending ? strings.common.saving : strings.common.save}
            </Button>
          </div>
        </form>
      </RoleGate>
    </Card>
  );
}
