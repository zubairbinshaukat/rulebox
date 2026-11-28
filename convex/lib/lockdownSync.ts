import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import type { ApplyStateValue } from "./lockdownValidators";

// `deviceLockdownSync`: the small per-PC row behind "PCs up to date: n of m" on the group lockdown screen (`lockdown:groupSync`).
//
// Why it exists: `deviceApplyReports` holds the whole report of a PC (7 layers, Wi-Fi and printer states, capabilities: ~1 to 2.5 KB) and
// `devices` rows are ~0.35 KB; `groupSync` needs five small facts of a PC and its group. Reading both rows of every PC on every re-run cost
// ~60 KB for 50 PCs. This row holds the facts (~0.3 KB) and is the group's membership list too, so the query reads ONE small row per PC.
// It is written ONLY when one of the facts changes (CLAUDE.md data rule 5) and is never part of the `devices` row that lists subscribe to
// (rule 4).
//
// Invariants (kept by `enrollment:enroll`, `fleet:move`, `deviceApi:reportApply`, `lib/fleet.ts:revokeDevice` and the backfill
// `maintenance:backfillLockdownSync`):
// - a PC that is in a group and not revoked has exactly ONE row, with the group it is in NOW;
// - a PC without a group, a revoked PC and a removed PC have none;
// - the facts are those of the PC's current `deviceApplyReports` row when that row names a configuration of this group; otherwise the row
//   is "waiting": `configVersion` 0, no `state`, both flags off (a PC that never reported, an agent too old to name its configuration, or a
//   PC that was just moved and has not reported in its new group yet).

/**
 * The apply-report codes that mean "Hide administrator accounts was left off on this PC because Other user sign-in is not confirmed
 * there" (the PC reports it as the `machine` layer's detail, or as the whole policy's refusal).
 * - `admin_tiles_skipped`: the agent since 2026-11-28 (the machine layer skips `hideAdminTiles` alone and reports `state: "ok"` with this
 *   detail; the rest of the document applied);
 * - `admin_signin_unverified`: older agents (the same situation reported as a `partial` machine layer or a refusal).
 */
export const ADMIN_TILES_CODES: ReadonlySet<string> = new Set(["admin_tiles_skipped", "admin_signin_unverified"]);

/** The facts `groupSync` counts, as stored (without the ids). The flags are stored only when true. */
export type SyncFields = {
  groupId: Id<"groups">;
  /** The group configuration version the PC applied (`deviceApplyReports.config.version`); 0 = waiting (no usable report yet). */
  configVersion: number;
  /** Absent while waiting. */
  state: ApplyStateValue | undefined;
  /** The PC left `hideAdminTiles` off because Other user sign-in is not confirmed there (whatever the layer's state). */
  adminTilesSkipped: true | undefined;
  /** Windows Home: the AppLocker or App Control layer is `unsupported`. */
  reduced: true | undefined;
};

type ReportLike = Pick<Doc<"deviceApplyReports">, "config" | "state" | "refusal" | "layers">;

/** A PC in `groupId` that has no usable report of that group yet. */
export function waitingFields(groupId: Id<"groups">): SyncFields {
  return { groupId, configVersion: 0, state: undefined, adminTilesSkipped: undefined, reduced: undefined };
}

/**
 * What the sync row of a PC in `deviceGroupId` must say for its report: the report's facts when it names a configuration of that group,
 * else "waiting" (no report yet, an old agent, or a configuration of another group: the PC was just moved). Null for a PC without a group
 * (it has no row).
 */
export function syncFieldsOf(report: ReportLike | null, deviceGroupId: Id<"groups"> | undefined): SyncFields | null {
  if (deviceGroupId === undefined) return null;
  if (report === null || report.config === undefined || report.config.groupId !== deviceGroupId) return waitingFields(deviceGroupId);
  const { layers } = report;
  return {
    groupId: deviceGroupId,
    configVersion: report.config.version,
    state: report.state,
    adminTilesSkipped: ADMIN_TILES_CODES.has(layers.machine.detail ?? "") || ADMIN_TILES_CODES.has(report.refusal ?? "") ? true : undefined,
    reduced: layers.appLocker.state === "unsupported" || layers.appControl.state === "unsupported" ? true : undefined,
  };
}

/** The document of a new PC's row (`enrollment:enroll`, the test seed): waiting in its group. */
export function newWaitingRow(device: { _id: Id<"devices">; orgId: Id<"organizations"> }, groupId: Id<"groups">, now: number) {
  return { orgId: device.orgId, deviceId: device._id, ...waitingFields(groupId), updatedAt: now };
}

/**
 * Bring the PC's sync row to `fields` (null = no row). Writes ONLY when something differs: the same facts again read one row and write
 * nothing. Returns the number of documents written (0 or 1).
 */
export async function setSyncRow(
  ctx: { db: DatabaseWriter },
  device: { _id: Id<"devices">; orgId: Id<"organizations"> },
  fields: SyncFields | null,
  now: number,
): Promise<number> {
  const row = await ctx.db
    .query("deviceLockdownSync")
    .withIndex("by_device", (q) => q.eq("deviceId", device._id))
    .unique();
  if (fields === null) {
    if (row === null) return 0;
    await ctx.db.delete(row._id);
    return 1;
  }
  if (row === null) {
    await ctx.db.insert("deviceLockdownSync", { orgId: device.orgId, deviceId: device._id, ...fields, updatedAt: now });
    return 1;
  }
  if (
    row.groupId === fields.groupId &&
    row.configVersion === fields.configVersion &&
    row.state === fields.state &&
    row.adminTilesSkipped === fields.adminTilesSkipped &&
    row.reduced === fields.reduced
  ) {
    return 0;
  }
  await ctx.db.patch(row._id, { ...fields, updatedAt: now });
  return 1;
}
