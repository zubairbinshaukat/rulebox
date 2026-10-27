/**
 * The few step-up sentences shown outside the lazily loaded step-up screens
 * (the account menu, the Members tab). Apart from `strings.ts` next to it so
 * every signed-in page does not carry the dialog and Security tab sentences.
 */
export const secShell = {
  lockNow: "Lock now",
  resetMember: "Reset PIN and passkeys",
  resetMemberTitle: (email: string) => `Reset the action PIN and passkeys of ${email}?`,
  resetMemberBody: "They set new ones after their next sign-in. Use this when they lost both.",
  resetMemberOtherOrg: "This person is also a member of another organization. They reset it with a recovery code instead.",
  resetMemberDone: "Action PIN and passkeys reset.",
} as const;
