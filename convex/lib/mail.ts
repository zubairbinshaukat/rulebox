import type { ActionCtx } from "../_generated/server";
import { bytesToHex } from "@noble/hashes/utils.js";
import { hasControlChar, normalizeEmail, randomBytes } from "./crypto";
import { MAIL_TIMEOUT_MS, MAX_MAIL_SUBJECT, MAX_MAIL_TEXT } from "./limits";
import { getSecret } from "./platformSecrets";

// Outgoing email through Resend (Phase 4b Part C, owner decision 3: free
// tier; its sending limits are NOT verified here, check Resend's pricing page
// before relying on them). The API key and from address are platform secrets
// (lib/platformSecrets.ts), never a tenant's env.
//
// - One POST to https://api.resend.com/emails, MAIL_TIMEOUT_MS deadline, at
//   most ONE retry with the same `Idempotency-Key` (a retry after a lost
//   answer does not send twice): on a network error, a timeout or a 5xx at
//   once; on a 429 only when `Retry-After` asks for at most
//   `mailSettings.maxRetryAfterMs` (then after that wait), else no retry.
// - Plain text only (no `html`): Resend's click tracking rewrites links in
//   HTML bodies, so the reset link reaches the person unchanged. No
//   per-request tracking flag is sent (none is documented for /emails; click
//   tracking is a domain setting: leave it OFF on the sending domain).
// - Never logs the key, the recipient, the subject or the body (they carry
//   reset links); only the outcome and an HTTP status.
// - Callers get `{ ok }` and a fixed reason, never the provider's message.
// - Best effort: callers treat a failure as "no mail", never as a reason to
//   fail their own work. Mutations send through `internal.mail.send` with
//   `ctx.scheduler.runAfter(0, ...)`, which commits with them.
//
// `fetch` is the global one at call time (tests stub it; no test sends mail).

export const RESEND_URL = "https://api.resend.com/emails";

/**
 * The per-request deadline, and the longest `Retry-After` a 429 may ask for
 * and still be retried (longer or missing: no retry, the caller treats it as
 * "no mail"). Through an object so a test can change them.
 */
export const mailSettings = { timeoutMs: MAIL_TIMEOUT_MS, maxRetryAfterMs: 3_000 };

/** `Retry-After` in milliseconds (delta-seconds only), or null when missing or not a number. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return null;
  return Number(raw.trim()) * 1000;
}

export type MailMessage = { to: string; subject: string; text: string };
export type MailResult = { ok: true } | { ok: false; reason: "mail_off" | "invalid" | "failed" };
export type MailConfig = { apiKey: string; from: string };

/** The Resend key and from address, or null when either is not set (mail is off). Actions only. */
export async function loadMailConfig(ctx: Pick<ActionCtx, "runQuery">): Promise<MailConfig | null> {
  const apiKey = await getSecret(ctx, "resendApiKey");
  const from = await getSecret(ctx, "resendFrom");
  return apiKey === null || from === null ? null : { apiKey, from };
}

function messageProblem(m: MailMessage): boolean {
  return (
    normalizeEmail(m.to) === null ||
    m.subject.length === 0 ||
    m.subject.length > MAX_MAIL_SUBJECT ||
    hasControlChar(m.subject) ||
    m.text.length === 0 ||
    m.text.length > MAX_MAIL_TEXT
  );
}

type Attempt = { kind: "sent" } | { kind: "retry"; waitMs: number } | { kind: "refused" };

