// Shared pieces of the vendor feed tests (Phase 6 Step 12): the committed vectors and a stub `fetch`. Kept outside convex/ so
// the Convex bundler never pushes it. No test touches the network: `fetch` is always this stub.
import { vi } from "vitest";
import installerText from "../../convex/testdata/feed/installer-2.1.0.bin?raw";
import signatureText from "../../convex/testdata/feed/installer-2.1.0.bin.sig?raw";
import vendorPubText from "../../convex/testdata/feed/vendor.pub?raw";
import otherPubText from "../../convex/testdata/feed/other.pub?raw";
import latestText from "../../convex/testdata/feed/latest.json?raw";

/**
 * Made once with `tauri signer generate` / `tauri signer sign` (tauri-cli 2.12.2): `installer-2.1.0.bin` (1365 bytes of text, not a
 * program), its `.sig` (the `signature` field of `latest.json` is that file's text), the vendor's `.pub` file, and the `.pub` of a
 * second key that signed nothing. The private keys were never committed.
 */
export const INSTALLER = new TextEncoder().encode(installerText);
export const SIGNATURE = signatureText.trim();
/** The `pubkey` field an admin pastes: base64 of the `.pub` file's text (the file already holds exactly that). */
export const VENDOR_PUBKEY = vendorPubText.trim();
export const OTHER_PUBKEY = otherPubText.trim();
export const LATEST = JSON.parse(latestText) as { version: string; platforms: Record<string, { signature: string; url: string }> };

export const FEED_URL = "https://updates.example.com/latest.json";
export const INSTALLER_URL = LATEST.platforms["windows-x86_64-nsis"]!.url;
export const TARGET = "windows-x86_64";

/** A `latest.json` for `version` (the vector's signature and URL unless overridden). */
export function latestJson(version = "2.1.0", over: Partial<{ signature: string; url: string; key: string }> = {}): string {
  return JSON.stringify({
    version,
    notes: "Test release",
    platforms: { [over.key ?? "windows-x86_64-nsis"]: { signature: over.signature ?? SIGNATURE, url: over.url ?? INSTALLER_URL } },
  });
}

export type Route = (req: { url: string; headers: Record<string, string> }) => Response | Promise<Response>;

export type StubbedFetch = typeof fetch & { urls: () => string[]; headersOf: (url: string) => Record<string, string>[] };

/** A `fetch` that answers the given URLs (exact match, no fragment) and fails with a network error for any other one. */
export function stubFetch(routes: Record<string, Route>): StubbedFetch {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ url, headers });
    const route = routes[url];
    if (route === undefined) throw new TypeError(`network error: ${url}`);
    return await route({ url, headers });
  }) as unknown as StubbedFetch;
  fn.urls = () => seen.map((s) => s.url);
  fn.headersOf = (url) => seen.filter((s) => s.url === url).map((s) => s.headers);
  return fn;
}

/** The two routes of a healthy feed: `latest.json` (with an etag) and the installer. */
export function healthyFeed(version = "2.1.0", etag = '"v-' + version + '"'): Record<string, Route> {
  return {
    [FEED_URL]: ({ headers }) =>
      headers["if-none-match"] === etag ? new Response(null, { status: 304 }) : new Response(latestJson(version), { status: 200, headers: { etag, "content-type": "application/json" } }),
    [INSTALLER_URL]: () => new Response(INSTALLER, { status: 200 }),
  };
}

/** A response whose body is `size` bytes of zeros delivered in 1 MiB chunks, so that nothing holds it all. */
export function zeroStream(size: number, declare = false): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = Math.min(1024 * 1024, size - sent);
      if (n <= 0) {
        controller.close();
        return;
      }
      sent += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
  return new Response(body, { status: 200, headers: declare ? { "content-length": String(size) } : {} });
}
