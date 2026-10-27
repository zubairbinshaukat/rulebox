import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Input, Textarea } from "@rulebox/ui";
import IconLayers from "~icons/solar/layers-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import { useCreateGroup, useGroupsScreen, usePlan } from "../data";
import type { GroupRow } from "../data/types";
import { Card } from "../components/Card";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../lib/toast";
import { formatCount } from "../lib/format";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";
import { groupFieldError, groupErrorMessage } from "./groups/errors";
import { groupText } from "./groups/strings";
import { plan as planText, UNLIMITED } from "./settings/strings";

const s = strings.groups;

/** `groups:list`: every group with capped device and employee counts ("500+"). */
export default function Groups() {
  const groups = useGroupsScreen();
  const [creating, setCreating] = useState(false);
  const cols = useMemo<Column<GroupRow>[]>(
    () => [
      {
        key: "name",
        header: s.colName,
        primary: true,
        cell: (g) => (
          <span className="dash-cell-stack">
            <Link className="dash-link dash-link--plain dash-truncate" to={`/groups/${g._id}`} title={g.name}>
              {g.name}
            </Link>
            {g.description ? (
              <span className="dash-cell-sub" title={g.description}>
                {g.description}
              </span>
            ) : null}
          </span>
        ),
      },
      { key: "devices", header: s.colDevices, numeric: true, cell: (g) => formatCount(g.deviceCount, 500) },
      { key: "employees", header: s.colEmployees, numeric: true, cell: (g) => formatCount(g.employeeCount, 500) },
    ],
    [],
  );

  const add = (
    <RoleGate minRole="admin">
      <Button onClick={() => setCreating(true)}>
        <IconAdd aria-hidden="true" />
        {s.add}
      </Button>
    </RoleGate>
  );

  return (
    <div className="dash-page">
      <PageHeader title={s.title} lead={s.lead} actions={add} />
      <Card body="none">
        <QueryRegion state={groups} skeleton={<SkeletonRows rows={5} columns={3} />}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState icon={<IconLayers />} title={s.emptyTitle} body={s.emptyBody} action={add} />
            ) : (
              <DataTable caption={s.title} columns={cols} rows={list} getKey={(g) => g._id} />
            )
          }
        </QueryRegion>
      </Card>
      {creating ? <CreateGroupDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

/** "New group". The plan (`settings:plan`, only while the dialog is open) shows how many groups are left. */
function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateGroup();
  const plan = usePlan();
  const navigate = useNavigate();
  const toast = useToast();
  const f = useForm({ name: "", description: "" }, (x) => ({
    name: v.name(x.name, v.NAME_MAX.group) ?? undefined,
    description: v.description(x.description, v.NAME_MAX.description) ?? undefined,
  }));
  const p = plan.status === "ready" ? plan.data : null;
  const limit = p?.limits.maxGroups;
  const usage = p && limit !== undefined && limit < UNLIMITED ? groupText.usage(p.usage.groups, limit, planText.names[p.plan]) : null;
  return (
    <Modal
      open
      title={s.addTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          const id = await create({ name: x.name.trim(), description: x.description.trim() || undefined });
          toast(s.created(x.name.trim()));
          onClose();
          navigate(`/groups/${id}`);
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : strings.common.create}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={s.name} error={f.errors.name ?? groupFieldError(f.serverError, "name")} required>
          {(fp) => <Input {...fp} value={f.values.name} onChange={(e) => f.set("name", e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={s.description} error={f.errors.description ?? groupFieldError(f.serverError, "description")} optional>
          {(fp) => <Textarea {...fp} rows={3} value={f.values.description} onChange={(e) => f.set("description", e.target.value)} />}
        </Field>
        {usage ? <p className="dash-field__hint">{usage}</p> : null}
        <FormError error={f.serverError} fields={["name", "description"]} describe={(e) => groupErrorMessage(e, p)} />
      </div>
    </Modal>
  );
}
