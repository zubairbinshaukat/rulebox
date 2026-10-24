import type { Entry, FileKind } from "@rulebox/types";
import type { SidebarSection, SortConfig } from "./types";
export { formatBytes } from "./storage";

// Keep these in step with `FileKind::matches` (src-tauri/src/files/types.rs).
export const DOC_EXTS = new Set([
  "doc",
  "docx",
  "pdf",
  "txt",
  "rtf",
  "odt",
  "ods",
  "odp",
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

/**
 * The sidebar's file categories: every file of that kind anywhere in the
 * employee's folder (loaded with `fs_files`), not the current folder filtered.
 */
export const CATEGORY_KINDS = {
  documents: "documents",
  audio: "audio",
  video: "video",
  images: "images",
} as const satisfies Partial<Record<SidebarSection, FileKind>>;

export const CATEGORY_TITLES: Record<keyof typeof CATEGORY_KINDS, string> = {
  documents: "Documents",
  audio: "Audio",
  video: "Video",
  images: "Images",
};

/** The `fs_files` kind for a category section, or null for a place (All files, Downloads, Trash). */
export function categoryKind(section: SidebarSection): FileKind | null {
  return section in CATEGORY_KINDS ? CATEGORY_KINDS[section as keyof typeof CATEGORY_KINDS] : null;
}

/**
 * Filter entries for the active sidebar section. A category shows files of
 * its kind only (also among search results); a place shows everything.
 */
export function filterEntriesBySection(
  entries: Entry[],
  section: SidebarSection,
): Entry[] {
  const keep = (exts: Set<string>) =>
    entries.filter((e) => e.kind === "file" && exts.has(getExtension(e.name)));
  switch (section) {
    case "documents":
      return keep(DOC_EXTS);
    case "audio":
      return keep(AUDIO_EXTS);
    case "video":
      return keep(VIDEO_EXTS);
    case "images":
      return keep(IMAGE_EXTS);
    default:
      return entries;
  }
}
