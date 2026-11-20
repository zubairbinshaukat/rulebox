// Installer fixtures for `convex/installerDetect.test.ts`, `convex/installerInspect.test.ts` and the dashboard's tests (Phase 6 Step 13).
//
// SOURCE AND LICENCE: every byte here is built by this file (a minimal PE32 header, section table, resource tree, certificate table and
// DER structures written from the public format documents). No third-party installer, stub or binary is copied or cut, so there is no
// third-party licence to record; the markers (`Nullsoft.NSIS.exehead`, `.wixburn`, ...) are the short names the detector looks for.
// Each fixture is a few hundred bytes to a few KiB.

const enc = new TextEncoder();

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const utf16 = (s: string): number[] => Array.from(s).flatMap((c) => u16(c.charCodeAt(0)));
const pad = (bytes: number[], to: number): number[] => (bytes.length % to === 0 ? bytes : [...bytes, ...new Array<number>(to - (bytes.length % to)).fill(0)]);

// ---------------------------------------------------------------- DER

function lengthOf(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, n >> 8, n & 0xff];
}
export const tlv = (tag: number, ...content: number[][]): number[] => {
  const body = content.flat();
  return [tag, ...lengthOf(body.length), ...body];
};
const oid = (...parts: number[]): number[] => tlv(0x06, parts);
const OID_CN = oid(0x55, 0x04, 0x03);
const OID_ORG = oid(0x55, 0x04, 0x0a);

/** `rdn("CN", "Zahras Software")`: one RDN. `bmp` writes the value as a BMPString (UTF-16BE) instead of a UTF8String. */
export function rdn(kind: "CN" | "O", text: string, bmp = false): number[] {
  const value = bmp ? tlv(0x1e, Array.from(text).flatMap((c) => [0, c.charCodeAt(0)])) : tlv(0x0c, Array.from(enc.encode(text)));
  return tlv(0x31, tlv(0x30, kind === "CN" ? OID_CN : OID_ORG, value));
}
export const name = (...rdns: number[][]): number[] => tlv(0x30, ...rdns);

function certificate(serial: number, issuer: number[], subject: number[]): number[] {
  const alg = tlv(0x30, oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), tlv(0x05));
  const validity = tlv(0x30, tlv(0x17, Array.from(enc.encode("240101000000Z"))), tlv(0x17, Array.from(enc.encode("340101000000Z"))));
  const tbs = tlv(0x30, tlv(0xa0, tlv(0x02, [2])), tlv(0x02, [serial]), alg, issuer, validity, subject, tlv(0x30, alg, tlv(0x03, [0, 1, 2, 3])));
  return tlv(0x30, tbs, alg, tlv(0x03, [0, 9, 9]));
}

/**
 * A WIN_CERTIFICATE (type 2, PKCS#7) with two certificates, the CA first and the leaf second, and a signer info that names the LEAF.
 * `signerCn` is the leaf's common name. `signerFirst` puts the leaf first instead.
 */
export function certificateTable(signerCn: string, opts: { bmp?: boolean; signerFirst?: boolean; org?: string } = {}): Uint8Array {
  const caName = name(rdn("O", "Fixture Root CA"), rdn("CN", "Fixture Root"));
  const leafName = name(...(opts.org !== undefined ? [rdn("O", opts.org)] : []), rdn("CN", signerCn, opts.bmp));
  const ca = certificate(7, caName, caName);
  const leaf = certificate(9, caName, leafName);
  const certs = opts.signerFirst === true ? [leaf, ca] : [ca, leaf];
  const signerInfo = tlv(0x30, tlv(0x02, [1]), tlv(0x30, caName, tlv(0x02, [9])), tlv(0x30, oid(0x60)), tlv(0x04, [1, 2, 3]));
  const signed = tlv(0x30, tlv(0x02, [1]), tlv(0x31), tlv(0x30, oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01)), tlv(0xa0, ...certs), tlv(0x31, signerInfo));
  const pkcs7 = tlv(0x30, oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02), tlv(0xa0, signed));
  return Uint8Array.from(pad([...u32(8 + pkcs7.length), ...u16(0x0200), ...u16(0x0002), ...pkcs7], 8));
}

