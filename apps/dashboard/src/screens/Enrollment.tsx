import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button, Input, Pill, NativeSelect, type PillTone } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-square-linear";
import IconKey from "~icons/solar/key-minimalistic-linear";
import { useGroupsScreen, usePlan } from "../data";
import { useCreateEnrollmentCode, useEnrollmentScreen, useRevokeEnrollmentCode } from "../data/enrollment";
import type { EnrollmentCodeRow, EnrollmentCodeState, GroupRow } from "../data/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyField } from "../components/CopyField";
import type { Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { ServerTable } from "../components/ServerTable";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
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
      <CodeList canAct={canAct} onRevoke={setRevoking} emptyAction={add} />
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

/** `enrollmentCodes:list` sort keys; the first is the default (newest first). No search and no total. */
const LIST: ListConfig = { sorts: ["created", "expires"], defaultSort: { key: "created", dir: "desc" } };

/**
 * The list, one page at a time (page, page size and sort live in the URL). `nowMs` is the minute, so the
 * subscription changes at most once a minute; the rows' expiry and state also keep ticking on their own
 * (`displayState`) without a new query. Action rows: a click on the row does nothing.
 */
function CodeList({ canAct, onRevoke, emptyAction }: { canAct: boolean; onRevoke: (row: EnrollmentCodeRow) => void; emptyAction: ReactNode }) {
  const minute = useMinute();
  const view = useListView(LIST);
  const paging = useListPaging(view, { total: null });
  const codes = useEnrollmentScreen(minute, paging.query);
  const cols = useMemo<Column<EnrollmentCodeRow>[]>(
    () => [
      {
        key: "label",
        header: s.colLabel,
        primary: true,
        cell: (c) => (
          <span className={["dash-truncate", c.label ? "" : "dash-muted"].join(" ")} title={c.label} style={{ fontWeight: 600 }}>
            {c.label ?? s.unlabeled}
          </span>
        ),
      },
      {
        key: "group",
        header: s.colGroup,
        truncate: 24,
        cell: (c) =>
          c.groupId && c.groupName ? (
            <Link className="dash-link dash-truncate" to={`/groups/${c.groupId}`} title={c.groupName}>
              {c.groupName}
            </Link>
          ) : (
            <span className="dash-muted">{c.groupId ? s.groupGone : "—"}</span>
          ),
      },
      { key: "uses", header: s.colUses, nowrap: true, cell: (c) => <span className="dash-mono">{s.used(Math.max(0, c.usesTotal - c.usesLeft), c.usesTotal)}</span> },
      { key: "created", header: s.colCreated, nowrap: true, sortable: true, sortDefaultDir: "desc", cell: (c) => <RelativeTime ms={c.createdAt} /> },
      { key: "expires", header: s.colExpires, nowrap: true, sortable: true, sortDefaultDir: "desc", cell: (c) => <RelativeTime ms={c.expiresAt} /> },
      { key: "state", header: s.colState, nowrap: true, cell: (c) => <StateCell row={c} /> },
      {
        key: "by",
        header: s.colCreatedBy,
        truncate: 20,
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
  return (
    <ServerTable<EnrollmentCodeRow>
      framed
      caption={s.listCaption}
      columns={cols}
      getKey={(c) => c._id}
      isDim={(c) => c.state !== "active"}
      paging={paging}
      list={codes}
      total={null}
      empty={<EmptyState icon={<IconKey />} title={s.emptyTitle} body={canAct ? s.emptyBody : s.emptyBodyViewer} action={emptyAction} />}
    />
  );
}
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
            <NativeSelect {...fp} value={f.values.groupId} onChange={(e) => f.set("groupId", e.target.value)}>
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
            </NativeSelect>
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
              <NativeSelect {...fp} value={f.values.ttl} onChange={(e) => f.set("ttl", e.target.value)}>
                {s.expiryOptions.map((o) => (
                  <option key={o.minutes} value={String(o.minutes)}>
                    {o.label}
                  </option>
                ))}
                <option value={CUSTOM}>{s.custom}</option>
              </NativeSelect>
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
                <NativeSelect aria-label={s.customUnit} value={f.values.customUnit} onChange={(e) => f.set("customUnit", e.target.value as TtlUnit)}>
                  {(Object.keys(s.units) as TtlUnit[]).map((u) => (
                    <option key={u} value={u}>
                      {s.units[u]}
                    </option>
                  ))}
                </NativeSelect>
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
