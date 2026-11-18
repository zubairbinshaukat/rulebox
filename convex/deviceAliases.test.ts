import { describe, expect, test } from "vitest";
import { DEVICE_CALLS, publicFunctions, ROWS } from "../tests/convex/matrixRows";
import { IO_BUDGETS } from "./ioBudgets";

// Phase 6 Step 3: the four Phase 2 aliases are gone. The agent calls headState, ping and report.
const REMOVED = ["devices:heartbeat", "devices:desiredState", "deviceApi:reportAudit", "deviceApi:reportInstalls"];

/** Every public function a device can call: it lives in `devices` or `deviceApi` (plus enrollment). */
async function deviceCallable(): Promise<string[]> {
  const all = await publicFunctions();
  return [...all.keys()].filter((name) => name.startsWith("devices:") || name.startsWith("deviceApi:") || name === "enrollment:enroll").sort();
}

describe("the removed Phase 2 aliases", () => {
  test("the device-callable functions are the agent's current set", async () => {
    const names = await deviceCallable();
    for (const gone of REMOVED) expect(names, gone).not.toContain(gone);
    // What the agent calls (apps/agent/src/backend/convex.rs and reports.rs) is still there.
    for (const kept of [
      "enrollment:enroll", "devices:headState", "devices:fetchDesired", "devices:fetchRoster", "devices:ping", "devices:unenroll",
      "deviceApi:report", "deviceApi:verifyEmployee", "deviceApi:rotateCredential", "deviceApi:reportApply",
      "deviceApi:reportFindings", "deviceApi:reportSecurityDaily", "deviceApi:reportAcks", "deviceApi:registerSealKey",
    ]) {
      expect(names, kept).toContain(kept);
    }
  });

  test("no budget row, matrix row or device call remains for them", () => {
    for (const gone of REMOVED) {
      expect(Object.keys(IO_BUDGETS), gone).not.toContain(gone);
      expect(ROWS.map((r) => r.name), gone).not.toContain(gone);
      expect(Object.keys(DEVICE_CALLS), gone).not.toContain(gone);
    }
  });
});
