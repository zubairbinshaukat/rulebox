import type { HTMLAttributes } from "react";

/** Fixed hue table by file extension (Staff App file list). */
const EXT_HUE: Record<string, number> = {
  pdf: 25,
  doc: 210,
  docx: 210,
  xls: 145,
  xlsx: 145,
  csv: 145,
  ppt: 30,
  pptx: 30,
  txt: 70,
  md: 70,
  png: 300,
  jpg: 300,
  jpeg: 300,
  gif: 300,
  webp: 300,
  svg: 300,
  mp3: 280,
  wav: 280,
  m4a: 280,
  mp4: 255,
  mov: 255,
  webm: 255,
  zip: 55,
  rar: 55,
  "7z": 55,
};

function hueForExt(ext: string): number {
  const key = ext.replace(/^\./, "").toLowerCase();
  return EXT_HUE[key] ?? 175;
}

export interface FileChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** File extension, with or without a leading dot. */
  ext: string;
}

/** Coloured type chip; hue comes from a fixed extension table. */
export function FileChip({ ext, className, style, ...rest }: FileChipProps) {
  const label = ext.replace(/^\./, "").toUpperCase() || "FILE";
  const hue = hueForExt(ext);
  const cls = ["rb-file-chip", className ?? ""].filter(Boolean).join(" ");

  return (
    <span
      className={cls}
      style={{ ...style, ["--rb-hue" as string]: hue }}
      {...rest}
    >
      {label}
    </span>
  );
}
