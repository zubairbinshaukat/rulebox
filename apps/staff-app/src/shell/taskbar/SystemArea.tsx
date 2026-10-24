import type { BatteryDto, NetworkDto } from "@rulebox/types";
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

/** Network, volume and battery in one chip. It opens quick settings. */
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
      className="rb-chip"
      aria-label={`Quick settings: ${networkLabel(network)}${battery?.percent != null ? `, battery ${battery.percent}%` : ""}`}
      title="Quick settings"
      style={{ padding: "0 14px" }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => open(event.currentTarget)}
    >
      {networkIcon(network)}
      <span className="rb-chip__muted" style={{ display: "inline-flex" }}>
        {volumeIcon(volume?.muted ?? false, volume?.level ?? 0)}
      </span>
      {battery ? <Battery battery={battery} /> : null}
    </button>
  );
}

function Battery({ battery }: { battery: BatteryDto }) {
  const low = battery.percent != null && battery.percent < 20 && !battery.charging;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span className={battery.charging ? "rb-chip__warn" : low ? "rb-chip__bad" : "rb-chip__muted"} style={{ display: "inline-flex" }}>
        {batteryIcon(battery.charging, battery.percent)}
      </span>
      {battery.percent != null ? (
        <span className={low ? "rb-chip__bad" : "rb-chip__good"}>{battery.percent}%</span>
      ) : null}
    </span>
  );
}

function networkLabel(network: NetworkDto): string {
  switch (network) {
    case "internet":
      return "connected";
    case "local":
      return "no internet";
    case "none":
      return "offline";
    default: {
      const unreachable: never = network;
      return unreachable;
    }
  }
}

function networkIcon(network: NetworkDto) {
  switch (network) {
    case "internet":
      return (
        <span className="rb-chip__good" style={{ display: "inline-flex" }}>
          <IconWifiHigh width={18} height={18} />
        </span>
      );
    case "local":
      return (
        <span className="rb-chip__warn" style={{ display: "inline-flex" }}>
          <IconWifiLow width={18} height={18} />
        </span>
      );
    case "none":
      return (
        <span className="rb-chip__muted" style={{ display: "inline-flex" }}>
          <IconWifiOff width={18} height={18} />
        </span>
      );
    default: {
      const unreachable: never = network;
      return unreachable;
    }
  }
}

function volumeIcon(muted: boolean, level: number) {
  if (muted || level <= 0) {
    return <IconVolumeCross width={18} height={18} />;
  }
  if (level < 0.4) {
    return <IconVolumeSmall width={18} height={18} />;
  }
  return <IconVolumeLoud width={18} height={18} />;
}

function batteryIcon(charging: boolean, percent: number | null) {
  if (charging) {
    return <IconBatteryCharge width={18} height={18} />;
  }
  if (percent != null && percent < 20) {
    return <IconBatteryLow width={18} height={18} />;
  }
  if (percent != null && percent < 50) {
    return <IconBatteryHalf width={18} height={18} />;
  }
  return <IconBatteryFull width={18} height={18} />;
}
