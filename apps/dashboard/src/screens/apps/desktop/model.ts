/**
 * Pure helpers of the Windows app screens (the review/add flow and the Details tab): what a popular app, a winget answer or a checked
 * installer fills into the form, which status lines to show, and the small text rules (a name from a file name, the program folder
 * from winget's install location). No React, so every rule is a plain test.
 */
import { prefillFor } from "@convex/lib/installerDetect";
import type { AppDetail, DesktopSpec, InstallerInspection, WingetResolved } from "../../../data/types";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { silentStatus, type SilentStatus } from "../../../lib/apps/silentMode";
import { storedTech } from "../../../lib/apps/installerRules";
import * as v from "../../../lib/validate";
import type { FormValues } from "../appForm";
import type { GalleryApp } from "../gallery/catalog";

const t = appAddStrings;

/** The form's "no app yet": `initialValues` of a new Windows program starts from this. */
export function blankDesktopDetail(): AppDetail {
  return {
    _id: "new",
    name: "",
    kind: "desktop",
    archived: false,
    revision: 0,
    createdAt: 0,
    assignments: [],
    fileTypes: [],
    directEmployeeCount: 0,
    groupOptions: [],
    denials30d: [],
  };
}

/** What the form shows as "automatic" for the install command: the winget switches, a detection's, or the table for the stored technology. */
export interface Automatic {
  silentArgs: string;
  successCodes: string;
}

export function automaticOf(x: FormValues, inspection: InstallerInspection | null): Automatic {
  if (x.source === "winget") return { silentArgs: x.resolved ? v.joinArgs(x.resolved.install.silentArgs) : "", successCodes: x.successCodes };
  if (inspection !== null && inspection.kind === "exe") return { silentArgs: v.joinArgs(inspection.silentArgs), successCodes: [...new Set(inspection.successExitCodes)].join(", ") };
  if (x.source === "exe" && x.tech !== "") {
    const p = prefillFor(x.tech);
    return { silentArgs: v.joinArgs(p.silentArgs), successCodes: [...new Set(p.successExitCodes)].join(", ") };
  }
  return { silentArgs: "", successCodes: "0" };
}

export interface Line {
  id: "silent" | "checked" | "winget" | "removal" | "version";
  tone: "success" | "warning" | "neutral";
  label: string;
  info: string;
  /** A sentence under the line that must stay visible (per-user, best guess). */
  note?: string;
}

export interface LinesResult {
  silent: SilentStatus;
  lines: Line[];
}

/** The status lines of a Windows app, in the order a person reads them: how it installs, that it is checked, where it comes from, what happens on removal, which version. */
export function linesOf(x: FormValues, inspection: InstallerInspection | null): LinesResult {
  const auto = automaticOf(x, inspection);
  const fromWinget = x.source === "winget";
  const silent = silentStatus({
    source: x.source,
    kind: fromWinget ? x.resolved?.install.kind : x.source === "msi" ? "msi" : x.source === "exe" ? "exe" : undefined,
    tech: fromWinget ? (x.resolved?.install.tech ?? "") : (inspection?.tech ?? x.tech),
    confidence: inspection?.confidence,
    silentArgs: x.silentArgs,
    autoArgs: auto.silentArgs,
    needsAnswerFile: inspection?.needsAnswerFile,
    answerReady: x.answerOn && x.answerUrl.trim() !== "" && x.answerSha256.trim() !== "",
    perUserLikely: inspection?.perUserLikely,
  });
  const lines: Line[] = [];
  if (silent.state !== "unknown" && silent.state !== "needs_answer") {
    const note = silent.perUser ? t.silent.perUserWarning : silent.state === "guess" ? t.silent.guessWarning : undefined;
    lines.push({ id: "silent", tone: silent.tone, label: silent.label, info: silent.info, ...(note !== undefined ? { note } : {}) });
  }
  const hash = fromWinget ? (x.resolved?.install.sha256 ?? "") : x.sha256.trim();
  if (x.source !== "preinstalled" && hash !== "") lines.push({ id: "checked", tone: "success", label: t.lines.checked, info: t.lines.checkedInfo });
  if (fromWinget && x.resolved) lines.push({ id: "winget", tone: "neutral", label: t.lines.wingetFrom(x.resolved.version), info: t.lines.wingetInfo });
  const installKind = fromWinget ? x.resolved?.install.kind : x.source;
  if (x.source !== "preinstalled" && installKind !== undefined && (installKind === "msi" || installKind === "exe" || installKind === "portable")) {
    const removable = installKind !== "exe";
    lines.push(
      removable && x.removeWhenUnassigned
        ? { id: "removal", tone: "neutral", label: t.lines.remove, info: t.lines.removeInfo }
        : { id: "removal", tone: "neutral", label: t.lines.keep, info: removable ? t.lines.keepOffInfo : t.lines.keepInfo },
    );
  }
  if (x.source !== "preinstalled" && x.version.trim() !== "") lines.push({ id: "version", tone: "neutral", label: t.lines.version(x.version.trim()), info: t.lines.versionInfo });
  return { silent, lines };
}

