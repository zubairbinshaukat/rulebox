import { useRef, useState } from "react";
import { Button, Input, InfoTip, Pill, Switch } from "@rulebox/ui";
import IconLock from "~icons/solar/lock-keyhole-linear";
import IconKeyboard from "~icons/solar/keyboard-linear";
import IconPin from "~icons/solar/password-minimalistic-input-linear";
import IconExit from "~icons/solar/logout-2-linear";
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
import { keysOf } from "./hotkeyKeys";
import { HotkeyRecorder, KeyCaps } from "./HotkeyRecorder";
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
        <div className="set-exit">
          <ExitForm key={formKey} data={data} onReload={() => setFormKey((k) => k + 1)} />
          <PinCard pin={data.exitPin} />
          <HowItWorks hotkey={data.settings.adminExit.hotkey} />
        </div>
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
  const [advOpen, setAdvOpen] = useState(false);
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
  const hotkeyProblem = f.errors.hotkey ?? live ?? serverHotkey;
  // A problem is never hidden in a closed disclosure.
  const open = advOpen || Boolean(hotkeyProblem);

  return (
    <form
      ref={form}
      className="set-exit__form"
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
      <Card level={3} title={s.card}>
        <div className="set-fs">
          {!canAct ? <InlineNotice tone="neutral" title={strings.app.readOnly} /> : null}
          <div className="set-switch">
            <Switch checked={f.values.enabled} onChange={(val) => f.set("enabled", val)} label={s.enabled} disabled={!canAct} />
            <InfoTip label={`About ${s.enabled}`}>{s.enabledInfo}</InfoTip>
          </div>

          <div className="dash-field">
            <span className="rb-labelrow">
              <span className="dash-field__label">{s.hotkey}</span>
              <InfoTip label={`About ${s.hotkey}`}>{s.hotkeyInfo}</InfoTip>
            </span>
            <HotkeyRecorder
              value={f.values.hotkey}
              disabled={!canAct}
              onChange={(canonical) => {
                setTyped(true);
                f.set("hotkey", canonical);
              }}
            />
            {canAct && f.values.hotkey !== v.DEFAULT_HOTKEY ? (
              <span>
                <Button variant="ghost" className="dash-btn--sm" onClick={() => f.set("hotkey", v.DEFAULT_HOTKEY)}>
                  {s.useDefault(v.DEFAULT_HOTKEY)}
                </Button>
              </span>
            ) : null}
          </div>

          <details
            className="dash-advanced"
            open={open}
            onToggle={(e) => setAdvOpen(e.currentTarget.open)}
          >
            <summary>{s.typeInstead}</summary>
            <div className="dash-advanced__body">
              <Field label={s.hotkey} hint={canonicalHint ?? s.typeInsteadHint} error={hotkeyProblem} required>
                {(p) => (
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
                    style={{ maxWidth: 280 }}
                  />
                )}
              </Field>
            </div>
          </details>

          <FormError error={f.serverError} onReload={onReload} fields={[HOTKEY_FIELD]} />
          {canAct ? (
            <div className="dash-form__actions">
              <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
                {f.pending ? strings.common.saving : strings.common.saveChanges}
              </Button>
              {f.dirty ? <span className="dash-form__status">{strings.common.unsavedHint}</span> : null}
            </div>
          ) : null}
        </div>
      </Card>
    </form>
  );
}

/** The exit PIN is never shown: only whether one is set, and since when. Admins and Owners change it. */
function PinCard({ pin }: { pin: SettingsScreen["exitPin"] }) {
  const [dialog, setDialog] = useState<"set" | "clear" | null>(null);
  const clear = useClearExitPin();
  const toast = useToast();
  return (
    <Card level={3} title={s.pin} className="set-exit__pin">
      <div className="set-fs">
        {pin.set ? (
          <p className="set-pinstate">
            <Pill tone="success" dot>
              {s.pinIsSet}
            </Pill>
            <span>{pin.setAt !== undefined ? s.pinSetOn(pin.setAt) : s.pinSet}</span>
          </p>
        ) : (
          <InlineNotice tone="warning" title={s.pinNotSet} />
        )}
        <RoleGate minRole="admin">
          <div className="set-pinactions">
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog("set")}>
              <IconLock aria-hidden="true" />
              {pin.set ? s.changePin : s.setPin}
            </Button>
            {pin.set ? (
              <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => setDialog("clear")}>
                {s.clearPin}
              </Button>
            ) : null}
          </div>
        </RoleGate>
      </div>
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

/** Three steps, in the words of someone standing at the PC. */
function HowItWorks({ hotkey }: { hotkey: string }) {
  const icons = [IconKeyboard, IconPin, IconExit];
  return (
    <Card level={3} title={s.howTitle} className="set-exit__how">
      <ol className="set-how">
        {s.how.map((step, i) => {
          const Icon = icons[i]!;
          return (
            <li key={step.title} className="set-how__step">
              <span className="set-how__icon" aria-hidden="true">
                <Icon />
              </span>
              <div className="set-how__text">
                <p className="set-how__title">{step.title}</p>
                {i === 0 ? <KeyCaps keys={keysOf(hotkey)} /> : <p className="set-how__body">{step.body}</p>}
              </div>
            </li>
          );
        })}
      </ol>
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
        <Field label={s.newPin} info={s.pinInfo} error={f.errors.pin ?? serverPin} required>
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
