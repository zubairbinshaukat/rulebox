/**
 * Fleet rows from `convex/fleet.ts` as the screens' types. Pure functions (no
 * Convex React imports), shared by `live/hooks.ts` (detail) and
 * `devices/live.ts` (lists).
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import type { CompatReport, DeviceDetail, DevicePage, DeviceReport, DeviceRow, KioskPhase, ShellHealth } from "../types";

type ListRow = FunctionReturnType<typeof api.fleet.list>["page"][number];
type GetResult = NonNullable<FunctionReturnType<typeof api.fleet.get>>;
type PageResult = NonNullable<FunctionReturnType<typeof api.fleet.page>>;

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
  const out = { ...r, liteMode: r.liteMode === true } as CompatReport;
  // The Phase 6 fields (plan 4.12) arrive checked by the server; anything odd is left out, never shown wrong.
  const x = r as Record<string, unknown>;
  const flag = (o: unknown, k: string) => typeof (o as Record<string, unknown> | null)?.[k] === "boolean";
  if (x.protection !== "full" && x.protection !== "reduced") delete out.protection;
  if (typeof x.layers !== "object" || x.layers === null || !flag(x.layers, "appLocker") || !flag(x.layers, "appControl")) delete out.layers;
  if (typeof x.browsers !== "object" || x.browsers === null || !flag(x.browsers, "edge") || !flag(x.browsers, "chrome")) delete out.browsers;
  const w = x.webview2 as Record<string, unknown> | null | undefined;
  if (typeof w !== "object" || w === null || typeof w.present !== "boolean") delete out.webview2;
  return out;
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

/** `fleet:page` as the screen's `DevicePage`. Tolerant of absent fields (a stale bundle or a newer field the server adds later). */
export function devicePageOf(d: PageResult): DevicePage {
  const r = d.report;
  const report: DeviceReport | null = r
    ? {
        ...r,
        kioskPhase: kioskPhaseOf(r.kioskPhase),
        shellHealth: shellHealthOf(r.shellHealth),
        compat: compatOf(r.compat),
        // The out-of-support flag is computed on write into the summary (A8), not the report.
        outOfSupport: d.outOfSupport === true,
      }
    : null;
  return {
    _id: d._id,
    name: d.name,
    revision: d.revision,
    revoked: d.revoked === true || d.flags.revoked,
    kioskEnabled: d.kioskEnabled,
    enrolledAt: d.enrolledAt,
    group: d.group ?? null,
    displayMode: d.displayMode ?? "auto",
    groupDisplayMode: d.groupDisplayMode ?? "auto",
    presence: { online: d.presence.online, since: d.presence.since },
    report,
    outOfSupport: d.outOfSupport === true,
    latestVersion: d.latestVersion ?? null,
    planState: d.planState ?? null,
    flags: d.flags,
    lock: d.lock ?? null,
    ring: d.ring ?? "everyone",
    usbAllowUntil: d.usbAllowUntil ?? null,
    protection: d.protection ?? null,
    lockdownCapable: d.lockdownCapable ?? null,
    apply: d.apply ?? null,
    failedInstalls: d.failedInstalls ?? { count: 0, more: false, names: [] },
    network: d.network ?? { wifiFailed: 0, printersFailed: 0 },
  };
}

/**
 * `fleet:get` as the screen's `DeviceDetail`.
 * @deprecated UI pass 2026-11: the device page reads `fleet:page` (`devicePageOf`).
 */
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
    // Phase 6 Step 19: an older server has neither.
    displayMode: d.displayMode ?? "auto",
    groupDisplayMode: d.groupDisplayMode ?? "auto",
  };
}
