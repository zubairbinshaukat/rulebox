// Installer detection (Phase 6 Step 13, plan 4.7). PURE: bytes in, a result out. No I/O, no dependency, so the same file runs in
// a Convex action (`apps:inspectInstaller`), in the dashboard's "check a file on this computer" (a lazy chunk) and in tests.
//
// It reads only what a few KiB of a Windows program or MSI say about themselves: the PE headers, the section names, the manifest
// and version resources, a few marker strings, and (display only) the name of the claimed signer in the certificate table. A claimed
// signer is NOT checked here and never decides anything: the device checks the real Authenticode signature (plan 4.6, `publisher`).
// Every read is bounds-checked: a truncated or hostile file gives a less certain answer, never an exception.

/** What the detector can tell apart. `exe` = "a Windows program we know nothing about". */
export type DetectedTech = "msi" | "nsis" | "inno" | "burn" | "installshield_msi" | "installshield_script" | "advanced_installer" | "exe";

export const DETECTED_TECHS: readonly DetectedTech[] = ["msi", "nsis", "inno", "burn", "installshield_msi", "installshield_script", "advanced_installer", "exe"];

export type Confidence = "high" | "medium" | "low";

export type InstallerInspection = {
  tech: DetectedTech;
  /** `msi` for an MSI package, `exe` for every program (also the setup.exe of an InstallShield MSI). */
  kind: "msi" | "exe";
  confidence: Confidence;
  /** The switches Rulebox pre-fills for this technology (plan 4.7 table). May hold `{AnswerFile}`. */
  silentArgs: string[];
  /** Pre-filled success codes, `0` first. */
  successExitCodes: number[];
  /** InstallShield InstallScript: the installer cannot run silently without a recorded answer file. */
  needsAnswerFile: boolean;
  /** Heuristic (unverified): an NSIS installer that asks for no elevation is often a per-user installer. */
  perUserLikely: boolean;
  /** The subject of the certificate that CLAIMS to have signed the file. Display only. */
  signer?: string;
  /** `requestedExecutionLevel` of the manifest. */
  executionLevel?: string;
  fileVersion?: string;
  productName?: string;
  companyName?: string;
};

/** What the action asks the server for (plan 4.7): the first 2 MiB, the certificate table, the last 64 KiB. */
export const INSPECT_HEAD_BYTES = 2 * 1024 * 1024;
export const INSPECT_TAIL_BYTES = 64 * 1024;
/** A certificate table larger than this is not read (a normal one is 5 to 20 KiB). */
export const INSPECT_CERT_MAX_BYTES = 256 * 1024;

export type DetectInput = {
  /** The first bytes of the file (up to `INSPECT_HEAD_BYTES`). */
  head: Uint8Array;
  /** The last bytes, when they are not already in `head`. */
  tail?: Uint8Array;
  /** The certificate table (`certificateRange(head)`), when it is not already in `head`. */
  cert?: Uint8Array;
};

type Prefill = { silentArgs: string[]; successExitCodes: number[]; needsAnswerFile: boolean };

/** Plan 4.7: the switches and success codes pre-filled per technology. */
const PREFILL: Record<DetectedTech, Prefill> = {
  msi: { silentArgs: [], successExitCodes: [0], needsAnswerFile: false },
  nsis: { silentArgs: ["/S"], successExitCodes: [0], needsAnswerFile: false },
  inno: { silentArgs: ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], successExitCodes: [0], needsAnswerFile: false },
  burn: { silentArgs: ["/quiet", "/norestart"], successExitCodes: [0, 3010, 1641], needsAnswerFile: false },
  installshield_msi: { silentArgs: ["/s", "/v/qn"], successExitCodes: [0, 3010, 1641], needsAnswerFile: false },
  installshield_script: { silentArgs: ["/s", "/f1{AnswerFile}"], successExitCodes: [0], needsAnswerFile: true },
  advanced_installer: { silentArgs: ["/exenoui", "/qn", "/norestart"], successExitCodes: [0, 3010, 1641], needsAnswerFile: false },
  exe: { silentArgs: [], successExitCodes: [0], needsAnswerFile: false },
};

/** The pre-filled switches and codes of a technology (copies: the caller may edit them). */
export function prefillFor(tech: DetectedTech): Prefill {
  const p = PREFILL[tech];
  return { silentArgs: [...p.silentArgs], successExitCodes: [...p.successExitCodes], needsAnswerFile: p.needsAnswerFile };
}

// ---------------------------------------------------------------- byte helpers

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function u16(b: Uint8Array, o: number): number {
  return o >= 0 && o + 2 <= b.length ? b[o]! | (b[o + 1]! << 8) : -1;
}

