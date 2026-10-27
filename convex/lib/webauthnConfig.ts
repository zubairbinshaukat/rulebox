import { env } from "../_generated/server";

// Passkey relying-party settings, per environment (plan 4.16). Env values
// (declared optional in convex.config.ts):
//
//   RULEBOX_WEBAUTHN_RP_ID     the registrable domain, e.g. "dashboard.rulebox.app" or "localhost"
//   RULEBOX_WEBAUTHN_ORIGINS   comma-separated exact origins, e.g. "https://dashboard.rulebox.app"
//   RULEBOX_WEBAUTHN_RP_NAME   shown by the authenticator (default "Rulebox")
//
// A missing or invalid value turns passkeys off (fail closed: `not_ready`);
// the action PIN keeps working.

export type WebAuthnConfig = { rpId: string; rpName: string; origins: string[] };

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Pure: validate the three values. Null when anything is off. */
export function parseWebAuthnConfig(
  rpIdRaw: string | undefined,
  originsRaw: string | undefined,
  rpNameRaw: string | undefined,
): WebAuthnConfig | null {
  const rpId = (rpIdRaw ?? "").trim().toLowerCase();
  if (!HOST_RE.test(rpId)) return null;
  const origins: string[] = [];
  for (const part of (originsRaw ?? "").split(",")) {
    const text = part.trim();
    if (text === "") continue;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    // Exactly an origin: no path, query, fragment or credentials.
    if (url.origin !== text.replace(/\/$/, "") || url.username !== "" || url.password !== "") return null;
    const secure = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
    if (!secure) return null;
    const host = url.hostname.toLowerCase();
    if (host !== rpId && !host.endsWith(`.${rpId}`)) return null;
    origins.push(url.origin);
  }
  if (origins.length === 0) return null;
  const rpName = (rpNameRaw ?? "").trim() || "Rulebox";
  return { rpId, rpName: rpName.slice(0, 64), origins };
}

export function webauthnConfig(): WebAuthnConfig | null {
  return parseWebAuthnConfig(env.RULEBOX_WEBAUTHN_RP_ID, env.RULEBOX_WEBAUTHN_ORIGINS, env.RULEBOX_WEBAUTHN_RP_NAME);
}
