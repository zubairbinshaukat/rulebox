import { useState } from "react";
import { Button, type ButtonVariant } from "@rulebox/ui";
import { useAllowUsb } from "../../data/lockdown";
import type { Id } from "../../data/types";
import { messageFor } from "../../lib/errors";
import { useToast } from "../../lib/toast";
import { deviceLockdownStrings } from "../lockdown/deviceStrings";
import { deviceText as t } from "./strings";

/**
 * "End now" of the "USB devices are allowed until ..." note (`fleet:allowUsb` with 0 hours). Its own chunk: it needs the lockdown seam,
 * which the Overview would otherwise carry for the sake of one rare button.
 */
export default function EndUsbButton({ deviceId, label, variant, disabled }: { deviceId: Id; label: string; variant: ButtonVariant; disabled?: boolean }) {
  const allowUsb = useAllowUsb();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      disabled={disabled || busy}
      aria-busy={busy}
      onClick={() => {
        setBusy(true);
        allowUsb({ deviceId, hours: 0 }).then(
          () => {
            setBusy(false);
            toast(deviceLockdownStrings.usbEnded);
          },
          (e) => {
            setBusy(false);
            toast(messageFor(e), "danger");
          },
        );
      }}
    >
      {busy ? t.running : label}
    </Button>
  );
}
