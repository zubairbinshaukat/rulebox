import { useState, type ReactNode } from "react";
import { Button, Pill, Select } from "@rulebox/ui";
import { useSetRings } from "../../data";
import { useAllowUsb, useDeviceLockdown } from "../../data/lockdown";
import { LAYER_NAMES, MAX_USB_ALLOW_HOURS, RINGS, type DeviceLockdown, type Id, type Ring, type SecurityPosture } from "../../data/types";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { RelativeTime } from "../../components/RelativeTime";
import { formatDateTime } from "../../lib/format";
import { useCan } from "../../lib/member";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { useNow } from "../../lib/useNow";
import { LAYER_MODE_LABELS, layerNoteOf, layerStateOf, protectionGaps, refusalText } from "./codes";
import { deviceLockdownStrings as s, RING_LABELS, ringErrorMessage } from "./deviceStrings";

/**
 * The device page's lockdown cards (plan 4.20). They read the lockdown part of `fleet:get` through `useDeviceLockdown`: the
 * same query and arguments as the page, so the same subscription and no extra read.
 */
function useLockdown(deviceId: Id, title: string, body: (ld: DeviceLockdown) => ReactNode): ReactNode {
  const ld = useDeviceLockdown(deviceId);
  if (ld.status === "ready") return body(ld.data);
  return (
    <Card title={title}>
      <p className="dash-muted">{ld.status === "loading" ? strings.app.loading : s.unavailable}</p>
    </Card>
  );
}

/** A reported code as words; a code this dashboard does not know is shown as it is. */
const value = (code: string | undefined): string => (code === undefined ? "—" : (s.values[code] ?? code));

function Row({ label, text, tone }: { label: string; text: string; tone?: "success" | "warning" | "neutral" }) {
  return (
    <li className="dash-roll__member">
      <span>{label}</span>
      {tone ? <Pill tone={tone}>{text}</Pill> : <span className="dash-muted">{text}</span>}
    </li>
  );
}

/**
 * The Physical protection card (plan 4.16, rule 8): green only when Secure Boot and BitLocker are on, automatic recovery is off
 * and the agent is registered for Safe Mode; otherwise it says what is missing and what that means. Report only: Rulebox never
 * turns BitLocker on.
 */
export function ProtectionCard({ deviceId }: { deviceId: Id }) {
  return useLockdown(deviceId, s.protectionTitle, (ld) => <Protection protection={ld.protection} />);
}

function Protection({ protection: p }: { protection: SecurityPosture | null }) {
  if (p === null) {
    return (
      <Card title={s.protectionTitle}>
        <p className="dash-muted">{s.protectionNone}</p>
      </Card>
    );
  }
  const gaps = protectionGaps(p);
  const good = (ok: boolean) => (ok ? "success" : "warning") as "success" | "warning";
  return (
    <Card title={s.protectionTitle}>
      <div className="dash-form">
        {gaps.length === 0 ? (
          <InlineNotice tone="success" title={s.protectionOk} />
        ) : (
          <InlineNotice tone="warning" title={s.protectionMissing} detail={`${s.missingList(gaps.map((g) => s.missing[g]))} ${s.never}`} />
        )}
        <ul className="dash-roll__members" aria-label={s.protectionTitle}>
          <Row label={s.secureBoot} text={value(p.secureBoot)} tone={good(p.secureBoot === "on")} />
          <Row label={s.bitLocker} text={value(p.bitLocker)} tone={good(p.bitLocker === "on")} />
          <Row label={s.autoRecovery} text={value(p.autoRecovery)} tone={good(!gaps.includes("autoRecovery"))} />
          <Row label={s.safeMode} text={p.safeModeAgent === true ? s.registered : s.notRegistered} tone={good(p.safeModeAgent === true)} />
          {p.tpm !== undefined ? <Row label={s.tpm} text={value(p.tpm)} /> : null}
          {p.serviceAcl !== undefined ? <Row label={s.serviceAcl} text={value(p.serviceAcl)} tone={p.serviceAcl === "ok" ? "success" : "warning"} /> : null}
          {p.aclDrift !== undefined && p.aclDrift > 0 ? <Row label={s.aclDrift} text={String(p.aclDrift)} /> : null}
        </ul>
      </div>
    </Card>
  );
}

/**
 * The Lockdown card (plan 4.11, 4.20): what the PC reported after applying its policy: the overall state, the refusal in plain
 * words, each layer's mode, state and note, the last working version, and the PC's rollout ring. Codes only: the PC never sends
 * a path or a command line.
 */
export function LockdownCard({ deviceId }: { deviceId: Id }) {
  return useLockdown(deviceId, s.lockdownTitle, (ld) => <Lockdown deviceId={deviceId} ld={ld} />);
}

