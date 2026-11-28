import type { AttentionItem } from "../../components/AttentionList";
import type { AssignmentRow, GroupDetail, Role } from "../../data/types";
import { groupPage as t } from "./strings";

/** Program blocking that stays a trial run this long (days) gets a warning: nobody turned it on. */
export const TRIAL_WARN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type GroupProblemAction =
  | { kind: "link"; label: string; to: string }
  /** Opens the "Unassign this app?" question of the group page. */
  | { kind: "unassign"; label: string; assignment: AssignmentRow };

export interface GroupProblem {
  id: string;
  tone: "danger" | "warning" | "info";
  title: string;
  body?: string;
  action?: GroupProblemAction;
}

/**
 * What needs attention on a group (other-pages plan 1.2), most urgent first. Pure: it reads only what `groups:get` returned. An
 * older server (`rollout` / `lockdownAuditSince` absent) has no rollout and trial warnings. A viewer sees the same cards, without
 * the button that changes something (Unassign); the links are for everyone.
 */
export function groupProblems(g: GroupDetail, role: Role, now: number): GroupProblem[] {
  const out: GroupProblem[] = [];
  const canChange = role !== "viewer";

  if (g.rollout?.state === "halted") {
    out.push({
      id: "halted",
      tone: "danger",
      title: t.problem.haltedTitle,
      body: t.problem.haltedBody,
      action: { kind: "link", label: t.problem.openRollout, to: `/groups/${g._id}/rollout` },
    });
  }

  const since = g.lockdownAuditSince;
  if (typeof since === "number" && now - since > TRIAL_WARN_DAYS * DAY_MS) {
    out.push({
      id: "trial",
      tone: "warning",
      title: t.problem.trialTitle,
      body: t.problem.trialBody(Math.floor((now - since) / DAY_MS)),
      action: { kind: "link", label: t.problem.openProtection, to: `/groups/${g._id}/lockdown` },
    });
  }

  for (const a of g.assignments) {
    if (!a.archived) continue;
    out.push({
      id: `archived:${a._id}`,
      tone: "warning",
      title: t.problem.archivedTitle(a.appName),
      body: t.problem.archivedBody,
      action: canChange ? { kind: "unassign", label: t.problem.unassign, assignment: a } : undefined,
    });
  }

  if (g.rollout?.enabled === true && g.rollout.state === "rolling") {
    out.push({
      id: "rolling",
      tone: "info",
      title: t.problem.rollingTitle,
      body: t.problem.rollingBody,
      action: { kind: "link", label: t.problem.openRollout, to: `/groups/${g._id}/rollout` },
    });
  }
  return out;
}

/** The number on the Overview tab: what needs a look (danger and warning), never the notes. */
export function problemBadge(problems: readonly GroupProblem[]): { count: number; danger: boolean } {
  const urgent = problems.filter((p) => p.tone !== "info");
  return { count: urgent.length, danger: urgent.some((p) => p.tone === "danger") };
}

export interface Checklist {
  apps: boolean;
  people: boolean;
  pcs: boolean;
  /** How many of the three steps are done. */
  done: number;
  /** Anything of the three is still missing: the "Get this group ready" card shows. */
  show: boolean;
}

/** The "Get this group ready" steps: an app assigned, a person added, a PC in the group. */
export function groupChecklist(g: Pick<GroupDetail, "assignments" | "deviceCount" | "employeeCount">): Checklist {
  const apps = g.assignments.length > 0;
  const pcs = g.deviceCount > 0;
  const people = g.employeeCount > 0;
  const done = [apps, people, pcs].filter(Boolean).length;
  return { apps, people, pcs, done, show: done < 3 };
}

/**
 * The cards of the `AttentionList`. While the checklist shows, the notes (info) fold away: the checklist is the one thing to read.
 * `onUnassign` opens the group page's question; a link goes where the problem is.
 */
export function attentionItems(problems: readonly GroupProblem[], opts: { checklist: boolean; onUnassign: (a: AssignmentRow) => void }): AttentionItem[] {
  return problems
    .filter((p) => !(opts.checklist && p.tone === "info"))
    .map((p): AttentionItem => {
      const a = p.action;
      return {
        key: p.id,
        tone: p.tone,
        title: p.title,
        body: p.body,
        action:
          a === undefined
            ? undefined
            : a.kind === "link"
              ? { label: a.label, to: a.to }
              : { label: a.label, onClick: () => opts.onUnassign(a.assignment) },
      };
    });
}
