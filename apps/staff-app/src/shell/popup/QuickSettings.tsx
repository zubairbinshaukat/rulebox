import { useEffect, type CSSProperties } from "react";
import { Slider } from "@rulebox/ui";
import type { NoticeTone, ThemeDto } from "@rulebox/types";
import IconClose from "~icons/solar/close-circle-bold-duotone";
import IconMonitor from "~icons/solar/monitor-bold-duotone";
import IconMoon from "~icons/solar/moon-bold-duotone";
import IconSun from "~icons/solar/sun-bold-duotone";
import IconVolumeCross from "~icons/solar/volume-cross-bold-duotone";
import IconVolumeLoud from "~icons/solar/volume-loud-bold-duotone";

import { useShell } from "../../lib/store";
import { call } from "../../lib/tauri";
import { batteryLine, networkLabel } from "../taskbar/status";

const THEMES: { id: ThemeDto; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** Volume, battery, network, brightness, theme and the notice list. */
export function QuickSettings() {
  const volume = useShell((s) => s.system.volume);
  const battery = useShell((s) => s.system.battery);
  const network = useShell((s) => s.system.network);
  const brightness = useShell((s) => s.system.brightness);
  const theme = useShell((s) => s.display.theme);
  const notices = useShell((s) => s.notices);

  useEffect(() => {
    void call("notices_seen", {});
  }, []);

  const line = batteryLine(battery);
  const percent = volume == null ? 0 : Math.round(volume.level * 100);

  return (
    <div
      data-testid="quick-settings"
      style={{
        height: "100%",
        boxSizing: "border-box",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        minHeight: 0,
      }}
    >
      {volume == null ? (
        <p style={{ margin: 0, color: "var(--rb-muted)" }}>No sound device</p>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Slider
              label="Volume"
              min={0}
              max={100}
              step={1}
              value={percent}
              onChange={(value) => void call("set_volume", { level: value / 100 })}
            />
          </div>
          <button
            type="button"
            aria-label={volume.muted ? "Unmute" : "Mute"}
            aria-pressed={volume.muted}
            title={volume.muted ? "Unmute" : "Mute"}
            onClick={() => void call("set_muted", { muted: !volume.muted })}
            style={iconButton}
          >
            {volume.muted ? (
              <IconVolumeCross width={20} height={20} />
            ) : (
              <IconVolumeLoud width={20} height={20} />
            )}
          </button>
        </div>
      )}

      {line ? <p style={{ margin: 0, fontSize: 14 }}>{line}</p> : null}
      <p style={{ margin: 0, fontSize: 14, color: "var(--rb-muted)" }}>{networkLabel(network)}</p>

      {brightness != null ? (
        <Slider
          label="Brightness"
          min={0}
          max={100}
          step={1}
          value={brightness}
          onChange={(value) => void call("set_brightness", { level: value })}
        />
      ) : null}

      <div role="group" aria-label="Theme" style={{ display: "flex", gap: 6 }}>
        {THEMES.map((choice) => {
          const selected = theme === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              aria-pressed={selected}
              onClick={() => void call("set_theme", { theme: choice.id })}
              style={{
                ...themeButton,
                background: selected ? "var(--rb-accent-soft)" : "transparent",
                color: selected ? "var(--rb-accent-text)" : "var(--rb-ink)",
              }}
            >
              {choice.id === "auto" ? <IconMonitor width={16} height={16} /> : null}
              {choice.id === "light" ? <IconSun width={16} height={16} /> : null}
              {choice.id === "dark" ? <IconMoon width={16} height={16} /> : null}
              {choice.label}
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600 }}>Notices</div>
      <div
        aria-live="polite"
        style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 8 }}
      >
        {notices.length === 0 ? (
          <p style={{ margin: 0, color: "var(--rb-muted)", fontSize: 13.5 }}>No notices</p>
        ) : (
          [...notices].reverse().map((notice) => (
            <div
              key={notice.id}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                fontSize: 13.5,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  marginTop: 5,
                  borderRadius: 99,
                  flex: "none",
                  background: toneColor(notice.tone),
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{notice.title}</div>
                {notice.detail ? (
                  <div style={{ color: "var(--rb-muted)" }}>{notice.detail}</div>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={`Dismiss ${notice.title}`}
                onClick={() => void call("dismiss_notice", { id: notice.id })}
                style={iconButton}
              >
                <IconClose width={16} height={16} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function toneColor(tone: NoticeTone): string {
  switch (tone) {
    case "neutral":
      return "var(--rb-muted)";
    case "accent":
      return "var(--rb-accent)";
    case "success":
      return "var(--rb-success)";
    case "warning":
      return "var(--rb-warning)";
    case "danger":
      return "var(--rb-danger)";
    default: {
      const unreachable: never = tone;
      return unreachable;
    }
  }
}

const iconButton: CSSProperties = {
  width: 36,
  height: 36,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 10,
  border: 0,
  background: "transparent",
  color: "var(--rb-ink)",
  cursor: "pointer",
  flex: "none",
};

const themeButton: CSSProperties = {
  flex: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  height: 36,
  borderRadius: 12,
  border: "1px solid var(--rb-line)",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13.5,
};
