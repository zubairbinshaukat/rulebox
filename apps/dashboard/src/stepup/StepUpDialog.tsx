import { useState } from "react";
import { Button } from "@rulebox/ui";
import { useSetActionPin, useStepUpStatus } from "../data/stepup";
import { IS_DEMO } from "../data";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { RegionError } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { errorCodeOf, toAppError } from "../lib/errors";
import { strings } from "../lib/strings";
import type { StepUpController } from "../lib/stepup/controller";
import { sec } from "../lib/stepup/strings";
import { FactorForm } from "./FactorForm";
import { SignOutAndIn } from "./Reauthenticate";
import { SetPinForm } from "./SetPinForm";
import "./stepup.css";

/**
 * The confirm dialog (plan 4.16, dashboard flow 2): a call failed with
 * `step_up_required` or `step_up_setup_required`. Passkey first when one can
 * be used here, the action PIN always; without any factor, the first PIN is
 * set right here (it unlocks the session). Closing it cancels the call.
 */
export default function StepUpDialog({
  error,
  controller,
  onClose,
}: {
  error: unknown;
  controller: StepUpController;
  onClose: (ok: boolean, serverNow?: number) => void;
}) {
  const status = useStepUpStatus();
  const setPin = useSetActionPin();
  const app = toAppError(error);
  const [reauth, setReauth] = useState(app?.code === "step_up_setup_required" && app.detail === "reauthenticate");
  const st = status.status === "ready" ? status.data : null;
  const hasFactor = st ? st.actionPin.set || st.passkeys.length > 0 : true;
  const setup = st !== null && !hasFactor;

  const title = reauth ? sec.reauthTitle : setup ? sec.noFactorTitle : sec.confirmTitle;
  const lead = reauth
    ? sec.reauthLead
    : setup
      ? sec.noFactorLead
      : app?.detail === "fresh"
        ? sec.confirmLeadFresh
        : sec.confirmLead;

  return (
    <Modal
      open
      title={title}
      onClose={() => onClose(false)}
      className="su-dialog"
      actions={
        <Button variant="ghost" onClick={() => onClose(false)}>
          {strings.common.cancel}
        </Button>
      }
    >
      <p className="dash-dialog__lead">{lead}</p>
      {IS_DEMO && !reauth && !setup ? <InlineNotice tone="accent" title={strings.demo.badge} detail={strings.demo.actionPin} /> : null}
      {reauth ? (
        <SignOutAndIn />
      ) : status.status === "loading" ? (
        <SkeletonBlock lines={3} />
      ) : status.status === "error" ? (
        <RegionError error={status.error} onRetry={status.retry} />
      ) : setup ? (
        <SetPinForm
          autoFocus
          submitLabel={sec.setPin}
          onSave={async (pin) => {
            try {
              await setPin({ pin });
            } catch (e) {
              if (errorCodeOf(e) === "step_up_setup_required") setReauth(true);
              throw e;
            }
            onClose(true);
          }}
        />
      ) : (
        <FactorForm status={status.data} controller={controller} submitLabel={sec.confirm} onVerified={(r) => onClose(true, r.serverNow)} />
      )}
    </Modal>
  );
}
