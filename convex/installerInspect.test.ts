import { describe, expect, test } from "vitest";
import { buildOle, buildPe, certificateTable, FIXTURES } from "../tests/convex/installerFixtures";
import { rangeHost } from "../tests/convex/rangeHost";
import { INSPECT_CERT_MAX_BYTES, INSPECT_HEAD_BYTES, INSPECT_TAIL_BYTES } from "./lib/installerDetect";
import { inspectInstallerUrl } from "./lib/installerInspect";

// The Range reads of `apps:inspectInstaller` (plan 4.7) against a stub host: no test touches the network.

const URL1 = "https://downloads.example.com/setup.exe";
const MIB = 1024 * 1024;

describe("inspectInstallerUrl", () => {
  test("a small file is one request: the whole file is the head, nothing else is read", async () => {
    const host = rangeHost({ [URL1]: { body: FIXTURES.nsisHigh() } });
    const r = await inspectInstallerUrl(URL1, { fetch: host.fetch });
    expect(r).toMatchObject({ ok: true, inspection: { tech: "nsis", confidence: "high" } });
    expect(host.calls).toEqual([{ url: URL1, range: `bytes=0-${INSPECT_HEAD_BYTES - 1}` }]);
  });

  test("a big signed file: head, certificate table and tail are three ranges, at most 2.3 MiB", async () => {
    const table = certificateTable("Big Software Co");
    const body = buildPe({ manifest: "<x/>", overlay: new Uint8Array(3 * MIB), certificate: table });
    const host = rangeHost({ [URL1]: { body } });
    const r = await inspectInstallerUrl(URL1, { fetch: host.fetch });
    expect(r).toMatchObject({ ok: true, sizeBytes: body.length, inspection: { signer: "Big Software Co" } });
    expect(host.calls).toHaveLength(3);
    expect(host.calls[0]!.range).toBe(`bytes=0-${INSPECT_HEAD_BYTES - 1}`);
    expect(host.calls[1]!.range).toBe(`bytes=${body.length - table.length}-${body.length - 1}`);
    // The tail is the last 64 KiB, and it also covers the table here.
    expect(host.calls[2]!.range).toBe(`bytes=${body.length - INSPECT_TAIL_BYTES}-${body.length - 1}`);
    expect(host.bytesServed()).toBeLessThanOrEqual(INSPECT_HEAD_BYTES + INSPECT_CERT_MAX_BYTES + INSPECT_TAIL_BYTES);
    expect(host.bytesServed()).toBeLessThan(4 * MIB);
  });

  test("a marker only the tail has is found by the third range", async () => {
    const tailText = new TextEncoder().encode("..Inno Setup Setup Data (6.2)");
    const overlay = new Uint8Array(3 * MIB);
    overlay.set(tailText, overlay.length - tailText.length);
    const host = rangeHost({ [URL1]: { body: buildPe({ overlay }) } });
    const r = await inspectInstallerUrl(URL1, { fetch: host.fetch });
    expect(r).toMatchObject({ ok: true, inspection: { tech: "inno", confidence: "medium" } });
  });

  test("an MSI is detected from its first bytes", async () => {
    const host = rangeHost({ [URL1]: { body: buildOle(4096) } });
    expect(await inspectInstallerUrl(URL1, { fetch: host.fetch })).toMatchObject({ ok: true, inspection: { tech: "msi", kind: "msi" } });
  });

  test("a host without Range support: a small file is still read, a big one is `unsupported` and not read", async () => {
    const small = rangeHost({ [URL1]: { body: FIXTURES.innoHigh(), ranges: false } });
    expect(await inspectInstallerUrl(URL1, { fetch: small.fetch })).toMatchObject({ ok: true, inspection: { tech: "inno" } });
    const big = rangeHost({ [URL1]: { body: FIXTURES.innoHigh(), ranges: false, declaredLength: 900 * MIB } });
    expect(await inspectInstallerUrl(URL1, { fetch: big.fetch })).toEqual({ ok: false, reason: "unsupported" });
    expect(big.calls).toHaveLength(1);
    const unknown = rangeHost({ [URL1]: { body: new Uint8Array(10), ranges: false, declaredLength: 0 } });
    expect(await inspectInstallerUrl(URL1, { fetch: unknown.fetch })).toEqual({ ok: false, reason: "unsupported" });
  });

  test("something that is not an installer: not_installer (a web page, a zip, an empty file)", async () => {
    for (const body of [new TextEncoder().encode("<html>Not found</html>"), Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0]), new Uint8Array(0)]) {
      const host = rangeHost({ [URL1]: { body } });
      const r = await inspectInstallerUrl(URL1, { fetch: host.fetch });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(["not_installer", "failed"]).toContain(r.reason);
    }
    const page = rangeHost({ [URL1]: { body: new TextEncoder().encode("<html>Not found</html>") } });
    expect(await inspectInstallerUrl(URL1, { fetch: page.fetch })).toEqual({ ok: false, reason: "not_installer" });
  });

  test("a truncated file still gives an answer from what is there", async () => {
    const full = buildPe({ sections: [".wixburn"], manifest: "<x/>" });
    const cut = full.subarray(0, 0x400); // headers only, no sections' data
    const host = rangeHost({ [URL1]: { body: cut } });
    expect(await inspectInstallerUrl(URL1, { fetch: host.fetch })).toMatchObject({ ok: true, inspection: { tech: "burn" } });
  });

  test("a redirect is followed only to another public https address; http and private hosts are blocked", async () => {
    const body = FIXTURES.nsisHigh();
    const ok = rangeHost({ [URL1]: { body: new Uint8Array(0), redirect: "https://cdn.example.com/s.exe" }, "https://cdn.example.com/s.exe": { body } });
    expect(await inspectInstallerUrl(URL1, { fetch: ok.fetch })).toMatchObject({ ok: true });
    for (const to of ["http://cdn.example.com/s.exe", "https://10.0.0.5/s.exe", "https://localhost/s.exe", "https://169.254.169.254/latest", "https://cdn.example.com:8443/s.exe"]) {
      const host = rangeHost({ [URL1]: { body, redirect: to }, [to]: { body } });
      expect(await inspectInstallerUrl(URL1, { fetch: host.fetch }), to).toEqual({ ok: false, reason: "blocked" });
      expect(host.calls.map((c) => c.url)).toEqual([URL1]); // the blocked address was never requested
    }
    const loop = rangeHost({ [URL1]: { body, redirect: URL1 } });
    expect(await inspectInstallerUrl(URL1, { fetch: loop.fetch })).toEqual({ ok: false, reason: "failed" });
  });

  test("a private or non-https address is blocked before any request", async () => {
    const host = rangeHost({});
    for (const url of ["http://downloads.example.com/a.exe", "https://192.168.1.4/a.exe", "https://localhost/a.exe", "nonsense"]) {
      expect(await inspectInstallerUrl(url, { fetch: host.fetch }), url).toEqual({ ok: false, reason: "blocked" });
    }
    expect(host.calls).toEqual([]);
  });

  test("errors: 404, 500, a lying Content-Range, a body that fills more than asked, a network error, a timeout", async () => {
    expect(await inspectInstallerUrl(URL1, { fetch: rangeHost({}).fetch })).toEqual({ ok: false, reason: "failed" });
    expect(await inspectInstallerUrl(URL1, { fetch: rangeHost({ [URL1]: { body: new Uint8Array(1), status: 500 } }).fetch })).toEqual({ ok: false, reason: "failed" });
    const throwing = (async () => {
      throw new TypeError("network");
    }) as typeof fetch;
    expect(await inspectInstallerUrl(URL1, { fetch: throwing })).toEqual({ ok: false, reason: "failed" });
    // A 206 whose Content-Range starts somewhere else than we asked.
    const lying = (async () => new Response(FIXTURES.msi() as BodyInit, { status: 206, headers: { "content-range": "bytes 100-1123/5000" } })) as unknown as typeof fetch;
    expect(await inspectInstallerUrl(URL1, { fetch: lying })).toEqual({ ok: false, reason: "failed" });
    // A 206 that sends more than the range it was asked for.
    const greedy = (async () => new Response(new Uint8Array(INSPECT_HEAD_BYTES + 10) as BodyInit, { status: 206, headers: { "content-range": `bytes 0-${INSPECT_HEAD_BYTES - 1}/${INSPECT_HEAD_BYTES + 10}` } })) as unknown as typeof fetch;
    expect(await inspectInstallerUrl(URL1, { fetch: greedy })).toEqual({ ok: false, reason: "failed" });
    // Never answers: the deadline aborts the read.
    const hang = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await inspectInstallerUrl(URL1, { fetch: hang, timeoutMs: 20 })).toEqual({ ok: false, reason: "failed" });
  });

  test("an unknown total (Content-Range `*`) reads the head only", async () => {
    const host = rangeHost({ [URL1]: { body: buildPe({ overlay: new Uint8Array(3 * MIB) }), total: "*" } });
    const r = await inspectInstallerUrl(URL1, { fetch: host.fetch });
    expect(r).toMatchObject({ ok: true, inspection: { tech: "exe" } });
    expect(host.calls).toHaveLength(1);
    expect(r.ok ? r.sizeBytes : "refused").toBeUndefined();
  });

  test("a certificate table beyond the end of the file or above the cap is not requested", async () => {
    const body = buildPe({ overlay: new Uint8Array(3 * MIB), certificate: new Uint8Array(INSPECT_CERT_MAX_BYTES + 8) });
    const host = rangeHost({ [URL1]: { body } });
    await inspectInstallerUrl(URL1, { fetch: host.fetch });
    expect(host.calls.map((c) => c.range)).toEqual([`bytes=0-${INSPECT_HEAD_BYTES - 1}`, `bytes=${body.length - INSPECT_TAIL_BYTES}-${body.length - 1}`]);
  });
});
