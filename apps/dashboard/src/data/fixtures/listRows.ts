/**
 * More demo rows so the server-driven tables (Phase 4b) have several pages at the default page size of 10:
 * apps, file-type rules, members, pending invites and enrollment codes. Added after `seed()` built the
 * hand-written story, so that story (and its ids) stays as it was. Deterministic: no randomness.
 */
import { DEFAULT_WEB_PERMISSIONS, type DesktopSpec } from "../types";
import type { DbApp, DbInvite, DbMember, DbToken, DemoDb } from "./seed";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const WEB_APPS: [name: string, host: string, hue: number, description?: string][] = [
  ["Calendar", "calendar.example.com", 220, "Shared team calendar"],
  ["Customer portal", "portal.example.com", 175],
  ["Inventory", "inventory.example.com", 40, "Counts and transfers"],
  ["Loyalty cards", "loyalty.example.com", 330],
  ["Order tracking", "orders.example.net", 100],
  ["Price checker", "prices.example.com", 60],
  ["Staff rota", "rota.example.org", 260, "Who works when"],
  ["Supplier portal", "suppliers.example.com", 20],
  ["Training videos", "training.example.org", 300, "Onboarding and refreshers"],
  ["Visitor log", "visitors.example.com", 200],
  ["Support desk", "support.example.net", 150, "Open and close tickets"],
  ["Shift swap", "swap.example.org", 0],
  ["Delivery map", "delivery.example.com", 130],
  ["Returns form", "returns.example.com", 80],
];

const DESKTOP_APPS: [name: string, exe: string, hue: number][] = [
  ["LibreOffice Writer", "{ProgramFiles}\\LibreOffice\\program\\swriter.exe", 210],
  ["Notepad++", "{ProgramFiles}\\Notepad++\\notepad++.exe", 120],
  ["IrfanView", "{ProgramFiles}\\IrfanView\\i_view64.exe", 350],
  ["SumatraPDF", "{ProgramFiles}\\SumatraPDF\\SumatraPDF.exe", 25],
  ["Foxit Reader", "{ProgramFilesX86}\\Foxit Software\\Foxit Reader\\FoxitReader.exe", 5],
  ["WinRAR", "{ProgramFiles}\\WinRAR\\WinRAR.exe", 45],
];

function desktop(exe: string): DesktopSpec {
  return { source: "preinstalled", exe, args: [], fileArgTemplate: ["{file}"], resetFolders: [] };
}

const MEMBER_NAMES = [
  "priya.nair", "tomas.keller", "lena.moreau", "omar.haddad", "grace.liu", "kofi.mensah", "ines.duarte", "yuki.sato", "ahmed.farouk", "nora.lindqvist",
];

