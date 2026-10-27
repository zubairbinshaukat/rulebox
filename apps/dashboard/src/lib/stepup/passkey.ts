/**
 * Browser side of the passkey ceremonies. `@simplewebauthn/browser` is
 * imported only here and only when a passkey is actually used (a separate
 * chunk, never part of the first load).
 */
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

/** WebAuthn exists in this browser (and this is a secure context). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

const load = () => import("@simplewebauthn/browser");

/** `navigator.credentials.get` with the server's options; the credential JSON as a string. */
export async function assertPasskey(optionsJson: string): Promise<string> {
  const { startAuthentication } = await load();
  const optionsJSON = JSON.parse(optionsJson) as PublicKeyCredentialRequestOptionsJSON;
  return JSON.stringify(await startAuthentication({ optionsJSON }));
}

/** `navigator.credentials.create` with the server's options; the credential JSON as a string. */
export async function createPasskey(optionsJson: string): Promise<string> {
  const { startRegistration } = await load();
  const optionsJSON = JSON.parse(optionsJson) as PublicKeyCredentialCreationOptionsJSON;
  return JSON.stringify(await startRegistration({ optionsJSON }));
}

/** Stops a running prompt (the dialog closed). Loads nothing when no ceremony ever started. */
export function cancelPasskeyPrompt(started: boolean): void {
  if (!started) return;
  void load().then((m) => m.WebAuthnAbortService.cancelCeremony(), () => undefined);
}

function nameOf(e: unknown): string {
  if (!e || typeof e !== "object") return "";
  const cause = (e as { cause?: unknown }).cause;
  const own = (e as { name?: unknown }).name;
  const causeName = cause && typeof cause === "object" ? (cause as { name?: unknown }).name : undefined;
  return [own, causeName].filter((x): x is string => typeof x === "string").join(" ");
}

function codeOf(e: unknown): string {
  const c = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : "";
}

/** The person closed or timed out the browser's prompt (not an error to shout about). */
export function isPasskeyCancel(e: unknown): boolean {
  return /NotAllowedError|AbortError/.test(nameOf(e)) || codeOf(e) === "ERROR_CEREMONY_ABORTED";
}

/** Registration of an authenticator that already holds one of the person's passkeys. */
export function isPasskeyDuplicate(e: unknown): boolean {
  return codeOf(e) === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || /InvalidStateError/.test(nameOf(e));
}
