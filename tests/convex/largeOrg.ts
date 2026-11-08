// A large organization for the I/O probe (Phase 4 Step 18 item 9, A16): bulk rows inserted
// directly (no wrappers, no audit) into an organization that already exists. Outside convex/
// so the Convex bundler never pushes it.

import type { Id } from "../../convex/_generated/dataModel";
import { sha256HexSync } from "../../convex/lib/crypto";
import { DEFAULT_WEB_PERMISSIONS } from "../../convex/lib/validators";
import type { T } from "./identity";

export type LargeOrgSize = { devices: number; employees: number; apps: number; groups: number; audit: number };

/** The size the plan asks for (Step 18 item 9). */
export const LARGE: LargeOrgSize = { devices: 200, employees: 300, apps: 30, groups: 10, audit: 500 };

/**
 * Adds `size` rows of each kind to `orgId` and bumps its counters. Devices spread over the new
 * groups, each with credentials, summary, presence and liveness; every new app is assigned to
 * three groups; every employee is in one group. Names repeat across organizations on purpose
 * ("Group 0", "PC 0", "Employee 0"...) so a cross-tenant leak cannot hide behind different names.
 */
export async function seedLargeOrg(t: T, orgId: Id<"organizations">, size: LargeOrgSize = LARGE): Promise<{ groupIds: Id<"groups">[] }> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const groupIds: Id<"groups">[] = [];
    for (let g = 0; g < size.groups; g++) {
      groupIds.push(await ctx.db.insert("groups", { orgId, name: `Group ${g}`, revision: 0, createdAt: now }));
    }
    const tokenId = await ctx.db.insert("enrollmentTokens", {
      orgId,
      tokenHash: sha256HexSync(`large-${orgId}`),
      expiresAt: 0,
      usesLeft: 0,
      createdAt: now,
    });
    for (let i = 0; i < size.devices; i++) {
      const groupId = groupIds[i % groupIds.length];
      const deviceId = await ctx.db.insert("devices", { orgId, groupId, name: `PC ${i}`, enrolledAt: now - i, enrollmentTokenId: tokenId, revision: 0 });
      await ctx.db.insert("deviceCredentials", { deviceId, orgId, secretHash: sha256HexSync(`large-${orgId}-${i}`), state: "active" });
      await ctx.db.insert("deviceSummary", { deviceId, orgId, agentVersion: "0.4.0", windowsBuild: "26300.1", kioskPhase: "applied", outOfSupport: false, updatedAt: now });
      const online = i % 2 === 0;
      await ctx.db.insert("devicePresence", { deviceId, orgId, online, since: now });
      await ctx.db.insert("deviceLiveness", { deviceId, orgId, seenBucket: Math.floor(now / 60_000), online, offlineAfter: Math.floor(now / 60_000) + 10, pingIntervalMs: 60_000 });
    }
    for (let i = 0; i < size.employees; i++) {
      const employeeId = await ctx.db.insert("employees", {
        orgId,
        name: `Employee ${i}`,
        username: `employee.${i}`,
        searchText: `employee ${i} employee.${i}`,
        disabled: false,
        credentialRevision: 0,
        revision: 0,
        createdAt: now - i,
      });
      await ctx.db.insert("groupMembers", { orgId, groupId: groupIds[i % groupIds.length]!, employeeId });
    }
    for (let i = 0; i < size.apps; i++) {
      const appId = await ctx.db.insert("apps", {
        orgId,
        name: `App ${i}`,
        kind: "web",
        web: { url: `https://example.com/${i}`, allowedDomains: ["example.com"], permissions: DEFAULT_WEB_PERMISSIONS },
        archived: false,
        revision: 0,
        createdAt: now - i,
      });
      for (let k = 0; k < 3; k++) {
        await ctx.db.insert("appAssignments", { orgId, groupId: groupIds[(i + k) % groupIds.length]!, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true });
      }
    }
    for (let i = 0; i < size.audit; i++) {
      await ctx.db.insert("auditLog", {
        orgId,
        at: now - 10_000 + i,
        actorType: "member",
        actorLabel: "owner@acme.test",
        action: "group.renamed",
        summary: `Renamed group ${i}`,
        eventKey: `large:${orgId}:${i}`,
      });
    }
    const stats = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
    await ctx.db.patch(stats._id, {
      deviceCount: (stats.deviceCount ?? 0) + size.devices,
      employeeCount: (stats.employeeCount ?? 0) + size.employees,
      activeEmployeeCount: (stats.activeEmployeeCount ?? 0) + size.employees,
      appCount: (stats.appCount ?? 0) + size.apps,
      groupCount: (stats.groupCount ?? 0) + size.groups,
    });
    return { groupIds };
  });
}
