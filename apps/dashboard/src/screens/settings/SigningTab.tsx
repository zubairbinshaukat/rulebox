import { useState } from "react";
import { Button, Pill, type PillTone } from "@rulebox/ui";
import IconShieldOk from "~icons/solar/shield-check-linear";
import IconShieldOff from "~icons/solar/shield-warning-linear";
import { useFinishRotation, useKeysScreen, usePrepareRotation, useRegisterKey } from "../../data";
import type { KeysScreen, PolicyKeyStatus } from "../../data/types";
import { Card } from "../../components/Card";
import { CopyField } from "../../components/CopyField";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { RoleGate } from "../../components/RoleGate";
import { SkeletonBlock } from "../../components/Skeleton";
import { useToast } from "../../lib/toast";
import { formatDate } from "../../lib/format";
import { publishErrorMessage, usePublishAgainFlow } from "../../lib/publish";
import { strings } from "../../lib/strings";
import { settingsStrings } from "../../lib/screenStrings/settings";

const s = settingsStrings.signing;
const p = strings.publish;
const TONE: Record<PolicyKeyStatus, PillTone> = { active: "success", next: "accent", retired: "neutral" };

/** `keys:status` + `keys:trustProgress` (Section 4.5). Register / rotate are Owner only. */
export function SigningTab() {
  const keys = useKeysScreen();
  return (
    <QueryRegion state={keys} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={5} /></div>}>
      {(k) => <Signing k={k} />}
    </QueryRegion>
  );
}

