import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Input } from "@rulebox/ui";
import IconKey from "~icons/solar/key-minimalistic-square-linear";
import { useGenerateRecoveryCodes, useSetActionPin, useStepUpStatus } from "../data/stepup";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { RegionError } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { errorCodeOf, toAppError } from "../lib/errors";
import { useMember } from "../lib/member";
import type { StepUpController } from "../lib/stepup/controller";
import { stepUpMessage } from "../lib/stepup/messages";
import { isPasskeyCancel, passkeysSupported } from "../lib/stepup/passkey";
import { sec } from "../lib/stepup/strings";
import { RecoveryCodes } from "./RecoveryCodes";
import { SignOutAndIn } from "./Reauthenticate";
import { SetPinForm } from "./SetPinForm";
import { useAddPasskey } from "./usePasskeys";
import "./stepup.css";

type Phase = "pin" | "codes" | "passkey";

/**
 * PIN setup right after the first sign-in (Phase 4b), for every role, shown
 * while `me.pin.required && !me.pin.set`:
 *   1. choose the PIN (twice, with a "don't forget it" warning),
 *   2. the recovery codes, shown once (copy / download; Continue only after
 *      "I stored them"),
 *   3. an optional passkey, with Skip (left out when this browser or server
 *      cannot use passkeys).
 * The PIN may be set only within 15 minutes of a password sign-in (the
 * backend's bootstrap window); later, sign out and in again. The screen stays
 * up until the last step is done, also after `me.pin.set` turns true. The
 * recovery codes live in this component's state only. Sign-out is always there.
 */
