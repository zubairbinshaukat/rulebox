import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuthActions } from "../data";
import { expiredSignInPath, onUnauthenticated } from "../lib/session";

/**
 * How long `account:me` may say "signed out" while the client still holds a
 * token before the session counts as gone. Right after sign-in the first
 * answers can still be the signed-out ones; a real loss lasts.
 */
export const SESSION_LOST_GRACE_MS = 2500;

/**
 * Ends a session the server no longer accepts (Step 4 #3, session expiry):
 * when any live hook reports `unauthenticated`, or `account:me` stays `null`
 * although the client holds a token, go to `/sign-in?next=…&expired=1` and
 * drop the local tokens (Convex Auth `signOut`).
 *
 * `next` defaults to the current location.
 */
export function useSessionGuard(sessionMissing: boolean, next?: string) {
  const { signOut } = useAuthActions();
  const navigate = useNavigate();
  const location = useLocation();
  const target = next ?? location.pathname + location.search;

  // Latest values for the callbacks below (updated after render, never during it).
  const latest = useRef({ signOut, target });
  useEffect(() => {
    latest.current = { signOut, target };
  });

  const ending = useRef(false);
  const end = useCallback(() => {
    if (ending.current) return;
    ending.current = true;
    navigate(expiredSignInPath(latest.current.target), { replace: true });
    void latest.current.signOut();
  }, [navigate]);

  useEffect(() => onUnauthenticated(end), [end]);

  useEffect(() => {
    if (!sessionMissing) return;
    const t = setTimeout(end, SESSION_LOST_GRACE_MS);
    return () => clearTimeout(t);
  }, [sessionMissing, end]);
}
