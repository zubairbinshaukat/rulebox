import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { MAX_POLICY_KEYS_PER_STATUS } from "./limits";

// The organization's public signing keys (`policyKeys`, plan 4.5). Public
// data only: key ids, public keys and endorsements. Trust is per
// organization: a device is only ever told its own organization's keys.

const STATUSES = ["active", "next", "retired"] as const;

/** Every key row of the organization, oldest first (3 index reads, <= 20 rows each). */
export async function orgPolicyKeys(ctx: { db: DatabaseReader }, orgId: Id<"organizations">): Promise<Doc<"policyKeys">[]> {
  const rows: Doc<"policyKeys">[] = [];
  for (const status of STATUSES) {
    rows.push(
      ...(await ctx.db
        .query("policyKeys")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
        .take(MAX_POLICY_KEYS_PER_STATUS)),
    );
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt || (a._creationTime - b._creationTime));
}

export const publishedKey = v.object({
  keyId: v.string(),
  publicKey: v.string(),
  endorsement: v.union(v.object({ byKeyId: v.string(), signature: v.string() }), v.null()),
});

/** The key list of the agent's subscription (plan 5.1): every row, oldest first. */
export function publishedKeysOf(rows: Doc<"policyKeys">[]) {
  return rows.map((r) => ({
    keyId: r.keyId,
    publicKey: r.publicKey,
    endorsement: r.endorsement !== undefined ? { byKeyId: r.endorsement.byKeyId, signature: r.endorsement.signature } : null,
  }));
}

/** What `enroll` hands a new device to trust (plan 4.5): the active key and the next key when one exists. */
export function enrollmentKeysOf(rows: Doc<"policyKeys">[]): { keyId: string; publicKey: string }[] {
  return rows
    .filter((r) => r.status === "active" || r.status === "next")
    .map((r) => ({ keyId: r.keyId, publicKey: r.publicKey }));
}
