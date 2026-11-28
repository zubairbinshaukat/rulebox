/**
 * The popular-apps gallery of "Add an app" (UI pass, `docs/plans/ui-pass/add-app.md` section 7, decisions D2, D3, D30).
 * Static, typed, reviewed in code: it ships only in the lazy start/review chunks, never in the entry bundle, and it is data
 * the dashboard owns (no database rows, nothing to read).
 *
 * - Icons: a letter tile for every entry (D2). The vendors' logos are trademarks and none was confirmed to allow bundling,
 *   so `logo` is empty for all of them and `logos/` stays empty until the owner checks a vendor's brand terms (then:
 *   add an SVG of at most 4 KB, set `logo`, add a line to `THIRD_PARTY_NOTICES.md`).
 * - `verified: false` everywhere (D30): the winget IDs were checked against the public winget-pkgs repository, but the
 *   program path (`exe`) and the web entries' domains are typical locations that the owner confirms on the test VM
 *   (add-app plan step 18), then flips `verified`. A wrong path shows up on the PC as "exe_missing_after_install" and is
 *   fixed in the app's Details; it never runs anything else.
 * - Left out on purpose: remote-control tools (they bypass the kiosk), Store/MSIX-only apps, Microsoft 365 desktop
 *   (Click-to-Run), Webex (path unknown).
 *   Paint.NET: `dotPDN.PaintDotNet` exists, but Rulebox's resolver refuses its newest release (checked 2026-11-28:
 *   no machine-wide MSI or EXE). Add it back when that is fixed or the resolver learns the package.
 * - Notepad++ (`Notepad++.Notepad++`) is back since the package-id rule accepts a "+" (`v.wingetId`, `wingetIdProblem`).
 *
 * `confidence` records how sure we are of the entry, for the reviewer: `id` = the winget id exists in winget-pkgs AND the
 * server's `resolveWinget` accepted it with the real manifest (2026-11-28), `path` = how typical the program path is
 * (`typical` also when winget's own install-location hint agrees).
 */
import type { WebPermissions } from "../../../data/types";

export type GalleryCategory = "browsers" | "meetings" | "office" | "media" | "tools";

/** The order of the category chips (after "All"). */
export const GALLERY_CATEGORIES: readonly GalleryCategory[] = ["browsers", "meetings", "office", "media", "tools"];

export interface GalleryApp {
  /** URL-safe, `?gallery=<key>`. */
  key: string;
  /** Saved as the app's name. */
  name: string;
  /** Three to six words under the name. */
  blurb: string;
  category: GalleryCategory;
  /** The letter tile's colour: one of the tile hues (`HUES` in `appForm.ts`). */
  hue: number;
  /** A bundled file in `logos/` (none in v1: every entry shows a letter tile). */
  logo?: string;
  kind: "desktop" | "web";
  /** desktop + winget: the package id (case-sensitive). */
  wingetId?: string;
  /** desktop: where the program comes from. */
  source?: "winget" | "preinstalled";
  /** desktop: the program to start, as a path template (`v.exePath` must pass). */
  exe?: string;
  /** Firefox: it can open any website; Rulebox limits websites only in Chrome and Edge. */
  warning?: "unrestricted_browser";
  /** Chrome/Edge: starter browser rules (none in v1: the admin adds them). */
  sites?: string[];
  /** web: the start page, the other sites it needs, and the permissions to switch on after it is added. */
  url?: string;
  allowedDomains?: string[];
  permissions?: Partial<WebPermissions>;
  /** The program path (desktop) or domains (web) are confirmed on the test VM. */
  verified: boolean;
  /** For the reviewer only, see the file header. */
  confidence: { id: "checked" | "none"; path: "typical" | "uncertain" | "none" };
}

const PF = "{ProgramFiles}\\";
const PF86 = "{ProgramFilesX86}\\";

