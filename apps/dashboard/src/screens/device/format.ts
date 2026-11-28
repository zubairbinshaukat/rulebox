import type { CompatReport, DeviceReport } from "../../data/types";
import { formatGb } from "../../lib/format";
import { deviceText as t } from "./strings";

/**
 * Plain words for what the PC reports (UI pass 2026-11, `docs/plans/ui-pass/device-detail.md` D23): the Windows edition as people
 * know it, memory in whole GB, the browsers found. Pure, so the header, the tiles and the About card say the same thing.
 */

/** `EditionID` as Windows spells it -> the name on the box. An id this does not know is returned as it is. */
export function editionName(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const id = raw.trim();
  if (/^core/i.test(id)) return "Home";
  if (/^professional/i.test(id)) return "Pro";
  if (/^iotenterprise/i.test(id)) return "IoT Enterprise";
  if (/^enterprise/i.test(id)) return "Enterprise";
  if (/^education/i.test(id)) return "Education";
  return id;
}

/** "Windows 11 Home": the reported name plus the edition, without saying the edition twice. null when the PC reported neither. */
export function windowsName(r: DeviceReport | null): string | null {
  if (r === null) return null;
  const build = r.compat?.os.build ?? (r.osBuild !== undefined ? Number.parseInt(r.osBuild, 10) : Number.NaN);
  const base = r.os?.trim() || (Number.isFinite(build) ? (build >= 22000 ? "Windows 11" : "Windows 10") : null);
  if (base === null) return null;
  const edition = editionName(r.osEdition ?? r.compat?.os.editionId);
  if (edition === null || base.toLowerCase().includes(edition.toLowerCase())) return base;
  return `${base} ${edition}`;
}

/** "Windows 11 Home, 24H2" (the feature update when the compatibility report has it). */
export function windowsLine(r: DeviceReport | null): string | null {
  const name = windowsName(r);
  if (name === null) return null;
  const version = r?.compat?.os.displayVersion;
  return version ? `${name}, ${version}` : name;
}

/** The Windows build in full ("26100.4336"), for the technical details. */
export function buildNumber(r: DeviceReport | null): string | null {
  const c = r?.compat?.os;
  if (c) return `${c.build}.${c.ubr}`;
  return r?.osBuild ?? null;
}

/** Memory in whole GB ("4 GB"); 3.8 GB of a "4 GB" PC rounds up, like the box says. */
export function memoryText(ramMb: number | undefined): string | null {
  if (ramMb === undefined || ramMb <= 0) return null;
  return formatGb(Math.max(1, Math.round(ramMb / 1024)));
}

export function memoryMb(r: DeviceReport | null): number | undefined {
  return r?.ramMb ?? r?.compat?.os.ramMb;
}

export function diskFreeGb(r: DeviceReport | null): number | undefined {
  return r?.diskFreeGb ?? r?.compat?.os.systemDiskFreeGb;
}

/** "Edge, Chrome"; null when the agent did not report browsers (an older agent: never a wrong "None"). */
export function browsersText(c: CompatReport | undefined): string | null {
  if (c?.browsers === undefined) return null;
  const found: string[] = [];
  if (c.browsers.edge) found.push(t.browserEdge);
  if (c.browsers.chrome) found.push(t.browserChrome);
  return found.length ? found.join(", ") : t.browsersNone;
}

/** The PC is joined to a company domain or to Entra ID. */
export function isManaged(c: CompatReport | undefined): boolean {
  return c !== undefined && (c.os.domainJoined || c.os.entraJoined);
}
