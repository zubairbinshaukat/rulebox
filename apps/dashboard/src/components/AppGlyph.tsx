import type { CSSProperties } from "react";
import type { AppKind } from "../data/types";

/** An app's tile art: its colour (hue) with the first letter of its name. */
export function AppGlyph({ name, hue, size = "md" }: { name: string; hue?: number; kind?: AppKind; size?: "md" | "lg" }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span
      className={["dash-glyph", size === "lg" ? "dash-glyph--lg" : ""].filter(Boolean).join(" ")}
      style={{ "--rb-hue": hue ?? 175 } as CSSProperties}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}
