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
 * One save (and a delete) touches at most this many groups: the groups the network is in now plus the ones picked; the server makes
 * a new configuration for each of them in the same call (`MAX_NETWORK_SNAPSHOT_GROUPS`) and answers `too_large` detail "groups".
 */
export const MAX_WIFI_GROUPS_PER_SAVE = 10;

/** An SSID is 1 to 32 BYTES of UTF-8 (802.11), not characters. */
export const MAX_SSID_BYTES = 32;
/** Wi-Fi profiles per organization (`MAX_WIFI_PROFILES` on the server). */
export const MAX_WIFI_PROFILES = 50;
/** The profile's display name. */
export const MAX_WIFI_NAME = 60;

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
