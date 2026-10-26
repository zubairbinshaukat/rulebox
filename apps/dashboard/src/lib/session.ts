/**
 * "The server says this session is gone" signal (Step 4 #3). The live data
 * hooks call `reportUnauthenticated()` when a query, mutation or action fails
 * with `unauthenticated` (session deleted by a password reset, a disabled
 * member, an expired session). `useSessionGuard` (in `app/`) listens and sends
 * the person to `/sign-in?next=…&expired=1`.
 *
 * Nothing about the session is stored here: Convex Auth owns its tokens.
 */
import { safeNext } from "./next";

type Listener = () => void;

const listeners = new Set<Listener>();

export function reportUnauthenticated(): void {
  for (const l of [...listeners]) l();
}

export function onUnauthenticated(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `/sign-in?next=<here>&expired=1` (the `next` guard of `lib/next.ts` applies). */
export function expiredSignInPath(next: string): string {
  const params = new URLSearchParams();
  const safe = safeNext(next);
  if (safe !== "/") params.set("next", safe);
  params.set("expired", "1");
  return `/sign-in?${params.toString()}`;
}
