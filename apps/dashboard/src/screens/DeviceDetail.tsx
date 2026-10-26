import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Input, Pill, Select, Switch } from "@rulebox/ui";
import IconPen from "~icons/solar/pen-linear";
import {
  useDeviceDetail,
  useDeviceInstalls,
  useLiveStatus,
  useMoveDevice,
  useRemoveDevice,
  useRenameDevice,
  useRequestRotation,
  useRetryApp,
  useRevokeDevice,
  useSetKiosk,
} from "../data";
import type { DeviceDetail as Detail, DeviceInstallRow } from "../data/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { DeviceOnline, KioskCell } from "../components/DeviceCells";
import { EmptyState } from "../components/EmptyState";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { HistoryPanel } from "../components/HistoryPanel";
import { InstallStatePill } from "../components/InstallState";
import { installDetail } from "../lib/install";
import { LoadMore } from "../components/LoadMore";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { PagedRegion, QueryRegion } from "../components/Region";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { useCan } from "../lib/member";
import { SkeletonBlock, SkeletonRows } from "../components/Skeleton";
import { useToast } from "../lib/toast";
import { formatDate, formatDateTime, formatGb, formatNumber } from "../lib/format";
import { messageFor } from "../lib/errors";
import { strings } from "../lib/strings";
import { useNow } from "../lib/useNow";
import * as v from "../lib/validate";

const s = strings.device;

export default function DeviceDetail() {
  const { id = "" } = useParams();
  const detail = useDeviceDetail(id);
  return (
    <div className="dash-page">
      {detail.status === "loading" ? <PageHeader title={strings.app.loading} back={{ to: "/devices", label: s.back }} /> : null}
      {detail.status === "error" ? <PageHeader title={strings.devices.title} back={{ to: "/devices", label: s.back }} /> : null}
      <QueryRegion
        state={detail}
        skeleton={
          <div className="dash-card dash-card--pad">
            <SkeletonBlock lines={6} />
          </div>
        }
      >
        {(d) => <Device d={d} />}
      </QueryRegion>
    </div>
  );
}

