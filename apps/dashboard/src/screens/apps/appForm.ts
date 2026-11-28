/**
 * The app form's model (values, initial values, validation, the saved specs). It used to live in `AppEdit.tsx`;
 * the screens (`AppEdit`, `AppInstaller`, `AppBrowser`, `AppUpdates`) and the new add/edit pages share it.
 * Pure: no React except the `FormApi` type.
 */
import type { useForm } from "../../lib/useForm";
import {
  type AppDetail,
  type AppKind,
  type ApplyWhen,
  type BrowserKind,
  type DesktopSource,
  type DesktopSpec,
  type WizardTech,
  type UpdateMode,
  type UpdateSpec,
  type WingetResolved,
} from "../../data/types";
import { appEditStrings } from "../../lib/screenStrings/appEdit";
import { appBrowserStrings } from "../../lib/screenStrings/appBrowser";
import { installFormStrings } from "../../lib/screenStrings/installRefusals";
import * as v from "../../lib/validate";
import * as u from "../../lib/apps/updateRules";
import * as ins from "../../lib/apps/installerRules";
import { browserSitesProblem } from "../../lib/apps/browserRules";

const s = appEditStrings;
/** The twelve tile colours (hue angles), in picker order. */
export const HUES = [175, 150, 100, 60, 40, 20, 0, 330, 300, 260, 220, 200];
export const SOURCES: DesktopSource[] = ["winget", "msi", "exe", "portable", "preinstalled"];

export interface FormValues extends Record<string, unknown> {
  name: string;
  description: string;
  hue: number | undefined;
  url: string;
  domains: string;
  source: DesktopSource;
  wingetId: string;
  wingetVersion: string;
  resolved: WingetResolved | null;
  installUrl: string;
  sha256: string;
  silentArgs: string;
  productCode: string;
  removeWhenUnassigned: boolean;
  exe: string;
  args: string;
  fileArg: string;
  resetFolders: string;
  // Phase 6: versions and update modes
  version: string;
  updateMode: UpdateMode;
  publisher: string;
  publisherProduct: string;
  minVersion: string;
  feedUrl: string;
  feedPubkey: string;
  feedTarget: string;
  autoPublish: boolean;
  applyWhen: ApplyWhen;
  rollbackOnFail: boolean;
  // Phase 6 Step 16: browser web apps (a website) and browser rules (Chrome or Edge as a program)
  browserKind: BrowserKind;
  chromeAppId: string;
  sites: string;
  // Phase 6 Step 13: installer details (an MSI or EXE program)
  tech: WizardTech | "";
  successCodes: string;
  timeoutMin: string;
  installPublisher: string;
  answerOn: boolean;
  answerUrl: string;
  answerSha256: string;
}

export type FormApi = ReturnType<typeof useForm<FormValues>>;

/** Chrome and Edge can only be Vendor mode (plan 4.4.2): the form shows and saves that whatever was picked. */
export function effectiveMode(x: FormValues): UpdateMode {
  return u.browserAppOf(x.exe) !== null ? "vendor" : x.updateMode;
}

