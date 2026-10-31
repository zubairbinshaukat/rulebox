import type { CSSProperties } from "react";
import type { AppKind } from "../data/types";

/**
 * An app's tile art: its icon when it has one (a PNG from the app's own site,
 * stored with the app), else its colour (hue) with the first letter of its name.
 */
export function AppGlyph({ name, hue, iconUrl, size = "md" }: { name: string; hue?: number; iconUrl?: string; kind?: AppKind; size?: "md" | "lg" }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span
      className={["dash-glyph", size === "lg" ? "dash-glyph--lg" : "", iconUrl ? "dash-glyph--icon" : ""].filter(Boolean).join(" ")}
      style={{ "--rb-hue": hue ?? 175 } as CSSProperties}
      aria-hidden="true"
    >
      {iconUrl ? <img src={iconUrl} alt="" width={56} height={56} decoding="async" /> : letter}
    </span>
  );
}
