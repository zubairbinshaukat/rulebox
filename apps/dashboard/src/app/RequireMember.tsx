import { Navigate, Outlet, useLocation } from "react-router";
import { Button, LogoMark, Spinner } from "@rulebox/ui";
import { useAuthActions, useAuthState, useMe } from "../data";
import { MeContext } from "../lib/member";
import { withNext } from "../lib/next";
import { strings } from "../lib/strings";
import { useSessionGuard } from "./useSessionGuard";

export function FullPageSpinner() {
  return (
    <div className="dash-fullpage" aria-busy="true">
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <Spinner size={56} />
        <p className="dash-muted">{strings.app.signingIn}</p>
      </div>
    </div>
  );
}

function NoAccess() {
  const { signOut } = useAuthActions();
  return (
    <main className="dash-fullpage">
      <div className="dash-card dash-card--pad" style={{ maxWidth: 440, display: "flex", flexDirection: "column", gap: 14 }}>
        <LogoMark size={44} label={strings.app.name} />
        <h1 style={{ fontSize: 22 }}>{strings.app.noAccessTitle}</h1>
        <p className="dash-muted">{strings.app.noAccessBody}</p>
        <div>
          <Button onClick={() => void signOut()}>{strings.app.signOut}</Button>
        </div>
      </div>
    </main>
  );
}

/**
 * Gate for every signed-in screen (Step 4 #3): signed out → `/sign-in?next=…`,
 * no member row → "no access", Owner/Admin without a verified second factor →
 * `/mfa?next=…`; otherwise the member is provided to the screens.
 */
export function RequireMember() {
  const { isLoading, isAuthenticated } = useAuthState();
  const me = useMe();
  const location = useLocation();
  const here = location.pathname + location.search;
  // A token the server no longer accepts (`me` stays null), or any live hook
  // answering `unauthenticated`: back to sign-in with `next` (session expiry).
  useSessionGuard(!isLoading && isAuthenticated && me === null);

  if (isLoading) return <FullPageSpinner />;
  if (!isAuthenticated) return <Navigate to={withNext("/sign-in", here)} replace />;
  if (me === undefined || me === null) return <FullPageSpinner />;
  if ("noAccess" in me) return <NoAccess />;
  if (me.mfa.required && !me.mfa.verified) return <Navigate to={withNext("/mfa", here)} replace />;

  return (
    <MeContext.Provider value={me}>
      <Outlet context={me} />
    </MeContext.Provider>
  );
}
