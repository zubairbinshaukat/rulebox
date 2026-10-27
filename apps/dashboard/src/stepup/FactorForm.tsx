import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input } from "@rulebox/ui";
import IconKey from "~icons/solar/key-minimalistic-square-linear";
import { useVerifyActionPin } from "../data/stepup";
import type { StepUpStatus, StepUpVerified } from "../data/types";
import { InlineNotice } from "../components/Notice";
import { toAppError } from "../lib/errors";
import { strings } from "../lib/strings";
import { stepUpMessage } from "../lib/stepup/messages";
import { cancelPasskeyPrompt, isPasskeyCancel, passkeysSupported } from "../lib/stepup/passkey";
import { pinInput } from "../lib/stepup/pin";
import { sec } from "../lib/stepup/strings";
import type { StepUpController } from "../lib/stepup/controller";
import { usePasskeyVerification } from "./usePasskeys";

interface Wait {
  /** Local time when the next PIN try is allowed. */
  until: number;
  message: string;
}

/** The wait the server already reports (`actionPin.lockedUntil`, server time). */
function initialWait(status: StepUpStatus, controller: StepUpController | null): Wait | null {
  const until = status.actionPin.lockedUntil;
  if (until === null || status.actionPin.disabled) return null;
  const local = controller ? controller.toLocal(until) : until;
  const left = local - Date.now();
  return left > 0 ? { until: local, message: sec.pinLockedWait(left) } : null;
}

/**
 * Confirm with a passkey (first, when one can be used here) or the action PIN.
 * Used by the confirm dialog and the lock screen. The PIN lives only in this
 * component's state and is cleared after every try and on unmount.
 */
export function FactorForm({
  status,
  controller,
  submitLabel,
  onVerified,
}: {
  status: StepUpStatus;
  controller: StepUpController | null;
  submitLabel: string;
  onVerified: (r: StepUpVerified) => void;
}) {
  const verifyPin = useVerifyActionPin();
  const verifyPasskey = usePasskeyVerification();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<"pin" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState<Wait | null>(() => initialWait(status, controller));
  const mounted = useRef(true);
  const prompted = useRef(false);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A prompt still open when the dialog closes is cancelled (no stuck ceremony).
      cancelPasskeyPrompt(prompted.current);
    };
  }, []);

  // One timeout to the end of the wait (no ticking clock).
  useEffect(() => {
    if (!wait) return;
    const t = setTimeout(() => setWait(null), Math.max(0, wait.until - Date.now()));
    return () => clearTimeout(t);
  }, [wait]);

  const usablePasskeys = status.passkeys.filter((k) => !k.suspended).length;
  const canPasskey = status.passkeysAvailable && usablePasskeys > 0 && passkeysSupported();
  const pinUsable = status.actionPin.set && !status.actionPin.disabled;
  const triesLeft = status.actionPin.attemptsBeforeDisable;

  async function onPasskey() {
    if (busy) return;
    setBusy("passkey");
    setError(null);
    try {
      const r = await verifyPasskey(() => {
        prompted.current = true;
      });
      if (mounted.current) onVerified(r);
    } catch (e) {
      if (!mounted.current) return;
      setError(isPasskeyCancel(e) ? sec.passkeyCancelled : stepUpMessage(e));
    } finally {
      prompted.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function onPin(e: FormEvent) {
    e.preventDefault();
    if (busy || wait) return;
    if (!/^[0-9]{6,12}$/.test(pin)) {
      setError(strings.validate.pin);
      pinRef.current?.focus();
      return;
    }
    setBusy("pin");
    setError(null);
    const value = pin;
    setPin("");
    try {
      const r = await verifyPin({ pin: value });
      if (mounted.current) onVerified(r);
    } catch (err) {
      if (!mounted.current) return;
      const app = toAppError(err);
      const ms = app?.retryAfterMs;
      if (ms && (app.code === "step_up_invalid" || app.code === "step_up_locked")) {
        setWait({ until: Date.now() + ms, message: stepUpMessage(err) });
      } else setError(stepUpMessage(err));
      pinRef.current?.focus();
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <div className="dash-form su-factor">
      {canPasskey ? (
        <Button
          variant="primary"
          className="dash-btn--accent su-factor__passkey"
          onClick={() => void onPasskey()}
          disabled={busy !== null}
          aria-busy={busy === "passkey"}
        >
          <IconKey aria-hidden="true" />
          {busy === "passkey" ? sec.usingPasskey : sec.usePasskey}
        </Button>
      ) : null}
      {canPasskey && pinUsable ? <p className="su-factor__or">{sec.orPin}</p> : null}

      {pinUsable ? (
        <form className="dash-form" noValidate onSubmit={(e) => void onPin(e)}>
          <div className="dash-field">
            <label className="dash-field__label" htmlFor="su-pin">
              {sec.pin}
            </label>
            <Input
              ref={pinRef}
              id="su-pin"
              name="rulebox-action-pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              // Not a password to save or fill: one-off, typed each time.
              autoComplete="off"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="done"
              maxLength={12}
              autoFocus={!canPasskey}
              className="dash-mono su-factor__pin"
              aria-describedby="su-pin-hint"
              aria-invalid={error ? true : undefined}
              value={pin}
              disabled={busy === "pin"}
              onChange={(e) => setPin(pinInput(e.target.value))}
            />
            <p className="dash-field__hint" id="su-pin-hint">
              {sec.pinHint}
            </p>
          </div>
          {triesLeft > 0 && triesLeft < 10 ? <p className="dash-muted su-factor__tries">{sec.pinTriesLeft(triesLeft)}</p> : null}
          <Button type="submit" className={canPasskey ? undefined : "dash-btn--accent"} disabled={busy !== null || wait !== null} aria-busy={busy === "pin"}>
            {busy === "pin" ? sec.confirming : submitLabel}
          </Button>
        </form>
      ) : status.actionPin.disabled ? (
        <InlineNotice tone="warning" title={canPasskey ? strings.errors.stepUpDisabled : sec.pinDisabledNoPasskey} />
      ) : !canPasskey ? (
        <InlineNotice tone="warning" title={usablePasskeys > 0 && status.passkeysAvailable ? sec.passkeyUnsupported : sec.notReady["passkeys not configured"]!} />
      ) : null}

      <div aria-live="assertive" className="su-factor__msg">
        {wait ? <InlineNotice tone="warning" alert title={wait.message} /> : null}
        {error ? <InlineNotice tone={isCancelText(error) ? "neutral" : "danger"} alert title={error} /> : null}
      </div>
    </div>
  );
}

function isCancelText(message: string): boolean {
  return message === sec.passkeyCancelled;
}
