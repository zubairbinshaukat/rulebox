import { useState } from "react";
import { Button } from "@rulebox/ui";
import { useRequestPinReset } from "../data/stepup";
import { InlineNotice } from "../components/Notice";
import { stepUpMessage } from "../lib/stepup/messages";
import { sec } from "../lib/stepup/strings";

/**
 * "Forgot PIN?" on the lock screen. The request is bound to the signed-in
 * session: no email is typed, the link goes to the member's own address, and
 * the answer is always the same neutral sentence (`account:requestPinReset`
 * answers ok whether or not anything could be sent). Only a rate limit or a
 * lost connection shows an error.
 */
export function ForgotPin({ email, resetByEmail }: { email: string; resetByEmail: boolean }) {
  const request = useRequestPinReset();
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!resetByEmail) return <p className="dash-muted">{sec.emailOff}</p>;

  function send() {
    if (state === "sending") return;
    setState("sending");
    setError(null);
    request().then(
      () => setState("sent"),
      (e: unknown) => {
        setError(stepUpMessage(e));
        setState("idle");
      },
    );
  }

  return (
    <div className="dash-form">
      {state === "sent" ? (
        <InlineNotice
          tone="success"
          title={sec.forgotSent(email)}
          detail={sec.forgotNote}
          action={
            <Button variant="ghost" className="dash-btn--sm" onClick={send}>
              {sec.forgotSendAgain}
            </Button>
          }
        />
      ) : (
        <div>
          <button type="button" className="dash-link" onClick={send} disabled={state === "sending"} aria-busy={state === "sending"}>
            {state === "sending" ? sec.forgotSending : sec.forgotPin}
          </button>
        </div>
      )}
      {error ? <InlineNotice tone="danger" alert title={error} /> : null}
    </div>
  );
}
