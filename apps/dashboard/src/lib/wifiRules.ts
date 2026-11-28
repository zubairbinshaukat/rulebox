/**
 * The Wi-Fi rules the server enforces (`networks:saveWifi`, `wifi:setPassphrase`; plan 4.15), mirrored here for inline
 * messages and for the demo backend. Pure: no sentences (the screen maps a problem to its text), so this file can be
 * imported by the demo layer without pulling a screen's strings along.
 */

/** The security choices in the order the form lists them (the recommended one first). */
export const WIFI_SECURITIES: readonly ("wpa2Wpa3Personal" | "wpa2Personal" | "wpa3Personal" | "open")[] = [
  "wpa2Wpa3Personal",
  "wpa2Personal",
  "wpa3Personal",
  "open",
];

/**
 * A network, a printer or a driver can be in at most this many groups (`MAX_NETWORK_GROUPS` on the server). A save may touch any number of
 * them: the server makes the first 10 configurations in the call and the rest a moment later (Step 20b).
 */
export const MAX_WIFI_GROUPS = 100;

/** An SSID is 1 to 32 BYTES of UTF-8 (802.11), not characters. */
export const MAX_SSID_BYTES = 32;
/** Wi-Fi profiles per organization (`MAX_WIFI_PROFILES` on the server). */
export const MAX_WIFI_PROFILES = 50;
/** The profile's display name. */
export const MAX_WIFI_NAME = 60;

/** What the form calls a network whose Wi-Fi name is empty or only spaces. */
export const DEFAULT_WIFI_NAME = "Wi-Fi network";
/** The byte counter next to the Wi-Fi name appears only from here (and always when over the limit): most names are far shorter. */
export const SSID_COUNTER_FROM_BYTES = 24;

/** Show the "n of 32 bytes" counter: close to the limit or over it. */
export function showSsidCounter(ssid: string): boolean {
  return ssidBytes(ssid) > SSID_COUNTER_FROM_BYTES;
}

/**
 * The name Rulebox shows for a network before the admin edits it: the Wi-Fi name, trimmed, without control characters, at most
 * `MAX_WIFI_NAME` characters (code points, then trimmed again); `DEFAULT_WIFI_NAME` when nothing is left. The SSID itself is never
 * trimmed (spaces count), only this display name.
 */
export function defaultWifiName(ssid: string): string {
  const cleaned = Array.from(ssid)
    .filter((ch) => !hasControl(ch))
    .join("")
    .trim();
  const cut = Array.from(cleaned).slice(0, MAX_WIFI_NAME).join("").trim();
  return cut === "" ? DEFAULT_WIFI_NAME : cut;
}

/** UTF-8 length of an SSID in bytes: "Café" is 5 bytes. */
export function ssidBytes(ssid: string): number {
  return new TextEncoder().encode(ssid).length;
}

/** C0 and C1 controls and DEL, like the server's `hasControlChars`. */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return true;
  }
  return false;
}

export type SsidProblem = "empty" | "tooLong" | "control";

/** `null` when the SSID is fine. Spaces are legal in an SSID, so the text is not trimmed. */
export function ssidProblem(ssid: string): SsidProblem | null {
  if (ssid.length === 0) return "empty";
  if (hasControl(ssid)) return "control";
  if (ssidBytes(ssid) > MAX_SSID_BYTES) return "tooLong";
  return null;
}

export type PassphraseProblem = "empty" | "length" | "chars";

/**
 * WPA-Personal: 8 to 63 printable ASCII characters, or exactly 64 hexadecimal digits (the raw key). `null` when fine.
 * The value is only inspected here, never stored or logged.
 */
export function passphraseProblem(passphrase: string): PassphraseProblem | null {
  if (passphrase.length === 0) return "empty";
  if (/^[0-9a-fA-F]{64}$/.test(passphrase)) return null;
  if (!/^[\x20-\x7e]*$/.test(passphrase)) return "chars";
  if (passphrase.length < 8 || passphrase.length > 63) return "length";
  return null;
}