export const GALLERY: readonly GalleryApp[] = [
  // ---- browsers
  {
    key: "chrome",
    name: "Google Chrome",
    blurb: "Web browser",
    category: "browsers",
    hue: 20,
    kind: "desktop",
    source: "winget",
    wingetId: "Google.Chrome",
    exe: `${PF}Google\\Chrome\\Application\\chrome.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  {
    key: "edge",
    name: "Microsoft Edge",
    blurb: "Web browser, already on Windows",
    category: "browsers",
    hue: 200,
    kind: "desktop",
    // Edge ships with Windows (D7): the program is already on the PCs, so nothing is installed.
    source: "preinstalled",
    exe: `${PF86}Microsoft\\Edge\\Application\\msedge.exe`,
    verified: false,
    confidence: { id: "none", path: "typical" },
  },
  {
    key: "firefox",
    name: "Firefox",
    blurb: "Web browser",
    category: "browsers",
    hue: 40,
    kind: "desktop",
    source: "winget",
    wingetId: "Mozilla.Firefox",
    exe: `${PF}Mozilla Firefox\\firefox.exe`,
    warning: "unrestricted_browser",
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  // ---- meetings and chat
  {
    key: "zoom",
    name: "Zoom Workplace",
    blurb: "Video meetings and chat",
    category: "meetings",
    hue: 220,
    kind: "desktop",
    source: "winget",
    // The MSI package. `Zoom.Zoom.EXE` installs per user only, so it is not used.
    wingetId: "Zoom.Zoom",
    exe: `${PF}Zoom\\bin\\Zoom.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  {
    key: "teams",
    name: "Microsoft Teams",
    blurb: "Meetings and chat, in a window",
    category: "meetings",
    hue: 260,
    kind: "web",
    // winget's Microsoft.Teams is a Store-style (MSIX) package that Rulebox cannot install (D5): a website instead.
    url: "https://teams.microsoft.com/",
    allowedDomains: ["login.microsoftonline.com", "login.live.com"],
    permissions: { camera: true, microphone: true, screenShare: true, notifications: true },
    verified: false,
    confidence: { id: "none", path: "uncertain" },
  },
  {
    key: "slack",
    name: "Slack",
    blurb: "Team chat, in a window",
    category: "meetings",
    hue: 330,
    kind: "web",
    // winget's SlackTechnologies.Slack only installs for one user account (D5): a website instead.
    url: "https://app.slack.com/",
    allowedDomains: ["slack.com"],
    verified: false,
    confidence: { id: "none", path: "uncertain" },
  },
  {
    key: "outlook",
    name: "Outlook (web)",
    blurb: "Email and calendar, in a window",
    category: "meetings",
    hue: 220,
    kind: "web",
    url: "https://outlook.office.com/",
    allowedDomains: ["login.microsoftonline.com", "login.live.com"],
    permissions: { notifications: true },
    verified: false,
    confidence: { id: "none", path: "uncertain" },
  },
  // ---- office and PDF
  {
    key: "libreoffice",
    name: "LibreOffice",
    blurb: "Documents, sheets, slides",
    category: "office",
    hue: 150,
    kind: "desktop",
    source: "winget",
    wingetId: "TheDocumentFoundation.LibreOffice",
    exe: `${PF}LibreOffice\\program\\soffice.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  {
    key: "onlyoffice",
    name: "ONLYOFFICE",
    blurb: "Documents, sheets, slides",
    category: "office",
    hue: 20,
    kind: "desktop",
    source: "winget",
    wingetId: "ONLYOFFICE.DesktopEditors",
    exe: `${PF}ONLYOFFICE\\DesktopEditors\\DesktopEditors.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  {
    key: "reader",
    name: "Adobe Acrobat Reader",
    blurb: "Read and print PDF files",
    category: "office",
    hue: 0,
    kind: "desktop",
    source: "winget",
    wingetId: "Adobe.Acrobat.Reader.64-bit",
    // Unsure: the 64-bit Reader's folder name has changed between releases.
    exe: `${PF}Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe`,
    verified: false,
    confidence: { id: "checked", path: "uncertain" },
  },
  {
    key: "sumatra",
    name: "SumatraPDF",
    blurb: "Light PDF reader",
    category: "office",
    hue: 60,
    kind: "desktop",
    source: "winget",
    wingetId: "SumatraPDF.SumatraPDF",
    // Unsure: its installer may install for the current user only unless asked for all users.
    exe: `${PF}SumatraPDF\\SumatraPDF.exe`,
    verified: false,
    confidence: { id: "checked", path: "uncertain" },
  },
  {
    key: "foxit",
    name: "Foxit PDF Reader",
    blurb: "Read and fill in PDF files",
    category: "office",
    hue: 0,
    kind: "desktop",
    source: "winget",
    wingetId: "Foxit.FoxitReader",
    // Unsure: older releases are 32-bit and install under Program Files (x86).
    exe: `${PF}Foxit Software\\Foxit PDF Reader\\FoxitPDFReader.exe`,
    verified: false,
    confidence: { id: "checked", path: "uncertain" },
  },
  {
    key: "thunderbird",
    name: "Thunderbird",
    blurb: "Email program",
    category: "office",
    hue: 260,
    kind: "desktop",
    source: "winget",
    wingetId: "Mozilla.Thunderbird",
    exe: `${PF}Mozilla Thunderbird\\thunderbird.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  // ---- photos, video and sound
  {
    key: "vlc",
    name: "VLC media player",
    blurb: "Plays almost any video or music",
    category: "media",
    hue: 40,
    kind: "desktop",
    source: "winget",
    wingetId: "VideoLAN.VLC",
    exe: `${PF}VideoLAN\\VLC\\vlc.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  {
    key: "irfanview",
    name: "IrfanView",
    blurb: "Fast picture viewer",
    category: "media",
    hue: 175,
    kind: "desktop",
    source: "winget",
    wingetId: "IrfanSkiljan.IrfanView",
    exe: `${PF}IrfanView\\i_view64.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  {
    key: "gimp",
    name: "GIMP",
    blurb: "Advanced picture editor",
    category: "media",
    hue: 60,
    kind: "desktop",
    source: "winget",
    // `GIMP.GIMP` exists too; `GIMP.GIMP.3` is the 3.x line.
    wingetId: "GIMP.GIMP.3",
    // Least sure of all: the file name inside bin\ depends on the release (gimp-3.exe or gimp-3.0.exe).
    exe: `${PF}GIMP 3\\bin\\gimp-3.exe`,
    verified: false,
    confidence: { id: "checked", path: "uncertain" },
  },
  {
    key: "audacity",
    name: "Audacity",
    blurb: "Record and edit sound",
    category: "media",
    hue: 220,
    kind: "desktop",
    source: "winget",
    wingetId: "Audacity.Audacity",
    exe: `${PF}Audacity 4\\Audacity.exe`,
    verified: false,
    confidence: { id: "checked", path: "uncertain" },
  },
  {
    key: "inkscape",
    name: "Inkscape",
    blurb: "Drawing and logos",
    category: "media",
    hue: 300,
    kind: "desktop",
    source: "winget",
    wingetId: "Inkscape.Inkscape",
    exe: `${PF}Inkscape\\bin\\inkscape.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  // ---- tools
  {
    key: "7zip",
    name: "7-Zip",
    blurb: "Open and make zip files",
    category: "tools",
    hue: 175,
    kind: "desktop",
    source: "winget",
    wingetId: "7zip.7zip",
    exe: `${PF}7-Zip\\7zFM.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
  {
    key: "notepadpp",
    name: "Notepad++",
    blurb: "Text and code editor",
    category: "tools",
    hue: 150,
    kind: "desktop",
    source: "winget",
    wingetId: "Notepad++.Notepad++",
    // Unsure: the id exists in winget-pkgs (8.8.9, nullsoft, machine scope) but the server's `resolveWinget` was not run on it,
    // and the manifest's DefaultInstallLocation says `%ProgramFiles(x86)%\Notepad++` even for the x64 build (the 64-bit
    // installer normally uses Program Files). The VM check settles which.
    exe: `${PF}Notepad++\\notepad++.exe`,
    verified: false,
    confidence: { id: "none", path: "uncertain" },
  },
  {
    key: "keepassxc",
    name: "KeePassXC",
    blurb: "Password manager",
    category: "tools",
    hue: 150,
    kind: "desktop",
    source: "winget",
    wingetId: "KeePassXCTeam.KeePassXC",
    exe: `${PF}KeePassXC\\KeePassXC.exe`,
    verified: false,
    confidence: { id: "checked", path: "typical" },
  },
];

/** The entry for `?gallery=<key>`, or `undefined` for an unknown key. */
export function galleryApp(key: string | null | undefined): GalleryApp | undefined {
  return key ? GALLERY.find((app) => app.key === key) : undefined;
}

/** The entries of a category (all of them for `"all"`), in list order. */
export function galleryIn(category: GalleryCategory | "all"): GalleryApp[] {
  return category === "all" ? [...GALLERY] : GALLERY.filter((app) => app.category === category);
}

/** A case-insensitive search of the names, blurbs and keys; a blank text matches everything. */
export function searchGallery(text: string, category: GalleryCategory | "all" = "all"): GalleryApp[] {
  const q = text.trim().toLowerCase();
  return galleryIn(category).filter((app) => q === "" || app.name.toLowerCase().includes(q) || app.blurb.toLowerCase().includes(q) || app.key.includes(q));
}
