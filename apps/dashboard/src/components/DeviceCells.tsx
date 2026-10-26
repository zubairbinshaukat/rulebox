import { Pill } from "@rulebox/ui";
import type { DeviceRow } from "../data/types";
import { formatDateTimeLong, formatRelative } from "../lib/format";
import { isOnline } from "../lib/online";
import { strings } from "../lib/strings";
import { StatusDot } from "./StatusDot";

const s = strings.devices;

/** Online / offline from `fleet:liveStatus` (Section 4.9), with "last seen" that ticks. */
export function DeviceOnline({ lastSeenAt, pingIntervalMs, now }: { lastSeenAt?: number; pingIntervalMs?: number; now: number }) {
  if (lastSeenAt === undefined || pingIntervalMs === undefined) {
    return <StatusDot tone="neutral" label={strings.common.offline} sub={strings.common.neverSeen} />;
  }
  const online = isOnline(lastSeenAt, pingIntervalMs, now);
  return (
    <StatusDot
      tone={online ? "success" : "neutral"}
      label={online ? strings.common.online : strings.common.offline}
      sub={formatRelative(lastSeenAt, now)}
      title={`${strings.common.lastSeen(formatRelative(lastSeenAt, now))} · ${formatDateTimeLong(lastSeenAt)}`}
    />
  );
}

export function KioskCell({ row }: { row: Pick<DeviceRow, "kioskEnabled" | "revoked" | "report"> }) {
  if (row.revoked) return <Pill tone="danger">{s.revoked}</Pill>;
  if (!row.kioskEnabled) return <Pill tone="warning">{s.kioskOff}</Pill>;
  const phase = row.report?.kioskPhase ?? "unknown";
  const tone = phase === "applied" ? "success" : phase === "failed" ? "danger" : "neutral";
  return (
    <Pill tone={tone} dot>
      {strings.kioskPhase[phase]}
    </Pill>
  );
}

export function PolicyCell({ applied, latest }: { applied?: number; latest?: number }) {
  if (latest === undefined) return <span className="dash-muted">—</span>;
  if (applied === latest) return <span className="dash-mono">{s.policyCurrent(latest)}</span>;
  return <Pill tone="warning">{s.policyWaiting(applied, latest)}</Pill>;
}
