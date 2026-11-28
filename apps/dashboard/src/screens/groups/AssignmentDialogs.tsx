import { useMemo, useState } from "react";
import { Button, SearchSelect } from "@rulebox/ui";
import IconEveryone from "~icons/solar/users-group-rounded-linear";
import IconChosen from "~icons/solar/user-check-rounded-linear";
import IconTaskbar from "~icons/solar/align-bottom-linear";
import IconDesktop from "~icons/solar/monitor-linear";
import { useAppOptions, useAssignApp, useUpdateAssignment } from "../../data";
import type { AppOption, AssignmentRow, Audience } from "../../data/types";
import { appSelectOptions } from "../../components/appOptions";
import { ChoiceCards } from "../../components/ChoiceCards";
import { Field, FieldSet } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { ToggleChip } from "../../components/ToggleChip";
import { useToast } from "../../lib/toast";
import { strings } from "../../lib/strings";
import { groupStrings } from "../../lib/screenStrings/group";
import { useForm } from "../../lib/useForm";
import { assignmentErrorMessage } from "./errors";
import { groupText } from "./strings";

const s = groupStrings;

type Fields = { audience: Audience; pinnedTaskbar: boolean; pinnedDesktop: boolean };

const AUDIENCE_OPTIONS = [
  { value: "everyone" as const, label: groupText.audienceCards.everyone, art: <IconEveryone /> },
  { value: "selected" as const, label: groupText.audienceCards.selected, art: <IconChosen /> },
];

/** Audience and pins: the part of both dialogs that edits an assignment. */
function AssignmentFields({ values, onChange }: { values: Fields; onChange: (next: Fields) => void }) {
  return (
    <>
      <FieldSet legend={s.audience} info={groupText.audienceInfo} infoLabel={groupText.audienceInfoLabel}>
        <ChoiceCards<Audience> aria-label={s.audience} columns={2} value={values.audience} onChange={(audience) => onChange({ ...values, audience })} options={AUDIENCE_OPTIONS} />
      </FieldSet>
      <FieldSet legend={groupText.pinsLegend}>
        <div className="dash-tchips">
          <ToggleChip icon={<IconTaskbar />} pressed={values.pinnedTaskbar} onToggle={() => onChange({ ...values, pinnedTaskbar: !values.pinnedTaskbar })}>
            {groupText.pinTaskbar}
          </ToggleChip>
          <ToggleChip icon={<IconDesktop />} pressed={values.pinnedDesktop} onToggle={() => onChange({ ...values, pinnedDesktop: !values.pinnedDesktop })}>
            {groupText.pinDesktop}
          </ToggleChip>
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

function AssignForm({ groupId, apps, onClose }: { groupId: string; apps: AppOption[]; onClose: () => void }) {
  const assign = useAssignApp();
  const toast = useToast();
  // Nothing is chosen for them, unless there is only one app to choose from.
  const [initial] = useState(() => ({ appId: apps.length === 1 ? apps[0]!._id : "", audience: "everyone" as Audience, pinnedTaskbar: false, pinnedDesktop: true }));
  const f = useForm(initial, (x) => ({ appId: x.appId ? undefined : strings.validate.required }));
  const appOptions = useMemo(() => appSelectOptions(apps), [apps]);
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
            <SearchSelect
              {...p}
              value={f.values.appId}
              onChange={(id) => f.set("appId", id)}
              options={appOptions}
              placeholder={groupText.appPlaceholder}
              searchPlaceholder={groupText.appSearch}
              emptyText={groupText.appNoMatch}
              disabled={apps.length === 0}
            />
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
