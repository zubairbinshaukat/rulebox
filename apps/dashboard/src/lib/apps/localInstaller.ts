// "Check a file on this computer" (Phase 6 Step 13, Q9, plan 4.7). A lazy chunk: the App screen imports it only when the admin picks a
// file. The file is read in this browser, hashed in chunks (never held whole in memory) and run through the SAME detector the
// server uses. Nothing is uploaded anywhere. The result only fills the form; the PC still verifies the real file.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { certificateRange, detectInstaller, INSPECT_HEAD_BYTES, INSPECT_TAIL_BYTES, type InstallerInspection } from "@convex/lib/installerDetect";

const CHUNK = 4 * 1024 * 1024;

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(blob);
  });
}

export interface LocalCheck {
  /** `null` when the file is neither a Windows program nor an MSI. */
  inspection: InstallerInspection | null;
  /** 64 lower-case hex of the whole file. */
  sha256: string;
  sizeBytes: number;
}

export async function checkLocalFile(file: File): Promise<LocalCheck> {
  const size = file.size;
  const head = await bytesOf(file.slice(0, Math.min(size, INSPECT_HEAD_BYTES)));
  const range = certificateRange(head);
  const cert = range !== null && range.offset + range.size > head.length && range.offset + range.size <= size ? await bytesOf(file.slice(range.offset, range.offset + range.size)) : undefined;
  const tail = size > head.length ? await bytesOf(file.slice(Math.max(head.length, size - INSPECT_TAIL_BYTES), size)) : undefined;
  const inspection = detectInstaller({ head, ...(tail !== undefined ? { tail } : {}), ...(cert !== undefined ? { cert } : {}) });
  const hash = sha256.create();
  for (let at = 0; at < size; at += CHUNK) hash.update(await bytesOf(file.slice(at, Math.min(size, at + CHUNK))));
  return { inspection, sha256: bytesToHex(hash.digest()), sizeBytes: size };
}
