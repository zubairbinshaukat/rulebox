import type { BatteryDto, NetworkDto } from "@rulebox/types";

/** The battery line in quick settings. Matches the Rust `battery_text` cases. */
export function batteryLine(battery: BatteryDto | null): string | null {
  if (!battery) {
    return null;
  }
  if (battery.charging) {
    return battery.percent == null ? "Charging" : `${battery.percent}% · Charging`;
  }
  if (battery.minutesLeft != null) {
    return `On battery · ${formatMinutes(battery.minutesLeft)}`;
  }
  if (battery.percent != null) {
    return `${battery.percent}% · On battery`;
  }
  return null;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) {
    return `${mins} min left`;
  }
  return `${hours} h ${mins} min left`;
}

export function networkLabel(network: NetworkDto): string {
  switch (network) {
    case "internet":
      return "Connected to the internet";
    case "local":
      return "Connected, no internet";
    case "none":
      return "No network";
    default: {
      const unreachable: never = network;
      return unreachable;
    }
  }
}

/** Milliseconds until the next minute, for the one clock timer. */
export function msUntilNextMinute(date: Date): number {
  return 60_000 - (date.getSeconds() * 1000 + date.getMilliseconds());
}
