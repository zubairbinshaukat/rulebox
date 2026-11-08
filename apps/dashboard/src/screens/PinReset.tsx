import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { Button } from "@rulebox/ui";
import { useAuthState, useMe } from "../data";
import { useRedeemPinReset } from "../data/stepup";
import { AuthShell } from "../components/AuthShell";
import { InlineNotice } from "../components/Notice";
import { FullPageSpinner } from "../app/RequireMember";
import { useSessionGuard } from "../app/useSessionGuard";
import { toAppError } from "../lib/errors";
import { withNext } from "../lib/next";
import { captureResetToken, forgetResetToken } from "../lib/pinResetLink";
import { sec } from "../lib/stepup/strings";
import { strings } from "../lib/strings";
import { SignOutAndIn } from "../stepup/Reauthenticate";
import { SetPinForm } from "../stepup/SetPinForm";
import "../stepup/stepup.css";

type Outcome = "form" | "invalid" | "reauth" | "done";

/** Mounted copies of the page (2 for a moment under StrictMode); the token is dropped only when none is left. */
let mounted = 0;

/**
 * `/pin-reset#token=...`: the page the forgot-PIN email links to (Phase 4b
 * Part C). The token is read from the URL fragment and removed from the
 * address at once (`lib/pinResetLink.ts`; `main.tsx` already did it on a real
 * page load). The email alone is never enough: the member must also be signed
 * in here with the password (a visitor without a session goes to sign-in and
 * comes back), and that sign-in must be under 15 minutes old.
 *
 * Every problem with the link (expired, used, wrong, someone else's) is one
 * sentence; the screen never says which.
 */
export default function PinReset() {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuthState();
  const me = useMe();
  const redeem = useRedeemPinReset();
  // In the initial state, so the strip happens during the first render (StrictMode runs it twice; it is idempotent).
  const [token] = useState(() => captureResetToken());
  const [outcome, setOutcome] = useState<Outcome>("form");
  useSessionGuard(!auth.isLoading && auth.isAuthenticated && me === null, "/pin-reset");

  // The token must not outlive this page, except through a sign-in detour (signed out, an old sign-in, an
  // ended session), which comes back here. The check waits one tick, so StrictMode's test unmount is harmless.
  const detour = (!auth.isAuthenticated && token !== null) || (auth.isAuthenticated && me === null) || outcome === "reauth";
  const keep = useRef(detour);
  useEffect(() => {
    keep.current = detour;
  });
  useEffect(() => {
    mounted += 1;
    return () => {
      mounted -= 1;
      setTimeout(() => {
        if (mounted === 0 && !keep.current) forgetResetToken();
      }, 0);
    };
  }, []);

  if (auth.isLoading || me === undefined) return <FullPageSpinner />;
  if (!auth.isAuthenticated && token !== null) return <Navigate to={withNext("/sign-in", location.pathname)} replace />;
  if (auth.isAuthenticated && me === null) return <FullPageSpinner />;

  if (token === null && outcome !== "done") {
    return (
      <AuthShell title={sec.resetTitle}>
        <InlineNotice tone="warning" title={sec.resetNoToken} />
        <div className="dash-auth__links">
          <Link className="dash-link" to="/">
            {sec.resetBack}
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (outcome === "done") {
    return (
      <AuthShell title={sec.resetDone} lead={sec.resetDoneLead}>
        <div>
          <Button className="dash-btn--accent" onClick={() => navigate("/", { replace: true })}>
            {sec.resetGoOn}
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (outcome === "invalid") {
    return (
      <AuthShell title={sec.resetTitle}>
        <InlineNotice tone="danger" alert title={sec.resetInvalid} />
        <div className="dash-auth__links">
          <Link className="dash-link" to="/">
            {sec.resetBack}
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (outcome === "reauth") {
    return (
      <AuthShell title={sec.reauthTitle}>
        <InlineNotice tone="warning" title={sec.reauthTitle} detail={sec.reauthLead} />
        <SignOutAndIn />
      </AuthShell>
    );
  }

  return (
    <AuthShell title={sec.resetTitle} lead={sec.resetLead} demoHint={sec.resetDemoHint}>
      <SetPinForm
        autoFocus
        submitLabel={sec.resetSubmit}
        onSave={async (pin) => {
          try {
            await redeem({ token: token ?? "", newPin: pin });
          } catch (e) {
            const app = toAppError(e);
            if (app?.code === "step_up_invalid") {
              forgetResetToken();
              setOutcome("invalid");
              return;
            }
            if (app?.code === "step_up_setup_required" && app.detail === "reauthenticate") {
              // The token stays in memory for the sign-in detour.
              setOutcome("reauth");
              return;
            }
            throw e;
          }
          forgetResetToken();
          setOutcome("done");
        }}
        extraActions={
          <Link className="dash-link" to="/" onClick={forgetResetToken}>
            {strings.common.cancel}
          </Link>
        }
      />
    </AuthShell>
  );
}
