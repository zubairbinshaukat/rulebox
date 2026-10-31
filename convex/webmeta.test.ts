import { describe, expect, test } from "vitest";
import { codeOf } from "../tests/convex/identity";
import { fetchPublic, readLimited } from "./lib/safeFetch";
import {
  appleTouchIconHref,
  fetchWebMeta,
  hueFromColor,
  iconDataUrl,
  linkTags,
  manifestHref,
  pickManifestIcon,
  pngSize,
  stripNoise,
} from "./lib/webmeta";
import appleTouch from "./testdata/webmeta/apple-touch.html?raw";
import bare from "./testdata/webmeta/bare.html?raw";
import manifestPage from "./testdata/webmeta/manifest-page.html?raw";

// Web metadata (plan Step 10 item 5): the HTML scan on three saved snippets
// (convex/testdata/webmeta/), the manifest/icon rules, and the SSRF guards of
// the fetch. `fetch` is stubbed in every test: nothing touches the network.

/** A minimal valid PNG: signature + a `w` x `h` IHDR, padded with zeros to `size` bytes. */
function png(w = 128, h = 128, size = 64): Uint8Array {
  const b = new Uint8Array(Math.max(size, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b.slice(0, size);
}

type Reply = { status?: number; body?: BodyInit | Uint8Array; headers?: Record<string, string> };

function stub(routes: Record<string, Reply>) {
  const calls: { url: string; redirect: string | undefined }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    const r = routes[url];
    if (r === undefined) return new Response("nope", { status: 404 });
    return new Response((r.body ?? "") as BodyInit, { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { f, calls };
}

describe("HTML scan", () => {
  test("manifest-page.html: the manifest link in any attribute order and quoting, entities decoded; commented and script links ignored", () => {
    expect(manifestHref(manifestPage)).toBe("/assets/site.webmanifest?v=3&x=1");
    const tags = linkTags(manifestPage);
    expect(tags.map((t) => t.rel[0])).toEqual(["stylesheet", "manifest", "icon", "apple-touch-icon"]);
    expect(appleTouchIconHref(manifestPage)).toBe("/apple-touch-icon.png");
  });

  test("apple-touch.html: no manifest; the touch icon closest to 128 px (at least 48), else an unsized one", () => {
    expect(manifestHref(appleTouch)).toBeNull();
    expect(appleTouchIconHref(appleTouch)).toBe("https://cdn.example.net/touch-152.png"); // 152 is closer to 128 than 57
    const onlyUnsized = '<link rel="apple-touch-icon" href="/u.png"><link rel="apple-touch-icon" sizes="32x32" href="/small.png">';
    expect(appleTouchIconHref(onlyUnsized)).toBe("/u.png");
    expect(appleTouchIconHref('<link rel="apple-touch-icon" sizes="32x32" href="/small.png">')).toBeNull();
  });

  test("bare.html: nothing found, and a hostile page cannot make the scan slow", () => {
    expect(manifestHref(bare)).toBeNull(); // the link inside <script> is not a link
    expect(linkTags(bare).map((t) => t.href)).toEqual(["/a.css"]);
    const hostile = "<link".repeat(200_000) + "<!-- " + "<link rel=manifest href=/x>".repeat(10_000);
    const started = Date.now();
    expect(manifestHref(hostile)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    // many real tags: only the first 100 are read
    expect(linkTags('<link rel="stylesheet" href="/a.css">'.repeat(500))).toHaveLength(100);
  });

  test("stripNoise removes comments, scripts and styles, and an unterminated block ends the text", () => {
    expect(stripNoise("a<!-- x -->b<SCRIPT>y</SCRIPT>c<style>z</style>d")).toBe("abcd");
    expect(stripNoise("a<script>never closed <link rel=manifest href=/m>")).toBe("a");
    expect(stripNoise("a<!-- never closed")).toBe("a");
  });
});

describe("theme colour and icons", () => {
  test("hex colour -> HSL hue, whole degrees", () => {
    expect(hueFromColor("#ff0000")).toBe(0);
    expect(hueFromColor("#00ff00")).toBe(120);
    expect(hueFromColor("#0000ff")).toBe(240);
    expect(hueFromColor("#0f6e6e")).toBe(180);
    expect(hueFromColor("#f00")).toBe(0);
    expect(hueFromColor("#12b76a")).toBe(152); // the brand green
    expect(hueFromColor("#ff0000ff")).toBe(0);
    expect(hueFromColor("#ff00aa")).toBe(320);
    expect(hueFromColor("  #FF0000 ")).toBe(0);
    expect(hueFromColor("#ffffff")).toBeNull(); // grey: no hue
    expect(hueFromColor("#000")).toBeNull();
    expect(hueFromColor("red")).toBeNull();
    expect(hueFromColor("rgb(1,2,3)")).toBeNull();
    expect(hueFromColor("#12345")).toBeNull();
    expect(hueFromColor(undefined)).toBeNull();
    for (const c of ["#ff0001", "#ff0100", "#fe00ff", "#00ffff"]) {
      const h = hueFromColor(c)!;
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  test("manifest icon: PNG only, declared size closest to 128 and at least 48", () => {
    const icons = (list: unknown[]) => pickManifestIcon({ icons: list });
    expect(icons([{ src: "a48.png", sizes: "48x48", type: "image/png" }, { src: "a192.png", sizes: "192x192", type: "image/png" }, { src: "a96.png", sizes: "96x96" }])).toBe("a96.png");
    expect(icons([{ src: "a32.png", sizes: "32x32" }, { src: "a512.png", sizes: "512x512" }])).toBe("a512.png"); // 32 is below 48
    expect(icons([{ src: "a.svg", sizes: "any", type: "image/svg+xml" }, { src: "a.webp", sizes: "128x128", type: "image/webp" }, { src: "a.ico", sizes: "64x64" }])).toBeNull();
    expect(icons([{ src: "multi.png", sizes: "16x16 64x64 256x256" }])).toBe("multi.png"); // the largest declared side counts
    expect(icons([{ src: "x.png" }])).toBe("x.png"); // undeclared size: last resort
    expect(icons([{ src: "x.png" }, { src: "y.png", sizes: "100x100" }])).toBe("y.png");
    expect(icons([{ src: 3 }, null, "x", { src: "" }])).toBeNull();
    expect(pickManifestIcon({})).toBeNull();
    expect(pickManifestIcon({ icons: "nope" })).toBeNull();
  });

  test("PNG check: signature, IHDR, at most 512 px a side and 32 KiB", () => {
    expect(pngSize(png(128, 128))).toEqual({ width: 128, height: 128 });
    expect(pngSize(png(512, 512))).toEqual({ width: 512, height: 512 });
    expect(pngSize(png(513, 128))).toBeNull();
    expect(pngSize(png(0, 10))).toBeNull();
    expect(pngSize(png(128, 128, 32 * 1024))).not.toBeNull();
    expect(pngSize(png(128, 128, 32 * 1024 + 1))).toBeNull();
    expect(pngSize(png(128, 128, 20))).toBeNull();
    const notPng = png();
    notPng[1] = 0x51;
    expect(pngSize(notPng)).toBeNull();
    const badChunk = png();
    badChunk[12] = 0x58;
    expect(pngSize(badChunk)).toBeNull();
    expect(pngSize(new TextEncoder().encode("<html>not an image at all, but long enough to pass the length check</html>"))).toBeNull();
  });

  test("the preview is a data URL", () => {
    expect(iconDataUrl(png(128, 128, 40))).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });
});

const PAGE = "https://example.com/app/";

describe("fetchWebMeta (stub fetch)", () => {
  test("manifest-page: name, hue and the manifest's own icon, relative to the manifest", async () => {
    const manifest = JSON.stringify({
      name: "Example Docs",
      short_name: "Docs",
      theme_color: "#0000ff",
      icons: [
        { src: "icons/32.png", sizes: "32x32", type: "image/png" },
        { src: "icons/144.png", sizes: "144x144", type: "image/png" },
        { src: "icons/any.svg", sizes: "any", type: "image/svg+xml" },
      ],
    });
    const icon = png(144, 144);
    const { f, calls } = stub({
      [PAGE]: { body: manifestPage },
      "https://example.com/assets/site.webmanifest?v=3&x=1": { body: manifest },
      "https://example.com/assets/icons/144.png": { body: icon },
    });
    const meta = await fetchWebMeta(PAGE, { fetch: f });
    expect(meta.name).toBe("Example Docs");
    expect(meta.hue).toBe(240);
    expect(meta.iconPng).toEqual(icon);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([PAGE, "https://example.com/assets/site.webmanifest?v=3&x=1", "https://example.com/assets/icons/144.png"]);
  });

  test("short_name when there is no name; nameless, colourless manifests leave those fields out", async () => {
    const { f } = stub({
      [PAGE]: { body: manifestPage },
      "https://example.com/assets/site.webmanifest?v=3&x=1": { body: JSON.stringify({ short_name: "Docs", theme_color: "white" }) },
      "https://example.com/apple-touch-icon.png": { body: png() },
    });
    const meta = await fetchWebMeta(PAGE, { fetch: f });
    expect(meta).toMatchObject({ name: "Docs" });
    expect("hue" in meta).toBe(false);
    expect(meta.iconPng).toBeDefined(); // the manifest has no icon: apple-touch-icon is next
  });

  test("no manifest: apple-touch-icon, then /favicon.png; a non-PNG or oversized answer is skipped", async () => {
    const touch = stub({ [PAGE]: { body: appleTouch }, "https://cdn.example.net/touch-152.png": { body: png(152, 152) } });
    expect((await fetchWebMeta(PAGE, { fetch: touch.f })).iconPng).toBeDefined();

    const fav = stub({
      [PAGE]: { body: appleTouch },
      "https://cdn.example.net/touch-152.png": { body: "<html>not a png</html>" },
      "https://example.com/favicon.png": { body: png(64, 64) },
    });
    const meta = await fetchWebMeta(PAGE, { fetch: fav.f });
    expect(meta.iconPng).toEqual(png(64, 64));
    expect(fav.calls.map((c) => c.url)).toEqual([PAGE, "https://cdn.example.net/touch-152.png", "https://example.com/favicon.png"]);

    const big = stub({ [PAGE]: { body: bare }, "https://example.com/favicon.png": { body: png(64, 64, 40 * 1024) } });
    expect((await fetchWebMeta(PAGE, { fetch: big.f })).iconPng).toBeUndefined();
    const none = stub({ [PAGE]: { body: bare } });
    expect(await fetchWebMeta(PAGE, { fetch: none.f })).toEqual({});
  });

  test("a broken manifest only costs the manifest's fields", async () => {
    const { f } = stub({ [PAGE]: { body: manifestPage }, "https://example.com/assets/site.webmanifest?v=3&x=1": { body: "{ not json" } });
    expect(await fetchWebMeta(PAGE, { fetch: f })).toEqual({}); // /apple-touch-icon.png answers 404 in the stub
  });

  test("an unreadable page is webmeta_failed", async () => {
    for (const reply of [{ status: 404 }, { status: 500 }, { status: 403 }]) {
      const { f } = stub({ [PAGE]: reply });
      await expect(fetchWebMeta(PAGE, { fetch: f })).rejects.toSatisfy((e) => codeOf(e) === "webmeta_failed");
    }
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    await expect(fetchWebMeta(PAGE, { fetch: down })).rejects.toSatisfy((e) => codeOf(e) === "webmeta_failed");
  });
});

describe("SSRF and size guards", () => {
  const redirectTo = (location: string) => ({ status: 302, headers: { location } });
  const failure = async (routes: Record<string, Reply>, start = PAGE) => {
    const { f, calls } = stub(routes);
    const r = await fetchPublic(start, { fetch: f, maxBytes: 1024 });
    return { r, calls };
  };

  test("redirects to a private, link-local, loopback or non-https address are refused and never requested", async () => {
    for (const target of [
      "http://example.com/",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/admin",
      "https://127.0.0.1:8080/",
      "https://localhost/",
      "https://[::1]/",
      "https://intranet/",
      "https://printer.local/",
      "https://u:p@example.org/",
      "file:///etc/passwd",
      "ftp://example.com/x",
    ]) {
      const { r, calls } = await failure({ [PAGE]: redirectTo(target) });
      expect(r, target).toEqual({ ok: false, reason: "blocked" });
      expect(calls.map((c) => c.url), target).toEqual([PAGE]);
    }
  });

  test("a start address that is not allowed is never requested", async () => {
    for (const start of ["http://example.com/", "https://10.1.2.3/", "https://169.254.169.254/", "https://localhost/", "not a url", "https://[::1]/"]) {
      const { r, calls } = await failure({}, start);
      expect(r, start).toEqual({ ok: false, reason: "blocked" });
      expect(calls, start).toHaveLength(0);
    }
  });

  test("public redirects are followed (relative ones too); loops stop after four", async () => {
    const ok = await failure({ [PAGE]: redirectTo("/final"), "https://example.com/final": { body: "hello" } });
    expect(ok.r).toMatchObject({ ok: true });
    expect(ok.r.ok && new TextDecoder().decode(ok.r.bytes)).toBe("hello");
    expect(ok.r.ok && ok.r.url.href).toBe("https://example.com/final");

    const loop = await failure({ [PAGE]: redirectTo(PAGE) });
    expect(loop.r).toEqual({ ok: false, reason: "redirects" });
    expect(loop.calls).toHaveLength(5);

    const chain = await failure({ [PAGE]: redirectTo("https://a.example.org/"), "https://a.example.org/": redirectTo("https://169.254.169.254/") });
    expect(chain.r).toEqual({ ok: false, reason: "blocked" });
    expect(await failure({ [PAGE]: { status: 302 } })).toMatchObject({ r: { ok: false, reason: "status" } });
  });

  test("body size cap: declared length, and bytes actually read", async () => {
    const declared = await failure({ [PAGE]: { body: "x", headers: { "content-length": "999999" } } });
    expect(declared.r).toEqual({ ok: false, reason: "too_large" });
    const streamed = await failure({ [PAGE]: { body: "y".repeat(5_000) } });
    expect(streamed.r).toEqual({ ok: false, reason: "too_large" });
    const fits = await failure({ [PAGE]: { body: "y".repeat(1_024) } });
    expect(fits.r).toMatchObject({ ok: true });
    // a stream that never ends is cut at the cap, not buffered
    let pulled = 0;
    const endless = new Response(
      new ReadableStream({
        pull(c) {
          pulled += 512;
          c.enqueue(new Uint8Array(512));
        },
      }),
    );
    expect(await readLimited(endless, 4_096)).toBeNull();
    expect(pulled).toBeLessThan(4_096 * 4);
  });

  test("a server that never answers is cut off at the deadline", async () => {
    const hang = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const started = Date.now();
    const r = await fetchPublic(PAGE, { fetch: hang, maxBytes: 1024, timeoutMs: 50 });
    expect(r).toEqual({ ok: false, reason: "network" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("HTTP errors", async () => {
    expect((await failure({ [PAGE]: { status: 404 } })).r).toEqual({ ok: false, reason: "status", status: 404 });
    expect((await failure({ [PAGE]: { status: 500 } })).r).toEqual({ ok: false, reason: "status", status: 500 });
  });
});
