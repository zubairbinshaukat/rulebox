/**
 * "Installs silently": what the Windows app screens tell a non-technical admin about HOW an installer runs, picked
 * automatically from the installer type (detection) or from winget data (add-app plan section 5). Pure: the screens give
 * what they know, this says which line to show, in which tone, with which (i) text, and whether Add must wait.
 *
 * It never changes anything and never invents switches: the automatic switches come from the caller (the detection or the
 * winget answer), and text the admin typed is theirs ("own switches"). A plain EXE nobody recognised has no silent mode:
 * Add stays blocked until switches exist (D9), because a wrong guess hangs a wizard on every PC.
 */
import type { DesktopSource, DetectedTech, InstallKind } from "../../data/types";
import { appAddStrings } from "../screenStrings/appAdd";

const t = appAddStrings.silent;

export type SilentState =
  /** Confident: an MSI, winget switches, or a recognised installer. */
  | "silent"
  /** Recognised with low confidence: works, but try it on one PC first. */
  | "guess"
  /** The admin typed their own switches. */
  | "own"
  /** A plain EXE and no switches: Add is blocked. */
  | "unknown"
  /** InstallShield InstallScript without its answer file: Add is blocked. */
  | "needs_answer"
  /** A portable file: nothing to install. */
  | "none"
  /** Already on the PCs: nothing to install. */
  | "preinstalled";

export type SilentTone = "success" | "warning" | "neutral";

export interface SilentInput {
  source: DesktopSource;
  /** The install kind (`msi`/`exe`/`portable`); for winget the kind of the resolved installer. Omit when not known yet. */
  kind?: InstallKind;
  /** The technology: detected, or stored with the app. `""`/absent = a plain EXE or an MSI. */
  tech?: DetectedTech | "";
  /** How sure the detection was. Absent (winget, a saved app) counts as high. */
  confidence?: "high" | "medium" | "low";
  /** The switches as the form holds them (joined text). */
  silentArgs: string;
  /** The automatic switches for this installer (joined text): the winget switches or the detection's. `""` when there are none. */
  autoArgs: string;
  /** The detection says the installer cannot run without a recorded answer file. */
  needsAnswerFile?: boolean;
  /** The form's answer-file switch is on and the answer link and SHA-256 are filled in. */
  answerReady?: boolean;
  /** The detection says the installer is probably per-user (NSIS without elevation). */
  perUserLikely?: boolean;
}

export interface SilentStatus {
  state: SilentState;
  tone: SilentTone;
  /** The line: "Installs silently". */
  label: string;
  /** The (i) text. */
  info: string;
  /** Add must wait: no switches (`unknown`) or no answer file (`needs_answer`). */
  blocksAdd: boolean;
  /** Show the "may install for one account only" warning next to the line. */
  perUser: boolean;
}

/** The switches an unknown installer's admin can try, in the order of how often they work (the buttons under the warning). */
export const COMMON_SWITCHES: readonly string[] = ["/S", "/silent", "/quiet", "/VERYSILENT"];

const norm = (text: string): string => text.trim().replace(/\s+/g, " ");

function infoFor(tech: DetectedTech | "" | undefined, fromWinget: boolean): string {
  if (fromWinget) return `${t.info.base} ${t.info.winget}`;
  switch (tech) {
    case "nsis":
      return `${t.info.base} ${t.info.nsis}`;
    case "inno":
      return `${t.info.base} ${t.info.inno}`;
    case "burn":
      return `${t.info.base} ${t.info.burn}`;
    case "installshield_msi":
      return `${t.info.base} ${t.info.installshield_msi}`;
    case "advanced_installer":
      return `${t.info.base} ${t.info.advanced_installer}`;
    case "installshield_script":
      return `${t.info.base} ${t.info.installshield_script}`;
    default:
      return t.info.base;
  }
}

/** The line to show for a Windows app's installer. See section 5 of the add-app plan: every row is a case in the tests. */
export function silentStatus(input: SilentInput): SilentStatus {
  const out = (state: SilentState, tone: SilentTone, label: string, info: string, extra: Partial<Pick<SilentStatus, "blocksAdd" | "perUser">> = {}): SilentStatus => ({
    state,
    tone,
    label,
    info,
    blocksAdd: extra.blocksAdd ?? false,
    perUser: extra.perUser ?? false,
  });

  if (input.source === "preinstalled") return out("preinstalled", "neutral", t.preinstalled, t.info.preinstalled);
  if (input.source === "portable" || input.kind === "portable") return out("none", "neutral", t.none, t.info.portable);

  const msi = input.source === "msi" || input.kind === "msi";
  // An MSI is installed by the agent with msiexec in quiet mode: there are no switches to show or to get wrong.
  if (msi) return out("silent", "success", t.silent, t.info.msi);

  const fromWinget = input.source === "winget";
  const tech = input.tech ?? "";
  const args = norm(input.silentArgs);
  const auto = norm(input.autoArgs);

  // InstallShield InstallScript cannot run silently without a recorded answer file (blocking until it is given).
  if (!fromWinget && (input.needsAnswerFile === true || tech === "installshield_script") && input.answerReady !== true) {
    return out("needs_answer", "warning", t.needsAnswer, t.info.installshield_script, { blocksAdd: true });
  }
  // Text the admin typed is theirs: the line says so, and the "Use automatic" button restores the computed switches.
  if (args !== "" && args !== auto) return out("own", "neutral", t.own, t.info.own);
  // A resolved winget installer always has switches (the server refuses one without); an empty field only means "not resolved yet".
  if (args === "" && fromWinget) return out("silent", "success", t.silent, infoFor(tech, true));
  if (args === "") return out("unknown", "warning", t.unknownTitle, t.info.unknown, { blocksAdd: true });

  if (input.confidence === "low") return out("guess", "warning", t.guess, t.info.guess);
  const perUser = tech === "nsis" && input.perUserLikely === true;
  return out("silent", "success", t.silent, infoFor(tech, fromWinget), { perUser });
}

/** True when the form holds switches that differ from the automatic ones (the "(edited)" mark and the "Use automatic" button). */
export function switchesEdited(silentArgs: string, autoArgs: string): boolean {
  return norm(silentArgs) !== "" && norm(silentArgs) !== norm(autoArgs);
}

/** Why a winget package can't be installed (the server's `winget_unsupported` detail, `convex/lib/winget.ts`), in the words of `appAddStrings.unsupported`. */
export type WingetRefusalKind = "msixOrUser" | "noSilent" | "other";

export function wingetRefusalKind(detail: string | undefined): WingetRefusalKind {
  const text = (detail ?? "").toLowerCase();
  if (text.includes("per-user") || text.includes("non-installer")) return "msixOrUser";
  if (text.includes("no silent install") || text.includes("silent install switches")) return "noSilent";
  return "other";
}
