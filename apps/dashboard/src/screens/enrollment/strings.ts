/**
 * "Add a PC" (route `/enrollment`; plan Step 6, UI pass `enrollment-networks.md` section 7): its sentences, loaded with the screen's
 * chunk (same rules as `lib/strings.ts`), so the sign-in page and the shell do not download them. Plain words; the long explanations
 * live in (i) tips, never more than three short sentences.
 */
import type { EnrollmentCodeState } from "../../data/types";
import { formatNumber, plural } from "../../lib/format";

const n = (count: number, one: string, other: string) => `${formatNumber(count)} ${plural(count, { one, other })}`;

export const enrollText = {
  title: "Add a PC",
  lead: "Three steps. The new PC shows up here by itself.",

  // The stepper.
  stepsLabel: "Steps to add a PC",
  steps: { create: "Create a code", install: "Install on the PC", done: "Done" },
  stepState: { done: "done", current: "current step", todo: "not yet" },
  stepSummary: (group: string | undefined, uses: number) => (group ? `${group} · ${n(uses, "PC", "PCs")}` : n(uses, "PC", "PCs")),

  // Step 1.
  createHeading: "Create a code",
  group: "Joins the group",
  groupInfo: "Settings, apps and Wi-Fi of this group reach the PC as soon as it joins.",
  pickGroup: "Pick a group",
  groupSearch: "Find a group",
  groupEmpty: "No group matches.",
  uses: "How many PCs?",
  usesInfo: "One code can set up several PCs. It stops working after that many.",
  fewer: "Fewer PCs",
  more: "More PCs",
  summary: (uses: number, ttl: string) => `One code for ${n(uses, "PC", "PCs")}. It works for ${ttl}.`,
  advanced: "More options",
  expiry: "Code works for",
  expiryOptions: [
    { minutes: 15, label: "15 minutes" },
    { minutes: 60, label: "1 hour" },
    { minutes: 1440, label: "1 day" },
    { minutes: 10080, label: "7 days" },
  ],
  label: "Name of the code",
  labelInfo: "Only for you, in the list of codes.",
  labelInvalid: "Use at most 64 characters without line breaks.",
  ttlRange: "Pick between 15 minutes and 7 days.",
  create: "Create code",
  creating: "Creating…",
  usage: (used: number, limit: number, plan: string) =>
    `${formatNumber(used)} of ${n(limit, "active code", "active codes")} in use on the ${plan} plan.`,
  planFull: "Your plan is full: a new PC can't join. Remove a PC or upgrade.",
  seeCodes: "See your codes",
  firstGroup: "Your PCs need a group first.",
  firstGroupInfo: "A group is a set of PCs that get the same apps and settings. You can add more later.",
  firstGroupName: "Group name",
  firstGroupDefault: "My PCs",
  firstGroupCreate: "Create group",
  groupGoneError: "This group no longer exists. Pick another one.",
  notReady: "This deployment's address can't be used by PCs, so codes can't be created here.",

  // Step 2: the code, shown once. It exists only in the screen's memory (plan 4.7).
  installHeading: "Install Rulebox on the PC",
  codeTitle: "Your code",
  codeLabel: "Enrollment code",
  codeOnceInfo: "Shown only now. Copy it before you leave this page. If it gets lost, revoke it and make a new one.",
  codeCaseInfo: "Upper and lower case letters are different.",
  copy: "Copy code",
  copied: "Copied",
  copyManual: "Select the code and press Ctrl+C to copy.",
  download: "Download Rulebox",
  copyLink: "Copy download link",
  linkCopied: "Link copied",
  qr: "QR code",
  worksFor: (uses: number, when: string) => `Works for ${n(uses, "PC", "PCs")} until ${when}.`,
  how: ["On the new PC, open this page or the download link.", "Run the installer.", "Paste the code when Rulebox Setup asks."],
  needsLabel: "What the PC needs",
  needsInfo: "Windows 10 22H2 or 11, 64-bit, an administrator account and internet. Setup checks the rest.",
  silentTitle: "Install without clicks (for IT)",
  silentMsi: "Installer command",
  silentCli: "Already installed? Enroll from a Command Prompt",
  silentWarn: "Don't add /l*v: the log would contain the code. Use Command Prompt; PowerShell keeps a history.",
  waiting: "Waiting for the PC…",
  waitingSub: "This page updates by itself.",
  hiddenNow: "The code is hidden now. If the PC still needs it, create a new code.",
  expired: "This code expired.",
  revokedNow: "This code was revoked.",
  newCode: "Create a new code",
  gone: "This code isn't available.",
  watching: "Watching a code",

  // Step 3: the PCs that joined.
  joinedHeading: (count: number, ready: boolean) =>
    ready ? (count === 1 ? "Your PC is ready" : "Your PCs are ready") : count === 1 ? "Your PC is joining" : "Your PCs are joining",
  joinedOf: (joined: number, total: number) => `${formatNumber(joined)} of ${n(total, "PC", "PCs")} joined`,
  allJoined: "All PCs joined.",
  morePcs: (count: number) => `and ${formatNumber(count)} more on the Devices page`,
  joinedAgo: "Joined",
  notOnlineYet: "Not online yet",
  stages: { joined: "Joined", online: "Online", settingUp: "Setting up", ready: "Ready", needsAttention: "Needs attention" },
  stagesLabel: (pc: string, stage: string) => `${pc}: ${stage}`,
  openPc: "Open PC",
  another: "Add another PC",
  done: "Done",
  stillWorks: (left: number) => `The same code still works for ${n(left, "more PC", "more PCs")}.`,

  // The wizard when it is closed.
  idleTitle: "Ready for the next PC?",
  idleBody: "Make a one-time code and the PC joins your organization.",
  idleAction: "Add a PC",
  viewerIdle: "An Admin or Owner can add PCs.",

  // The QR dialog of "Add a PC" (`QrDialog.tsx`).
  qrTitle: "Scan the code",
  qrLabel: "QR code of the enrollment code",
  qrHint: "Point a phone or tablet camera at it to copy the code across. It holds the code and nothing else.",
  qrFailed: "Couldn't make the QR code. Copy the code instead.",

  // The list of codes (the side column).
  aside: "Your codes",
  listCaption: "Enrollment codes",
  colLabel: "Code",
  colGroup: "Group",
  colUses: "Uses",
  colExpires: "Expires",
  colCreated: "Created",
  colState: "State",
  states: {
    active: "Active",
    usedUp: "Used up",
    expired: "Expired",
    revoked: "Revoked",
  } satisfies Record<EnrollmentCodeState, string>,
  unlabeled: "Unlabeled code",
  groupGone: "Deleted group",
  used: (used: number, total: number) => `${formatNumber(used)} of ${formatNumber(total)} used`,
  seeProgress: "See progress",
  seeProgressNamed: (name: string) => `See progress of ${name}`,
  revokeTitle: "Revoke this code?",
  revokeBody: "PCs can no longer enroll with it. PCs already enrolled are not affected.",
  revokeNamed: (name: string) => `Revoke ${name}`,
  revoked: "Code revoked.",
  emptyTitle: "No codes yet.",
};
