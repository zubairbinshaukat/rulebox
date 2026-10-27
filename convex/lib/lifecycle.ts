// Windows servicing end dates (plan Step 7 item 2): `outOfSupport` is computed
// when a device's status is written, from this dated table, so the rule can be
// updated without touching code paths. Dates are the end of the security
// updates of the RELEASE (Microsoft lifecycle pages, recorded from memory on
// 2026-10-27; re-check before relying on a date: unverified).
//
// Tracks by edition id (the agent reports the registry `EditionID`):
// - "consumer": Home (Core*), Pro (Professional*), Pro Education, Pro for
//   Workstations, SE: 24 months for Windows 11.
// - "enterprise": Enterprise, Education, IoT Enterprise (non-LTSC): 36 months.
// - "ltsc": EnterpriseS / IoTEnterpriseS (long-term servicing channel).

export type Track = "consumer" | "enterprise" | "ltsc" | "ltscIot";

type Release = { build: number; ends: Partial<Record<Track, number>> };

const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);

/** Windows 11 releases by build; anything newer than the table is treated as supported. */
const RELEASES: Release[] = [
  { build: 22000, ends: { consumer: d(2023, 10, 10), enterprise: d(2024, 10, 8) } }, // 21H2
  { build: 22621, ends: { consumer: d(2024, 10, 8), enterprise: d(2025, 10, 14) } }, // 22H2
  { build: 22631, ends: { consumer: d(2025, 11, 11), enterprise: d(2026, 11, 10) } }, // 23H2
  {
    build: 26100, // 24H2 (and LTSC 2024)
    ends: { consumer: d(2026, 10, 13), enterprise: d(2027, 10, 12), ltsc: d(2029, 10, 9), ltscIot: d(2034, 10, 10) },
  },
  { build: 26200, ends: { consumer: d(2027, 10, 12), enterprise: d(2028, 10, 10) } }, // 25H2
];

/** Windows 10 (builds below 22000): end of support 2025-10-14, except LTSC releases. */
const WINDOWS_10_END = d(2025, 10, 14);
const WINDOWS_10_LTSC: Release[] = [
  { build: 17763, ends: { ltsc: d(2029, 1, 9), ltscIot: d(2029, 1, 9) } }, // LTSC 2019
  { build: 19044, ends: { ltsc: d(2027, 1, 12), ltscIot: d(2032, 1, 13) } }, // LTSC 2021
];
/** Oldest build Rulebox supports at all (PRD compatibility check). */
const MIN_BUILD = 19045;

export function trackOf(edition: string | undefined): Track {
  const e = (edition ?? "").toLowerCase();
  if (e === "iotenterprises" || e === "iotenterprisesk") return "ltscIot";
  if (e === "enterprises" || e === "enterprisesn") return "ltsc";
  if (e.startsWith("enterprise") || e.startsWith("education") || e.startsWith("iotenterprise")) return "enterprise";
  return "consumer";
}

/** "26100.4351" -> 26100; null when unreadable. */
export function majorBuild(osBuild: string | undefined): number | null {
  if (osBuild === undefined) return null;
  const n = Number.parseInt(osBuild.split(".")[0] ?? "", 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * True when the release behind `osBuild` / `osEdition` no longer gets security
 * updates at `nowMs`. An unknown build reports false (no badge without data).
 */
export function isOutOfSupport(osBuild: string | undefined, osEdition: string | undefined, nowMs: number): boolean {
  const build = majorBuild(osBuild);
  if (build === null) return false;
  const track = trackOf(osEdition);
  if (build < 22000) {
    const ltsc = WINDOWS_10_LTSC.find((r) => r.build === build)?.ends[track];
    if (ltsc !== undefined) return nowMs >= ltsc;
    if (build < MIN_BUILD) return true;
    return nowMs >= WINDOWS_10_END;
  }
  const release = RELEASES.find((r) => r.build === build);
  if (release === undefined) return false; // newer (or Insider) builds
  // LTSC editions on a release without an LTSC date follow the enterprise track.
  const end = release.ends[track] ?? release.ends.enterprise ?? release.ends.consumer;
  return end !== undefined && nowMs >= end;
}
