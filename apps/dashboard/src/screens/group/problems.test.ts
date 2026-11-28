import { describe, expect, it } from "vitest";
import type { AssignmentRow, GroupDetail } from "../../data/types";
import { attentionItems, groupChecklist, groupProblems, problemBadge, TRIAL_WARN_DAYS } from "./problems";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const app = (over: Partial<AssignmentRow> = {}): AssignmentRow => ({
  _id: "as1",
  appId: "a1",
  appName: "PDF Reader",
  appKind: "desktop",
  audience: "everyone",
  pinnedTaskbar: false,
  pinnedDesktop: true,
  ...over,
});

const group = (over: Partial<GroupDetail> = {}): GroupDetail => ({
  _id: "g1",
  name: "Front desk",
  revision: 1,
  assignments: [app()],
  deviceCount: 3,
  employeeCount: 5,
  ...over,
});

const ids = (g: GroupDetail, role: "owner" | "admin" | "viewer" = "admin") => groupProblems(g, role, NOW).map((p) => p.id);

describe("groupProblems (what needs attention on a group)", () => {
  it("a quiet group has nothing, and so does an older server without the new fields", () => {
    expect(ids(group())).toEqual([]);
    expect(ids(group({ rollout: null, lockdownAuditSince: null }))).toEqual([]);
  });

  it("a halted rollout is urgent and opens the rollout", () => {
    const [p] = groupProblems(group({ rollout: { enabled: true, state: "halted" } }), "admin", NOW);
    expect(p).toMatchObject({ id: "halted", tone: "danger", action: { kind: "link", to: "/groups/g1/rollout" } });
  });

  it("a trial run counts as a problem only after two weeks, and says how long", () => {
    expect(ids(group({ lockdownAuditSince: NOW - (TRIAL_WARN_DAYS - 1) * DAY }))).toEqual([]);
    expect(ids(group({ lockdownAuditSince: NOW - TRIAL_WARN_DAYS * DAY }))).toEqual([]);
    const [p] = groupProblems(group({ lockdownAuditSince: NOW - 20 * DAY - 1000 }), "admin", NOW);
    expect(p).toMatchObject({ id: "trial", tone: "warning", action: { kind: "link", to: "/groups/g1/lockdown" } });
    expect(p!.body).toContain("20 days");
  });

  it("an archived app is a warning with Unassign for admins, without it for a viewer; every archived app counts", () => {
    const g = group({ assignments: [app(), app({ _id: "as2", appId: "a2", appName: "Old scheduler", archived: true }), app({ _id: "as3", appId: "a3", appName: "Old POS", archived: true })] });
    expect(ids(g)).toEqual(["archived:as2", "archived:as3"]);
    const [first] = groupProblems(g, "admin", NOW);
    expect(first).toMatchObject({ tone: "warning", title: "Old scheduler is archived. PCs no longer get it.", action: { kind: "unassign" } });
    expect(groupProblems(g, "viewer", NOW)[0]!.action).toBeUndefined();
  });

  it("a rollout that is reaching the first PCs is a note, never when it is off or idle", () => {
    expect(groupProblems(group({ rollout: { enabled: true, state: "rolling" } }), "admin", NOW)[0]).toMatchObject({ id: "rolling", tone: "info" });
    expect(ids(group({ rollout: { enabled: false, state: "rolling" } }))).toEqual([]);
    expect(ids(group({ rollout: { enabled: true, state: "idle" } }))).toEqual([]);
  });

  it("the badge counts what needs a look, never the notes", () => {
    const all = groupProblems(
      group({ rollout: { enabled: true, state: "halted" }, lockdownAuditSince: NOW - 30 * DAY, assignments: [app({ archived: true })] }),
      "admin",
      NOW,
    );
    expect(problemBadge(all)).toEqual({ count: 3, danger: true });
    expect(problemBadge(groupProblems(group({ rollout: { enabled: true, state: "rolling" } }), "admin", NOW))).toEqual({ count: 0, danger: false });
  });
});

describe("groupChecklist", () => {
  it("counts the three steps and shows until all are done", () => {
    expect(groupChecklist(group({ assignments: [], deviceCount: 0, employeeCount: 0 }))).toEqual({ apps: false, people: false, pcs: false, done: 0, show: true });
    expect(groupChecklist(group({ deviceCount: 0 }))).toMatchObject({ apps: true, people: true, pcs: false, done: 2, show: true });
    expect(groupChecklist(group({ employeeCount: 0 }))).toMatchObject({ people: false, show: true });
    expect(groupChecklist(group())).toMatchObject({ done: 3, show: false });
  });
});

describe("attentionItems", () => {
  const problems = () =>
    groupProblems(group({ rollout: { enabled: true, state: "rolling" }, lockdownAuditSince: NOW - 30 * DAY, assignments: [app({ archived: true })] }), "admin", NOW);

  it("maps links to links and Unassign to a button that hands over the assignment", () => {
    const seen: AssignmentRow[] = [];
    const items = attentionItems(problems(), { checklist: false, onUnassign: (a) => seen.push(a) });
    expect(items.map((i) => i.key)).toEqual(["trial", "archived:as1", "rolling"]);
    expect(items[0]!.action).toEqual({ label: "Open protection", to: "/groups/g1/lockdown" });
    items[1]!.action!.onClick!();
    expect(seen.map((a) => a._id)).toEqual(["as1"]);
  });

  it("folds the notes away while the checklist shows", () => {
    expect(attentionItems(problems(), { checklist: true, onUnassign: () => undefined }).map((i) => i.key)).toEqual(["trial", "archived:as1"]);
  });
});
