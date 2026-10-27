import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button, Input, Pill, Select, type PillTone } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-square-linear";
import IconKey from "~icons/solar/key-minimalistic-linear";
import { useGroupsScreen, usePlan } from "../data";
import { useCreateEnrollmentCode, useEnrollmentScreen, useRevokeEnrollmentCode } from "../data/enrollment";
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
import { PagedRegion, RegionBoundary } from "../components/Region";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { SkeletonRows } from "../components/Skeleton";
import { useCan } from "../lib/member";
import { useToast } from "../lib/toast";
import { formatDateTime } from "../lib/format";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import { useMinute, useNow } from "../lib/useNow";
import {
  codeBlocks,
  displayState,
  enrollErrorMessage,
  enrollFieldError,
  ttlMinutesOf,
  validateEnrollForm,
  type EnrollForm,
  type TtlUnit,
} from "./enrollment/model";
import { enrollText as s } from "./enrollment/strings";
import { plan as planText, UNLIMITED } from "./settings/strings";
import "./enrollment/enrollment.css";

const TONE: Record<EnrollmentCodeState, PillTone> = { active: "success", usedUp: "neutral", expired: "warning", revoked: "danger" };

/** A code just created: kept only in this screen's state, never fetched again (plan 4.7). */
interface Created {
  code: string;
  expiresAt: number;
  uses: number;
  groupName?: string;
}

/**
 * `/enrollment`: `enrollmentCodes:list` (paginated, newest first), create
 * (the code is shown once) and revoke (major action: fresh step-up). The code
 * lives only in this component's state: closing the panel or leaving the page
 * drops it, and it never goes to the URL, storage, a toast or the console.
 */
export default function Enrollment() {
  const groups = useGroupsScreen();
  const canAct = useCan("admin");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [revoking, setRevoking] = useState<EnrollmentCodeRow | null>(null);
  const revoke = useRevokeEnrollmentCode();
  const toast = useToast();
  const groupList: GroupRow[] | null = groups.status === "ready" ? groups.data : null;

  const add = (
    <RoleGate minRole="admin">
      <Button onClick={() => setCreating(true)} disabled={groupList === null || groupList.length === 0}>
        <IconAdd aria-hidden="true" />
        {s.create}
      </Button>
    </RoleGate>
  );

  return (
    <div className="dash-page">
      <PageHeader title={s.title} lead={s.lead} actions={add} />
      {canAct && groupList?.length === 0 ? (
        <InlineNotice tone="warning" title={s.noGroups} action={<Link className="rb-btn rb-btn--ghost dash-btn--sm" to="/groups">{s.addGroup}</Link>} />
      ) : null}
      {created ? <OneTimeCode created={created} onClose={() => setCreated(null)} /> : null}
      <Card body="none">
        <RegionBoundary>
          <CodeList canAct={canAct} onRevoke={setRevoking} emptyAction={add} />
        </RegionBoundary>
      </Card>
      {creating && groupList ? (
        <CreateDialog
          groups={groupList}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            toast(s.created);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title={s.revokeTitle}
        body={s.revokeBody}
        confirmLabel={strings.common.revoke}
        danger
        typeToConfirm={revoking?.label}
        onConfirm={() => revoke({ tokenId: revoking!._id })}
        onDone={() => toast(s.revoked)}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}

/**
 * The list. `nowMs` is the minute, so the subscription changes at most once a
 * minute. A new `nowMs` restarts the pagination at the first page, so once
 * more pages are loaded the minute stops moving: the rows' expiry and state
 * keep ticking on their own (`displayState`) without a new query.
 */
function CodeList({ canAct, onRevoke, emptyAction }: { canAct: boolean; onRevoke: (row: EnrollmentCodeRow) => void; emptyAction: ReactNode }) {
  const minute = useMinute();
  const [extraPages, setExtraPages] = useState(false);
  const [queryMinute, setQueryMinute] = useState(minute);
  if (!extraPages && queryMinute !== minute) setQueryMinute(minute);
  const codes = useEnrollmentScreen(queryMinute);
  return (
    <PagedRegion state={codes} skeleton={<SkeletonRows rows={5} columns={5} />}>
      {(p) =>
        p.items.length === 0 ? (
          <EmptyState icon={<IconKey />} title={s.emptyTitle} body={canAct ? s.emptyBody : s.emptyBodyViewer} action={emptyAction} />
        ) : (
          <>
            <CodesTable rows={p.items} canAct={canAct} onRevoke={onRevoke} />
            <LoadMore
              shown={p.items.length}
              canLoadMore={p.canLoadMore}
              isLoadingMore={p.isLoadingMore}
              loadMore={() => {
                setExtraPages(true);
                p.loadMore();
              }}
            />
          </>
        )
      }
    </PagedRegion>
  );
}

const CodesTable = memo(function CodesTable({
  rows,
  canAct,
  onRevoke,
}: {
  rows: EnrollmentCodeRow[];
  canAct: boolean;
  onRevoke: (row: EnrollmentCodeRow) => void;
}) {
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
          c.groupId && c.groupName ? (
            <Link className="dash-link dash-truncate" to={`/groups/${c.groupId}`} title={c.groupName}>
              {c.groupName}
            </Link>
          ) : (
            <span className="dash-muted">{c.groupId ? s.groupGone : "—"}</span>
          ),
      },
      { key: "uses", header: s.colUses, cell: (c) => <span className="dash-mono">{s.used(Math.max(0, c.usesTotal - c.usesLeft), c.usesTotal)}</span> },
      { key: "expires", header: s.colExpires, cell: (c) => <RelativeTime ms={c.expiresAt} /> },
      { key: "state", header: s.colState, cell: (c) => <StateCell row={c} /> },
      {
        key: "by",
        header: s.colCreatedBy,
        isEmpty: (c) => !c.createdByEmail,
        cell: (c) => (
          <span className="dash-truncate" title={c.createdByEmail} style={{ maxWidth: 220 }}>
            {c.createdByEmail ?? "—"}
          </span>
        ),
      },
      ...(canAct
        ? [
            {
              key: "act",
              header: strings.common.actions,
              actions: true,
              isEmpty: (c: EnrollmentCodeRow) => c.state !== "active",
              cell: (c: EnrollmentCodeRow) => <RevokeCell row={c} onRevoke={onRevoke} />,
            },
          ]
        : []),
    ],
    [canAct, onRevoke],
  );
  return <DataTable caption={s.listCaption} columns={cols} rows={rows} getKey={(c) => c._id} isDim={(c) => c.state !== "active"} />;
});

