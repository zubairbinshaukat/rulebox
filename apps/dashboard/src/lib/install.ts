import { strings } from "./strings";

/** The fixed sentence for an install failure detail code (never raw server text). */
export function installDetail(detail?: string): string {
  if (!detail) return strings.install.detailFallback;
  return strings.install.details[detail] ?? strings.install.detailFallback;
}