import type { Id } from "../../data/types";
import { HistoryPanel } from "../../components/HistoryPanel";
import { groupPage as t } from "./strings";

/** The Activity tab: what happened to this group (the audit history, one page at a time). Subscribes only while it is open. */
export default function ActivityTab({ groupId }: { groupId: Id }) {
  return <HistoryPanel targetId={groupId} title={t.historyTitle} />;
}