/** Colour and text; re-renders on its own clock (30 s), not the table's. */
function StateCell({ row }: { row: EnrollmentCodeRow }) {
  const state = displayState(row, useNow(30_000));
  return (
    <Pill tone={TONE[state]} dot>
      {s.states[state]}
    </Pill>
  );
}

function RevokeCell({ row, onRevoke }: { row: EnrollmentCodeRow; onRevoke: (row: EnrollmentCodeRow) => void }) {
  const state = displayState(row, useNow(30_000));
  if (state !== "active") return null;
  return (
    <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => onRevoke(row)} aria-label={s.revokeNamed(row.label ?? s.unlabeled)}>
      {strings.common.revoke}
    </Button>
  );
}

/** The one-time panel: large, in blocks for reading, with Copy (exact code) and a warning. */
function OneTimeCode({ created, onClose }: { created: Created; onClose: () => void }) {
  const title = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useEffect(() => {
    title.current?.focus();
  }, [created]);
  return (
    <section className="dash-card dash-onetime" aria-labelledby={titleId}>
      <div className="dash-card__head">
        <h2 id={titleId} ref={title} tabIndex={-1} className="dash-card__title dash-onetime__title">
          {s.codeTitle}
        </h2>
      </div>
      <div className="dash-card__body">
        <div className="dash-form">
          <InlineNotice tone="warning" title={s.codeOnce} detail={s.codeOnceDetail} />
          <p className="dash-onetime__code" translate="no">
            {codeBlocks(created.code).map((b, i) => (
              <span key={i}>{b}</span>
            ))}
          </p>
          <CopyField value={created.code} label={s.codeLabel} />
          <p className="dash-onetime__meta">
            {s.codeFor(created.uses, created.groupName)} {s.codeExpires(formatDateTime(created.expiresAt))} {s.codeCase}
          </p>
          <p className="dash-onetime__howto">{s.codeHowTo}</p>
          <p className="dash-onetime__howto">{s.codeHowToCli}</p>
          <div>
            <Button variant="ghost" onClick={onClose}>
              {s.codeDone}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

const CUSTOM = "custom";

function CreateDialog({ groups, onClose, onCreated }: { groups: GroupRow[]; onClose: () => void; onCreated: (c: Created) => void }) {
  const create = useCreateEnrollmentCode();
  const plan = usePlan();
  const initial: EnrollForm = {
    groupId: groups.length === 1 ? groups[0]!._id : "",
    uses: "1",
    ttl: "1440",
    customAmount: "",
    customUnit: "hours",
    label: "",
  };
  const f = useForm(initial, validateEnrollForm);
  const p = plan.status === "ready" ? plan.data : null;
  const limit = p?.limits.maxEnrollmentCodesActive;
  const usage = p && limit !== undefined && limit < UNLIMITED ? s.usage(p.usage.enrollmentCodes, limit, planText.names[p.plan]) : null;
  const ttlServer = enrollFieldError(f.serverError, "ttlMinutes");

  return (
    <Modal
      open
      title={s.createTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          const uses = Number(x.uses.trim());
          const r = await create({ groupId: x.groupId, uses, ttlMinutes: ttlMinutesOf(x)!, label: x.label.trim() || undefined });
          onCreated({ code: r.code, expiresAt: r.expiresAt, uses, groupName: groups.find((g) => g._id === x.groupId)?.name });
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
          {(fp) => (
            <Select {...fp} value={f.values.groupId} onChange={(e) => f.set("groupId", e.target.value)}>
              {groups.length !== 1 ? (
                <option value="" disabled>
                  {s.pickGroup}
                </option>
              ) : null}
              {groups.map((g) => (
                <option key={g._id} value={g._id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="dash-form__row">
          <Field label={s.uses} hint={s.usesHint} error={f.errors.uses ?? enrollFieldError(f.serverError, "uses")} required>
            {(fp) => (
              <Input {...fp} type="number" min={1} max={100} step={1} inputMode="numeric" value={f.values.uses} onChange={(e) => f.set("uses", e.target.value)} />
            )}
          </Field>
          <Field label={s.expiry} error={f.values.ttl === CUSTOM ? null : (f.errors.ttl ?? ttlServer)} required>
            {(fp) => (
              <Select {...fp} value={f.values.ttl} onChange={(e) => f.set("ttl", e.target.value)}>
                {s.expiryOptions.map((o) => (
                  <option key={o.minutes} value={String(o.minutes)}>
                    {o.label}
                  </option>
                ))}
                <option value={CUSTOM}>{s.custom}</option>
              </Select>
            )}
          </Field>
        </div>
        {f.values.ttl === CUSTOM ? (
          <Field label={s.customAmount} hint={s.ttlRange} error={f.errors.ttl ?? ttlServer} required>
            {(fp) => (
              <div className="dash-ttl-custom">
                <Input
                  {...fp}
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={f.values.customAmount}
                  onChange={(e) => f.set("customAmount", e.target.value)}
                />
                <Select aria-label={s.customUnit} value={f.values.customUnit} onChange={(e) => f.set("customUnit", e.target.value as TtlUnit)}>
                  {(Object.keys(s.units) as TtlUnit[]).map((u) => (
                    <option key={u} value={u}>
                      {s.units[u]}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </Field>
        ) : null}
        <Field label={s.label} hint={s.labelHint} error={f.errors.label ?? enrollFieldError(f.serverError, "label")} optional>
          {(fp) => <Input {...fp} value={f.values.label} onChange={(e) => f.set("label", e.target.value)} autoComplete="off" maxLength={200} />}
        </Field>
        {usage ? <p className="dash-field__hint">{usage}</p> : null}
        <FormError error={f.serverError} fields={["uses", "ttlMinutes", "label"]} describe={(e) => enrollErrorMessage(e, p)} />
      </div>
    </Modal>
  );
}
