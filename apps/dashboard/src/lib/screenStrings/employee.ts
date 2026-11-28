import { n } from "../strings";

/** The first word of a name ("Maria Fernanda" -> "Maria"); a blank name reads as "This person". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "This person";
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function nameList(names: string[], more: (k: number) => string, max = 3): string {
  if (names.length <= max) {
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(", ")} and ${more(names.length - max)}`;
}

export const employeeStrings = {
  back: "All employees",
  newTitle: "Add employee",
  profile: "Profile",
  name: "Full name",
  /** The sign-in name: "Signs in as maria.fernanda" with a Change link. */
  username: "Signs in as",
  usernameInfo: "The name this person types on the PC. Letters, digits, dots, dashes and underscores.",
  usernameWait: "Appears when you type a name",
  change: "Change",
  usernameDone: "Done",
  create: "Create employee",
  groups: "Groups",
  groupsHint: "Can sign in on the PCs of these groups.",
  groupsEmpty: "No groups chosen yet",
  groupsAdd: "Add a group",
  groupsSearch: "Search groups",
  groupsNoMatch: "No group with that name",
  groupsNone: "No groups yet. Create a group first.",
  groupsCreate: "Create a group",
  apps: "Extra apps",
  appsInfo: "Apps for this person only, on top of their groups' apps. Windows apps only appear on PCs whose group has them.",
  appsAdd: "Give extra apps",
  appsEmpty: "No extra apps",
  appsPick: "Add an app",
  appsSearch: "Search apps",
  appsNoMatch: "No app with that name",
  desktopNote: "Only on PCs whose group has it",
  quota: "Storage",
  quotaInfo: "How much space this person gets for their files on a PC. Most people never need to change this.",
  quotaDefault: (gb: number) => (gb === 0 ? "Organization default (unlimited)" : `Organization default (${gb} GB)`),
  quotaUnlimited: "Unlimited",
  quotaCustom: "Custom",
  quotaAmount: "Gigabytes",
  quotaNow: (mode: "default" | "unlimited" | "custom", gb: number, custom: string) =>
    mode === "unlimited"
      ? "Storage: unlimited"
      : mode === "custom"
        ? `Storage: ${custom.trim() || "?"} GB`
        : gb === 0
          ? "Storage: organization default, unlimited"
          : `Storage: organization default, ${gb} GB`,
  advanced: "Advanced",
  quotaRequired: "Enter a whole number from 1 to 2000.",
  password: "Password",
  passwordInfo: "A password only you and this person know. It is stored scrambled, so nobody can read it back, including you.",
  generate: "Generate another",
  typeOwn: "Type my own",
  useGenerated: "Use a generated password",
  copy: "Copy",
  copied: "Copied",
  copyManual: "Select it and press Ctrl+C",
  passwordGeneratedHint: "Give it to them after you add them. It is shown once.",
  createdTitle: (name: string) => `${firstName(name)} is added`,
  handoverBody: "Give them this password. It is not shown again.",
  handoverSignIn: "They sign in with the name",
  handoverDone: "Done",
  summary: "Summary",
  summaryEmpty: "Type a name to see the summary.",
  summaryGroups: (name: string, groups: string[], moreGroups: (k: number) => string) =>
    groups.length === 0
      ? `${firstName(name)} is not in a group yet and can't sign in on any PC.`
      : `${firstName(name)} can sign in on the PCs of ${nameList(groups, moreGroups)} and gets their apps.`,
  summaryExtra: (k: number) => `Plus ${n(k, "extra app", "extra apps")} just for them.`,
  summaryMore: (k: number) => `${k} more ${k === 1 ? "group" : "groups"}`,
  summaryPassword: "You will see their password once, after you add them.",
  summaryPasswordTyped: "You chose their password.",
  passwordSetPrefix: "Set",
  passwordNotSet: "No password yet",
  passwordNotSetBody: "They can't sign in until you set one.",
  newPassword: "New password",
  setPassword: "Set password",
  setPasswordTitle: "New password",
  setPasswordBody: "The old password stops working on every PC, also offline.",
  setPasswordCopyFirst: "Copy it before you save. It is not shown again.",
  savePassword: "Save password",
  passwordSaved: "Password saved.",
  lockedTitle: "Locked out",
  lockedDetail: (failures: number, until: string) =>
    `${n(failures, "wrong password", "wrong passwords")}. Locked until ${until}.`,
  unlock: "Unlock",
  unlocked: "Unlocked. The employee can try again.",
  status: "Account",
  disabledHelp: "A disabled employee can't sign in anywhere.",
  activeLine: "Can sign in on their PCs.",
  disabledLine: "Turn it back on to let them sign in.",
  accountOn: "Account is active",
  accountOff: "Account is disabled",
  disableInfo: "They are signed out of every PC at their next check-in and can't sign in again until you enable the account. Their files stay on the PCs.",
  disable: "Disable",
  enable: "Enable",
  disableTitle: "Disable this employee?",
  disableBody: "They are signed out of every PC at their next check-in and can't sign in again until enabled.",
  deleteRow: "Delete employee",
  deleteLine: "Removes the account for good.",
  deleteInfo: "Their account, password and group memberships are deleted. Files already on the PCs stay where they are; the audit log keeps the name.",
  deleteTitle: "Delete this employee?",
  deleteBody:
    "Their account, password and memberships are deleted. Files already on the PCs stay where they are; the audit log keeps the name.",
  deleteNeedsDisable: "Disable the account first.",
  created: (name: string) => `${name} added.`,
  deleted: (name: string) => `${name} deleted.`,
  saved: "Employee saved.",
  history: "History",
} as const;
