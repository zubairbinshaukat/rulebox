import { lazy, Suspense } from "react";
import { useUnassignApp } from "../../data";
import type { AssignmentRow, GroupDetail } from "../../data/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { groupStrings } from "../../lib/screenStrings/group";
import { useToast } from "../../lib/toast";
import { groupText } from "../groups/strings";

// The assign and edit dialogs load when one is opened (they bring the app picker's code with them).
const AssignAppDialog = lazy(() => import("../groups/AssignmentDialogs").then((m) => ({ default: m.AssignAppDialog })));
const EditAssignmentDialog = lazy(() => import("../groups/AssignmentDialogs").then((m) => ({ default: m.EditAssignmentDialog })));

/** Which assignment dialog is open: assign a new app, change one, or ask before taking one away. */
export type AssignmentDialog = { kind: "assign" } | { kind: "edit"; assignment: AssignmentRow } | { kind: "unassign"; assignment: AssignmentRow };

/**
 * The three questions about a group's apps, in one place because three parts of the page open them (the header's Assign app, the
 * apps list's row buttons, a "needs attention" card). Every change rebuilds the group's PCs' documents (the server's job).
 */
export function AssignmentHost({ g, dialog, onClose }: { g: GroupDetail; dialog: AssignmentDialog | null; onClose: () => void }) {
  const unassign = useUnassignApp();
  const toast = useToast();
  const removing = dialog?.kind === "unassign" ? dialog.assignment : null;
  return (
    <>
      <Suspense fallback={null}>
        {dialog?.kind === "assign" ? <AssignAppDialog groupId={g._id} assignedAppIds={g.assignments.map((a) => a.appId)} onClose={onClose} /> : null}
        {dialog?.kind === "edit" ? <EditAssignmentDialog key={dialog.assignment._id} assignment={dialog.assignment} onClose={onClose} /> : null}
      </Suspense>
      <ConfirmDialog
        open={removing !== null}
        title={groupStrings.unassignTitle(removing?.appName ?? "")}
        body={groupStrings.unassignBody}
        confirmLabel={groupStrings.unassign}
        danger
        onConfirm={() => unassign({ assignmentId: removing!._id })}
        onDone={() => toast(groupText.unassigned(removing?.appName ?? ""))}
        onClose={onClose}
      />
    </>
  );
}
