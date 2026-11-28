import { useState } from "react";
import { Button, InfoTip, Pill, Select } from "@rulebox/ui";
import { useAllowUsb } from "../../data/lockdown";
import { LAYER_NAMES, MAX_USB_ALLOW_HOURS, type DevicePage, type SecurityPosture } from "../../data/types";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { RelativeTime } from "../../components/RelativeTime";
import { formatDateTime } from "../../lib/format";
import { useCan } from "../../lib/member";
import { useToast } from "../../lib/toast";
import { useNow } from "../../lib/useNow";
import { TechnicalDetails, type TechItem } from "../device/TechnicalDetails";
import { layerNoteOf, layerStateOf, protectionGaps, refusalText } from "./codes";
import { deviceLockdownStrings as s } from "./deviceStrings";

/**
 * The device page's lockdown cards (plan 4.20, UI pass 2026-11): they show what the page query (`fleet:page`) already carries, so
 * the Protection tab subscribes to nothing of its own. Technical values (versions, TPM, folder repairs, codes) sit under
 * "Technical details".
 */

/** A reported code as words; a code this dashboard does not know is shown as it is. */
const value = (code: string | undefined): string => (code === undefined ? "—" : (s.values[code] ?? code));

type Tone = "success" | "warning" | "neutral";

