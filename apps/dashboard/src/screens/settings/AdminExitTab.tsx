import { useRef, useState } from "react";
import { Button, Input, Pill, Switch } from "@rulebox/ui";
import IconLock from "~icons/solar/lock-keyhole-linear";
import { useClearExitPin, useSetExitPin, useSettingsScreen, useUpdateSettings } from "../../data";
import type { SettingsScreen } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { serverFieldError } from "../../components/serverField";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { RoleGate } from "../../components/RoleGate";
import { useCan } from "../../lib/member";
import { SkeletonBlock } from "../../components/Skeleton";
import { useToast } from "../../lib/toast";
import { strings } from "../../lib/strings";
import { useForm } from "../../lib/useForm";
import * as v from "../../lib/validate";
import { exit as s, exitPinMessage, hotkeyMessage } from "./strings";

const HOTKEY_FIELD = "adminExit.hotkey";

/** The sentence for a key combination, or null when it is valid (the same grammar as the server and the PCs). */
function hotkeyError(text: string): string | null {
  if (text.length > v.HOTKEY_MAX) return strings.validate.tooLong(v.HOTKEY_MAX);
  const r = v.parseHotkey(text);
  return r.ok ? null : hotkeyMessage(r);
}

/** Settings → Admin exit: `settings:get`; saving a changed admin exit and the exit PIN need a fresh step-up. */
export function AdminExitTab() {
  const settings = useSettingsScreen();
  const [formKey, setFormKey] = useState(0);
  return (
    <QueryRegion state={settings} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={5} /></div>}>
      {(data) => (
        <>
          <ExitForm key={formKey} data={data} onReload={() => setFormKey((k) => k + 1)} />
          <PinCard pin={data.exitPin} />
        </>
      )}
    </QueryRegion>
  );
}

function ExitForm({ data, onReload }: { data: SettingsScreen; onReload: () => void }) {
  const canAct = useCan("admin");
  const update = useUpdateSettings();
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [revision, setRevision] = useState(data.revision);
  const [typed, setTyped] = useState(false);
  const f = useForm({ enabled: data.settings.adminExit.enabled, hotkey: data.settings.adminExit.hotkey }, (x) => ({
    hotkey: hotkeyError(x.hotkey) ?? undefined,
  }));
  // Live feedback while the admin types (Step 5 #7), before the first submit too.
  const live = typed ? hotkeyError(f.values.hotkey) : null;
  const parsed = v.parseHotkey(f.values.hotkey);
  const canonicalHint = parsed.ok && parsed.canonical !== f.values.hotkey ? s.hotkeyCanonical(parsed.canonical) : null;
  const serverHotkey = serverFieldError(f.serverError, HOTKEY_FIELD, (e) =>
    e.detail ? hotkeyMessage({ ok: false, reason: e.detail as v.HotkeyProblem }) : strings.errors.invalidArgument,
  );

  return (
    <Card title={strings.settings.tabs.adminExit} sub={s.lead}>
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            const hk = v.parseHotkey(x.hotkey);
            const r = await update({
              expectedRevision: revision,
              name: data.name,
              settings: { ...data.settings, adminExit: { enabled: x.enabled, hotkey: hk.ok ? hk.canonical : x.hotkey } },
            });
            setRevision(r.revision);
            if (hk.ok) f.reset({ enabled: x.enabled, hotkey: hk.canonical });
            setTyped(false);
            toast(r.changed.length ? s.saved : strings.common.saved);
          }, form.current);
        }}
      >
        {!canAct ? <InlineNotice tone="neutral" title={strings.app.readOnly} /> : null}
        <div className="dash-stack" style={{ gap: 6 }}>
          <Switch checked={f.values.enabled} onChange={(val) => f.set("enabled", val)} label={s.enabled} disabled={!canAct} />
          {canAct ? <p className="dash-field__hint">{s.enabledHint}</p> : null}
        </div>
        <Field label={s.hotkey} hint={canonicalHint ?? s.hotkeyHint} error={f.errors.hotkey ?? live ?? serverHotkey} required>
          {(p) => (
            <div className="dash-row" style={{ flexWrap: "wrap" }}>
              <Input
                {...p}
                className="dash-mono"
                value={f.values.hotkey}
                disabled={!canAct}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => {
                  setTyped(true);
                  f.set("hotkey", e.target.value);
                }}
                style={{ maxWidth: 280, flex: "1 1 180px" }}
              />
              {canAct ? (
                <Button variant="ghost" onClick={() => f.set("hotkey", v.DEFAULT_HOTKEY)} disabled={f.values.hotkey === v.DEFAULT_HOTKEY}>
                  {s.useDefault}
                </Button>
              ) : null}
            </div>
          )}
        </Field>
        <FormError error={f.serverError} onReload={onReload} fields={[HOTKEY_FIELD]} />
        {canAct ? (
          <div className="dash-form__actions">
            <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
              {f.pending ? strings.common.saving : strings.common.saveChanges}
            </Button>
            {f.dirty ? <span className="dash-form__status">{strings.common.unsavedHint}</span> : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}

/** The exit PIN is never shown: only whether one is set, and since when. Admins and Owners change it. */
function PinCard({ pin }: { pin: SettingsScreen["exitPin"] }) {
  const [dialog, setDialog] = useState<"set" | "clear" | null>(null);
  const clear = useClearExitPin();
  const toast = useToast();
  return (
    <Card
      title={s.pin}
      actions={
        <RoleGate minRole="admin">
          <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog("set")}>
            <IconLock aria-hidden="true" />
            {pin.set ? s.changePin : s.setPin}
          </Button>
          {pin.set ? (
            <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => setDialog("clear")}>
              {s.clearPin}
            </Button>
          ) : null}
        </RoleGate>
      }
    >
      {pin.set ? (
        <p className="dash-row">
          <Pill tone="success" dot>
            {strings.common.yes}
          </Pill>
          <span>{pin.setAt !== undefined ? s.pinSetOn(pin.setAt) : s.pinSet}</span>
        </p>
      ) : (
        <InlineNotice tone="warning" title={s.pinNotSet} />
      )}
      {dialog === "set" ? <PinDialog onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog === "clear"}
        title={s.clearTitle}
        body={s.clearBody}
        confirmLabel={s.clearPin}
        danger
        onConfirm={() => clear()}
        onDone={() => toast(s.cleared)}
        onClose={() => setDialog(null)}
      />
    </Card>
  );
}

