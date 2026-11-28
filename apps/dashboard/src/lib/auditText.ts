/**
 * Plain words for the audit log (other-pages plan 6.1, decision 26).
 *
 * The server writes most summaries as sentences, but four actions list internal field names
 * ("Changed organization settings: offlineDays, power"). Both old and new rows are reworded here, in the
 * browser, so nothing in the database changes. Every other action is shown as written.
 */
import type { AuditActorType, AuditEntry } from "../data/types";

/** The sub-label under who did it: a team member, a PC or Rulebox itself. */
const ACTOR_KINDS: Record<AuditActorType, string> = {
  member: "Team member",
  device: "PC",
  system: "Rulebox",
};

export function actorKind(type: AuditActorType): string {
  return ACTOR_KINDS[type];
}

/** Field names the server writes in these summaries, in words. */
const FIELD_WORDS: Record<string, string> = {
  offlineDays: "offline sign-in days",
  defaultQuotaGb: "default storage",
  power: "power options",
  adminExit: "administrator exit",
  name: "name",
  quota: "storage",
  username: "sign-in name",
};

/** The permissions of a web app, in words (`geolocation` is the server's key, `location` the plan's). */
const PERMISSION_WORDS: Record<string, string> = {
  camera: "camera",
  microphone: "microphone",
  screenShare: "screen sharing",
  clipboardRead: "clipboard",
  notifications: "notifications",
  downloads: "downloads",
  printing: "printing",
  geolocation: "location",
  location: "location",
};

/** "screenShare" -> "screen share": an unknown camelCase name still reads as words. */
function splitCamel(word: string): string {
  return word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

const CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;

/** One field name: the known word, else camelCase split into words, else as written. */
function fieldWord(token: string, known: Record<string, string> = FIELD_WORDS): string {
  const hit = known[token];
  if (hit !== undefined) return hit;
  return CAMEL.test(token) ? splitCamel(token) : token;
}

/** `a, b, c` where every item is one bare word (no spaces): the list the server joins field names with. */
const WORD_LIST = /^[A-Za-z][A-Za-z0-9]*(?:, [A-Za-z][A-Za-z0-9]*)*$/;

function mapList(list: string, known?: Record<string, string>): string {
  return list
    .split(", ")
    .map((t) => fieldWord(t, known))
    .join(", ");
}

/** "Changed organization settings: offlineDays, power" */
function orgSettings(summary: string): string {
  const prefix = "Changed organization settings: ";
  if (!summary.startsWith(prefix)) return summary;
  const list = summary.slice(prefix.length);
  return WORD_LIST.test(list) ? prefix + mapList(list) : summary;
}

/** "Changed the name, username of Maria" (the name of the employee never contains the list). */
function employeeUpdated(summary: string): string {
  const m = /^Changed the (.+?) of (.+)$/s.exec(summary);
  if (!m || !WORD_LIST.test(m[1]!)) return summary;
  return `Changed the ${mapList(m[1]!)} of ${m[2]!}`;
}

/** "Changed permissions of PDF Reader: camera allowed, screenShare blocked" */
function appPermissions(summary: string): string {
  const m = /^(.*): ((?:[A-Za-z][A-Za-z0-9]* (?:allowed|blocked))(?:, [A-Za-z][A-Za-z0-9]* (?:allowed|blocked))*)$/s.exec(summary);
  if (!m) return summary;
  const items = m[2]!.split(", ").map((item) => {
    const space = item.indexOf(" ");
    return `${fieldWord(item.slice(0, space), PERMISSION_WORDS)}${item.slice(space)}`;
  });
  return `${m[1]!}: ${items.join(", ")}`;
}

/** "Changed the display settings of the group X: display mode lite, at most 3 web windows": only a bare camelCase item is split. */
function groupDisplay(summary: string): string {
  const at = summary.lastIndexOf(": ");
  if (at < 0) return summary;
  const items = summary
    .slice(at + 2)
    .split(", ")
    .map((item) => (CAMEL.test(item) ? splitCamel(item) : item));
  return `${summary.slice(0, at + 2)}${items.join(", ")}`;
}

const REWRITE: Record<string, (summary: string) => string> = {
  "org.settingsChanged": orgSettings,
  "employee.updated": employeeUpdated,
  "app.permissionsChanged": appPermissions,
  "group.displayModeChanged": groupDisplay,
};

/**
 * The details of an audit row in plain words. Only the four actions that list field names are reworded;
 * any other action (and any summary of those four in a shape this does not know) comes back as written.
 */
export function plainSummary(entry: Pick<AuditEntry, "action" | "summary">): string {
  const rewrite = REWRITE[entry.action];
  return rewrite ? rewrite(entry.summary) : entry.summary;
}
