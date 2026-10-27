import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Input, Pill, Textarea } from "@rulebox/ui";
import IconPen from "~icons/solar/pen-linear";
import IconTrash from "~icons/solar/trash-bin-trash-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import {
  useAddGroupEmployee,
  useDeleteGroup,
  useDevicesScreen,
  useEmployeesScreen,
  useGroupDetail,
  useRemoveGroupEmployee,
  useUpdateGroup,
} from "../data";
import type { AssignmentRow, DeviceRow, EmployeeRow, GroupDetail as Detail } from "../data/types";
import { AppGlyph } from "../components/AppGlyph";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { KioskCell } from "../components/DeviceCells";
import { EmptyState } from "../components/EmptyState";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { HistoryPanel } from "../components/HistoryPanel";
import { LoadMore } from "../components/LoadMore";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { PagedRegion, QueryRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { useCan } from "../lib/member";
import { SearchInput } from "../components/SearchInput";
import { SkeletonBlock, SkeletonRows } from "../components/Skeleton";
import { useToast } from "../lib/toast";
import { messageFor } from "../lib/errors";
import { strings } from "../lib/strings";
import { useDebounced } from "../lib/useDebounced";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";
import { groupErrorMessage, groupFieldError } from "./groups/errors";
import { groupText } from "./groups/strings";

const s = strings.group;

/**
 * `groups:get` (+ the paginated devices `fleet:list({ groupId })` and
 * employees `employees:list({ groupId })`, which show "Coming in a later
 * step" until Steps 7 and 11). Apps are read-only until Step 10.
 */
export default function GroupDetail() {
  const { id = "" } = useParams();
  const detail = useGroupDetail(id);
  return (
    <div className="dash-page">
      {detail.status !== "ready" ? <PageHeader title={detail.status === "loading" ? strings.app.loading : strings.groups.title} back={{ to: "/groups", label: s.back }} /> : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={5} /></div>}>
        {(g) => <Group g={g} />}
      </QueryRegion>
    </div>
  );
}

function Group({ g }: { g: Detail }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <PageHeader
        back={{ to: "/groups", label: s.back }}
        title={<span className="dash-wrap">{g.name}</span>}
        lead={g.description}
        meta={
          <>
            <Pill>{strings.groups.devices(g.deviceCount)}</Pill>
            <Pill>{strings.groups.employees(g.employeeCount)}</Pill>
          </>
        }
        actions={
          <RoleGate minRole="admin">
            <Button variant="ghost" onClick={() => setEditing(true)}>
              <IconPen aria-hidden="true" />
              {strings.common.edit}
            </Button>
            <Button variant="danger-ghost" onClick={() => setDeleting(true)}>
              <IconTrash aria-hidden="true" />
              {strings.common.delete}
            </Button>
          </RoleGate>
        }
      />
      {editing ? <EditGroup g={g} onClose={() => setEditing(false)} /> : null}
      <DeleteGroup g={g} open={deleting} onClose={() => setDeleting(false)} />

      <Assignments g={g} />
      <div className="dash-grid dash-grid--2">
        <GroupDevices groupId={g._id} />
        <GroupEmployees groupId={g._id} />
      </div>
      <HistoryPanel targetId={g._id} />
    </>
  );
}

