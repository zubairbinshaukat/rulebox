import type { CompatReport, DevicePage } from "../../data/types";
import { InlineNotice } from "../../components/Notice";
import { deviceStrings as s } from "../../lib/screenStrings/device";
import { LockdownCard, ProtectionCard, UsbAllowCard } from "../lockdown/DeviceCards";

/** The layers the PC cannot use, in words (the agent's `layers`, plan 4.12). */
function missingLayers(c: CompatReport): string[] {
  const missing: string[] = [];
  if (c.layers?.appLocker === false) missing.push(s.layerAppLocker);
  if (c.layers?.appControl === false) missing.push(s.layerAppControl);
  return missing;
}

/**
 * STUB (UI pass step 8 replaces it): today's lockdown, physical protection and USB cards in the final arrangement (main + aside),
 * plus the "Reduced protection" notice that used to live in the compatibility card. These cards still read the lockdown part of
 * `fleet:get` through `useDeviceLockdown` (data/lockdown), so while this tab is open it holds the old subscription; the real tab
 * reads `d.apply`, `d.protection`, `d.ring`, `d.usbAllowUntil` from the page query.
 */
export default function ProtectionTab({ d }: { d: DevicePage }) {
  const compat = d.report?.compat;
  return (
    <>
      {compat?.protection === "reduced" ? <InlineNotice tone="neutral" title={s.reducedTitle} detail={s.reducedDetail(missingLayers(compat))} /> : null}
      <div className="dash-split">
        <div className="dash-split__main">
          <LockdownCard deviceId={d._id} />
        </div>
        <div className="dash-split__aside">
          <ProtectionCard deviceId={d._id} />
          <UsbAllowCard deviceId={d._id} />
        </div>
      </div>
    </>
  );
}
