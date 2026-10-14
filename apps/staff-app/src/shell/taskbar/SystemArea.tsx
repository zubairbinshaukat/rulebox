import type { CSSProperties, ReactNode } from "react";
import type { NetworkDto } from "@rulebox/types";
import IconBatteryCharge from "~icons/solar/battery-charge-bold-duotone";
import IconBatteryFull from "~icons/solar/battery-full-bold-duotone";
import IconBatteryHalf from "~icons/solar/battery-half-bold-duotone";
import IconBatteryLow from "~icons/solar/battery-low-bold-duotone";
import IconVolumeCross from "~icons/solar/volume-cross-bold-duotone";
import IconVolumeLoud from "~icons/solar/volume-loud-bold-duotone";
import IconVolumeSmall from "~icons/solar/volume-small-bold-duotone";
import IconWifiHigh from "~icons/solar/wi-fi-high-bold-duotone";
import IconWifiLow from "~icons/solar/wi-fi-low-bold-duotone";
import IconWifiOff from "~icons/solar/wi-fi-off-bold-duotone";

import { useShell } from "../../lib/store";
import { anchorOf, call, isTauri } from "../../lib/tauri";

/** Network, volume and battery. One button opens quick settings. */
export function SystemArea() {
  const volume = useShell((s) => s.system.volume);
  const battery = useShell((s) => s.system.battery);
  const network = useShell((s) => s.system.network);

  const open = (element: Element) => {
    if (!isTauri()) {
      return;
    }
    void call("popup_open", {
      kind: "quickSettings",
      anchor: anchorOf(element),
    });
  };

  return (
    <button
      type="button"
      className="rb-task"
      aria-label="Quick settings"
      title="Quick settings"
      style={{ width: "auto", padding: "0 8px", gap: 6 }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => open(event.currentTarget)}
    >
      <IconBox>{networkIcon(network)}</IconBox>
      <IconBox>{volumeIcon(volume?.muted ?? false, volume?.level ?? 0)}</IconBox>
      {battery ? <IconBox>{batteryIcon(battery.charging, battery.percent)}</IconBox> : null}
    </button>
  );
}

function IconBox({ children }: { children: ReactNode }) {
  return <span style={icon}>{children}</span>;
}

const icon: CSSProperties = {
  display: "inline-flex",
  color: "var(--rb-ink)",
};

function networkIcon(network: NetworkDto) {
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

function volumeIcon(muted: boolean, level: number) {
  if (muted || level <= 0) {
    return <IconVolumeCross width={20} height={20} />;
  }
  if (level < 0.4) {
    return <IconVolumeSmall width={20} height={20} />;
  }
  return <IconVolumeLoud width={20} height={20} />;
}

function batteryIcon(charging: boolean, percent: number | null) {
  if (charging) {
    return <IconBatteryCharge width={20} height={20} />;
  }
  if (percent != null && percent < 20) {
    return <IconBatteryLow width={20} height={20} />;
  }
  if (percent != null && percent < 50) {
    return <IconBatteryHalf width={20} height={20} />;
  }
  return <IconBatteryFull width={20} height={20} />;
}
