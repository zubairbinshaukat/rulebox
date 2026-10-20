import type { ViewerKind } from "@rulebox/types";

/**
 * Which viewer shows a file. This mirrors the Rust table in
 * `src-tauri/src/files/types.rs` (`viewer_for`); a test keeps the two in step
 * with the formats of PRD 7.9. Files the table does not know get no viewer.
 */
const VIEWERS: Record<string, ViewerKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  mp3: "media",
  wav: "media",
  m4a: "media",
  aac: "media",
  ogg: "media",
  mp4: "media",
  webm: "media",
  pdf: "pdf",
  txt: "text",
  csv: "csv",
  docx: "docx",
  xlsx: "xlsx",
};

const MEDIA_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** The last extension, lower-cased, after trimming dots and spaces (as the backend does). */
export function extensionOf(name: string): string {
  const trimmed = name.replace(/^[. ]+|[. ]+$/g, "");
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0) {
    return "";
  }
  return trimmed
    .slice(dot + 1)
    .replace(/^[. ]+|[. ]+$/g, "")
    .toLowerCase();
}

export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function viewerKindFor(name: string): ViewerKind | null {
  return VIEWERS[extensionOf(name)] ?? null;
}

export function mediaMime(name: string): string | null {
  return MEDIA_MIME[extensionOf(name)] ?? null;
}

/** Audio or video, for a media file. */
export function isVideo(name: string): boolean {
  return mediaMime(name)?.startsWith("video/") ?? false;
}

/** The `rbfile` address of a file: served by the Rust protocol, with ranges. */
export function rbfileUrl(path: string): string {
  return `http://rbfile.localhost/${path.split("/").map(encodeURIComponent).join("/")}`;
}
