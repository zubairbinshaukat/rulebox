import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useKeepAlive, useLockSession, useStepUpStatus } from "../data/stepup";
import { FullPageSpinner } from "../app/RequireMember";
import { useMember } from "../lib/member";
import { StepUpController, type ControllerOptions } from "../lib/stepup/controller";
import { setStepUpHandler } from "../lib/stepUpRetry";
import { StepUpContext } from "./context";

// Each piece is its own chunk: most visits never see a dialog, a lock or setup.
const StepUpDialog = lazy(() => import("./StepUpDialog"));
const LockScreen = lazy(() => import("./LockScreen"));
const SetupScreen = lazy(() => import("./SetupScreen"));

/**
 * Step-up for the signed-in shell (plan 4.16, Phase 4b): feeds `stepUp:status`
 * and the keep-alive / lock calls to the controller, and shows, instead of the
 * screens, the PIN setup (`me.pin.required && !me.pin.set`, every role) or the
 * PIN screen (on every page load, after idle time and "Lock now"), plus the
 * confirm dialog for calls that need it.
 */
export function StepUpProvider({ children, options }: { children: ReactNode; options?: ControllerOptions }) {
  const me = useMember();
  const [controller] = useState(() => new StepUpController({ idleOverrideMs: __STEPUP_TEST_IDLE_MS__, lockOnStart: true, ...options }));
  const status = useStepUpStatus();
  const keepAlive = useKeepAlive();
  const lock = useLockSession();
  const st = status.status === "ready" ? status.data : null;

  useEffect(() => controller.setDeps({ keepAlive, lock }), [controller, keepAlive, lock]);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  useEffect(() => controller.onStatus(st), [controller, st]);
  // The idle lock needs to know there is a PIN before `stepUp:status` has loaded (or if it never does).
  useEffect(() => controller.noteFactor(me.pin.set), [controller, me.pin.set]);
  // Every write of the data seam asks this shell for a confirmation (lib/stepUpRetry.ts).
  useEffect(() => setStepUpHandler((e) => controller.request(e)), [controller]);

  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // `account:me` knows at once (no wait for the status query): no flash of the dashboard before PIN setup.
  const needsSetup = me.pin.required && !me.pin.set;

  let body: ReactNode = children;
  // A lock (idle, another tab, the server) wins over the setup screen: the recovery codes it may be
  // showing are dropped with it, and a new set is made when setup comes back. (The start lock, reason
  // "load", does not: with no PIN yet there is nothing to ask for, and no lock screen should flash.)
  const lockedOverSetup = snap.locked && snap.reason !== "load";
  if ((needsSetup || snap.setupActive) && !lockedOverSetup) body = <SetupScreen controller={controller} />;
  else if (snap.locked) body = <LockScreen controller={controller} email={me.email} reason={snap.reason} />;

  return (
    <StepUpContext.Provider value={controller}>
      <Suspense fallback={<FullPageSpinner />}>{body}</Suspense>
      {snap.request && !snap.locked ? (
        <Suspense fallback={null}>
          <StepUpDialog
            key={snap.request.id}
            error={snap.request.error}
            controller={controller}
            onClose={(ok, serverNow) => controller.settle(ok, serverNow)}
          />
        </Suspense>
      ) : null}
    </StepUpContext.Provider>
  );
}
