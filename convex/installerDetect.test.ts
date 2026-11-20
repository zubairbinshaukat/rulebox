import { describe, expect, test } from "vitest";
import { buildOle, buildPe, certificateTable, FIXTURES, tlv } from "../tests/convex/installerFixtures";
import { certificateRange, DETECTED_TECHS, detectInstaller, INSPECT_CERT_MAX_BYTES, prefillFor, type DetectedTech } from "./lib/installerDetect";

// The detector of plan 4.7 against small hand-built fixtures (`tests/convex/installerFixtures.ts`: no third-party bytes).

const detect = (head: Uint8Array, rest: { tail?: Uint8Array; cert?: Uint8Array } = {}) => detectInstaller({ head, ...rest });

describe("detectInstaller: every technology of plan 4.7", () => {
  const cases: [string, () => Uint8Array, DetectedTech, "high" | "medium" | "low", string[], number[]][] = [
    ["MSI (OLE header)", FIXTURES.msi, "msi", "high", [], [0]],
    ["NSIS by its manifest name", () => FIXTURES.nsisHigh(), "nsis", "high", ["/S"], [0]],
    ["NSIS by the first word of the description", FIXTURES.nsisMedium, "nsis", "medium", ["/S"], [0]],
    ["NSIS by its header marker", FIXTURES.nsisString, "nsis", "medium", ["/S"], [0]],
    ["Inno Setup by the description", FIXTURES.innoHigh, "inno", "high", ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], [0]],
    ["Inno Setup by its data marker", FIXTURES.innoString, "inno", "medium", ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], [0]],
    ["WiX Burn by its .wixburn section", FIXTURES.burnHigh, "burn", "high", ["/quiet", "/norestart"], [0, 3010, 1641]],
    ["WiX Burn by the description", FIXTURES.burnLow, "burn", "low", ["/quiet", "/norestart"], [0, 3010, 1641]],
    ["InstallShield with an MSI inside", FIXTURES.installshieldMsi, "installshield_msi", "low", ["/s", "/v/qn"], [0, 3010, 1641]],
    ["InstallShield InstallScript (UTF-16 marker, no MSI)", FIXTURES.installshieldScript, "installshield_script", "low", ["/s", "/f1{AnswerFile}"], [0]],
    ["Advanced Installer", FIXTURES.advancedInstaller, "advanced_installer", "low", ["/exenoui", "/qn", "/norestart"], [0, 3010, 1641]],
    ["an unknown EXE", FIXTURES.plainExe, "exe", "low", [], [0]],
  ];

  test.each(cases)("%s", (_name, make, tech, confidence, silentArgs, codes) => {
    const r = detect(make());
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ tech, confidence, silentArgs, successExitCodes: codes });
    expect(r!.kind).toBe(tech === "msi" ? "msi" : "exe");
  });

  test("only InstallScript needs an answer file", () => {
    for (const [, make, tech] of cases) expect(detect(make())!.needsAnswerFile, tech).toBe(tech === "installshield_script");
  });

  test("every technology has a pre-fill, and the pre-fill is a copy the caller may edit", () => {
    for (const t of DETECTED_TECHS) {
      const p = prefillFor(t);
      expect(p.successExitCodes[0], t).toBe(0);
      p.silentArgs.push("/x");
      p.successExitCodes.push(5);
      expect(prefillFor(t).silentArgs).not.toContain("/x");
      expect(prefillFor(t).successExitCodes).not.toContain(5);
    }
  });

  test("the specific markers win over the weak string markers", () => {
    // A Burn bundle that also mentions Advanced Installer and InstallShield in its text is still Burn.
    const r = detect(buildPe({ sections: [".wixburn"], overlay: Array.from(new TextEncoder().encode("Advanced Installer InstallShield")) }));
    expect(r?.tech).toBe("burn");
  });
});

describe("detectInstaller: what the file says about itself", () => {
  test("version fields, product, company and the execution level", () => {
    const r = detect(FIXTURES.nsisHigh())!;
    expect(r).toMatchObject({ fileVersion: "1.2.3.4", productName: "Fixture App", companyName: "Fixture Co", executionLevel: "asInvoker" });
  });

  test("NSIS that asks for no elevation may be a per-user installer (heuristic); other cases never warn", () => {
    expect(detect(FIXTURES.nsisHigh("asInvoker"))!.perUserLikely).toBe(true);
    expect(detect(FIXTURES.nsisHigh("requireAdministrator"))!.perUserLikely).toBe(false);
    // Inno also says asInvoker (it elevates itself): no warning, the plan names NSIS only.
    expect(detect(FIXTURES.innoHigh())!.perUserLikely).toBe(false);
    expect(detect(FIXTURES.msi())!.perUserLikely).toBe(false);
  });

  test("a file without resources still gets its technology from the marker strings", () => {
    const r = detect(buildPe({ manifest: "<x/>", noResources: true, overlay: Array.from(new TextEncoder().encode("NullsoftInst")) }));
    expect(r).toMatchObject({ tech: "nsis", confidence: "medium" });
    expect(r!.executionLevel).toBeUndefined();
  });

  test("markers in the tail count when they are not in the head", () => {
    const head = buildPe();
    expect(detect(head)!.tech).toBe("exe");
    expect(detect(head, { tail: Uint8Array.from(new TextEncoder().encode("..Inno Setup Setup Data (6.0)")) })!.tech).toBe("inno");
  });

  test("an OLE header that is not at the start of the file is not an MSI", () => {
    const shifted = new Uint8Array(64);
    shifted.set(buildOle(32), 16);
    expect(detect(shifted)).toBeNull();
  });
});

