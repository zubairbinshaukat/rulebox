import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, InfoTip, Input, SearchSelect } from "@rulebox/ui";
import IconDoc from "~icons/solar/document-text-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import { useAppOptions, useRemoveFileHandler, useSetFileHandler, useSetFileHandlers } from "../data";
import { useFileTypesPage } from "../data/apps";
import { useAdoptedTotal } from "../data/serverList";
import type { AppOption, FileTypeRow } from "../data/types";
import { appSelectOptions } from "../components/appOptions";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { Column, RowAction } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Field, FieldSet } from "../components/Field";
import { FormError } from "../components/FormError";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { RegionError } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { ServerTable } from "../components/ServerTable";
import { SkeletonBlock } from "../components/Skeleton";
import { ToggleChip } from "../components/ToggleChip";
import { useCan } from "../lib/member";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { useToast } from "../lib/toast";
import { strings } from "../lib/strings";
import { FILE_KINDS, fileTypesStrings } from "../lib/screenStrings/fileTypes";
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

  const cols = useMemo<Column<FileTypeRow>[]>(() => {
    const actionsOf = (r: FileTypeRow): RowAction[] => (canAct ? [{ label: strings.common.remove, onSelect: () => setRemoving(r) }] : []);
    return [
      { key: "extension", header: s.colExtension, primary: true, type: "mono", sortable: true, cell: (r) => <span className="dash-chip dash-mono">{r.extension}</span> },
      {
        key: "app",
        header: s.colApp,
        type: "name",
        maxWidth: 260,
        sortable: true,
        card: "fact",
        cardWide: true,
        cell: (r) => (
          <Link className="dash-link" to={`/apps/${r.appId}`}>
            {r.appName}
          </Link>
        ),
      },
      ...(canAct ? [{ key: "act", header: strings.common.actions, actions: true, rowActions: actionsOf, cell: () => null }] : []),
    ];
  }, [canAct]);

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
      <PageHeader
        title={s.title}
        lead={
          <>
            {s.lead} <InfoTip label={s.leadInfoLabel}>{s.leadInfo}</InfoTip>
          </>
        }
        actions={add}
      />
      <ServerTable<FileTypeRow>
        framed
        caption={s.title}
        columns={cols}
        getKey={(r) => r._id}
        rowLabel={(r) => r.extension}
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

/** `fileHandlers:setMany` takes at most this many extensions in one call. */
const MAX_PER_CALL = 20;
/** The "Adds ..." line names this many extensions, then "and N more". */
const SHOWN = 8;

function AddForm({ options, onClose }: { options: AppOption[]; onClose: () => void }) {
  const set = useSetFileHandler();
  const setMany = useSetFileHandlers();
  const toast = useToast();
  const appOptions = useMemo(() => appSelectOptions(options), [options]);
  // Nothing is chosen for them, unless there is only one program to choose from.
  const f = useForm({ kinds: [] as string[], other: false, extension: "", appId: options.length === 1 ? options[0]!._id : "" }, (x) => {
    const typed = x.other ? x.extension.trim() : "";
    return {
      kinds: x.kinds.length === 0 && !x.other ? s.pickOne : undefined,
      // The "Other" box is checked when it holds something, or when it is the only thing chosen.
      extension: x.other && (typed !== "" || x.kinds.length === 0) ? (v.extension(x.extension) ?? undefined) : undefined,
      appId: x.appId ? undefined : strings.validate.required,
    };
  });

  const x = f.values;
  const typed = x.other && x.extension.trim() !== "" ? v.normalizeExtension(x.extension) : null;
  const chosen = FILE_KINDS.filter((k) => x.kinds.includes(k.id)).flatMap((k) => k.extensions as readonly string[]);
  const all = [...new Set([...chosen, ...(typed ? [typed] : [])])];
  const shown = all.length > SHOWN ? `${all.slice(0, SHOWN).join(" ")} …+${all.length - SHOWN}` : all.join(" ");

  const toggleKind = (id: string) => f.set("kinds", x.kinds.includes(id) ? x.kinds.filter((k) => k !== id) : [...x.kinds, id]);

  return (
    <Modal
      open
      title={s.addTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (val) => {
          if (all.length === 1 && chosen.length === 0) {
            // Only "Other": one extension, the same call as before.
            await set({ extension: all[0]!, appId: val.appId });
          } else {
            // One call per 20 extensions: every call is one settings version, so "Pictures" never makes five.
            for (let i = 0; i < all.length; i += MAX_PER_CALL) await setMany({ extensions: all.slice(i, i + MAX_PER_CALL), appId: val.appId });
          }
          toast(all.length === 1 ? s.added(all[0]!) : s.addedMany(all.length));
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
        <FieldSet legend={s.kinds} info={s.kindsInfo} infoLabel={s.kindsInfoLabel} hint={s.moveNote} error={f.errors.kinds}>
          <div className="dash-tchips">
            {FILE_KINDS.map((k) => (
              <ToggleChip key={k.id} pressed={x.kinds.includes(k.id)} onToggle={() => toggleKind(k.id)} title={s.kindTitle(k.label, k.extensions)}>
                {k.label}
              </ToggleChip>
            ))}
            <ToggleChip pressed={x.other} onToggle={() => f.set("other", !x.other)}>
              {s.other}
            </ToggleChip>
          </div>
          {all.length > 0 ? <p className="dash-field__hint dash-mono">{s.willAdd(shown)}</p> : null}
        </FieldSet>
        {x.other ? (
          <Field label={s.extension} hint={s.extensionHint} error={f.errors.extension}>
            {(p) => (
              <Input {...p} className="dash-mono" autoComplete="off" spellCheck={false} autoCapitalize="off" maxLength={12} value={x.extension} onChange={(e) => f.set("extension", e.target.value)} style={{ maxWidth: 200 }} />
            )}
          </Field>
        ) : null}
        <Field label={s.app} info={s.appInfo} infoLabel={s.appInfoLabel} error={f.errors.appId} required>
          {(p) => (
            <SearchSelect
              {...p}
              value={x.appId}
              onChange={(id) => f.set("appId", id)}
              options={appOptions}
              placeholder={s.appPlaceholder}
              searchPlaceholder={s.appSearch}
              emptyText={s.appNoMatch}
              disabled={options.length === 0}
            />
          )}
        </Field>
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}