async function attempt(config: MailConfig, body: string, idempotencyKey: string): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), mailSettings.timeoutMs);
  try {
    const res = await globalThis.fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    // The body is not read: it may echo what was sent.
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return { kind: "sent" };
    if (res.status === 429) {
      // Rate limited: retry only when the provider asks for a short wait (never hammer it).
      const wait = retryAfterMs(res);
      if (wait !== null && wait <= mailSettings.maxRetryAfterMs) {
        console.warn("sendMail: provider answered 429, retrying once after Retry-After");
        return { kind: "retry", waitMs: wait };
      }
      console.warn("sendMail: provider answered 429, not retrying");
      return { kind: "refused" };
    }
    if (res.status >= 500) {
      console.warn(`sendMail: provider answered ${res.status}, retrying once`);
      return { kind: "retry", waitMs: 0 };
    }
    console.warn(`sendMail: provider refused the message (${res.status})`);
    return { kind: "refused" };
  } catch {
    console.warn("sendMail: network error or timeout");
    return { kind: "retry", waitMs: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one plain-text email. `{ ok: false, reason: "mail_off" }` when no key
 * or from address is configured. `config` skips loading it again. Actions only.
 */
export async function sendMail(
  ctx: Pick<ActionCtx, "runQuery" | "runAction">,
  message: MailMessage,
  config?: MailConfig | null,
): Promise<MailResult> {
  if (messageProblem(message)) return { ok: false, reason: "invalid" };
  const c = config ?? (await loadMailConfig(ctx));
  if (c === null) return { ok: false, reason: "mail_off" };
  const body = JSON.stringify({ from: c.from, to: [normalizeEmail(message.to)], subject: message.subject, text: message.text });
  const idempotencyKey = bytesToHex(randomBytes(ctx, 16));
  for (let i = 0; i < 2; i++) {
    const r = await attempt(c, body, idempotencyKey);
    if (r.kind === "sent") return { ok: true };
    if (r.kind === "refused") break;
    if (i === 0 && r.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, r.waitMs));
  }
  return { ok: false, reason: "failed" };
}

// ---------------------------------------------------------------- texts (fixed; no secret but the link)

export function pinResetMail(link: string): Omit<MailMessage, "to"> {
  return {
    subject: "Reset your Rulebox PIN",
    text:
      "You asked (from a signed-in dashboard session) to reset the PIN of your Rulebox dashboard account.\n\n" +
      `To set a new PIN, open this link within 30 minutes and sign in with your password:\n${link}\n\n` +
      "The link works once. If you did not ask for this, your PIN stays as it is unless the link is used, " +
      "but someone signed in with your password: change it now (Settings > Security > Change password) " +
      "or ask an Owner of your organization for a password reset code.",
  };
}

/** How to act when it was not the person: the real paths that exist (review finding 5). */
const NOT_YOU =
  "If this was not you, someone may know your password. Change it now: unlock the dashboard with your PIN, " +
  "a passkey or a recovery code, then Settings > Security > Change password (it signs out every other " +
  "session). If you cannot unlock, reset your PIN by email from the lock screen (\"Forgot PIN?\"; the " +
  "link also needs your password) or ask an Owner of your organization to reset it, then change your " +
  "password. Ask an Owner to check the audit log.";

export function pinResetDoneMail(how: "email" | "recoveryCode" = "email"): Omit<MailMessage, "to"> {
  const by = how === "email" ? "with an emailed link" : "with one of your recovery codes";
  return {
    subject: "Your Rulebox PIN was reset",
    text:
      `The PIN of your Rulebox dashboard account was just reset ${by}, and every other ` +
      `session of your account was signed out.\n\n${NOT_YOU}`,
  };
}

/** The PIN was set for the first time or changed from an unlocked session (not a reset: see `pinResetDoneMail`). */
export function pinChangedMail(changed: boolean): Omit<MailMessage, "to"> {
  return {
    subject: changed ? "Your Rulebox PIN was changed" : "A PIN was set on your Rulebox account",
    text:
      `The PIN of your Rulebox dashboard account was just ${changed ? "changed" : "set for the first time"}` +
      `${changed ? ", and your other sessions lost their unlock" : ""}.\n\n` +
      `If this was you, nothing to do. ${NOT_YOU}`,
  };
}

function duration(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours % 24 === 0 && hours >= 48 ? `${hours / 24} days` : `${hours} hours`;
}

export function pinLockedMail(lockoutMs: number): Omit<MailMessage, "to"> {
  return {
    subject: `Your Rulebox PIN is locked for ${duration(lockoutMs)}`,
    text:
      `Your Rulebox dashboard PIN was entered wrongly too many times, so it is locked for ${duration(lockoutMs)}. ` +
      "Repeated lockouts last longer each time.\n\n" +
      "If this was you, you can still unlock with a passkey or a recovery code, or reset the PIN by email " +
      `from the lock screen ("Forgot PIN?").\n\n${NOT_YOU}`,
  };
}

export function pinFailuresMail(failures: number): Omit<MailMessage, "to"> {
  return {
    subject: "Wrong PIN attempts on your Rulebox account",
    text:
      `There were ${failures} wrong PIN attempts on your Rulebox dashboard account since you last unlocked it.\n\n` +
      `If this was you, nothing to do. ${NOT_YOU}`,
  };
}

export function passwordChangedMail(): Omit<MailMessage, "to"> {
  return {
    subject: "Your Rulebox password was changed",
    text:
      "The password of your Rulebox dashboard account was just changed, and every other session of your " +
      "account was signed out.\n\nIf this was not you, ask an Owner of your organization for a password " +
      "reset code at once and to check the audit log.",
  };
}
