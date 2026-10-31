import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import { ROSTER_SNAPSHOT_EVERY } from "./limits";
import { signWith, type SigningKey } from "./signing";

// The signed per-group roster log (plan 4.2.1 / 4.4 amended, A6; Step 8 item
// 11). Who may sign in on a device is NOT in the device document any more:
// each group has an append-only log of signed entries ("employee E may sign
// in with credential revision R" / "E was removed") with a gap-free epoch, and
// a signed snapshot every ROSTER_SNAPSHOT_EVERY entries. Entries older than
// the newest snapshot are pruned. A device fetches the delta since its epoch
// (`devices:fetchRoster`), or the snapshot when it is too far behind.
//
// Until Step 11 nothing appends (every group's roster is empty, epoch 0).
//
// Signed messages (UTF-8, verified byte for byte by the agent, Step 9):
//   entry:    "rulebox.roster/1\n<keyId>\n<orgId>\n<groupId>\n<epoch>\n<employeeId>\n<rev|removed>"
//             (keyId = the signing key's id, so an entry names the key it
//             was signed with, like a document's payload; 2026-11-01)
//   snapshot: the JSON payload of `buildSnapshotPayload` (format
//             "rulebox.roster-snapshot/1"), signed like a desired document.

export const ROSTER_ENTRY_FORMAT = "rulebox.roster/1";
export const ROSTER_SNAPSHOT_FORMAT = "rulebox.roster-snapshot/1";

export type RosterChange = { employeeId: string; credentialRevision: number | null };

/** The exact message of one entry. `credentialRevision` null = removed. `keyId` = the signing key's id. */
export function rosterEntryMessage(e: {
  keyId: string;
  orgId: string;
  groupId: string;
  epoch: number;
  employeeId: string;
  credentialRevision: number | null;
}): string {
  const rev = e.credentialRevision === null ? "removed" : String(e.credentialRevision);
  return `${ROSTER_ENTRY_FORMAT}\n${e.keyId}\n${e.orgId}\n${e.groupId}\n${e.epoch}\n${e.employeeId}\n${rev}`;
}

/** Signature (standard base64) of one entry with the organization's key; the message names `key.keyId`. */
export function signRosterEntry(
  e: { orgId: string; groupId: string; epoch: number; employeeId: string; credentialRevision: number | null },
  key: SigningKey,
): string {
  return signWith(key, rosterEntryMessage({ ...e, keyId: key.keyId }));
}

/**
 * The members after applying `entries` (ascending epochs) to `base`: an entry
 * with a revision adds or updates, a removal deletes. Sorted by employee id.
 * Pure.
 */
export function buildRosterSnapshot(base: [string, number][], entries: RosterChange[]): [string, number][] {
  const members = new Map(base);
  for (const e of entries) {
    if (e.credentialRevision === null) members.delete(e.employeeId);
    else members.set(e.employeeId, e.credentialRevision);
  }
  return [...members.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * The signed snapshot payload. `members` is an array of `[employeeId,
 * credentialRevision]` pairs sorted by id (an array, not an object: JS orders
 * integer-like object keys first, which would make the bytes depend on the
 * ids).
 */
export function buildSnapshotPayload(p: {
  keyId: string;
  orgId: string;
  groupId: string;
  epoch: number;
  members: [string, number][];
}): string {
  return JSON.stringify({
    format: ROSTER_SNAPSHOT_FORMAT,
    keyId: p.keyId,
    orgId: p.orgId,
    groupId: p.groupId,
    epoch: p.epoch,
    members: p.members.map(([id, rev]) => [id, rev]),
  });
}

/** The members inside a snapshot payload this server wrote (no signature check: our own row). */
export function snapshotMembers(payload: string): [string, number][] {
  const parsed = JSON.parse(payload) as { members?: unknown };
  if (!Array.isArray(parsed.members)) return [];
  const out: [string, number][] = [];
  for (const m of parsed.members) {
    if (Array.isArray(m) && typeof m[0] === "string" && typeof m[1] === "number") out.push([m[0], m[1]]);
  }
  return out;
}

/**
 * Append signed entries to a group's roster (Step 11 is the first caller).
 * Bumps `groupRoster.epoch` once per entry; when the log reached
 * ROSTER_SNAPSHOT_EVERY entries past the last snapshot, writes a signed
 * snapshot at the new epoch and prunes the entries it covers. Devices of the
 * group see the new epoch through `devices:headState` (it reads
 * `groupRoster`): no document is re-signed and no head is written.
 */
export async function appendRosterEntries(
  ctx: { db: DatabaseWriter },
  key: SigningKey,
  orgId: Id<"organizations">,
  groupId: Id<"groups">,
  changes: RosterChange[],
  now: number,
): Promise<Doc<"groupRoster">> {
  let roster = await ctx.db
    .query("groupRoster")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .unique();
  if (roster === null) {
    const id = await ctx.db.insert("groupRoster", { orgId, groupId, epoch: 0, snapshotEpoch: 0 });
    roster = (await ctx.db.get(id))!;
  }
  let epoch = roster.epoch;
  for (const c of changes) {
    epoch++;
    const entry = { orgId, groupId, epoch, employeeId: c.employeeId, credentialRevision: c.credentialRevision };
    await ctx.db.insert("rosterEntries", {
      orgId,
      groupId,
      epoch,
      employeeId: c.employeeId,
      credentialRevision: c.credentialRevision ?? undefined,
      keyId: key.keyId,
      signature: signRosterEntry(entry, key),
    });
  }
  const patch: Partial<Doc<"groupRoster">> = { epoch };
  if (epoch - roster.snapshotEpoch >= ROSTER_SNAPSHOT_EVERY) {
    const base =
      roster.snapshotId !== undefined ? snapshotMembers((await ctx.db.get(roster.snapshotId))?.payload ?? "{}") : [];
    const since = await ctx.db
      .query("rosterEntries")
      .withIndex("by_group_epoch", (q) => q.eq("groupId", groupId).gt("epoch", roster.snapshotEpoch))
      .take(epoch - roster.snapshotEpoch + 1);
    const members = buildRosterSnapshot(
      base,
      since.map((e) => ({ employeeId: e.employeeId, credentialRevision: e.credentialRevision ?? null })),
    );
    const payload = buildSnapshotPayload({ keyId: key.keyId, orgId, groupId, epoch, members });
    const snapshotId = await ctx.db.insert("rosterSnapshots", {
      orgId,
      groupId,
      epoch,
      payload,
      signature: signWith(key, payload),
      keyId: key.keyId,
      createdAt: now,
    });
    if (roster.snapshotId !== undefined) await ctx.db.delete(roster.snapshotId);
    for (const e of since) await ctx.db.delete(e._id);
    patch.snapshotEpoch = epoch;
    patch.snapshotId = snapshotId;
  }
  await ctx.db.patch(roster._id, patch);
  return { ...roster, ...patch };
}
