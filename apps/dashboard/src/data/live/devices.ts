/**
 * Fleet rows from `convex/fleet.ts` as the screens' types. Pure functions (no
 * Convex React imports), shared by `live/hooks.ts` (detail) and
 * `devices/live.ts` (lists).
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import type { CompatReport, DeviceDetail, DeviceReport, DeviceRow, KioskPhase, ShellHealth } from "../types";

type ListRow = FunctionReturnType<typeof api.fleet.list>["page"][number];
type GetResult = NonNullable<FunctionReturnType<typeof api.fleet.get>>;

const KIOSK_PHASES: readonly string[] = ["notApplied", "applying", "applied", "failed", "unknown"] satisfies KioskPhase[];
const SHELL_HEALTH: readonly string[] = ["notRunning", "starting", "healthy", "unhealthy", "failed", "unknown"] satisfies ShellHealth[];

/** The agent reports these as free text: anything not known shows as "Unknown". */
export function kioskPhaseOf(s: string | undefined): KioskPhase | undefined {
  return s === undefined ? undefined : KIOSK_PHASES.includes(s) ? (s as KioskPhase) : "unknown";
}

export function shellHealthOf(s: string | undefined): ShellHealth | undefined {
  return s === undefined ? undefined : SHELL_HEALTH.includes(s) ? (s as ShellHealth) : "unknown";
}

/** `compat` is `v.any()` on the server (the agent owns its shape): the screen needs it whole or not at all. */
export function compatOf(c: unknown): CompatReport | undefined {
  if (typeof c !== "object" || c === null) return undefined;
  const r = c as Partial<CompatReport>;
  if (typeof r.os !== "object" || r.os === null || !Array.isArray(r.blockers) || !Array.isArray(r.warnings)) return undefined;
  return { ...r, liteMode: r.liteMode === true } as CompatReport;
}

export function deviceRowOf(r: ListRow): DeviceRow {
  const s = r.summary;
  return {
    _id: r._id,
    name: r.name,
    groupId: r.groupId,
    groupName: r.groupName,
    revoked: r.presence.revoked,
    kioskEnabled: r.kioskEnabled,
    enrolledAt: r.enrolledAt,
    presence: { online: r.presence.online, since: r.presence.since },
    report: s
      ? {
          agentVersion: s.agentVersion,
          osBuild: s.windowsBuild,
          kioskPhase: kioskPhaseOf(s.kioskPhase),
          appliedVersion: s.appliedVersion,
          outOfSupport: s.outOfSupport,
        }
      : null,
    latestVersion: r.latestVersion ?? undefined,
    planState: r.planState ?? null,
  };
}

export function deviceDetailOf(d: GetResult): DeviceDetail {
  const r = d.report;
  const report: DeviceReport | null = r
    ? {
        ...r,
        kioskPhase: kioskPhaseOf(r.kioskPhase),
        shellHealth: shellHealthOf(r.shellHealth),
        compat: compatOf(r.compat),
        // The out-of-support flag is computed on write into the summary (A8), not the report.
        outOfSupport: d.summary?.outOfSupport === true,
      }
    : null;
  return {
    _id: d._id,
    name: d.name,
    revision: d.revision,
    revoked: d.flags.revoked,
    kioskEnabled: d.kioskEnabled,
    enrolledAt: d.enrolledAt,
    group: d.group,
    presence: { online: d.presence.online, since: d.presence.since },
    report,
    versions: d.versions,
    flags: d.flags,
    // An older server (rolling deploy) has no `lock`: no lock.
    lock: d.lock ?? null,
    groups: d.groups,
  };
}
