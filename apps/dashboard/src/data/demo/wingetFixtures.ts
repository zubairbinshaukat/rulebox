/**
 * Demo twins of three server answers of the Add app flow (UI pass `docs/plans/ui-pass/add-app.md` section 8): `apps:resolveWinget`
 * for every package of the popular-apps gallery, `apps:inspectInstaller` (the technology comes from words in the address) and
 * `apps:fingerprintInstaller` (the same, plus a made-up but stable hash). No network. Demo only: this module is imported by
 * `demo/hooks.ts`, so it never reaches a live build.
 *
 * The versions and installer kinds follow the plan's section 7 table (what `winget-pkgs` offered on 2026-11-28 after the server's
 * own picking rules: machine scope, x64, `msi`/`wix` first). The hashes are made up. `Microsoft.Teams` and `SlackTechnologies.Slack`
 * answer `winget_unsupported` like the live server does (an MSIX package and a per-user installer).
 */
import { prefillFor } from "@convex/lib/installerDetect";
import * as validate from "../../lib/validate";
import type { DetectedTech, FingerprintResult, InstallerInspection, WingetResolved } from "../types";
import { fail } from "./store";

type Known = { kind: "msi" | "exe"; version: string; silent?: string[]; where?: string; product?: string; name: string; publisher: string };

/** Lower-case package id -> what the manifest says. */
const KNOWN: Record<string, Known> = {
  // The first three are the ones the demo always had.
  "7zip.7zip": { kind: "msi", version: "24.08", where: "{ProgramFiles}\\7-Zip", product: "{23170F69-40C1-2702-2408-000001000000}", name: "7-Zip", publisher: "Igor Pavlov" },
  "videolan.vlc": { kind: "exe", version: "3.0.21", silent: ["/S"], where: "{ProgramFiles}\\VideoLAN\\VLC", name: "VLC media player", publisher: "VideoLAN" },
  "notepad++.notepad++": { kind: "exe", version: "8.8.9", silent: ["/S"], where: "{ProgramFiles}\\Notepad++", name: "Notepad++", publisher: "Notepad++ Team" },
  // The rest of the gallery (`screens/apps/gallery/catalog.ts`).
  "google.chrome": { kind: "msi", version: "131.0.6778.205", where: "{ProgramFiles}\\Google\\Chrome", name: "Google Chrome", publisher: "Google LLC" },
  "mozilla.firefox": { kind: "exe", version: "133.0", silent: ["/S", "/PreventRebootRequired=true"], where: "{ProgramFiles}\\Mozilla Firefox", name: "Mozilla Firefox", publisher: "Mozilla" },
  "zoom.zoom": { kind: "msi", version: "6.2.11", where: "{ProgramFiles}\\Zoom", name: "Zoom Workplace", publisher: "Zoom Video Communications" },
  "thedocumentfoundation.libreoffice": { kind: "msi", version: "24.8.3", where: "{ProgramFiles}\\LibreOffice", name: "LibreOffice", publisher: "The Document Foundation" },
  "onlyoffice.desktopeditors": { kind: "exe", version: "8.2.1", silent: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], where: "{ProgramFiles}\\ONLYOFFICE\\DesktopEditors", name: "ONLYOFFICE Desktop Editors", publisher: "Ascensio System SIA" },
  "adobe.acrobat.reader.64-bit": { kind: "exe", version: "24.005.20320", silent: ["-sfx_nu", "/sAll", "/rs", "/msi"], name: "Adobe Acrobat Reader (64-bit)", publisher: "Adobe" },
  "sumatrapdf.sumatrapdf": { kind: "exe", version: "3.5.2", silent: ["-s"], name: "SumatraPDF", publisher: "Krzysztof Kowalczyk" },
  "foxit.foxitreader": { kind: "msi", version: "2024.3.0.26795", where: "{ProgramFiles}\\Foxit Software\\Foxit PDF Reader", name: "Foxit PDF Reader", publisher: "Foxit Software" },
  "mozilla.thunderbird": { kind: "exe", version: "128.5.0", silent: ["/S"], where: "{ProgramFiles}\\Mozilla Thunderbird", name: "Mozilla Thunderbird", publisher: "Mozilla" },
  "irfanskiljan.irfanview": { kind: "exe", version: "4.70", silent: ["/silent"], name: "IrfanView", publisher: "Irfan Skiljan" },
  "gimp.gimp.3": { kind: "exe", version: "3.0.0", silent: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], where: "{ProgramFiles}\\GIMP 3", name: "GIMP", publisher: "The GIMP Team" },
  "audacity.audacity": { kind: "msi", version: "4.0.0", where: "{ProgramFiles}\\Audacity 4", name: "Audacity", publisher: "Audacity Team" },
  "inkscape.inkscape": { kind: "msi", version: "1.4", where: "{ProgramFiles}\\Inkscape", name: "Inkscape", publisher: "Inkscape Project" },
  "keepassxcteam.keepassxc": { kind: "msi", version: "2.7.9", where: "{ProgramFiles}\\KeePassXC", name: "KeePassXC", publisher: "KeePassXC Team" },
};

