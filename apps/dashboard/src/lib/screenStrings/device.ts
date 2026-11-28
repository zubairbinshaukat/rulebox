/**
 * Strings that the device page's Settings, Protection stubs, the rename dialog and the history panel still use. The page shell, the
 * Overview, the Apps and Activity tabs have their own words in `screens/device/strings.ts` and `problemStrings.ts` (UI pass 2026-11);
 * the Settings and Protection builders move what is left here into `settingsStrings.ts` and `deviceStrings.ts`.
 */
export const deviceStrings = {
  identity: "Identity",
  group: "Group",
  enrolled: "Enrolled",
  kiosk: "Kiosk mode",
  kioskHelp: "When off, the PC runs a normal Windows desktop for maintenance.",
  kioskOn: "Kiosk on",
  kioskOffLabel: "Kiosk off",
  move: "Move",
  // Protection tab: the "Reduced protection" notice that used to live in the compatibility card.
  reducedTitle: "Reduced protection",
  reducedDetail: (missing: string[]) =>
    `${missing.join(" and ")} cannot be used on this PC. It can still be enrolled; the other lockdown layers apply.`,
  layerAppLocker: "AppLocker rules (Windows edition)",
  layerAppControl: "App Control policies (Windows build)",
  renameTitle: "Rename device",
  renameLabel: "Device name",
  rotate: "Rotate credential",
  rotateTitle: "Rotate this PC's credential?",
  rotateBody: "The PC gets a new secret the next time it checks in. Nothing changes for employees.",
  rotateRequested: "Rotation requested. The PC picks it up at its next check-in.",
  rotatePending: "Credential rotation requested; waiting for the PC.",
  revoke: "Revoke",
  revokeTitle: "Revoke this PC?",
  revokeBody:
    "The PC stops receiving changes and can no longer talk to Rulebox. It keeps its current settings until it is re-enrolled or reset.",
  removeTitle: "Remove this PC from Rulebox?",
  removeBody: "Its reports, install results and policy history are deleted. The audit log keeps the record.",
  removed: (name: string) => `${name} was removed.`,
  dangerZone: "Danger zone",
  history: "History",
} as const;
