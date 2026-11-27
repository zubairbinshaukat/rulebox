import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@rulebox/ui";
import IconKey from "~icons/solar/key-minimalistic-square-linear";
import { useStepUpStatus } from "../data/stepup";
import { useMember } from "../lib/member";
import { passkeysSupported } from "../lib/stepup/passkey";
import { sec } from "../lib/stepup/strings";
import { dismissPasskeyReminder, wasPasskeyReminderDismissed } from "./reminderStore";

/**
 * A dismissible banner on every screen while the member has no passkey (step 3 of setup is optional and
 * is skipped silently when the tab was closed before it). Links to Settings, Security. It stays hidden
 * once dismissed (per person, in this browser only), and while there is nothing to add (this browser or
 * the server cannot use passkeys, a passkey exists, or PIN setup is still running).
 */
export function PasskeyReminder() {
  const me = useMember();
  const status = useStepUpStatus();
  const [dismissed, setDismissed] = useState(() => wasPasskeyReminderDismissed(me.email));
  if (status.status !== "ready" || dismissed) return null;
  const st = status.data;
  if (!me.pin.set || me.pin.codesPending === true || !st.passkeysAvailable || st.passkeys.length > 0 || !passkeysSupported()) return null;
  return (
    <div className="dash-banner dash-banner--accent" role="status">
      <span className="dash-banner__icon" aria-hidden="true">
        <IconKey />
      </span>
      <p className="dash-banner__text">
        <strong>{sec.passkeyReminderTitle}</strong>
        {sec.passkeyReminderBody}
      </p>
      <Link to="/settings?tab=security" className="rb-btn rb-btn--ghost dash-btn--sm">
        {sec.passkeyReminderAction}
      </Link>
      <Button
        variant="ghost"
        className="dash-btn--sm"
        onClick={() => {
          setDismissed(true);
          dismissPasskeyReminder(me.email);
        }}
      >
        {sec.passkeyReminderDismiss}
      </Button>
    </div>
  );
}