// ---------------------------------------------------------------- PE

export type PeOptions = {
  /** Section names besides `.text` and `.rsrc` (for example `.wixburn`). */
  sections?: string[];
  /** The text of the manifest resource. */
  manifest?: string;
  /** Fields of the version resource (`FileVersion`, `ProductName`, `CompanyName`, `FileDescription`). */
  version?: Record<string, string>;
  /** Bytes appended after the last section (the installer's payload). */
  overlay?: Uint8Array | number[];
  /** A certificate table to append (after the overlay) and point the security directory at. */
  certificate?: Uint8Array;
  /** Leave the resource directory out of the data directories (so only string markers remain). */
  noResources?: boolean;
};

/** The version resource: VS_VERSIONINFO with one StringFileInfo (enough for the detector: key, NUL padding, value). */
function versionResource(fields: Record<string, string>): number[] {
  const out: number[] = [];
  for (const [key, value] of Object.entries(fields)) {
    out.push(...pad([...utf16(key), 0, 0], 4), ...utf16(value), 0, 0);
    while (out.length % 4 !== 0) out.push(0);
  }
  return [...utf16("VS_VERSION_INFO"), 0, 0, 0, 0, ...out];
}

/** A resource tree: type -> name 1 -> language 0x409 -> data, for each (type, data) pair. Returns the section bytes for a section at `rva`. */
function resourceSection(entries: { type: number; data: number[] }[], rva: number): number[] {
  const rootSize = 16 + entries.length * 8;
  const perType = 16 + 8 + 16 + 8; // name dir + one entry, language dir + one entry
  const dataEntries = rootSize + entries.length * perType;
  const blobs = dataEntries + entries.length * 16;
  const out: number[] = [...u32(0), ...u32(0), ...u32(0), ...u16(0), ...u16(entries.length)];
  entries.forEach((e, i) => out.push(...u32(e.type), ...u32(0x80000000 | (rootSize + i * perType))));
  const blobAt: number[] = [];
  let cursor = blobs;
  for (const e of entries) {
    blobAt.push(cursor);
    cursor += pad(e.data, 4).length;
  }
  entries.forEach((_, i) => {
    const nameDir = rootSize + i * perType;
    const langDir = nameDir + 24;
    out.push(...u32(0), ...u32(0), ...u32(0), ...u16(0), ...u16(1), ...u32(1), ...u32(0x80000000 | langDir));
    out.push(...u32(0), ...u32(0), ...u32(0), ...u16(0), ...u16(1), ...u32(0x409), ...u32(dataEntries + i * 16));
  });
  entries.forEach((e, i) => out.push(...u32(rva + blobAt[i]!), ...u32(e.data.length), ...u32(0), ...u32(0)));
  for (const e of entries) out.push(...pad(e.data, 4));
  return out;
}

