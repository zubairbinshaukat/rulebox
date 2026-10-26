import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Checkbox, Input } from "@rulebox/ui";
import IconLock from "~icons/solar/lock-keyhole-linear";
import IconKey from "~icons/solar/key-linear";
import {
  useCreateEmployee,
  useDeleteEmployee,
  useEmployeeDetail,
  useSetEmployeeDisabled,
  useSetEmployeePassword,
  useUnlockEmployee,
  useUpdateEmployee,
} from "../data";
import type { EmployeeDetail as Detail } from "../data/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field, FieldSet } from "../components/Field";
import { FormError } from "../components/FormError";
import { HistoryPanel } from "../components/HistoryPanel";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { PasswordInput } from "../components/PasswordInput";
import { QueryRegion } from "../components/Region";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { useCan } from "../lib/member";
import { SkeletonBlock } from "../components/Skeleton";
import { StatusDot } from "../components/StatusDot";
import { useToast } from "../lib/toast";
import { formatGb, formatTime } from "../lib/format";
import { messageFor } from "../lib/errors";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";

const s = strings.employee;

interface ProfileValues extends Record<string, unknown> {
  name: string;
  username: string;
  quota: string;
  groupIds: string[];
  appIds: string[];
  password: string;
}

function valuesOf(d: Detail): ProfileValues {
  return {
    name: d.name,
    username: d.username,
    quota: d.quotaGb === undefined ? "" : String(d.quotaGb),
    groupIds: d.groupIds,
    appIds: d.appIds,
    password: "",
  };
}

function suggestUsername(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 40);
}

/** `employees:get`; `/employees/new` uses the same form with blank values. */
export default function EmployeeDetail() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const detail = useEmployeeDetail(isNew ? "new" : id);
  return (
    <div className="dash-page">
      {detail.status !== "ready" ? (
        <PageHeader title={detail.status === "loading" ? strings.app.loading : strings.employees.title} back={{ to: "/employees", label: s.back }} />
      ) : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
        {(d) => (isNew ? <NewEmployee d={d} /> : <ExistingEmployee d={d} />)}
      </QueryRegion>
    </div>
  );
}

function NewEmployee({ d }: { d: Detail }) {
  const canAct = useCan("admin");
  const create = useCreateEmployee();
  const navigate = useNavigate();
  const toast = useToast();
  if (!canAct) {
    return (
      <>
        <PageHeader title={s.newTitle} back={{ to: "/employees", label: s.back }} />
        <InlineNotice tone="neutral" title={strings.app.readOnly} />
      </>
    );
  }
  return (
    <>
      <PageHeader title={s.newTitle} back={{ to: "/employees", label: s.back }} />
      <ProfileForm
        d={d}
        isNew
        onSave={async (x) => {
          const id = await create({
            name: x.name.trim(),
            username: x.username.trim(),
            quotaGb: x.quota.trim() === "" ? undefined : Number(x.quota),
            groupIds: x.groupIds,
            appIds: x.appIds,
            password: x.password || undefined,
          });
          toast(s.created(x.name.trim()));
          navigate(`/employees/${id}`, { replace: true });
        }}
      />
    </>
  );
}

function ExistingEmployee({ d }: { d: Detail }) {
  const canAct = useCan("admin");
  const update = useUpdateEmployee();
  const toast = useToast();
  const [revision, setRevision] = useState(d.revision);
  const [formKey, setFormKey] = useState(0);

  return (
    <>
      <PageHeader
        back={{ to: "/employees", label: s.back }}
        title={<span className="dash-wrap">{d.name}</span>}
        meta={
          <>
            <span className="dash-chip dash-mono">{d.username}</span>
            {d.disabled ? <StatusDot tone="neutral" label={strings.employees.disabled} /> : <StatusDot tone="success" label={strings.employees.active} />}
          </>
        }
      />
      {d.disabled ? <InlineNotice tone="neutral" title={strings.employees.disabled} detail={s.disabledHelp} /> : null}
      {d.lockout ? <LockoutNotice d={d} /> : null}

      <div className="dash-grid dash-grid--main">
        <div className="dash-stack">
          {canAct ? (
            <ProfileForm
              key={formKey}
              d={d}
              onSave={async (x) => {
                await update({
                  employeeId: d._id,
                  expectedRevision: revision,
                  name: x.name.trim(),
                  username: x.username.trim(),
                  quotaGb: x.quota.trim() === "" ? undefined : Number(x.quota),
                  groupIds: x.groupIds,
                  appIds: x.appIds,
                });
                setRevision((r) => r + 1);
                toast(s.saved);
              }}
              onReload={() => {
                setRevision(d.revision);
                setFormKey((k) => k + 1);
              }}
            />
          ) : (
            <ReadOnlyProfile d={d} />
          )}
        </div>
        <div className="dash-stack">
          <PasswordCard d={d} />
          <RoleGate minRole="admin">
            <AccountCard d={d} />
          </RoleGate>
          <HistoryPanel targetId={d._id} title={s.history} />
        </div>
      </div>
    </>
  );
}

