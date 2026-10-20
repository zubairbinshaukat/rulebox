import { describe, expect, it } from "vitest";
import { formatBytes, formatStorageDetail, getStorageThreshold } from "./storage";

describe("storage bar thresholds (79%, 80%, 95%, 100%)", () => {
  const limit = 10 * 1024 * 1024 * 1024; // 10 GB

  it("threshold <80% (79%): normal state", () => {
    const used = 7.9 * 1024 * 1024 * 1024; // 7.9 GB = 79%
    const res = getStorageThreshold(used, limit);
    expect(res.pct).toBeCloseTo(79, 0);
    expect(res.status).toBe("normal");
    expect(res.tone).toBe("accent");
    expect(res.actionText).toBeNull();
    expect(res.banner).toBeNull();
    expect(res.isBlocked).toBe(false);
  });

  it("threshold 80%: turns warning with 'Free up space'", () => {
    const used = 8.0 * 1024 * 1024 * 1024; // 8.0 GB = 80%
    const res = getStorageThreshold(used, limit);
    expect(res.pct).toBeCloseTo(80, 0);
    expect(res.status).toBe("warning");
    expect(res.tone).toBe("warning");
    expect(res.actionText).toBe("Free up space");
    expect(res.banner).toBeNull();
    expect(res.isBlocked).toBe(false);
  });

  it("threshold 95%: turns strong warning with danger tone and 'Free up space'", () => {
    const used = 9.5 * 1024 * 1024 * 1024; // 9.5 GB = 95%
    const res = getStorageThreshold(used, limit);
    expect(res.pct).toBeCloseTo(95, 0);
    expect(res.status).toBe("strongWarning");
    expect(res.tone).toBe("danger");
    expect(res.actionText).toBe("Free up space");
    expect(res.banner).toBeNull();
    expect(res.isBlocked).toBe(false);
  });

  it("threshold 100%: blocked banner 'Storage is full. Delete files to save new ones.'", () => {
    const used = 10.0 * 1024 * 1024 * 1024; // 10 GB = 100%
    const res = getStorageThreshold(used, limit);
    expect(res.pct).toBe(100);
    expect(res.status).toBe("blocked");
    expect(res.tone).toBe("danger");
    expect(res.actionText).toBe("Free up space");
    expect(res.banner).toBe("Storage is full. Delete files to save new ones.");
    expect(res.isBlocked).toBe(true);
  });

  it("over 100% (e.g. 110%): clamps bar percentage to 100, retains blocked banner", () => {
    const used = 11.0 * 1024 * 1024 * 1024;
    const res = getStorageThreshold(used, limit);
    expect(res.pct).toBe(100);
    expect(res.status).toBe("blocked");
    expect(res.isBlocked).toBe(true);
    expect(res.banner).toBe("Storage is full. Delete files to save new ones.");
  });

  it("unlimited quota (limit = 0): shows used amount without threshold alarms", () => {
    const used = 5 * 1024 * 1024 * 1024;
    const res = getStorageThreshold(used, 0);
    expect(res.pct).toBe(0);
    expect(res.status).toBe("normal");
    expect(res.tone).toBe("accent");
    expect(res.banner).toBeNull();
    expect(res.isBlocked).toBe(false);
  });

  it("formatBytes and formatStorageDetail format correctly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(6.2 * 1024 * 1024 * 1024)).toBe("6.2 GB");
    expect(formatStorageDetail(6.2 * 1024 * 1024 * 1024, 10 * 1024 * 1024 * 1024)).toBe(
      "6.2 GB of 10 GB",
    );
  });
});
