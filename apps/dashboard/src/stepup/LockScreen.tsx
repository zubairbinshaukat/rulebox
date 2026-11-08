import { useEffect, useState } from "react";
import { useStepUpStatus } from "../data/stepup";
import { AuthShell } from "../components/AuthShell";
import { RegionError } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { ConnectionBanner } from "../app/ConnectionBanner";
import type { LockReason, StepUpController } from "../lib/stepup/controller";
import { sec } from "../lib/stepup/strings";
import { strings } from "../lib/strings";
import { FactorForm } from "./FactorForm";
import { ForgotPin } from "./ForgotPin";
import { RecoveryReset } from "./RecoveryReset";
import { SignOutAndIn } from "./Reauthenticate";
import "./stepup.css";

function leadFor(reason: LockReason | null, email: string): string {
  if (reason === "load") return sec.lockLeadLoad(email);
  if (reason === "elsewhere" || reason === "server") return sec.lockLeadOther;
  return sec.lockLead(email);
}

/**
 * The PIN screen (plan 4.16, Phase 4b): shown on every page load or new tab,
 * after the idle time, and after "Lock now". The screens are gone (their
 * subscriptions stopped), the session stays signed in, and the PIN or a
 * passkey brings them back. Below the PIN: "Forgot PIN?" (an emailed link) and
 * "Use a recovery code" (code + new PIN). An unlock in another tab also opens
 * it (the controller watches `stepUp:status`), except right after a load.
 * Sign-out is always offered.
 */
export default function LockScreen({ controller, email, reason }: { controller: StepUpController; email: string; reason: LockReason | null }) {
  const status = useStepUpStatus();
  const [mode, setMode] = useState<"pin" | "recovery">("pin");
  const st = status.status === "ready" ? status.data : null;
  const noPin = st !== null && !st.pin.set;

  useEffect(() => {
    document.title = `${sec.locked} · Rulebox`;
  }, []);

  // PIN removed meanwhile (an Owner's reset): nothing to unlock with; the PIN setup takes over.
  useEffect(() => {
    if (noPin) controller.unlocked();
  }, [noPin, controller]);

  const recovery = mode === "recovery";

  return (
    <AuthShell
      demoHint={strings.demo.actionPin}
      title={recovery ? sec.recoveryUseTitle : sec.lockTitle}
      lead={recovery ? undefined : leadFor(reason, email)}
    >
      <ConnectionBanner />
      {status.status === "loading" || noPin ? (
        <SkeletonBlock lines={3} />
      ) : status.status === "error" ? (
        <RegionError error={status.error} onRetry={status.retry} />
      ) : recovery ? (
        <RecoveryReset
          onDone={() => controller.unlocked()}
          extraActions={
            <button type="button" className="dash-link" onClick={() => setMode("pin")}>
              {sec.backToPin}
            </button>
          }
        />
      ) : (
        <>
          <FactorForm status={status.data} controller={controller} submitLabel={sec.unlock} onVerified={(r) => controller.unlocked(r.serverNow)} />
          <div className="su-lock__help">
            <ForgotPin email={email} resetByEmail={status.data.pin.resetByEmail} />
            {status.data.pin.recoveryCodesLeft > 0 ? (
              <div>
                <button type="button" className="dash-link" onClick={() => setMode("recovery")}>
                  {sec.useRecoveryCode}
                </button>
              </div>
            ) : (
              <p className="dash-muted">{sec.noRecoveryCodes}</p>
            )}
          </div>
        </>
      )}
      <div className="dash-auth__links">
        <SignOutAndIn label={sec.signOut} variant="ghost" />
      </div>
    </AuthShell>
  );
}
