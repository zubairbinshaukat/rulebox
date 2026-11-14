import { fail } from "./errors";
import { MAX_APPROVED_PRINTER_DRIVERS, MAX_PRINTER_DRIVER } from "./limits";

// The approved printer drivers (Phase 5 Step 14, plan 4.15; changed 2026-11-08, "Approved list = inbox class drivers +
// names the org adds"). Step 14 only names drivers that are already on the PC; the agent never installs one.

/** Windows' own class drivers (plan 4.15 default list). */
export const INBOX_PRINTER_DRIVERS: readonly string[] = [
  "Microsoft IPP Class Driver",
  "Microsoft PCL6 Class Driver",
  "Microsoft PS Class Driver",
  "Generic / Text Only",
];

/** The inbox list followed by the names the organization added (no duplicates, at most MAX_APPROVED_PRINTER_DRIVERS added). */
export function approvedPrinterDrivers(added: readonly string[] | undefined): string[] {
  const out = [...INBOX_PRINTER_DRIVERS];
  for (const name of (added ?? []).slice(0, MAX_APPROVED_PRINTER_DRIVERS)) {
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

/** The driver as the approved list spells it, or `invalid_argument` (field "driver": "empty" | "length" | "not_approved"). */
export function checkPrinterDriver(driver: string, approved: readonly string[]): string {
  const name = driver.trim();
  if (name === "") fail("invalid_argument", { field: "driver", detail: "empty" });
  if (name.length > MAX_PRINTER_DRIVER) fail("invalid_argument", { field: "driver", detail: "length" });
  const hit = approved.find((x) => x.toLowerCase() === name.toLowerCase());
  if (hit === undefined) fail("invalid_argument", { field: "driver", detail: "not_approved" });
  return hit as string;
}
