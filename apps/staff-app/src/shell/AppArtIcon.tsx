import type { CSSProperties } from "react";
import type { AppEntry } from "@rulebox/types";

import { hueFor } from "./appArt";
import { AppIcon } from "./appIcon";

/**
 * A catalogue app's art outside the tiles (taskbar, app switcher): its own
 * icon on a light plate, or its Solar glyph on a square in the app's colour.
 */
export function AppArt({ app, large = false }: { app: AppEntry; large?: boolean }) {
  const style = { ["--rb-hue" as string]: hueFor(app) } as CSSProperties;
  const size = large ? " rb-task__art--lg" : "";
  if (app.iconUrl) {
    return (
      <span className={`rb-task__art rb-task__art--image${size}`} style={style}>
        <img src={app.iconUrl} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className={`rb-task__art rb-task__art--glyph${size}`} style={style}>
      <AppIcon app={app} />
    </span>
  );
}
