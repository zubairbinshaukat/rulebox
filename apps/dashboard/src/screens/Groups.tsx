import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Input, Textarea } from "@rulebox/ui";
import IconLayers from "~icons/solar/layers-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import { useCreateGroup, useGroupsScreen } from "../data";
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

const s = strings.groups;

/** `groups:list`: every group with capped device and employee counts. */
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
      <CreateGroupDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function CreateGroupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <CreateInner onClose={onClose} />;
}

function CreateInner({ onClose }: { onClose: () => void }) {
  const create = useCreateGroup();
  const navigate = useNavigate();
  const toast = useToast();
  const f = useForm({ name: "", description: "" }, (x) => ({
    name: v.name(x.name, v.NAME_MAX.group) ?? undefined,
    description: v.optionalText(x.description, v.NAME_MAX.description) ?? undefined,
  }));
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
        <Field label={s.name} error={f.errors.name} required>
          {(p) => <Input {...p} value={f.values.name} onChange={(e) => f.set("name", e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={s.description} error={f.errors.description} optional>
          {(p) => <Textarea {...p} rows={3} value={f.values.description} onChange={(e) => f.set("description", e.target.value)} />}
        </Field>
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}
