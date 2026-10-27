/**
 * Groups list and detail (plan Step 5): the sentences added with the live
 * backend. A lazily loaded part of `lib/strings.ts`; the older group
 * sentences shared with other screens stay in `strings.groups` / `strings.group`.
 */
import { formatNumber, plural } from "../../lib/format";

const DEPENDENT_NAMES: Record<string, string> = {
  devices: "the PCs in it (move them to another group)",
  employees: "its employees (remove them from the group)",
  apps: "its apps (unassign them)",
  "enrollment codes": "its active enrollment codes (revoke them)",
};

export const groupText = {
  nameTaken: "Another group already has this name. Pick another one.",
  nameInvalid: "Use 1 to 64 characters without line breaks.",
  descriptionInvalid: "Use at most 300 characters.",
  usage: (used: number, limit: number, plan: string) =>
    `${formatNumber(used)} of ${formatNumber(limit)} ${plural(limit, { one: "group", other: "groups" })} used on the ${plan} plan.`,
  appsReadOnly: "Assigning apps to groups comes with the apps step.",
  /** `has_dependents` detail ("devices, employees, apps, enrollment codes") as a sentence. */
  hasDependents: (detail: string | undefined) => {
    const parts = (detail ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "")
      .map((x) => DEPENDENT_NAMES[x] ?? x);
    if (parts.length === 0) return "This group is still in use. Move or remove what uses it first.";
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    return `This group is still in use. Before deleting it, take care of ${list}.`;
  },
  deleteBody: "Only a group that nothing uses can be deleted. This can't be undone.",
};