describe("detectInstaller: the claimed signer (display only)", () => {
  test("is the signer's own certificate, not the first one in the file", () => {
    const pe = buildPe({ manifest: "<x/>", certificate: certificateTable("Fixture Software Ltd") });
    expect(detect(pe)!.signer).toBe("Fixture Software Ltd");
    const first = buildPe({ manifest: "<x/>", certificate: certificateTable("Leaf First", { signerFirst: true }) });
    expect(detect(first)!.signer).toBe("Leaf First");
  });

  test("reads a BMPString name and falls back to the organization without a common name", () => {
    expect(detect(buildPe({ certificate: certificateTable("Zahras POS", { bmp: true }) }))!.signer).toBe("Zahras POS");
  });

  test("an unsigned file, an unreadable table and a table of another type give no signer", () => {
    expect(detect(buildPe({ manifest: "<x/>" }))!.signer).toBeUndefined();
    const table = certificateTable("Nobody");
    const wrongType = Uint8Array.from(table);
    wrongType[6] = 0x01;
    expect(detect(buildPe({ certificate: wrongType }))!.signer).toBeUndefined();
    const garbage = Uint8Array.from([0x20, 0, 0, 0, 0, 2, 2, 0, ...new Array<number>(40).fill(0xff)]);
    expect(detect(buildPe({ certificate: garbage }))!.signer).toBeUndefined();
    const cut = table.subarray(0, 40);
    expect(detect(buildPe({ certificate: cut }))!.signer).toBeUndefined();
  });

  test("the table can come separately when it lies outside the head", () => {
    const table = certificateTable("Far Away Ltd");
    const full = buildPe({ manifest: "<x/>", certificate: table });
    const range = certificateRange(full)!;
    expect(range.size).toBe(table.length);
    const head = full.subarray(0, range.offset);
    expect(detect(head)!.signer).toBeUndefined();
    expect(detect(head, { cert: table })!.signer).toBe("Far Away Ltd");
  });

  test("a control character in a name is dropped (the text goes on screen)", () => {
    expect(detect(buildPe({ certificate: certificateTable("Evil\u0007\u001bName") }))!.signer).toBe("EvilName");
  });
});

describe("certificateRange", () => {
  test("null for a file without a table, for an MSI, and for a table above the cap", () => {
    expect(certificateRange(buildPe())).toBeNull();
    expect(certificateRange(buildOle())).toBeNull();
    const big = new Uint8Array(INSPECT_CERT_MAX_BYTES + 8);
    expect(certificateRange(buildPe({ certificate: big }))).toBeNull();
  });
});

describe("detectInstaller: garbage and truncated input", () => {
  test("not a program and not an MSI: null", () => {
    expect(detect(new Uint8Array(0))).toBeNull();
    expect(detect(Uint8Array.from([0x4d]))).toBeNull();
    expect(detect(new TextEncoder().encode("<html>not found</html>"))).toBeNull();
    expect(detect(new Uint8Array(4096).fill(0xff))).toBeNull();
    expect(detect(Uint8Array.from([0x50, 0x4b, 3, 4, ...new Array<number>(100).fill(1)]))).toBeNull(); // a zip
  });

  test("MZ without a PE signature, or with a PE offset outside the file: null", () => {
    const b = new Uint8Array(128);
    b.set([0x4d, 0x5a]);
    expect(detect(b)).toBeNull();
    b.set([0xff, 0xff, 0xff, 0x7f], 0x3c);
    expect(detect(b)).toBeNull();
  });

  test("a PE that is cut at any length never throws and is either null or a low-risk answer", () => {
    const full = buildPe({ sections: [".wixburn"], manifest: "<description>Inno Setup</description>", version: { FileVersion: "9.9" }, certificate: certificateTable("Cut Co") });
    for (let n = 0; n <= full.length; n += 13) {
      const r = detect(full.subarray(0, n));
      if (r !== null) expect(DETECTED_TECHS).toContain(r.tech);
    }
    // Cut inside the section table: a PE with no readable sections is a plain EXE.
    expect(detect(full.subarray(0, 0x150))!.tech).toBe("exe");
    // Cut after the section table: the .wixburn section is there again.
    expect(detect(full.subarray(0, 0x400))!.tech).toBe("burn");
  });

  test("a resource tree that points outside the file, or loops on itself, is ignored", () => {
    const pe = buildPe({ manifest: "<description>Inno Setup</description>" });
    // Point the first resource entry at itself (offset 0 of the section, directory bit set).
    const loop = Uint8Array.from(pe);
    const rsrcRaw = 0x400 + 0x200; // header, then .text, then .rsrc
    loop.set([0, 0, 0, 0x80], rsrcRaw + 16 + 4);
    expect(() => detect(loop)).not.toThrow();
    expect(detect(loop)!.tech).toBe("exe");
    // A resource RVA far beyond the file.
    const far = Uint8Array.from(pe);
    far.set([0xff, 0xff, 0xff, 0x0f], 0x58 + 96 + 16);
    expect(detect(far)!.tech).toBe("exe");
  });

  test("hostile DER lengths in the certificate table never throw", () => {
    const bad = Uint8Array.from([...certificateTable("Ok").subarray(0, 8), 0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 1, 2, 3]);
    new DataView(bad.buffer).setUint32(0, bad.length, true);
    expect(detect(buildPe({ certificate: bad }))!.signer).toBeUndefined();
    const deep = Uint8Array.from([...certificateTable("Ok").subarray(0, 8), ...tlv(0x30, tlv(0x06, [1]), tlv(0xa0, tlv(0x30, tlv(0xa0, tlv(0x31)))))]);
    new DataView(deep.buffer).setUint32(0, deep.length, true);
    expect(detect(buildPe({ certificate: deep }))!.signer).toBeUndefined();
  });
});
