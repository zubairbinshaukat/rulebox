import { describe, expect, it } from "vitest";
import { addressProblem, defaultDriverFor, driverChoices, INBOX_DRIVERS, isHost, parsePrinterAddress, portProblem, printerNameProblem, queueProblem } from "./printerRules";

describe("parsePrinterAddress (one address field decides the kind)", () => {
  it("a shared printer", () => {
    expect(parsePrinterAddress("\\\\print01\\hp")).toEqual({ kind: "share", address: "\\\\print01\\hp" });
    expect(parsePrinterAddress("  \\\\print01.acme.example\\Front desk  ")).toEqual({ kind: "share", address: "\\\\print01.acme.example\\Front desk" });
    expect(parsePrinterAddress("\\\\print01")).toBeNull();
    expect(parsePrinterAddress("\\\\print01\\a,b")).toBeNull();
    expect(parsePrinterAddress("\\\\bad host\\hp")).toBeNull();
  });

  it("IPP addresses are kept, ipps and http are turned into the forms the server accepts", () => {
    expect(parsePrinterAddress("ipp://10.0.0.20:631/ipp/print")).toEqual({ kind: "ipp", address: "ipp://10.0.0.20:631/ipp/print" });
    expect(parsePrinterAddress("ipp://printer.acme.example/ipp/printer1")).toEqual({ kind: "ipp", address: "ipp://printer.acme.example/ipp/printer1" });
    expect(parsePrinterAddress("https://printer.acme.example/ipp/print")).toEqual({ kind: "ipp", address: "https://printer.acme.example/ipp/print" });
    expect(parsePrinterAddress("ipps://printer.acme.example:443/ipp/print")).toEqual({ kind: "ipp", address: "https://printer.acme.example:443/ipp/print" });
    expect(parsePrinterAddress("HTTP://10.0.0.20:631/ipp/print")).toEqual({ kind: "ipp", address: "ipp://10.0.0.20:631/ipp/print" });
    expect(parsePrinterAddress("http://10.0.0.20/ipp/print")).toEqual({ kind: "ipp", address: "ipp://10.0.0.20:80/ipp/print" });
    expect(parsePrinterAddress("ipp://[fe80::1]:631/ipp/print")).toEqual({ kind: "ipp", address: "ipp://[fe80::1]:631/ipp/print" });
    // No path typed: the usual one.
    expect(parsePrinterAddress("ipp://10.0.0.20")).toEqual({ kind: "ipp", address: "ipp://10.0.0.20/ipp/print" });
    expect(parsePrinterAddress("https://10.0.0.20/")).toEqual({ kind: "ipp", address: "https://10.0.0.20/ipp/print" });
    // Not acceptable as IPP.
    expect(parsePrinterAddress("ipp://u:p@10.0.0.20/ipp/print")).toBeNull();
    expect(parsePrinterAddress("ipp://10.0.0.20:0/ipp/print")).toBeNull();
    expect(parsePrinterAddress("ipp://999.0.0.1/ipp/print")).toBeNull();
    expect(parsePrinterAddress("ipp:///ipp/print")).toBeNull();
    expect(parsePrinterAddress("ipp://10.0.0.20/ipp/pri nt")).toBeNull();
  });

  it("lpr:// gives the host and the queue", () => {
    expect(parsePrinterAddress("lpr://10.0.0.20/lp")).toEqual({ kind: "lpr", address: "10.0.0.20", queue: "lp" });
    expect(parsePrinterAddress("LPD://print01.acme.example/Front")).toEqual({ kind: "lpr", address: "print01.acme.example", queue: "Front" });
    expect(parsePrinterAddress("lpr://[fe80::1]/lp")).toEqual({ kind: "lpr", address: "fe80::1", queue: "lp" });
    expect(parsePrinterAddress("lpr://10.0.0.20")).toBeNull();
    expect(parsePrinterAddress("lpr://10.0.0.20/")).toBeNull();
    expect(parsePrinterAddress("lpr://10.0.0.20/my queue")).toBeNull();
    expect(parsePrinterAddress("lpr://bad host/lp")).toBeNull();
  });

  it("host:port is raw, except 631 which is IPP", () => {
    expect(parsePrinterAddress("10.0.0.20:9100")).toEqual({ kind: "raw", address: "10.0.0.20", port: 9100 });
    expect(parsePrinterAddress("printer.acme.example:9101")).toEqual({ kind: "raw", address: "printer.acme.example", port: 9101 });
    expect(parsePrinterAddress("[fe80::1]:9100")).toEqual({ kind: "raw", address: "fe80::1", port: 9100 });
    expect(parsePrinterAddress("10.0.0.20:631")).toEqual({ kind: "ipp", address: "ipp://10.0.0.20:631/ipp/print" });
    expect(parsePrinterAddress("10.0.0.20:0")).toBeNull();
    expect(parsePrinterAddress("10.0.0.20:70000")).toBeNull();
    expect(parsePrinterAddress("10.0.0.20:abc")).toBeNull();
    expect(parsePrinterAddress("10.0.0.20:")).toBeNull();
  });

  it("a bare IPv4, IPv6 or name is IPP with the usual path", () => {
    expect(parsePrinterAddress("10.0.0.20")).toEqual({ kind: "ipp", address: "ipp://10.0.0.20/ipp/print" });
    expect(parsePrinterAddress("  10.0.0.20 ")).toEqual({ kind: "ipp", address: "ipp://10.0.0.20/ipp/print" });
    expect(parsePrinterAddress("fe80::1")).toEqual({ kind: "ipp", address: "ipp://[fe80::1]/ipp/print" });
    expect(parsePrinterAddress("::1")).toEqual({ kind: "ipp", address: "ipp://[::1]/ipp/print" });
    expect(parsePrinterAddress("[fe80::1]")).toEqual({ kind: "ipp", address: "ipp://[fe80::1]/ipp/print" });
    expect(parsePrinterAddress("front-desk.acme.example")).toEqual({ kind: "ipp", address: "ipp://front-desk.acme.example/ipp/print" });
    expect(parsePrinterAddress("printer")).toEqual({ kind: "ipp", address: "ipp://printer/ipp/print" });
    expect(parsePrinterAddress("printer.local/ipp/print")).toEqual({ kind: "ipp", address: "ipp://printer.local/ipp/print" });
    expect(parsePrinterAddress("10.0.0.20:8000/ipp/print")).toEqual({ kind: "ipp", address: "ipp://10.0.0.20:8000/ipp/print" });
  });

  it("junk is nothing", () => {
    for (const junk of ["", "   ", "999.1.1.1", "10.0.0", "a b", "-x.example", "ftp://10.0.0.20/x", "file:///c:/x", "smb://server/printer", "//server/printer", "/ipp/print", "x".repeat(300)]) {
      expect(parsePrinterAddress(junk), junk).toBeNull();
    }
  });

  it("everything it returns passes the server's own address check", () => {
    for (const typed of ["10.0.0.20", "fe80::1", "printer.local", "10.0.0.20:9100", "10.0.0.20:631", "ipps://p.example/ipp/print", "http://p.example:631/ipp/print", "\\\\s\\p", "lpr://h.example/q"]) {
      const parsed = parsePrinterAddress(typed);
      expect(parsed, typed).not.toBeNull();
      expect(addressProblem(parsed!.kind, parsed!.address), typed).toBeNull();
    }
  });

  it("a raw host longer than 48 characters parses and is refused by the normal check, in words of its own", () => {
    const long = `${"a".repeat(30)}.${"b".repeat(20)}`;
    const parsed = parsePrinterAddress(`${long}:9100`);
    expect(parsed).toEqual({ kind: "raw", address: long, port: 9100 });
    expect(addressProblem("raw", parsed!.address)).toBe("length");
  });
});

