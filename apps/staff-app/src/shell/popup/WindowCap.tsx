import { useCallback, useEffect, useState } from "react";
import { Button } from "@rulebox/ui";

import { call, type CapPrompt } from "../../lib/tauri";

/**
 * "Too many windows are open" (Phase 6 Step 19, PRD 22.4): at the window cap the employee chooses which web app window to close
 * so the app they clicked can open. Nothing is ever closed without a click here. No animation: it is a plain list.
 */
export function WindowCap() {
  const [prompt, setPrompt] = useState<CapPrompt | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void call("window_cap_state", {}).then(setPrompt);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void call("window_cap_state", {}).then((next) => {
      if (!cancelled) {
        setPrompt(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing waits any more (the app was opened some other way): the dialog has no purpose.
  useEffect(() => {
    if (prompt === null) {
      void call("popup_close", {});
    }
  }, [prompt]);

  if (!prompt) {
    return null;
  }

  const pick = (label: string) => {
    setBusy(true);
    void call("window_cap_close", { label })
      .then((outcome) => {
        // Still at the cap (it was lowered meanwhile): ask again with the windows that are left.
        if (outcome === "stillFull") {
          load();
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <div
      data-testid="window-cap"
      style={{
        height: "100%",
        boxSizing: "border-box",
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <h2 style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>Too many windows are open</h2>
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--rb-muted)" }}>
        {`At most ${prompt.cap} ${prompt.cap === 1 ? "window" : "windows"} can be open at once. Close one to open ${prompt.appName}.`}
      </p>
      <ul
        aria-label="Open windows"
        style={{ listStyle: "none", margin: 0, padding: 0, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}
      >
        {prompt.windows.map((window) => (
          <li key={window.label}>
            <Button
              variant="ghost"
              disabled={busy}
              aria-label={`Close ${window.appName}`}
              onClick={() => pick(window.label)}
              style={{ width: "100%", justifyContent: "flex-start" }}
            >
              {`Close ${window.appName}`}
            </Button>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: "auto", display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {/* Cancel takes the focus first: Enter right after opening must not close anybody's window. */}
        <Button variant="ghost" disabled={busy} data-autofocus onClick={() => void call("window_cap_cancel", {})}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
