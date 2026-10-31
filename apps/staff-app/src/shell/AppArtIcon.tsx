import type { CSSProperties } from "react";
import type { AppEntry } from "@rulebox/types";

import { hueFor } from "./appArt";
import { AppIcon } from "./appIcon";
import { useIconArt } from "./iconArt";
import { iconFit } from "./iconCutout";

/**
 * A catalogue app's art outside the tiles (taskbar button, app switcher, Start menu):
 * its logo cut out of its background and enlarged to fill the box, with no box drawn behind it
 * (a logo too dark or light for the theme is recoloured; see `iconCutout.ts`), a picture that
 * cannot be cut out filling the box with `cover`, or its Solar glyph on a
 * square in the app's colour. `large` is the switcher's size, `small` the Start menu's.
 */
export function AppArt({ app, large = false, small = false }: { app: AppEntry; large?: boolean; small?: boolean }) {
  const art = useIconArt(app.iconUrl);
  const style = {
    ["--rb-hue" as string]: hueFor(app),
    ...(app.iconUrl && art?.edge && !art.cutout ? { ["--rb-icon-edge" as string]: art.edge } : {}),
  } as CSSProperties;
  const size = large ? " rb-task__art--lg" : small ? " rb-task__art--sm" : "";
  if (app.iconUrl) {
    return (
      <span
        className={`rb-task__art rb-task__art--photo${size}`}
        style={style}
        data-icon-kind={art?.kind ?? "pending"}
        data-icon-tone={art?.tone}
        data-icon-fit={iconFit(art)}
        data-icon-recolor={art?.cutout ? art.recolor : undefined}
      >
        <img src={art?.cutout ?? app.iconUrl} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className={`rb-task__art rb-task__art--glyph${size}`} style={style}>
      <AppIcon app={app} />
    </span>
  );
}