function Signing({ k }: { k: KeysScreen }) {
  const register = useRegisterKey();
  const prepare = usePrepareRotation();
  const finish = useFinishRotation();
  const toast = useToast();
  const again = usePublishAgainFlow();
  const [pending, setPending] = useState<"register" | "prepare" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const active = k.keys.find((x) => x.status === "active");
  const next = k.keys.find((x) => x.status === "next");
  // An organization with its own key (keyring) never touches the server's environment: no warning about it, no commands, no rotation.
  const deployment = k.managed === "deployment";
  const working = Boolean(active) && k.signing === "ok" && !k.keyringLocked && k.publishFailedAt === null;

  const run = (what: "register" | "prepare", fn: () => Promise<void>, done: string) => {
    setPending(what);
    setError(null);
    fn().then(
      () => {
        setPending(null);
        toast(done);
      },
      (e) => {
        setPending(null);
        setError(e);
      },
    );
  };

  const publishAgain = (
    <RoleGate minRole="owner">
      <Button variant="ghost" className="dash-btn--sm" disabled={again.pending} aria-busy={again.pending} onClick={again.run}>
        {again.pending ? p.publishing : p.again}
      </Button>
    </RoleGate>
  );

  return (
    <div className="set-sign">
      <Card level={3} className="set-sign__status">
        <div className="set-fs">
          <div className="set-hero" data-tone={working ? "ok" : "off"}>
            <span className="set-hero__icon" aria-hidden="true">
              {working ? <IconShieldOk /> : <IconShieldOff />}
            </span>
            <div className="set-hero__text">
              <p className="set-hero__title">{working ? (deployment ? s.statusDeployment : s.statusKeyring) : s.statusOffLine}</p>
              {active && working ? <p className="set-hero__sub">{s.since(formatDate(active.createdAt))}</p> : null}
            </div>
            <Pill tone={working ? "success" : "danger"} dot>
              {working ? s.statusOn : s.statusOff}
            </Pill>
          </div>

          {k.keyringLocked ? <InlineNotice tone="danger" title={s.lockedTitle} detail={s.lockedBody} /> : null}
          {k.publishFailedAt !== null ? (
            <InlineNotice tone="danger" title={s.publishFailed(formatDate(k.publishFailedAt))} detail={p.signingHint} action={publishAgain} />
          ) : null}
          <FormError error={again.error} describe={publishErrorMessage} />
          {k.rosterPending ? (
            <InlineNotice
              tone="warning"
              title={p.rosterTitle}
              detail={p.rosterBody}
              action={k.publishFailedAt === null ? publishAgain : undefined}
            />
          ) : null}
          {deployment && !k.envKeyPresent ? <InlineNotice tone="warning" title={s.envMissing} /> : null}
          {deployment && active && k.envKeyPresent && k.signing === "mismatch" ? (
            <InlineNotice tone="danger" title={s.mismatchTitle} detail={s.mismatchBody} />
          ) : null}
          {!active ? (
            <InlineNotice
              tone="danger"
              title={s.noKeyTitle}
              detail={deployment ? s.noKeyBody : s.noKeyKeyring}
              action={
                <RoleGate minRole="owner">
                  <Button disabled={pending !== null || (deployment && !k.envKeyPresent)} aria-busy={pending === "register"} onClick={() => run("register", () => register(), s.registered)}>
                    {s.register}
                  </Button>
                </RoleGate>
              }
            />
          ) : null}
          <FormError error={error} />
        </div>
      </Card>

      <Card level={3} title={s.advancedTitle} className="set-sign__adv">
        <div className="set-adv">
          {deployment && !active ? (
            <RoleGate minRole="owner">
              <details className="dash-advanced" open>
                <summary>{s.setupTitle}</summary>
                <div className="dash-advanced__body">
                  <p className="dash-list__title">{s.cliTitle}</p>
                  {s.cliSteps.map((step) => (
                    <CopyField key={step.command} label={step.label} value={step.command} showLabel />
                  ))}
                  <p className="dash-muted">{s.cliNote}</p>
                </div>
              </details>
            </RoleGate>
          ) : null}

          {k.keys.length ? (
            <details className="dash-advanced">
              <summary>{s.keyDetails}</summary>
              <div className="dash-advanced__body">
                <ul className="dash-list" aria-label={s.keyDetails}>
                  {k.keys.map((key) => (
                    <li key={key.keyId} className="dash-list__item" style={{ paddingInline: 0, alignItems: "flex-start" }}>
                      <div className="dash-list__body">
                        <p className="dash-list__title">
                          {s.keyId} <span className="dash-mono">{key.keyId}</span>
                        </p>
                        <p className="dash-list__meta dash-mono dash-wrap">
                          {s.fingerprint}: {key.fingerprint}
                        </p>
                        <p className="dash-list__meta">
                          {s.created} {formatDate(key.createdAt)}
                        </p>
                      </div>
                      <Pill tone={TONE[key.status]} dot>
                        {s.status[key.status]}
                      </Pill>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ) : null}

          {deployment && active ? (
            <details className="dash-advanced" open={Boolean(next) || undefined}>
              <summary>{s.rotateTitle}</summary>
              <div className="dash-advanced__body">
                <p className="dash-muted">{s.rotateLead}</p>
                <ol className="dash-steps">
                  {s.rotateSteps.map((step) => (
                    <li key={step}>
                      <div className="dash-steps__body">
                        <p>{step}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                {next && k.trust ? <InlineNotice tone="accent" title={s.trust(k.trust.trusting, k.trust.total)} /> : null}
                {next && !k.envNextKeyPresent ? <InlineNotice tone="neutral" title={s.envNextMissing} /> : null}
                <RoleGate minRole="owner" fallback={<p className="dash-muted">{strings.app.ownerOnly}</p>}>
                  <div className="dash-form__actions">
                    {!next ? (
                      <Button variant="ghost" disabled={pending !== null} aria-busy={pending === "prepare"} onClick={() => run("prepare", () => prepare(), s.prepared)}>
                        {s.prepare}
                      </Button>
                    ) : (
                      <Button onClick={() => setConfirmFinish(true)}>{s.finish}</Button>
                    )}
                  </div>
                </RoleGate>
              </div>
            </details>
          ) : null}

          <details className="dash-advanced">
            <summary>{s.wrongTitle}</summary>
            <div className="dash-advanced__body">
              <div>
                <p className="dash-list__title">{s.lostLabel}</p>
                <p className="dash-muted">{s.lostBody}</p>
              </div>
              <div>
                <p className="dash-list__title">{s.stolenLabel}</p>
                <p className="dash-muted">{s.stolenBody}</p>
              </div>
            </div>
          </details>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmFinish}
        title={s.finishConfirmTitle}
        body={s.finishConfirmBody}
        confirmLabel={s.finish}
        danger
        typeToConfirm={next?.keyId}
        onConfirm={() => finish()}
        onDone={() => toast(s.finished)}
        onClose={() => setConfirmFinish(false)}
      />
    </div>
  );
}
