/*
 * The website's only server code (plan §3.4, §10). One Worker serves the
 * static files from ../dist and runs this script only for /api/* (set by
 * assets.run_worker_first in wrangler.jsonc), so page views never count
 * against the Workers request limit.
 *
 *   POST /api/pilot          pilot request   -> owner inbox + auto-reply
 *   POST /api/contact        contact form    -> owner inbox (routed by topic)
 *   POST /api/notify         "notify me"     -> double opt-in confirmation email
 *   GET  /api/notify/confirm signed link     -> adds the address to the list
 *
 * Every POST: JSON only, same-origin, honeypot empty, not faster than 2 s,
 * Turnstile token verified on the server, fields trimmed and capped, rate
 * limited per IP. Nothing is stored here and nothing touches Convex.
 */

export interface Env {
  ASSETS: Fetcher;
  /** Workers rate-limiting binding (wrangler.jsonc "ratelimits"). */
  FORM_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  TURNSTILE_SECRET: string;
  RESEND_API_KEY: string;
  /** Owner inbox for pilot and general mail. */
  FORM_TO_ADDRESS: string;
  /** Optional separate inbox for security-topic contact messages. */
  SECURITY_TO_ADDRESS?: string;
  /** Fixed sender on the verified sending subdomain, e.g. "Rulebox <hello@hello.example.org>". */
  FORM_FROM_ADDRESS: string;
  /** Allowed Origin, e.g. "https://example.org". */
  SITE_ORIGIN: string;
  /** HMAC key for notify confirmation links. */
  NOTIFY_SECRET: string;
  /** Optional Resend audience for the notify list; without it the owner gets an email. */
  RESEND_AUDIENCE_ID?: string;
  /** "false" turns the pilot auto-reply off on a busy day (Resend free plan: 100 emails a day). */
  AUTO_REPLY?: string;
}

type Json = Record<string, unknown>;
const MIN_ELAPSED_MS = 2000;

const json = (status: number, body: Json) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });

/** Trim, cap length, and (for header-bound values) strip line breaks. */
export function clean(value: unknown, max: number, singleLine = true): string {
  if (typeof value !== "string") return "";
  let v = value.trim().slice(0, max);
  if (singleLine) v = v.replace(/[\r\n\t]+/g, " ");
  return v;
}

export function isEmail(v: string): boolean {
  return v.length <= 200 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(v);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function verifyTurnstile(secret: string, token: string, ip: string | null, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!token) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const res = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

async function sendEmail(env: Env, msg: { to: string; subject: string; text: string; replyTo?: string }): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.FORM_FROM_ADDRESS,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
  });
  return res.ok;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Shared checks for every form POST. Returns the parsed body or an error response. */
async function guard(req: Request, env: Env): Promise<Json | Response> {
  if (req.method !== "POST") return json(405, { message: "Use POST." });
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return json(415, { message: "Send JSON." });
  if (req.headers.get("origin") !== env.SITE_ORIGIN) return json(403, { message: "This form only works on our website." });

  const ip = req.headers.get("cf-connecting-ip");
  if (env.FORM_LIMITER) {
    const { success } = await env.FORM_LIMITER.limit({ key: ip ?? "unknown" });
    if (!success) return json(429, { message: "Too many messages from your connection. Please wait a minute, or email us." });
  }

  let body: Json;
  try {
    const raw = await req.text();
    if (raw.length > 20_000) return json(413, { message: "That message is too long." });
    body = JSON.parse(raw) as Json;
  } catch {
    return json(400, { message: "That did not look like a form submission." });
  }
  // Honeypot and timing: answer "ok" so bots learn nothing, but send nothing.
  if (clean(body.website, 200) !== "" || Number(body.elapsedMs ?? 0) < MIN_ELAPSED_MS) {
    return json(200, { message: "Thank you." });
  }
  const ok = await verifyTurnstile(env.TURNSTILE_SECRET, clean(body.turnstileToken, 4096), ip);
  if (!ok) return json(403, { message: "The spam check did not pass. Please try again." });
  return body;
}

