export type StorageStatus = "normal" | "warning" | "strongWarning" | "blocked";

export interface StorageThresholdResult {
  pct: number;
  status: StorageStatus;
  tone: "accent" | "warning" | "danger";
  detail: string;
  actionText: string | null;
  banner: string | null;
  isBlocked: boolean;
}

/** Format a byte count nicely (e.g. "6.2 GB", "850 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const clampedIndex = Math.min(i, units.length - 1);
  const value = bytes / Math.pow(1024, clampedIndex);
  // If value is a round number or in bytes, don't show decimal
  if (clampedIndex === 0 || value % 1 === 0) {
    return `${value} ${units[clampedIndex]}`;
  }
  // Format with at most 1 decimal place
  return `${value.toFixed(1).replace(/\.0$/, "")} ${units[clampedIndex]}`;
}

export function formatStorageDetail(used: number, limit: number): string {
  if (limit <= 0) {
    return `${formatBytes(used)} used`;
  }
  return `${formatBytes(used)} of ${formatBytes(limit)}`;
}

/**
 * Computes storage status and messages from used and limit bytes according
 * to Section 7.8 thresholds (80%, 95%, 100%).
 */
export function getStorageThreshold(
  used: number,
  limit: number,
): StorageThresholdResult {
  const detail = formatStorageDetail(used, limit);

  if (limit <= 0) {
    return {
      pct: 0,
      status: "normal",
      tone: "accent",
      detail,
      actionText: null,
      banner: null,
      isBlocked: false,
    };
  }

  const rawPct = (used / limit) * 100;
  const pct = Math.min(Math.max(0, rawPct), 100);

  if (rawPct < 80) {
    return {
      pct,
      status: "normal",
      tone: "accent",
      detail,
      actionText: null,
      banner: null,
      isBlocked: false,
    };
  }

  if (rawPct < 95) {
    return {
      pct,
      status: "warning",
      tone: "warning",
      detail,
      actionText: "Free up space",
      banner: null,
      isBlocked: false,
    };
  }

  if (rawPct < 100) {
    return {
      pct,
      status: "strongWarning",
      tone: "danger",
      detail,
      actionText: "Free up space",
      banner: null,
      isBlocked: false,
    };
  }

  return {
    pct,
    status: "blocked",
    tone: "danger",
    detail,
    actionText: "Free up space",
    banner: "Storage is full. Delete files to save new ones.",
    isBlocked: true,
  };
}
