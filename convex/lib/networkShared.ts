import type { Doc, Id } from "../_generated/dataModel";
import { snapshotGroupConfig } from "./groupConfig";

// Helpers shared by the Networks screen's functions (`networks.ts`) and the drivers (`drivers.ts`, Phase 5 Step 14b).

export type GroupReader = { db: { get(id: Id<"groups">): Promise<Doc<"groups"> | null> } };
export type GroupRef = { _id: Id<"groups">; name: string };

/** The first `cap` groups of a profile that still exist (a deleted group is skipped), names from a per-query cache. */
export async function groupsOf(ctx: GroupReader, ids: Id<"groups">[], cap: number, cache: Map<string, GroupRef | null>): Promise<GroupRef[]> {
  const out: GroupRef[] = [];
  for (const id of ids.slice(0, cap)) {
    let hit = cache.get(id);
    if (hit === undefined) {
      const g = await ctx.db.get(id);
      hit = g === null ? null : { _id: g._id, name: g.name };
      cache.set(id, hit);
    }
    if (hit !== null) out.push(hit);
  }
  return out;
}

export function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return true;
  }
  return false;
}

export const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Snapshot the configuration of every still existing group in `ids` (cap MAX_NETWORK_SNAPSHOT_GROUPS is the caller's check). */
export async function snapshotGroups(
  ctx: Parameters<typeof snapshotGroupConfig>[0] & GroupReader,
  ids: Iterable<Id<"groups">>,
  reason: string,
  by: Id<"members">,
): Promise<void> {
  for (const id of ids) {
    if ((await ctx.db.get(id)) === null) continue;
    await snapshotGroupConfig(ctx, id, reason, by);
  }
}