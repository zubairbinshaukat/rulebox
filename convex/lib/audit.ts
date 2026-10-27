import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { AUDIT_SUMMARY_MAX } from "./limits";

/** Every audit action (plan 4.11), exact strings: a typo is a type error. */
export const AUDIT_ACTIONS = [
  "org.settingsChanged",
  "org.exitPinSet",
  "org.exitPinCleared",
  // Plan, limits or ping interval changed by the operator (Step 5, A1).
  "org.planChanged",
  "member.invited",
  "member.inviteRevoked",
  "member.joined",
  "member.roleChanged",
  "member.disabled",
  "member.enabled",
  "member.resetCodeCreated",
  "member.passwordReset",
  "member.mfaEnabled",
  "member.mfaReset",
  "member.recoveryCodeUsed",
  // Step-up (plan 4.16). Written in the organization the person acted in.
  "member.actionPinSet",
  "member.actionPinChanged",
  "member.actionPinCleared",
  "member.actionPinLocked",
  "member.passkeyAdded",
  "member.passkeyRemoved",
  "member.passkeyCloneDetected",
  "member.stepUpReset",
  "group.created",
  "group.renamed",
  "group.updated", // description only (Step 5)
  "group.deleted",
  "device.enrolled",
  "device.renamed",
  "device.moved",
  "device.kioskEnabled",
  "device.kioskDisabled",
  "device.revoked",
  "device.removed",
  "device.credentialRotationRequested",
  "device.credentialRotated",
  "enrollment.codeCreated",
  "enrollment.codeRevoked",
  "employee.created",
  "employee.updated",
  "employee.passwordSet",
  "employee.disabled",
  "employee.enabled",
  "employee.deleted",
  "employee.groupsChanged",
  "employee.appsChanged",
  "employee.lockedOut",
  "app.created",
  "app.updated",
  "app.archived",
  "app.deleted",
  "app.assigned",
  "app.unassigned",
  "app.retryRequested",
  "fileHandler.set",
  "fileHandler.removed",
  "policy.keyRegistered",
  "policy.rotationPrepared",
  "policy.rotationFinished",
  "policy.publishFailed",
  "device.adminExitSuccess",
  "device.adminExitWrongPin",
  "device.adminExitLockedOut",
  "device.adminExitFailed",
  "device.employeeLockedOut",
  "device.auditDropped",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditActor = {
  type: "member" | "device" | "system";
  id?: string;
  label: string;
};

export type AuditEntry = {
  orgId: Id<"organizations">;
  actor: AuditActor;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  summary: string;
  eventKey?: string;
};

/**
 * Throw on a suspicious summary instead of withholding it. Tests switch it on
 * (`audit.test.ts`); production withholds the summary and keeps the row.
 */
export const auditPolicy = { strict: false };

const WITHHELD = "(summary withheld)";

/**
 * True when `text` looks like it carries a secret value: a PHC hash, a
 * "password/secret/token/code/pin: value" pair, or a long random-looking run
 * (hex, base32, base64) that no human name contains.
 */
export function looksSecret(text: string): boolean {
  if (/\$argon2|\$scrypt|\$2[aby]\$/i.test(text)) return true;
  if (/(password|passwd|secret|token|code|pin|key|seed)\s*[:=]\s*\S/i.test(text)) return true;
  if (/[0-9a-f]{32,}/i.test(text)) return true;
  // A run of 20+ code-like characters with at least one digit and no space.
  for (const run of text.match(/[A-Za-z0-9+/=_-]{20,}/g) ?? []) {
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) return true;
  }
  return false;
}

function clean(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  let oneLine = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    oneLine += c < 0x20 || c === 0x7f ? " " : ch;
  }
  oneLine = oneLine.trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * The only writer of `auditLog` (plan 4.11). Append-only. Callers write fixed
 * texts with names, never values; a summary that looks like it carries a
 * secret throws under `auditPolicy.strict` and is withheld otherwise.
 */
export async function writeAudit(ctx: Pick<MutationCtx, "db">, e: AuditEntry): Promise<Id<"auditLog">> {
  let summary = clean(e.summary, AUDIT_SUMMARY_MAX) ?? "";
  if (looksSecret(e.summary) || (e.targetLabel !== undefined && looksSecret(e.targetLabel))) {
    if (auditPolicy.strict) {
      throw new Error("writeAudit: summary or target label looks like it carries a secret");
    }
    console.warn("writeAudit: summary withheld");
    summary = WITHHELD;
  }
  const targetLabel =
    e.targetLabel !== undefined && looksSecret(e.targetLabel) ? undefined : clean(e.targetLabel, 120);
  return await ctx.db.insert("auditLog", {
    orgId: e.orgId,
    at: Date.now(),
    actorType: e.actor.type,
    actorId: e.actor.id,
    actorLabel: clean(e.actor.label, 120) ?? "",
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    targetLabel,
    summary,
    eventKey: e.eventKey,
  });
}

export const SYSTEM_ACTOR: AuditActor = { type: "system", label: "Rulebox" };
