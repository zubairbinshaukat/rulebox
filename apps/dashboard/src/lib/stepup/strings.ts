/**
 * The step-up sentences (plan 4.16, Phase 4b): the confirm dialog, the lock
 * screen, PIN setup, the PIN reset page and Settings → Security. A lazily
 * loaded part of `lib/strings.ts` (same rules: short, plain, interpolation by
 * functions), so the sign-in page does not download them.
 *
 * "PIN" is the member's dashboard PIN: asked on every page load, and again for
 * important changes. It is never called "exit PIN" (the PCs' admin exit) and
 * the two are never accepted for each other.
 */
import { formatDuration, formatNumber, plural } from "../format";
import { secShell } from "./strings-shell";

export const sec = {
  ...secShell,
  tab: "Security",

  // ---- confirm dialog (step_up_required / step_up_setup_required)
  confirmTitle: "Confirm it's you",
  confirmLead: "This change needs your PIN or a passkey.",
  confirmLeadFresh: "Important changes need a confirmation from the last 5 minutes.",
  confirm: "Confirm",
  confirming: "Checking…",
  usePasskey: "Use a passkey",
  usingPasskey: "Waiting for your passkey…",
  orPin: "or enter your PIN",
  pin: "PIN",
  pinHint: "6 to 12 digits. Not the exit PIN of the PCs.",
  showPin: "Show PIN",
  hidePin: "Hide PIN",
  passkeyCancelled: "The passkey prompt was closed. Try again or use your PIN.",
  passkeyFailed: "The passkey didn't work here. Use your PIN or try another passkey.",
  passkeyUnsupported: "This browser can't use passkeys. Use your PIN.",
  passkeyDuplicate: "This passkey is already registered.",
  pinLockedWait: (ms: number) => `Too many wrong PINs. Try again in ${formatDuration(ms)}.`,
  /** Shown after the first wrong PIN: what has happened and what is left. */
  pinTriesLeft: (failed: number, left: number) =>
    `${formatNumber(failed)} wrong ${plural(failed, { one: "PIN", other: "PINs" })} since you last unlocked. ${formatNumber(left)} ${plural(left, { one: "try", other: "tries" })} left before the PIN locks.`,
  /** The long lockout (24 hours, then longer): the PIN field is hidden until it ends. */
  pinLockout: (when: string) => `Your PIN is locked until ${when} after too many wrong tries.`,
  pinLockoutHelp: "You can still use a passkey, a recovery code or the emailed link.",
  noFactorTitle: "Set your PIN first",
  noFactorLead: "Important changes are confirmed with your PIN or a passkey. Choose a PIN now; it unlocks this session.",
  reauthTitle: "Sign in again to continue",
  reauthLead:
    "Your PIN can be set or reset only within 15 minutes of signing in with your password. Sign out, sign in again, then continue.",
  signOutAndIn: "Sign out and sign in again",
  signOut: "Sign out",

  // ---- lock screen (every page load, idle, "Lock now")
  lockTitle: "Enter your PIN",
  lockLeadLoad: (email: string) => `Welcome back, ${email}. Enter your PIN to open the dashboard.`,
  lockLead: (email: string) => `You were away for a while. ${email} is still signed in; enter your PIN to continue.`,
  lockLeadOther: "This dashboard was locked. Enter your PIN to continue.",
  unlock: "Unlock",
  locked: "Locked",
  forgotPin: "Forgot PIN?",
  useRecoveryCode: "Use a recovery code",
  backToPin: "Back to the PIN",
  noRecoveryCodes: "No recovery codes left. Ask an Owner to reset your PIN, or use Forgot PIN.",
  emailOff: "Email reset is not set up on this Rulebox server. Use a recovery code, a passkey, or ask an Owner to reset your PIN.",
  forgotSending: "Sending…",
  /** Neutral on purpose: the same sentence whatever happened behind it. */
  forgotSent: (email: string) =>
    `If email is set up for this Rulebox, a reset link is on its way to ${email}. It works once, for 30 minutes. Open it in this browser.`,
  forgotSendAgain: "Send it again",
  forgotNote: "The link only works while you are signed in here with your password sign-in from the last 15 minutes.",

  // ---- recovery code + new PIN
  recoveryCode: "Recovery code",
  recoveryUseTitle: "Reset your PIN with a recovery code",
  recoveryUseLead:
    "Enter one of your recovery codes and choose a new PIN. Your passkeys are removed; add them again afterwards. This works within 15 minutes of signing in with your password.",
  recoveryUseSubmit: "Reset PIN",
  recoveryUseSaving: "Resetting…",

  // ---- PIN setup after the first sign-in
  setupTitle: "Set your PIN",
  setupLead: "You enter this PIN every time you open the dashboard, and to confirm important changes.",
  setupWarnTitle: "Don't forget this PIN",
  setupWarnDetail:
    "Rulebox can't show it to you again. If you lose it, you can reset it with a recovery code or an emailed link, but only right after signing in with your password.",
  setupPinLead: "6 to 12 digits that only you know. Avoid repeated digits and simple runs like 123456.",
  newPin: "New PIN",
  repeatPin: "Repeat the PIN",
  setPin: "Save PIN",
  savingPin: "Saving…",
  pinSaved: "PIN saved.",
  setupWhy: "Why? A signed-in browser alone is not enough for changes that affect your PCs or your team.",
  setupSteps: ["PIN", "Recovery codes", "Passkey"],
  setupStepOf: (n: number, total: number, name: string) => `Step ${formatNumber(n)} of ${formatNumber(total)}: ${name}`,

  // ---- recovery codes (shown once)
  codesTitle: "Save your recovery codes",
  codesLead:
    "Each code works once if you forget your PIN. They are shown only now. Store them somewhere safe, like a password manager.",
  codesPreparing: "Creating your codes…",
  codesRetry: "Try again",
  codesList: "Recovery codes",
  codesCopyAll: "Copy all codes",
  codesDownload: "Download as a text file",
  codesDownloaded: "File saved to your downloads.",
  codesSaved: "I stored these codes somewhere safe",
  codesContinue: "Continue",
  codesFileName: "rulebox-recovery-codes.txt",
  codesFile: (email: string, date: string, codes: readonly string[]) =>
    [
      "Rulebox recovery codes",
      `Account: ${email}`,
      `Created: ${date}`,
      "",
      "Each code works once. Use one if you forget your PIN (Forgot PIN, Use a recovery code).",
      "Keep this file somewhere safe and private.",
      "",
      ...codes,
      "",
    ].join("\n"),

  // ---- passkey offer
  setupPasskeyTitle: "Add a passkey? (optional)",
  setupPasskeyLead: "Windows Hello, your phone or a security key. It unlocks the dashboard faster than typing the PIN.",
  setupPasskeySkip: "Skip for now",
  setupDone: "Continue to the dashboard",
  setupPasskeyDone: "Done",

  // ---- the /pin-reset page (the emailed link)
  resetTitle: "Choose a new PIN",
  resetLead: "Choose a new PIN for the dashboard. Your other signed-in browsers are signed out.",
  resetNeedsSignIn: "Sign in to continue",
  resetNeedsSignInLead: "Sign in with your password, then you come back here to choose a new PIN.",
  resetSubmit: "Save new PIN",
  resetDone: "Your PIN is changed",
  resetDoneLead: "Your other signed-in browsers were signed out. You enter the new PIN on the next screen.",
  resetGoOn: "Open the dashboard",
  /** One sentence for an expired, used or invalid link: they are not told apart. */
  resetInvalid: "This link is not valid any more. Open the newest link from your email, or ask for a new one on the PIN screen.",
  resetNoToken: "This page needs the link from your reset email. Open it from the email, or ask for a new one on the PIN screen.",
  resetBack: "Back to the dashboard",
  resetDemoHint: "Demo: open /pin-reset#token=demo-pin-reset-token to try the link.",

  // ---- Settings → Security
  lead: "How you open the dashboard and confirm important changes.",
  pinCard: "PIN",
  pinCardSub: "Asked on every page load and for important changes. It is not the exit PIN of the PCs.",
  pinSet: "Set",
  pinNotSet: "Not set",
  pinLockedUntil: (when: string) => `Locked until ${when}`,
  setPinButton: "Set PIN",
  changePin: "Change PIN",
  changePinTitle: "Change your PIN",
  setPinTitle: "Set your PIN",
  pinChangeLead: "You confirm with your current PIN or a passkey first.",
  pinRequiredHint: "The PIN is required and can't be removed. You can change it here.",
  passkeysCard: "Passkeys",
  passkeysCardSub: (max: number) => `Windows Hello, a phone or a security key. Up to ${formatNumber(max)}.`,
  passkeysEmpty: "No passkeys yet.",
  passkeysOff: "Passkeys are not set up on this Rulebox server. The PIN works.",
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
  synced: "Synced",
  suspended: "Suspended",
  suspendedHint: "Its signature counter went backwards, which can mean it was copied. Remove it and add it again.",
  created: (when: string) => `Added ${when}`,
  lastUsed: (when: string) => `last used ${when}`,
  neverUsed: "never used",
  sessionCard: "This session",
  /** Followed by the relative time ("3 minutes ago") and a full stop. */
  sessionVerified: (method: "actionPin" | "passkey") => `Confirmed with ${method === "passkey" ? "a passkey" : "your PIN"}`,
  sessionNotVerified: "Not confirmed yet. The first important change asks for your PIN or a passkey.",
  sessionLockHint: "Locks after 10 minutes without typing or clicking, and again on every page load.",

  // recovery codes card
  recoveryCard: "Recovery codes",
  recoveryCardSub: "If you forget your PIN, a recovery code lets you choose a new one.",
  recoveryLeft: (n: number) => `${formatNumber(n)} ${plural(n, { one: "code", other: "codes" })} left`,
  recoveryNone: "No recovery codes yet",
  recoveryCreate: "Create new codes",
  recoveryCreateTitle: "Create new recovery codes?",
  recoveryCreateBody: "Your old codes stop working. You confirm with your PIN or a passkey first.",
  recoveryCreated: "New recovery codes",
  recoveryCreatedLead: "Shown only now. Store them somewhere safe.",
  recoveryOtherWays: "Other ways back in: the emailed Forgot PIN link on the PIN screen, or another Owner (Settings → Members).",

  // password card
  passwordCard: "Password",
  passwordCardSub: "The password you sign in with. Changing it signs out your other browsers.",
  passwordChange: "Change password",
  passwordCurrent: "Current password",
  passwordNew: "New password",
  passwordRepeat: "Repeat the new password",
  passwordRules: "12 or more characters, with a letter and a digit.",
  passwordWrong: "That is not your current password.",
  passwordSame: "The new password must be different from the current one.",
  passwordSaving: "Changing…",
  passwordChanged: "Password changed. Your other browsers are signed out.",

  // ---- not_ready details
  notReady: {
    "no action PIN": "No PIN is set yet.",
    "no passkey": "No usable passkey. Use your PIN.",
    "passkeys not configured": "Passkeys are not set up on this Rulebox server. Use your PIN.",
    "no recovery codes": "This account has no recovery codes left. Use Forgot PIN, or ask an Owner to reset your PIN.",
  } as Record<string, string>,
} as const;
