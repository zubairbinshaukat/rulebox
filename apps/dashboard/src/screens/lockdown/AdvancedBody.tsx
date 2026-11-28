import { useId, type ReactNode } from "react";
import { Checkbox, InfoTip, Input, Pill, Select, Switch, type SelectOption } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import {
  LAYER_MODES,
  type AppControlLevel,
  type LayerMode,
  type LockdownSettings,
  type UsbStorageMode,
  type UsbSwitch,
} from "../../data/types";
import { Field } from "../../components/Field";
import type { LockoutDraft } from "./rules";
import { lockdownStrings as s } from "./strings";

type Patch = (fn: (cur: LockdownSettings) => LockdownSettings) => void;

const MODE_OPTIONS: SelectOption[] = LAYER_MODES.map((m) => ({ value: m, label: s.modes[m], hint: s.modeSub[m] }));
const LEVEL_OPTIONS: SelectOption[] = (["recommendedBlocks", "allowlist"] as const).map((l) => ({ value: l, label: s.levels[l] }));
const STORAGE_OPTIONS: SelectOption[] = (["allow", "readOnly", "block"] as const).map((m) => ({ value: m, label: s.storageModes[m] }));
const USB_OPTIONS: SelectOption[] = (["allow", "block"] as const).map((m) => ({ value: m, label: s.usbModes[m] }));
const USB_SWITCHES = ["printers", "imaging", "phones", "other"] as const;
const STAFF_KEYS = Object.keys(s.staff) as (keyof typeof s.staff)[];
const MACHINE_KEYS = Object.keys(s.machine) as (keyof typeof s.machine)[];

// ---------------------------------------------------------------- rows

/** The small "Changed" mark of a setting that differs from the nearest protection level. */
function ChangedMark() {
  return (
    <Pill tone="accent" className="lk-changed">
      {s.changed}
    </Pill>
  );
}

