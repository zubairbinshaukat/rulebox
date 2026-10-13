import { useEffect, useState } from "react";
import type { ThemeDto } from "@rulebox/types";

import { call, isTauri } from "../lib/tauri";
import { useShell } from "../lib/store";
import {
  getForceReducedMotion,
  setForceReducedMotion,
} from "../lib/motion";

/**
 * Debug-only overlay (Ctrl+Shift+D): theme, Lite, simulated reduced motion.
 * Frame meter lands in Step 17.
 */
export function DevOverlay() {
  const display = useShell((s) => s.display);
  const [open, setOpen] = useState(false);
  const [reduced, setReduced] = useState(getForceReducedMotion);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.code === "KeyD") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!import.meta.env.DEV || !open) {
    return null;
  }

  const setTheme = async (theme: ThemeDto) => {
    if (isTauri()) {
      await call("dev_set_display", { lite: display.lite, theme });
    }
  };

  const setLite = async (lite: boolean) => {
    if (isTauri()) {
      await call("dev_set_display", { lite, theme: display.theme });
    }
  };

  const toggleReduced = () => {
    const next = !reduced;
    setForceReducedMotion(next);
    setReduced(next);
  };

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 9999,
        padding: 12,
        borderRadius: 12,
        background: "var(--rb-surface)",
        border: "1px solid var(--rb-line)",
        boxShadow: "var(--rb-shadow-md)",
        fontFamily: "var(--rb-font-mono)",
        fontSize: 12,
        color: "var(--rb-ink)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 200,
      }}
    >
      <div style={{ fontWeight: 600 }}>Dev overlay</div>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        Theme
        <select
          value={display.theme}
          onChange={(e) => void setTheme(e.target.value as ThemeDto)}
        >
          <option value="auto">auto</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
        </select>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={display.lite}
          onChange={(e) => void setLite(e.target.checked)}
        />
        Lite
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={reduced} onChange={toggleReduced} />
        Reduced motion (sim)
      </label>
      <div style={{ color: "var(--rb-muted)" }}>Ctrl+Shift+D to hide</div>
    </div>
  );
}
