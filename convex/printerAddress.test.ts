import { describe, expect, test } from "vitest";
import { checkPrinterTarget, isHost, isIpv4, isIpv6, type PrinterKindName } from "./lib/printerAddress";
import { approvedPrinterDrivers, checkPrinterDriver, INBOX_PRINTER_DRIVERS } from "./lib/printerDrivers";

// Printer address and driver rules (Phase 5 Step 14, plan 4.15). The agent has the same vectors in
// `apps/agent/src/network/printers/tests.rs` (`address_vectors`): keep the two lists in step.

const detailOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    const data = (e as { data?: { field?: string; detail?: string } }).data;
    return `${data?.field}:${data?.detail}`;
  }
  return "ok";
};
const check = (kind: PrinterKindName, address: string, port?: number, queue?: string) => detailOf(() => checkPrinterTarget(kind, address, port, queue));

describe("hosts", () => {
  test("IPv4, IPv6 and DNS names", () => {
    for (const ok of ["10.0.0.20", "printer", "front-desk.acme.example", "a.b.c", "0.0.0.0", "255.255.255.255", "::1", "fe80::1", "2001:db8::8:800:200c:417a", "::ffff:10.0.0.1", "1:2:3:4:5:6:7:8"]) {
      expect(isHost(ok), ok).toBe(true);
    }
    for (const bad of ["", "999.1.1.1", "10.0.0", "10.0.0.256", "-a.example", "a-.example", "a..b", "a b", "a_b.example", "http://x", "x".repeat(64) + ".example", "1:2:3:4:5:6:7:8:9", "1::2::3", "::1.2.3.4::", "12345::1", "10.0.0.20:631"]) {
      expect(isHost(bad), bad).toBe(false);
    }
    expect(isHost(("a".repeat(63) + ".").repeat(3) + "a".repeat(61))).toBe(true); // 253 characters
    expect(isHost(("a".repeat(63) + ".").repeat(3) + "a".repeat(62))).toBe(false);
    expect(isIpv4("01.2.3.4")).toBe(false);
    expect(isIpv6("fe80::")).toBe(true);
  });
});

