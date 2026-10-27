import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import { deepEqual } from "./deepEqual";
import { isOutOfSupport } from "./lifecycle";
import { bumpOrgStatsIfPresent } from "./plans";
import type { DiskBand } from "./validators";

// The agent's status report, split by change rate (plan 4.2.1, A8; post-Phase-5
// plan 2.6): `deviceSummary` holds the list columns, `deviceReports` the
// detail. Each is written only when its own fields change; disk space is
// compared as a band. Used by `devices:heartbeat` now and by
// `deviceApi:report({ status })` from Step 12.

/** Nullable on the wire so a Rust `None` serializes to a clear. */
const optionalString = v.optional(v.union(v.string(), v.null()));
const optionalNumber = v.optional(v.union(v.number(), v.null()));

/**
 * The agent's complete status snapshot (Phase 2: 12 keys; Step 7 adds two
 * optional keys BEFORE any agent sends them, plan 5.1). Absent (or null) means
 * "not set": when this differs from what is stored, the stored fields are
 * replaced.
 */
export const statusValidator = v.object({
  agentVersion: optionalString,
  os: optionalString,
  osBuild: optionalString,
  osEdition: optionalString,
  ramMb: optionalNumber,
  diskFreeGb: optionalNumber,
  lockdownLevel: optionalString,
  kioskPhase: optionalString,
  kioskError: optionalString,
  appliedVersion: optionalNumber,
  shellHealth: optionalString,
  compat: v.optional(v.any()),
  trustedKeyIds: v.optional(v.union(v.array(v.string()), v.null())),
  restartPending: v.optional(v.union(v.boolean(), v.null())),
});
export type StatusInput = Infer<typeof statusValidator>;

/** Free disk space band (post-Phase-5 plan 2.6). */
export function diskBandOf(gb: number | undefined): DiskBand | undefined {
  if (gb === undefined) return undefined;
  if (gb < 5) return "lt5";
  if (gb < 10) return "5to10";
  if (gb < 20) return "10to20";
  if (gb < 50) return "20to50";
  if (gb <= 100) return "50to100";
  return "gt100";
}

const nn = <T>(x: T | null | undefined): T | undefined => (x === null ? undefined : x);

type Ids = { deviceId: Id<"devices">; orgId: Id<"organizations"> };

type ReportFields = Omit<Doc<"deviceReports">, "_id" | "_creationTime" | "deviceId" | "orgId" | "updatedAt">;
type SummaryFields = Omit<Doc<"deviceSummary">, "_id" | "_creationTime" | "deviceId" | "orgId" | "updatedAt">;

function changed<T extends object>(next: T, stored: object): boolean {
  return (Object.keys(next) as (keyof T)[]).some((k) => !deepEqual(next[k], (stored as T)[k]));
}

export type StatusWrite = { summary: boolean; report: boolean };

/**
 * Write a status snapshot of an authenticated, non-revoked device. Reads the
 * two rows (2 reads); writes each only when it changed; `outOfSupportCount`
 * moves only when the summary's flag flips (1 read + 1 write, rare).
 */
export async function writeStatus(
  ctx: { db: DatabaseWriter },
  ids: Ids,
  s: StatusInput,
  now: number,
  opts: { counters?: boolean } = {},
): Promise<StatusWrite> {
  const osBuild = nn(s.osBuild);
  const osEdition = nn(s.osEdition);
  const diskFreeGb = nn(s.diskFreeGb);

  const summaryNext: SummaryFields = {
    agentVersion: nn(s.agentVersion),
    windowsBuild: osBuild,
    kioskPhase: nn(s.kioskPhase),
    outOfSupport: isOutOfSupport(osBuild, osEdition, now),
    appliedVersion: nn(s.appliedVersion),
    diskBand: diskBandOf(diskFreeGb),
  };
  const summary = await ctx.db
    .query("deviceSummary")
    .withIndex("by_device", (q) => q.eq("deviceId", ids.deviceId))
    .unique();
  let summaryWritten = false;
  let flip = 0;
  if (summary === null) {
    await ctx.db.insert("deviceSummary", { ...ids, ...summaryNext, updatedAt: now });
    summaryWritten = true;
    flip = summaryNext.outOfSupport ? 1 : 0;
  } else if (changed(summaryNext, summary)) {
    await ctx.db.patch(summary._id, { ...summaryNext, updatedAt: now });
    summaryWritten = true;
    if (summary.outOfSupport !== summaryNext.outOfSupport) flip = summaryNext.outOfSupport ? 1 : -1;
  }
  if (flip !== 0 && opts.counters !== false) await bumpOrgStatsIfPresent(ctx, ids.orgId, { outOfSupportCount: flip });

  const report = await ctx.db
    .query("deviceReports")
    .withIndex("by_device", (q) => q.eq("deviceId", ids.deviceId))
    .unique();
  const reportNext: ReportFields = {
    agentVersion: nn(s.agentVersion),
    os: nn(s.os),
    osBuild,
    osEdition,
    ramMb: nn(s.ramMb),
    // The exact value is rewritten only when its band changes.
    diskFreeGb:
      report !== null && diskBandOf(report.diskFreeGb) === diskBandOf(diskFreeGb) ? report.diskFreeGb : diskFreeGb,
    lockdownLevel: nn(s.lockdownLevel),
    kioskPhase: nn(s.kioskPhase),
    kioskError: nn(s.kioskError),
    appliedVersion: nn(s.appliedVersion),
    shellHealth: nn(s.shellHealth),
    compat: nn(s.compat),
    trustedKeyIds: nn(s.trustedKeyIds),
    restartPending: nn(s.restartPending),
  };
  let reportWritten = false;
  if (report === null) {
    await ctx.db.insert("deviceReports", { ...ids, ...reportNext, updatedAt: now });
    reportWritten = true;
  } else if (changed(reportNext, report)) {
    // `undefined` removes the field, so a cleared error is really cleared.
    await ctx.db.patch(report._id, { ...reportNext, updatedAt: now });
    reportWritten = true;
  }
  return { summary: summaryWritten, report: reportWritten };
}
