import { useState } from "react";
import { Button, Pill, type PillTone } from "@rulebox/ui";
import { useFinishRotation, useKeysScreen, usePrepareRotation, useRegisterKey } from "../../data";
import type { KeysScreen, PolicyKeyStatus } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { RoleGate } from "../../components/RoleGate";
import { SkeletonBlock } from "../../components/Skeleton";
import { useToast } from "../../lib/toast";
import { formatDate } from "../../lib/format";
import { strings } from "../../lib/strings";

const s = strings.settings.signing;
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
  const [pending, setPending] = useState<"register" | "prepare" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const active = k.keys.find((x) => x.status === "active");
  const next = k.keys.find((x) => x.status === "next");

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

  return (
    <>
      <Card title={strings.settings.tabs.signing} sub={s.lead}>
        <div className="dash-form">
          {!k.envKeyPresent ? <InlineNotice tone="warning" title={s.envMissing} /> : null}
          {!active ? (
            <InlineNotice
              tone="danger"
              title={s.noKeyTitle}
              detail={s.noKeyBody}
              action={
                <RoleGate minRole="owner">
                  <Button disabled={pending !== null || !k.envKeyPresent} aria-busy={pending === "register"} onClick={() => run("register", () => register(), s.registered)}>
                    {s.register}
                  </Button>
                </RoleGate>
              }
            />
          ) : null}
          {k.keys.length ? (
            <ul className="dash-list" aria-label={strings.settings.tabs.signing}>
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
          ) : null}
          <FormError error={error} />
        </div>
      </Card>

      {active ? (
        <Card title={s.rotateTitle} sub={s.rotateLead}>
          <div className="dash-form">
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
        </Card>
      ) : null}

      <div className="dash-grid dash-grid--2">
        <Card title={s.lostTitle}>
          <p className="dash-muted">{s.lostBody}</p>
        </Card>
        <Card title={s.stolenTitle}>
          <p className="dash-muted">{s.stolenBody}</p>
        </Card>
      </div>

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
    </>
  );
}
