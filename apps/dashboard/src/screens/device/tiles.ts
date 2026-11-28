import type { DevicePage, LayerName } from "../../data/types";
import { LAYER_NAMES } from "../../data/types";
import { formatGb, formatRelative } from "../../lib/format";
import { diskFreeGb, memoryMb, memoryText } from "./format";
import type { ProblemTab } from "./problems";
import { deviceText as t } from "./strings";

/**
 * The four (five on a wide screen) numbers at the top of the Overview: is it up to date, is the lockdown working, did the apps
 * install, is there room on the disk. Pure, so the words and tones are unit-tested without the page.
 */
export type TileTone = "ok" | "warn" | "danger" | "neutral";

export interface Tile {
  id: "settings" | "protection" | "apps" | "disk" | "memory";
  label: string;
  value: string;
  sub?: string;
  tone: TileTone;
  /** The tab a click opens: only a tile with something to look at links. */
  tab?: ProblemTab;
  /** The (i) text of the label. */
  info?: string;
  /** Wide screens only (the fifth tile). */
  wide?: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const LOW_DISK_GB = 2;

function protectionOf(d: DevicePage): Pick<Tile, "value" | "tone" | "sub"> {
  const apply = d.apply;
  if (apply === null) {
    if (d.lockdownCapable === false) return { value: t.tile.notApplied, tone: "warn", sub: t.tile.needsNewerRulebox };
    return { value: t.tile.notReported, tone: "neutral" };
  }
  if (apply.state === "refused" || apply.state === "failed" || apply.state === "rolledBack") return { value: t.tile.notApplied, tone: "danger" };
  const trouble = LAYER_NAMES.some((name: LayerName) => apply.layers[name].state === "failed" || apply.layers[name].state === "partial");
  if (apply.state === "partial" || trouble) return { value: t.tile.partly, tone: "warn" };
  return { value: t.tile.working, tone: "ok" };
}

export function overviewTiles(d: DevicePage, now: number): Tile[] {
  const report = d.report;
  const silent = report === null && d.apply === null;
  const dash = (id: Tile["id"], label: string, extra: Partial<Tile> = {}): Tile => ({ id, label, value: t.tile.none, tone: "neutral", ...extra });
  // A PC that is off shows what it last said; say how old that is once it is more than an hour.
  const lastKnown =
    !d.presence.online && report !== null && now - report.updatedAt > HOUR_MS ? t.tile.lastKnown(formatRelative(report.updatedAt, now)) : undefined;

  // ---- settings
  let settings: Tile;
  if (silent) settings = dash("settings", t.tile.settings, { info: t.tile.infoSettings });
  else if (d.latestVersion === null) settings = { id: "settings", label: t.tile.settings, value: t.tile.notSent, tone: "neutral", info: t.tile.infoSettings };
  else if (report?.appliedVersion === d.latestVersion) {
    settings = { id: "settings", label: t.tile.settings, value: t.tile.upToDate, tone: "ok", sub: lastKnown, info: t.tile.infoSettings };
  } else {
    settings = {
      id: "settings",
      label: t.tile.settings,
      value: t.tile.updating,
      tone: "neutral",
      sub: d.presence.online ? t.tile.arrivesSoon : t.tile.arrivesLater,
      info: t.tile.infoSettings,
    };
  }

  // ---- protection
  const protection: Tile = silent
    ? dash("protection", t.tile.protection, { info: t.tile.infoProtection })
    : { id: "protection", label: t.tile.protection, ...protectionOf(d), info: t.tile.infoProtection };
  if (!silent && protection.tone !== "ok" && protection.tone !== "neutral") protection.tab = "protection";
  if (!silent && protection.sub === undefined) protection.sub = lastKnown;

  // ---- apps
  const failed = d.failedInstalls;
  const apps: Tile = silent
    ? dash("apps", t.tile.apps)
    : failed.count > 0
      ? { id: "apps", label: t.tile.apps, value: t.tile.failed(failed.count, failed.more), tone: "warn", tab: "apps" }
      : { id: "apps", label: t.tile.apps, value: t.tile.noFailures, tone: "ok", sub: lastKnown };

  // ---- disk and memory
  const free = diskFreeGb(report);
  const lowDisk = free !== undefined && (free < LOW_DISK_GB || report?.compat?.warnings.includes("low_disk") === true);
  const disk: Tile =
    free === undefined
      ? dash("disk", t.tile.disk, { info: t.tile.infoDisk })
      : { id: "disk", label: t.tile.disk, value: formatGb(free), tone: lowDisk ? "warn" : "neutral", sub: lowDisk ? t.tile.lowDisk : lastKnown, info: t.tile.infoDisk };
  const ram = memoryText(memoryMb(report));
  const memory: Tile =
    ram === null
      ? { ...dash("memory", t.tile.memory), wide: true }
      : { id: "memory", label: t.tile.memory, value: ram, tone: "neutral", sub: report?.compat?.liteMode ? t.tile.lite : undefined, wide: true };

  return [settings, protection, apps, disk, memory];
}
