/**
 * Public addresses the dashboard links to. Plain links (never fetched by the browser: the dashboard works offline-first and talks to
 * GitHub only through the server, see `ruleboxRelease:githubReleases`).
 */

/** The public Rulebox repository (also in the website's config and the server's `DEFAULT_RELEASES_REPO`). */
export const RULEBOX_REPO_URL = "https://github.com/zubairbinshaukat/rulebox";

/** The newest release page: where "Download Rulebox" goes while the organization has not chosen a build in Settings, Updates. */
export const RULEBOX_RELEASES_URL = `${RULEBOX_REPO_URL}/releases/latest`;

/**
 * The address "Download Rulebox" opens: the organization's own build when it set one, else the releases page. Only `https://` links are
 * ever returned (anything else falls back to the releases page).
 */
export function downloadUrl(download: { url: string } | null | undefined): string {
  return download !== null && download !== undefined && /^https:\/\/[^\s/]+/i.test(download.url) ? download.url : RULEBOX_RELEASES_URL;
}
