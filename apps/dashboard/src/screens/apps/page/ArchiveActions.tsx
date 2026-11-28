import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@rulebox/ui";
import IconArchive from "~icons/solar/archive-linear";
import IconTrash from "~icons/solar/trash-bin-trash-linear";
import { useDeleteApp, useSetAppArchived } from "../../../data";
import type { AppDetail } from "../../../data/types";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { RoleGate } from "../../../components/RoleGate";
import { messageFor } from "../../../lib/errors";
import { appEditStrings as s } from "../../../lib/screenStrings/appEdit";
import { strings } from "../../../lib/strings";
import { useToast } from "../../../lib/toast";

/** Archive / Restore / Delete (type the name to confirm). Admin and Owner only. */
export function ArchiveActions({ d }: { d: AppDetail }) {
  const setArchived = useSetAppArchived();
  const del = useDeleteApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null);
  return (
    <RoleGate minRole="admin">
      {d.archived ? (
        <>
          <Button variant="ghost" onClick={() => setArchived({ appId: d._id, archived: false }).catch((e) => toast(messageFor(e), "danger"))}>
            {s.unarchive}
          </Button>
          <Button variant="danger-ghost" onClick={() => setDialog("delete")}>
            <IconTrash aria-hidden="true" />
            {strings.common.delete}
          </Button>
        </>
      ) : (
        <Button variant="danger-ghost" onClick={() => setDialog("archive")}>
          <IconArchive aria-hidden="true" />
          {s.archive}
        </Button>
      )}
      <ConfirmDialog
        open={dialog === "archive"}
        title={s.archiveTitle}
        body={s.archiveBody}
        confirmLabel={s.archive}
        danger
        typeToConfirm={d.name}
        onConfirm={() => setArchived({ appId: d._id, archived: true })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        title={s.deleteTitle}
        body={s.deleteBody}
        confirmLabel={strings.common.delete}
        danger
        typeToConfirm={d.name}
        onConfirm={() => del({ appId: d._id })}
        onDone={() => {
          toast(s.deleted(d.name));
          navigate("/apps?archived=1", { replace: true });
        }}
        onClose={() => setDialog(null)}
      />
    </RoleGate>
  );
}
