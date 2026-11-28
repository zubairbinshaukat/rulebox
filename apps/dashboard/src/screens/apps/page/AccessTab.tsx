import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Checkbox, Select } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-circle-linear";
import { useAssignApp } from "../../../data";
import type { AppDetail, Audience } from "../../../data/types";
import { Card } from "../../../components/Card";
import { DataTable, type Column } from "../../../components/DataTable";
import { EmptyState } from "../../../components/EmptyState";
import { Field, FieldSet } from "../../../components/Field";
import { FormError } from "../../../components/FormError";
import { Modal } from "../../../components/Modal";
import { InlineNotice } from "../../../components/Notice";
import { Pager } from "../../../components/Pager";
import { RoleGate } from "../../../components/RoleGate";
import { PAGE_SIZES } from "../../../lib/cursorPager";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appEditStrings as s } from "../../../lib/screenStrings/appEdit";
import { groupStrings } from "../../../lib/screenStrings/group";
import { strings } from "../../../lib/strings";
import { useForm } from "../../../lib/useForm";
import { useToast } from "../../../lib/toast";
import { assignmentErrorMessage } from "../../groups/errors";

type Row = AppDetail["assignments"][number];

/**
 * "Who gets it": the groups that assign this app (they come with `apps:get`, bounded by the server, so nothing is queried here), the
 * Assign button and, right after an app was added (`?added=1`), the banner that points at it. A slice of what is already loaded is
 * paged here; nothing is sorted or filtered in the browser.
 */
export default function AccessTab({ d }: { d: AppDetail }) {
  const [assigning, setAssigning] = useState(false);
  const [params] = useSearchParams();
  const added = params.get("added") !== null;
  return (
    <div className="dash-split apps-access">
      <div className="dash-split__main">
        {added && !d.archived ? (
          <InlineNotice
            tone="success"
            title={appAddStrings.added.banner(d.name)}
            action={
              <RoleGate minRole="admin">
                <Button type="button" onClick={() => setAssigning(true)} disabled={d.assignments.length >= d.groupOptions.length}>
                  {appAddStrings.added.assign}
                </Button>
              </RoleGate>
            }
          />
        ) : null}
        <Card
          title={s.assignments}
          body="none"
          className="dash-card--tight"
          actions={
            !d.archived ? (
              <RoleGate minRole="admin">
                <Button variant="ghost" className="dash-btn--sm" onClick={() => setAssigning(true)}>
                  <IconAdd aria-hidden="true" />
                  {s.assign}
                </Button>
              </RoleGate>
            ) : undefined
          }
        >
          {d.assignments.length === 0 ? <EmptyState compact title={s.assignmentsNone} /> : <AssignmentsTable rows={d.assignments} />}
        </Card>
      </div>
      <aside className="dash-split__aside">
        {d.directEmployeeCount > 0 ? (
          <Card>
            <p className="dash-muted">{s.directEmployees(d.directEmployeeCount)}</p>
          </Card>
        ) : null}
        {d.kind === "desktop" ? (
          <Card title={s.fileTypes}>
            {d.fileTypes.length ? (
              <div className="dash-pills">
                {d.fileTypes.map((ext) => (
                  <span key={ext} className="dash-chip dash-mono">
                    {ext}
                  </span>
                ))}
              </div>
            ) : (
              <p className="dash-muted">{strings.common.none}</p>
            )}
            <p style={{ marginTop: 12 }}>
              <Link className="dash-link" to="/file-types">
                {s.fileTypesManage}
              </Link>
            </p>
          </Card>
        ) : null}
      </aside>
      {assigning ? <AssignToGroup d={d} onClose={() => setAssigning(false)} /> : null}
    </div>
  );
}

/** The groups card with its Assign button and modal, on its own (the website screen that has no tabs yet shows it beside its form). */
export function AssignmentsCard({ d }: { d: AppDetail }) {
  const [assigning, setAssigning] = useState(false);
  return (
    <Card
      title={s.assignments}
      body="none"
      className="dash-card--tight"
      actions={
        !d.archived ? (
          <RoleGate minRole="admin">
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setAssigning(true)}>
              <IconAdd aria-hidden="true" />
              {s.assign}
            </Button>
          </RoleGate>
        ) : undefined
      }
    >
      {d.assignments.length === 0 ? <EmptyState compact title={s.assignmentsNone} /> : <AssignmentsTable rows={d.assignments} />}
      {d.directEmployeeCount > 0 ? <p className="dash-muted apps-direct">{s.directEmployees(d.directEmployeeCount)}</p> : null}
      {assigning ? <AssignToGroup d={d} onClose={() => setAssigning(false)} /> : null}
    </Card>
  );
}

