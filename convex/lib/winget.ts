import { parse } from "yaml";
import type { Infer } from "convex/values";
import { httpsUrlProblem, wingetIdProblem, wingetVersionProblem } from "./appRules";
import { fail } from "./errors";
import { WINGET_MAX_LISTING_BYTES, WINGET_MAX_MANIFEST_BYTES, WINGET_MAX_VERSION_TRIES, WINGET_TIMEOUT_MS } from "./limits";
import { fetchPublic } from "./safeFetch";
import type { installSpec, wingetResolved } from "./validators";

// Winget package -> install spec (plan 4.8 "Choosing a winget installer
// entry", Step 10 item 4). The agent NEVER runs winget (it fails under SYSTEM):
// the server reads the public manifest from the winget-pkgs repository once,
// at "Resolve" time, and the signed document then carries the plain URL + hash.
//
// `pickInstaller` is pure and tested on committed manifests
// (`convex/testdata/winget/`). Everything that touches the network is in
// `resolveWinget`, which takes `fetch` from the caller's global (tests stub it).

type InstallSpec = Infer<typeof installSpec>;
export type WingetResolved = Infer<typeof wingetResolved>;

// ---------------------------------------------------------------- picking an installer

type Json = Record<string, unknown>;

const SUPPORTED_TYPES = ["msi", "wix", "exe", "inno", "nullsoft", "burn"] as const;
type InstallerType = (typeof SUPPORTED_TYPES)[number];

/** Silent switches of the installer frameworks that have a fixed one (plan 4.8 item 3). */
const DEFAULT_SILENT: Partial<Record<InstallerType, string[]>> = {
  inno: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"],
  nullsoft: ["/S"],
  burn: ["/quiet", "/norestart"],
};

export type PickResult =
  | { ok: true; install: InstallSpec; defaultInstallLocation?: string }
  | { ok: false; reason: string };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Entry-level value, else manifest-level. */
function inherited<T>(entry: Json, manifest: Json, read: (o: Json) => T | undefined): T | undefined {
  return read(entry) ?? read(manifest);
}

/**
 * `DefaultInstallLocation` as the start of a path template for the "where is the
 * program after install?" hint: `%ProgramFiles%\Git` -> `{ProgramFiles}\Git`. Anything
 * else is passed on as written (it is only a hint; the admin types the real path).
 */
export function locationHint(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text
    .replace(/%ProgramFiles\(x86\)%/gi, "{ProgramFilesX86}")
    .replace(/%ProgramW6432%|%ProgramFiles%/gi, "{ProgramFiles}")
    .replace(/%SystemRoot%|%windir%/gi, "{SystemRoot}");
}

