import { describe, expect, test } from "vitest";
import { ERROR_CODES as DASHBOARD_CODES } from "../apps/dashboard/src/data/types";
import { ERROR_CODES, fail } from "./lib/errors";

describe("error codes", () => {
  test("the dashboard mirrors the server's ErrorCode set exactly", () => {
    expect([...DASHBOARD_CODES].sort()).toEqual([...ERROR_CODES].sort());
  });

  test("fail throws a ConvexError with the code and only the given extras", () => {
    try {
      fail("rate_limited", { retryAfterMs: 1200.4 });
    } catch (e) {
      expect(e).toMatchObject({ data: { code: "rate_limited", retryAfterMs: 1201 } });
      expect(Object.keys((e as { data: object }).data).sort()).toEqual(["code", "retryAfterMs"]);
      return;
    }
    throw new Error("fail did not throw");
  });
});
