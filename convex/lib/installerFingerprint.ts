import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { fetchFeedResource } from "./feed/fetch";
import { FEED_DOWNLOAD_TIMEOUT_MS, FEED_INSTALLER_MAX_BYTES } from "./feed/limits";
import { certificateRange, detectInstaller, INSPECT_HEAD_BYTES, INSPECT_TAIL_BYTES, type InstallerInspection } from "./installerDetect";

// "Fingerprint" of an installer address (UI pass, `docs/plans/ui-pass/add-app.md` section 5, D8, `apps:fingerprintInstaller`): the file is
// streamed ONCE over https (the feed resolver's fetch: public https hosts only, every redirect re-checked, size cap and one overall
// deadline enforced while the body arrives), hashed with SHA-256 as it goes, and the pure detector runs on what a few chunks say about
// the file (the first 2 MiB, the certificate table, the last 64 KiB). The file is never stored and never held whole: the memory in use
// is the 2 MiB head, the 64 KiB tail ring and a certificate table of at most 256 KiB (about 2.4 MiB), whatever the file's size.
//
// Trust: the hash comes from the same place as the file (trust on first use). It pins the file, so a later swap on the host is refused by
// the PC (which re-hashes what it downloads); it does not prove the file is the vendor's. A winget app keeps the manifest's hash.
//
// `fetch` is injectable (tests stub it: no test uses the network).

type FetchLike = typeof fetch;

export type FingerprintFailure =
  /** More than `FEED_INSTALLER_MAX_BYTES` (declared or counted): the form falls back to `apps:inspectInstaller` + the local file check. */
  | "too_large"
  /** The address is not one the server may fetch (private host, http, a redirect off https, ...). */
  | "blocked"
  /** The host did not answer, answered an error, or the download did not finish in time. */
  | "failed"
  /** The first bytes are not a Windows program or an MSI. */
  | "not_installer";

export type FingerprintResult = {
  /** Lower-case hex SHA-256 of every byte of the file. */
  sha256: string;
  sizeBytes: number;
  inspection: InstallerInspection;
};

export type FingerprintOutcome = ({ ok: true } & FingerprintResult) | { ok: false; reason: FingerprintFailure };

/** The certificate table is looked up once this many bytes of the file are known (the PE headers and section table sit in the first KiB). */
const CERT_LOOKUP_AT = 64 * 1024;

/**
 * Feed the file's bytes in order with `update`, then `finish`. Keeps only what the detector reads: the head, the certificate table (when
 * it lies beyond the head, or straddles its end) and the tail (the last bytes that are not in the head). Chunk sizes do not matter:
 * the same file gives the same answer however it is cut.
 */
export class FingerprintCapture {
  private readonly hash = sha256.create();
  private readonly head = new Uint8Array(INSPECT_HEAD_BYTES);
  private headLength = 0;
  private readonly ring = new Uint8Array(INSPECT_TAIL_BYTES);
  private position = 0;
  private cert: { offset: number; size: number; bytes: Uint8Array } | null = null;
  private certLookedUp = false;

  /** Bytes seen so far. */
  get size(): number {
    return this.position;
  }

  update(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.hash.update(chunk);
    const start = this.position;
    if (this.headLength < this.head.length) {
      const take = Math.min(chunk.length, this.head.length - this.headLength);
      this.head.set(chunk.subarray(0, take), this.headLength);
      this.headLength += take;
    }
    // The file's own PE headers are in the head by now: find the certificate table, and back-fill what of it came before this chunk.
    if (!this.certLookedUp && this.headLength >= CERT_LOOKUP_AT) this.lookUpCertificate(start);
    if (this.cert !== null) this.copyIntoCert(start, chunk);
    // Ring: only the last INSPECT_TAIL_BYTES of the chunk can survive. A byte at file offset p lives at ring[p % size].
    const last = chunk.length > this.ring.length ? chunk.subarray(chunk.length - this.ring.length) : chunk;
    const from = (start + (chunk.length - last.length)) % this.ring.length;
    const room = this.ring.length - from;
    if (last.length <= room) {
      this.ring.set(last, from);
    } else {
      this.ring.set(last.subarray(0, room), from);
      this.ring.set(last.subarray(room), 0);
    }
    this.position += chunk.length;
  }

