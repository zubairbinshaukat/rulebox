import { formatTime } from "../../lib/format";
import { LAYER_NAMES, type DeviceLiveness, type DevicePage, type LayerName, type Role } from "../../data/types";
import { REFUSALS, layerDetailText, protectionGaps } from "../lockdown/codes";
import {
  ADMIN_EXIT_ERROR,
  COMPAT_BLOCKER_FALLBACK,
  COMPAT_RULES,
  COMPAT_WARNING_FALLBACK,
  KIOSK_ERRORS,
  KIOSK_ERROR_FALLBACK,
  LAYER_GENERIC,
  LAYER_LABELS,
  LOCKDOWN_RULES,
  problemStrings as s,
  type FixKind,
  type Rule,
  type RuleSeverity,
} from "./problemStrings";

/**
 * "Needs attention" on the device page (UI pass 2026-11, `docs/plans/ui-pass/device-detail.md` section 5): everything that is
 * wrong with one PC, worked out from the page query and the liveness row, as plain words and ONE thing to do about each.
 * Pure: no React, no clock (`now` is passed in), no data hooks. The words are in `problemStrings.ts`.
 */

export type ProblemSeverity = RuleSeverity;
export type ProblemTab = "overview" | "apps" | "protection" | "network" | "activity" | "settings";

/** What a "run" action does; the screen runs it through the usual data hooks (kiosk on, unlock, end the USB window). */
export type ProblemRun = "kioskOn" | "unlock" | "endUsb";

export type ProblemAction =
  /** Open a tab of this page; `focus` names the control to focus there (the group picker, the Remove button). */
  | { kind: "tab"; tab: ProblemTab; label: string; focus?: "group" | "remove" }
  | { kind: "link"; to: string; label: string }
  | { kind: "run"; label: string; run: ProblemRun };

export interface Problem {
  id: string;
  severity: ProblemSeverity;
  title: string;
  body: string;
  action?: ProblemAction;
  /** For support, shown under "Technical details": raw codes and the like. Never in the title or body. */
  tech?: { label: string; value: string }[];
}

