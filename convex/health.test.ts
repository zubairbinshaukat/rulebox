import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

test("health.ping answers ok", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.health.ping, {});
  expect(result.ok).toBe(true);
});
