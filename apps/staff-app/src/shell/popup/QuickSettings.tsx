import { useEffect, type CSSProperties, type ReactNode } from "react";
import { Slider } from "@rulebox/ui";
import type { BatteryDto, NetworkDto, NoticeTone, ThemeDto } from "@rulebox/types";
import IconBatteryCharge from "~icons/solar/battery-charge-bold-duotone";
import IconBatteryFull from "~icons/solar/battery-full-bold-duotone";
import IconBatteryHalf from "~icons/solar/battery-half-bold-duotone";
import IconBatteryLow from "~icons/solar/battery-low-bold-duotone";
import IconBellOff from "~icons/solar/bell-off-bold-duotone";
import IconClose from "~icons/solar/close-circle-bold-duotone";
import IconInfo from "~icons/solar/info-circle-bold-duotone";
import IconMonitor from "~icons/solar/monitor-bold-duotone";
import IconMoon from "~icons/solar/moon-bold-duotone";
import IconSun from "~icons/solar/sun-bold-duotone";
import IconSunBright from "~icons/solar/sun-2-bold-duotone";
import IconVolumeCross from "~icons/solar/volume-cross-bold-duotone";
import IconVolumeLoud from "~icons/solar/volume-loud-bold-duotone";
import IconWifiHigh from "~icons/solar/wi-fi-high-bold-duotone";
import IconWifiLow from "~icons/solar/wi-fi-low-bold-duotone";
import IconWifiOff from "~icons/solar/wi-fi-off-bold-duotone";

import { useShell } from "../../lib/store";
import { call } from "../../lib/tauri";
import { batteryLine, networkLabel } from "../taskbar/status";
import { useThrottledValue } from "./useThrottledValue";

