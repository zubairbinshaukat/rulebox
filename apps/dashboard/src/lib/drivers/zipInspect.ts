/**
 * Looks inside a driver package (a .zip) that the admin picked on this computer (UI pass, enrollment plan 4.5): which INF files it
 * holds and which printer models each one delivers, so the driver form can fill the INF path and the "This driver adds" names
 * instead of asking for them. A lazy chunk: the form imports it only when a zip was picked. Nothing is uploaded.
 *
 * It reads the ZIP's end-of-central-directory record and the central directory from slices of the `File` (a package can be hundreds
 * of megabytes: the file is never read whole). Only the INF entries are opened (stored, or deflate through the browser's
 * `DecompressionStream("deflate-raw")`), each at most 1 MiB. ZIP64, multi-disk and encrypted archives are refused with a `ZipError`:
 * the driver form then says "Couldn't read this zip" and leaves the fields to the admin (Advanced). Any failure here is advice
 * only: the PC still verifies the real file by its SHA-256.
 */
import { infProblem } from "../driverRules";
import { decodeInf, MAX_MODELS, parseInfModels } from "./infModels";

export type ZipProblem = "not_zip" | "zip64" | "multi_disk" | "encrypted" | "unreadable";

/** Why a zip cannot be read (`code`); the message is for developers, never shown. */
export class ZipError extends Error {
  readonly code: ZipProblem;
  constructor(code: ZipProblem) {
    super(`zip: ${code}`);
    this.name = "ZipError";
    this.code = code;
  }
}

export interface ZipEntry {
  /** The path inside the zip, with forward slashes. */
  path: string;
  /** 0 = stored, 8 = deflate; others cannot be opened here. */
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
  /** A directory entry (the path ends in a slash). */
  directory: boolean;
}

/** The longest comment a zip may carry after its end record (16 bits) plus the record itself. */
const EOCD_SEARCH = 22 + 0xffff;
/** The central directory is read in one slice: refuse an absurd one (more than ~100,000 entries). */
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
/** An INF file larger than this is not read (real ones are a few hundred KB at most). */
export const MAX_INF_BYTES = 1024 * 1024;
/** INF files whose models are read in one `inspectDriverZip` call (shallowest first); the others are listed and can be read on demand. */
export const MAX_INFS_READ = 12;
/** INF paths listed at most (the Select of the form); `moreInfs` says when there were more. */
export const MAX_INFS_LISTED = 200;

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(blob);
  });
}

const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);