/** Rename / describe with the loaded revision; `stale_edit` offers Reload (the latest values, nothing kept). */
function EditGroup({ g, onClose }: { g: Detail; onClose: () => void }) {
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
      title={strings.common.edit}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          // "" clears the description; the server treats a missing one as "unchanged".
          await update({ groupId: g._id, expectedRevision: revision, name: x.name.trim(), description: x.description.trim() });
          toast(s.saved);
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
        <Field label={strings.groups.name} error={f.errors.name ?? groupFieldError(f.serverError, "name")} required>
          {(p) => <Input {...p} value={f.values.name} onChange={(e) => f.set("name", e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={strings.groups.description} error={f.errors.description ?? groupFieldError(f.serverError, "description")} optional>
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

/**
 * Delete (a major action: the step-up dialog may ask first). What this
 * screen already knows blocks it up front; the server's `has_dependents`
 * (which also counts active enrollment codes) is explained the same way.
 */
function DeleteGroup({ g, open, onClose }: { g: Detail; open: boolean; onClose: () => void }) {
  const del = useDeleteGroup();
  const navigate = useNavigate();
  const toast = useToast();
  const known = [g.deviceCount ? "devices" : null, g.employeeCount ? "employees" : null, g.assignments.length ? "apps" : null].filter((x) => x !== null);
  if (open && known.length > 0) {
    return (
      <Modal open title={s.deleteTitle} onClose={onClose} actions={<Button onClick={onClose}>{strings.common.close}</Button>}>
        <InlineNotice tone="warning" title={groupText.hasDependents(known.join(", "))} />
      </Modal>
    );
  }
  return (
    <ConfirmDialog
      open={open}
      title={s.deleteTitle}
      body={groupText.deleteBody}
      confirmLabel={strings.common.delete}
      danger
      typeToConfirm={g.name}
      onConfirm={() => del({ groupId: g._id })}
      describeError={(e) => groupErrorMessage(e)}
      onDone={() => {
        toast(s.deleted(g.name));
        navigate("/groups", { replace: true });
      }}
      onClose={onClose}
    />
  );
}

/** Assigned apps, read-only until Step 10 brings assigning, audiences and pins. */
function Assignments({ g }: { g: Detail }) {
  const canAct = useCan("admin");
  const cols = useMemo<Column<AssignmentRow>[]>(
    () => [
      {
        key: "app",
        header: s.app,
        primary: true,
        cell: (a) => (
          <span className="dash-row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
            <AppGlyph name={a.appName} hue={a.hue} />
            <Link className="dash-link dash-link--plain dash-truncate" to={`/apps/${a.appId}`} title={a.appName}>
              {a.appName}
            </Link>
          </span>
        ),
      },
      { key: "audience", header: s.audience, cell: (a) => (a.audience === "everyone" ? s.audienceEveryone : s.audienceSelected) },
      {
        key: "pins",
        header: s.pins,
        cell: (a) => (
          <span className="dash-pills">
            {a.pinnedTaskbar ? <Pill>{s.pinnedTaskbar}</Pill> : null}
            {a.pinnedDesktop ? <Pill>{s.pinnedDesktop}</Pill> : null}
            {!a.pinnedTaskbar && !a.pinnedDesktop ? <span className="dash-muted">—</span> : null}
          </span>
        ),
      },
    ],
    [],
  );
  return (
    <Card title={s.apps} sub={canAct ? `${s.appsLead} ${groupText.appsReadOnly}` : s.appsLead} body="none">
      <div style={{ paddingTop: 12 }}>
        {g.assignments.length === 0 ? (
          <EmptyState compact title={s.appsNone} />
        ) : (
          <DataTable caption={s.apps} columns={cols} rows={g.assignments} getKey={(a) => a._id} />
        )}
      </div>
    </Card>
  );
}

function GroupDevices({ groupId }: { groupId: string }) {
  const devices = useDevicesScreen({ groupId });
  const cols = useMemo<Column<DeviceRow>[]>(
    () => [
      {
        key: "name",
        header: strings.devices.colName,
        primary: true,
        cell: (d) => (
          <Link className="dash-link dash-link--plain dash-truncate" to={`/devices/${d._id}`} title={d.name}>
            {d.name}
          </Link>
        ),
      },
      { key: "kiosk", header: strings.devices.colKiosk, cell: (d) => <KioskCell row={d} /> },
    ],
    [],
  );
  return (
    <Card title={s.devices} body="none">
      <div style={{ paddingTop: 12 }}>
        <PagedRegion state={devices} skeleton={<SkeletonRows rows={4} columns={2} />}>
          {(p) =>
            p.items.length === 0 ? (
              <EmptyState compact title={s.devicesNone} />
            ) : (
              <>
                <DataTable caption={s.devices} columns={cols} rows={p.items} getKey={(d) => d._id} isDim={(d) => d.revoked} />
                <LoadMore shown={p.items.length} canLoadMore={p.canLoadMore} isLoadingMore={p.isLoadingMore} loadMore={p.loadMore} />
              </>
            )
          }
        </PagedRegion>
      </div>
    </Card>
  );
}

function GroupEmployees({ groupId }: { groupId: string }) {
  const employees = useEmployeesScreen({ groupId });
  const canAct = useCan("admin");
  const remove = useRemoveGroupEmployee();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const ready = employees.status === "ready";
  const cols: Column<EmployeeRow>[] = [
    {
      key: "name",
      header: strings.employees.colName,
      primary: true,
      cell: (e) => (
        <span className="dash-cell-stack">
          <Link className="dash-link dash-link--plain dash-truncate" to={`/employees/${e._id}`} title={e.name}>
            {e.name}
          </Link>
          <span className="dash-cell-sub dash-mono">{e.username}</span>
        </span>
      ),
    },
    ...(canAct
      ? [
          {
            key: "act",
            header: strings.common.actions,
            actions: true,
            cell: (e: EmployeeRow) => (
              <Button
                variant="ghost"
                className="dash-btn--sm"
                aria-label={`${s.removeEmployee}: ${e.name}`}
                onClick={() => remove({ groupId, employeeId: e._id }).catch((err) => toast(messageFor(err), "danger"))}
              >
                {strings.common.remove}
              </Button>
            ),
          },
        ]
      : []),
  ];
  return (
    <Card
      title={s.employees}
      body="none"
      actions={
        ready ? (
          <RoleGate minRole="admin">
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setAdding(true)}>
              <IconAdd aria-hidden="true" />
              {s.addEmployee}
            </Button>
          </RoleGate>
        ) : undefined
      }
    >
      <div style={{ paddingTop: 12 }}>
        <PagedRegion state={employees} skeleton={<SkeletonRows rows={4} columns={2} />}>
          {(p) =>
            p.items.length === 0 ? (
              <EmptyState compact title={s.employeesNone} />
            ) : (
              <>
                <DataTable caption={s.employees} columns={cols} rows={p.items} getKey={(e) => e._id} isDim={(e) => e.disabled} />
                <LoadMore shown={p.items.length} canLoadMore={p.canLoadMore} isLoadingMore={p.isLoadingMore} loadMore={p.loadMore} />
              </>
            )
          }
        </PagedRegion>
      </div>
      {adding ? <AddEmployeeDialog groupId={groupId} onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

function AddEmployeeDialog({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 250);
  const results = useEmployeesScreen({ search: debounced || " " });
  const add = useAddGroupEmployee();
  const toast = useToast();
  const [added, setAdded] = useState<Set<string>>(new Set());
  return (
    <Modal open title={s.addEmployeeTitle} onClose={onClose} wide actions={<Button onClick={onClose}>{strings.common.done}</Button>}>
      <div className="dash-form">
        <SearchInput value={search} onChange={setSearch} label={s.employeeSearch} placeholder={strings.employees.searchPlaceholder} />
        <PagedRegion state={results} skeleton={<SkeletonRows rows={3} columns={1} />}>
          {(p) =>
            !debounced ? null : p.items.length === 0 ? (
              <EmptyState compact title={strings.employees.noMatchTitle} />
            ) : (
              <ul className="dash-list" style={{ maxHeight: 320, overflowY: "auto" }}>
                {p.items.map((e) => {
                  const inGroup = added.has(e._id) || e.groups.some((g) => g._id === groupId);
                  return (
                    <li key={e._id} className="dash-list__item" style={{ paddingInline: 0 }}>
                      <div className="dash-list__body">
                        <p className="dash-list__title dash-truncate">{e.name}</p>
                        <p className="dash-list__meta dash-mono">{e.username}</p>
                      </div>
                      {inGroup ? (
                        <Pill tone="success">{strings.common.done}</Pill>
                      ) : (
                        <Button
                          variant="ghost"
                          className="dash-btn--sm"
                          aria-label={`${strings.common.add}: ${e.name}`}
                          onClick={() =>
                            add({ groupId, employeeId: e._id }).then(
                              () => setAdded((set) => new Set(set).add(e._id)),
                              (err) => toast(messageFor(err), "danger"),
                            )
                          }
                        >
                          {strings.common.add}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )
          }
        </PagedRegion>
      </div>
    </Modal>
  );
}
