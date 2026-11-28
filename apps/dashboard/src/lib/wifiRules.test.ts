import { describe, expect, it } from "vitest";
import { DEFAULT_WIFI_NAME, defaultWifiName, MAX_SSID_BYTES, MAX_WIFI_NAME, passphraseProblem, showSsidCounter, ssidBytes, ssidProblem } from "./wifiRules";

describe("defaultWifiName (the name Rulebox shows before the admin edits it)", () => {
  it("is the Wi-Fi name, trimmed", () => {
    expect(defaultWifiName("Shop floor")).toBe("Shop floor");
    expect(defaultWifiName("  Shop floor  ")).toBe("Shop floor");
    expect(defaultWifiName("A&B <\"it's\">")).toBe("A&B <\"it's\">");
  });

  it("falls back when nothing is left", () => {
    expect(defaultWifiName("")).toBe(DEFAULT_WIFI_NAME);
    expect(defaultWifiName("   ")).toBe("Wi-Fi network");
    expect(defaultWifiName("\u0007\u0000")).toBe("Wi-Fi network");
  });

  it("drops control characters and is at most 60 characters (not bytes), trimmed again after the cut", () => {
    expect(defaultWifiName("a\u0007b")).toBe("ab");
    expect(defaultWifiName("x".repeat(80))).toBe("x".repeat(MAX_WIFI_NAME));
    expect(defaultWifiName("é".repeat(40))).toBe("é".repeat(40)); // 80 bytes, 40 characters
    expect(defaultWifiName(`${"y".repeat(59)} tail`)).toBe("y".repeat(59)); // the cut lands on the space
    expect(Array.from(defaultWifiName("😀".repeat(70)))).toHaveLength(MAX_WIFI_NAME); // code points, never half a pair
  });
});

describe("the byte counter", () => {
  it("shows only near or over the 32-byte limit", () => {
    expect(showSsidCounter("Shop floor")).toBe(false);
    expect(showSsidCounter("a".repeat(24))).toBe(false);
    expect(showSsidCounter("a".repeat(25))).toBe(true);
    expect(showSsidCounter("é".repeat(13))).toBe(true); // 26 bytes
    expect(showSsidCounter("a".repeat(40))).toBe(true);
  });
});

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
