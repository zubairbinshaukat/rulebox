import { useMemo, useState } from "react";
import { Button, Select } from "@rulebox/ui";
import { useSetGroupDisplay } from "../../data";
import { IDLE_CLOSE_RANGE, WEB_WINDOW_CAP_RANGE, type DisplayChoice, type GroupDetail } from "../../data/types";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { useToast } from "../../lib/toast";
import { strings } from "../../lib/strings";
import { displayStrings as s } from "../../lib/screenStrings/display";
import { idleCloseOptions, MODE_OPTIONS, windowCapOptions } from "./options";

const holds = (g: GroupDetail) => ({ mode: g.displayMode ?? ("auto" as DisplayChoice), cap: g.webWindowCap ?? null, idle: g.webIdleCloseMin ?? null });

/**
 * The group's display settings (`groups:setDisplay`) in a dialog that the "Display and memory" row of the group page opens (UI pass:
 * the three drop-downs are performance tuning, so they are not on the page). Display mode, web window limit and idle close; the long
 * explanations are (i) tips. `null` for the limit or the idle time means the mode's default. Admins only: the row hides the button
 * from viewers.
 */
export function GroupDisplayDialog({ g, onClose }: { g: GroupDetail; onClose: () => void }) {
  const set = useSetGroupDisplay();
  const toast = useToast();
  const [saved, setSaved] = useState(() => holds(g));
  const [revision, setRevision] = useState(g.revision);
  const [mode, setMode] = useState<DisplayChoice>(saved.mode);
  const [cap, setCap] = useState<number | null>(saved.cap);
  const [idle, setIdle] = useState<number | null>(saved.idle);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const changed = mode !== saved.mode || cap !== saved.cap || idle !== saved.idle;
  const capOptions = useMemo(() => windowCapOptions(WEB_WINDOW_CAP_RANGE.min, WEB_WINDOW_CAP_RANGE.max), []);
  const idleOptions = useMemo(() => idleCloseOptions(idle, IDLE_CLOSE_RANGE.min, IDLE_CLOSE_RANGE.max), [idle]);

  function submit() {
    if (!changed || pending) return;
    setPending(true);
    setError(null);
    set({ groupId: g._id, expectedRevision: revision, displayMode: mode, webWindowCap: cap, webIdleCloseMin: idle }).then(
      () => {
        setPending(false);
        toast(s.saved);
        onClose();
      },
      (err) => {
        setPending(false);
        setError(err);
      },
    );
  }

  return (
    <Modal
      open
      title={s.title}
      onClose={() => !pending && onClose()}
      onSubmit={submit}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={!changed || pending} aria-busy={pending}>
            {pending ? strings.common.saving : strings.common.save}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        {/* No (i) on the first field: a dialog focuses its first control, and a tip would open over the title. */}
        <Field label={s.mode} hint={mode === "auto" ? s.autoNote : undefined}>
          {(p) => <Select {...p} value={mode} options={MODE_OPTIONS} onChange={(v) => setMode(v as DisplayChoice)} />}
        </Field>
        {mode === "standard" ? <InlineNotice tone="warning" title={s.standardOnSmallGroup} /> : null}
        <Field label={s.windowCap} info={s.windowCapHint}>
          {(p) => <Select {...p} value={cap === null ? "" : String(cap)} options={capOptions} onChange={(v) => setCap(v === "" ? null : Number(v))} />}
        </Field>
        <Field label={s.idleClose} info={s.idleCloseHint}>
          {(p) => <Select {...p} value={idle === null ? "" : String(idle)} options={idleOptions} onChange={(v) => setIdle(v === "" ? null : Number(v))} />}
        </Field>
        <FormError
          error={error}
          onReload={() => {
            // Their change arrived through the subscription: take their values and revision, keep nothing of ours.
            const now = holds(g);
            setSaved(now);
            setMode(now.mode);
            setCap(now.cap);
            setIdle(now.idle);
            setRevision(g.revision);
            setError(null);
          }}
        />
      </div>
    </Modal>
  );
}
