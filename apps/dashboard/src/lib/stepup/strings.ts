/**
 * The step-up sentences (plan 4.16): the confirm dialog, the lock screen, the
 * first-factor setup and Settings → Security. A lazily loaded part of
 * `lib/strings.ts` (same rules: short, plain, interpolation by functions), so
 * the sign-in page does not download them.
 *
 * "Action PIN" is the member's dashboard PIN. It is never called "exit PIN"
 * (the PCs' admin exit) and the two are never accepted for each other.
 */
import { formatDuration, formatNumber, plural } from "../format";
import { secShell } from "./strings-shell";

export const sec = {
  ...secShell,
  tab: "Security",

  // ---- confirm dialog (step_up_required / step_up_setup_required)
  confirmTitle: "Confirm it's you",
  confirmLead: "This change needs your action PIN or a passkey.",
  confirmLeadFresh: "Important changes need a confirmation from the last 5 minutes.",
  confirm: "Confirm",
  confirming: "Checking…",
  usePasskey: "Use a passkey",
  usingPasskey: "Waiting for your passkey…",
  orPin: "or enter your action PIN",
  pin: "Action PIN",
  pinHint: "6 to 12 digits. Not the exit PIN of the PCs.",
  showPin: "Show PIN",
  hidePin: "Hide PIN",
  passkeyCancelled: "The passkey prompt was closed. Try again or use your action PIN.",
  passkeyFailed: "The passkey didn't work here. Use your action PIN or try another passkey.",
  passkeyUnsupported: "This browser can't use passkeys. Use your action PIN.",
  passkeyDuplicate: "This passkey is already registered.",
  pinLockedWait: (ms: number) => `Too many wrong PINs. Try again in ${formatDuration(ms)}.`,
  pinTriesLeft: (n: number) =>
    `${formatNumber(n)} ${plural(n, { one: "try", other: "tries" })} left before the action PIN turns off.`,
  pinDisabledNoPasskey:
    "Your action PIN is turned off after too many wrong attempts. Ask another Owner to reset it, or sign in again and use a recovery code under Settings → Security.",
  noFactorTitle: "Set up an action PIN first",
  noFactorLead: "Important changes are confirmed with an action PIN or a passkey. Choose a PIN now; it unlocks this session.",
  reauthTitle: "Sign in again to continue",
  reauthLead:
    "An action PIN or passkey can be set up only within 15 minutes of signing in. Sign out, sign in again, then set it up.",
  signOutAndIn: "Sign out and sign in again",
  signOut: "Sign out",

  // ---- lock screen (idle)
  lockTitle: "Dashboard locked",
  lockLead: (email: string) => `You were away for a while. ${email} is still signed in; confirm it's you to continue.`,
  lockLeadOther: "This dashboard was locked. Confirm it's you to continue.",
  unlock: "Unlock",
  locked: "Locked",

  // ---- first-factor setup
  setupTitle: "Protect important actions",
  setupLead:
    "Owners and Admins confirm important changes, like inviting a member or removing a PC, with an action PIN or a passkey. It also unlocks the dashboard after you have been away.",
  setupPinStep: "Choose an action PIN",
  setupPinLead: "6 to 12 digits that only you know. Avoid repeated digits and simple runs like 123456.",
  newPin: "New action PIN",
  repeatPin: "Repeat the PIN",
  setPin: "Save PIN",
  savingPin: "Saving…",
  pinSaved: "Action PIN saved.",
  setupPasskeyStep: "Add a passkey (optional)",
  setupPasskeyLead: "Windows Hello, your phone or a security key. Faster than typing the PIN.",
  setupDone: "Continue to the dashboard",
  setupWhy: "Why? A signed-in browser alone is not enough for changes that affect your PCs or your team.",

  // ---- Settings → Security
  lead: "How you confirm important changes in this dashboard.",
  pinCard: "Action PIN",
  pinCardSub: "Confirms important changes. It is not the exit PIN of the PCs.",
  pinSet: "Set",
  pinNotSet: "Not set",
  pinOff: "Turned off",
  pinLockedUntil: (when: string) => `Locked until ${when}`,
  setPinButton: "Set PIN",
  changePin: "Change PIN",
  removePin: "Remove PIN",
  changePinTitle: "Change your action PIN",
  setPinTitle: "Set an action PIN",
  pinChangeLead: "You confirm with your current PIN or a passkey first.",
  removePinTitle: "Remove your action PIN?",
  removePinBody: "Important changes are then confirmed with a passkey only.",
  pinRemoved: "Action PIN removed.",
  lastFactorHint: "Add a passkey before removing your only action PIN.",
  passkeysCard: "Passkeys",
  passkeysCardSub: (max: number) => `Windows Hello, a phone or a security key. Up to ${formatNumber(max)}.`,
  passkeysEmpty: "No passkeys yet.",
  passkeysOff: "Passkeys are not set up on this Rulebox server. The action PIN works.",
  addPasskey: "Add passkey",
  addPasskeyTitle: "Add a passkey",
  addPasskeyLead: "Give it a name you will recognise, then follow your browser's prompt.",
  passkeyName: "Name",
  passkeyNameDefault: "This PC",
  passkeyAdded: (name: string) => `Passkey “${name}” added.`,
  passkeyLimit: (max: number) => `You have ${formatNumber(max)} passkeys, the most allowed. Remove one to add another.`,
  renamePasskeyTitle: "Rename passkey",
  removePasskey: "Remove",
  removePasskeyTitle: (name: string) => `Remove the passkey “${name}”?`,
  removePasskeyBody: "It can no longer confirm changes. If this session was unlocked with it, the dashboard locks.",
  passkeyRemoved: "Passkey removed.",
  lastPasskeyHint: "Set an action PIN or add another passkey before removing your only one.",
  synced: "Synced",
  suspended: "Suspended",
  suspendedHint: "Its signature counter went backwards, which can mean it was copied. Remove it and add it again.",
  created: (when: string) => `Added ${when}`,
  lastUsed: (when: string) => `last used ${when}`,
  neverUsed: "never used",
  sessionCard: "This session",
  /** Followed by the relative time ("3 minutes ago") and a full stop. */
  sessionVerified: (method: "actionPin" | "passkey") => `Confirmed with ${method === "passkey" ? "a passkey" : "your action PIN"}`,
  sessionNotVerified: "Not confirmed yet. The first important change asks for your PIN or a passkey.",
  sessionLockHint: "Locks after 10 minutes without typing or clicking.",
  recoveryCard: "Lost your PIN and passkeys?",
  recoveryLead:
    "Another Owner can reset them from Settings → Members. Or, within 15 minutes of signing in, use one of your two-step recovery codes here; then set a new PIN.",
  recoveryCode: "Recovery code",
  recoveryReset: "Reset with recovery code",
  recoveryDone: "Your action PIN and passkeys were removed. Set a new PIN now.",
  recoveryNone: "This account has no recovery codes. Ask another Owner to reset your action PIN and passkeys.",
  viewerSetupHint: "Viewers don't need it to look around, but it protects your own account settings.",

  // ---- not_ready details
  notReady: {
    "no action PIN": "No action PIN is set. Use a passkey.",
    "no passkey": "No usable passkey. Use your action PIN.",
    "passkeys not configured": "Passkeys are not set up on this Rulebox server. Use your action PIN.",
    "no recovery codes": "This account has no recovery codes. Ask another Owner to reset your action PIN and passkeys.",
  } as Record<string, string>,
} as const;
