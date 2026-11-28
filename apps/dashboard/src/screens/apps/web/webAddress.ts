/**
 * Pure helpers of the website form (UI pass, add-app plan sections 3 and 6): the address as a person types it, how an address is
 * shown (Unicode names, the ASCII form in a `title`, D25) and the "www" default of a new website (D14). No React.
 */
import { levels, parseAddress, registrableDomain, withLevel } from "../../../lib/apps/siteAccess";
import { toUnicodeHost } from "../../../lib/apps/punycode";
import type { AppDetail } from "../../../data/types";

/** `shop.example.com/start` -> `https://shop.example.com/start`. Text that already has a scheme is left alone (the form then says "https only"). */
export function withHttps(text: string): string {
  const t = text.trim();
  if (t === "") return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

export interface ShownAddress {
  /** What is drawn: the host in Unicode, no `https://`, no lone `/`. An `http://` address keeps its scheme (it is the "not secure" example). */
  text: string;
  /** The same address with the ASCII (punycode) host, for a `title`; `undefined` when it is the same as `text`. */
  title: string | undefined;
}

/** An address for display (decoded Punycode), with the ASCII form kept for a `title` (D25). */
export function showAddress(address: string): ShownAddress {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { text: address, title: undefined };
  }
  const scheme = url.protocol === "https:" ? "" : `${url.protocol}//`;
  const host = url.hostname.replace(/\.$/, "");
  const rest = `${url.port === "" ? "" : `:${url.port}`}${url.pathname === "/" ? "" : url.pathname}`;
  const text = `${scheme}${toUnicodeHost(host)}${rest}`;
  const ascii = `${scheme}${host}${rest}`;
  return { text, title: ascii === text ? undefined : ascii };
}

/** A host for display, with its ASCII form for the `title` when they differ. */
export function showHost(host: string): { text: string; title: string | undefined } {
  const text = toUnicodeHost(host);
  return { text, title: text === host ? undefined : host };
}

/**
 * The entries of a NEW website whose address starts with `www.`: "All of <domain>" is preselected, because `example.com` often
 * redirects to `www.example.com` (and back) and would otherwise be blocked (D14). `null` when nothing should change: not a `www.` host,
 * no parent level, or the list already holds a level of this host (a popular app's entries, or the person's own choice).
 */
export function wwwDefault(address: string, entries: readonly string[]): string[] | null {
  const own = parseAddress(address);
  if (own === null || own.isIp || !own.host.startsWith("www.")) return null;
  const registrable = registrableDomain(own.host);
  if (registrable === null || registrable === own.host) return null;
  if (levels(own.host).some((level) => entries.some((e) => e.trim().toLowerCase().replace(/^\*\./, "") === level))) return null;
  return withLevel(own.host, entries, registrable);
}

/** The form's "no app yet": `initialValues(blankWebDetail(), "web")` is the start of a new website. */
export function blankWebDetail(): AppDetail {
  return {
    _id: "new",
    name: "",
    kind: "web",
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