function Lockdown({ deviceId, ld }: { deviceId: Id; ld: DeviceLockdown }) {
  const a = ld.apply;
  const refusal = refusalText(a?.refusal);
  const home = a !== null && (a.layers.appLocker.state === "unsupported" || a.layers.appControl.state === "unsupported");
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
        {ld.lockdownCapable === false ? <InlineNotice tone="warning" title={s.tooOld} detail={s.tooOldDetail} /> : null}
        {a === null && ld.lockdownCapable !== false ? <p className="dash-muted">{s.noReport}</p> : null}
        {a?.state === "refused" ? <InlineNotice tone="danger" title={s.refusedTitle} detail={refusal ?? undefined} /> : null}
        {a?.state === "rolledBack" ? <InlineNotice tone="danger" title={s.rolledBackTitle} detail={refusal ?? s.rolledBackDetail} /> : null}
        {a !== null && a.state !== "refused" && a.state !== "rolledBack" && refusal !== null ? <InlineNotice tone="warning" title={refusal} /> : null}
        {home ? <InlineNotice tone="neutral" title={s.reducedHome} detail={s.reducedHomeDetail} /> : null}
        {a ? (
          <>
            <ul className="dash-roll__members" aria-label={s.layerList}>
              {LAYER_NAMES.map((name) => {
                const l = a.layers[name];
                const st = layerStateOf(l.state);
                const note = layerNoteOf(name, l);
                return (
                  <li key={name} className="dash-roll__member">
                    <span className="dash-cell-stack">
                      <span>{s.layers[name]}</span>
                      <span className="dash-cell-sub dash-wrap">{[LAYER_MODE_LABELS[l.mode] ?? l.mode, note].filter(Boolean).join(" · ")}</span>
                    </span>
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </li>
                );
              })}
            </ul>
            <dl className="dash-kv">
              <div className="dash-kv__item">
                <dt>{s.configVersion}</dt>
                <dd>{a.configVersion === null ? "—" : s.version(a.configVersion)}</dd>
              </div>
              <div className="dash-kv__item">
                <dt>{s.lkg}</dt>
                <dd>{a.lkgVersion === null ? "—" : s.version(a.lkgVersion)}</dd>
              </div>
            </dl>
          </>
        ) : null}
        <RingPicker deviceId={deviceId} ld={ld} />
      </div>
    </Card>
  );
}

/** The PC's rollout ring (plan 4.14, 4.20): `rollouts:setRings` for this one PC, with the rollout revision `fleet:get` carries. */
function RingPicker({ deviceId, ld }: { deviceId: Id; ld: DeviceLockdown }) {
  const setRings = useSetRings();
  const canAct = useCan("admin");
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const groupId = ld.groupId;
  if (groupId === null) return <p className="dash-muted">{s.ringNoGroup}</p>;
  if (!canAct || ld.revoked) {
    return (
      <dl className="dash-kv">
        <div className="dash-kv__item">
          <dt>{s.ring}</dt>
          <dd>{RING_LABELS[ld.ring]}</dd>
        </div>
      </dl>
    );
  }
  return (
    <>
      <Field label={s.ring} hint={s.ringHint}>
        {(p) => (
          <Select
            {...p}
            value={ld.ring}
            disabled={pending}
            onChange={(e) => {
              const ring = e.target.value as Ring;
              setPending(true);
              setError(null);
              setRings({ groupId, deviceIds: [deviceId], ring, expectedRevision: ld.rolloutRevision }).then(
                () => {
                  setPending(false);
                  toast(s.ringSaved);
                },
                (err) => {
                  setPending(false);
                  setError(err);
                },
              );
            }}
          >
            {RINGS.map((r) => (
              <option key={r} value={r}>
                {RING_LABELS[r]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <FormError error={error} onReload={() => setError(null)} describe={ringErrorMessage} />
    </>
  );
}

const HOUR_CHOICES = [1, 2, 4, MAX_USB_ALLOW_HOURS];

/**
 * "Allow USB for this PC" (plan 4.3 `usbTempAllow`, edge case 62): lifts the group's USB blocks on this one PC for at most 8 hours,
 * then they apply again by themselves. Keyboards, mice and touch screens are never blocked, with or without it.
 */
export function UsbAllowCard({ deviceId }: { deviceId: Id }) {
  return useLockdown(deviceId, s.usbTitle, (ld) => <UsbAllow deviceId={deviceId} ld={ld} />);
}

function UsbAllow({ deviceId, ld }: { deviceId: Id; ld: DeviceLockdown }) {
  const allowUsb = useAllowUsb();
  const canAct = useCan("admin");
  const toast = useToast();
  const now = useNow(30_000);
  const [hours, setHours] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const until = ld.usbAllowUntil;
  const open = until !== null && until > now;

  function run(h: number) {
    setPending(true);
    setError(null);
    allowUsb({ deviceId, hours: h }).then(
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
    <Card title={s.usbTitle} actions={open ? <Pill tone="warning">{s.usbHour(Math.max(1, Math.ceil((until - now) / 3_600_000)))}</Pill> : undefined}>
      <div className="dash-form">
        <p className="dash-muted">
          {s.usbLead} {s.usbAlways}
        </p>
        <p>{open ? s.usbOn(formatDateTime(until)) : s.usbOff}</p>
        {canAct && !ld.revoked ? (
          open ? (
            <div className="dash-form__actions">
              <Button variant="ghost" disabled={pending} aria-busy={pending} onClick={() => run(0)}>
                {s.usbEnd}
              </Button>
            </div>
          ) : (
            <>
              <Field label={s.usbHours} hint={s.usbMax}>
                {(p) => (
                  <Select {...p} value={String(hours)} disabled={pending} onChange={(e) => setHours(Number(e.target.value))}>
                    {HOUR_CHOICES.map((h) => (
                      <option key={h} value={h}>
                        {s.usbHour(h)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="dash-form__actions">
                <Button variant="ghost" disabled={pending} aria-busy={pending} onClick={() => run(hours)}>
                  {s.usbAllow}
                </Button>
              </div>
            </>
          )
        ) : null}
        <FormError error={error} />
      </div>
    </Card>
  );
}
