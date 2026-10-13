import { useRef } from "react";
import { Surface } from "@rulebox/ui";

import { anchorOf, call, isTauri } from "../../lib/tauri";

/**
 * Placeholder strip (Step 4). The real taskbar is Step 6. The Start button
 * exists so the popup window can be placed and checked on screen.
 */
export function Taskbar() {
  const start = useRef<HTMLButtonElement>(null);

  const openStart = () => {
    if (!isTauri() || !start.current) {
      return;
    }
    void call("popup_open", {
      kind: "start",
      anchor: anchorOf(start.current),
    });
  };

  return (
    <Surface
      kind="bar"
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 12,
        fontFamily: "var(--rb-font-sans)",
        color: "var(--rb-ink)",
      }}
    >
      <button ref={start} type="button" onClick={openStart}>
        Start
      </button>
      <span style={{ color: "var(--rb-muted)" }}>Taskbar (Step 6)</span>
    </Surface>
  );
}
