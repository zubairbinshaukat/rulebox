import type { AuditEntry } from "../data/types";
import { plainSummary } from "../lib/auditText";

/** An audit row's details in plain words. A separate file so `AuditItem` can load the rewording only when a row is on screen. */
export default function PlainSummary({ entry }: { entry: Pick<AuditEntry, "action" | "summary"> }) {
  return <>{plainSummary(entry)}</>;
}