export function initialValues(d: AppDetail, kind: AppKind): FormValues {
  const desk = d.desktop;
  const install = desk?.install;
  const up = desk?.update;
  const source = desk?.source ?? "winget";
  return {
    name: d.name,
    description: d.description ?? "",
    hue: d.hue,
    url: d.web?.url ?? "",
    domains: (d.web?.allowedDomains ?? []).filter((x) => {
      try {
        return x !== new URL(d.web?.url ?? "").hostname;
      } catch {
        return true;
      }
    }).join("\n"),
    source,
    wingetId: desk?.wingetId ?? "",
    wingetVersion: desk?.wingetVersion ?? "",
    resolved:
      source === "winget" && install && desk?.wingetId
        ? { packageId: desk.wingetId, version: desk.wingetVersion ?? "", install }
        : null,
    installUrl: install?.url ?? "",
    sha256: install?.sha256 ?? "",
    silentArgs: v.joinArgs(install?.silentArgs ?? []),
    productCode: install?.productCode ?? "",
    removeWhenUnassigned: install?.removeWhenUnassigned ?? true,
    exe: desk?.exe ?? (kind === "desktop" ? "{ProgramFiles}\\" : ""),
    args: v.joinArgs(desk?.args ?? []),
    fileArg: v.joinArgs(desk?.fileArgTemplate ?? (kind === "desktop" ? ["{file}"] : [])),
    resetFolders: (desk?.resetFolders ?? []).join("\n"),
    version: desk?.version ?? "",
    updateMode: up?.mode ?? "pinned",
    publisher: up?.publisher ?? "",
    publisherProduct: up?.publisherProduct ?? "",
    minVersion: up?.minVersion ?? "",
    feedUrl: up?.feed?.url ?? "",
    feedPubkey: up?.feed?.pubkey ?? "",
    feedTarget: up?.feed?.target ?? "windows-x86_64-nsis",
    autoPublish: up?.autoPublish ?? true,
    applyWhen: up?.applyWhen ?? "boot_or_signed_out",
    rollbackOnFail: up?.rollbackOnFail ?? true,
    browserKind: d.web?.browser?.kind ?? "builtin",
    chromeAppId: d.web?.browser?.kind === "chrome" ? (d.web.browser.appId ?? "") : "",
    sites: (desk?.browserSites ?? []).join("\n"),
    tech: install?.tech !== undefined ? ins.storedTech(install.tech) : "",
    successCodes: ins.formatExitCodes(install?.successExitCodes ?? [0]),
    timeoutMin: install?.timeoutMin !== undefined ? String(install.timeoutMin) : "",
    installPublisher: install?.publisher ?? "",
    answerOn: install?.answerFile !== undefined,
    answerUrl: install?.answerFile?.url ?? "",
    answerSha256: install?.answerFile?.sha256 ?? "",
  };
}

/** The installer details of an MSI or EXE program against the rules of plan 4.2 and 4.6 (the server decides; these are the inline messages). */
export function installerProblems(x: FormValues): Partial<Record<keyof FormValues & string, string>> {
  if (x.source !== "msi" && x.source !== "exe") return {};
  const out: Partial<Record<keyof FormValues & string, string>> = {};
  if (ins.timeoutProblem(x.timeoutMin)) out.timeoutMin = installFormStrings.timeoutBad;
  if (x.installPublisher.trim().length > ins.MAX_PUBLISHER) out.installPublisher = installFormStrings.publisherBad;
  if (x.source !== "exe") return out;
  if (ins.parseExitCodes(x.successCodes) === null) out.successCodes = installFormStrings.successCodesBad;
  const args = v.splitArgs(x.silentArgs);
  const usesToken = args.some((a) => a.includes("{AnswerFile}"));
  if (ins.silentArgTokenProblem(args)) out.silentArgs ??= installFormStrings.tokenBad;
  if (x.answerOn) {
    const url = ins.answerUrlProblem(x.answerUrl);
    if (url !== null) out.answerUrl = installFormStrings.answerUrlBad;
    const hash = v.sha256(x.answerSha256);
    if (hash !== null) out.answerSha256 = hash;
    if (!usesToken) out.silentArgs ??= installFormStrings.answerNeedsToken;
  } else if (usesToken) {
    out.silentArgs ??= installFormStrings.tokenNeedsAnswer;
  }
  return out;
}

