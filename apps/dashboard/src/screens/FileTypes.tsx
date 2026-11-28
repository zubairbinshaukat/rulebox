import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Input, NativeSelect } from "@rulebox/ui";
import IconDoc from "~icons/solar/document-text-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import { useAppOptions, useRemoveFileHandler, useSetFileHandler } from "../data";
import { useFileTypesPage } from "../data/apps";
import { useAdoptedTotal } from "../data/serverList";
import type { AppOption, FileTypeRow } from "../data/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { RegionError } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { ServerTable } from "../components/ServerTable";
import { SkeletonBlock } from "../components/Skeleton";
import { useCan } from "../lib/member";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { useToast } from "../lib/toast";
import { strings } from "../lib/strings";
import { fileTypesStrings } from "../lib/screenStrings/fileTypes";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";

const s = fileTypesStrings;

/** `fileHandlers:page` sort keys; the first is the default (A to Z). A bounded table: offset cursors, exact total inside the page. */
const LIST: ListConfig = { sorts: ["extension", "app"], defaultSort: { key: "extension", dir: "asc" } };

/** File types: extension → app, one page at a time. Executables and scripts can never be added (PRD 7.3). */
export default function FileTypes() {
  const navigate = useNavigate();
  const view = useListView(LIST);
  const [total, adoptTotal] = useAdoptedTotal();
  const paging = useListPaging(view, { total, offset: true });
  const rules = useFileTypesPage(paging.query);
  adoptTotal(rules);
  const canAct = useCan("admin");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<FileTypeRow | null>(null);
  const remove = useRemoveFileHandler();
  const toast = useToast();

  const cols = useMemo<Column<FileTypeRow>[]>(
    () => [
      { key: "extension", header: s.colExtension, primary: true, sortable: true, cell: (r) => <span className="dash-chip dash-mono">{r.extension}</span> },
      {
        key: "app",
        header: s.colApp,
        sortable: true,
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
              cell: (r: FileTypeRow) => (
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
      <ServerTable<FileTypeRow>
        framed
        caption={s.title}
        columns={cols}
        getKey={(r) => r._id}
        paging={paging}
        list={rules}
        total={total}
        search={{ label: s.searchLabel, placeholder: s.searchPlaceholder }}
        onRowClick={(r) => navigate(`/apps/${r.appId}`)}
        empty={<EmptyState icon={<IconDoc />} title={s.emptyTitle} body={s.emptyBody} action={add} />}
      />
      {adding ? <AddDialog onClose={() => setAdding(false)} /> : null}
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

/** The program picker is `apps:options`, subscribed only while this dialog is open. */
function AddDialog({ onClose }: { onClose: () => void }) {
  const apps = useAppOptions();
  if (apps.status !== "ready") {
    return (
      <Modal
        open
        title={s.addTitle}
        onClose={onClose}
        actions={
          <Button variant="ghost" onClick={onClose}>
            {strings.common.cancel}
          </Button>
        }
      >
        {apps.status === "loading" ? <SkeletonBlock lines={3} /> : <RegionError error={apps.error} onRetry={apps.retry} />}
      </Modal>
    );
  }
  // `apps:options` lists every active app with a `canOpenFiles` flag; only programs that can open files are offered.
  return <AddForm options={apps.data.filter((a) => a.canOpenFiles)} onClose={onClose} />;
}

function AddForm({ options, onClose }: { options: AppOption[]; onClose: () => void }) {
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
            <NativeSelect {...p} value={f.values.appId} onChange={(e) => f.set("appId", e.target.value)} disabled={options.length === 0}>
              {options.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}
