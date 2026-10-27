/**
 * Enrollment screen (plan Step 6, Section 4.13): its sentences, loaded with the
 * screen's chunk (same rules as `lib/strings.ts`), so the sign-in page and the
 * shell do not download them.
 */
import type { EnrollmentCodeState } from "../../data/types";
import { formatNumber, plural } from "../../lib/format";

const n = (count: number, one: string, other: string) => `${formatNumber(count)} ${plural(count, { one, other })}`;

export const enrollText = {
  title: "Enrollment",
  lead: "One-time codes that add a PC to your organization.",
  create: "Create code",
  createTitle: "New enrollment code",

  group: "Group",
  groupHint: "New PCs join this group.",
  pickGroup: "Pick a group",
  groupsLoading: "Loading groups…",
  uses: "Number of PCs",
  usesHint: "How many PCs can use this code: 1 to 100.",
  expiry: "Valid for",
  expiryOptions: [
    { minutes: 15, label: "15 minutes" },
    { minutes: 60, label: "1 hour" },
    { minutes: 1440, label: "1 day" },
    { minutes: 10080, label: "7 days" },
  ],
  custom: "Custom…",
  customAmount: "Custom length",
  customUnit: "Unit",
  units: { minutes: "minutes", hours: "hours", days: "days" },
  ttlRange: "Pick between 15 minutes and 7 days.",
  label: "Label",
  labelHint: "Helps you recognise the code later. Never shown on the PC.",
  labelInvalid: "Use at most 64 characters without line breaks.",
  usage: (used: number, limit: number, plan: string) =>
    `${formatNumber(used)} of ${n(limit, "active code", "active codes")} in use on the ${plan} plan.`,
  created: "Code created.",

  // The one-time panel. The code exists only in the screen's memory (plan 4.7).
  codeTitle: "Your enrollment code",
  codeOnce: "This code is shown only now.",
  codeOnceDetail: "Copy it before you close this panel. If it gets lost, revoke it and create a new one.",
  codeLabel: "Enrollment code",
  codeCase: "Upper and lower case letters are different.",
  codeFor: (uses: number, group: string | undefined) =>
    group ? `For ${n(uses, "PC", "PCs")} in the group ${group}.` : `For ${n(uses, "PC", "PCs")}.`,
  codeExpires: (when: string) => `Expires ${when}.`,
  codeHowTo: "On the PC, run the Rulebox installer and paste this code when it asks for it.",
  codeHowToCli: "Without the installer: run rulebox-agent enroll followed by the code, as an administrator.",
  codeDone: "Done, hide the code",

  // List.
  listCaption: "Enrollment codes",
  colLabel: "Code",
  colGroup: "Group",
  colUses: "Uses",
  colExpires: "Expires",
  colState: "State",
  colCreatedBy: "Created by",
  states: {
    active: "Active",
    usedUp: "Used up",
    expired: "Expired",
    revoked: "Revoked",
  } satisfies Record<EnrollmentCodeState, string>,
  unlabeled: "Unlabeled code",
  groupGone: "Deleted group",
  used: (used: number, total: number) => `${formatNumber(used)} of ${formatNumber(total)} used`,
  revokeTitle: "Revoke this code?",
  revokeBody: "PCs can no longer enroll with it. PCs already enrolled are not affected.",
  revokeNamed: (name: string) => `Revoke ${name}`,
  revoked: "Code revoked.",
  emptyTitle: "No codes yet.",
  emptyBody: "Create one to add the first PC.",
  emptyBodyViewer: "An Admin or Owner can create one to add the first PC.",
  noGroups: "Create a group first: every code adds PCs to a group.",
  addGroup: "New group",

  // Refusals with a screen-specific sentence.
  groupGoneError: "This group no longer exists. Pick another one.",
  notReady: "This deployment's address can't be used by PCs, so codes can't be created here.",
};
