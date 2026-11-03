// scripts/platform-secret.mjs (Phase 4b Part C). Node environment. Uses a
// throwaway master key in a temporary folder that is deleted afterwards; never
// runs `convex run` (the runner is replaced) and never reads a real secret.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openSecret } from "../convex/lib/platformSecrets.ts";
import { generateMasterKey, main, parseMasterKey, seal } from "./platform-secret.mjs";

let dir = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env.RULEBOX_PLATFORM_KEY;
});

function io(value = "re_TestKeyNotReal_0123456789") {
  const lines = [];
  const runs = [];
  return {
    lines,
    runs,
    io: {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      readValue: async () => value,
      run: async (fn, args, prod) => {
        runs.push({ fn, args, prod });
        return 0;
      },
    },
  };
}

describe("platform-secret.mjs", () => {
  test("seal produces what the deployment decrypts (same format as lib/platformSecrets.ts)", async () => {
    const key = generateMasterKey();
    expect(parseMasterKey(key)).toHaveLength(32);
    const sealed = await seal(key, "resendApiKey", "re_TestKeyNotReal_0123456789");
    process.env.RULEBOX_PLATFORM_KEY = key;
    expect(await openSecret("resendApiKey", sealed)).toBe("re_TestKeyNotReal_0123456789");
    expect(await openSecret("resendFrom", sealed)).toBeNull(); // the name is bound
    process.env.RULEBOX_PLATFORM_KEY = generateMasterKey();
    expect(await openSecret("resendApiKey", sealed)).toBeNull();
  });

  test("generate-key writes a key file once; set sends only the ciphertext, never the value", async () => {
    dir = mkdtempSync(join(tmpdir(), "rulebox-platform-"));
    const file = join(dir, "platform.key");
    const a = io();
    expect(await main(["generate-key", "--out", file], a.io)).toBe(0);
    const key = readFileSync(file, "utf8").trim();
    expect(parseMasterKey(key)).toHaveLength(32);
    expect(a.lines.join("\n")).not.toContain(key);
    expect(await main(["generate-key", "--out", file], a.io)).toBe(1); // never overwrites

    const b = io();
    expect(await main(["set", "resendApiKey", "--key-file", file, "--prod"], b.io)).toBe(0);
    expect(b.runs).toHaveLength(1);
    expect(b.runs[0].fn).toBe("platform:storeSecret");
    expect(b.runs[0].prod).toBe(true);
    expect(Object.keys(b.runs[0].args).sort()).toEqual(["ciphertext", "iv", "name"]);
    expect(JSON.stringify(b.runs)).not.toContain("re_TestKeyNotReal_0123456789");
    expect(b.lines.join("\n")).not.toContain("re_TestKeyNotReal_0123456789");
    process.env.RULEBOX_PLATFORM_KEY = key;
    expect(await openSecret("resendApiKey", b.runs[0].args)).toBe("re_TestKeyNotReal_0123456789");
  });

  test("refuses unknown names, a missing key file, an empty or padded value; clear / status / check", async () => {
    dir = mkdtempSync(join(tmpdir(), "rulebox-platform-"));
    const file = join(dir, "platform.key");
    await main(["generate-key", "--out", file], io().io);
    expect(await main(["set", "githubToken", "--key-file", file], io().io)).toBe(2);
    expect(await main(["set", "resendApiKey"], io().io)).toBe(2);
    expect(await main(["set", "resendApiKey", "--key-file", join(dir, "missing")], io().io)).toBe(1);
    const empty = io("");
    expect(await main(["set", "resendApiKey", "--key-file", file], empty.io)).toBe(1);
    expect(empty.runs).toHaveLength(0);
    expect(await main(["set", "resendApiKey", "--key-file", file], io(" padded ").io)).toBe(1);
    const c = io();
    await main(["clear", "resendFrom"], c.io);
    await main(["status"], c.io);
    await main(["check"], c.io);
    expect(c.runs.map((r) => r.fn)).toEqual(["platform:clearSecret", "platform:status", "platform:checkSecrets"]);
    expect(await main([], io().io)).toBe(2);
  });
});