/** Splits a switch string like `/S /D="C:\x y"` into arguments; quoted parts stay together and lose their quotes (the agent quotes what needs it). */
export function splitSwitches(text: string): string[] {
  return [...text.matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map((m) => m[0].replace(/"/g, ""));
}

function typeOf(entry: Json, manifest: Json): string | undefined {
  return inherited(entry, manifest, (o) => str(o.InstallerType)?.toLowerCase());
}

function usable(entry: Json, manifest: Json): InstallerType | null {
  const scope = inherited(entry, manifest, (o) => str(o.Scope)?.toLowerCase());
  if (scope === "user") return null;
  const arch = str(entry.Architecture)?.toLowerCase() ?? str(manifest.Architecture)?.toLowerCase();
  // Windows on ARM is not a target of Rulebox (PRD 6): arm and arm64 are dropped.
  if (arch === "arm64" || arch === "arm") return null;
  const type = typeOf(entry, manifest);
  return type !== undefined && (SUPPORTED_TYPES as readonly string[]).includes(type) ? (type as InstallerType) : null;
}

/** Lower sorts first: machine scope, then x64, then msi/wix, then an English or unspecified locale. */
function rank(entry: Json, manifest: Json, type: InstallerType): [number, number, number, number] {
  const scope = inherited(entry, manifest, (o) => str(o.Scope)?.toLowerCase());
  const arch = (str(entry.Architecture) ?? str(manifest.Architecture) ?? "neutral").toLowerCase();
  const locale = (str(entry.InstallerLocale) ?? str(manifest.InstallerLocale) ?? "").toLowerCase();
  return [
    scope === "machine" ? 0 : 1,
    arch === "x64" ? 0 : 1,
    type === "msi" || type === "wix" ? 0 : 1,
    locale === "" || locale.startsWith("en") ? 0 : 1,
  ];
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

function productCodeOf(entry: Json, manifest: Json): string | undefined {
  const direct = inherited(entry, manifest, (o) => str(o.ProductCode));
  if (direct !== undefined) return direct;
  for (const holder of [entry, manifest]) {
    const entries = holder.AppsAndFeaturesEntries;
    if (Array.isArray(entries) && isObject(entries[0])) {
      const code = str(entries[0].ProductCode);
      if (code !== undefined) return code;
    }
  }
  return undefined;
}

function successCodesOf(entry: Json, manifest: Json): number[] {
  const raw = inherited(entry, manifest, (o) => (Array.isArray(o.InstallerSuccessCodes) ? (o.InstallerSuccessCodes as unknown[]) : undefined)) ?? [];
  const codes = raw.filter((c): c is number => typeof c === "number" && Number.isInteger(c) && c >= -2_147_483_648 && c <= 2_147_483_647);
  return [0, ...[...new Set(codes)].filter((c) => c !== 0).sort((a, b) => a - b)];
}

/**
 * Choose the installer entry Rulebox can install silently, machine-wide, on
 * x64 Windows, and turn it into an `installSpec` (sizes are unknown in
 * manifests: 0). Order of preference (plan 4.8): drop `Scope: user`, ARM and
 * unsupported installer types; prefer `Scope: machine`, then x64, then
 * msi/wix. A plain `exe` with no `Silent` switch is refused: the installer
 * would open a window nobody can click.
 */
export function pickInstaller(manifest: unknown): PickResult {
  if (!isObject(manifest)) return { ok: false, reason: "the manifest is not readable" };
  const entries = Array.isArray(manifest.Installers) ? manifest.Installers.filter(isObject) : [];
  if (entries.length === 0) return { ok: false, reason: "the manifest lists no installer" };

  const candidates = entries
    .map((entry, index) => ({ entry, index, type: usable(entry, manifest) }))
    .filter((c): c is { entry: Json; index: number; type: InstallerType } => c.type !== null);
  if (candidates.length === 0) {
    return { ok: false, reason: "it only offers per-user, ARM or non-installer packages (no machine-wide x64 msi or exe)" };
  }
  candidates.sort((a, b) => compareRank(rank(a.entry, manifest, a.type), rank(b.entry, manifest, b.type)) || a.index - b.index);

  let refused = "this package has no silent install";
  for (const { entry, type } of candidates) {
    const url = str(entry.InstallerUrl);
    const sha = str(entry.InstallerSha256)?.toLowerCase();
    if (url === undefined || httpsUrlProblem(url)) {
      refused = "its installer is not downloaded over https";
      continue;
    }
    if (sha === undefined || !/^[0-9a-f]{64}$/.test(sha)) {
      refused = "its installer has no SHA-256";
      continue;
    }
    const meta = isObject(entry.InstallationMetadata) ? entry.InstallationMetadata : isObject(manifest.InstallationMetadata) ? manifest.InstallationMetadata : {};
    const defaultInstallLocation = locationHint(str(meta.DefaultInstallLocation));
    const base = { url, sha256: sha, sizeBytes: 0, successExitCodes: successCodesOf(entry, manifest) };

    if (type === "msi" || type === "wix") {
      const code = productCodeOf(entry, manifest)?.toUpperCase();
      return {
        ok: true,
        install: {
          kind: "msi",
          ...base,
          silentArgs: [],
          ...(code !== undefined && /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/.test(code) ? { productCode: code } : {}),
          removeWhenUnassigned: true,
        },
        defaultInstallLocation,
      };
    }
    const switches = inherited(entry, manifest, (o) => (isObject(o.InstallerSwitches) ? str(o.InstallerSwitches.Silent) : undefined));
    const silentArgs = switches !== undefined ? splitSwitches(switches) : (DEFAULT_SILENT[type] ?? []);
    if (silentArgs.length === 0) continue; // plain exe without a silent switch
    return {
      ok: true,
      install: { kind: "exe", ...base, silentArgs, removeWhenUnassigned: false },
      defaultInstallLocation,
    };
  }
  return { ok: false, reason: refused };
}

// ---------------------------------------------------------------- parsing

/** Parses installer-manifest YAML. Untrusted text: no aliases beyond a handful, size capped by the caller. */
export function parseManifest(text: string): unknown {
  try {
    return parse(text, { maxAliasCount: 20, uniqueKeys: false });
  } catch {
    return null;
  }
}

/** The package's display name and publisher from a locale manifest (best effort). */
export function parseLocale(text: string): { name?: string; publisher?: string } {
  const doc = parseManifest(text);
  if (!isObject(doc)) return {};
  const clean = (v: unknown): string | undefined => {
    const s = str(v);
    return s !== undefined && s.length <= 100 && !/[\u0000-\u001f\u007f]/.test(s) ? s : undefined; // eslint-disable-line no-control-regex
  };
  return { name: clean(doc.PackageName), publisher: clean(doc.Publisher) };
}

// ---------------------------------------------------------------- version order

/** Splits a version into numeric and text parts: "1.2.10-beta" -> [1, 2, 10, "beta"]. */
function versionParts(v: string): (number | string)[] {
  return v
    .split(/[.\-+_]/)
    .filter((p) => p !== "")
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p.toLowerCase()));
}

/** Negative when `a` is older than `b`. Numbers compare numerically and rank above text at the same position. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    if (p === undefined) return typeof q === "number" ? -1 : 1; // "1.0" < "1.0.1", but "1.0" > "1.0-beta"
    if (q === undefined) return typeof p === "number" ? 1 : -1;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return 1;
    if (typeof q === "number") return -1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------- addresses

const RAW = "https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests";
const API = "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests";

/** `manifests/<first letter lower-case>/<id with "." -> "/">` */
function packagePath(id: string): string {
  return `${id.charAt(0).toLowerCase()}/${id.split(".").join("/")}`;
}

export function installerManifestUrl(id: string, version: string): string {
  return `${RAW}/${packagePath(id)}/${version}/${id}.installer.yaml`;
}

export function localeManifestUrl(id: string, version: string): string {
  return `${RAW}/${packagePath(id)}/${version}/${id}.locale.en-US.yaml`;
}

export function versionListUrl(id: string): string {
  return `${API}/${packagePath(id)}`;
}

// ---------------------------------------------------------------- resolve (network)

type FetchLike = typeof fetch;

const GITHUB_HOSTS = new Set(["raw.githubusercontent.com", "api.github.com"]);

/** One GET of a GitHub address: the text, or the status that was not 2xx (0 = network, -1 = too large). */
async function getText(
  f: FetchLike | undefined,
  url: string,
  max: number,
  token: string | undefined,
): Promise<{ status: number; text: string }> {
  const res = await fetchPublic(url, {
    fetch: f,
    maxBytes: max,
    accept: url.startsWith(API) ? "application/vnd.github+json" : "text/plain",
    timeoutMs: WINGET_TIMEOUT_MS,
    maxRedirects: 2,
    // The token goes to the API host only, never to a redirect target or the raw host.
    headers: (u) => ({
      "user-agent": "rulebox-dashboard",
      ...(token !== undefined && token !== "" && u.hostname === "api.github.com" ? { authorization: `Bearer ${token}` } : {}),
    }),
  });
  if (res.ok) {
    if (!GITHUB_HOSTS.has(res.url.hostname)) return { status: 0, text: "" };
    return { status: 200, text: new TextDecoder().decode(res.bytes) };
  }
  if (res.reason === "too_large") return { status: -1, text: "" };
  return { status: res.reason === "status" ? (res.status ?? 0) : 0, text: "" };
}

function unreachable(): never {
  fail("winget_unreachable", { detail: "GitHub did not answer; set GITHUB_TOKEN to raise the rate limit" });
}

/** Newest-first version folders from the GitHub contents API listing (folders that look like versions). */
export function versionsFromListing(listing: unknown): string[] {
  if (!Array.isArray(listing)) return [];
  const names = listing
    .filter((e): e is Json => isObject(e) && e.type === "dir")
    .map((e) => str(e.name))
    .filter((n): n is string => n !== undefined && /^[0-9][A-Za-z0-9._+-]{0,63}$/.test(n));
  return names.sort((a, b) => compareVersions(b, a));
}

export type ResolveOptions = { fetch?: FetchLike; githubToken?: string };

/**
 * Resolve `packageId` (and optionally `version`) to an install spec: the
 * newest version's installer manifest unless a version is named. Errors:
 * `winget_unreachable` (GitHub not reachable or rate-limited),
 * `winget_unsupported` with the reason (not found, nothing usable).
 */
export async function resolveWinget(packageId: string, version: string | undefined, opts: ResolveOptions = {}): Promise<WingetResolved> {
  if (wingetIdProblem(packageId)) fail("invalid_argument", { field: "packageId" });
  if (version !== undefined && wingetVersionProblem(version)) fail("invalid_argument", { field: "version" });
  const token = opts.githubToken;

  let versions: string[];
  if (version !== undefined) {
    versions = [version];
  } else {
    const listing = await getText(opts.fetch, versionListUrl(packageId), WINGET_MAX_LISTING_BYTES, token);
    if (listing.status === 404) fail("winget_unsupported", { detail: "package not found (ids are case-sensitive, like VideoLAN.VLC)" });
    if (listing.status !== 200) unreachable();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(listing.text);
    } catch {
      unreachable();
    }
    versions = versionsFromListing(parsed).slice(0, WINGET_MAX_VERSION_TRIES);
    if (versions.length === 0) fail("winget_unsupported", { detail: "no versions found" });
  }

  let manifestText: string | null = null;
  let chosen = "";
  for (const v of versions) {
    const res = await getText(opts.fetch, installerManifestUrl(packageId, v), WINGET_MAX_MANIFEST_BYTES, token);
    if (res.status === 200) {
      manifestText = res.text;
      chosen = v;
      break;
    }
    if (res.status === -1) fail("winget_unsupported", { detail: "its manifest is too large" });
    if (res.status !== 404) unreachable();
  }
  if (manifestText === null) fail("winget_unsupported", { detail: version !== undefined ? "that version was not found" : "package not found" });

  const manifest = parseManifest(manifestText);
  const picked = pickInstaller(manifest);
  if (!picked.ok) fail("winget_unsupported", { detail: picked.reason });
  const m = manifest as Json;
  // The manifest's own identity must be the one asked for (a mislabelled folder is not trusted).
  const identifier = str(m.PackageIdentifier);
  if (identifier === undefined || identifier.toLowerCase() !== packageId.toLowerCase()) {
    fail("winget_unsupported", { detail: "the manifest is for another package" });
  }
  const resolvedVersion = str(m.PackageVersion) ?? chosen;
  if (wingetVersionProblem(resolvedVersion)) fail("winget_unsupported", { detail: "the manifest has an unusable version" });

  // Display name and publisher live in the locale manifest; best effort, never fatal.
  const locale = await getText(opts.fetch, localeManifestUrl(packageId, chosen), WINGET_MAX_MANIFEST_BYTES, token);
  const names = locale.status === 200 ? parseLocale(locale.text) : {};
  return {
    packageId,
    version: resolvedVersion,
    install: picked.install,
    ...(picked.defaultInstallLocation !== undefined ? { defaultInstallLocation: picked.defaultInstallLocation } : {}),
    ...(names.publisher !== undefined ? { publisher: names.publisher } : {}),
    ...(names.name !== undefined ? { name: names.name } : {}),
  };
}