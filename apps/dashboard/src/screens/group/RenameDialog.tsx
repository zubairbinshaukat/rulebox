import { useState } from "react";
import { Button, Input, Textarea } from "@rulebox/ui";
import { useUpdateGroup } from "../../data";
import type { GroupDetail } from "../../data/types";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { groupsStrings } from "../../lib/screenStrings/groups";
import { strings } from "../../lib/strings";
import { useForm } from "../../lib/useForm";
import { useToast } from "../../lib/toast";
import * as v from "../../lib/validate";
import { groupFieldError } from "../groups/errors";
import { groupPage as t } from "./strings";

/** Rename / describe with the loaded revision; `stale_edit` offers Reload (the latest values, nothing kept). */
export function RenameDialog({ g, onClose }: { g: GroupDetail; onClose: () => void }) {
  const update = useUpdateGroup();
  const toast = useToast();
  const [revision, setRevision] = useState(g.revision);
  const f = useForm({ name: g.name, description: g.description ?? "" }, (x) => ({
    name: v.name(x.name, v.NAME_MAX.group) ?? undefined,
    description: v.description(x.description, v.NAME_MAX.description) ?? undefined,
  }));
  return (
    <Modal
      open
      title={t.renameTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          // "" clears the description; the server treats a missing one as "unchanged".
          await update({ groupId: g._id, expectedRevision: revision, name: x.name.trim(), description: x.description.trim() });
          toast(t.saved);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : strings.common.save}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={groupsStrings.name} error={f.errors.name ?? groupFieldError(f.serverError, "name")} required>
          {(p) => <Input {...p} value={f.values.name} onChange={(e) => f.set("name", e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={groupsStrings.description} error={f.errors.description ?? groupFieldError(f.serverError, "description")} optional>
          {(p) => <Textarea {...p} rows={3} value={f.values.description} onChange={(e) => f.set("description", e.target.value)} />}
        </Field>
        <FormError
          error={f.serverError}
          fields={["name", "description"]}
          onReload={() => {
            f.reset({ name: g.name, description: g.description ?? "" });
            setRevision(g.revision);
          }}
        />
      </div>
    </Modal>
  );
}
