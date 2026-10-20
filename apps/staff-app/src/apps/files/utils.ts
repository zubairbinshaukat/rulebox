import type { Entry } from "@rulebox/types";
import type { SidebarSection, SortConfig } from "./types";
export { formatBytes } from "./storage";

export const DOC_EXTS = new Set([
  "doc",
  "docx",
  "pdf",
  "txt",
  "rtf",
  "odt",
  "xls",
  "xlsx",
  "csv",
  "ppt",
  "pptx",
  "md",
]);

export const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"]);
export const VIDEO_EXTS = new Set(["mp4", "webm", "mkv", "avi", "mov"]);
export const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "bmp",
]);

/**
 * A DOM id for an item, safe for `aria-activedescendant` (an id list is split
 * on spaces, so a path with a space would break it).
 */
export function itemId(path: string): string {
  return `fx-${Array.from(new TextEncoder().encode(path), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

export function formatDate(ms: number): string {
  if (!ms || ms <= 0) {
    return "--";
  }
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Sort entries: folders always first, then by the configured sort field. */
export function sortEntries(entries: Entry[], sort: SortConfig): Entry[] {
  return [...entries].sort((a, b) => {
    // Folders come first
    if (a.kind === "folder" && b.kind !== "folder") {
      return -1;
    }
    if (a.kind !== "folder" && b.kind === "folder") {
      return 1;
    }

    let cmp = 0;
    switch (sort.field) {
      case "name":
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
        break;
      case "type": {
        const extA = a.kind === "folder" ? "" : getExtension(a.name);
        const extB = b.kind === "folder" ? "" : getExtension(b.name);
        cmp = extA.localeCompare(extB);
        if (cmp === 0) {
          cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        }
        break;
      }
      case "size":
        cmp = a.size - b.size;
        break;
      case "modified":
        cmp = a.modifiedMs - b.modifiedMs;
        break;
    }

    return sort.direction === "asc" ? cmp : -cmp;
  });
}

/** Filter entries according to active sidebar media category. */
export function filterEntriesBySection(
  entries: Entry[],
  section: SidebarSection,
): Entry[] {
  switch (section) {
    case "documents":
      return entries.filter(
        (e) => e.kind === "folder" || DOC_EXTS.has(getExtension(e.name)),
      );
    case "audio":
      return entries.filter(
        (e) => e.kind === "folder" || AUDIO_EXTS.has(getExtension(e.name)),
      );
    case "video":
      return entries.filter(
        (e) => e.kind === "folder" || VIDEO_EXTS.has(getExtension(e.name)),
      );
    case "images":
      return entries.filter(
        (e) => e.kind === "folder" || IMAGE_EXTS.has(getExtension(e.name)),
      );
    default:
      return entries;
  }
}
