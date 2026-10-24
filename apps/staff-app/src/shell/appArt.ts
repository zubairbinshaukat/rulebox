import type { AppEntry } from "@rulebox/types";

/** The Solar glyphs an app tile can show (see `appIcon.tsx` for the icons). */
export type GlyphKey =
  | "folder"
  | "document"
  | "mail"
  | "calendar"
  | "video"
  | "music"
  | "bag"
  | "card"
  | "badge"
  | "chart"
  | "chat"
  | "people"
  | "delivery"
  | "phone"
  | "camera"
  | "calculator"
  | "ticket"
  | "learn"
  | "settings"
  | "globe"
  | "widget";

/** Each glyph's own colour (oklch hue), used when the app has no `hue`. */
export const GLYPH_HUES: Record<GlyphKey, number> = {
  folder: 62,
  document: 250,
  mail: 22,
  calendar: 258,
  video: 300,
  music: 352,
  bag: 152,
  card: 212,
  badge: 178,
  chart: 135,
  chat: 280,
  people: 200,
  delivery: 48,
  phone: 162,
  camera: 320,
  calculator: 230,
  ticket: 10,
  learn: 270,
  settings: 240,
  globe: 228,
  widget: 190,
};

/** Words in an app's name that pick a glyph, first match wins (so "Team chat" is a chat). */
const NAME_RULES: Array<[RegExp, GlyphKey]> = [
  [/\b(mail|inbox|e-?mail|outlook)\b/, "mail"],
  [/\b(chat|message|messages|teams|slack)\b/, "chat"],
  [/\b(meet|meeting|meetings|calendar|schedule|booking|bookings|rooms?)\b/, "calendar"],
  [/\b(video|videos|training|clips?|tv)\b/, "video"],
  [/\b(music|audio|radio|playlist|sound)\b/, "music"],
  [/\b(orders?|shop|store|pos|sales|cart|checkout)\b/, "bag"],
  [/\b(accounts?|bank|banking|finance|pay|payments?|billing|invoices?|ledger)\b/, "card"],
  [/\b(visitors?|badge|guests?|reception|check-?in|front desk)\b/, "badge"],
  [/\b(reports?|analytics|dashboard|stats|insights)\b/, "chart"],
  [/\b(deliver|deliveries|delivery|parcels?|shipping|logistics|stock|inventory|warehouse)\b/, "delivery"],
  [/\b(people|staff|hr|team|employees|directory|contacts)\b/, "people"],
  [/\b(phone|calls?|dialer)\b/, "phone"],
  [/\b(camera|photos?|scan|scanner)\b/, "camera"],
  [/\b(calc|calculator)\b/, "calculator"],
  [/\b(help|support|tickets?|helpdesk)\b/, "ticket"],
  [/\b(learn|learning|course|courses|academy|school)\b/, "learn"],
  [/\b(settings|admin|config)\b/, "settings"],
  [/\b(files?|folders?|drive)\b/, "folder"],
  [/\b(docs?|documents?|notes?|notepad|editor|word|writer)\b/, "document"],
];

const ICON_KEYS = new Set<string>(Object.keys(GLYPH_HUES));

/** Pure: which Solar glyph stands for `app`. */
export function glyphFor(app: Pick<AppEntry, "id" | "name" | "iconKey" | "kind">): GlyphKey {
  const key = (app.iconKey ?? "").toLowerCase();
  if (ICON_KEYS.has(key)) {
    return key as GlyphKey;
  }
  if (app.kind.type === "builtin" || app.id === "files") {
    return "folder";
  }
  const name = app.name.toLowerCase();
  for (const [rule, glyph] of NAME_RULES) {
    if (rule.test(name)) {
      return glyph;
    }
  }
  return app.kind.type === "web" ? "globe" : "widget";
}

/** Pure: the app's colour. Its own `hue` from the dashboard wins, then its glyph's. */
export function hueFor(app: Pick<AppEntry, "id" | "name" | "iconKey" | "kind" | "hue">): number {
  if (app.hue !== null && app.hue !== undefined) {
    return ((app.hue % 360) + 360) % 360;
  }
  return GLYPH_HUES[glyphFor(app)];
}
