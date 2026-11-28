import { usePromoteAll, useSetRolloutEnabled } from "../../data";
import type { RolloutRow, RolloutView } from "../../data/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../lib/toast";
import { FirstPcsDialog } from "./FirstPcsDialog";
import { RollbackDialog } from "./RollbackDialog";
import { rolloutErrorMessage, rolloutStrings as s } from "./strings";

/** The dialogs of the rollout page, one at a time: which PCs go first (Turn on), send to everyone now, turn off, and undo the last change. */
export type RolloutDialog = "first" | "everyone" | "off" | "undo";

export function RolloutDialogs({
  dialog,
  groupId,
  rollout,
  view,
  onClose,
}: {
  dialog: RolloutDialog | null;
  groupId: string;
  rollout: RolloutRow;
  view: RolloutView;
  onClose: () => void;
}) {
  const promoteAll = usePromoteAll();
  const setEnabled = useSetRolloutEnabled();
  const toast = useToast();
  return (
    <>
      <FirstPcsDialog open={dialog === "first"} groupId={groupId} rollout={rollout} view={view} onClose={onClose} />
      <ConfirmDialog
        open={dialog === "everyone"}
        title={s.sendEveryoneTitle}
        body={s.sendEveryoneBody}
        confirmLabel={s.sendEveryoneConfirm}
        onConfirm={() => promoteAll({ groupId, expectedRevision: rollout.revision })}
        onDone={() => toast(s.sentToast)}
        onClose={onClose}
        describeError={(e) => rolloutErrorMessage(e)}
      />
      <ConfirmDialog
        open={dialog === "off"}
        title={s.turnOffTitle}
        body={s.turnOffBody}
        confirmLabel={s.turnOffConfirm}
        onConfirm={() => setEnabled({ groupId, enabled: false, expectedRevision: rollout.revision })}
        onDone={() => toast(s.turnedOffToast)}
        onClose={onClose}
        describeError={(e) => rolloutErrorMessage(e)}
      />
      <RollbackDialog open={dialog === "undo"} groupId={groupId} rollout={rollout} versions={view.versions} onClose={onClose} />
    </>
  );
}
