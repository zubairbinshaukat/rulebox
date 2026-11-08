import { messageFor, toAppError } from "../errors";
import { strings } from "../strings";
import { isPasskeyCancel, isPasskeyDuplicate } from "./passkey";
import { sec } from "./strings";

/**
 * The sentence for an error of a step-up call: the `ErrorCode` mirror
 * (`lib/errors.ts`), plus the `not_ready` details and the browser's passkey
 * errors, which only these screens meet.
 */
export function stepUpMessage(e: unknown): string {
  const app = toAppError(e);
  if (app?.code === "not_ready" && app.detail && sec.notReady[app.detail]) return sec.notReady[app.detail]!;
  if (app?.code === "conflict" && app.detail === "passkey limit") return sec.passkeyLimit(10);
  if (app?.code === "conflict" && app.detail === "passkey exists") return sec.passkeyDuplicate;
  if (app?.code === "forbidden" && app.detail === "member of another organization") return sec.resetMemberOtherOrg;
  if (app?.code === "invalid_argument") {
    // A PIN the server refused (the form mirrors the rules, so this is a drift or a race).
    if (app.field === "pin" || app.field === "newPin") return app.detail === "6 to 12 digits" ? strings.validate.pin : strings.validate.pinWeak;
    if (app.field === "currentPassword") return sec.passwordWrong;
    if (app.field === "newPassword") return app.detail === "same as current" ? sec.passwordSame : strings.validate.passwordMember;
  }  if (!app) {
    if (isPasskeyCancel(e)) return sec.passkeyCancelled;
    if (isPasskeyDuplicate(e)) return sec.passkeyDuplicate;
    if (e instanceof Error && /WebAuthn is not supported/.test(e.message)) return sec.passkeyUnsupported;
    // Any other WebAuthnError or DOMException from the browser's prompt.
    if (e instanceof Error && (e.name === "WebAuthnError" || e.name.endsWith("Error")) && "code" in e) return sec.passkeyFailed;
    if (typeof DOMException === "function" && e instanceof DOMException) return sec.passkeyFailed;
  }
  return messageFor(e);
}