function ReadOnlyProfile({ d }: { d: Detail }) {
  const groups = d.groupOptions.filter((g) => d.groupIds.includes(g._id));
  const apps = d.appOptions.filter((a) => d.appIds.includes(a._id));
  return (
    <Card title={s.profile}>
      <dl className="dash-kv">
        <div className="dash-kv__item">
          <dt>{s.name}</dt>
          <dd>{d.name}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.username}</dt>
          <dd className="dash-mono">{d.username}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.quota}</dt>
          <dd>{d.quotaGb === undefined ? `${strings.employees.defaultQuota} (${d.defaultQuotaGb ? formatGb(d.defaultQuotaGb) : strings.employees.unlimited})` : d.quotaGb === 0 ? strings.employees.unlimited : formatGb(d.quotaGb)}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.groups}</dt>
          <dd>{groups.length ? groups.map((g) => g.name).join(", ") : strings.common.none}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.apps}</dt>
          <dd>{apps.length ? apps.map((a) => a.name).join(", ") : strings.common.none}</dd>
        </div>
      </dl>
    </Card>
  );
}

function ProfileForm({
  d,
  isNew,
  onSave,
  onReload,
}: {
  d: Detail;
  isNew?: boolean;
  onSave: (values: ProfileValues) => Promise<void>;
  onReload?: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [usernameTouched, setUsernameTouched] = useState(!isNew);
  const f = useForm<ProfileValues>(valuesOf(d), (x) => ({
    name: v.name(x.name, v.NAME_MAX.employee) ?? undefined,
    username: v.username(x.username) ?? undefined,
    quota: v.quota(x.quota) ?? undefined,
    password: isNew && x.password ? v.employeePassword(x.password, x.username) ?? undefined : undefined,
  }));

  return (
    <Card title={s.profile}>
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(onSave, form.current);
        }}
      >
        <div className="dash-form__row">
          <Field label={s.name} error={f.errors.name} required>
            {(p) => (
              <Input
                {...p}
                value={f.values.name}
                autoComplete="off"
                onChange={(e) => {
                  f.set("name", e.target.value);
                  if (!usernameTouched) f.set("username", suggestUsername(e.target.value));
                }}
              />
            )}
          </Field>
          <Field label={s.username} hint={s.usernameHint} error={f.errors.username} required>
            {(p) => (
              <Input
                {...p}
                className="dash-mono"
                value={f.values.username}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => {
                  setUsernameTouched(true);
                  f.set("username", e.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <Field label={s.quota} hint={s.quotaHint(d.defaultQuotaGb)} error={f.errors.quota} optional>
          {(p) => (
            <Input {...p} inputMode="numeric" value={f.values.quota} onChange={(e) => f.set("quota", e.target.value)} style={{ maxWidth: 200 }} />
          )}
        </Field>
        <FieldSet legend={s.groups} hint={s.groupsHint}>
          {d.groupOptions.length === 0 ? (
            <p className="dash-muted">{strings.groups.emptyBody}</p>
          ) : (
            <div className="dash-checks">
              {d.groupOptions.map((g) => (
                <Checkbox
                  key={g._id}
                  label={g.name}
                  checked={f.values.groupIds.includes(g._id)}
                  onChange={(e) =>
                    f.set("groupIds", e.target.checked ? [...f.values.groupIds, g._id] : f.values.groupIds.filter((x) => x !== g._id))
                  }
                />
              ))}
            </div>
          )}
        </FieldSet>
        <FieldSet legend={s.apps} hint={s.appsHint}>
          <div className="dash-checks">
            {d.appOptions.map((a) => (
              <Checkbox
                key={a._id}
                label={a.name}
                hint={a.kind === "desktop" ? s.desktopNote : undefined}
                checked={f.values.appIds.includes(a._id)}
                onChange={(e) => f.set("appIds", e.target.checked ? [...f.values.appIds, a._id] : f.values.appIds.filter((x) => x !== a._id))}
              />
            ))}
          </div>
        </FieldSet>
        {isNew ? (
          <Field label={s.passwordInitial} hint={s.passwordInitialHint} error={f.errors.password} optional>
            {(p) => <PasswordInput {...p} autoComplete="new-password" value={f.values.password} onChange={(e) => f.set("password", e.target.value)} />}
          </Field>
        ) : null}
        <FormError error={f.serverError} onReload={onReload} />
        <div className="dash-form__actions">
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : isNew ? strings.common.create : strings.common.saveChanges}
          </Button>
          {isNew ? (
            <Link to="/employees" className="rb-btn rb-btn--ghost">
              {strings.common.cancel}
            </Link>
          ) : f.dirty ? (
            <span className="dash-form__status">{strings.common.unsavedHint}</span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function LockoutNotice({ d }: { d: Detail }) {
  const unlock = useUnlockEmployee();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  if (!d.lockout) return null;
  return (
    <InlineNotice
      tone="warning"
      title={s.lockedTitle}
      detail={s.lockedDetail(d.lockout.failures, formatTime(d.lockout.lockedUntil))}
      action={
        <RoleGate minRole="admin">
          <Button
            variant="ghost"
            className="dash-btn--sm"
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              setPending(true);
              unlock({ employeeId: d._id }).then(
                () => toast(s.unlocked),
                (e) => {
                  setPending(false);
                  toast(messageFor(e), "danger");
                },
              );
            }}
          >
            <IconLock aria-hidden="true" />
            {s.unlock}
          </Button>
        </RoleGate>
      }
    />
  );
}

function PasswordCard({ d }: { d: Detail }) {
  const [open, setOpen] = useState(false);
  return (
    <Card
      title={s.password}
      actions={
        <RoleGate minRole="admin">
          <Button variant="ghost" className="dash-btn--sm" onClick={() => setOpen(true)}>
            <IconKey aria-hidden="true" />
            {s.setPassword}
          </Button>
        </RoleGate>
      }
    >
      {d.passwordSet && d.passwordSetAt ? (
        <p>
          {s.passwordSetPrefix} <RelativeTime ms={d.passwordSetAt} />.
        </p>
      ) : (
        <InlineNotice tone="warning" title={s.passwordNotSet} />
      )}
      {open ? <SetPasswordDialog d={d} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

function SetPasswordDialog({ d, onClose }: { d: Detail; onClose: () => void }) {
  const setPassword = useSetEmployeePassword();
  const toast = useToast();
  const f = useForm({ password: "", repeat: "" }, (x) => ({
    password: v.employeePassword(x.password, d.username) ?? undefined,
    repeat: v.same(x.password, x.repeat, strings.validate.passwordsDiffer) ?? undefined,
  }));
  return (
    <Modal
      open
      title={s.setPasswordTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await setPassword({ employeeId: d._id, password: x.password });
          toast(s.passwordSaved);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : s.setPassword}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <p className="dash-dialog__lead">{s.setPasswordBody}</p>
        <Field label={strings.auth.newPassword} hint={strings.validate.passwordEmployee} error={f.errors.password} required>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={f.values.password} onChange={(e) => f.set("password", e.target.value)} />}
        </Field>
        <Field label={strings.auth.repeatPassword} error={f.errors.repeat} required>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={f.values.repeat} onChange={(e) => f.set("repeat", e.target.value)} />}
        </Field>
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}

function AccountCard({ d }: { d: Detail }) {
  const setDisabled = useSetEmployeeDisabled();
  const del = useDeleteEmployee();
  const navigate = useNavigate();
  const toast = useToast();
  const [dialog, setDialog] = useState<"disable" | "delete" | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Card title={s.status} tone="danger">
      <div className="dash-form">
        <div className="dash-row dash-row--between">
          <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.disabledHelp}</span>
          {d.disabled ? (
            <Button
              variant="ghost"
              disabled={pending}
              aria-busy={pending}
              onClick={() => {
                setPending(true);
                setDisabled({ employeeId: d._id, disabled: false }).then(
                  () => setPending(false),
                  (e) => {
                    setPending(false);
                    toast(messageFor(e), "danger");
                  },
                );
              }}
            >
              {s.enable}
            </Button>
          ) : (
            <Button variant="danger-ghost" onClick={() => setDialog("disable")}>
              {s.disable}
            </Button>
          )}
        </div>
        <hr className="dash-divider" />
        <div className="dash-row dash-row--between">
          <span className="dash-muted" style={{ flex: "1 1 200px" }}>{d.disabled ? s.deleteBody : s.deleteNeedsDisable}</span>
          {d.disabled ? (
            <Button variant="danger-ghost" onClick={() => setDialog("delete")}>
              {strings.common.delete}
            </Button>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={dialog === "disable"}
        title={s.disableTitle}
        body={s.disableBody}
        confirmLabel={s.disable}
        danger
        onConfirm={() => setDisabled({ employeeId: d._id, disabled: true })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        title={s.deleteTitle}
        body={s.deleteBody}
        confirmLabel={strings.common.delete}
        danger
        typeToConfirm={d.username}
        onConfirm={() => del({ employeeId: d._id })}
        onDone={() => {
          toast(s.deleted(d.name));
          navigate("/employees", { replace: true });
        }}
        onClose={() => setDialog(null)}
      />
    </Card>
  );
}