/** The entries of the zip (central directory). Throws `ZipError`. */
export async function listZip(file: Blob): Promise<ZipEntry[]> {
  const total = file.size;
  if (total < 22) throw new ZipError("not_zip");
  const tailStart = Math.max(0, total - EOCD_SEARCH);
  const tail = await bytesOf(file.slice(tailStart, total));
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    // The end record, whose comment length leads exactly to the end of the file (a signature inside a comment does not).
    if (u32(tv, i) === 0x06054b50 && i + 22 + u16(tv, i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not_zip");
  if (eocd >= 20 && u32(tv, eocd - 20) === 0x07064b50) throw new ZipError("zip64");
  const disk = u16(tv, eocd + 4);
  const directoryDisk = u16(tv, eocd + 6);
  const count = u16(tv, eocd + 10);
  const directorySize = u32(tv, eocd + 12);
  const directoryOffset = u32(tv, eocd + 16);
  if (disk !== 0 || directoryDisk !== 0 || u16(tv, eocd + 8) !== count) throw new ZipError("multi_disk");
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new ZipError("zip64");
  if (directoryOffset + directorySize > total || directorySize > MAX_DIRECTORY_BYTES) throw new ZipError("unreadable");

  const dir = await bytesOf(file.slice(directoryOffset, directoryOffset + directorySize));
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const names = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > dir.length || u32(dv, at) !== 0x02014b50) throw new ZipError("unreadable");
    const flags = u16(dv, at + 8);
    const method = u16(dv, at + 10);
    const compressedSize = u32(dv, at + 20);
    const size = u32(dv, at + 24);
    const nameLength = u16(dv, at + 28);
    const extraLength = u16(dv, at + 30);
    const commentLength = u16(dv, at + 32);
    const offset = u32(dv, at + 42);
    if (at + 46 + nameLength > dir.length) throw new ZipError("unreadable");
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError("zip64");
    if ((flags & 1) !== 0) throw new ZipError("encrypted");
    const path = names.decode(dir.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, "/");
    entries.push({ path, method, compressedSize, size, offset, directory: path.endsWith("/") });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The decompressed bytes of an entry up to `maxBytes` (`null` when it is bigger, uses another method, or cannot be inflated). */
export async function readEntry(file: Blob, entry: ZipEntry, maxBytes = MAX_INF_BYTES): Promise<Uint8Array | null> {
  if (entry.directory || entry.size > maxBytes || (entry.method !== 0 && entry.method !== 8)) return null;
  try {
    const header = await bytesOf(file.slice(entry.offset, entry.offset + 30));
    const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (header.length < 30 || u32(hv, 0) !== 0x04034b50) return null;
    const start = entry.offset + 30 + u16(hv, 26) + u16(hv, 28);
    if (start + entry.compressedSize > file.size) return null;
    const data = await bytesOf(file.slice(start, start + entry.compressedSize));
    if (entry.method === 0) return data;
    return await inflateRaw(data, maxBytes);
  } catch {
    return null;
  }
}

/** Raw deflate (what a zip stores) through the browser's own decompressor; null when the data is broken or inflates past `maxBytes`. */
async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // A broken stream rejects both sides: the read below reports it, so the write's own rejection is dropped here.
  void writer
    .write(data as Uint8Array<ArrayBuffer>)
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The printer models one INF entry delivers (up to `MAX_MODELS`); empty when the entry cannot be read. */
export async function modelsOfInf(file: Blob, entry: ZipEntry): Promise<string[]> {
  const bytes = await readEntry(file, entry);
  return bytes === null ? [] : parseInfModels(decodeInf(bytes), MAX_MODELS);
}

export interface InfFile {
  /** The path inside the zip: what the driver's INF field takes (already checked against the server's rule). */
  path: string;
  /** The models it delivers; `null` = not read (see `MAX_INFS_READ`), `[]` = read, none found. */
  models: string[] | null;
}

export interface DriverZipInspection {
  entryCount: number;
  /** Every usable INF, shallowest and alphabetical first, at most `MAX_INFS_LISTED`. Empty = "No .inf file in this zip". */
  infs: InfFile[];
  moreInfs: boolean;
}

const depth = (path: string) => path.split("/").length;

/**
 * What the driver form needs from a picked zip: the INF files (paths the server accepts: relative, `.inf`, at most 120 characters)
 * and the models of the first few. Throws `ZipError` for a zip it cannot read.
 */
export async function inspectDriverZip(file: Blob): Promise<DriverZipInspection> {
  const entries = await listZip(file);
  const infs = entries
    .filter((e) => !e.directory && e.path.toLowerCase().endsWith(".inf") && infProblem(e.path) === null)
    .sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  const listed = infs.slice(0, MAX_INFS_LISTED);
  const out: InfFile[] = [];
  for (const [i, entry] of listed.entries()) {
    out.push({ path: entry.path, models: i < MAX_INFS_READ ? await modelsOfInf(file, entry) : null });
  }
  return { entryCount: entries.length, infs: out, moreInfs: infs.length > listed.length };
}

/** The models of one INF of a zip picked earlier (the admin chose another one in the Select). */
export async function modelsOfInfPath(file: Blob, path: string): Promise<string[]> {
  const entry = (await listZip(file)).find((e) => e.path === path);
  return entry === undefined ? [] : await modelsOfInf(file, entry);
}
