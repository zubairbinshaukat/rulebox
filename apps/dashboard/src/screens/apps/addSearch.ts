/**
 * The smart search of "Add an app" (add-app plan section 3.1): what the text means besides a name in the popular list. Pure.
 *
 * - A website address (`shop.example.com`, `https://shop.example.com/start`) offers "Add the website".
 * - A winget id (`VideoLAN.VLC`) or a pasted winget.run / winstall.app / winget-pkgs link offers "Look up in the catalogue".
 * Both can apply to one text (`VideoLAN.VLC` is also host-shaped): the person picks.
 *
 * Nothing here is sent anywhere. A winget id goes into a query string only through `encodeURIComponent` (`Notepad++.Notepad++`: a bare
 * `+` would read as a space).
 */
import * as v from "../../lib/validate";

export interface SiteMatch {
  host: string;
  url: string;
}

const VERSION_LIKE = /^\d/;

/** The winget id inside pasted text, or `null`. Accepts the id itself and links of winget.run, winstall.app and winget-pkgs. */
export function wingetIdOf(text: string): string | null {
  const t = text.trim();
  if (t === "" || /\s/.test(t)) return null;
  if (!/^https?:\/\//i.test(t)) {
    // winget.run/pkg/VideoLAN/VLC and winstall.app/apps/VideoLAN.VLC pasted without a scheme.
    if (/^(www\.)?(winget\.run|winstall\.app)\//i.test(t)) return wingetIdOf(`https://${t}`);
    return v.wingetId(t) === null && t.includes(".") ? t : null;
  }
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let id: string | null = null;
  if (host === "winstall.app" && parts[0] === "apps" && parts[1] !== undefined) id = parts[1];
  else if (host === "winget.run" && parts[0] === "pkg" && parts.length >= 3) id = parts.slice(1).join(".");
  else if (host === "github.com" && parts.includes("manifests")) {
    // .../manifests/v/VideoLAN/VLC/3.0.21: after the letter, the id parts up to the first version-like folder.
    const after = parts.slice(parts.indexOf("manifests") + 2);
    const idParts: string[] = [];
    for (const p of after) {
      if (VERSION_LIKE.test(p)) break;
      idParts.push(p);
    }
    if (idParts.length >= 2) id = idParts.join(".");
  }
  return id !== null && v.wingetId(id) === null ? id : null;
}

/** The website the text could be (`https://` added when missing), or `null`. A winget link is not a website to add. */
export function siteOf(text: string): SiteMatch | null {
  const t = text.trim();
  if (t === "" || /\s/.test(t)) return null;
  if (/^(www\.)?(winget\.run|winstall\.app)(\/|$)/i.test(t)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  if (v.webUrl(withScheme) !== null) return null;
  try {
    const host = new URL(withScheme).hostname;
    if (!host.includes(".")) return null;
    if (/^(winget\.run|winstall\.app)$/i.test(host.replace(/^www\./, ""))) return null;
    if (host === "github.com" && withScheme.includes("/winget-pkgs/")) return null;
    return { host: host.replace(/^www\./, ""), url: withScheme };
  } catch {
    return null;
  }
}

/** The address of the review page for a popular app (`?gallery=<key>`). */
export const galleryTarget = (kind: "desktop" | "web", key: string): string => `/apps/new?${new URLSearchParams({ kind, gallery: key }).toString()}`;
/** The address of the review page for a winget id. `URLSearchParams` encodes `+`. */
export const wingetTarget = (id: string): string => `/apps/new?${new URLSearchParams({ kind: "desktop", winget: id }).toString()}`;
/** The address of the website form for an address typed or pasted into the search. */
export const siteTarget = (url: string): string => `/apps/new?${new URLSearchParams({ kind: "web", url }).toString()}`;
