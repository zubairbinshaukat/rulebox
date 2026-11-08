import { installStrings } from "./screenStrings/install";

/** The fixed sentence for an install failure detail code (never raw server text). */
export function installDetail(detail?: string): string {
  if (!detail) return installStrings.detailFallback;
  return installStrings.details[detail] ?? installStrings.detailFallback;
}