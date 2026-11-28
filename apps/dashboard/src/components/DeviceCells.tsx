import { Pill } from "@rulebox/ui";
import type { DevicePresence, DeviceRow } from "../data/types";
import { formatDateTimeLong, formatRelative } from "../lib/format";
import { strings } from "../lib/strings";
import { devicesStrings } from "../lib/screenStrings/devices";
import { kioskPhaseStrings } from "../lib/screenStrings/kioskPhase";
import { StatusDot } from "./StatusDot";

const s = devicesStrings;

/**
 * Online / offline from `devicePresence` (Section 4.9: a transition, never a
 * timestamp the list has to keep fresh). Offline says since when; a PC never
 * seen since Step 7 (`since` null) says so.
 */
export function DeviceOnline({ presence, now }: { presence: DevicePresence; now: number }) {
  const { online, since } = presence;
  if (online) {
    return <StatusDot tone="success" label={strings.common.online} title={since === null ? undefined : formatDateTimeLong(since)} />;
  }
  if (since === null) return <StatusDot tone="neutral" label={strings.common.offline} sub={strings.common.neverSeen} />;
  return (
    <StatusDot
      tone="neutral"
      label={strings.common.offline}
      sub={strings.common.since(formatRelative(since, now))}
      title={formatDateTimeLong(since)}
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
      {kioskPhaseStrings[phase]}
    </Pill>
  );
}

/**
 * What the PC's head says about the plan: only "over the limit" and "suspended" are worth a badge
 * (the PC keeps its last policy); "ok" and null show nothing.
 */
export function PlanStateBadge({ planState }: { planState: DeviceRow["planState"] }) {
  if (planState === "overLimit") {
    return (
      <span>
        <Pill tone="warning" title={s.planOverLimitHint}>
          {s.planOverLimit}
        </Pill>
      </span>
    );
  }
  if (planState === "suspended") {
    return (
      <span>
        <Pill tone="danger" title={s.planSuspendedHint}>
          {s.planSuspended}
        </Pill>
      </span>
    );
  }
  return null;
}

/** "Up to date" or "Update waiting" (the version numbers are only in the tooltip). */
export function PolicyCell({ applied, latest }: { applied?: number; latest?: number }) {
  if (latest === undefined) return <span className="dash-muted">—</span>;
  if (applied === latest) return <span>{s.policyUpToDate}</span>;
  return (
    <span>
      <Pill tone="warning" title={s.policyWaitingHint(applied, latest)}>
        {s.policyWaiting}
      </Pill>
    </span>
  );
}