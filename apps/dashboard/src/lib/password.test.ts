import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_ALPHABET, PASSWORD_LENGTH, generatePassword } from "./password";
import * as v from "./validate";

afterEach(() => vi.restoreAllMocks());

describe("generatePassword", () => {
  it("is 12 characters in three groups of four, 14 with the dashes", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
      expect(p).toHaveLength(14);
      expect(p.replaceAll("-", "")).toHaveLength(PASSWORD_LENGTH);
    }
  });

  it("uses only the alphabet without look-alikes", () => {
    expect(PASSWORD_ALPHABET).toHaveLength(31);
    for (const bad of "0o1li") expect(PASSWORD_ALPHABET).not.toContain(bad);
    for (let i = 0; i < 200; i++) {
      for (const c of generatePassword().replaceAll("-", "")) expect(PASSWORD_ALPHABET).toContain(c);
    }
  });

  it("passes the employee password rule, whatever the user name", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(v.employeePassword(p, "maria.fernanda")).toBeNull();
      expect(v.employeePassword(p, "")).toBeNull();
    }
  });

  it("gives a different password each time", () => {
    const seen = new Set(Array.from({ length: 100 }, generatePassword));
    expect(seen.size).toBe(100);
  });

  it("draws from crypto.getRandomValues, never Math.random", () => {
    const random = vi.spyOn(Math, "random");
    const spy = vi.spyOn(crypto, "getRandomValues");
    generatePassword();
    expect(spy).toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it("throws away bytes that would favour the first characters (rejection sampling)", () => {
    // 248 = 31 * 8 is the first byte that must be rejected. Bytes 248..255 first, then 0, 1, 2, ...: only the later ones count.
    let call = 0;
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) array[i] = call === 0 ? 248 + (i % 8) : i % 31;
      call++;
      return array;
    }) as typeof crypto.getRandomValues);
    const p = generatePassword().replaceAll("-", "");
    // The first call (all rejected) contributes nothing: the password is built from the second call (bytes 0, 1, 2, ...).
    expect(p).toBe(PASSWORD_ALPHABET.slice(0, PASSWORD_LENGTH));
    expect(call).toBeGreaterThanOrEqual(2);
  });
});
