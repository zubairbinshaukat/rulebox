// Reads the latest stable GitHub release (plan §11.2) and writes
// src/data/release.json for the download page. Run before the build in the
// release workflow:  pnpm --filter @rulebox/website fetch:release
//
// The release must carry the MSI and a SHA256SUMS file. If the API call
// fails, or the release has no checksum for the MSI, this script exits with
// an error: the site never ships an empty or stale checksum. With no release
// at all it writes { latest: null } and the page shows "first release coming".
//
// Env: GITHUB_REPOSITORY (owner/name, default from src/config.ts REPO_URL),
//      GITHUB_TOKEN (optional, for rate limits), RELEASE_SIGNED=true once SignPath signing is live.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(join(root, "src/config.ts"), "utf8");
const repo = process.env.GITHUB_REPOSITORY ?? config.match(/REPO_URL = "https:\/\/github\.com\/([^"]+)"/)?.[1];
if (!repo) throw new Error("No repository: set GITHUB_REPOSITORY");

const headers = { accept: "application/vnd.github+json", "user-agent": "rulebox-website-build" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
const out = join(root, "src/data/release.json");
const note = "Written by scripts/fetch-release.mjs at build time. null until the first public release exists.";

if (res.status === 404) {
  writeFileSync(out, JSON.stringify({ _note: note, latest: null }, null, 2) + "\n");
  console.log("No release yet: download page shows 'first release coming'.");
  process.exit(0);
}
if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}`);

const rel = await res.json();
const msi = rel.assets.find((a) => a.name.toLowerCase().endsWith(".msi"));
const sums = rel.assets.find((a) => a.name === "SHA256SUMS");
if (!msi || !sums) throw new Error(`Release ${rel.tag_name} needs an .msi and a SHA256SUMS asset`);

const sumsText = await (await fetch(sums.browser_download_url, { headers: { "user-agent": headers["user-agent"] } })).text();
const line = sumsText.split(/\r?\n/).find((l) => l.trim().endsWith(msi.name));
const sha256 = line?.trim().split(/\s+/)[0]?.toLowerCase();
if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`SHA256SUMS has no valid line for ${msi.name}`);

const latest = {
  version: rel.tag_name.replace(/^v/, ""),
  date: rel.published_at.slice(0, 10),
  msiUrl: msi.browser_download_url,
  msiName: msi.name,
  sha256,
  signed: process.env.RELEASE_SIGNED === "true",
};
writeFileSync(out, JSON.stringify({ _note: note, latest }, null, 2) + "\n");
console.log(`Release ${latest.version}: ${latest.msiName} ${latest.sha256}`);
