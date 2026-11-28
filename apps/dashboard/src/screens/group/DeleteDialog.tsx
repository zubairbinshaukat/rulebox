import { useNavigate } from "react-router";
import { Button } from "@rulebox/ui";
import { useDeleteGroup } from "../../data";
import type { GroupDetail } from "../../data/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { groupErrorMessage } from "../groups/errors";
import { groupText } from "../groups/strings";
import { groupPage as t } from "./strings";

/**
 * Delete (a major action: the step-up dialog may ask first). What this screen already knows blocks it up front; the server's
 * `has_dependents` (which also counts active enrollment codes) is explained the same way.
 */
export function DeleteDialog({ g, onClose }: { g: GroupDetail; onClose: () => void }) {
  const del = useDeleteGroup();
  const navigate = useNavigate();
  const toast = useToast();
  const known = [g.deviceCount ? "devices" : null, g.employeeCount ? "employees" : null, g.assignments.length ? "apps" : null].filter((x) => x !== null);
  if (known.length > 0) {
    return (
      <Modal open title={t.deleteTitle} onClose={onClose} actions={<Button onClick={onClose}>{strings.common.close}</Button>}>
        <InlineNotice tone="warning" title={groupText.hasDependents(known.join(", "))} />
      </Modal>
    );
  }
  return (
    <ConfirmDialog
      open
      title={t.deleteTitle}
      body={groupText.deleteBody}
      confirmLabel={strings.common.delete}
      danger
      typeToConfirm={g.name}
      onConfirm={() => del({ groupId: g._id })}
      describeError={(e) => groupErrorMessage(e)}
      onDone={() => {
        toast(t.deleted(g.name));
        navigate("/groups", { replace: true });
      }}
      onClose={onClose}
    />
  );
}
