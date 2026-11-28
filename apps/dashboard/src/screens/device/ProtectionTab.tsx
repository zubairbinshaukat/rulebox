import type { DevicePage } from "../../data/types";
import { LockdownCard, ProtectionCard, UsbAllowCard } from "../lockdown/DeviceCards";

/**
 * The Protection tab (UI pass step 8): what the PC applied of its group's lockdown (main) and the physical protection and the
 * USB allowance (aside). Everything comes from the page query (`fleet:page`): this tab subscribes to nothing of its own, and the
 * old `fleet:get` subscription of the stub is gone. A tablet puts the two aside cards side by side, a phone stacks all three.
 */
export default function ProtectionTab({ d }: { d: DevicePage }) {
  return (
    <div className="dash-split prot">
      <div className="dash-split__main">
        <LockdownCard d={d} />
      </div>
      <div className="dash-split__aside prot__aside">
        <ProtectionCard d={d} />
        <UsbAllowCard d={d} />
      </div>
    </div>
  );
}