async function pilot(req: Request, env: Env): Promise<Response> {
  const b = await guard(req, env);
  if (b instanceof Response) return b;
  const f = {
    name: clean(b.name, 120),
    email: clean(b.email, 200),
    organisation: clean(b.organisation, 160),
    pcs: clean(b.pcs, 40),
    useCase: clean(b.useCase, 80),
    windows: clean(b.windows, 160),
    message: clean(b.message, 3000, false),
    consent: b.consent === "yes",
  };
  if (!f.name || !isEmail(f.email) || !f.organisation || !f.pcs || !f.useCase || !f.consent) {
    return json(422, { message: "Please fill in every required field and tick the consent box." });
  }
  const text = [
    `Name: ${f.name}`,
    `Email: ${f.email}`,
    `Organisation: ${f.organisation}`,
    `PCs: ${f.pcs}`,
    `Used for: ${f.useCase}`,
    `Windows: ${f.windows || "-"}`,
    "",
    f.message || "(no message)",
  ].join("\n");
  const sent = await sendEmail(env, { to: env.FORM_TO_ADDRESS, subject: `Pilot request: ${f.organisation}`, text, replyTo: f.email });
  if (!sent) return json(502, { message: "We could not send that right now. Please email us instead." });
  if (env.AUTO_REPLY !== "false") {
    await sendEmail(env, {
      to: f.email,
      subject: "We received your Rulebox pilot request",
      text: `Hello ${f.name},\n\nThank you for your interest in the Rulebox pilot. We read every request and will reply by email.\n\nThe Rulebox team`,
    });
  }
  return json(200, { message: "Thank you. We received your request and will reply by email." });
}

async function contact(req: Request, env: Env): Promise<Response> {
  const b = await guard(req, env);
  if (b instanceof Response) return b;
  const topics = ["general", "press", "partnership", "security"];
  const f = {
    name: clean(b.name, 120),
    email: clean(b.email, 200),
    topic: topics.includes(String(b.topic)) ? String(b.topic) : "general",
    message: clean(b.message, 5000, false),
  };
  if (!f.name || !isEmail(f.email) || !f.message) return json(422, { message: "Please fill in your name, email and message." });
  const to = f.topic === "security" && env.SECURITY_TO_ADDRESS ? env.SECURITY_TO_ADDRESS : env.FORM_TO_ADDRESS;
  const sent = await sendEmail(env, {
    to,
    subject: `Contact (${f.topic}): ${f.name}`,
    text: `From: ${f.name} <${f.email}>\nTopic: ${f.topic}\n\n${f.message}`,
    replyTo: f.email,
  });
  return sent ? json(200, { message: "Thank you. We will reply by email." }) : json(502, { message: "We could not send that right now. Please email us instead." });
}

async function notify(req: Request, env: Env): Promise<Response> {
  const b = await guard(req, env);
  if (b instanceof Response) return b;
  const email = clean(b.email, 200).toLowerCase();
  if (!isEmail(email)) return json(422, { message: "Please enter a valid email address." });
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const sig = await hmac(env.NOTIFY_SECRET, `${email}|${exp}`);
  const link = `${env.SITE_ORIGIN}/api/notify/confirm?e=${encodeURIComponent(email)}&x=${exp}&s=${sig}`;
  const sent = await sendEmail(env, {
    to: email,
    subject: "Confirm: tell me when Rulebox is open to everyone",
    text: `Someone (we hope you) asked to hear when Rulebox opens to everyone.\n\nConfirm here: ${link}\n\nIf it was not you, ignore this email and nothing happens.`,
  });
  return sent ? json(200, { message: "Almost done. Check your inbox to confirm." }) : json(502, { message: "We could not send the email right now. Please try later." });
}

async function confirm(url: URL, env: Env): Promise<Response> {
  const email = clean(url.searchParams.get("e"), 200).toLowerCase();
  const exp = Number(url.searchParams.get("x"));
  const sig = url.searchParams.get("s") ?? "";
  const page = (title: string, text: string, status = 200) =>
    new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><body style="font:18px/1.6 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;background:#f8f5f0;color:#231e19"><h1 style="letter-spacing:-.03em">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="/">Back to Rulebox</a></p></body></html>`,
      { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  if (!isEmail(email) || !exp || exp < Date.now()) return page("This link has expired", "Please sign up again from the website.", 400);
  const expected = await hmac(env.NOTIFY_SECRET, `${email}|${exp}`);
  if (!timingSafeEqual(sig, expected)) return page("This link is not valid", "Please sign up again from the website.", 400);

  let ok: boolean;
  if (env.RESEND_AUDIENCE_ID) {
    const res = await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ email, unsubscribed: false }),
    });
    ok = res.ok;
  } else {
    ok = await sendEmail(env, { to: env.FORM_TO_ADDRESS, subject: "Notify list: new confirmed address", text: email });
  }
  return ok ? page("You are on the list", "We will email you once when Rulebox is open to everyone. Nothing else.") : page("Something went wrong", "Please try the link again in a minute.", 502);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/api/pilot":
        return pilot(req, env);
      case "/api/contact":
        return contact(req, env);
      case "/api/notify":
        return notify(req, env);
      case "/api/notify/confirm":
        return req.method === "GET" ? confirm(url, env) : json(405, { message: "Use GET." });
      default:
        if (url.pathname.startsWith("/api/")) return json(404, { message: "Not found." });
        return env.ASSETS.fetch(req);
    }
  },
} satisfies ExportedHandler<Env>;
