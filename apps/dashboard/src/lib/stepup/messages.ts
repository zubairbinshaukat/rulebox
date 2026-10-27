import { messageFor, toAppError } from "../errors";
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
  if (!app) {
    if (isPasskeyCancel(e)) return sec.passkeyCancelled;
    if (isPasskeyDuplicate(e)) return sec.passkeyDuplicate;
    if (e instanceof Error && /WebAuthn is not supported/.test(e.message)) return sec.passkeyUnsupported;
    // Any other WebAuthnError or DOMException from the browser's prompt.
    if (e instanceof Error && (e.name === "WebAuthnError" || e.name.endsWith("Error")) && "code" in e) return sec.passkeyFailed;
    if (typeof DOMException === "function" && e instanceof DOMException) return sec.passkeyFailed;
  }
  return messageFor(e);
}
