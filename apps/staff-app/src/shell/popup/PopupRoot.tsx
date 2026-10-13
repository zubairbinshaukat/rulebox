import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Surface } from "@rulebox/ui";

import { call, isTauri, type PopupKind } from "../../lib/tauri";

/**
 * Placeholder (Step 4): shows which popup was asked for. The real contents
 * arrive with the Start menu (Step 9) and quick settings (Step 10).
 */
export function PopupRoot() {
  const [kind, setKind] = useState<PopupKind | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const show = await listen<{ kind: PopupKind }>("popup://show", (event) => {
        setKind(event.payload.kind);
      });
      const hide = await listen("popup://hide", () => setKind(null));
      if (disposed) {
        show();
        hide();
      } else {
        unlisten.push(show, hide);
      }
    })();
    return () => {
      disposed = true;
      for (const fn of unlisten) {
        fn();
      }
    };
  }, []);

  return (
    <Surface
      kind="popover"
      style={{
        height: "100vh",
        padding: 16,
        fontFamily: "var(--rb-font-sans)",
        color: "var(--rb-ink)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600 }}>Popup: {kind ?? "—"}</div>
      <button type="button" onClick={() => void call("popup_close", {})}>
        Close
      </button>
    </Surface>
  );
}