  /** `before` = bytes of the file that came before the current chunk (the head holds all of them: it fills first). */
  private lookUpCertificate(before: number): void {
    this.certLookedUp = true;
    const range = certificateRange(this.head.subarray(0, this.headLength));
    // A table the head already holds whole needs no copy: the detector reads it from the head.
    if (range === null || range.offset + range.size <= this.head.length) return;
    this.cert = { offset: range.offset, size: range.size, bytes: new Uint8Array(range.size) };
    this.copyIntoCert(0, this.head.subarray(0, before));
  }

  /** Copies the part of `chunk` (which starts at file offset `at`) that overlaps the certificate table. */
  private copyIntoCert(at: number, chunk: Uint8Array): void {
    const cert = this.cert;
    if (cert === null) return;
    const from = Math.max(at, cert.offset);
    const to = Math.min(at + chunk.length, cert.offset + cert.size);
    if (from < to) cert.bytes.set(chunk.subarray(from - at, to - at), from - cert.offset);
  }

  /**
   * The hash, the size and what the detector reads. `cert` is set only when the whole table arrived; `tail` only when the file is longer
   * than the head (the same rule as `inspectInstallerUrl`: the last bytes the head does not already hold).
   */
  finish(): { sha256: string; sizeBytes: number; head: Uint8Array; tail?: Uint8Array; cert?: Uint8Array } {
    const head = this.head.slice(0, this.headLength);
    const out: { sha256: string; sizeBytes: number; head: Uint8Array; tail?: Uint8Array; cert?: Uint8Array } = {
      sha256: bytesToHex(this.hash.digest()),
      sizeBytes: this.position,
      head,
    };
    if (this.cert !== null && this.cert.offset + this.cert.size <= this.position) out.cert = this.cert.bytes;
    if (this.position > head.length) {
      const want = Math.min(this.ring.length, this.position - head.length);
      const tail = new Uint8Array(want);
      for (let i = 0; i < want; i++) tail[i] = this.ring[(this.position - want + i) % this.ring.length]!;
      out.tail = tail;
    }
    return out;
  }
}

export type FingerprintOptions = { fetch?: FetchLike; maxBytes?: number; timeoutMs?: number };

/**
 * Downloads the file at `url` through the checked fetch, hashes it and detects its installer type. Never throws: a refusal is an
 * `ok: false` with the reason. Nothing is stored.
 */
export async function fingerprintInstallerUrl(url: string, opts: FingerprintOptions = {}): Promise<FingerprintOutcome> {
  const capture = new FingerprintCapture();
  const got = await fetchFeedResource(url, {
    maxBytes: opts.maxBytes ?? FEED_INSTALLER_MAX_BYTES,
    timeoutMs: opts.timeoutMs ?? FEED_DOWNLOAD_TIMEOUT_MS,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    // The bytes that are hashed must be the file's own: no transparent decompression of an answer.
    headers: { "accept-encoding": "identity" },
    onChunk: (chunk) => capture.update(chunk),
  });
  if (!got.ok) {
    if (got.reason === "too_large") return { ok: false, reason: "too_large" };
    // `redirect_followed`: the runtime itself followed a redirect to an address nobody checked.
    if (got.reason === "blocked" || got.reason === "redirect_followed") return { ok: false, reason: "blocked" };
    return { ok: false, reason: "failed" };
  }
  if (got.notModified) return { ok: false, reason: "failed" };
  const done = capture.finish();
  const inspection = detectInstaller({ head: done.head, ...(done.tail !== undefined ? { tail: done.tail } : {}), ...(done.cert !== undefined ? { cert: done.cert } : {}) });
  if (inspection === null) return { ok: false, reason: "not_installer" };
  return { ok: true, sha256: done.sha256, sizeBytes: done.sizeBytes, inspection };
}
