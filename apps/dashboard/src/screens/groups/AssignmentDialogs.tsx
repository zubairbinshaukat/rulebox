import { useState } from "react";
import { Button, Checkbox, Select } from "@rulebox/ui";
import { useAppOptions, useAssignApp, useUpdateAssignment } from "../../data";
import type { AssignmentRow, Audience } from "../../data/types";
import { Field, FieldSet } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { useToast } from "../../lib/toast";
import { strings } from "../../lib/strings";
import { groupStrings } from "../../lib/screenStrings/group";
import { useForm } from "../../lib/useForm";
import { assignmentErrorMessage } from "./errors";
import { groupText } from "./strings";

const s = groupStrings;

type Fields = { audience: Audience; pinnedTaskbar: boolean; pinnedDesktop: boolean };

/** Audience and pins: the part of both dialogs that edits an assignment. */
function AssignmentFields({ values, onChange }: { values: Fields; onChange: (next: Fields) => void }) {
  return (
    <>
      <Field label={s.audience} hint={groupText.audienceHint}>
        {(p) => (
          <Select {...p} value={values.audience} onChange={(e) => onChange({ ...values, audience: e.target.value as Audience })}>
            <option value="everyone">{s.audienceEveryone}</option>
            <option value="selected">{s.audienceSelected}</option>
          </Select>
        )}
      </Field>
      <FieldSet legend={s.pins}>
        <div className="dash-checks dash-checks--inline">
          <Checkbox label={s.pinTaskbar} checked={values.pinnedTaskbar} onChange={(e) => onChange({ ...values, pinnedTaskbar: e.target.checked })} />
          <Checkbox label={s.pinDesktop} checked={values.pinnedDesktop} onChange={(e) => onChange({ ...values, pinnedDesktop: e.target.checked })} />
        </div>
      </FieldSet>
    </>
  );
}
/** Give the group an app: pick it, choose who sees it and where it is pinned (`groups:assignApp`). */
export function AssignAppDialog({ groupId, assignedAppIds, onClose }: { groupId: string; assignedAppIds: string[]; onClose: () => void }) {
  // Subscribed only while this dialog is open (`apps:options`, at most 500 apps).
  const options = useAppOptions();
  return (
    <QueryRegion state={options} skeleton={<Modal open title={s.assignTitle} onClose={onClose}><SkeletonBlock lines={4} /></Modal>}>
      {(apps) => (
        <AssignForm
          groupId={groupId}
          apps={apps.filter((a) => !assignedAppIds.includes(a._id))}
          onClose={onClose}
        />
      )}
    </QueryRegion>
  );
}

function AssignForm({ groupId, apps, onClose }: { groupId: string; apps: { _id: string; name: string }[]; onClose: () => void }) {
  const assign = useAssignApp();
  const toast = useToast();
  const [initial] = useState(() => ({ appId: apps[0]?._id ?? "", audience: "everyone" as Audience, pinnedTaskbar: false, pinnedDesktop: true }));
  const f = useForm(initial, (x) => ({ appId: x.appId ? undefined : strings.validate.required }));
  return (
    <Modal
      open
      title={s.assignTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await assign({ groupId, ...x });
          toast(groupText.assigned(apps.find((a) => a._id === x.appId)?.name ?? ""));
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending || apps.length === 0} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : s.assign}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        {apps.length === 0 ? <InlineNotice tone="neutral" title={groupText.noAppsToAssign} /> : null}
        <Field label={s.app} error={f.errors.appId} required>
          {(p) => (
            <Select {...p} value={f.values.appId} onChange={(e) => f.set("appId", e.target.value)} disabled={apps.length === 0}>
              {apps.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <AssignmentFields
          values={f.values}
          onChange={(n) => {
            f.set("audience", n.audience);
            f.set("pinnedTaskbar", n.pinnedTaskbar);
            f.set("pinnedDesktop", n.pinnedDesktop);
          }}
        />
        <FormError error={f.serverError} describe={assignmentErrorMessage} />
      </div>
    </Modal>
  );
}

/** Change who sees an assigned app and where it is pinned (`groups:updateAssignment`). */
export function EditAssignmentDialog({ assignment, onClose }: { assignment: AssignmentRow; onClose: () => void }) {
  const update = useUpdateAssignment();
  const toast = useToast();
  const f = useForm(
    { audience: assignment.audience, pinnedTaskbar: assignment.pinnedTaskbar, pinnedDesktop: assignment.pinnedDesktop },
    () => ({}),
  );
  return (
    <Modal
      open
      title={groupText.editAssignmentTitle(assignment.appName)}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await update({ assignmentId: assignment._id, ...x });
          toast(strings.common.saved);
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
        <AssignmentFields
          values={f.values}
          onChange={(n) => {
            f.set("audience", n.audience);
            f.set("pinnedTaskbar", n.pinnedTaskbar);
            f.set("pinnedDesktop", n.pinnedDesktop);
          }}
        />
        <FormError error={f.serverError} describe={assignmentErrorMessage} />
      </div>
    </Modal>
  );
}