/** `{ProgramFiles}\VideoLAN\VLC\vlc.exe` for a person: `Program Files\VideoLAN\VLC\vlc.exe`. */
export function friendlyPath(exe: string): string {
  const roots = t.program.roots;
  const root = Object.keys(roots).find((r) => exe.startsWith(r));
  return root === undefined ? exe : `${roots[root]}\\${exe.slice(root.length)}`;
}

/** `{ProgramFiles}\VideoLAN\VLC` (winget's install folder) as the start of a program path; the person adds the file name. */
export function exeFolderOf(location: string | undefined): string | null {
  if (location === undefined) return null;
  const folder = location.trim().replace(/[\\/]+$/, "");
  const prefixes = ["{ProgramFiles}\\", "{ProgramFilesX86}\\", "{SystemRoot}\\System32\\"];
  return prefixes.some((p) => folder.startsWith(p) && folder.length > p.length) ? `${folder}\\` : null;
}

/** Everything a resolved winget package (and the popular-apps entry it came from) fills into the form. */
export function wingetFill(r: WingetResolved, entry: GalleryApp | undefined, x: FormValues): Partial<FormValues> {
  const folder = exeFolderOf(r.defaultInstallLocation);
  return {
    source: "winget",
    wingetId: r.packageId,
    wingetVersion: r.version,
    resolved: r,
    name: entry?.name ?? (x.name.trim() !== "" ? x.name : (r.name ?? "")),
    ...(entry !== undefined ? { hue: entry.hue } : {}),
    removeWhenUnassigned: r.install.removeWhenUnassigned,
    silentArgs: v.joinArgs(r.install.silentArgs),
    version: r.version,
    exe: entry?.exe ?? folder ?? x.exe,
    // The publisher that the vendor update rule needs: winget names it.
    publisher: x.publisher !== "" ? x.publisher : (r.publisher ?? ""),
    tech: r.install.tech !== undefined ? storedTech(r.install.tech) : "",
  };
}

/** A name for an app from the file it installs: `pos-setup-2.4.exe` becomes "Pos 2 4". Empty when the file name says nothing. */
export function nameFromUrl(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url.trim()).pathname.split("/").filter(Boolean).pop() ?? "");
    const base = last
      .replace(/\.(exe|msi)$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b(setup|installer|install|x64|x86|win64|win32|amd64)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (base === "") return "";
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return "";
  }
}

/** A vendor's name usable in "Usually under Program Files\<company>" (no trademark marks, no company suffix). */
export function companyFolder(company: string | undefined): string | null {
  const c = (company ?? "").replace(/[™®©]/g, "").replace(/,?\s+(inc|ltd|llc|gmbh|corp|corporation|co|limited|s\.?a\.?|b\.?v\.?)\.?$/i, "").trim();
  return c === "" || /[\\/:*?"<>|]/.test(c) ? null : c;
}

/**
 * The "before" the form compares an installer with: the add flow knows the size of the file it checked, which the form has no field
 * for, so the saved spec carries it (same url and SHA-256 keep their size, see `desktopSpec`).
 */
export function checkedBefore(url: string, sha256: string, sizeBytes: number): DesktopSpec {
  return {
    source: "exe",
    exe: "",
    args: [],
    fileArgTemplate: [],
    resetFolders: [],
    install: { kind: "exe", url: url.trim(), sha256: sha256.toLowerCase(), sizeBytes, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: false },
  };
}
