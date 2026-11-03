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
//   most ONE retry (network error, timeout, 429 or 5xx) with the same
//   `Idempotency-Key`, so a retry after a lost answer does not send twice.
// - Never logs the key, the recipient, the subject or the body (they carry
//   reset links); only the outcome and an HTTP status.
// - Callers get `{ ok }` and a fixed reason, never the provider's message.
// - Best effort: callers treat a failure as "no mail", never as a reason to
//   fail their own work. Mutations send through `internal.mail.send` with
//   `ctx.scheduler.runAfter(0, ...)`, which commits with them.
//
// `fetch` is the global one at call time (tests stub it; no test sends mail).

export const RESEND_URL = "https://api.resend.com/emails";

/** The per-request deadline, through an object so a test can shorten it. */
export const mailSettings = { timeoutMs: MAIL_TIMEOUT_MS };

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

type Attempt = { kind: "sent" } | { kind: "retry" } | { kind: "refused" };

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
    if (res.status === 429 || res.status >= 500) {
      console.warn(`sendMail: provider answered ${res.status}, retrying once`);
      return { kind: "retry" };
    }
    console.warn(`sendMail: provider refused the message (${res.status})`);
    return { kind: "refused" };
  } catch {
    console.warn("sendMail: network error or timeout");
    return { kind: "retry" };
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
  }
  return { ok: false, reason: "failed" };
}

// ---------------------------------------------------------------- texts (fixed; no secret but the link)

export function pinResetMail(link: string): Omit<MailMessage, "to"> {
  return {
    subject: "Reset your Rulebox PIN",
    text:
      "Someone asked to reset the PIN of your Rulebox dashboard account.\n\n" +
      `To set a new PIN, open this link within 30 minutes and sign in with your password:\n${link}\n\n` +
      "The link works once. If you did not ask for this, ignore this email: your PIN stays as it is.",
  };
}

export function pinResetDoneMail(): Omit<MailMessage, "to"> {
  return {
    subject: "Your Rulebox PIN was reset",
    text:
      "The PIN of your Rulebox dashboard account was just reset with an emailed link, and every other " +
      "session of your account was signed out.\n\nIf this was not you, change your password now and ask " +
      "an Owner of your organization to check the audit log.",
  };
}

export function pinLockedMail(): Omit<MailMessage, "to"> {
  return {
    subject: "Your Rulebox PIN is locked for 24 hours",
    text:
      "Your Rulebox dashboard PIN was entered wrongly 10 times in a row, so it is locked for 24 hours.\n\n" +
      "If this was you, you can still unlock with a passkey or a recovery code, or reset the PIN by email. " +
      "If it was not you, someone may know your password: change it now.",
  };
}
