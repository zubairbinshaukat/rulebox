import type { AppEntry } from "@rulebox/types";
import IconFolder from "~icons/solar/folder-bold-duotone";
import IconDocument from "~icons/solar/document-bold-duotone";
import IconGlobal from "~icons/solar/global-bold-duotone";
import IconWidget from "~icons/solar/widget-bold-duotone";

/** The Solar glyph standing in for a catalogue app (tiles, taskbar, Start). */
export function AppIcon({ app }: { app: AppEntry }) {
  const key = app.iconKey ?? "";
  if (key.includes("folder") || app.id === "files") {
    return <IconFolder width="1em" height="1em" />;
  }
  if (app.kind.type === "web") {
    return <IconGlobal width="1em" height="1em" />;
  }
  if (app.kind.type === "builtin") {
    return <IconDocument width="1em" height="1em" />;
  }
  return <IconWidget width="1em" height="1em" />;
}

/** Fallback glyph for a program window whose icon could not be loaded. */
export function GenericProgramIcon() {
  return <IconWidget width="1em" height="1em" />;
}
