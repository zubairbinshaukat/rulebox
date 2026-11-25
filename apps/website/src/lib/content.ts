/*
 * Small helpers shared by the docs and blog pages: reading time, the docs
 * section order (sidebar, docs home, prev/next) and dates.
 */
import { getCollection, type CollectionEntry } from "astro:content";
import type { IconName } from "../components/Icon.astro";

/** Minutes to read, at 220 words a minute (rounded up, at least 1). */
export function readMinutes(body = ""): number {
  const text = body
    .replace(/^---[\s\S]*?---/, "") // front matter (if present)
    .replace(/^import .*$/gm, "") // MDX imports
    .replace(/<\/?[A-Z][^>]*>/g, " ") // MDX components
    .replace(/[#>*_`|[\]()-]/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

/** "25 November 2026" (British order). */
export function longDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export const DOC_SECTIONS: { name: string; icon: IconName; tone: string; text: string }[] = [
  { name: "Start here", icon: "signpost", tone: "blue", text: "What Rulebox is, and what a PC needs." },
  { name: "Install and enrol", icon: "cloud-download", tone: "sun", text: "Download, verify, enrol, and undo." },
  { name: "Manage", icon: "settings", tone: "mint", text: "People, apps, rules and rollouts." },
  { name: "Security", icon: "shield", tone: "coral", text: "The design, the layers and the limits." },
  { name: "Self-hosting", icon: "server", tone: "violet", text: "Run the backend yourself." },
  { name: "Reference", icon: "book", tone: "blue", text: "Settings, limits and terms." },
  { name: "Contributing", icon: "code", tone: "mint", text: "Build, run and test each part." },
];

export interface DocGroup {
  name: string;
  icon: IconName;
  tone: string;
  text: string;
  pages: CollectionEntry<"docs">[];
}

/** Docs grouped by section in sidebar order; empty sections are left out. */
export async function docGroups(): Promise<DocGroup[]> {
  const all = await getCollection("docs");
  return DOC_SECTIONS.map((s) => ({
    ...s,
    pages: all.filter((d) => d.data.section === s.name).sort((a, b) => a.data.order - b.data.order),
  })).filter((g) => g.pages.length);
}