/** Lower-case package id -> why the server refuses it. */
const UNSUPPORTED: Record<string, string> = {
  "spotify.spotify": "it only offers a per-user (Scope: user) installer",
  "microsoft.teams": "it only offers per-user, ARM or non-installer packages (no machine-wide x64 msi or exe)",
  "slacktechnologies.slack": "it only offers a per-user (Scope: user) installer",
};

/** The package ids the demo can resolve (the gallery's, in `catalog.ts` spelling is not needed: lookups are case-insensitive). */
export const DEMO_WINGET_IDS: readonly string[] = Object.keys(KNOWN);

/** A stable 64-character hex string for `text` (made up: the demo has no files): eight FNV-1a words with different seeds. */
function fakeSha256(text: string): string {
  let out = "";
  for (let word = 0; word < 8; word++) {
    let h = (0x811c9dc5 ^ Math.imul(word + 1, 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    out += ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}
/** The demo answer of `apps:resolveWinget`, or the server's refusal (`fail` throws). Lookups are case-insensitive in the demo. */
export function demoResolveWinget(packageId: string, version?: string): WingetResolved {
  const id = packageId.trim();
  if (validate.wingetId(id)) fail("invalid_argument", { field: "packageId" });
  const lower = id.toLowerCase();
  if (UNSUPPORTED[lower] !== undefined) fail("winget_unsupported", { detail: UNSUPPORTED[lower] });
  if (lower.startsWith("offline.")) fail("winget_unreachable");
  const k = KNOWN[lower];
  if (!k) fail("winget_unsupported", { detail: "no machine-wide x64 installer with a silent switch was found" });
  const v = version?.trim() || k.version;
  return {
    packageId: id,
    version: v,
    name: k.name,
    publisher: k.publisher,
    ...(k.where !== undefined ? { defaultInstallLocation: k.where } : {}),
    install: {
      kind: k.kind,
      url: `https://downloads.example.com/winget/${lower}/${v}/setup.${k.kind}`,
      sha256: fakeSha256(`${lower}@${v}`),
      sizeBytes: 12_345_678,
      silentArgs: k.silent ?? [],
      ...(k.product !== undefined ? { productCode: k.product } : {}),
      successExitCodes: [0],
      removeWhenUnassigned: k.kind === "msi",
    },
  };
}

/** The installer type a demo address names (words in the address: nsis, inno, burn, script, shield, advanced; `.msi`; else a plain exe). */
export function demoInspectionOf(url: string): InstallerInspection {
  const path = url.toLowerCase();
  const tech: DetectedTech = path.endsWith(".msi")
    ? "msi"
    : path.includes("nsis")
      ? "nsis"
      : path.includes("inno")
        ? "inno"
        : path.includes("burn")
          ? "burn"
          : path.includes("script")
            ? "installshield_script"
            : path.includes("shield")
              ? "installshield_msi"
              : path.includes("advanced")
                ? "advanced_installer"
                : "exe";
  const p = prefillFor(tech);
  return {
    tech,
    kind: tech === "msi" ? "msi" : "exe",
    confidence: tech === "exe" ? "low" : "high",
    silentArgs: p.silentArgs,
    successExitCodes: p.successExitCodes,
    needsAnswerFile: p.needsAnswerFile,
    perUserLikely: tech === "nsis",
    ...(tech === "exe" || tech === "msi" ? {} : { signer: "Demo Software Ltd", fileVersion: "2.4.1.0", productName: "Demo Setup", companyName: "Demo Software Ltd" }),
    sizeBytes: 48_234_496,
  };
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * The demo answer of `apps:fingerprintInstaller`: the same refusals as the server (`fingerprint_too_large` for `big` in the address,
 * `fingerprint_blocked` for a private host, `fingerprint_failed` for a host named `fail...`, `fingerprint_not_installer` for a zip or
 * a page), else the technology the address names and a made-up hash that is the same for the same address.
 */
export function demoFingerprint(url: string): FingerprintResult {
  if (validate.installerUrl(url) !== null) fail("invalid_argument", { field: "url" });
  const parsed = new URL(url);
  const path = url.toLowerCase();
  if (PRIVATE_HOST.test(parsed.hostname)) fail("invalid_argument", { field: "url", detail: "fingerprint_blocked" });
  if (parsed.hostname.includes("fail")) fail("invalid_argument", { field: "url", detail: "fingerprint_failed" });
  if (path.includes("big")) fail("invalid_argument", { field: "url", detail: "fingerprint_too_large" });
  if (path.endsWith(".zip") || path.endsWith(".html")) fail("invalid_argument", { field: "url", detail: "fingerprint_not_installer" });
  const { sizeBytes, ...inspection } = demoInspectionOf(url);
  return { sha256: fakeSha256(url.trim()), sizeBytes: sizeBytes ?? 48_234_496, inspection };
}
