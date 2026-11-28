import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Button, Checkbox, Input, Pill, NativeSelect, Switch } from "@rulebox/ui";
import { useLockdownView, useRemoveException, useSaveLockdown } from "../data/lockdown";
import { LAYER_MODES, type ExceptionRow, type LayerMode, type LockdownSettings, type LockdownView, type UsbStorageMode, type UsbSwitch } from "../data/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { formatDate } from "../lib/format";
import { changedLayers, lockoutDraftOf, lockoutProblems, sameSettings, settingsOf, type LockoutDraft } from "./lockdown/rules";
import { useCan } from "../lib/member";
import { strings } from "../lib/strings";
import { useToast } from "../lib/toast";
import { useNow } from "../lib/useNow";
import { lockdownErrorMessage, lockdownStrings as s } from "./lockdown/strings";

const DAY = 24 * 60 * 60 * 1000;
/** Plan Q2: suggest Enforce after a week of audit. */
const AUDIT_HINT_DAYS = 7;

/**
 * `/groups/:id/lockdown` (plan 4.20): the group's lockdown settings in one form with one Save. `lockdown:groupView` is the only
 * query. Switching a program rule to Enforce asks first and shows how many findings are still open. Admins change, viewers read.
 */
export default function Lockdown() {
  const { id = "" } = useParams();
  const view = useLockdownView(id);
  const back = { to: `/groups/${id}`, label: s.back };
  const [formKey, setFormKey] = useState(0);
  return (
    <div className="dash-page">
      {view.status !== "ready" ? <PageHeader title={view.status === "loading" ? s.loadingTitle : s.title} back={back} /> : null}
      <QueryRegion state={view} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
        {(v) => (
          <>
            <PageHeader back={back} title={<span className="dash-wrap">{s.titleFor(v.groupName)}</span>} lead={s.lead} />
            {/* A fresh form (the saved values again) after Reload on a stale edit. */}
            <Form key={formKey} groupId={id} v={v} onReload={() => setFormKey((k) => k + 1)} />
            <Exceptions v={v} />
          </>
        )}
      </QueryRegion>
    </div>
  );
}