const THEMES: { id: ThemeDto; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/**
 * Network and battery (read-only), volume, brightness, theme and the notice
 * list. Volume is always drawn: with no sound device it is a disabled slider
 * with a line saying so. Brightness is drawn only when this machine has a
 * controllable screen (a desktop PC or a VM has none).
 *
 * Wi-Fi is status only here (PRD 24.2: networks are pushed by the
 * administrator, employees cannot open Windows settings).
 */
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

  const volumeSlider = useThrottledValue(volume == null ? 0 : Math.round(volume.level * 100), (value) => {
    void call("set_volume", { level: value / 100 }).catch(() => undefined);
  });
  const brightnessSlider = useThrottledValue(brightness ?? 0, (value) => {
    void call("set_brightness", { level: value }).catch(() => undefined);
  });

  const line = batteryLine(battery);

  return (
    <div
      data-testid="quick-settings"
      style={{
        height: "100%",
        boxSizing: "border-box",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 0,
      }}
    >
      <section style={card} aria-label="Status">
        <StatusRow
          icon={networkIcon(network)}
          tone={networkTone(network)}
          title="Network"
          detail={networkLabel(network)}
        />
        {battery && line ? (
          <StatusRow
            icon={batteryIcon(battery)}
            tone={battery.charging ? "good" : battery.percent != null && battery.percent < 20 ? "bad" : "plain"}
            title="Battery"
            detail={line}
          />
        ) : null}
        <p id="qs-network-note" style={note}>
          <IconInfo width={16} height={16} aria-hidden style={{ flex: "none", marginTop: 1 }} />
          <span>Wi-Fi networks are set up by your administrator.</span>
        </p>
      </section>

      <section style={card} aria-label="Sound and screen">
        <div style={controlRow}>
          <button
            type="button"
            // One name and a pressed state: "Mute, pressed", not a name that flips with it.
            aria-label="Mute"
            aria-pressed={volume?.muted ?? false}
            disabled={volume == null}
            title={volume == null ? "No sound device" : volume.muted ? "Unmute" : "Mute"}
            onClick={() => void call("set_muted", { muted: !volume?.muted }).catch(() => undefined)}
            style={{ ...iconButton, opacity: volume == null ? 0.5 : 1, cursor: volume == null ? "default" : "pointer" }}
          >
            {volume?.muted ? (
              <IconVolumeCross width={20} height={20} />
            ) : (
              <IconVolumeLoud width={20} height={20} />
            )}
          </button>
          <Slider
            className="rb-slider--bare"
            label="Volume"
            min={0}
            max={100}
            step={1}
            value={volumeSlider.value}
            disabled={volume == null}
            onChange={volumeSlider.change}
          />
        </div>
        {volume == null ? (
          <p style={hint} data-testid="no-sound-device">
            No sound device found on this computer.
          </p>
        ) : null}

        {brightness != null ? (
          <div style={controlRow}>
            <span aria-hidden style={{ ...iconTile, background: "transparent" }}>
              <IconSunBright width={20} height={20} />
            </span>
            <Slider
              className="rb-slider--bare"
              label="Brightness"
              min={0}
              max={100}
              step={1}
              value={brightnessSlider.value}
              onChange={brightnessSlider.change}
            />
          </div>
        ) : null}
      </section>

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
                // Bold and a heavier edge as well as the tint: the choice is not told by colour alone.
                fontWeight: selected ? 600 : 400,
                borderColor: selected ? "var(--rb-focus)" : "var(--rb-line-strong)",
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

      <h2 style={{ margin: "2px 0 0", fontSize: 13, fontWeight: 600 }}>Notices</h2>
      <div
        aria-live="polite"
        style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 8 }}
      >
        {notices.length === 0 ? (
          <p style={empty}>
            <IconBellOff width={18} height={18} aria-hidden />
            No notices
          </p>
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
                <div style={{ fontWeight: 600 }}>
                  {/* The dot's colour in words, so a problem is not told by colour alone. */}
                  {TONE_WORD[notice.tone] ? <span className="rb-sr-only">{TONE_WORD[notice.tone]}: </span> : null}
                  {notice.title}
                </div>
                {notice.detail ? (
                  <div style={{ color: "var(--rb-muted)" }}>{notice.detail}</div>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={`Dismiss ${notice.title}`}
                onClick={() => void call("dismiss_notice", { id: notice.id })}
                style={{ ...iconButton, width: 32, height: 32 }}
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

type RowTone = "good" | "warn" | "bad" | "plain";

/** An icon tile, a title and one line of state. Read-only. */
function StatusRow({
  icon,
  tone,
  title,
  detail,
}: {
  icon: ReactNode;
  tone: RowTone;
  title: string;
  detail: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span aria-hidden style={{ ...iconTile, ...TILE_TONE[tone] }}>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--rb-muted)" }}>{title}</div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{detail}</div>
      </div>
    </div>
  );
}

function networkTone(network: NetworkDto): RowTone {
  switch (network) {
    case "internet":
      return "good";
    case "local":
      return "warn";
    case "none":
      return "plain";
    default: {
      const unreachable: never = network;
      return unreachable;
    }
  }
}

function networkIcon(network: NetworkDto): ReactNode {
  switch (network) {
    case "internet":
      return <IconWifiHigh width={20} height={20} />;
    case "local":
      return <IconWifiLow width={20} height={20} />;
    case "none":
      return <IconWifiOff width={20} height={20} />;
    default: {
      const unreachable: never = network;
      return unreachable;
    }
  }
}

function batteryIcon(battery: BatteryDto): ReactNode {
  if (battery.charging) {
    return <IconBatteryCharge width={20} height={20} />;
  }
  if (battery.percent != null && battery.percent < 20) {
    return <IconBatteryLow width={20} height={20} />;
  }
  if (battery.percent != null && battery.percent < 50) {
    return <IconBatteryHalf width={20} height={20} />;
  }
  return <IconBatteryFull width={20} height={20} />;
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
      // The darker shade: --rb-warning is 2.3:1 on the popup.
      return "var(--rb-warning-text)";
    case "danger":
      return "var(--rb-danger)";
    default: {
      const unreachable: never = tone;
      return unreachable;
    }
  }
}

const TONE_WORD: Partial<Record<NoticeTone, string>> = {
  success: "Success",
  warning: "Warning",
  danger: "Error",
};

const TILE_TONE: Record<RowTone, CSSProperties> = {
  good: { background: "var(--rb-success-soft)", color: "var(--rb-success-text)" },
  warn: { background: "var(--rb-warning-soft)", color: "var(--rb-warning-text)" },
  bad: { background: "var(--rb-danger-soft)", color: "var(--rb-danger-text)" },
  plain: { background: "var(--rb-hover)", color: "var(--rb-ink)" },
};

/** A rounded group on the popup: quiet fill, hairline edge. */
const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 14,
  borderRadius: "var(--rb-r-16)",
  background: "var(--rb-paper)",
  border: "1px solid var(--rb-line)",
};

const iconTile: CSSProperties = {
  width: 36,
  height: 36,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "var(--rb-r-md)",
  flex: "none",
};

const controlRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const note: CSSProperties = {
  margin: 0,
  paddingTop: 12,
  borderTop: "1px solid var(--rb-line)",
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  fontSize: 12.5,
  lineHeight: 1.4,
  color: "var(--rb-muted)",
};

const hint: CSSProperties = {
  margin: "-4px 0 0 48px",
  fontSize: 12.5,
  color: "var(--rb-muted)",
};

const empty: CSSProperties = {
  margin: 0,
  padding: "14px 0",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: "var(--rb-muted)",
  fontSize: 13.5,
};

const iconButton: CSSProperties = {
  width: 36,
  height: 36,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "var(--rb-r-md)",
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
  borderRadius: "var(--rb-r-md)",
  border: "1px solid var(--rb-line)",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13.5,
};
