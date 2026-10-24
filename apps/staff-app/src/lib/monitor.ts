import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MonitorSample } from "@rulebox/types";

import { isTauri } from "./tauri";

// One subscription per window, kept for the window's life, so a monitor that
// opens again shows the last figures at once instead of waiting two seconds.
let latest: MonitorSample | null = null;
let started = false;
const listeners = new Set<(sample: MonitorSample) => void>();

function ensureListening() {
  if (started || !isTauri()) {
    return;
  }
  started = true;
  void listen<MonitorSample>("monitor://sample", (event) => {
    latest = event.payload;
    for (const listener of listeners) {
      listener(event.payload);
    }
  });
}

/**
 * The developer resource monitor's latest sample (debug builds send one every
 * two seconds; release builds never do, so this stays null and nothing shows).
 */
export function useMonitorSample(): MonitorSample | null {
  const [sample, setSample] = useState<MonitorSample | null>(latest);
  useEffect(() => {
    ensureListening();
    listeners.add(setSample);
    return () => {
      listeners.delete(setSample);
    };
  }, []);
  return sample;
}

/** Bytes as MB below a gigabyte, GB from there, one decimal where it helps. */
export function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function formatPercent(percent: number): string {
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}
