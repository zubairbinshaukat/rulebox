import { describe, expect, it } from "vitest";
import { decodeInf, MAX_MODELS, parseInfModels } from "./infModels";

const HP_INF = `
; Printer INF
[Version]
Signature="$Windows NT$"
Class=Printer

[Manufacturer]
%HP% = HP, NTamd64, NTamd64.10.0

[HP.NTamd64]
%Model1% = Install1, USBPRINT\\HP1
"HP Quoted Name" = Install2, USBPRINT\\HP2
%Model3%=Install3,USBPRINT\\HP3

[HP.NTamd64.10.0]
%Model4% = Install4, USBPRINT\\HP4

[HP.NTx86]
%X86Only% = InstallX, USBPRINT\\HPX

[Strings]
HP = "HP Inc."
Model1 = "HP LaserJet 4000 Series"   ; trailing comment
Model3 = "HP Color LaserJet; the one with a semicolon"
Model4 = HP DeskJet 2700
X86Only = "HP 32-bit only"
`;

describe("parseInfModels", () => {
  it("reads quoted names and %tokens% from the 64-bit model sections, in file order", () => {
    expect(parseInfModels(HP_INF)).toEqual([
      "HP LaserJet 4000 Series",
      "HP Quoted Name",
      "HP Color LaserJet; the one with a semicolon",
      "HP DeskJet 2700",
    ]);
  });

  it("without a 64-bit section the 32-bit one counts", () => {
    const inf = `[Manufacturer]\n%V%=Models,NTx86\n[Models.NTx86]\n%A%=Install\n[Strings]\nA="Old Printer"`;
    expect(parseInfModels(inf)).toEqual(["Old Printer"]);
  });

  it("an undecorated model section works, with a manufacturer that has no decoration at all", () => {
    const inf = `[Manufacturer]\n"Acme"=Models\n[Models]\n"Acme P1"=Install1\n"Acme P2"=Install2\n`;
    expect(parseInfModels(inf)).toEqual(["Acme P1", "Acme P2"]);
  });

  it("several manufacturers add up; a section named like a prefix of another does not leak", () => {
    const inf = [
      "[Manufacturer]",
      "%A% = ModelsA, NTamd64",
      "%B% = ModelsB, NTamd64",
      "[ModelsA.NTamd64]",
      '"A1" = I',
      "[ModelsB.NTamd64]",
      '"B1" = I',
      "[ModelsAB.NTamd64]",
      '"Not listed" = I',
    ].join("\n");
    expect(parseInfModels(inf)).toEqual(["A1", "B1"]);
  });

  it("tokens are case-insensitive, localized strings fill what the plain ones lack, %% is a percent sign", () => {
    const inf = [
      "[Manufacturer]",
      "%v% = M, NTamd64",
      "[M.NTamd64]",
      "%model% = I",
      "%Local% = I",
      "%Pct% = I",
      "[Strings]",
      'MODEL = "Plain Model"',
      "[Strings.0409]",
      'Local = "English Only"',
      'Model = "Ignored duplicate"',
      'Pct = "100%% Toner Printer"',
    ].join("\n");
    expect(parseInfModels(inf)).toEqual(["Plain Model", "English Only", "100% Toner Printer"]);
  });

  it("skips a model whose token is unknown, and names that the server would refuse", () => {
    const inf = ["[Manufacturer]", "%V% = M, NTamd64", "[M.NTamd64]", "%Unknown% = I", `"${"x".repeat(101)}" = I`, '"Fine" = I', '"" = I', "[Strings]", "V = V"].join("\n");
    expect(parseInfModels(inf)).toEqual(["Fine"]);
  });

  it("names are unique ignoring case, and at most 10 are returned", () => {
    const lines = ["[Manufacturer]", "%V% = M, NTamd64", "[M.NTamd64]", '"Same" = I', '"SAME" = I'];
    for (let i = 0; i < 15; i++) lines.push(`"Model ${i}" = I`);
    const names = parseInfModels(lines.join("\n"));
    expect(names).toHaveLength(MAX_MODELS);
    expect(names.slice(0, 3)).toEqual(["Same", "Model 0", "Model 1"]);
    expect(parseInfModels(lines.join("\n"), 3)).toEqual(["Same", "Model 0", "Model 1"]);
  });

  it("joins continued lines and ignores comment-only lines, CRLF and stray text before the first section", () => {
    const inf = "stray text\r\n[Manufacturer]\r\n%V% = M, \\\r\n NTamd64\r\n; comment\r\n[M.NTamd64]\r\n\"One\" = I, \\\r\n  HW1\r\n\"Two\" = I\r\n";
    expect(parseInfModels(inf)).toEqual(["One", "Two"]);
  });

  it("is not fooled by text that is not an INF", () => {
    for (const junk of ["", "hello", "[Manufacturer]", "[Manufacturer]\n= x\n%V% =", "\u0000\u0001garbage", "[Manufacturer]\n%V% = Missing, NTamd64"]) {
      expect(parseInfModels(junk), junk).toEqual([]);
    }
  });
});

describe("decodeInf", () => {
  const text = "[Manufacturer]\n%V% = M, NTamd64\n[M.NTamd64]\n\"Tëst Printer\" = I\n";

  it("UTF-16 with a byte order mark (what most vendor INFs are)", () => {
    const le = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      le[2 + i * 2] = c & 0xff;
      le[3 + i * 2] = c >> 8;
    }
    expect(decodeInf(le)).toBe(text);
    expect(parseInfModels(decodeInf(le))).toEqual(["Tëst Printer"]);

    const be = new Uint8Array(2 + text.length * 2);
    be.set([0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      be[2 + i * 2] = c >> 8;
      be[3 + i * 2] = c & 0xff;
    }
    expect(decodeInf(be)).toBe(text);
  });

  it("UTF-8, with or without a byte order mark", () => {
    const body = new TextEncoder().encode(text);
    expect(decodeInf(body)).toBe(text);
    expect(decodeInf(new Uint8Array([0xef, 0xbb, 0xbf, ...body]))).toBe(text);
  });

  it("falls back to Windows-1252 for an 'ANSI' INF", () => {
    const ansi = Uint8Array.from(Array.from(text, (ch) => (ch === "ë" ? 0xeb : ch.charCodeAt(0))));
    expect(decodeInf(ansi)).toBe(text);
  });

  it("empty input is empty text", () => {
    expect(decodeInf(new Uint8Array())).toBe("");
  });
});
