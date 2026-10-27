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
 * Step-up for the signed-in shell (plan 4.16): feeds `stepUp:status` and the
 * keep-alive / lock calls to the controller, and shows, instead of the
 * screens, the first-factor setup (Owner / Admin without a factor) or the
 * lock screen (idle), plus the confirm dialog for calls that need it.
 */
export function StepUpProvider({ children, options }: { children: ReactNode; options?: ControllerOptions }) {
  const me = useMember();
  const [controller] = useState(() => new StepUpController({ idleOverrideMs: __STEPUP_TEST_IDLE_MS__, ...options }));
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
  // Every write of the data seam asks this shell for a confirmation (lib/stepUpRetry.ts).
  useEffect(() => setStepUpHandler((e) => controller.request(e)), [controller]);

  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const needsSetup = st !== null && me.role !== "viewer" && !st.actionPin.set && st.passkeys.length === 0;

  let body: ReactNode = children;
  if (needsSetup || snap.setupActive) body = <SetupScreen controller={controller} />;
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
