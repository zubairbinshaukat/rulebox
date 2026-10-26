import { useRef, useState } from "react";
import { Button, Input, Pill, Switch } from "@rulebox/ui";
import IconLock from "~icons/solar/lock-keyhole-linear";
import { useClearExitPin, useSetExitPin, useSettingsScreen, useUpdateSettings } from "../../data";
import type { SettingsScreen } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
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

const s = strings.settings.exit;

export function AdminExitTab() {
  const settings = useSettingsScreen();
  const [formKey, setFormKey] = useState(0);
  return (
    <QueryRegion state={settings} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={5} /></div>}>
      {(data) => (
        <>
          <ExitForm key={formKey} data={data} onReload={() => setFormKey((k) => k + 1)} />
          <PinCard set={data.exitPin.set} />
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
  const f = useForm({ enabled: data.settings.adminExit.enabled, hotkey: data.settings.adminExit.hotkey }, (x) => ({
    hotkey: x.enabled ? (v.hotkey(x.hotkey) ?? undefined) : undefined,
  }));
  // Live feedback as the admin types (Step 5 #7), before the first submit too.
  const live = f.values.hotkey ? v.parseHotkey(f.values.hotkey) : null;

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
            await update({
              expectedRevision: revision,
              name: data.name,
              settings: { ...data.settings, adminExit: { enabled: x.enabled, hotkey: hk.ok ? hk.canonical : x.hotkey } },
            });
            setRevision((r) => r + 1);
            toast(s.saved);
          }, form.current);
        }}
      >
        {!canAct ? <InlineNotice tone="neutral" title={strings.app.readOnly} /> : null}
        <Switch checked={f.values.enabled} onChange={(val) => f.set("enabled", val)} label={s.enabled} disabled={!canAct} />
        <Field
          label={s.hotkey}
          hint={live && live.ok && live.canonical !== f.values.hotkey ? `${s.hotkeyHint} → ${live.canonical}` : s.hotkeyHint}
          error={f.errors.hotkey ?? (live && !live.ok && f.values.hotkey.length > 2 ? strings.validate.hotkey(live.reason) : null)}
          required
        >
          {(p) => (
            <div className="dash-row" style={{ flexWrap: "nowrap" }}>
              <Input
                {...p}
                className="dash-mono"
                value={f.values.hotkey}
                disabled={!canAct || !f.values.enabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => f.set("hotkey", e.target.value)}
                style={{ maxWidth: 280 }}
              />
              {canAct ? (
                <Button variant="ghost" onClick={() => f.set("hotkey", v.DEFAULT_HOTKEY)} disabled={!f.values.enabled || f.values.hotkey === v.DEFAULT_HOTKEY}>
                  {s.useDefault}
                </Button>
              ) : null}
            </div>
          )}
        </Field>
        <FormError error={f.serverError} onReload={onReload} />
        {canAct ? (
          <div className="dash-form__actions">
            <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
              {f.pending ? strings.common.saving : strings.common.saveChanges}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

function PinCard({ set }: { set: boolean }) {
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
            {set ? s.changePin : s.setPin}
          </Button>
          {set ? (
            <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => setDialog("clear")}>
              {s.clearPin}
            </Button>
          ) : null}
        </RoleGate>
      }
    >
      {set ? (
        <p className="dash-row">
          <Pill tone="success" dot>
            {strings.common.yes}
          </Pill>
          <span>{s.pinSet}</span>
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

/** The PIN goes to the `settings:setExitPin` action only; it is hashed on the server and never shown again. */
function PinDialog({ onClose }: { onClose: () => void }) {
  const setPin = useSetExitPin();
  const toast = useToast();
  const f = useForm({ pin: "", repeat: "" }, (x) => ({
    pin: v.exitPin(x.pin) ?? undefined,
    repeat: v.same(x.pin, x.repeat, strings.validate.pinsDiffer) ?? undefined,
  }));
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
        <Field label={s.newPin} error={f.errors.pin} required>
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
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}