function u32(b: Uint8Array, o: number): number {
  return o >= 0 && o + 4 <= b.length ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0 : -1;
}

function indexOfBytes(hay: Uint8Array, needle: ArrayLike<number>, from = 0): number {
  const first = needle[0]!;
  for (let i = hay.indexOf(first, from); i !== -1 && i + needle.length <= hay.length; i = hay.indexOf(first, i + 1)) {
    let k = 1;
    while (k < needle.length && hay[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

const asciiBytes = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));
const utf16Bytes = (text: string): number[] => Array.from(text).flatMap((c) => [c.charCodeAt(0), 0]);

/** Whether any of the buffers holds `text` as ASCII or as UTF-16LE (version resources and most strings are one of them). */
function hasText(bufs: Uint8Array[], text: string): boolean {
  const a = asciiBytes(text);
  const w = utf16Bytes(text);
  return bufs.some((b) => indexOfBytes(b, a) !== -1 || indexOfBytes(b, w) !== -1);
}

function slice(b: Uint8Array, start: number, length: number): Uint8Array | null {
  return start >= 0 && length >= 0 && start + length <= b.length ? b.subarray(start, start + length) : null;
}

const utf8 = (b: Uint8Array): string => new TextDecoder("utf-8").decode(b);

// ---------------------------------------------------------------- PE

type Section = { name: string; va: number; vsize: number; raw: number; rawSize: number };
type Pe = { sections: Section[]; certificate: { offset: number; size: number } | null; resource: { rva: number; size: number } | null };

function parsePe(b: Uint8Array): Pe | null {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return null;
  const pe = u32(b, 0x3c);
  if (pe < 0 || u32(b, pe) !== 0x00004550) return null;
  const count = u16(b, pe + 6);
  const optSize = u16(b, pe + 20);
  const opt = pe + 24;
  const magic = u16(b, opt);
  const is64 = magic === 0x20b;
  const out: Pe = { sections: [], certificate: null, resource: null };
  if (magic !== 0x10b && !is64) return out;
  const dirs = opt + (is64 ? 112 : 96);
  const dirCount = u32(b, opt + (is64 ? 108 : 92));
  if (dirCount > 2) {
    const rva = u32(b, dirs + 2 * 8);
    const size = u32(b, dirs + 2 * 8 + 4);
    if (rva > 0 && size > 0) out.resource = { rva, size };
  }
  if (dirCount > 4) {
    const offset = u32(b, dirs + 4 * 8);
    const size = u32(b, dirs + 4 * 8 + 4);
    // In this entry (and only this one) the first number is a FILE offset, not an RVA.
    if (offset > 0 && size > 8) out.certificate = { offset, size };
  }
  const table = opt + optSize;
  for (let i = 0; i < Math.min(count, 96); i++) {
    const at = table + i * 40;
    const name = slice(b, at, 8);
    if (name === null) break;
    const end = name.indexOf(0);
    out.sections.push({
      name: String.fromCharCode(...name.subarray(0, end === -1 ? 8 : end)),
      vsize: u32(b, at + 8),
      va: u32(b, at + 12),
      rawSize: u32(b, at + 16),
      raw: u32(b, at + 20),
    });
  }
  return out;
}

/** Where the certificate table of a PE file is (a file offset and a size), from its first bytes; null when it has none or is not a PE. */
export function certificateRange(head: Uint8Array): { offset: number; size: number } | null {
  const c = parsePe(head)?.certificate ?? null;
  return c !== null && c.size <= INSPECT_CERT_MAX_BYTES ? c : null;
}

function rvaToOffset(sections: Section[], rva: number): number {
  for (const s of sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return s.raw + (rva - s.va);
  }
  return -1;
}

const RT_VERSION = 16;
const RT_MANIFEST = 24;

/** The data of the first resource of `type` (the first name, the first language): the bytes, or null when they are not in `b`. */
function resourceData(b: Uint8Array, pe: Pe, type: number): Uint8Array | null {
  if (pe.resource === null) return null;
  const base = rvaToOffset(pe.sections, pe.resource.rva);
  if (base < 0) return null;
  const entryAt = (dir: number, wantId: number | null): number => {
    // IMAGE_RESOURCE_DIRECTORY: named count at +12, id count at +14, then the 8-byte entries.
    const named = u16(b, dir + 12);
    const ids = u16(b, dir + 14);
    if (named < 0 || ids < 0) return -1;
    const total = Math.min(named + ids, 512);
    for (let i = 0; i < total; i++) {
      const e = dir + 16 + i * 8;
      const id = u32(b, e);
      if (id < 0) return -1;
      if (wantId === null ? true : id === wantId) return u32(b, e + 4);
    }
    return -1;
  };
  let target = entryAt(base, type);
  // type -> name -> language: each level is a directory (high bit set) until the data entry.
  for (let depth = 0; depth < 2; depth++) {
    if (target < 0 || (target & 0x80000000) === 0) return null;
    target = entryAt(base + (target & 0x7fffffff), null);
  }
  if (target < 0 || (target & 0x80000000) !== 0) return null;
  const data = base + target;
  const rva = u32(b, data);
  const size = u32(b, data + 4);
  if (rva < 0 || size < 0 || size > 512 * 1024) return null;
  const at = rvaToOffset(pe.sections, rva);
  return at < 0 ? null : slice(b, at, size);
}

function versionField(text: string, key: string): string | undefined {
  // The key and its value are both NUL-terminated UTF-16 strings with padding between them.
  const m = new RegExp(`${key}\\u0000+([^\\u0000]+)`).exec(text);
  const v = m?.[1]?.trim();
  return v === undefined || v === "" ? undefined : v.slice(0, 200);
}

// ---------------------------------------------------------------- claimed signer (display only)

type Tlv = { tag: number; start: number; end: number; contentStart: number };

/** One DER element at `o` (definite lengths only), within `limit`; null for anything else. */
function der(b: Uint8Array, o: number, limit: number): Tlv | null {
  if (o < 0 || o + 2 > limit || o + 2 > b.length) return null;
  const tag = b[o]!;
  const first = b[o + 1]!;
  let len = first;
  let at = o + 2;
  if (first >= 0x80) {
    const n = first & 0x7f;
    if (n === 0 || n > 4 || at + n > limit) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[at + i]!;
    at += n;
  }
  const end = at + len;
  return end <= limit && end <= b.length ? { tag, start: o, end, contentStart: at } : null;
}

function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let o = t.contentStart; o < t.end && out.length < 64; ) {
    const c = der(b, o, t.end);
    if (c === null) break;
    out.push(c);
    o = c.end;
  }
  return out;
}