describe("checkPrinterTarget", () => {
  test("ipp: ipp:// or https:// with a path; the port lives in the URL; no credentials", () => {
    expect(checkPrinterTarget("ipp", "ipp://10.0.0.20:631/ipp/print", undefined, undefined)).toEqual({ address: "ipp://10.0.0.20:631/ipp/print", port: null, queue: null });
    expect(checkPrinterTarget("ipp", " HTTPS://Printer.acme.example/ipp/print ", undefined, undefined).address).toBe("https://Printer.acme.example/ipp/print");
    expect(checkPrinterTarget("ipp", "ipp://[2001:db8::1]:631/ipp/print", undefined, undefined).address).toBe("ipp://[2001:db8::1]:631/ipp/print");
    expect(check("ipp", "http://10.0.0.20/ipp/print")).toBe("address:scheme");
    expect(check("ipp", "10.0.0.20")).toBe("address:scheme");
    expect(check("ipp", "ipp://user:pw@10.0.0.20/ipp/print")).toBe("address:credentials");
    expect(check("ipp", "ipp://user@10.0.0.20/ipp/print")).toBe("address:credentials");
    expect(check("ipp", "ipp://10.0.0.20")).toBe("address:path");
    expect(check("ipp", "ipp://10.0.0.20/")).toBe("address:path");
    expect(check("ipp", "ipp://10.0.0.20:0/ipp/print")).toBe("address:port");
    expect(check("ipp", "ipp://10.0.0.20:65536/ipp/print")).toBe("address:port");
    expect(check("ipp", "ipp://10.0.0.20:abc/ipp/print")).toBe("address:port");
    expect(check("ipp", "ipp://999.0.0.1/ipp/print")).toBe("address:host");
    expect(check("ipp", "ipp://[::1/ipp/print")).toBe("address:host");
    expect(check("ipp", "ipp:///ipp/print")).toBe("address:host");
    expect(check("ipp", "ipp://10.0.0.20/ipp/pri nt")).toBe("address:characters");
    expect(check("ipp", "ipp://10.0.0.20:631/ipp/print", 631)).toBe("port:not_used");
    expect(check("ipp", "ipp://10.0.0.20/ipp/print", undefined, "q")).toBe("queue:not_used");
  });

  test("raw: a host, an optional port 1-65535, no queue; at most 48 characters", () => {
    expect(checkPrinterTarget("raw", "10.0.0.20", undefined, undefined)).toEqual({ address: "10.0.0.20", port: null, queue: null });
    expect(checkPrinterTarget("raw", "printer.acme.example", 9101, "  ")).toEqual({ address: "printer.acme.example", port: 9101, queue: null });
    expect(check("raw", "10.0.0.20", 0)).toBe("port:range");
    expect(check("raw", "10.0.0.20", 65536)).toBe("port:range");
    expect(check("raw", "10.0.0.20", 1.5)).toBe("port:range");
    expect(check("raw", "10.0.0.20:9100")).toBe("address:host");
    expect(check("raw", "tcp://10.0.0.20")).toBe("address:host");
    expect(check("raw", "10.0.0.20", undefined, "queue")).toBe("queue:not_used");
    expect(check("raw", `${"a".repeat(30)}.${"b".repeat(20)}`)).toBe("address:length");
    expect(check("raw", "")).toBe("address:empty");
    expect(check("raw", "a".repeat(256))).toBe("address:length");
  });

  test("lpr: a host and a queue (at most 32 characters, no spaces); no port", () => {
    expect(checkPrinterTarget("lpr", "10.0.0.20", undefined, "lp")).toEqual({ address: "10.0.0.20", port: null, queue: "lp" });
    expect(check("lpr", "10.0.0.20")).toBe("queue:required");
    expect(check("lpr", "10.0.0.20", undefined, "x".repeat(33))).toBe("queue:length");
    expect(check("lpr", "10.0.0.20", undefined, "my queue")).toBe("queue:characters");
    expect(check("lpr", "10.0.0.20", 515, "lp")).toBe("port:not_used");
    expect(check("lpr", "bad host", undefined, "lp")).toBe("address:host");
  });

  test("share: \\\\server\\queue only", () => {
    expect(checkPrinterTarget("share", "\\\\print01\\Front desk", undefined, undefined).address).toBe("\\\\print01\\Front desk");
    expect(checkPrinterTarget("share", "\\\\10.0.0.5\\hp", undefined, undefined).address).toBe("\\\\10.0.0.5\\hp");
    expect(check("share", "print01\\hp")).toBe("address:share");
    expect(check("share", "\\\\print01")).toBe("address:share");
    expect(check("share", "\\\\print01\\a\\b")).toBe("address:share");
    expect(check("share", "//print01/hp")).toBe("address:share");
    expect(check("share", "\\\\bad host\\hp")).toBe("address:host");
    expect(check("share", "\\\\print01\\a,b")).toBe("address:characters");
    expect(check("share", "\\\\print01\\hp", 9100)).toBe("port:not_used");
  });
});

describe("approved drivers", () => {
  test("the inbox list plus what the organization added, without duplicates", () => {
    expect(approvedPrinterDrivers(undefined)).toEqual([...INBOX_PRINTER_DRIVERS]);
    expect(approvedPrinterDrivers(["HP Universal Printing PCL 6", "microsoft ipp class driver"])).toEqual([...INBOX_PRINTER_DRIVERS, "HP Universal Printing PCL 6"]);
  });

  test("a driver outside the list, an empty one and a long one are refused; the listed spelling is returned", () => {
    const list = approvedPrinterDrivers(["HP Universal Printing PCL 6"]);
    expect(checkPrinterDriver("  microsoft pcl6 class driver ", list)).toBe("Microsoft PCL6 Class Driver");
    expect(detailOf(() => checkPrinterDriver("HP Evil Driver", list))).toBe("driver:not_approved");
    expect(detailOf(() => checkPrinterDriver("", list))).toBe("driver:empty");
    expect(detailOf(() => checkPrinterDriver("x".repeat(101), list))).toBe("driver:length");
  });
});
