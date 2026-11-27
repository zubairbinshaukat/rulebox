// Whether a person closed the passkey reminder banner (per person, this browser only). Storage can be
// missing or blocked (private window): then the banner is simply shown again on the next visit.
const KEY_PREFIX = "rulebox.passkeyReminder.";

export function wasPasskeyReminderDismissed(email: string): boolean {
  try {
    return window.localStorage.getItem(KEY_PREFIX + email) === "1";
  } catch {
    return false;
  }
}

/** Hide the banner for this person in this browser (the Dismiss button, and "Skip for now" in setup). */
export function dismissPasskeyReminder(email: string): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + email, "1");
  } catch {
    /* hidden for this visit only */
  }
}