function AssignmentsTable({ rows }: { rows: Row[] }) {
  const navigate = useNavigate();
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages);
  const cols = useMemo<Column<Row>[]>(
    () => [
      {
        key: "group",
        header: strings.enrollment.group,
        primary: true,
        cell: (a) => (
          <Link className="dash-link dash-link--plain dash-truncate" to={`/groups/${a.groupId}`} title={a.groupName}>
            {a.groupName}
          </Link>
        ),
      },
      { key: "audience", header: groupStrings.audience, type: "short", cell: (a) => (a.audience === "everyone" ? groupStrings.audienceEveryone : groupStrings.audienceSelected) },
      {
        key: "pins",
        header: groupStrings.pins,
        type: "short",
        isEmpty: (a) => !a.pinnedTaskbar && !a.pinnedDesktop,
        cell: (a) =>
          a.pinnedTaskbar || a.pinnedDesktop ? [a.pinnedTaskbar ? groupStrings.pinnedTaskbar : null, a.pinnedDesktop ? groupStrings.pinnedDesktop : null].filter(Boolean).join(" · ") : <span className="dash-muted">—</span>,
      },
    ],
    [],
  );
  return (
    <DataTable
      caption={s.assignments}
      columns={cols}
      rows={rows.slice((current - 1) * size, current * size)}
      getKey={(a) => a._id}
      onRowClick={(a) => navigate(`/groups/${a.groupId}`)}
      footer={
        rows.length > PAGE_SIZES[0] ? (
          <Pager
            page={current}
            pageSize={size}
            total={rows.length}
            hasNext={current < pages}
            reachablePages={new Set(Array.from({ length: pages }, (_, i) => i + 1))}
            onPage={setPage}
            onPageSize={(n) => {
              setSize(n);
              setPage(1);
            }}
          />
        ) : undefined
      }
    />
  );
}

function AssignToGroup({ d, onClose }: { d: AppDetail; onClose: () => void }) {
  const assign = useAssignApp();
  const toast = useToast();
  const options = d.groupOptions.filter((g) => !d.assignments.some((a) => a.groupId === g._id));
  const f = useForm({ groupId: options[0]?._id ?? "", audience: "everyone" as Audience, pinnedTaskbar: false, pinnedDesktop: true }, (x) => ({ groupId: x.groupId ? undefined : strings.validate.pickGroup }));
  return (
    <Modal
      open
      title={s.assign}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await assign({ appId: d._id, ...x });
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
        <Field label={strings.enrollment.group} error={f.errors.groupId} required>
          {(p) => <Select {...p} value={f.values.groupId} onChange={(val) => f.set("groupId", val)} options={options.map((g) => ({ value: g._id, label: g.name }))} />}
        </Field>
        <Field label={groupStrings.audience}>
          {(p) => (
            <Select
              {...p}
              value={f.values.audience}
              onChange={(val) => f.set("audience", val as Audience)}
              options={[
                { value: "everyone", label: groupStrings.audienceEveryone },
                { value: "selected", label: groupStrings.audienceSelected },
              ]}
            />
          )}
        </Field>
        <FieldSet legend={groupStrings.pins}>
          <div className="dash-checks dash-checks--inline">
            <Checkbox label={groupStrings.pinTaskbar} checked={f.values.pinnedTaskbar} onChange={(e) => f.set("pinnedTaskbar", e.target.checked)} />
            <Checkbox label={groupStrings.pinDesktop} checked={f.values.pinnedDesktop} onChange={(e) => f.set("pinnedDesktop", e.target.checked)} />
          </div>
        </FieldSet>
        <FormError error={f.serverError} describe={assignmentErrorMessage} />
      </div>
    </Modal>
  );
}