/**
 * The PIN goes to the `settings:setExitPin` action only: it is checked and
 * hashed on the server, never stored in the browser and never shown again.
 */
function PinDialog({ onClose }: { onClose: () => void }) {
  const setPin = useSetExitPin();
  const toast = useToast();
  const f = useForm({ pin: "", repeat: "" }, (x) => ({
    pin: v.exitPin(x.pin) ?? undefined,
    repeat: v.same(x.pin, x.repeat, strings.validate.pinsDiffer) ?? undefined,
  }));
  const serverPin = serverFieldError(f.serverError, "pin", (e) => exitPinMessage(e.detail));
  const digitsOnly = (value: string) => value.replace(/\D/g, "").slice(0, 12);
  return (
    <Modal
      open
      title={s.pinTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await setPin({ pin: x.pin });
          toast(s.pinSaved);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : s.setPin}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <p className="dash-dialog__lead">{s.pinBody}</p>
        <Field label={s.newPin} error={f.errors.pin ?? serverPin} required>
          {(p) => (
            <Input
              {...p}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              className="dash-mono"
              maxLength={12}
              value={f.values.pin}
              onChange={(e) => f.set("pin", digitsOnly(e.target.value))}
              style={{ maxWidth: 240, letterSpacing: "0.2em" }}
            />
          )}
        </Field>
        <Field label={s.repeatPin} error={f.errors.repeat} required>
          {(p) => (
            <Input
              {...p}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              className="dash-mono"
              maxLength={12}
              value={f.values.repeat}
              onChange={(e) => f.set("repeat", digitsOnly(e.target.value))}
              style={{ maxWidth: 240, letterSpacing: "0.2em" }}
            />
          )}
        </Field>
        <FormError error={f.serverError} fields={["pin"]} />
      </div>
    </Modal>
  );
}
