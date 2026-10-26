import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../data/types";
import { AppError, messageFor, messageForCode } from "./errors";
import { formatCount, plural } from "./format";
import { safeNext, withNext } from "./next";
import { signInMessage } from "./signin";
import { strings } from "./strings";

describe("safeNext (open-redirect guard)", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/devices/abc?x=1")).toBe("/devices/abc?x=1");
    expect(safeNext("/")).toBe("/");
  });
  it.each(["//evil.test", "https://evil.test", "http://evil.test/x", "/\\evil.test", "evil.test", "javascript:alert(1)", "", null, undefined, "/\u0000x", "/a\\b"])(
    "rejects %s",
    (value) => {
      expect(safeNext(value as string | null | undefined)).toBe("/");
    },
  );
  it("builds sign-in links with an encoded next", () => {
    expect(withNext("/sign-in", "/devices?group=a")).toBe("/sign-in?next=%2Fdevices%3Fgroup%3Da");
    expect(withNext("/sign-in", "//evil.test")).toBe("/sign-in");
  });
});

describe("messageFor", () => {
  it("has its own sentence for every ErrorCode", () => {
    const seen = new Set<string>();
    for (const code of ERROR_CODES) {
      const msg = messageFor(new AppError({ code }));
      expect(msg, code).toBeTruthy();
      expect(msg, code).not.toBe(strings.errors.unknown);
      seen.add(msg);
    }
    expect(seen.size).toBe(ERROR_CODES.length);
  });
  it("reads ConvexError-shaped errors ({ data: { code } })", () => {
    expect(messageFor({ data: { code: "stale_edit" } })).toBe(strings.errors.staleEdit);
  });
  it("uses the generic sentence for unknown errors", () => {
    expect(messageFor(new Error("boom"))).toBe(strings.errors.unknown);
    expect(messageFor("x")).toBe(strings.errors.unknown);
    expect(messageFor({ data: { code: 42 } })).toBe(strings.errors.unknown);
  });
  it("uses extra data where it helps", () => {
    expect(messageForCode("mfa_locked", { retryAfterMs: 15 * 60_000 })).toContain("15 minutes");
    expect(messageForCode("winget_unsupported", { detail: "only a user installer" })).toContain("only a user installer");
  });
  it("sign-in shows the rate-limit sentence and hides which credential was wrong", () => {
    expect(signInMessage(new AppError({ code: "rate_limited" }))).toBe(strings.errors.rateLimited);
    expect(signInMessage(new Error("InvalidSecret"))).toBe(strings.auth.wrongCredentials);
  });
});

describe("counts and plurals", () => {
  it("caps server counts", () => {
    expect(formatCount(501, 500)).toBe("500+");
    expect(formatCount(500, 500)).toBe("500");
    expect(formatCount(1001, 1000)).toBe("1,000+");
  });
  it("zero / one / many", () => {
    expect(strings.counts.devices(0)).toBe("0 devices");
    expect(strings.counts.devices(1)).toBe("1 device");
    expect(strings.counts.devices(2)).toBe("2 devices");
    expect(strings.groups.devices(501)).toBe("500+ devices");
    expect(plural(0, { one: "a", other: "b", zero: "none" })).toBe("none");
  });
});
