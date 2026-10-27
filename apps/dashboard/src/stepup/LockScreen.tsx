import { useEffect } from "react";
import { useStepUpStatus } from "../data/stepup";
import { AuthShell } from "../components/AuthShell";
import { RegionError } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { ConnectionBanner } from "../app/ConnectionBanner";
import type { LockReason, StepUpController } from "../lib/stepup/controller";
import { sec } from "../lib/stepup/strings";
import { strings } from "../lib/strings";
import { FactorForm } from "./FactorForm";
import { SignOutAndIn } from "./Reauthenticate";
import "./stepup.css";

/**
 * The idle lock (plan 4.16, dashboard flow 3): the screens are gone (their
 * subscriptions stopped), the session stays signed in, and a PIN or a passkey
 * brings them back. An unlock in another tab of this browser also does (the
 * controller watches `stepUp:status`). Sign-out is always offered.
 */
export default function LockScreen({ controller, email, reason }: { controller: StepUpController; email: string; reason: LockReason | null }) {
  const status = useStepUpStatus();
  const st = status.status === "ready" ? status.data : null;
  const noFactor = st !== null && !st.actionPin.set && st.passkeys.length === 0;

  useEffect(() => {
    document.title = `${sec.locked} · Rulebox`;
  }, []);

  // Factors removed meanwhile (an Owner's reset): nothing to unlock with; the
  // first-factor setup takes over.
  useEffect(() => {
    if (noFactor) controller.unlocked();
  }, [noFactor, controller]);

  return (
    <AuthShell demoHint={strings.demo.actionPin} title={sec.lockTitle} lead={reason === "elsewhere" || reason === "server" ? sec.lockLeadOther : sec.lockLead(email)}>
      <ConnectionBanner />
      {status.status === "loading" || noFactor ? (
        <SkeletonBlock lines={3} />
      ) : status.status === "error" ? (
        <RegionError error={status.error} onRetry={status.retry} />
      ) : (
        <FactorForm status={status.data} controller={controller} submitLabel={sec.unlock} onVerified={(r) => controller.unlocked(r.serverNow)} />
      )}
      <div className="dash-auth__links">
        <SignOutAndIn label={sec.signOut} variant="ghost" />
      </div>
    </AuthShell>
  );
}
