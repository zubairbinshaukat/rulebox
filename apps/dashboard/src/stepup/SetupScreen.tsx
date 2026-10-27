import { useEffect, useState } from "react";
import { Button, Input } from "@rulebox/ui";
import IconKey from "~icons/solar/key-minimalistic-square-linear";
import { useSetActionPin, useStepUpStatus } from "../data/stepup";
import { strings } from "../lib/strings";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { RegionError } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { errorCodeOf, toAppError } from "../lib/errors";
import type { StepUpController } from "../lib/stepup/controller";
import { stepUpMessage } from "../lib/stepup/messages";
import { isPasskeyCancel, passkeysSupported } from "../lib/stepup/passkey";
import { sec } from "../lib/stepup/strings";
import { SignOutAndIn } from "./Reauthenticate";
import { SetPinForm } from "./SetPinForm";
import { useAddPasskey } from "./usePasskeys";
import "./stepup.css";

/**
 * "Protect important actions" (plan 4.16, dashboard flow 1): right after
 * sign-in + MFA, an Owner or Admin without an action PIN or passkey sets one.
 * The first factor may be set only within 15 minutes of a password sign-in
 * (the backend's bootstrap window); later, sign out and in again, so an Owner
 * is never locked out. Sign-out is always there.
 */
export default function SetupScreen({ controller }: { controller: StepUpController }) {
  const status = useStepUpStatus();
  const setPin = useSetActionPin();
  const [reauth, setReauth] = useState(false);
  const [pinDone, setPinDone] = useState(false);

  // Keep this screen up until "Continue", also after the first factor exists.
  useEffect(() => controller.beginSetup(), [controller]);

  const st = status.status === "ready" ? status.data : null;
  const hasFactor = st !== null && (st.actionPin.set || st.passkeys.length > 0);
  const passkeysHere = st !== null && st.passkeysAvailable && passkeysSupported();

  return (
    <AuthShell title={sec.setupTitle} lead={sec.setupLead} wide demoHint={strings.demo.actionPin}>
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
        <ol className="dash-steps">
          <li>
            <div className="dash-steps__body">
              <p className="su-step-title">{sec.setupPinStep}</p>
              {pinDone || st?.actionPin.set ? (
                <InlineNotice tone="success" title={sec.pinSaved} />
              ) : (
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
                    setPinDone(true);
                  }}
                />
              )}
            </div>
          </li>
          {passkeysHere ? (
            <li>
              <div className="dash-steps__body">
                <p className="su-step-title">{sec.setupPasskeyStep}</p>
                <p className="dash-muted">{sec.setupPasskeyLead}</p>
                <AddPasskeyInline count={st?.passkeys.length ?? 0} onReauth={() => setReauth(true)} />
              </div>
            </li>
          ) : null}
        </ol>
      )}
      <p className="dash-muted">{sec.setupWhy}</p>
      <div className="dash-form__actions">
        {hasFactor ? (
          <Button className="dash-btn--accent" onClick={() => controller.finishSetup()}>
            {sec.setupDone}
          </Button>
        ) : null}
        <SignOutAndIn label={sec.signOut} variant="ghost" />
      </div>
    </AuthShell>
  );
}

/** Name + "Add passkey" on the setup screen (the first factor, or a second one right after the PIN). */
function AddPasskeyInline({ count, onReauth }: { count: number; onReauth: () => void }) {
  const add = useAddPasskey();
  const [name, setName] = useState<string>(sec.passkeyNameDefault);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "neutral"; text: string } | null>(null);
  return (
    <form
      className="dash-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const clean = name.trim() || sec.passkeyNameDefault;
        setBusy(true);
        setMessage(null);
        add(clean).then(
          () => setMessage({ tone: "success", text: sec.passkeyAdded(clean) }),
          (err: unknown) => {
            if (errorCodeOf(err) === "step_up_setup_required") onReauth();
            setMessage({ tone: isPasskeyCancel(err) ? "neutral" : "danger", text: stepUpMessage(err) });
          },
        ).finally(() => setBusy(false));
      }}
    >
      <Field label={sec.passkeyName}>
        {(p) => <Input {...p} value={name} maxLength={64} autoComplete="off" onChange={(e) => setName(e.target.value)} />}
      </Field>
      {message ? <InlineNotice tone={message.tone} alert={message.tone === "danger"} title={message.text} /> : null}
      <div>
        <Button type="submit" variant={count > 0 ? "ghost" : "primary"} disabled={busy} aria-busy={busy}>
          <IconKey aria-hidden="true" />
          {busy ? sec.usingPasskey : sec.addPasskey}
        </Button>
      </div>
    </form>
  );
}
