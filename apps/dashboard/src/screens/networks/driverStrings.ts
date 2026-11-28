/** The driver form's sentences (new and edit). Only the driver screen imports this file. */
import type { DriverClass, DriverKind } from "../../data/types";
import { formatNumber, plural } from "../../lib/format";
import type { ArgsProblem, CodesProblem, HashProblem, InfProblem, NameProblem, ProvidesProblem, SizeProblem, UrlProblem } from "../../lib/driverRules";
import {
  MAX_DRIVER_INF,
  MAX_DRIVER_NAME,
  MAX_DRIVER_URL,
  MAX_PROVIDED_NAME,
  MAX_PROVIDES,
  MAX_SILENT_ARG,
  MAX_SILENT_ARGS,
  MAX_SUCCESS_CODES,
} from "../../lib/driverRules";

export const driverStrings = {
  title: "Driver",
  newTitle: "New driver",
  loading: "Loading drivers",
  rulesInfo:
    "Only https links. Rulebox checks the file against its fingerprint before it runs, and Windows must trust the driver's signature. It installs in the background: nobody sees a window.",

  url: "Download link",
  urlInfo: "Rulebox doesn't host files. Paste the link where the maker offers the driver. It must start with https://.",
  urlPlaceholder: "https://…/driver.zip",
  urlProblems: {
    empty: "Paste the download link.",
    length: `A link is at most ${MAX_DRIVER_URL} characters.`,
    scheme: "The link must start with https://.",
    characters: "Remove spaces and special characters from the link.",
  } satisfies Record<UrlProblem, string>,

  // ---- check the file
  checkTitle: "Check the file",
  checkFile: "Pick the same file on this computer",
  checkingFile: "Checking the file…",
  checkFileInfo: "Rulebox reads the file here to fingerprint it and see what is inside. Nothing is uploaded. Pick the exact file the link downloads.",
  detect: "Detect from the link",
  detecting: "Looking at the link…",
  detectInfo: "Rulebox reads the start of the file at the link to find out how to install it silently.",
  chooseFile: "Choose the driver file on this computer",
  checkNeeded: "Check the file so Rulebox can fingerprint it, or paste its fingerprint under Advanced.",
  zipUnreadable: "Couldn't read this zip. Fill in the details under Advanced.",
  fileFailed: "Rulebox couldn't read that file. Fill in the details under Advanced.",
  notInstaller: "That file is not a Windows program or an MSI package.",
  noInf: "No .inf file in this zip.",
  moreInfs: "There are more driver files in this zip than the list shows.",
  summary: (kind: string, models: number, size: string, fingerprint: "checked" | "saved" | null) =>
    [
      kind,
      models > 0 ? `${formatNumber(models)} ${plural(models, { one: "printer model", other: "printer models" })}` : "",
      size,
      fingerprint === "checked" ? "fingerprint checked" : fingerprint === "saved" ? "fingerprint saved" : "",
    ]
      .filter((x) => x !== "")
      .join(" · "),  kindShort: { inf: "Driver package", exe: "Installer (.exe)", msi: "Installer (.msi)" } satisfies Record<DriverKind, string>,
  fingerprintChecked: "Fingerprint checked",
  fingerprintSaved: "Fingerprint saved",

  name: "Name",
  nameInfo: "Only for you, to tell drivers apart. Employees never see it.",
  nameProblems: {
    empty: "Enter a name.",
    length: `Use at most ${MAX_DRIVER_NAME} characters.`,
    characters: "Remove line breaks and special control characters.",
  } satisfies Record<NameProblem, string>,
  nameTaken: "Another driver already has this name.",

  infPick: "Driver file",
  infPickInfo: "This zip holds more than one driver file. Pick the one for your printer.",
  adds: "This driver adds",
  addsInfo: "The printer names Windows shows once the driver is installed. Ticked names appear in the printer form.",
  addsModels: (n: number) => `${formatNumber(n)} ${plural(n, { one: "printer model", other: "printer models" })}`,

  // ---- Advanced
  deviceType: "Device type",
  deviceTypeInfo: "Only for your own overview. If you block this type under USB rules, Windows also refuses the driver (by design).",
  classNames: { printer: "Printer", scanner: "Scanner", other: "Other device" } satisfies Record<DriverClass, string>,
  fileType: "File type",
  fileTypeInfo: "Rulebox picks it from the link. A driver package is a zip with an .inf file inside, installed with Windows' own tool and removed again with the driver. A vendor installer is run silently and left in place.",
  kindNames: {
    inf: "Driver package (zip)",
    exe: "Vendor installer (.exe)",
    msi: "Vendor installer (.msi)",
  } satisfies Record<DriverKind, string>,
  sha: "SHA-256 fingerprint",
  shaInfo: "The 64 characters the maker publishes, or the one Rulebox worked out from the file. A different file is never installed.",
  shaProblems: {
    empty: "Paste the SHA-256 of the file.",
    format: "A SHA-256 is exactly 64 digits and letters from 0 to 9 and a to f.",
  } satisfies Record<HashProblem, string>,
  size: "File size in bytes",
  sizeInfo: "Helps the PC check it has enough free space. Leave empty if you don't know.",
  sizeProblems: {
    number: "Use a whole number of bytes, or leave it empty.",
    range: "The file can be at most 4 GiB (4294967296 bytes).",
  } satisfies Record<SizeProblem, string>,
  inf: "Driver file inside the zip",
  infInfo: "The path of the .inf file in the zip, for example Drivers\\brother.inf.",
  infProblems: {
    empty: "Enter the path of the .inf file inside the zip.",
    length: `The path is at most ${MAX_DRIVER_INF} characters.`,
    extension: "The path must end in .inf.",
    path: "Use a path inside the zip, like Drivers\\brother.inf: no leading slash, no .. and no colon.",
  } satisfies Record<InfProblem, string>,
  args: "Silent switches (one per line)",
  argsInfo: "What makes the installer run without a window, for example /S or /quiet. Check the file or the link and Rulebox fills this in.",
  argsProblems: {
    required: "A vendor .exe installer needs at least one silent switch.",
    count: `At most ${MAX_SILENT_ARGS} switches.`,
    length: `A switch is at most ${MAX_SILENT_ARG} characters.`,
    characters: "Remove special control characters from the switches.",
  } satisfies Record<ArgsProblem, string>,
  codes: "Success codes",
  codesInfo: "Comma separated, for example 0, 3010. 3010 and 1641 mean done, restart needed.",
  codesProblems: {
    number: "Use whole numbers separated by commas.",
    count: `At most ${MAX_SUCCESS_CODES} codes.`,
  } satisfies Record<CodesProblem, string>,
  provides: "Printer driver names it delivers",
  providesInfo: "The names Windows shows for the driver once it is installed, one per line. They then appear in the printer form.",
  providesProblems: {
    count: `At most ${MAX_PROVIDES} names.`,
    length: `A name is at most ${MAX_PROVIDED_NAME} characters.`,
    characters: "Remove special control characters from the names.",
  } satisfies Record<ProvidesProblem, string>,

  create: "Add driver",
  saved: "Driver saved.",
  created: (name: string) => `${name} added.`,
  deleted: (name: string) => `${name} removed.`,
  retried: "The PCs will try again.",

  // ---- the aside of a new driver
  howTitle: "How it works",
  how1: "Paste the link, then check the file here. Rulebox fills in the rest.",
  how2: "PCs download the file and compare its fingerprint before they install.",
  how3: "Installation runs in the background. Nobody sees a window.",

  // ---- counts, retry, delete
  countsTitle: "On the PCs",
  countsSub: "How the PCs of the assigned groups report this driver. Counted when you open this page.",
  countsNone: "No PC has reported this driver yet.",
  installed: "Installed",
  failed: "Failed",
  pending: "Waiting or installing",
  restart: "Restart needed",
  removed: "Removed",
  unsupported: "Not usable",
  retryTitle: "Try again",
  retryBody: "A PC that failed several times stops trying. This asks every PC to start over, for example after you fixed the link.",
  retry: "Ask the PCs to retry",
  remove: "Remove driver",
  deleteTitle: (name: string) => `Remove ${name}?`,
  deleteBody:
    "The driver is taken away from every group. A driver package (zip) that Rulebox installed is removed from the PCs again; a vendor installer is left in place. This can't be undone.",

  // ---- read only
  readName: "Name",
  readType: "Type",
  readDevice: "Device type",
  readUrl: "Download link",
  readSha: "SHA-256 fingerprint",
  readInf: "Driver file",
  readProvides: "Printer driver names it delivers",
};
