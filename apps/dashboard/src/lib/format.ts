/**
 * Number, date and size formatting. Every `Intl` object is created once and
 * cached (they are expensive to build). The browser locale and time zone are used.
 */

const cache = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  let v = cache.get(key) as T | undefined;
  if (v === undefined) {
    v = make();
    cache.set(key, v);
  }
  return v;
}

const numberFmt = () => cached("num", () => new Intl.NumberFormat(undefined));
const dateTimeFmt = () =>
  cached("dt", () => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }));
const dateTimeLongFmt = () =>
  cached(
    "dtl",
    () => new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }),
  );
const dateFmt = () => cached("d", () => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }));
const timeFmt = () => cached("t", () => new Intl.DateTimeFormat(undefined, { timeStyle: "short" }));
const relFmt = () => cached("rel", () => new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }));
const pluralRules = () => cached("pl", () => new Intl.PluralRules(undefined));

export function formatNumber(n: number): string {
  return numberFmt().format(n);
}

/** Server counts are capped at `cap + 1` rows: show "500+" instead of a wrong exact number. */
export function formatCount(n: number, cap?: number): string {
  if (cap !== undefined && n > cap) return `${formatNumber(cap)}+`;
  return formatNumber(n);
}

export function formatDateTime(ms: number): string {
  return dateTimeFmt().format(ms);
}

/** Full date and time with the time zone, for `title` attributes. */
export function formatDateTimeLong(ms: number): string {
  return dateTimeLongFmt().format(ms);
}

export function formatDate(ms: number): string {
  return dateFmt().format(ms);
}

export function formatTime(ms: number): string {
  return timeFmt().format(ms);
}

/** The browser's IANA time zone (shown next to absolute times). */
export function timeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600 * 1000],
  ["month", 30 * 24 * 3600 * 1000],
  ["week", 7 * 24 * 3600 * 1000],
  ["day", 24 * 3600 * 1000],
  ["hour", 3600 * 1000],
  ["minute", 60 * 1000],
];

/** "2 minutes ago", "in 3 days", "now" (under 45 seconds). */
export function formatRelative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 45 * 1000) return relFmt().format(0, "second");
  for (const [unit, size] of UNITS) {
    if (abs >= size || unit === "minute") {
      return relFmt().format(Math.round(diff / size), unit);
    }
  }
  return relFmt().format(0, "second");
}

/** "15 minutes", "2 hours", "3 days" — for durations without a direction. */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, ms);
  const pick = (unit: "day" | "hour" | "minute" | "second", size: number) => {
    const n = Math.max(1, Math.round(abs / size));
    return cached(`dur-${unit}`, () =>
      new Intl.NumberFormat(undefined, { style: "unit", unit, unitDisplay: "long" }),
    ).format(n);
  };
  if (abs >= 24 * 3600 * 1000) return pick("day", 24 * 3600 * 1000);
  if (abs >= 3600 * 1000) return pick("hour", 3600 * 1000);
  if (abs >= 60 * 1000) return pick("minute", 60 * 1000);
  return pick("second", 1000);
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v < 10 && i > 0 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatGb(gb: number): string {
  return `${formatNumber(gb)} GB`;
}

/** Zero / one / many with the browser's plural rules. */
export function plural(n: number, forms: { one: string; other: string; zero?: string }): string {
  if (n === 0 && forms.zero !== undefined) return forms.zero;
  const rule = pluralRules().select(n);
  return rule === "one" ? forms.one : forms.other;
}

/** Splits a string into groups (`ABCD EFGH …`) for secrets typed by hand. */
export function groupChars(s: string, size = 4): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.join(" ");
}

/** A short form of a long hex value: `a1b2c3d4…9f8e`. */
export function shortHex(s: string, head = 8, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
