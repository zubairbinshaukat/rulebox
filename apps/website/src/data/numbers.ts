/*
 * Every number shown on the site. Source: Story §7. A number is shown only
 * through this file, with its kind and source (plan §7.1). The build check
 * (scripts/check-dist.mjs) fails if an entry has no source or a stale date.
 */
import { REPO_URL } from "../config";

export type NumberKind = "PRD" | "MEASURED" | "CITED";

export interface Stat {
  id: string;
  value: string;
  label: string;
  kind: NumberKind;
  source: string;
  sourceUrl: string;
  /** ISO date the source was last checked. */
  checked: string;
  note?: string;
}

const doc = (path: string) => `${REPO_URL}/blob/main/${path}`;

export const NUMBERS: Stat[] = [
  {
    id: "ram",
    value: "4 GB",
    label: "RAM is enough. Built and tested for 4 GB laptops.",
    kind: "PRD",
    source: "PRD 22.1",
    sourceUrl: doc("docs/prd.md"),
    checked: "2026-11-21",
  },
  {
    id: "installer",
    value: "1",
    label: "installer for every PC and every organisation",
    kind: "PRD",
    source: "PRD 9.1, 15",
    sourceUrl: doc("docs/prd.md"),
    checked: "2026-11-21",
  },
  {
    id: "rings",
    value: "3",
    label: "rollout rings: Pilot, Early, Everyone. One-click rollback.",
    kind: "PRD",
    source: "PRD 24.3",
    sourceUrl: doc("docs/prd.md"),
    checked: "2026-11-21",
  },
  {
    id: "escape-checks",
    value: "74",
    label: "escape checks we run against each release",
    kind: "PRD",
    source: "Phase 5 lockdown plan",
    sourceUrl: doc("docs/plans/phase-5-lockdown.md"),
    checked: "2026-11-21",
    note: "Checks we run, not a pass count. Results are published per release.",
  },
  {
    id: "licence",
    value: "MIT",
    label: "licence. Read every line that runs on your PCs.",
    kind: "PRD",
    source: "PRD 21, Decision 9",
    sourceUrl: doc("docs/prd.md"),
    checked: "2026-11-21",
  },
  {
    id: "mem-idle",
    value: "≈ 120 MB",
    label: "memory used with a person signed in, desktop idle",
    kind: "MEASURED",
    source: "Test build, 2026-10-27, Windows 11 Pro, 4 GB VM, Lite mode",
    sourceUrl: doc("docs/plans/phase-3-step17-results.md"),
    checked: "2026-10-27",
    note: "Debug test build. To be re-measured on the release build on a real 4 GB laptop.",
  },
  {
    id: "app-types",
    value: "4",
    label: "app types: winget, web app, MSI/EXE installer, portable EXE",
    kind: "PRD",
    source: "PRD 6",
    sourceUrl: doc("docs/prd.md"),
    checked: "2026-11-21",
  },
  {
    id: "web-permissions",
    value: "8",
    label: "permissions you set per web app",
    kind: "PRD",
    source: "PRD 24.1",
    sourceUrl: doc("docs/prd.md"),
    checked: "2026-11-21",
  },
  {
    id: "staff-admin",
    value: "0",
    label: "admin rights for staff. Not for a second.",
    kind: "PRD",
    source: "PRD 3.2, 12.2",
    sourceUrl: doc("docs/prd.md"),
    checked: "2026-11-21",
  },
  {
    id: "assigned-access",
    value: "Pro and up",
    label: "Windows editions supported by Windows’ own Assigned Access; Home is not listed",
    kind: "CITED",
    source: "Microsoft Learn, Assigned Access overview",
    sourceUrl: "https://learn.microsoft.com/en-us/windows/configuration/assigned-access/overview",
    checked: "2026-11-21",
  },
  {
    id: "win10-eos",
    value: "14 Oct 2025",
    label: "Windows 10 reached end of support",
    kind: "CITED",
    source: "Microsoft Support",
    sourceUrl:
      "https://support.microsoft.com/en-us/windows/windows-10-support-has-ended-on-october-14-2025-2ca8b313-1946-43d3-b55c-2b95b107f281",
    checked: "2026-11-21",
  },
  {
    id: "suite-price",
    value: "$2–$6",
    label: "typical list price per device per month for device-management suites, with 10 or 15 device minimums",
    kind: "CITED",
    source: "Hexnode and Scalefusion pricing pages",
    sourceUrl: "https://scalefusion.com/pricing",
    checked: "2026-11-21",
  },
];

export const STRIP_A = ["ram", "installer", "rings", "escape-checks", "licence"];

export const stat = (id: string): Stat => {
  const s = NUMBERS.find((n) => n.id === id);
  if (!s) throw new Error(`Unknown number id: ${id}`);
  return s;
};
