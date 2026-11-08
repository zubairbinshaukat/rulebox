import type { ShellHealth } from "../../data/types";

export const shellHealthStrings = {
  notRunning: "Not running",
  starting: "Starting",
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  failed: "Failed",
  unknown: "Unknown",
} as const satisfies Record<ShellHealth, string>;
