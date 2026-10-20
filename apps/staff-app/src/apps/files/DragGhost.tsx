import type { CSSProperties } from "react";

import type { DragState } from "./dragLogic";

/** The label that follows the pointer while dragging. */
export function DragGhost({ drag }: { drag: DragState | null }) {
  if (!drag) {
    return null;
  }
  const style: CSSProperties = {
    position: "fixed",
    left: 0,
    top: 0,
    transform: `translate(${drag.x + 14}px, ${drag.y + 14}px)`,
    pointerEvents: "none",
    zIndex: 2000,
    padding: "4px 10px",
    borderRadius: 8,
    background: "var(--rb-surface)",
    border: `1px solid ${drag.target !== null ? "var(--rb-accent)" : "var(--rb-line)"}`,
    boxShadow: "var(--rb-shadow-md)",
    fontSize: 12.5,
    fontWeight: 500,
    maxWidth: 260,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--rb-ink)",
  };
  const count = drag.paths.length;
  return (
    <div aria-hidden style={style}>
      {count > 1 ? `${count} items` : drag.label}
    </div>
  );
}
