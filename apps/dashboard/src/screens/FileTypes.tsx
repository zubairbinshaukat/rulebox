import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, Input, Select } from "@rulebox/ui";
import IconDoc from "~icons/solar/document-text-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import { useFileTypesScreen, useRemoveFileHandler, useSetFileHandler } from "../data";
import type { AppOption, FileTypesScreen } from "../data/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { useCan } from "../lib/member";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../lib/toast";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";

const s = strings.fileTypes;
type Row = FileTypesScreen["rows"][number];

/** `fileHandlers:list`: extension → app. Executables and scripts can never be added (PRD 7.3). */
export default function FileTypes() {
  const screen = useFileTypesScreen();
  const canAct = useCan("admin");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Row | null>(null);
  const remove = useRemoveFileHandler();
  const toast = useToast();

  const cols = useMemo<Column<Row>[]>(
    () => [
      { key: "ext", header: s.colExtension, primary: true, cell: (r) => <span className="dash-chip dash-mono">{r.extension}</span> },
      {
        key: "app",
        header: s.colApp,
        cell: (r) => (
          <Link className="dash-link dash-truncate" to={`/apps/${r.appId}`}>
            {r.appName}
          </Link>
        ),
      },
      ...(canAct
        ? [
            {
              key: "act",
              header: strings.common.actions,
              actions: true,
              cell: (r: Row) => (
                <Button variant="danger-ghost" className="dash-btn--sm" aria-label={`${strings.common.remove} ${r.extension}`} onClick={() => setRemoving(r)}>
                  {strings.common.remove}
                </Button>
              ),
            },
          ]
        : []),
    ],
    [canAct],
  );

  const add = (
    <RoleGate minRole="admin">
      <Button onClick={() => setAdding(true)}>
        <IconAdd aria-hidden="true" />
        {s.add}
      </Button>
    </RoleGate>
  );

  return (
    <div className="dash-page">
      <PageHeader title={s.title} lead={s.lead} actions={add} />
      <Card body="none">
        <QueryRegion state={screen} skeleton={<SkeletonRows rows={5} columns={2} />}>
          {(data) => (
            <>
              {data.rows.length === 0 ? (
                <EmptyState icon={<IconDoc />} title={s.emptyTitle} body={s.emptyBody} action={add} />
              ) : (
                <DataTable caption={s.title} columns={cols} rows={data.rows} getKey={(r) => r._id} />
              )}
              {adding ? <AddDialog options={data.appOptions} onClose={() => setAdding(false)} /> : null}
            </>
          )}
        </QueryRegion>
      </Card>
      <ConfirmDialog
        open={removing !== null}
        title={s.removeTitle(removing?.extension ?? "")}
        body={s.removeBody}
        confirmLabel={strings.common.remove}
        danger
        onConfirm={() => remove({ handlerId: removing!._id })}
        onDone={() => toast(s.removed(removing?.extension ?? ""))}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

function AddDialog({ options, onClose }: { options: AppOption[]; onClose: () => void }) {
  const set = useSetFileHandler();
  const toast = useToast();
  const f = useForm({ extension: "", appId: options[0]?._id ?? "" }, (x) => ({
    extension: v.extension(x.extension) ?? undefined,
    appId: x.appId ? undefined : strings.validate.required,
  }));
  return (
    <Modal
      open
      title={s.addTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          const ext = v.normalizeExtension(x.extension);
          await set({ extension: ext, appId: x.appId });
          toast(s.added(ext));
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending || options.length === 0} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : strings.common.add}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        {options.length === 0 ? <InlineNotice tone="warning" title={s.noApps} /> : null}
        <Field label={s.extension} hint={s.extensionHint} error={f.errors.extension} required>
          {(p) => (
            <Input {...p} className="dash-mono" autoComplete="off" spellCheck={false} autoCapitalize="off" maxLength={12} value={f.values.extension} onChange={(e) => f.set("extension", e.target.value)} style={{ maxWidth: 200 }} />
          )}
        </Field>
        <Field label={s.app} hint={s.appHint} error={f.errors.appId} required>
          {(p) => (
            <Select {...p} value={f.values.appId} onChange={(e) => f.set("appId", e.target.value)} disabled={options.length === 0}>
              {options.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}