export default function SetupScreen({ controller }: { controller: StepUpController }) {
  const me = useMember();
  const status = useStepUpStatus();
  const setPin = useSetActionPin();
  const generate = useGenerateRecoveryCodes();
  // Mounted with a PIN already set: setup was interrupted by a lock (the screen, and the recovery codes it
  // showed, were dropped). The PIN step is over; make a fresh set of codes.
  const [resumed] = useState(me.pin.set);
  const [phase, setPhase] = useState<Phase>(resumed ? "codes" : "pin");
  const [reauth, setReauth] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [codesError, setCodesError] = useState<string | null>(null);
  const [codesBusy, setCodesBusy] = useState(false);
  const [stored, setStored] = useState(false);

  // Keep this screen up until the last step, also after the PIN exists.
  useEffect(() => controller.beginSetup(), [controller]);

  const st = status.status === "ready" ? status.data : null;
  const passkeysHere = st !== null && st.passkeysAvailable && passkeysSupported();
  const total = passkeysHere ? 3 : 2;
  const step = phase === "pin" ? 1 : phase === "codes" ? 2 : 3;

  function makeCodes() {
    if (codesBusy) return;
    setCodesBusy(true);
    setCodesError(null);
    generate().then(
      (c) => setCodes(c),
      (e: unknown) => setCodesError(stepUpMessage(e)),
    ).finally(() => setCodesBusy(false));
  }

  const resumedStarted = useRef(false);
  useEffect(() => {
    if (!resumed || resumedStarted.current) return;
    resumedStarted.current = true;
    makeCodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  function finish() {
    setCodes(null);
    controller.finishSetup();
  }

  const title = phase === "pin" ? sec.setupTitle : phase === "codes" ? sec.codesTitle : sec.setupPasskeyTitle;
  const lead = phase === "pin" ? sec.setupLead : phase === "codes" ? sec.codesLead : sec.setupPasskeyLead;

  return (
    <AuthShell title={reauth ? sec.reauthTitle : title} lead={reauth ? undefined : lead} wide>
      {reauth ? (
        <>
          <InlineNotice tone="warning" title={sec.reauthTitle} detail={sec.reauthLead} />
          <SignOutAndIn />
        </>
      ) : status.status === "loading" ? (
        <SkeletonBlock lines={4} />
      ) : status.status === "error" ? (
        <RegionError error={status.error} onRetry={status.retry} />
      ) : (
        <>
          <p className="dash-overline">{sec.setupStepOf(step, total, sec.setupSteps[step - 1] ?? "")}</p>

          {phase === "pin" ? (
            <>
              <InlineNotice tone="warning" title={sec.setupWarnTitle} detail={sec.setupWarnDetail} />
              <SetPinForm
                autoFocus
                submitLabel={sec.setPin}
                onSave={async (pin) => {
                  try {
                    await setPin({ pin });
                  } catch (e) {
                    if (errorCodeOf(e) === "step_up_setup_required" && toAppError(e)?.detail === "reauthenticate") setReauth(true);
                    throw e;
                  }
                  // The first PIN unlocks this session (and this tab): the start lock is over.
                  controller.unlocked();
                  setPhase("codes");
                  makeCodes();
                }}
              />
            </>
          ) : null}

          {phase === "codes" ? (
            <>
              {codes ? (
                <>
                  <RecoveryCodes codes={codes} email={me.email} />
                  <Checkbox checked={stored} onChange={(e) => setStored(e.target.checked)} label={sec.codesSaved} />
                  <div className="dash-form__actions">
                    <Button
                      className="dash-btn--accent"
                      disabled={!stored}
                      onClick={() => {
                        if (passkeysHere) setPhase("passkey");
                        else finish();
                      }}
                    >
                      {passkeysHere ? sec.codesContinue : sec.setupDone}
                    </Button>
                  </div>
                </>
              ) : codesError ? (
                <>
                  <InlineNotice tone="danger" alert title={codesError} />
                  <div>
                    <Button onClick={makeCodes} disabled={codesBusy} aria-busy={codesBusy}>
                      {sec.codesRetry}
                    </Button>
                  </div>
                </>
              ) : (
                <div aria-busy="true">
                  <p className="dash-muted">{sec.codesPreparing}</p>
                  <SkeletonBlock lines={3} />
                </div>
              )}
            </>
          ) : null}

          {phase === "passkey" ? <PasskeyStep onReauth={() => setReauth(true)} onDone={finish} /> : null}
        </>
      )}
      <p className="dash-muted">{sec.setupWhy}</p>
      <div className="dash-auth__links">
        <SignOutAndIn label={sec.signOut} variant="ghost" />
      </div>
    </AuthShell>
  );
}

/** Name + "Add passkey", then "Done"; or "Skip for now". */
function PasskeyStep({ onReauth, onDone }: { onReauth: () => void; onDone: () => void }) {
  const add = useAddPasskey();
  const [name, setName] = useState<string>(sec.passkeyNameDefault);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "neutral"; text: string } | null>(null);
  return (
    <form
      className="dash-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || added) return;
        const clean = name.trim() || sec.passkeyNameDefault;
        setBusy(true);
        setMessage(null);
        add(clean)
          .then(
            () => {
              setAdded(true);
              setMessage({ tone: "success", text: sec.passkeyAdded(clean) });
            },
            (err: unknown) => {
              if (errorCodeOf(err) === "step_up_setup_required") onReauth();
              setMessage({ tone: isPasskeyCancel(err) ? "neutral" : "danger", text: stepUpMessage(err) });
            },
          )
          .finally(() => setBusy(false));
      }}
    >
      {added ? null : (
        <Field label={sec.passkeyName}>
          {(p) => <Input {...p} value={name} maxLength={64} autoComplete="off" onChange={(e) => setName(e.target.value)} />}
        </Field>
      )}
      {message ? <InlineNotice tone={message.tone} alert={message.tone === "danger"} title={message.text} /> : null}
      <div className="dash-form__actions">
        {added ? (
          <Button type="button" className="dash-btn--accent" onClick={onDone}>
            {sec.setupDone}
          </Button>
        ) : (
          <>
            <Button type="submit" className="dash-btn--accent" disabled={busy} aria-busy={busy}>
              <IconKey aria-hidden="true" />
              {busy ? sec.usingPasskey : sec.addPasskey}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
              {sec.setupPasskeySkip}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
