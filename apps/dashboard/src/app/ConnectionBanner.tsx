import { useEffect, useState } from "react";
import IconCloud from "~icons/solar/cloud-cross-linear";
import { useConnectionState } from "../data";
import { strings } from "../lib/strings";

/** How long the socket must be down before the banner shows (Section 4.13). */
export const DISCONNECTED_GRACE_MS = 3000;

/**
 * "Reconnecting…" after 3 seconds without the live connection. Mutations stay
 * enabled: the Convex client queues them until the connection is back.
 */
export function ConnectionBanner() {
  const { isWebSocketConnected } = useConnectionState();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isWebSocketConnected) {
      const t = setTimeout(() => setShow(false), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setShow(true), DISCONNECTED_GRACE_MS);
    return () => clearTimeout(t);
  }, [isWebSocketConnected]);

  return (
    <div role="status" aria-live="polite">
      {show && !isWebSocketConnected ? (
        <div className="dash-banner dash-banner--warning">
          <span className="dash-banner__icon" aria-hidden="true">
            <IconCloud />
          </span>
          <p className="dash-banner__text">
            <strong>{strings.app.reconnecting}</strong>
            {strings.app.reconnectingDetail}
          </p>
        </div>
      ) : null}
    </div>
  );
}