/** A switch with its label, an (i) for the explanation and, when it differs from the protection level, the "Changed" mark. */
function SwitchRow({ label, info, checked, onChange, disabled, changed }: { label: string; info?: ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled: boolean; changed?: boolean }) {
  return (
    <div className="lk-row" data-changed={changed || undefined}>
      <Switch label={label} checked={checked} onChange={onChange} disabled={disabled} />
      {changed ? <ChangedMark /> : null}
      {info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
    </div>
  );
}

/** A tick box with its label, an (i) and the "Changed" mark. */
function CheckRow({ label, info, checked, onChange, disabled, changed }: { label: string; info?: ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled: boolean; changed?: boolean }) {
  return (
    <div className="lk-row" data-changed={changed || undefined}>
      <Checkbox label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {changed ? <ChangedMark /> : null}
      {info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
    </div>
  );
}

/** A label with its (i) and a `Select` (label above on a narrow column, beside it on a wide one: container query). */
function SelectRow({
  label,
  info,
  value,
  options,
  onChange,
  disabled,
  changed,
  children,
}: {
  label: string;
  info?: ReactNode;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled: boolean;
  changed?: boolean;
  /** Under the select: a line that must stay visible (a warning). */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="lk-sel" data-changed={changed || undefined}>
      <div className="lk-sel__label rb-labelrow">
        <label htmlFor={id}>{label}</label>
        {changed ? <ChangedMark /> : null}
        {info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
      </div>
      <Select id={id} compact value={value} options={options} disabled={disabled} onChange={onChange} />
      {children}
    </div>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return (
    <p className="lk-note" data-tone="warning">
      <IconWarn aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function Group({ title, tag, children }: { title: string; tag?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="lk-group" aria-labelledby={id}>
      <div className="lk-group__head">
        <h3 id={id} className="lk-group__title">
          {title}
        </h3>
        {tag ? <span className="lk-group__tag">{tag}</span> : null}
      </div>
      <div className="lk-group__rows">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- the settings (loaded when Advanced is opened)

export interface AdvancedBodyProps {
  draft: LockdownSettings;
  lockout: LockoutDraft;
  problems: { threshold: boolean; duration: boolean; window: boolean };
  /** Show the lockout errors (after the first Save click). */
  touched: boolean;
  disabled: boolean;
  /** True when this setting differs from the nearest protection level (a "Changed" mark). */
  isChanged: (path: string) => boolean;
  patch: Patch;
  setLockout: (fn: (cur: LockoutDraft) => LockoutDraft) => void;
  /** PCs that left "Hide administrator accounts" off because Other user sign-in is not confirmed there (`lockdown:groupSync`). */
  adminTilesPending: number;
}

/** Every individual setting, as section cards in CSS columns (short and tall sections pack without holes). */
export default function AdvancedBody({ draft, lockout, problems, touched, disabled, isChanged, patch, setLockout, adminTilesPending }: AdvancedBodyProps) {
  const sub = <K extends "staff" | "machine" | "performance">(group: K, key: keyof LockdownSettings[K], on: boolean) =>
    patch((d) => ({ ...d, [group]: { ...d[group], [key]: on } }));
  const mode = (key: "appLocker" | "appControl" | "procWatch", m: LayerMode) => patch((d) => ({ ...d, [key]: { ...d[key], mode: m } }));
  const level = draft.appControl.level;

  return (
    <div className="lk-adv__cols">
      <Group title={s.checksTitle}>
        <SelectRow label={s.appLocker} info={s.appLockerHelp} value={draft.appLocker.mode} options={MODE_OPTIONS} disabled={disabled} onChange={(m) => mode("appLocker", m as LayerMode)} />
        <SelectRow label={s.appControl} info={s.appControlHelp} value={draft.appControl.mode} options={MODE_OPTIONS} disabled={disabled} onChange={(m) => mode("appControl", m as LayerMode)} />
        <SelectRow
          label={s.appControlLevel}
          info={s.levelHelp[level]}
          value={level}
          options={LEVEL_OPTIONS}
          disabled={disabled}
          changed={isChanged("appControl.level")}
          onChange={(l) => patch((d) => ({ ...d, appControl: { ...d.appControl, level: l as AppControlLevel } }))}
        >
          {level === "allowlist" ? <Warn>{s.levelHelp.allowlist}</Warn> : null}
        </SelectRow>
        <SelectRow label={s.procWatch} info={s.procWatchHelp} value={draft.procWatch.mode} options={MODE_OPTIONS} disabled={disabled} onChange={(m) => mode("procWatch", m as LayerMode)} />
      </Group>

      <Group title={s.staffTitle} tag={s.tags.staff}>
        {STAFF_KEYS.map((key) => (
          <SwitchRow key={key} label={s.staff[key][0]} info={s.staff[key][1] || undefined} checked={draft.staff[key]} disabled={disabled} changed={isChanged(`staff.${key}`)} onChange={(on) => sub("staff", key, on)} />
        ))}
      </Group>

      <Group title={s.machineTitle} tag={s.tags.everyone}>
        {MACHINE_KEYS.map((key) => (
          <div key={key} className="lk-row-wrap">
            <SwitchRow label={s.machine[key][0]} info={s.machine[key][1] || undefined} checked={draft.machine[key]} disabled={disabled} changed={isChanged(`machine.${key}`)} onChange={(on) => sub("machine", key, on)} />
            {key === "hideAdminTiles" && draft.machine.hideAdminTiles && adminTilesPending > 0 ? <Warn>{s.adminTilesPending(adminTilesPending)}</Warn> : null}
          </div>
        ))}
      </Group>

      <Group title={s.lockoutTitle} tag={s.tags.everyone}>
        <SwitchRow label={s.lockout} info={s.lockoutHelp} checked={lockout.on} disabled={disabled} changed={isChanged("machine.accountLockout")} onChange={(on) => setLockout((l) => ({ ...l, on }))} />
        {lockout.on ? (
          <div className="lk-lockout">
            <Field label={s.lockoutThreshold} info={s.lockoutThresholdHint} error={touched && problems.threshold ? s.lockoutProblems.threshold : null}>
              {(p) => <Input {...p} value={lockout.threshold} inputMode="numeric" autoComplete="off" disabled={disabled} onChange={(e) => setLockout((l) => ({ ...l, threshold: e.target.value }))} />}
            </Field>
            <Field label={s.lockoutDuration} error={touched && problems.duration ? s.lockoutProblems.duration : null}>
              {(p) => <Input {...p} value={lockout.duration} inputMode="numeric" autoComplete="off" disabled={disabled} onChange={(e) => setLockout((l) => ({ ...l, duration: e.target.value }))} />}
            </Field>
            <Field label={s.lockoutWindow} info={s.lockoutWindowHint} error={touched && problems.window ? s.lockoutProblems.window : null}>
              {(p) => <Input {...p} value={lockout.window} inputMode="numeric" autoComplete="off" disabled={disabled} onChange={(e) => setLockout((l) => ({ ...l, window: e.target.value }))} />}
            </Field>
          </div>
        ) : null}
      </Group>

      <Group title={s.usbTitle}>
        <p className="lk-note" data-tone="success">
          <IconCheck aria-hidden="true" />
          <span>{s.usbAlways}</span>
        </p>
        <SelectRow
          label={s.usb.storage}
          info={s.usbHelp.storage}
          value={draft.usb.storage}
          options={STORAGE_OPTIONS}
          disabled={disabled}
          changed={isChanged("usb.storage")}
          onChange={(storage) => patch((d) => ({ ...d, usb: { ...d.usb, storage: storage as UsbStorageMode } }))}
        />
        {USB_SWITCHES.map((key) => (
          <SelectRow
            key={key}
            label={s.usb[key]}
            info={s.usbHelp[key]}
            value={draft.usb[key]}
            options={USB_OPTIONS}
            disabled={disabled}
            changed={isChanged(`usb.${key}`)}
            onChange={(val) => patch((d) => ({ ...d, usb: { ...d.usb, [key]: val as UsbSwitch } }))}
          >
            {key === "other" && draft.usb.other === "block" ? <Warn>{s.usbOtherWarning}</Warn> : null}
          </SelectRow>
        ))}
        <CheckRow label={s.usbRetroactive} info={s.usbRetroactiveHint} checked={draft.usb.retroactive} disabled={disabled} changed={isChanged("usb.retroactive")} onChange={(on) => patch((d) => ({ ...d, usb: { ...d.usb, retroactive: on } }))} />
      </Group>

      <Group title={s.inputTitle}>
        <SwitchRow
          label={s.winCombos}
          info={s.winCombosHelp}
          checked={draft.keyboard.winCombos === "swallow"}
          disabled={disabled}
          changed={isChanged("keyboard.winCombos")}
          onChange={(on) => patch((d) => ({ ...d, keyboard: { winCombos: on ? "swallow" : "pass" } }))}
        />
        <SwitchRow label={s.accessibilityTools} info={s.accessibilityToolsHelp} checked={draft.accessibilityTools} disabled={disabled} changed={isChanged("accessibilityTools")} onChange={(on) => patch((d) => ({ ...d, accessibilityTools: on }))} />
      </Group>

      <Group title={s.bootTitle}>
        <SwitchRow
          label={s.autoRecovery}
          info={s.autoRecoveryHelp}
          checked={draft.boot.autoRecovery === "off"}
          disabled={disabled}
          changed={isChanged("boot.autoRecovery")}
          onChange={(on) => patch((d) => ({ ...d, boot: { ...d.boot, autoRecovery: on ? "off" : "leave" } }))}
        />
        <SwitchRow label={s.safeModeGuard} info={s.safeModeGuardHelp} checked={draft.boot.safeModeGuard} disabled={disabled} changed={isChanged("boot.safeModeGuard")} onChange={(on) => patch((d) => ({ ...d, boot: { ...d.boot, safeModeGuard: on } }))} />
      </Group>

      <Group title={s.perfTitle}>
        <SwitchRow label={s.staffTuning} info={s.staffTuningHelp} checked={draft.performance.staffTuning} disabled={disabled} onChange={(on) => sub("performance", "staffTuning", on)} />
        <SwitchRow label={s.kioskProfile} info={s.kioskProfileHelp} checked={draft.performance.kioskProfile} disabled={disabled} onChange={(on) => sub("performance", "kioskProfile", on)} />
        <SwitchRow label={s.noPrinting} info={s.noPrintingHelp} checked={draft.performance.noPrinting} disabled={disabled} onChange={(on) => sub("performance", "noPrinting", on)} />
      </Group>

      <Group title={s.netTitle}>
        <SwitchRow label={s.wifiManagedOnly} info={s.wifiManagedOnlyHelp} checked={draft.wifiManagedOnly} disabled={disabled} onChange={(on) => patch((d) => ({ ...d, wifiManagedOnly: on }))} />
        {draft.wifiManagedOnly ? (
          <CheckRow label={s.wifiManagedOnlyConfirm} info={s.wifiManagedOnlyConfirmHint} checked={draft.wifiManagedOnlyConfirmed === true} disabled={disabled} onChange={(on) => patch((d) => ({ ...d, wifiManagedOnlyConfirmed: on }))} />
        ) : null}
      </Group>
    </div>
  );
}