/** The version fields of the form against the rules of plan 4.4 (the server decides; these are the inline messages). */
export function updateProblems(x: FormValues): Partial<Record<keyof FormValues & string, string>> {
  const mode = effectiveMode(x);
  const version = x.version.trim();
  const min = x.minVersion.trim();
  const hasInstaller = x.source !== "preinstalled";
  const out: Partial<Record<keyof FormValues & string, string>> = {};
  if (version !== "" && !u.isVersionText(version)) out.version = s.versionText;
  if (mode === "managed") {
    if (!hasInstaller) out.updateMode = s.needsInstaller;
    if (out.version === undefined) out.version = version === "" ? s.versionNeeded : u.isOrderedVersion(version) ? undefined : s.versionNotOrdered;
    if (x.feedUrl.trim() !== "") {
      if (v.installerUrl(x.feedUrl) !== null) out.feedUrl = s.feedUrlBad;
      if (!u.isFeedKey(x.feedPubkey)) out.feedPubkey = s.feedKeyBad;
      if (!u.isFeedTarget(x.feedTarget)) out.feedTarget = s.feedTargetBad;
    }
  }
  if (mode === "vendor") {
    const publisher = x.publisher.trim();
    if (publisher === "" && u.browserAppOf(x.exe) === null) out.publisher = s.needsPublisher;
    else if (publisher !== "" && x.publisherProduct.trim() === "" && u.publisherTooBroad(publisher)) out.publisher = s.publisherBroadWindows;
    if (min !== "") {
      if (!u.isOrderedVersion(min)) out.minVersion = s.versionNotOrdered;
      else if (!hasInstaller) out.minVersion = s.needsInstaller;
      else if (out.version === undefined && !u.isOrderedVersion(version)) out.version = version === "" ? s.versionNeeded : s.versionNotOrdered;
      else if (u.numbersAbove(min, version)) out.minVersion = s.minAboveVersion;
    }
  }
  return out;
}

/** `desktop.update` as the form saves it: Pinned is no block at all (the server stores none). */
export function updateSpec(x: FormValues): UpdateSpec | undefined {
  const mode = effectiveMode(x);
  if (mode === "pinned") return undefined;
  if (mode === "vendor") {
    return { mode, publisher: x.publisher.trim() || undefined, publisherProduct: x.publisherProduct.trim() || undefined, minVersion: x.minVersion.trim() || undefined };
  }
  return {
    mode,
    feed: x.feedUrl.trim() ? { kind: "tauri", url: x.feedUrl.trim(), pubkey: x.feedPubkey.replace(/\s+/g, ""), target: x.feedTarget.trim() } : undefined,
    autoPublish: x.autoPublish,
    applyWhen: x.applyWhen,
    rollbackOnFail: x.rollbackOnFail,
  };
}

export function validateValues(kind: AppKind, x: FormValues): Partial<Record<keyof FormValues & string, string>> {
  const common = {
    name: v.name(x.name, v.NAME_MAX.app) ?? undefined,
    description: v.optionalText(x.description, v.NAME_MAX.description) ?? undefined,
  };
  if (kind === "web") {
    return {
      ...common,
      url: v.webUrl(x.url) ?? undefined,
      domains: v.domains(v.lines(x.domains)) ?? undefined,
      chromeAppId: x.browserKind === "chrome" && x.chromeAppId === "" ? appBrowserStrings.chromeNeeded : undefined,
    };
  }
  const needsInstall = x.source === "msi" || x.source === "exe" || x.source === "portable";
  const problems: Partial<Record<keyof FormValues & string, string | undefined>> = {
    ...common,
    wingetId: x.source === "winget" ? (v.wingetId(x.wingetId) ?? (x.resolved ? undefined : s.resolveFirst)) : undefined,
    installUrl: needsInstall ? (v.installerUrl(x.installUrl) ?? undefined) : undefined,
    sha256: needsInstall ? (v.sha256(x.sha256) ?? undefined) : undefined,
    silentArgs: x.source === "exe" ? (v.silentArgs(v.splitArgs(x.silentArgs)) ?? undefined) : undefined,
    productCode: x.source === "msi" ? (v.productCode(x.productCode) ?? undefined) : undefined,
    exe: v.exePath(x.exe, x.source === "portable") ?? undefined,
    args: v.args(v.splitArgs(x.args)) ?? undefined,
    fileArg: v.fileArgTemplate(v.splitArgs(x.fileArg)) ?? undefined,
    resetFolders: v.resetFolders(v.lines(x.resetFolders)) ?? undefined,
    ...updateProblems(x),
    sites: u.browserAppOf(x.exe) !== null ? (browserSitesProblem(v.lines(x.sites).map((l) => l.toLowerCase()), appBrowserStrings.sitesTooMany) ?? undefined) : undefined,
  };
  // The installer details (Phase 6 Step 13) never replace a message a field already has.
  for (const [key, message] of Object.entries(installerProblems(x))) problems[key as keyof FormValues & string] ??= message;
  return problems;
}