export function padListFixtures(db: DemoDb, now: number): void {
  const id = (prefix: string) => `${prefix}_${(db.nextId++).toString(36).padStart(4, "0")}`;
  const owner = db.members.find((m) => m.role === "owner")!;

  // ---- apps: 14 websites, 6 programs that open files, 3 archived
  WEB_APPS.forEach(([name, host, hue, description], i) => {
    db.apps.push({
      _id: id("app"),
      name,
      description,
      kind: "web",
      hue,
      web: { url: `https://${host}`, allowedDomains: [host], permissions: { ...DEFAULT_WEB_PERMISSIONS } },
      archived: false,
      revision: 1,
      createdAt: now - (30 - i) * DAY - i * HOUR,
    });
  });
  const programs: DbApp[] = DESKTOP_APPS.map(([name, exe, hue], i) => ({
    _id: id("app"),
    name,
    kind: "desktop",
    hue,
    desktop: desktop(exe),
    archived: false,
    revision: 1,
    createdAt: now - (16 - i) * DAY - i * HOUR,
  }));
  db.apps.push(...programs);
  const archivedAt = now - 200 * DAY;
  db.apps.push(
    { _id: id("app"), name: "Old intranet", kind: "web", hue: 90, web: { url: "https://intranet.example.com", allowedDomains: ["intranet.example.com"], permissions: { ...DEFAULT_WEB_PERMISSIONS } }, archived: true, revision: 1, createdAt: archivedAt },
    { _id: id("app"), name: "Legacy POS client", kind: "desktop", hue: 240, desktop: desktop("{ProgramFiles}\\Legacy POS\\pos.exe"), archived: true, revision: 1, createdAt: archivedAt - DAY },
    { _id: id("app"), name: "Label tool 2019", kind: "desktop", hue: 280, desktop: desktop("{ProgramFiles}\\Label Tool\\labels.exe"), archived: true, revision: 1, createdAt: archivedAt - 2 * DAY },
  );

  // ---- file-type rules: the six programs above each open two or three kinds of file (12 more rules)
  const exts: [number, string][] = [
    [0, ".docx"], [0, ".odt"], [0, ".rtf"], [1, ".log"], [1, ".csv"], [2, ".png"], [2, ".jpg"], [3, ".epub"], [3, ".xps"], [4, ".fdf"], [5, ".rar"], [5, ".tar"],
  ];
  for (const [p, extension] of exts) db.fileHandlers.push({ _id: id("fh"), extension, appId: programs[p]!._id });

  // ---- members: 10 more (two disabled), joined over the last months
  MEMBER_NAMES.forEach((local, i) => {
    const role: DbMember["role"] = i % 5 === 0 ? "admin" : "viewer";
    db.members.push({
      _id: id("mem"),
      email: `${local}@demo.rulebox.test`,
      role,
      status: i === 3 || i === 8 ? "disabled" : "active",
      createdAt: now - (80 - i * 6) * DAY,
      revision: 0,
      password: owner.password,
    });
  });

  // ---- pending invites: 9 more (join invites and password-reset codes)
  const invited = ["intern.one", "intern.two", "regional.lead", "night.manager", "contractor.a", "contractor.b", "payroll", "it.helpdesk", "store.opening"];
  invited.forEach((local, i) => {
    const invite: DbInvite = {
      _id: id("inv"),
      email: `${local}@demo.rulebox.test`,
      role: i % 3 === 0 ? "admin" : "viewer",
      kind: i % 4 === 3 ? "passwordReset" : "join",
      code: `JOIN-DEMO-${i + 10}`,
      expiresAt: now + (i + 1) * DAY - 3 * HOUR,
      createdAt: now - (i + 1) * 5 * HOUR,
    };
    db.invites.push(invite);
  });
  // One that is already used and one that has expired: the table never shows them.
  db.invites.push(
    { _id: id("inv"), email: "joined.already@demo.rulebox.test", role: "viewer", kind: "join", code: "USED", expiresAt: now + DAY, usedAt: now - HOUR, createdAt: now - 2 * DAY },
    { _id: id("inv"), email: "too.late@demo.rulebox.test", role: "viewer", kind: "join", code: "OLD", expiresAt: now - DAY, createdAt: now - 9 * DAY },
  );

  // ---- enrollment codes: 14 more (active, used up, expired, revoked)
  const groups = db.groups;
  const labels = ["Branch 5 rollout", "Spare laptops", "Warehouse tablets", undefined, "Pop-up store", "Loaner PCs", "Returns desk", undefined, "Seasonal staff", "Kitchen screens", "Reception", "Showroom", "Trial run", undefined];
  labels.forEach((label, i) => {
    const total = [1, 3, 5, 10, 20][i % 5]!;
    const state = i % 4; // 0 active, 1 used up, 2 expired, 3 revoked
    const token: DbToken = {
      _id: id("tok"),
      label,
      groupId: groups[i % groups.length]!._id,
      usesLeft: state === 1 ? 0 : Math.max(1, total - (i % 3)),
      usesTotal: total,
      expiresAt: state === 2 ? now - (i + 1) * 3 * HOUR : now + (i + 1) * 6 * HOUR,
      revoked: state === 3,
      createdAt: now - (i + 2) * 7 * HOUR,
      createdBy: i % 3 === 0 ? owner._id : db.members[1]!._id,
    };
    db.tokens.push(token);
  });
}
