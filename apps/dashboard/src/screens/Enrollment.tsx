import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, Input, Pill, Select, type PillTone } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-square-linear";
import IconQr from "~icons/solar/key-minimalistic-linear";
import { useCreateEnrollmentCode, useEnrollmentScreen, useGroupsScreen, useKeysScreen, useRevokeEnrollmentCode } from "../data";
import type { EnrollmentCodeRow, EnrollmentCodeState, GroupRow } from "../data/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyField } from "../components/CopyField";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { LoadMore } from "../components/LoadMore";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { PagedRegion } from "../components/Region";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { useCan } from "../lib/member";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../lib/toast";
import { formatDateTime } from "../lib/format";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import { minuteOf, useNow } from "../lib/useNow";
import * as v from "../lib/validate";

const s = strings.enrollment;
const TONE: Record<EnrollmentCodeState, PillTone> = { active: "success", usedUp: "neutral", expired: "warning", revoked: "danger" };

/** `enrollmentCodes:list` (paginated, newest first) + create (code shown once) + revoke. */
export default function Enrollment() {
  const now = useNow(30_000);
  const codes = useEnrollmentScreen(minuteOf(now));
  const groups = useGroupsScreen();
  const keys = useKeysScreen();
  const canAct = useCan("admin");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ code: string; expiresAt: number } | null>(null);
  const [revoking, setRevoking] = useState<EnrollmentCodeRow | null>(null);
  const revoke = useRevokeEnrollmentCode();
  const toast = useToast();
  const noKey = keys.status === "ready" && !keys.data.keys.some((k) => k.status === "active");
  const groupList: GroupRow[] = groups.status === "ready" ? groups.data : [];

  const cols = useMemo<Column<EnrollmentCodeRow>[]>(
    () => [
      {
        key: "label",
        header: s.colLabel,
        primary: true,
        cell: (c) => (
          <span className="dash-cell-stack">
            <span className={["dash-truncate", c.label ? "" : "dash-muted"].join(" ")} title={c.label} style={{ fontWeight: 600 }}>
              {c.label ?? s.unlabeled}
            </span>
            <span className="dash-cell-sub">
              <RelativeTime ms={c.createdAt} />
            </span>
          </span>
        ),
      },
      {
        key: "group",
        header: s.colGroup,
        cell: (c) =>
          c.groupId ? (
            <Link className="dash-link dash-truncate" to={`/groups/${c.groupId}`} title={c.groupName}>
              {c.groupName}
            </Link>
          ) : (
            <span className="dash-muted">—</span>
          ),
      },
      { key: "uses", header: s.colUses, cell: (c) => <span className="dash-mono">{s.usesLeft(c.usesLeft, c.usesTotal)}</span> },
      { key: "expires", header: s.colExpires, cell: (c) => <span title={formatDateTime(c.expiresAt)}><RelativeTime ms={c.expiresAt} /></span> },
      { key: "state", header: s.colState, cell: (c) => <Pill tone={TONE[c.state]} dot>{s.states[c.state]}</Pill> },
      { key: "by", header: s.colCreatedBy, isEmpty: (c) => !c.createdByEmail, cell: (c) => <span className="dash-truncate" title={c.createdByEmail} style={{ maxWidth: 220 }}>{c.createdByEmail ?? "—"}</span> },
      ...(canAct
        ? [
            {
              key: "act",
              header: strings.common.actions,
              actions: true,
              isEmpty: (c: EnrollmentCodeRow) => c.state !== "active",
              cell: (c: EnrollmentCodeRow) =>
                c.state === "active" ? (
                  <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => setRevoking(c)}>
                    {strings.common.revoke}
                  </Button>
                ) : null,
            },
          ]
        : []),
    ],
    [canAct],
  );

  const add = (
    <RoleGate minRole="admin">
      <Button onClick={() => setCreating(true)} disabled={groupList.length === 0 || noKey}>
        <IconAdd aria-hidden="true" />
        {s.create}
      </Button>
    </RoleGate>
  );

  return (
    <div className="dash-page">
      <PageHeader title={s.title} lead={s.lead} actions={add} />
      {noKey ? <InlineNotice tone="warning" title={s.noSigningKey} /> : null}
      {groups.status === "ready" && groupList.length === 0 ? (
        <InlineNotice tone="warning" title={s.noGroups} action={<Link className="rb-btn rb-btn--ghost dash-btn--sm" to="/groups">{strings.groups.add}</Link>} />
      ) : null}
      {created ? <OneTimeCode code={created.code} expiresAt={created.expiresAt} onDone={() => setCreated(null)} /> : null}
      <Card body="none">
        <PagedRegion state={codes} skeleton={<SkeletonRows rows={5} columns={5} />}>
          {(p) =>
            p.items.length === 0 ? (
              <EmptyState icon={<IconQr />} title={s.emptyTitle} body={s.emptyBody} action={add} />
            ) : (
              <>
                <DataTable caption={s.title} columns={cols} rows={p.items} getKey={(c) => c._id} isDim={(c) => c.state !== "active"} />
                <LoadMore shown={p.items.length} canLoadMore={p.canLoadMore} isLoadingMore={p.isLoadingMore} loadMore={p.loadMore} />
              </>
            )
          }
        </PagedRegion>
      </Card>
      {creating ? (
        <CreateDialog
          groups={groupList}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title={s.revokeTitle}
        body={s.revokeBody}
        confirmLabel={strings.common.revoke}
        danger
        typeToConfirm={revoking?.label ?? revoking?.groupName}
        onConfirm={() => revoke({ tokenId: revoking!._id })}
        onDone={() => toast(s.revoked)}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}

/** The code exists only in this component's state: it is never fetched again (Section 4.7). */
function OneTimeCode({ code, expiresAt, onDone }: { code: string; expiresAt: number; onDone: () => void }) {
  const command = `rulebox-agent enroll ${code}`;
  return (
    <Card title={s.codeTitle}>
      <div className="dash-form">
        <InlineNotice tone="warning" title={s.codeOnce} detail={s.codeExpires(formatDateTime(expiresAt))} />
        <p>{s.codeHowTo}</p>
        <CopyField value={command} label={s.codeLabel} multiline />
        <div>
          <Button variant="ghost" onClick={onDone}>
            {s.codeDone}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function CreateDialog({
  groups,
  onClose,
  onCreated,
}: {
  groups: GroupRow[];
  onClose: () => void;
  onCreated: (c: { code: string; expiresAt: number }) => void;
}) {
  const create = useCreateEnrollmentCode();
  const f = useForm({ groupId: groups[0]?._id ?? "", uses: "1", ttl: "1440", label: "" }, (x) => ({
    groupId: x.groupId ? undefined : strings.validate.pickGroup,
    uses: v.intRange(x.uses, 1, 100) ?? undefined,
    label: v.optionalText(x.label, v.NAME_MAX.label) ?? undefined,
  }));
  return (
    <Modal
      open
      title={s.createTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          onCreated(await create({ groupId: x.groupId, uses: Number(x.uses), ttlMinutes: Number(x.ttl), label: x.label.trim() || undefined }));
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : s.create}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={s.group} hint={s.groupHint} error={f.errors.groupId} required>
          {(p) => (
            <Select {...p} value={f.values.groupId} onChange={(e) => f.set("groupId", e.target.value)}>
              {groups.map((g) => (
                <option key={g._id} value={g._id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="dash-form__row">
          <Field label={s.uses} hint={s.usesHint} error={f.errors.uses} required>
            {(p) => <Input {...p} type="number" min={1} max={100} inputMode="numeric" value={f.values.uses} onChange={(e) => f.set("uses", e.target.value)} />}
          </Field>
          <Field label={s.expiry}>
            {(p) => (
              <Select {...p} value={f.values.ttl} onChange={(e) => f.set("ttl", e.target.value)}>
                {s.expiryOptions.map((o) => (
                  <option key={o.minutes} value={String(o.minutes)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={s.label} hint={s.labelHint} error={f.errors.label} optional>
          {(p) => <Input {...p} value={f.values.label} onChange={(e) => f.set("label", e.target.value)} autoComplete="off" />}
        </Field>
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}