describe("defaultDriverFor ('Automatic')", () => {
  it("IPP class driver for IPP, PCL6 class driver for the rest, always one Windows ships", () => {
    expect(defaultDriverFor("ipp")).toBe("Microsoft IPP Class Driver");
    for (const kind of ["raw", "lpr", "share"] as const) expect(defaultDriverFor(kind)).toBe("Microsoft PCL6 Class Driver");
    for (const kind of ["ipp", "raw", "lpr", "share"] as const) expect(INBOX_DRIVERS).toContain(defaultDriverFor(kind));
  });
});

// The same vectors as the server's `convex/printerAddress.test.ts`.
describe("printer rules", () => {
  it("hosts", () => {
    for (const ok of ["10.0.0.20", "printer", "front-desk.acme.example", "0.0.0.0", "::1", "fe80::1", "::ffff:10.0.0.1", "1:2:3:4:5:6:7:8"]) expect(isHost(ok), ok).toBe(true);
    for (const bad of ["", "999.1.1.1", "10.0.0", "-a.example", "a..b", "a b", "a_b.example", "10.0.0.20:631", "1:2:3:4:5:6:7:8:9", "1::2::3", "01.2.3.4"]) {
      expect(isHost(bad), bad).toBe(false);
    }
  });

  it("addresses by kind", () => {
    expect(addressProblem("ipp", "ipp://10.0.0.20:631/ipp/print")).toBeNull();
    expect(addressProblem("ipp", "https://printer.acme.example/ipp/print")).toBeNull();
    expect(addressProblem("ipp", "http://10.0.0.20/ipp/print")).toBe("scheme");
    expect(addressProblem("ipp", "ipp://u:p@10.0.0.20/ipp/print")).toBe("credentials");
    expect(addressProblem("ipp", "ipp://10.0.0.20")).toBe("path");
    expect(addressProblem("ipp", "ipp://10.0.0.20:0/ipp/print")).toBe("port");
    expect(addressProblem("ipp", "ipp://999.0.0.1/ipp/print")).toBe("host");
    expect(addressProblem("ipp", "ipp://10.0.0.20/ipp/pri nt")).toBe("characters");
    expect(addressProblem("raw", "10.0.0.20")).toBeNull();
    expect(addressProblem("raw", "10.0.0.20:9100")).toBe("host");
    expect(addressProblem("raw", `${"a".repeat(30)}.${"b".repeat(20)}`)).toBe("length");
    expect(addressProblem("lpr", "bad host")).toBe("host");
    expect(addressProblem("share", "\\\\print01\\hp")).toBeNull();
    expect(addressProblem("share", "print01\\hp")).toBe("share");
    expect(addressProblem("share", "\\\\print01\\a,b")).toBe("characters");
    expect(addressProblem("raw", "  ")).toBe("empty");
  });

  it("name, port, queue and the driver list", () => {
    expect(printerNameProblem("Front desk")).toBeNull();
    expect(printerNameProblem(" ")).toBe("empty");
    expect(printerNameProblem("x".repeat(61))).toBe("length");
    expect(printerNameProblem("A\\B")).toBe("characters");
    expect(portProblem("")).toBeNull();
    expect(portProblem("9101")).toBeNull();
    expect(portProblem("0")).toBe("range");
    expect(portProblem("70000")).toBe("range");
    expect(portProblem("9x")).toBe("range");
    expect(queueProblem("lp")).toBeNull();
    expect(queueProblem("")).toBe("required");
    expect(queueProblem("x".repeat(33))).toBe("length");
    expect(queueProblem("my queue")).toBe("characters");
    expect(driverChoices(["HP Universal Printing PCL 6", "microsoft ipp class driver"])).toEqual([
      "Microsoft IPP Class Driver",
      "Microsoft PCL6 Class Driver",
      "Microsoft PS Class Driver",
      "Generic / Text Only",
      "HP Universal Printing PCL 6",
    ]);
  });
});