const SEVERITY_RANK: Record<ProblemSeverity, number> = { danger: 0, warning: 1, info: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;
/** Notes a lockdown layer can report while its state is `ok`, that still deserve a warning on the device page (`admin_tiles_skipped`, 2026-11-28). */
const OK_LAYER_WARNINGS: ReadonlySet<string> = new Set(["admin_tiles_skipped"]);

/** A PC that has been offline for longer than this is a problem (shorter is normal: it is switched off at night). */
export const OFFLINE_PROBLEM_AFTER_MS = DAY_MS;

/** The problems of one PC, most urgent first (danger, warning, info; inside a severity in the order of the plan's table). */
export function deviceProblems(p: DevicePage, live: DeviceLiveness | null, now: number, role: Role): Problem[] {
  const admin = role === "admin" || role === "owner";
  const owner = role === "owner";
  const report = p.report;
  const groupId = p.group?._id;
  const out: Problem[] = [];
  const add = (problem: Problem) => {
    // One problem per id: the first wins (the untrusted key and a compatibility blocker may both say the same thing).
    if (!out.some((x) => x.id === problem.id)) out.push(problem);
  };

  /** The button of a registry entry's `fix` for this role, or nothing (a viewer gets no admin-only link). */
  const fixAction = (fix: FixKind | undefined): ProblemAction | undefined => {
    switch (fix) {
      case "groupLockdown":
        return groupId === undefined ? undefined : { kind: "link", to: `/groups/${groupId}/lockdown`, label: s.openGroupLockdown };
      case "networks":
        return { kind: "link", to: "/networks", label: s.openNetworks };
      case "update":
        return owner ? { kind: "link", to: "/settings?tab=updates", label: s.openUpdates } : undefined;
      case "adminExit":
        return admin ? { kind: "link", to: "/settings?tab=adminExit", label: s.openAdminExit } : undefined;
      default:
        return undefined;
    }
  };
  /** Somebody else has to do it: say who. */
  const askOwner = (fix: FixKind | undefined) => (fix === "update" && !owner ? ` ${s.askOwner}` : "");
  const fromRule = (id: string, rule: Rule, severity: ProblemSeverity, bodyFallback: string, tech: Problem["tech"]): Problem => ({
    id,
    severity,
    title: rule.title,
    body: `${rule.body ?? bodyFallback}${askOwner(rule.fix)}`,
    action: fixAction(rule.fix),
    tech,
  });

  // ---- a disconnected PC: nothing else matters
  if (p.flags.revoked || p.revoked) {
    return [
      {
        id: "revoked",
        severity: "danger",
        title: s.revoked.title,
        body: s.revoked.body,
        action: admin ? { kind: "tab", tab: "settings", label: s.revoked.action, focus: "remove" } : undefined,
      },
    ];
  }

  if (p.lock !== null) {
    add({
      id: "locked",
      severity: "danger",
      title: s.locked.title,
      body: s.locked.body,
      action: admin ? { kind: "run", label: s.locked.action, run: "unlock" } : undefined,
    });
  }
  if (p.planState === "suspended") add({ id: "suspended", severity: "danger", title: s.suspended.title, body: s.suspended.body });

  // A PC that never reported and never called in (a failing liveness query says nothing: `live` is null then).
  if (report === null && live !== null && live.lastContactAt === null) {
    add({
      id: "neverSeen",
      severity: "info",
      title: s.neverSeen.title,
      body: s.neverSeen.body,
      action: admin ? { kind: "link", to: "/enrollment", label: s.neverSeen.action } : undefined,
    });
  }

  // ---- the kiosk
  const kioskError = report?.kioskError;
  const trustedKeys = report?.trustedKeyIds; // missing = an older agent that does not report them
  const noTrustedKey = trustedKeys !== undefined && trustedKeys.length === 0;
  if (kioskError === "desired_state_untrusted" || noTrustedKey) {
    const tech: { label: string; value: string }[] = [];
    if (kioskError === "desired_state_untrusted") tech.push({ label: s.techCode, value: kioskError });
    if (noTrustedKey) tech.push({ label: s.techKeys, value: s.untrusted.trustNone });
    tech.push({ label: s.techOnPc, value: s.untrusted.trustCommand });
    add({
      id: "untrusted",
      severity: "danger",
      title: s.untrusted.title,
      body: s.untrusted.body,
      action: admin ? { kind: "link", to: "/enrollment", label: s.untrusted.action } : undefined,
      tech,
    });
  }
  if (kioskError !== undefined && kioskError !== "" && kioskError !== "desired_state_untrusted") {
    const tech = [{ label: s.techCode, value: kioskError }];
    if (Object.hasOwn(COMPAT_RULES, kioskError)) {
      // A blocker the kiosk repeats: the same problem as the compatibility one.
      add(fromRule(`compat:${kioskError}`, COMPAT_RULES[kioskError]!, "danger", "", tech));
    } else {
      const rule = Object.hasOwn(KIOSK_ERRORS, kioskError)
        ? KIOSK_ERRORS[kioskError]!
        : kioskError.startsWith("admin_exit_") && kioskError.endsWith("_invalid")
          ? ADMIN_EXIT_ERROR
          : KIOSK_ERROR_FALLBACK;
      add(fromRule(`kioskError:${kioskError}`, rule, "danger", KIOSK_ERROR_FALLBACK.body!, tech));
    }
  } else if (report?.kioskPhase === "failed" && kioskError !== "desired_state_untrusted") {
    add({ id: "kioskFailed", severity: "danger", title: s.kioskFailed.title, body: s.kioskFailed.body });
  }

  // ---- lockdown
  const apply = p.apply;
  if (apply?.state === "refused") {
    const code = apply.refusal;
    const known = code !== null && Object.hasOwn(REFUSALS, code);
    const fix: FixKind | undefined =
      code === "managed_networks_empty"
        ? "networks"
        : code === "admin_signin_unverified" || code === "lockout_threshold_too_low" || (code?.startsWith("would_") ?? false)
          ? "groupLockdown"
          : code === "journal_unknown_target" || code === "section_unknown_value"
            ? "update"
            : undefined;
    add({
      id: "lockdownRefused",
      severity: "danger",
      title: s.lockdownRefused.title,
      body: `${known ? REFUSALS[code]! : s.lockdownRefused.fallbackBody}${askOwner(fix)}`,
      action: fixAction(fix),
      tech: code === null || code === "" ? undefined : [{ label: s.techCode, value: code }],
    });
  }
  if (apply?.state === "rolledBack") {
    add({
      id: "rolledBack",
      severity: "danger",
      title: s.rolledBack.title,
      body: s.rolledBack.body,
      action: fixAction("groupLockdown"),
      tech: apply.refusal === null || apply.refusal === "" ? undefined : [{ label: s.techCode, value: apply.refusal }],
    });
  }
  if (apply !== null) {
    // One problem per code, however many layers report it (and one per layer that failed without a code).
    const issues = new Map<string, { code: string | null; layers: LayerName[]; failed: boolean }>();
    for (const name of LAYER_NAMES) {
      const l = apply.layers[name];
      const code = l.detail !== undefined && l.detail !== "" ? l.detail : null;
      // A layer that is `ok` says nothing, except a warning the PC attaches to an applied layer (the hideAdminTiles slot).
      const okWarning = l.state === "ok" && code !== null && OK_LAYER_WARNINGS.has(code);
      if (l.state !== "failed" && l.state !== "partial" && !okWarning) continue;
      if (code === "restart_needed") continue; // the "Restart needed" problem says it
      const key = code ?? `none:${name}`;
      const issue = issues.get(key) ?? { code, layers: [], failed: false };
      issue.layers.push(name);
      issue.failed ||= l.state === "failed";
      issues.set(key, issue);
    }
    for (const [key, issue] of issues) {
      const { code } = issue;
      const rule = code !== null && Object.hasOwn(LOCKDOWN_RULES, code) ? LOCKDOWN_RULES[code]! : undefined;
      const severity: ProblemSeverity = rule?.severity ?? (issue.failed ? "danger" : "warning");
      const layers = issue.layers.map((n) => LAYER_LABELS[n]).join(", ");
      const tech = [...(code === null ? [] : [{ label: s.techCode, value: code }]), { label: s.techLayers, value: layers }];
      // The sentence of `lockdown/codes.ts`; a code it does not know ("Code: x") gets the generic sentence instead.
      const sentence = layerDetailText(code);
      const generic: Rule = { title: issue.failed ? LAYER_GENERIC.failedTitle : LAYER_GENERIC.partialTitle };
      const bodyFallback = sentence !== null && !sentence.startsWith("Code:") ? sentence : LAYER_GENERIC.unknownBody;
      add(fromRule(`layer:${key}`, rule ?? generic, severity, bodyFallback, tech));
    }
  }

  if (p.lockdownCapable === false) {
    add({ id: "tooOld", severity: "warning", title: s.tooOld.title, body: `${s.tooOld.body}${askOwner("update")}`, action: fixAction("update") });
  }

  // ---- the PC itself
  if (report?.shellHealth === "unhealthy" || report?.shellHealth === "failed") {
    const failed = report.shellHealth === "failed";
    add({
      id: "staffApp",
      severity: failed ? "danger" : "warning",
      title: failed ? s.staffAppFailed.title : s.staffAppUnhealthy.title,
      body: failed ? s.staffAppFailed.body : s.staffAppUnhealthy.body,
    });
  }
  if (!p.kioskEnabled) {
    add({
      id: "kioskOff",
      severity: "warning",
      title: s.kioskOff.title,
      body: s.kioskOff.body,
      action: admin ? { kind: "run", label: s.kioskOff.action, run: "kioskOn" } : undefined,
    });
  }
  if (p.flags.noGroup) {
    add({
      id: "noGroup",
      severity: "warning",
      title: s.noGroup.title,
      body: s.noGroup.body,
      action: admin ? { kind: "tab", tab: "settings", label: s.noGroup.action, focus: "group" } : undefined,
    });
  }
  if (p.planState === "overLimit") {
    add({
      id: "overLimit",
      severity: "warning",
      title: s.overLimit.title,
      body: s.overLimit.body,
      action: { kind: "link", to: "/devices", label: s.overLimit.action },
    });
  }

  // ---- installs, Wi-Fi and printers
  const failedApps = p.failedInstalls;
  if (failedApps.count > 0) {
    const name = failedApps.names[0];
    add({
      id: "failedInstalls",
      severity: "warning",
      title: failedApps.count === 1 ? (name === undefined ? s.failedInstalls.oneUnnamed : s.failedInstalls.one(name)) : s.failedInstalls.many(failedApps.count, failedApps.more),
      body: s.failedInstalls.body,
      action: { kind: "tab", tab: "apps", label: s.failedInstalls.action },
    });
  }
  const { wifiFailed, printersFailed } = p.network;
  if (wifiFailed > 0 || printersFailed > 0) {
    const t = s.network;
    add({
      id: "network",
      severity: "warning",
      title:
        wifiFailed > 0 && printersFailed > 0
          ? t.both
          : wifiFailed > 0
            ? wifiFailed === 1
              ? t.wifiOne
              : t.wifiMany(wifiFailed)
            : printersFailed === 1
              ? t.printerOne
              : t.printerMany(printersFailed),
      body: t.body,
      action: { kind: "tab", tab: "network", label: t.action },
    });
  }

  // ---- what the agent found when it checked the PC
  const compat = report?.compat;
  for (const code of compat?.blockers ?? []) {
    const rule = Object.hasOwn(COMPAT_RULES, code) ? COMPAT_RULES[code]! : COMPAT_BLOCKER_FALLBACK;
    add(fromRule(`compat:${code}`, rule, "danger", COMPAT_BLOCKER_FALLBACK.body!, [{ label: s.techCode, value: code }]));
  }
  for (const code of compat?.warnings ?? []) {
    const rule = Object.hasOwn(COMPAT_RULES, code) ? COMPAT_RULES[code]! : COMPAT_WARNING_FALLBACK;
    add(fromRule(`compat:${code}`, rule, rule.severity ?? "warning", COMPAT_WARNING_FALLBACK.body!, [{ label: s.techCode, value: code }]));
  }
  if (!p.presence.online && p.presence.since !== null && now - p.presence.since > OFFLINE_PROBLEM_AFTER_MS) {
    add({
      id: "offline",
      severity: "warning",
      title: s.offline.title(Math.floor((now - p.presence.since) / DAY_MS)),
      body: s.offline.body,
    });
  }
  if (p.outOfSupport) add({ id: "outOfSupport", severity: "warning", title: s.outOfSupport.title, body: s.outOfSupport.body });

  // ---- good to know
  const layerNeedsRestart = apply !== null && LAYER_NAMES.some((n) => apply.layers[n].state === "restartPending" || apply.layers[n].detail === "restart_needed");
  if (report?.restartPending === true || layerNeedsRestart) {
    add({ id: "restart", severity: "info", title: s.restart.title, body: s.restart.body });
  }
  if (p.usbAllowUntil !== null && p.usbAllowUntil > now) {
    add({
      id: "usbOpen",
      severity: "info",
      title: s.usbOpen.title(formatTime(p.usbAllowUntil)),
      body: s.usbOpen.body,
      action: admin ? { kind: "run", label: s.usbOpen.action, run: "endUsb" } : undefined,
    });
  }
  if (p.protection !== null) {
    const gaps = protectionGaps(p.protection);
    if (gaps.length > 0) {
      add({
        id: "physical",
        severity: "info",
        title: s.physical.title,
        body: s.physical.body(gaps.includes("secureBoot"), gaps.includes("bitLocker")),
        action: { kind: "tab", tab: "protection", label: s.physical.action },
      });
    }
  }

  // Stable sort: inside a severity the order above (the plan's table) stays.
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** What the Overview shows up front (danger and warning) and what sits in "Also good to know" (info). */
export function splitProblems(problems: Problem[]): { attention: Problem[]; goodToKnow: Problem[] } {
  return { attention: problems.filter((x) => x.severity !== "info"), goodToKnow: problems.filter((x) => x.severity === "info") };
}

/** The tab badge: the number of danger and warning problems and whether one of them is danger. */
export function problemBadge(problems: Problem[]): { count: number; danger: boolean } {
  const shown = problems.filter((x) => x.severity !== "info");
  return { count: shown.length, danger: shown.some((x) => x.severity === "danger") };
}