/** A minimal PE32 file with the pieces the detector reads. */
export function buildPe(opts: PeOptions = {}): Uint8Array {
  const names = [".text", ".rsrc", ...(opts.sections ?? [])];
  const resources: { type: number; data: number[] }[] = [];
  if (opts.manifest !== undefined) resources.push({ type: 24, data: Array.from(enc.encode(opts.manifest)) });
  if (opts.version !== undefined) resources.push({ type: 16, data: versionResource(opts.version) });

  const optSize = 224;
  const tableAt = 0x40 + 24 + optSize;
  const headerSize = 0x400;
  const rsrcVa = 0x2000;
  const rsrc = resourceSection(resources, rsrcVa);
  const sectionData: number[][] = names.map((n) => (n === ".rsrc" ? pad(rsrc, 0x200) : new Array<number>(0x200).fill(0x90)));
  const out: number[] = new Array<number>(headerSize).fill(0);
  const put = (at: number, bytes: number[]): void => bytes.forEach((b, i) => (out[at + i] = b));

  put(0, [0x4d, 0x5a]);
  put(0x3c, u32(0x40));
  put(0x40, [0x50, 0x45, 0, 0, ...u16(0x14c), ...u16(names.length), ...u32(0), ...u32(0), ...u32(0), ...u16(optSize), ...u16(0x102)]);
  const opt = 0x40 + 24;
  put(opt, u16(0x10b));
  put(opt + 92, u32(16));
  let raw = headerSize;
  const rawAt: number[] = [];
  names.forEach((n, i) => {
    const data = sectionData[i]!;
    const va = 0x1000 * (i + 1);
    rawAt.push(raw);
    put(tableAt + i * 40, [...Array.from(enc.encode(n)), ...new Array<number>(8 - n.length).fill(0), ...u32(data.length), ...u32(va), ...u32(data.length), ...u32(raw), ...new Array<number>(16).fill(0)]);
    raw += data.length;
  });
  if (opts.manifest !== undefined || opts.version !== undefined) {
    if (opts.noResources !== true) put(opt + 96 + 2 * 8, [...u32(rsrcVa), ...u32(rsrc.length)]);
  }
  const body = sectionData.flat();
  // The overlay may be megabytes: it is copied as bytes, never spread into an array of numbers.
  const overlay = opts.overlay === undefined ? new Uint8Array(0) : Uint8Array.from(opts.overlay);
  const certificate = opts.certificate ?? new Uint8Array(0);
  const headLength = out.length + body.length;
  // In the security directory the first number is a FILE offset: where the table starts, after the overlay.
  if (opts.certificate !== undefined) put(opt + 96 + 4 * 8, [...u32(headLength + overlay.length), ...u32(certificate.length)]);
  const file = new Uint8Array(headLength + overlay.length + certificate.length);
  file.set([...out, ...body]);
  file.set(overlay, headLength);
  file.set(certificate, headLength + overlay.length);
  return file;
}

/** An OLE compound file header (what an MSI starts with), padded to `size`. */
export function buildOle(size = 1024): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return b;
}

const ascii = (s: string): number[] => Array.from(enc.encode(s));

const NSIS_MANIFEST = `<assembly><assemblyIdentity name="Nullsoft.NSIS.exehead" type="win32"/><description>Nullsoft Install System v3.08</description><trustInfo><security><requestedPrivileges><requestedExecutionLevel level="%LEVEL%" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`;
const manifestWithDescription = (description: string, level = "asInvoker"): string =>
  `<assembly><description>${description}</description><trustInfo><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`;

/** One fixture per technology of plan 4.7 (and the confidence levels), keyed by a short name. */
export const FIXTURES = {
  msi: () => buildOle(),
  nsisHigh: (level = "asInvoker") => buildPe({ manifest: NSIS_MANIFEST.replace("%LEVEL%", level), version: { FileVersion: "1.2.3.4", ProductName: "Fixture App", CompanyName: "Fixture Co" } }),
  nsisMedium: () => buildPe({ manifest: manifestWithDescription("Nullsoft Install System v3.08", "requireAdministrator") }),
  nsisString: () => buildPe({ overlay: [...ascii("padding"), 0xef, 0xbe, 0xad, 0xde, ...ascii("NullsoftInst")] }),
  innoHigh: () => buildPe({ manifest: manifestWithDescription("Inno Setup", "asInvoker"), version: { FileVersion: "2.0.0", ProductName: "Inno Fixture" } }),
  innoString: () => buildPe({ overlay: ascii("Inno Setup Setup Data (6.2.2)") }),
  burnHigh: () => buildPe({ sections: [".wixburn"], manifest: manifestWithDescription("Anything") }),
  burnLow: () => buildPe({ manifest: manifestWithDescription("WiX Bootstrapper Application") }),
  installshieldMsi: () => buildPe({ overlay: [...ascii("InstallShield Setup Launcher"), ...new Array<number>(40).fill(0), ...Array.from(buildOle(64))] }),
  installshieldScript: () => buildPe({ overlay: [...utf16("InstallShield Software Corporation"), ...ascii("setup.inx")] }),
  advancedInstaller: () => buildPe({ overlay: ascii("Advanced Installer 21.0 Caphyon") }),
  plainExe: () => buildPe({ manifest: manifestWithDescription("Some Program"), version: { FileDescription: "Some Program" } }),
} as const;
