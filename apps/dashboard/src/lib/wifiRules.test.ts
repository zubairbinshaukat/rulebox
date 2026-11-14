import { describe, expect, it } from "vitest";
import { MAX_SSID_BYTES, passphraseProblem, ssidBytes, ssidProblem } from "./wifiRules";

describe("Wi-Fi rules (mirror of the server)", () => {
  it("an SSID is 1 to 32 bytes of UTF-8, not characters", () => {
    expect(ssidBytes("Café")).toBe(5);
    expect(ssidBytes("日本")).toBe(6);
    expect(ssidProblem("")).toBe("empty");
    expect(ssidProblem("a".repeat(MAX_SSID_BYTES))).toBeNull();
    expect(ssidProblem("a".repeat(MAX_SSID_BYTES + 1))).toBe("tooLong");
    expect(ssidProblem("é".repeat(16))).toBeNull(); // 32 bytes
    expect(ssidProblem("é".repeat(17))).toBe("tooLong"); // 34 bytes
    expect(ssidProblem("with space and & < > \" '")).toBeNull();
  });

  it("refuses control characters and keeps spaces", () => {
    expect(ssidProblem("a\nb")).toBe("control");
    expect(ssidProblem("a\u0000b")).toBe("control");
    expect(ssidProblem("a\u007fb")).toBe("control");
    expect(ssidProblem("a\u0085b")).toBe("control");
    expect(ssidProblem(" lead and trail ")).toBeNull();
  });

  it("a passphrase is 8 to 63 printable ASCII characters, or 64 hexadecimal digits", () => {
    expect(passphraseProblem("")).toBe("empty");
    expect(passphraseProblem("1234567")).toBe("length");
    expect(passphraseProblem("12345678")).toBeNull();
    expect(passphraseProblem("a".repeat(63))).toBeNull();
    expect(passphraseProblem("a".repeat(64))).toBeNull(); // hexadecimal: the raw key
    expect(passphraseProblem("g".repeat(64))).toBe("length"); // 64 but not hex
    expect(passphraseProblem("ABCDEF0123456789".repeat(4))).toBeNull();
    expect(passphraseProblem("with spaces and !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")).toBeNull();
    expect(passphraseProblem("pässwörd-123")).toBe("chars");
    expect(passphraseProblem("tab\there1")).toBe("chars");
  });
});