function Device({ d }: { d: Detail }) {
  const live = useLiveStatus([d._id]);
  const now = useNow(30_000);
  const lastSeen = live?.items[0]?.lastSeenAt;
  const r = d.report;
  const latest = d.versions[0]?.version;
  const waiting = latest !== undefined && r?.appliedVersion !== latest;
  const [renaming, setRenaming] = useState(false);

  return (
    <>
      <PageHeader
        back={{ to: "/devices", label: s.back }}
        title={<span className="dash-wrap">{d.name}</span>}
        meta={
          <>
            <DeviceOnline lastSeenAt={lastSeen} pingIntervalMs={live?.pingIntervalMs} now={now} />
            <KioskCell row={d} />
            {r?.outOfSupport ? <Pill tone="danger">{strings.devices.outOfSupport}</Pill> : null}
          </>
        }
        actions={
          <RoleGate minRole="admin">
            <Button variant="ghost" onClick={() => setRenaming(true)}>
              <IconPen aria-hidden="true" />
              {strings.common.rename}
            </Button>
          </RoleGate>
        }
      />
      <RenameDialog d={d} open={renaming} onClose={() => setRenaming(false)} />

      {d.revoked ? <InlineNotice tone="danger" title={s.revoked} /> : null}
      {d.flags.noGroup && !d.revoked ? <InlineNotice tone="warning" title={s.noGroupWarning} /> : null}
      {r?.outOfSupport ? <InlineNotice tone="warning" title={s.outOfSupportWarning} /> : null}
      {r?.kioskError ? <InlineNotice tone="danger" title={s.kioskError(r.kioskError)} /> : null}
      {r?.restartPending ? <InlineNotice tone="accent" title={s.restartPending} /> : null}
      {d.flags.rotateCredential ? <InlineNotice tone="neutral" title={s.rotatePending} /> : null}

      <div className="dash-grid dash-grid--main">
        <div className="dash-stack">
          <Card title={s.status}>
            {r ? (
              <dl className="dash-kv">
                <KV label={s.lastReport} value={<RelativeTime ms={r.updatedAt} />} />
                <KV label={s.agentVersion} value={<span className="dash-mono">{r.agentVersion ?? "—"}</span>} />
                <KV label={s.windows} value={r.os ? `${r.os} ${r.osBuild ?? ""}` : "—"} />
                <KV label={s.edition} value={r.osEdition ?? "—"} />
                <KV label={s.ram} value={r.ramMb ? formatGb(Math.round(r.ramMb / 1024)) : "—"} />
                <KV label={s.diskFree} value={r.diskFreeGb !== undefined ? formatGb(r.diskFreeGb) : "—"} />
                <KV label={s.kioskPhase} value={strings.kioskPhase[r.kioskPhase ?? "unknown"]} />
                <KV label={s.shellHealth} value={strings.shellHealth[r.shellHealth ?? "unknown"]} />
                <KV label={s.lockdown} value={r.lockdownLevel ?? "—"} />
              </dl>
            ) : (
              <EmptyState compact title={s.compatNone} />
            )}
          </Card>

          <Installs deviceId={d._id} />

          <Card title={s.policy}>
            <div className="dash-form">
              {latest === undefined ? (
                <p className="dash-muted">{s.versionsNone}</p>
              ) : (
                <InlineNotice tone={waiting ? "warning" : "success"} title={waiting ? s.waiting(r?.appliedVersion, latest) : s.upToDate} />
              )}
              {d.versions.length ? (
                <ol className="dash-list" aria-label={s.versions}>
                  {d.versions.map((ver) => (
                    <li key={ver.version} className="dash-list__item" style={{ paddingInline: 0 }}>
                      <span className="dash-chip dash-mono">v{formatNumber(ver.version)}</span>
                      <div className="dash-list__body">
                        <p className="dash-list__title">{ver.reason}</p>
                        <p className="dash-list__meta">{formatDateTime(ver.createdAt)}</p>
                      </div>
                      {r?.appliedVersion === ver.version ? <Pill tone="success">{s.applied}</Pill> : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          </Card>

          <Card title={s.compat}>
            {r?.compat ? (
              <div className="dash-form">
                <dl className="dash-kv">
                  <KV label={s.build} value={<span className="dash-mono">{`${r.compat.os.build}.${r.compat.os.ubr} (${r.compat.os.displayVersion})`}</span>} />
                  <KV label={s.edition} value={r.compat.os.editionId} />
                  <KV label={s.arch} value={r.compat.os.arch} />
                  <KV label={s.sMode} value={r.compat.os.sMode ? strings.common.yes : strings.common.no} />
                  <KV label={s.joined} value={r.compat.os.domainJoined || r.compat.os.entraJoined ? strings.common.yes : strings.common.no} />
                </dl>
                {r.compat.blockers.length === 0 && r.compat.warnings.length === 0 ? (
                  <InlineNotice tone="success" title={s.noIssues} />
                ) : null}
                {r.compat.blockers.length ? (
                  <InlineNotice tone="danger" title={s.blockers} detail={r.compat.blockers.join(", ")} />
                ) : null}
                {r.compat.warnings.length ? (
                  <InlineNotice tone="warning" title={s.warnings} detail={r.compat.warnings.join(", ")} />
                ) : null}
                {r.compat.liteMode ? <p className="dash-muted">{s.liteMode}</p> : null}
              </div>
            ) : (
              <p className="dash-muted">{s.compatNone}</p>
            )}
          </Card>
        </div>

        <div className="dash-stack">
          <Settings d={d} />
          <Card title={s.identity}>
            <dl className="dash-kv" style={{ gridTemplateColumns: "1fr" }}>
              <KV label={s.enrolled} value={formatDate(d.enrolledAt)} />
              <KV label="ID" value={<span className="dash-mono">{d._id}</span>} />
            </dl>
          </Card>
          <RoleGate minRole="admin">
            <Danger d={d} />
          </RoleGate>
          <HistoryPanel targetId={d._id} />
        </div>
      </div>
    </>
  );
}

function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="dash-kv__item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Installs({ deviceId }: { deviceId: string }) {
  const installs = useDeviceInstalls(deviceId);
  const retry = useRetryApp();
  const toast = useToast();
  const canAct = useCan("admin");
  const cols: Column<DeviceInstallRow>[] = [
    {
      key: "app",
      header: strings.apps.colName,
      primary: true,
      cell: (i) => (
        <Link className="dash-link dash-link--plain dash-truncate" to={`/apps/${i.appId}`}>
          {i.appName}
        </Link>
      ),
    },
    { key: "state", header: strings.appEdit.installState, cell: (i) => <InstallStatePill state={i.state} /> },
    {
      key: "detail",
      header: strings.common.details,
      isEmpty: (i) => i.state !== "failed",
      cell: (i) => (i.state === "failed" ? <span className="dash-muted" style={{ fontSize: 13 }}>{installDetail(i.detail)}</span> : <RelativeTime ms={i.updatedAt} />),
    },
    {
      key: "act",
      header: strings.common.actions,
      actions: true,
      isEmpty: (i) => !(canAct && i.state === "failed"),
      cell: (i) =>
        canAct && i.state === "failed" ? (
          <Button
            variant="ghost"
            className="dash-btn--sm"
            onClick={() =>
              retry({ appId: i.appId }).then(
                () => toast(strings.install.retried),
                (e) => toast(messageFor(e), "danger"),
              )
            }
          >
            {strings.install.retry}
          </Button>
        ) : null,
    },
  ];
  return (
    <Card title={s.installs} body="none">
      <PagedRegion state={installs} skeleton={<SkeletonRows rows={3} columns={3} />}>
        {(p) =>
          p.items.length === 0 ? (
            <EmptyState compact title={s.installsNone} />
          ) : (
            <>
              <DataTable caption={s.installs} columns={cols} rows={p.items} getKey={(i) => i._id} />
              <LoadMore shown={p.items.length} canLoadMore={p.canLoadMore} isLoadingMore={p.isLoadingMore} loadMore={p.loadMore} />
            </>
          )
        }
      </PagedRegion>
    </Card>
  );
}

function Settings({ d }: { d: Detail }) {
  const canAct = useCan("admin");
  const setKiosk = useSetKiosk();
  const move = useMoveDevice();
  const toast = useToast();
  const [groupId, setGroupId] = useState(d.group?._id ?? "");
  const [base, setBase] = useState({ groupId: d.group?._id ?? "", revision: d.revision });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const changed = groupId !== base.groupId && groupId !== "";

  return (
    <Card title={strings.app.nav.settings}>
      <div className="dash-form">
        <div className="dash-switch-row">
          <div className="dash-switch-row__text">
            <span className="dash-switch-row__title" id="kiosk-label">
              {s.kiosk}
            </span>
            <span className="dash-switch-row__hint">{s.kioskHelp}</span>
          </div>
          {canAct && !d.revoked ? (
            <Switch
              checked={d.kioskEnabled}
              label={d.kioskEnabled ? s.kioskOn : s.kioskOffLabel}
              onChange={(enabled) =>
                setKiosk({ deviceId: d._id, enabled }).catch((e) => toast(messageFor(e), "danger"))
              }
            />
          ) : (
            <Pill tone={d.kioskEnabled ? "success" : "warning"}>{d.kioskEnabled ? s.kioskOn : s.kioskOffLabel}</Pill>
          )}
        </div>
        <hr className="dash-divider" />
        {canAct && !d.revoked ? (
          <form
            className="dash-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!changed || pending) return;
              setPending(true);
              setError(null);
              move({ deviceId: d._id, expectedRevision: base.revision, groupId }).then(
                () => {
                  setPending(false);
                  setBase({ groupId, revision: base.revision + 1 });
                  toast(strings.common.saved);
                },
                (err) => {
                  setPending(false);
                  setError(err);
                },
              );
            }}
          >
            <Field label={s.group}>
              {(p) => (
                <Select {...p} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  {groupId === "" ? <option value="">{strings.devices.noGroup}</option> : null}
                  {d.groups.map((g) => (
                    <option key={g._id} value={g._id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <FormError
              error={error}
              onReload={() => {
                setError(null);
                setGroupId(d.group?._id ?? "");
                setBase({ groupId: d.group?._id ?? "", revision: d.revision });
              }}
            />
            {changed ? (
              <div className="dash-form__actions">
                <Button type="submit" disabled={pending} aria-busy={pending}>
                  {pending ? strings.common.saving : s.move}
                </Button>
                <Button variant="ghost" onClick={() => setGroupId(base.groupId)} disabled={pending}>
                  {strings.common.cancel}
                </Button>
              </div>
            ) : null}
          </form>
        ) : (
          <dl className="dash-kv" style={{ gridTemplateColumns: "1fr" }}>
            <KV label={s.group} value={d.group?.name ?? strings.devices.noGroup} />
          </dl>
        )}
      </div>
    </Card>
  );
}

function RenameDialog({ d, open, onClose }: { d: Detail; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <RenameInner d={d} onClose={onClose} />;
}

function RenameInner({ d, onClose }: { d: Detail; onClose: () => void }) {
  const rename = useRenameDevice();
  const toast = useToast();
  const [name, setName] = useState(d.name);
  const [revision, setRevision] = useState(d.revision);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const invalid = v.name(name, v.NAME_MAX.device);

  return (
    <Modal
      open
      title={s.renameTitle}
      onClose={() => !pending && onClose()}
      onSubmit={() => {
        setTouched(true);
        if (invalid || pending) return;
        setPending(true);
        setError(null);
        rename({ deviceId: d._id, expectedRevision: revision, name: name.trim() }).then(
          () => {
            toast(strings.common.saved);
            onClose();
          },
          (e) => {
            setPending(false);
            setError(e);
          },
        );
      }}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? strings.common.saving : strings.common.save}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={s.renameLabel} error={touched ? invalid : null} required>
          {(p) => <Input {...p} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoComplete="off" />}
        </Field>
        <FormError
          error={error}
          onReload={() => {
            setError(null);
            setName(d.name);
            setRevision(d.revision);
          }}
        />
      </div>
    </Modal>
  );
}

function Danger({ d }: { d: Detail }) {
  const navigate = useNavigate();
  const toast = useToast();
  const revoke = useRevokeDevice();
  const remove = useRemoveDevice();
  const rotate = useRequestRotation();
  const [dialog, setDialog] = useState<"revoke" | "remove" | "rotate" | null>(null);
  return (
    <Card title={s.dangerZone} tone="danger">
      <div className="dash-form">
        {!d.revoked ? (
          <>
            <div className="dash-row dash-row--between">
              <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.rotateBody}</span>
              <Button variant="ghost" onClick={() => setDialog("rotate")} disabled={d.flags.rotateCredential}>
                {s.rotate}
              </Button>
            </div>
            <hr className="dash-divider" />
            <div className="dash-row dash-row--between">
              <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.revokeBody}</span>
              <Button variant="danger-ghost" onClick={() => setDialog("revoke")}>
                {s.revoke}
              </Button>
            </div>
          </>
        ) : (
          <div className="dash-row dash-row--between">
            <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.removeBody}</span>
            <Button variant="danger-ghost" onClick={() => setDialog("remove")}>
              {strings.common.remove}
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={dialog === "rotate"}
        title={s.rotateTitle}
        body={s.rotateBody}
        confirmLabel={s.rotate}
        onConfirm={() => rotate({ deviceId: d._id })}
        onDone={() => toast(s.rotateRequested)}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "revoke"}
        title={s.revokeTitle}
        body={s.revokeBody}
        confirmLabel={s.revoke}
        danger
        typeToConfirm={d.name}
        onConfirm={() => revoke({ deviceId: d._id })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "remove"}
        title={s.removeTitle}
        body={s.removeBody}
        confirmLabel={strings.common.remove}
        danger
        typeToConfirm={d.name}
        onConfirm={() => remove({ deviceId: d._id })}
        onDone={() => {
          toast(s.removed(d.name));
          navigate("/devices", { replace: true });
        }}
        onClose={() => setDialog(null)}
      />
    </Card>
  );
}

