import { appSiteAccessStrings as s } from "../../../lib/screenStrings/appSiteAccess";

/** A sign-in service (or any group of sites) that is added and taken off with one button. */
export type SiteSuggestion = { label: string; entries: string[] };

/** The sign-in services most websites (and browsers) need. A popular app can bring its own on top. */
export const DEFAULT_SUGGESTIONS: readonly SiteSuggestion[] = [
  { label: s.suggestions.microsoft, entries: ["login.microsoftonline.com", "login.live.com"] },
  { label: s.suggestions.google, entries: ["accounts.google.com"] },
];

/** An entry as the lists compare it: lower-case, a leading `*.` read as the plain name (the picker only writes plain names). */
export const entryKey = (entry: string): string => {
  const t = entry.trim().toLowerCase();
  return t.startsWith("*.") ? t.slice(2) : t;
};