function SwitchLine({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void; disabled: boolean }) {
  return (
    <div className="dash-net__switch">
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      {hint ? <span className="dash-cell-sub">{hint}</span> : null}
    </div>
  );
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(p) => (
        <NativeSelect {...p} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}

const MODE_OPTIONS = LAYER_MODES.map((m) => [m, s.modes[m]] as const);
const STORAGE_OPTIONS: readonly (readonly [UsbStorageMode, string])[] = [
  ["allow", s.storageModes.allow],
  ["readOnly", s.storageModes.readOnly],
  ["block", s.storageModes.block],
];
const USB_OPTIONS: readonly (readonly [UsbSwitch, string])[] = [
  ["allow", s.usbModes.allow],
  ["block", s.usbModes.block],
];
const USB_SWITCHES = ["printers", "imaging", "phones", "other"] as const;
const STAFF_KEYS = Object.keys(s.staff) as (keyof typeof s.staff)[];
const MACHINE_KEYS = Object.keys(s.machine) as (keyof typeof s.machine)[];

function Form({ groupId, v, onReload }: { groupId: string; v: LockdownView; onReload: () => void }) {
  const save = useSaveLockdown();
  const canAct = useCan("admin");
  const toast = useToast();
  const now = useNow(60 * 60_000);
  const [draft, setDraft] = useState<LockdownSettings>(v.settings);
  const [lockout, setLockout] = useState<LockoutDraft>(() => lockoutDraftOf(v.settings));
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  // The revision this form started from: a save by someone else in between is a stale edit, not a silent overwrite.
  const [revision, setRevision] = useState(v.revision);
  const off = !canAct || pending;

  const problems = lockoutProblems(lockout);
  const invalid = problems.threshold || problems.duration || problems.window;
  const next = settingsOf(draft, lockout);
  const changed = !sameSettings(next, v.settings);
  const enforcing = changedLayers(v.settings, next).filter((l) => l.to === "enforce");
  const managedOn = next.wifiManagedOnly && !v.settings.wifiManagedOnly;
  const auditDays = v.auditSince === null ? 0 : Math.floor((now - v.auditSince) / DAY);

  const patch = (fn: (cur: LockdownSettings) => LockdownSettings) => setDraft(fn);
  const mode = (key: "appLocker" | "appControl" | "procWatch", m: LayerMode) => patch((d) => ({ ...d, [key]: { ...d[key], mode: m } }));

  async function send(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const r = await save({ groupId, settings: next, expectedRevision: revision });
      setRevision(r.revision);
      toast(s.saved);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }

  function submit() {
    setTouched(true);
    if (invalid || pending || !changed) return;
    if (enforcing.length > 0 || managedOn) setConfirming(true);
    else void send();
  }

  return (
    <form
      className="dash-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {canAct ? null : <InlineNotice tone="neutral" title={s.readOnly} />}
      {v.openFindings > 0 ? (
        <InlineNotice
          tone="accent"
          title={s.findingsNew(v.openFindings, v.openFindingsMore)}
          detail={s.findingsDetail}
          action={
            <Link className="rb-btn rb-btn--ghost dash-btn--sm" to="/lockdown/findings">
              {s.findingsOpen}
            </Link>
          }
        />
      ) : null}
      {auditDays >= AUDIT_HINT_DAYS ? <InlineNotice tone="warning" title={s.auditLong(auditDays)} detail={s.auditLongDetail} /> : null}

      <Card title={s.rulesTitle} sub={s.rulesLead}>
        <div className="dash-form">
          <Choice label={s.appLocker} hint={`${s.appLockerHelp} ${s.modeHelp[draft.appLocker.mode]}`} value={draft.appLocker.mode} options={MODE_OPTIONS} disabled={off} onChange={(m) => mode("appLocker", m)} />
          <Choice label={s.appControl} hint={`${s.appControlHelp} ${s.modeHelp[draft.appControl.mode]}`} value={draft.appControl.mode} options={MODE_OPTIONS} disabled={off} onChange={(m) => mode("appControl", m)} />
          <Choice
            label={s.appControlLevel}
            hint={s.levelHelp[draft.appControl.level]}
            value={draft.appControl.level}
            options={[
              ["recommendedBlocks", s.levels.recommendedBlocks],
              ["allowlist", s.levels.allowlist],
            ]}
            disabled={off}
            onChange={(level) => patch((d) => ({ ...d, appControl: { ...d.appControl, level } }))}
          />
          <Choice label={s.procWatch} hint={`${s.procWatchHelp} ${s.modeHelp[draft.procWatch.mode]}`} value={draft.procWatch.mode} options={MODE_OPTIONS} disabled={off} onChange={(m) => mode("procWatch", m)} />
        </div>
      </Card>

      <Card title={s.usbTitle} sub={s.usbLead}>
        <div className="dash-form">
          <InlineNotice tone="success" title={s.usbAlways} />
          <Choice label={s.usb.storage} hint={s.usbHelp.storage} value={draft.usb.storage} options={STORAGE_OPTIONS} disabled={off} onChange={(storage) => patch((d) => ({ ...d, usb: { ...d.usb, storage } }))} />
          {USB_SWITCHES.map((key) => (
            <Choice key={key} label={s.usb[key]} hint={s.usbHelp[key]} value={draft.usb[key]} options={USB_OPTIONS} disabled={off} onChange={(val) => patch((d) => ({ ...d, usb: { ...d.usb, [key]: val } }))} />
          ))}
          {draft.usb.other === "block" ? <InlineNotice tone="warning" title={s.usbOtherWarning} /> : null}
          <Checkbox
            label={s.usbRetroactive}
            hint={s.usbRetroactiveHint}
            checked={draft.usb.retroactive}
            disabled={off}
            onChange={(e) => patch((d) => ({ ...d, usb: { ...d.usb, retroactive: e.target.checked } }))}
          />
        </div>
      </Card>

      <div className="dash-grid dash-grid--2">
        <Card title={s.staffTitle} sub={s.staffLead}>
          <div className="dash-form">
            {STAFF_KEYS.map((key) => (
              <SwitchLine key={key} label={s.staff[key][0]} hint={s.staff[key][1]} checked={draft.staff[key]} disabled={off} onChange={(on) => patch((d) => ({ ...d, staff: { ...d.staff, [key]: on } }))} />
            ))}
          </div>
        </Card>
        <Card title={s.machineTitle} sub={s.machineLead}>
          <div className="dash-form">
            {MACHINE_KEYS.map((key) => (
              <SwitchLine key={key} label={s.machine[key][0]} hint={s.machine[key][1]} checked={draft.machine[key]} disabled={off} onChange={(on) => patch((d) => ({ ...d, machine: { ...d.machine, [key]: on } }))} />
            ))}
            <SwitchLine label={s.lockout} hint={s.lockoutHelp} checked={lockout.on} disabled={off} onChange={(on) => setLockout((l) => ({ ...l, on }))} />
            {lockout.on ? (
              <div className="dash-form__row">
                <Field label={s.lockoutThreshold} hint={s.lockoutThresholdHint} error={touched && problems.threshold ? s.lockoutProblems.threshold : null}>
                  {(p) => <Input {...p} value={lockout.threshold} inputMode="numeric" autoComplete="off" disabled={off} onChange={(e) => setLockout((l) => ({ ...l, threshold: e.target.value }))} />}
                </Field>
                <Field label={s.lockoutDuration} error={touched && problems.duration ? s.lockoutProblems.duration : null}>
                  {(p) => <Input {...p} value={lockout.duration} inputMode="numeric" autoComplete="off" disabled={off} onChange={(e) => setLockout((l) => ({ ...l, duration: e.target.value }))} />}
                </Field>
                <Field label={s.lockoutWindow} hint={s.lockoutWindowHint} error={touched && problems.window ? s.lockoutProblems.window : null}>
                  {(p) => <Input {...p} value={lockout.window} inputMode="numeric" autoComplete="off" disabled={off} onChange={(e) => setLockout((l) => ({ ...l, window: e.target.value }))} />}
                </Field>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <div className="dash-grid dash-grid--2">
        <Card title={s.inputTitle}>
          <div className="dash-form">
            <SwitchLine
              label={s.winCombos}
              hint={s.winCombosHelp}
              checked={draft.keyboard.winCombos === "swallow"}
              disabled={off}
              onChange={(on) => patch((d) => ({ ...d, keyboard: { winCombos: on ? "swallow" : "pass" } }))}
            />
            <SwitchLine label={s.accessibilityTools} hint={s.accessibilityToolsHelp} checked={draft.accessibilityTools} disabled={off} onChange={(on) => patch((d) => ({ ...d, accessibilityTools: on }))} />
          </div>
        </Card>
        <Card title={s.bootTitle}>
          <div className="dash-form">
            <SwitchLine
              label={s.autoRecovery}
              hint={s.autoRecoveryHelp}
              checked={draft.boot.autoRecovery === "off"}
              disabled={off}
              onChange={(on) => patch((d) => ({ ...d, boot: { ...d.boot, autoRecovery: on ? "off" : "leave" } }))}
            />
            <SwitchLine label={s.safeModeGuard} hint={s.safeModeGuardHelp} checked={draft.boot.safeModeGuard} disabled={off} onChange={(on) => patch((d) => ({ ...d, boot: { ...d.boot, safeModeGuard: on } }))} />
          </div>
        </Card>
      </div>

      <div className="dash-grid dash-grid--2">
        <Card title={s.perfTitle} sub={s.perfLead}>
          <div className="dash-form">
            <SwitchLine label={s.staffTuning} hint={s.staffTuningHelp} checked={draft.performance.staffTuning} disabled={off} onChange={(on) => patch((d) => ({ ...d, performance: { ...d.performance, staffTuning: on } }))} />
            <SwitchLine label={s.kioskProfile} hint={s.kioskProfileHelp} checked={draft.performance.kioskProfile} disabled={off} onChange={(on) => patch((d) => ({ ...d, performance: { ...d.performance, kioskProfile: on } }))} />
            <SwitchLine label={s.noPrinting} hint={s.noPrintingHelp} checked={draft.performance.noPrinting} disabled={off} onChange={(on) => patch((d) => ({ ...d, performance: { ...d.performance, noPrinting: on } }))} />
          </div>
        </Card>
        <Card title={s.netTitle}>
          <div className="dash-form">
            <SwitchLine label={s.wifiManagedOnly} hint={s.wifiManagedOnlyHelp} checked={draft.wifiManagedOnly} disabled={off} onChange={(on) => patch((d) => ({ ...d, wifiManagedOnly: on }))} />
            {draft.wifiManagedOnly ? (
              <Checkbox
                label={s.wifiManagedOnlyConfirm}
                hint={s.wifiManagedOnlyConfirmHint}
                checked={draft.wifiManagedOnlyConfirmed === true}
                disabled={off}
                onChange={(e) => patch((d) => ({ ...d, wifiManagedOnlyConfirmed: e.target.checked }))}
              />
            ) : null}
          </div>
        </Card>
      </div>

      <FormError error={error} onReload={onReload} describe={lockdownErrorMessage} />
      {canAct ? (
        <div className="dash-form__actions">
          <Button type="submit" disabled={pending || !changed} aria-busy={pending}>
            {pending ? strings.common.saving : s.save}
          </Button>
          <Button
            variant="ghost"
            disabled={pending || !changed}
            onClick={() => {
              setDraft(v.settings);
              setLockout(lockoutDraftOf(v.settings));
              setTouched(false);
            }}
          >
            {s.discard}
          </Button>
          {changed ? <span className="dash-form__status">{strings.common.unsavedHint}</span> : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={s.enforceTitle}
        confirmLabel={s.enforceConfirm}
        body={
          <>
            {enforcing.length > 0 ? (
              <>
                <p>{s.enforceIntro}</p>
                <p>{s.enforceFindings(v.openFindings, v.openFindingsMore)}</p>
                {enforcing.some((l) => l.layer === "appControl") ? <p>{s.enforceAppControl}</p> : null}
                <p>{s.enforceAuditFirst}</p>
              </>
            ) : null}
            {managedOn ? <p>{s.managedConfirm}</p> : null}
          </>
        }
        // The dialog closes either way: an error is shown next to the form, where Reload is.
        onConfirm={send}
        onClose={() => setConfirming(false)}
      />
    </form>
  );
}

/** The group's exceptions (newest first). Hash rules are marked "Breaks on update" (edge case 12). */
function Exceptions({ v }: { v: LockdownView }) {
  const remove = useRemoveException();
  const canAct = useCan("admin");
  const toast = useToast();
  const [removing, setRemoving] = useState<ExceptionRow | null>(null);
  return (
    <Card title={s.exceptionsTitle} sub={s.exceptionsInfo}>
      <div className="dash-form">
        {v.exceptions.length === 0 ? <p className="dash-muted">{s.exceptionsNone}</p> : null}
        {v.exceptions.length > 0 ? (
          <ul className="dash-roll__members" aria-label={s.exceptionsTitle}>
            {v.exceptions.map((e) => (
              <li key={e._id} className="dash-roll__member">
                <span className="dash-cell-stack">
                  <span className="dash-wrap">{s.exceptionWhat(e.rule)}</span>
                  <span className="dash-cell-sub dash-wrap">
                    {[s.exceptionKinds[e.rule.kind], e.appName ? s.forApp(e.appName) : null, e.reason || null, formatDate(e.createdAt)].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="dash-row">
                  {e.rule.kind === "hash" ? (
                    <span title={s.breaksOnUpdateHelp}>
                      <Pill tone="warning">{s.breaksOnUpdate}</Pill>
                    </span>
                  ) : null}
                  {canAct ? (
                    <Button variant="ghost" className="dash-btn--sm" onClick={() => setRemoving(e)}>
                      {s.removeException}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {v.exceptionsTruncated ? <p className="dash-muted">{s.exceptionsTruncated}</p> : null}
      </div>
      <ConfirmDialog
        open={removing !== null}
        title={s.removeExceptionTitle(removing?.rule.fileName ?? "this program")}
        body={s.removeExceptionBody}
        confirmLabel={s.removeException}
        danger
        onConfirm={() => remove({ exceptionId: removing?._id ?? "" })}
        onDone={() => toast(s.exceptionRemoved)}
        onClose={() => setRemoving(null)}
        describeError={lockdownErrorMessage}
      />
    </Card>
  );
}
