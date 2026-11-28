/**
 * The fake GitHub releases of the demo (`VITE_DEMO=1`): what `ruleboxRelease:githubReleases` would answer for the Rulebox repository.
 * Hashes are made of one repeated digit; addresses have the real shape (`https://github.com/<repo>/releases/download/...`) but are
 * never opened by the demo. `?demoReleases=empty|unavailable|rate|stale` shows the other states (screenshots, tests).
 */
import type { GithubRelease, GithubReleasesResult } from "./api";

const REPO = "zubairbinshaukat/rulebox";
const DAY = 86_400_000;

export const DEMO_RELEASES_VARIANTS = ["empty", "unavailable", "rate", "stale"] as const;
export type DemoReleasesVariant = (typeof DEMO_RELEASES_VARIANTS)[number];

/** The `demoReleases` URL parameter of the page, or null (not set or not one of the variants). */
export function demoReleasesVariant(search: string = globalThis.location?.search ?? ""): DemoReleasesVariant | null {
  const v = new URLSearchParams(search).get("demoReleases");
  return (DEMO_RELEASES_VARIANTS as readonly string[]).includes(v ?? "") ? (v as DemoReleasesVariant) : null;
}

function release(version: string, tag: string, o: { title?: string; digit: string; mb: number; daysAgo: number; now: number; notes: string; prerelease?: boolean; unsigned?: boolean }): GithubRelease {
  const name = `Rulebox-${version}-x64${o.unsigned === true ? "-unsigned" : ""}.msi`;
  return {
    tag,
    title: o.title ?? `Rulebox ${tag.slice(1)}`,
    version,
    prerelease: o.prerelease === true,
    publishedAt: o.now - o.daysAgo * DAY,
    pageUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
    notes: o.notes,
    notesTruncated: false,
    signed: o.unsigned !== true,
    msi: { name, url: `https://github.com/${REPO}/releases/download/${tag}/${name}`, sizeBytes: Math.round(o.mb * 1_000_000), sha256: o.digit.repeat(64) },
    problem: null,
  };
}

/** Newest first: 0.3.0 (unsigned, notes with headings and bullets), 0.3.0-rc1 (pre-release), 0.2.1, and 0.2.0 which cannot be used. */
export function demoGithubReleaseList(now: number = Date.now()): GithubRelease[] {
  return [
    release("0.3.0", "v0.3.0", {
      digit: "3",
      mb: 38.4,
      daysAgo: 3,
      now,
      unsigned: true,
      notes: [
        "## What's new",
        "",
        "Faster sign-in on shared PCs and a calmer start-up screen.",
        "",
        "### Fixes",
        "- Printing works again for employees on shared PCs",
        "- Offline sign-in no longer asks for the password twice",
        "- The kiosk keeps its wallpaper after a restart",
        "",
        "### Known issues",
        "- The first start after an update can take a little longer",
        "",
        "Full changelog: [v0.2.1...v0.3.0](https://github.com/zubairbinshaukat/rulebox/compare/v0.2.1...v0.3.0)",
      ].join("\n"),
    }),
    release("0.3.0", "v0.3.0-rc1", {
      title: "Rulebox 0.3.0-rc1",
      digit: "4",
      mb: 38.1,
      daysAgo: 10,
      now,
      prerelease: true,
      notes: "A test build of 0.3.0.\n\n- Please try it on one PC first",
    }),
    release("0.2.1", "v0.2.1", { digit: "2", mb: 36.2, daysAgo: 25, now, notes: "## Fixes\n- Small fixes for the lock screen" }),
    {
      tag: "v0.2.0",
      title: "Rulebox 0.2.0",
      version: "0.2.0",
      prerelease: false,
      publishedAt: now - 33 * DAY,
      pageUrl: `https://github.com/${REPO}/releases/tag/v0.2.0`,
      notes: "First public build.",
      notesTruncated: false,
      signed: true,
      msi: null,
      problem: "no_checksums",
    },
  ];
}

/** The answer of the fake action: the list, or one of the other states named by `variant`. */
export function demoGithubReleasesResult(variant: DemoReleasesVariant | null, now: number = Date.now()): GithubReleasesResult {
  const repoUrl = `https://github.com/${REPO}`;
  switch (variant) {
    case "empty":
      return { status: "ok", repoUrl, checkedAt: now, stale: false, releases: [] };
    case "unavailable":
      return { status: "unavailable", reason: "unreachable" };
    case "rate":
      return { status: "unavailable", reason: "rate_limited", retryAt: now + 14 * 60_000 };
    case "stale":
      return { status: "ok", repoUrl, checkedAt: now - 12 * 60_000, stale: true, releases: demoGithubReleaseList(now) };
    default:
      return { status: "ok", repoUrl, checkedAt: now, stale: false, releases: demoGithubReleaseList(now) };
  }
}