function Row({ label, info, text, tone }: { label: string; info?: string; text: string; tone: Tone }) {
  return (
    <li className="prot-row">
      <span className="prot-row__label">
        {label}
        {info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
      </span>
      <Pill tone={tone}>{text}</Pill>
    </li>
  );
}

/**
 * The Physical protection card (plan 4.16, rule 8): green only when Secure Boot and BitLocker are on, automatic recovery is off
 * and the agent is registered for Safe Mode; otherwise it says what is missing and what that means. Report only: Rulebox never
 * turns BitLocker on.
 */
export function ProtectionCard({ d }: { d: Pick<DevicePage, "protection"> }) {
  const p: SecurityPosture | null = d.protection;
  if (p === null) {
    return (
      <Card title={s.protectionTitle}>
        <p className="dash-muted">{s.protectionNone}</p>
      </Card>
    );
  }
  const gaps = protectionGaps(p);
  const good = (ok: boolean): Tone => (ok ? "success" : "warning");
  const fix = gaps.filter((g) => g === "secureBoot" || g === "bitLocker").map((g) => (g === "secureBoot" ? s.secureBoot : s.bitLocker));
  const tech: TechItem[] = [];
  if (p.tpm !== undefined) tech.push({ label: s.tpm, value: value(p.tpm), mono: false });
  if (p.serviceAcl !== undefined) tech.push({ label: s.serviceAcl, value: value(p.serviceAcl), mono: false });
  if (p.aclDrift !== undefined && p.aclDrift > 0) tech.push({ label: s.aclDrift, value: String(p.aclDrift), mono: false });
  return (
    <Card title={s.protectionTitle} actions={<InfoTip label={`About ${s.protectionTitle}`}>{s.protectionInfo}</InfoTip>}>
      <div className="dash-form">
        {gaps.length === 0 ? (
          <InlineNotice tone="success" title={s.protectionOk} />
        ) : (
          <InlineNotice
            tone="warning"
            title={s.protectionMissing}
            detail={`${fix.length > 0 ? s.turnOn(fix) : s.missingList(gaps.map((g) => s.missing[g]))} ${s.never}`}
          />
        )}
        <ul className="prot-rows" aria-label={s.protectionTitle}>
          <Row label={s.secureBoot} info={s.secureBootInfo} text={value(p.secureBoot)} tone={good(p.secureBoot === "on")} />
          <Row label={s.bitLocker} info={s.bitLockerInfo} text={value(p.bitLocker)} tone={good(p.bitLocker === "on")} />
          <Row label={s.autoRecovery} info={s.autoRecoveryInfo} text={value(p.autoRecovery)} tone={good(!gaps.includes("autoRecovery"))} />
          <Row label={s.safeMode} info={s.safeModeInfo} text={p.safeModeAgent === true ? s.yes : s.no} tone={good(p.safeModeAgent === true)} />
        </ul>
        <TechnicalDetails items={tech} />
      </div>
    </Card>
  );
}

/** What the compatibility report says cannot be used on this PC, in words. */
function missingLayers(c: NonNullable<NonNullable<DevicePage["report"]>["compat"]>): string[] {
  const missing: string[] = [];
  if (c.layers?.appLocker === false) missing.push(s.layerAppLocker);
  if (c.layers?.appControl === false) missing.push(s.layerAppControl);
  return missing;
}

/**
 * The Lockdown card (plan 4.11, 4.20): what the PC reported after applying its settings: the overall state, the refusal in plain
 * words, each layer's mode, state and note. Versions and codes are under "Technical details". Codes only: the PC never sends a path
 * or a command line.
 */
export function LockdownCard({ d }: { d: Pick<DevicePage, "apply" | "lockdownCapable" | "report"> }) {
  const a = d.apply;
  const refusal = refusalText(a?.refusal);
  const compat = d.report?.compat;
  const missing = compat?.protection === "reduced" ? missingLayers(compat) : [];
  // Windows Home: the apply report says a check is "unsupported"; the compatibility report says which ones cannot be used.
  const home = a !== null && (a.layers.appLocker.state === "unsupported" || a.layers.appControl.state === "unsupported");
  const tech: TechItem[] = [];
  if (a) {
    tech.push({ label: s.configVersion, value: a.configVersion === null ? "—" : String(a.configVersion), mono: false });
    tech.push({ label: s.lkg, value: a.lkgVersion === null ? "—" : String(a.lkgVersion), mono: false });
    if (a.refusal) tech.push({ label: s.refusalCode, value: a.refusal });
    for (const name of LAYER_NAMES) {
      const l = a.layers[name];
      if (l.detail) tech.push({ label: s.layerCode(s.layers[name]), value: l.detail });
    }
  }
  return (
    <Card
      title={s.lockdownTitle}
      actions={a ? <Pill tone={s.stateTones[a.state]}>{s.states[a.state]}</Pill> : undefined}
      sub={
        a ? (
          <>
            {s.reported} <RelativeTime ms={a.updatedAt} />
          </>
        ) : undefined
      }
    >
      <div className="dash-form">
        {d.lockdownCapable === false ? <InlineNotice tone="warning" title={s.tooOld} detail={s.tooOldDetail} /> : null}
        {a === null && d.lockdownCapable !== false ? <p className="dash-muted">{s.noReport}</p> : null}
        {a?.state === "refused" ? <InlineNotice tone="danger" title={s.refusedTitle} detail={refusal ?? undefined} /> : null}
        {a?.state === "rolledBack" ? <InlineNotice tone="danger" title={s.rolledBackTitle} detail={refusal ?? s.rolledBackDetail} /> : null}
        {a !== null && a.state !== "refused" && a.state !== "rolledBack" && refusal !== null ? <InlineNotice tone="warning" title={refusal} /> : null}
        {missing.length > 0 ? (
          <InlineNotice tone="neutral" title={s.reducedTitle} detail={s.reducedDetail(missing)} />
        ) : home ? (
          <InlineNotice tone="neutral" title={s.reducedTitle} detail={s.reducedHome} />
        ) : null}
        {a ? (
          <ul className="prot-layers" aria-label={s.layerList}>
            {LAYER_NAMES.map((name) => {
              const l = a.layers[name];
              const st = l.state === "auditFirst" ? { label: s.auditFirst, tone: "accent" as const } : layerStateOf(l.state);
              const note = layerNoteOf(name, l);
              return (
                <li key={name} className="prot-layer" data-tone={st.tone}>
                  <div className="prot-layer__head">
                    <span className="prot-layer__name">
                      {s.layers[name]}
                      <InfoTip label={`About ${s.layers[name]}`}>{s.layerInfo[name]}</InfoTip>
                    </span>
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </div>
                  <p className="prot-layer__mode">{s.modes[l.mode] ?? l.mode}</p>
                  {note ? <p className="prot-layer__note">{note}</p> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <TechnicalDetails items={tech} />
      </div>
    </Card>
  );
}

const HOUR_CHOICES = [1, 2, 4, MAX_USB_ALLOW_HOURS];

/**
 * "Allow USB for this PC" (plan 4.3 `usbTempAllow`, edge case 62): lifts the group's USB blocks on this one PC for at most 8 hours,
 * then they apply again by themselves. Keyboards, mice and touch screens are never blocked, with or without it.
 */
export function UsbAllowCard({ d }: { d: Pick<DevicePage, "_id" | "revoked" | "usbAllowUntil"> }) {
  const allowUsb = useAllowUsb();
  const canAct = useCan("admin");
  const toast = useToast();
  const now = useNow(30_000);
  const [hours, setHours] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const until = d.usbAllowUntil;
  const open = until !== null && until > now;

  function run(h: number) {
    setPending(true);
    setError(null);
    allowUsb({ deviceId: d._id, hours: h }).then(
      () => {
        setPending(false);
        toast(h === 0 ? s.usbEnded : s.usbStarted(h));
      },
      (err) => {
        setPending(false);
        setError(err);
      },
    );
  }

  return (
    <Card
      title={s.usbTitle}
      actions={
        <>
          {open ? <Pill tone="warning">{s.usbOpenPill}</Pill> : null}
          <InfoTip label={`About ${s.usbTitle}`}>{s.usbInfo}</InfoTip>
        </>
      }
    >
      <div className="dash-form">
        <p>{open ? s.usbOn(formatDateTime(until)) : s.usbOff}</p>
        {canAct && !d.revoked ? (
          open ? (
            <div className="dash-form__actions">
              <Button variant="ghost" disabled={pending} aria-busy={pending} onClick={() => run(0)}>
                {s.usbEnd}
              </Button>
            </div>
          ) : (
            <div className="prot-usb">
              <Field label={s.usbHours} className="prot-usb__hours">
                {(p) => (
                  <Select
                    {...p}
                    value={String(hours)}
                    disabled={pending}
                    onChange={(v) => setHours(Number(v))}
                    options={HOUR_CHOICES.map((h) => ({ value: String(h), label: s.usbHour(h) }))}
                  />
                )}
              </Field>
              <Button variant="ghost" disabled={pending} aria-busy={pending} onClick={() => run(hours)}>
                {s.usbAllow}
              </Button>
            </div>
          )
        ) : null}
        <FormError error={error} />
      </div>
    </Card>
  );
}
