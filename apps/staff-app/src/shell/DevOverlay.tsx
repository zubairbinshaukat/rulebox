import { useEffect, useState } from "react";
import type { AgentLinkDto, EnrollmentDto, KioskPhaseDto, ThemeDto } from "@rulebox/types";

import { call, isTauri } from "../lib/tauri";
import { useShell } from "../lib/store";
import {
  getForceReducedMotion,
  setForceReducedMotion,
} from "../lib/motion";

/**
 * Debug-only overlay (Ctrl+Shift+D): theme, Lite, simulated reduced motion,
 * and boot link/enrollment overrides for §7.1 screenshots.
 *
 * Hotkeys (DEV only): Ctrl+Shift+D toggle · 1–7 boot · 8/9 theme · 0 Lite.
 * Screenshot automation can also write `%TEMP%\rulebox-staff-dev-cmd.json`
 * (Rust poller in debug builds).
 */
export function DevOverlay() {
  const display = useShell((s) => s.display);
  const [open, setOpen] = useState(false);
  const [reduced, setReduced] = useState(getForceReducedMotion);

  const lite = display.lite;
  const theme = display.theme;

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const setTheme = async (next: ThemeDto) => {
      if (isTauri()) {
        await call("dev_set_display", { lite, theme: next });
      }
    };

    const setLite = async (next: boolean) => {
      if (isTauri()) {
        await call("dev_set_display", { lite: next, theme });
      }
    };

    const setBoot = async (patch: {
      link?: AgentLinkDto | null;
      enrollment?: EnrollmentDto | null;
      kioskPhase?: KioskPhaseDto | null;
      clockSuspect?: boolean | null;
    }) => {
      if (!isTauri()) return;
      await call("dev_set_boot", {
        link: patch.link ?? null,
        enrollment: patch.enrollment ?? null,
        kioskPhase: patch.kioskPhase ?? null,
        clockSuspect: patch.clockSuspect ?? null,
      });
    };

    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.shiftKey)) return;
      switch (event.code) {
        case "KeyD":
          event.preventDefault();
          setOpen((v) => !v);
          return;
        case "Digit1":
          event.preventDefault();
          void setBoot({ link: "disconnected" });
          return;
        case "Digit2":
          event.preventDefault();
          void setBoot({ link: "versionMismatch" });
          return;
        case "Digit3":
          event.preventDefault();
          void setBoot({ link: "linked", enrollment: "notEnrolled" });
          return;
        case "Digit4":
          event.preventDefault();
          void setBoot({
            link: "linked",
            enrollment: "revoked",
            kioskPhase: "applied",
          });
          return;
        case "Digit5":
          event.preventDefault();
          void setBoot({
            link: "linked",
            enrollment: "enrolled",
            kioskPhase: "applying",
          });
          return;
        case "Digit6":
          event.preventDefault();
          void setBoot({
            link: "linked",
            enrollment: "enrolled",
            kioskPhase: "applied",
          });
          return;
        case "Digit7":
          event.preventDefault();
          void setBoot({ clockSuspect: true });
          return;
        case "Digit8":
          event.preventDefault();
          void setTheme("light");
          return;
        case "Digit9":
          event.preventDefault();
          void setTheme("dark");
          return;
        case "Digit0":
          event.preventDefault();
          void setLite(!lite);
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lite, theme]);

  if (!import.meta.env.DEV || !open) {
    return null;
  }

  const setTheme = async (next: ThemeDto) => {
    if (isTauri()) {
      await call("dev_set_display", { lite: display.lite, theme: next });
    }
  };

  const setLite = async (next: boolean) => {
    if (isTauri()) {
      await call("dev_set_display", { lite: next, theme: display.theme });
    }
  };

  const setBoot = async (patch: {
    link?: AgentLinkDto | null;
    enrollment?: EnrollmentDto | null;
    kioskPhase?: KioskPhaseDto | null;
    clockSuspect?: boolean | null;
  }) => {
    if (!isTauri()) return;
    await call("dev_set_boot", {
      link: patch.link ?? null,
      enrollment: patch.enrollment ?? null,
      kioskPhase: patch.kioskPhase ?? null,
      clockSuspect: patch.clockSuspect ?? null,
    });
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
        minWidth: 220,
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
      <div style={{ fontWeight: 600, marginTop: 4 }}>Boot force</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <button type="button" onClick={() => void setBoot({ link: "disconnected" })}>
          disconnect
        </button>
        <button type="button" onClick={() => void setBoot({ link: "versionMismatch" })}>
          mismatch
        </button>
        <button
          type="button"
          onClick={() => void setBoot({ link: "linked", enrollment: "notEnrolled" })}
        >
          not set up
        </button>
        <button
          type="button"
          onClick={() =>
            void setBoot({ link: "linked", enrollment: "revoked", kioskPhase: "applied" })
          }
        >
          removed
        </button>
        <button
          type="button"
          onClick={() =>
            void setBoot({
              link: "linked",
              enrollment: "enrolled",
              kioskPhase: "applying",
            })
          }
        >
          applying
        </button>
        <button
          type="button"
          onClick={() =>
            void setBoot({
              link: "linked",
              enrollment: "enrolled",
              kioskPhase: "applied",
            })
          }
        >
          reset linked
        </button>
        <button type="button" onClick={() => void setBoot({ clockSuspect: true })}>
          bad clock
        </button>
      </div>
      <div style={{ fontWeight: 600, marginTop: 4 }}>Shell actions (no global hotkeys in dev)</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <button type="button" onClick={() => isTauri() && void call("popup_open", { kind: "switcher", anchor: null })}>
          App switcher
        </button>
        <button type="button" onClick={() => isTauri() && void call("popup_open", { kind: "start", anchor: null })}>
          Start
        </button>
        <button type="button" onClick={() => isTauri() && void call("admin_exit_open", {})}>
          Admin exit
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          if (isTauri()) {
            void call("restart_rulebox", {});
          }
        }}
      >
        Restart Rulebox
      </button>
      <div style={{ color: "var(--rb-muted)" }}>
        Ctrl+Shift+D · hotkeys 1–7 boot, 8/9 theme, 0 Lite
      </div>
    </div>
  );
}
