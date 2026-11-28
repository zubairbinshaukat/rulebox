import type { AppDetail } from "../../../data/types";
import { HistoryPanel } from "../../../components/HistoryPanel";
import { appEditStrings as s } from "../../../lib/screenStrings/appEdit";

/** "Activity": the audit history of the app. Its query starts only when the tab is open. */
export default function ActivityTab({ d }: { d: AppDetail }) {
  return <HistoryPanel targetId={d._id} title={s.history} />;
}
