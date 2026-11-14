import { describe, expect, it } from "vitest";
import { addressProblem, driverChoices, isHost, portProblem, printerNameProblem, queueProblem } from "./printerRules";

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