const raw = (b: Uint8Array, t: Tlv): Uint8Array => b.subarray(t.start, t.end);
const same = (a: Uint8Array, c: Uint8Array): boolean => a.length === c.length && a.every((x, i) => x === c[i]);

/** The text of a name attribute value (UTF8String, PrintableString, T61, IA5String, BMPString). */
function attributeText(b: Uint8Array, t: Tlv): string {
  const bytes = b.subarray(t.contentStart, t.end);
  if (t.tag === 0x1e) {
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return s;
  }
  return utf8(bytes);
}

/** The common name (else the organization) of a distinguished name. */
function nameText(b: Uint8Array, name: Tlv): string | undefined {
  let cn: string | undefined;
  let org: string | undefined;
  for (const set of children(b, name)) {
    for (const atv of children(b, set)) {
      const parts = children(b, atv);
      const oid = parts[0];
      const value = parts[1];
      if (oid === undefined || value === undefined || oid.tag !== 0x06) continue;
      const id = b.subarray(oid.contentStart, oid.end);
      if (id.length === 3 && id[0] === 0x55 && id[1] === 0x04) {
        if (id[2] === 0x03) cn ??= attributeText(b, value);
        if (id[2] === 0x0a) org ??= attributeText(b, value);
      }
    }
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  const text = (cn ?? org)?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text === undefined || text === "" ? undefined : text.slice(0, 200);
}

/**
 * The subject of the certificate that the signature names as its signer, from a WIN_CERTIFICATE (`dwLength`, revision, type 2 =
 * PKCS#7) holding a DER `SignedData`. Falls back to the first certificate when the signer's own cannot be matched. Display only.
 */
function claimedSigner(table: Uint8Array): string | undefined {
  const length = u32(table, 0);
  if (length < 16 || u16(table, 6) !== 0x0002) return undefined;
  const pkcs = table.subarray(8, Math.min(length, table.length));
  const info = der(pkcs, 0, pkcs.length);
  if (info === null || info.tag !== 0x30) return undefined;
  const wrapper = children(pkcs, info).find((c) => c.tag === 0xa0);
  const signed = wrapper === undefined ? undefined : children(pkcs, wrapper)[0];
  if (signed === undefined || signed.tag !== 0x30) return undefined;
  const parts = children(pkcs, signed);
  const certs = parts.find((c) => c.tag === 0xa0);
  const signerInfos = parts.filter((c) => c.tag === 0x31).at(-1);
  if (certs === undefined) return undefined;
  const list = children(pkcs, certs).filter((c) => c.tag === 0x30);
  // The signer's issuer and serial number, to find its certificate.
  const signer = signerInfos === undefined ? undefined : children(pkcs, signerInfos)[0];
  const issuerAndSerial = signer === undefined ? undefined : children(pkcs, signer)[1];
  const idParts = issuerAndSerial === undefined ? [] : children(pkcs, issuerAndSerial);
  let chosen: Tlv | undefined;
  for (const cert of list) {
    const tbs = children(pkcs, cert)[0];
    if (tbs === undefined) continue;
    const f = children(pkcs, tbs);
    const at = f[0]?.tag === 0xa0 ? 1 : 0; // an optional [0] version comes first
    const serial = f[at];
    const issuer = f[at + 2];
    if (serial === undefined || issuer === undefined) continue;
    if (idParts.length === 2 && same(raw(pkcs, serial), raw(pkcs, idParts[1]!)) && same(raw(pkcs, issuer), raw(pkcs, idParts[0]!))) {
      chosen = tbs;
      break;
    }
    chosen ??= tbs;
  }
  if (chosen === undefined) return undefined;
  const f = children(pkcs, chosen);
  const at = f[0]?.tag === 0xa0 ? 1 : 0;
  const subject = f[at + 4];
  return subject === undefined ? undefined : nameText(pkcs, subject);
}

// ---------------------------------------------------------------- the detector

function result(tech: DetectedTech, confidence: Confidence, extra: Partial<InstallerInspection> = {}): InstallerInspection {
  const p = prefillFor(tech);
  return {
    tech,
    kind: tech === "msi" ? "msi" : "exe",
    confidence,
    silentArgs: p.silentArgs,
    successExitCodes: p.successExitCodes,
    needsAnswerFile: p.needsAnswerFile,
    perUserLikely: false,
    ...extra,
  };
}

/**
 * What a file is, from its first bytes (and optionally its last bytes and certificate table): `null` when it is neither a Windows
 * program nor an MSI-style OLE file. Never throws.
 */
export function detectInstaller(input: DetectInput): InstallerInspection | null {
  const { head } = input;
  const bufs = input.tail === undefined ? [head] : [head, input.tail];
  if (indexOfBytes(head, OLE_MAGIC) === 0) return result("msi", "high");
  const pe = parsePe(head);
  if (pe === null) return null;

  const manifestBytes = resourceData(head, pe, RT_MANIFEST);
  const manifest = manifestBytes === null ? "" : utf8(manifestBytes);
  const versionBytes = resourceData(head, pe, RT_VERSION);
  const version = versionBytes === null ? "" : new TextDecoder("utf-16le").decode(versionBytes);
  const level = /requestedExecutionLevel[^>]*?\blevel\s*=\s*["']([^"']+)["']/i.exec(manifest)?.[1];
  const description = /<description[^>]*>([^<]*)<\/description>/i.exec(manifest)?.[1]?.trim().split(/\s+/)[0]?.toLowerCase();

  const certTable = input.cert ?? (pe.certificate !== null ? slice(head, pe.certificate.offset, pe.certificate.size) : null);
  const signer = certTable === null ? undefined : claimedSigner(certTable);
  const common: Partial<InstallerInspection> = {
    ...(signer !== undefined ? { signer } : {}),
    ...(level !== undefined ? { executionLevel: level } : {}),
    ...(versionField(version, "FileVersion") !== undefined ? { fileVersion: versionField(version, "FileVersion") } : {}),
    ...(versionField(version, "ProductName") !== undefined ? { productName: versionField(version, "ProductName") } : {}),
    ...(versionField(version, "CompanyName") !== undefined ? { companyName: versionField(version, "CompanyName") } : {}),
  };
  const found = (tech: DetectedTech, confidence: Confidence): InstallerInspection =>
    result(tech, confidence, { ...common, perUserLikely: tech === "nsis" && level?.toLowerCase() === "asinvoker" });

  if (pe.sections.some((s) => s.name === ".wixburn")) return found("burn", "high");
  if (manifest.includes("Nullsoft.NSIS.exehead")) return found("nsis", "high");
  if (description === "inno") return found("inno", "high");
  if (description === "nullsoft") return found("nsis", "medium");
  if (hasText(bufs, "NullsoftInst")) return found("nsis", "medium");
  if (hasText(bufs, "Inno Setup Setup Data") || hasText(bufs, "InnoSetupLdrWindow")) return found("inno", "medium");
  if (description === "wix") return found("burn", "low");
  if (hasText(bufs, "Advanced Installer") || hasText(bufs, "Caphyon")) return found("advanced_installer", "low");
  if (hasText(bufs, "InstallShield")) {
    // An InstallShield setup.exe that carries an MSI package is the "Basic MSI" project type.
    const withMsi = bufs.some((b) => indexOfBytes(b, OLE_MAGIC, 1) !== -1);
    return found(withMsi ? "installshield_msi" : "installshield_script", "low");
  }
  return found("exe", "low");
}
