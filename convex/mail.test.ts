import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import type { T } from "../tests/convex/identity";
import { internal } from "./_generated/api";
import { base64Encode } from "./lib/crypto";
import { MAIL_TIMEOUT_MS } from "./lib/limits";
import { mailSettings, RESEND_URL } from "./lib/mail";

// The Resend sender (lib/mail.ts) against a MOCKED fetch: no test sends mail.

declare const process: { env: Record<string, string | undefined> };

const KEY = "re_TestKeyNotReal_0123456789";
const FROM = "Rulebox <no-reply@rulebox.test>";
const MSG = { to: "Ana@Acme.test", subject: "Hello", text: "Body with a link https://x.test/pin-reset?token=SECRET" };

type Call = { url: string; init: RequestInit };

function mockFetch(answers: (Response | "hang" | "throw")[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const a = answers.shift() ?? new Response("{}", { status: 200 });
    if (a === "throw") throw new TypeError("network down");
    if (a === "hang") {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return a;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

async function configured(): Promise<T> {
  const t = await setupAuth();
  process.env.RULEBOX_PLATFORM_KEY = base64Encode(Uint8Array.from({ length: 32 }, (_, i) => i));
  await t.action(internal.platform.setSecret, { name: "resendApiKey", value: KEY });
  await t.action(internal.platform.setSecret, { name: "resendFrom", value: FROM });
  return t;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
  mailSettings.timeoutMs = MAIL_TIMEOUT_MS;
  delete process.env.RULEBOX_PLATFORM_KEY;
});

/** Nothing the sender logs carries the key, the recipient, the subject or the body. */
function expectQuietLogs(): void {
  const logged = JSON.stringify(warn.mock.calls);
  for (const s of [KEY, "ana@acme.test", MSG.subject, "SECRET"]) expect(logged).not.toContain(s);
}

describe("sendMail (Resend)", () => {
  test("no key configured: mail_off, nothing is fetched", async () => {
    const t = await setupAuth();
    const calls = mockFetch([]);
    expect(await t.action(internal.mail.send, MSG)).toEqual({ ok: false, reason: "mail_off" });
    // A master key but no Resend settings: still off.
    process.env.RULEBOX_PLATFORM_KEY = base64Encode(Uint8Array.from({ length: 32 }, (_, i) => i));
    expect(await t.action(internal.mail.send, MSG)).toEqual({ ok: false, reason: "mail_off" });
    expect(calls).toHaveLength(0);
  });

  test("ok: one POST with the Bearer key, an idempotency key and a plain-text JSON body", async () => {
    const t = await configured();
    const calls = mockFetch([new Response('{"id":"x"}', { status: 200 })]);
    expect(await t.action(internal.mail.send, MSG)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(RESEND_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(init.body as string)).toEqual({ from: FROM, to: ["ana@acme.test"], subject: MSG.subject, text: MSG.text });
    expectQuietLogs();
  });

  test("provider error (4xx): failed, no retry, no provider text leaks", async () => {
    const t = await configured();
    const calls = mockFetch([new Response('{"message":"Invalid `from` field: re_secret"}', { status: 422 })]);
    expect(await t.action(internal.mail.send, MSG)).toEqual({ ok: false, reason: "failed" });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Invalid");
    expectQuietLogs();
  });

  test("5xx or network error: exactly one retry with the same idempotency key", async () => {
    const t = await configured();
    let calls = mockFetch([new Response("", { status: 503 }), new Response("{}", { status: 200 })]);
    expect(await t.action(internal.mail.send, MSG)).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    const key = (c: Call) => (c.init.headers as Record<string, string>)["Idempotency-Key"];
    expect(key(calls[0]!)).toBe(key(calls[1]!));
    calls = mockFetch(["throw", "throw", "throw"]);
    expect(await t.action(internal.mail.send, MSG)).toEqual({ ok: false, reason: "failed" });
    expect(calls).toHaveLength(2);
    expectQuietLogs();
  });

  test("timeout: each attempt is aborted at the deadline; failed after one retry", async () => {
    const t = await configured();
    mailSettings.timeoutMs = 30;
    const calls = mockFetch(["hang", "hang"]);
    expect(await t.action(internal.mail.send, MSG)).toEqual({ ok: false, reason: "failed" });
    expect(calls).toHaveLength(2);
    expect(MAIL_TIMEOUT_MS).toBe(10_000);
  });

  test("a malformed message is refused before anything is fetched", async () => {
    const t = await configured();
    const calls = mockFetch([]);
    expect(await t.action(internal.mail.send, { ...MSG, to: "not-an-address" })).toEqual({ ok: false, reason: "invalid" });
    expect(await t.action(internal.mail.send, { ...MSG, subject: "a\r\nBcc: x@y.z" })).toEqual({ ok: false, reason: "invalid" });
    expect(calls).toHaveLength(0);
  });
});
