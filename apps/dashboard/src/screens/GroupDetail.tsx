import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Checkbox, Input, Pill, Select, Textarea } from "@rulebox/ui";
import IconPen from "~icons/solar/pen-linear";
import IconTrash from "~icons/solar/trash-bin-trash-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import {
  useAddGroupEmployee,
  useAssignApp,
  useDeleteGroup,
  useDevicesScreen,
  useEmployeesScreen,
  useGroupDetail,
  useRemoveGroupEmployee,
  useUnassignApp,
  useUpdateAssignment,
  useUpdateGroup,
} from "../data";
import type { AssignmentRow, Audience, DeviceRow, EmployeeRow, GroupDetail as Detail } from "../data/types";
import { AppGlyph } from "../components/AppGlyph";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { KioskCell } from "../components/DeviceCells";
import { EmptyState } from "../components/EmptyState";
import { Field, FieldSet } from "../components/Field";
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

const s = strings.group;

/** `groups:get` + paginated devices (`fleet:list({ groupId })`) and employees (`employees:list({ groupId })`). */
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

function EditGroup({ g, onClose }: { g: Detail; onClose: () => void }) {
  const update = useUpdateGroup();
  const toast = useToast();
  const [revision, setRevision] = useState(g.revision);
  const f = useForm({ name: g.name, description: g.description ?? "" }, (x) => ({
    name: v.name(x.name, v.NAME_MAX.group) ?? undefined,
    description: v.optionalText(x.description, v.NAME_MAX.description) ?? undefined,
  }));
  return (
    <Modal
      open
      title={strings.common.edit}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await update({ groupId: g._id, expectedRevision: revision, name: x.name.trim(), description: x.description.trim() || undefined });
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
        <Field label={strings.groups.name} error={f.errors.name} required>
          {(p) => <Input {...p} value={f.values.name} onChange={(e) => f.set("name", e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={strings.groups.description} error={f.errors.description} optional>
          {(p) => <Textarea {...p} rows={3} value={f.values.description} onChange={(e) => f.set("description", e.target.value)} />}
        </Field>
        <FormError
          error={f.serverError}
          onReload={() => {
            f.reset({ name: g.name, description: g.description ?? "" });
            setRevision(g.revision);
          }}
        />
      </div>
    </Modal>
  );
}

function DeleteGroup({ g, open, onClose }: { g: Detail; open: boolean; onClose: () => void }) {
  const del = useDeleteGroup();
  const navigate = useNavigate();
  const toast = useToast();
  const blocked = g.deviceCount + g.employeeCount + g.assignments.length + g.enrollmentCodeCount > 0;
  if (open && blocked) {
    return (
      <Modal open title={s.deleteTitle} onClose={onClose} actions={<Button onClick={onClose}>{strings.common.close}</Button>}>
        <InlineNotice tone="warning" title={s.deleteBlocked(g.deviceCount, g.employeeCount, g.assignments.length, g.enrollmentCodeCount)} />
      </Modal>
    );
  }
  return (
    <ConfirmDialog
      open={open}
      title={s.deleteTitle}
      body={s.deleteBody}
      confirmLabel={strings.common.delete}
      danger
      typeToConfirm={g.name}
      onConfirm={() => del({ groupId: g._id })}
      onDone={() => {
        toast(s.deleted(g.name));
        navigate("/groups", { replace: true });
      }}
      onClose={onClose}
    />
  );
}

function Assignments({ g }: { g: Detail }) {
  const canAct = useCan("admin");
  const update = useUpdateAssignment();
  const toast = useToast();
  const [assigning, setAssigning] = useState(false);
  const [unassign, setUnassign] = useState<AssignmentRow | null>(null);
  const unassignApp = useUnassignApp();

  const change = (a: AssignmentRow, patch: Partial<Pick<AssignmentRow, "audience" | "pinnedTaskbar" | "pinnedDesktop">>) =>
    update({ assignmentId: a._id, audience: a.audience, pinnedTaskbar: a.pinnedTaskbar, pinnedDesktop: a.pinnedDesktop, ...patch }).catch((e) =>
      toast(messageFor(e), "danger"),
    );

  const cols: Column<AssignmentRow>[] = [
    {
      key: "app",
      header: strings.group.app,
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
    {
      key: "audience",
      header: s.audience,
      cell: (a) =>
        canAct ? (
          <Select
            compact
            aria-label={`${s.audience}: ${a.appName}`}
            value={a.audience}
            onChange={(e) => void change(a, { audience: e.target.value as Audience })}
            style={{ minWidth: 200 }}
          >
            <option value="everyone">{s.audienceEveryone}</option>
            <option value="selected">{s.audienceSelected}</option>
          </Select>
        ) : (
          <span>{a.audience === "everyone" ? s.audienceEveryone : s.audienceSelected}</span>
        ),
    },
    {
      key: "pins",
      header: s.pinTaskbar + " / " + s.pinDesktop,
      cell: (a) =>
        canAct ? (
          <span className="dash-checks dash-checks--inline">
            <Checkbox label={s.pinnedTaskbar} checked={a.pinnedTaskbar} onChange={(e) => void change(a, { pinnedTaskbar: e.target.checked })} aria-label={`${s.pinTaskbar}: ${a.appName}`} />
            <Checkbox label={s.pinnedDesktop} checked={a.pinnedDesktop} onChange={(e) => void change(a, { pinnedDesktop: e.target.checked })} aria-label={`${s.pinDesktop}: ${a.appName}`} />
          </span>
        ) : (
          <span className="dash-pills">
            {a.pinnedTaskbar ? <Pill>{s.pinnedTaskbar}</Pill> : null}
            {a.pinnedDesktop ? <Pill>{s.pinnedDesktop}</Pill> : null}
            {!a.pinnedTaskbar && !a.pinnedDesktop ? <span className="dash-muted">—</span> : null}
          </span>
        ),
    },
    ...(canAct
      ? [
          {
            key: "act",
            header: strings.common.actions,
            actions: true,
            cell: (a: AssignmentRow) => (
              <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => setUnassign(a)}>
                {s.unassign}
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card
      title={s.apps}
      sub={s.appsLead}
      body="none"
      actions={
        <RoleGate minRole="admin">
          <Button variant="ghost" className="dash-btn--sm" onClick={() => setAssigning(true)}>
            <IconAdd aria-hidden="true" />
            {s.assign}
          </Button>
        </RoleGate>
      }
    >
      <div style={{ paddingTop: 12 }}>
        {g.assignments.length === 0 ? (
          <EmptyState compact title={s.appsNone} />
        ) : (
          <DataTable caption={s.apps} columns={cols} rows={g.assignments} getKey={(a) => a._id} />
        )}
      </div>
      {assigning ? <AssignDialog g={g} onClose={() => setAssigning(false)} /> : null}
      <ConfirmDialog
        open={unassign !== null}
        title={s.unassignTitle(unassign?.appName ?? "")}
        body={s.unassignBody}
        confirmLabel={s.unassign}
        danger
        onConfirm={() => unassignApp({ assignmentId: unassign!._id })}
        onClose={() => setUnassign(null)}
      />
    </Card>
  );
}

function AssignDialog({ g, onClose }: { g: Detail; onClose: () => void }) {
  const assign = useAssignApp();
  const toast = useToast();
  const options = useMemo(() => g.appOptions.filter((a) => !g.assignments.some((x) => x.appId === a._id)), [g]);
  const f = useForm(
    { appId: options[0]?._id ?? "", audience: "everyone" as Audience, pinnedTaskbar: false, pinnedDesktop: true },
    (x) => ({ appId: x.appId ? undefined : strings.validate.required }),
  );
  return (
    <Modal
      open
      title={s.assignTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await assign({ groupId: g._id, ...x });
          toast(strings.common.saved);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending || options.length === 0} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : s.assign}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={s.app} error={f.errors.appId} required>
          {(p) => (
            <Select {...p} value={f.values.appId} onChange={(e) => f.set("appId", e.target.value)}>
              {options.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.name} · {a.kind === "web" ? strings.apps.web : strings.apps.desktop}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={s.audience}>
          {(p) => (
            <Select {...p} value={f.values.audience} onChange={(e) => f.set("audience", e.target.value as Audience)}>
              <option value="everyone">{s.audienceEveryone}</option>
              <option value="selected">{s.audienceSelected}</option>
            </Select>
          )}
        </Field>
        <FieldSet legend={s.pins}>
          <div className="dash-checks dash-checks--inline">
            <Checkbox label={s.pinTaskbar} checked={f.values.pinnedTaskbar} onChange={(e) => f.set("pinnedTaskbar", e.target.checked)} />
            <Checkbox label={s.pinDesktop} checked={f.values.pinnedDesktop} onChange={(e) => f.set("pinnedDesktop", e.target.checked)} />
          </div>
        </FieldSet>
        <FormError error={f.serverError} />
      </div>
    </Modal>
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
        <RoleGate minRole="admin">
          <Button variant="ghost" className="dash-btn--sm" onClick={() => setAdding(true)}>
            <IconAdd aria-hidden="true" />
            {s.addEmployee}
          </Button>
        </RoleGate>
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
