// Cold-load performance of a built dashboard on a throttled phone profile.
//
//   node e2e/perf.mjs [--dist=dist] [--routes=/sign-in,/] [--runs=3] [--demo-session] [--h1] [--verbose]
//
// Serves the build with a small static server that behaves like the real
// hosts (HTTP/2 over TLS, Brotli, SPA fallback, immutable hashed assets;
// `--h1` for plain HTTP/1.1 like `vite preview`), then loads each
// route in headless Chromium with the DevTools "Slow 4G" network profile, a 4x
// CPU slowdown and a 412x823 phone viewport, with a cold cache every run.
// Prints the median FCP, LCP, total blocking time (long tasks over 50 ms),
// time until the screen's <h1> shows, CLS and the bytes transferred.
// `--demo-session` signs the demo build in (session storage) so the members'
// screens can be measured without a backend. Nothing is screenshotted.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { chromium } from "@playwright/test";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const DIST = resolve(args.dist ?? "dist");
const ROUTES = (args.routes ?? "/sign-in").split(",");
const RUNS = Number(args.runs ?? 3);

// DevTools "Slow 4G" (formerly "Fast 3G"): 562.5 ms RTT, 1.44 Mbit/s down, 675 kbit/s up.
const NETWORK = {
  offline: false,
  latency: 562.5,
  downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8,
  uploadThroughput: (750 * 1024 * 0.9) / 8,
};
const CPU_SLOWDOWN = 4;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const cache = new Map();

async function body(path) {
  if (!cache.has(path)) {
    const raw = await readFile(path);
    const compressible = /\.(html|js|css|svg)$/.test(path);
    cache.set(path, { raw, br: compressible ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) : null });
  }
  return cache.get(path);
}

// ---- a throwaway self-signed certificate (in memory), so the server can speak
// HTTP/2 like Cloudflare Pages and Vercel do. Browsers only do HTTP/2 over TLS;
// over HTTP/1.1 Chromium opens at most 6 connections per host and a page with
// 20 small chunks waits several extra round trips that real hosts never cause.
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const len = body.length < 128 ? Buffer.from([body.length]) : (() => {
    const bytes = [];
    for (let n = body.length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const oid = (s) => {
  const [a, b, ...rest] = s.split(".").map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const bytes = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) bytes.unshift(0x80 | (v & 0x7f));
    out.push(...bytes);
  }
  return der(0x06, Buffer.from(out));
};
function selfSigned() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const alg = der(0x30, oid("1.2.840.10045.4.3.2"));
  const name = der(0x30, der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, Buffer.from("localhost")))));
  const time = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
  const now = Date.now();
  const san = der(0x30, oid("2.5.29.17"), der(0x04, der(0x30, der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1])))));
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1, ...randomBytes(8)])),
    alg,
    name,
    der(0x30, time(new Date(now - 864e5)), time(new Date(now + 864e5))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, der(0x30, san)),
  );
  const cert = der(0x30, tbs, alg, der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

const H1 = !!args.h1;
const handler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let path = join(DIST, decodeURIComponent(url.pathname));
  if (!path.startsWith(DIST + sep) && path !== DIST) {
    res.writeHead(403).end();
    return;
  }
  const isFile = await stat(path).then((s) => s.isFile()).catch(() => false);
  if (!isFile) path = join(DIST, "index.html");
  const { raw, br } = await body(path);
  const headers = {
    "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
    "Cache-Control": path.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  };
  const useBr = br && /\bbr\b/.test(req.headers["accept-encoding"] ?? "");
  if (useBr) headers["Content-Encoding"] = "br";
  res.writeHead(200, headers).end(useBr ? br : raw);
};
const server = H1 ? createServer(handler) : createSecureServer({ ...selfSigned(), allowHTTP1: true }, handler);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `${H1 ? "http" : "https"}://127.0.0.1:${server.address().port}`;
console.log(`Serving ${DIST} over ${H1 ? "HTTP/1.1" : "HTTP/2 (TLS)"}; Slow 4G, ${CPU_SLOWDOWN}x CPU, 412x823 phone`);

const browser = await chromium.launch({ headless: true, executablePath: process.env.RB_CHROME || undefined });

/** Signs in to the demo build once (unthrottled) and returns its session-storage entry. */
async function demoSession() {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sign-in`);
  await page.getByLabel("Email").fill("owner@demo.rulebox.test");
  await page.getByLabel("Password", { exact: true }).fill("rulebox-demo-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/mfa/);
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/mfa"));
  const value = await page.evaluate(() => sessionStorage.getItem("rulebox.demo.session"));
  await ctx.close();
  return value;
}
const session = args["demo-session"] ? await demoSession() : null;

async function measure(route) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 412, height: 823 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "no-preference",
  });
  if (session) {
    // The seeded demo Owner, already past MFA (src/data/demo/store.ts keeps it in session storage).
    await ctx.addInitScript((s) => sessionStorage.setItem("rulebox.demo.session", s), session);
  }
  await ctx.addInitScript(() => {
    const p = (window.__perf = { long: [], lcp: 0, cls: 0, h1: 0 });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => p.long.push([e.startTime, e.duration]))).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (p.lcp = e.startTime))).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) p.cls += e.value; })).observe({ type: "layout-shift", buffered: true });
    const mo = new MutationObserver(() => {
      if (!p.h1 && document.querySelector("h1") && !document.querySelector("[aria-busy='true']")) {
        p.h1 = performance.now();
        mo.disconnect();
      }
    });
    mo.observe(document, { childList: true, subtree: true });
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", NETWORK);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  let bytes = 0;
  let requests = 0;
  const byType = {};
  const urls = new Map();
  cdp.on("Network.responseReceived", (e) => urls.set(e.requestId, e.response.url));
  cdp.on("Network.loadingFinished", (e) => {
    const url = urls.get(e.requestId) ?? "";
    if (!url.startsWith(BASE)) return; // only the dashboard's own files, not the backend
    bytes += e.encodedDataLength;
    requests++;
    if (args.verbose) console.log(`    ${(e.encodedDataLength / 1024).toFixed(1).padStart(6)} KB ${url}`);
    const t = extname(new URL(url).pathname) || ".html";
    byType[t] = (byType[t] ?? 0) + e.encodedDataLength;
  });
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(BASE + route, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__perf.h1 > 0, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const m = await page.evaluate(() => {
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    const p = window.__perf;
    const tbt = p.long.filter(([s]) => s >= fcp).reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
    const longest = p.long.reduce((a, [, d]) => Math.max(a, d), 0);
    return { fcp, lcp: p.lcp, tbt, longest, h1: p.h1, cls: p.cls, path: location.pathname };
  });
  await ctx.close();
  return { ...m, bytes, requests, byType };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const route of ROUTES) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await measure(route));
  const pick = (k) => median(runs.map((r) => r[k]));
  const kb = (n) => (n / 1024).toFixed(1);
  const types = Object.entries(runs[0].byType).map(([t, n]) => `${t} ${kb(n)}`).join(", ");
  console.log(
    `${route.padEnd(10)} → ${runs[0].path.padEnd(10)} FCP ${pick("fcp").toFixed(0)} ms | LCP ${pick("lcp").toFixed(0)} ms | ` +
      `h1 ${pick("h1").toFixed(0)} ms | TBT ${pick("tbt").toFixed(0)} ms (longest task ${pick("longest").toFixed(0)} ms) | ` +
      `CLS ${pick("cls").toFixed(3)} | ${kb(pick("bytes"))} KB in ${pick("requests")} requests (${types})`,
  );
}
await browser.close();
server.close();