/** `previous` is never sent: it is the server's field (`apps:update` ignores it). */
export function desktopSpec(x: FormValues, before?: DesktopSpec): DesktopSpec {
  const version = x.version.trim() || undefined;
  const update = updateSpec(x);
  // The allowed sites belong to Chrome and Edge only (the server refuses them for another program).
  const sites = u.browserAppOf(x.exe) !== null ? [...new Set(v.lines(x.sites).map((l) => l.toLowerCase()))] : [];
  const base = {
    source: x.source,
    exe: x.exe.trim(),
    args: v.splitArgs(x.args),
    fileArgTemplate: v.splitArgs(x.fileArg),
    resetFolders: v.lines(x.resetFolders),
    ...(version !== undefined ? { version } : {}),
    ...(update !== undefined ? { update } : {}),
    ...(sites.length > 0 ? { browserSites: sites } : {}),
  };
  // The form does not know an installer's size: the same installer keeps the one the server has.
  const sameInstaller = before?.install !== undefined && before.install.url === x.installUrl.trim() && before.install.sha256 === x.sha256.trim().toLowerCase();
  switch (x.source) {
    case "winget":
      return { ...base, wingetId: x.resolved?.packageId ?? x.wingetId.trim(), wingetVersion: x.resolved?.version, install: x.resolved?.install };
    case "preinstalled":
      return base;
    default: {
      // Phase 6 Step 13: the installer details of an MSI or EXE. A portable file runs no installer, so it has none.
      const runs = x.source === "msi" || x.source === "exe";
      const exe = x.source === "exe";
      const answerUrl = x.answerUrl.trim();
      const answerSha = x.answerSha256.trim().toLowerCase();
      const oldAnswer = before?.install?.answerFile;
      // The form does not know an answer file's size either: the same file keeps the one the server has.
      const answerSize = oldAnswer !== undefined && oldAnswer.url === answerUrl && oldAnswer.sha256 === answerSha ? oldAnswer.sizeBytes : 0;
      const publisher = x.installPublisher.trim();
      return {
        ...base,
        install: {
          kind: x.source,
          url: x.installUrl.trim(),
          sha256: x.sha256.trim().toLowerCase(),
          sizeBytes: sameInstaller ? before.install!.sizeBytes : 0,
          silentArgs: exe ? v.splitArgs(x.silentArgs) : [],
          productCode: x.source === "msi" && x.productCode.trim() ? x.productCode.trim().toUpperCase() : undefined,
          successExitCodes: (runs ? ins.parseExitCodes(x.successCodes) : null) ?? [0],
          removeWhenUnassigned: exe ? false : x.removeWhenUnassigned,
          ...(exe && x.tech !== "" ? { tech: x.tech } : {}),
          ...(exe && x.answerOn ? { answerFile: { url: answerUrl, sha256: answerSha, sizeBytes: answerSize } } : {}),
          ...(runs && x.timeoutMin.trim() !== "" ? { timeoutMin: Number(x.timeoutMin) } : {}),
          ...(runs && publisher !== "" ? { publisher } : {}),
        },
      };
    }
  }
}
/** The tile colour (one of `HUES`) closest to a hue angle (e.g. a site's theme colour). */
export function nearestHue(h: number): number {
  return HUES.reduce((best, x) => (Math.abs(x - h) < Math.abs(best - h) ? x : best), HUES[0]!);
}
