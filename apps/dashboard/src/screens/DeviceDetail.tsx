import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Input, Pill, Select, Switch } from "@rulebox/ui";
import IconPen from "~icons/solar/pen-linear";
import IconBell from "~icons/solar/bell-linear";
import {
  useDeviceDetail,
  useDeviceLiveness,
  useMoveDevice,
  useRemoveDevice,
  useRenameDevice,
  useRequestRotation,
  useRetryApp,
  useRevokeDevice,
  useSetKiosk,
  useWatchDevice,
} from "../data";
import { useDeviceInstalls } from "../data/devices";
import type { DeviceDetail as Detail, DeviceInstallRow, DeviceLiveness, DocVersion, QueryState } from "../data/types";
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
import { LockCard } from "./broadcasts/LockCard";
import { LockdownCard, ProtectionCard, UsbAllowCard } from "./lockdown/DeviceCards";
import { SendBroadcastDialog } from "./broadcasts/SendDialog";
import { broadcastStrings } from "./broadcasts/strings";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { ServerTable } from "../components/ServerTable";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { useCan } from "../lib/member";
import { SkeletonBlock } from "../components/Skeleton";
import { useToast } from "../lib/toast";
import { formatDate, formatDateTime, formatGb, formatNumber } from "../lib/format";
import { messageFor } from "../lib/errors";
import { strings } from "../lib/strings";
import { appEditStrings } from "../lib/screenStrings/appEdit";
import { appsStrings } from "../lib/screenStrings/apps";
import { deviceStrings } from "../lib/screenStrings/device";
import { devicesStrings } from "../lib/screenStrings/devices";
import { installStrings } from "../lib/screenStrings/install";
import { kioskPhaseStrings } from "../lib/screenStrings/kioskPhase";
import { shellHealthStrings } from "../lib/screenStrings/shellHealth";
import { useNow } from "../lib/useNow";
import * as v from "../lib/validate";

const s = deviceStrings;

/** The page renews watch mode (`fleet:watch`, 5 minutes) a little before it runs out. */
const WATCH_RENEW_MS = 4 * 60_000;

/** Asks for fast pings while this page is visible (plan 4.9). Errors (rate limit, plan) just leave the normal interval. */
function useWatch(deviceId: string, enabled: boolean) {
  const watch = useWatchDevice();
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === "visible") watch({ deviceId }).catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, WATCH_RENEW_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [watch, deviceId, enabled]);
}

/** "Last contact 20 s ago" from the one `fleet:liveness` row; the minute bucket is shown as it is. */
function LastContact({ liveness }: { liveness: QueryState<DeviceLiveness> }) {
  const at = liveness.status === "ready" ? liveness.data.lastContactAt : null;
  // Loading and a failed query show a dash; "Not seen yet" is only for a PC the server says never pinged.
  const none = liveness.status === "ready" ? strings.common.neverSeen : "—";
  return <KV label={s.lastContact} value={at === null ? <span className="dash-muted">{none}</span> : <RelativeTime ms={at} />} />;
}

export default function DeviceDetail() {
  const { id = "" } = useParams();
  const detail = useDeviceDetail(id);
  // Depends only on the route id, so it subscribes next to `fleet:get` instead of after it.
  const liveness = useDeviceLiveness(id);
  return (
    <div className="dash-page">
      {detail.status === "loading" ? <PageHeader title={strings.app.loading} back={{ to: "/devices", label: s.back }} /> : null}
      {detail.status === "error" ? <PageHeader title={devicesStrings.title} back={{ to: "/devices", label: s.back }} /> : null}
      <QueryRegion
        state={detail}
        skeleton={
          <div className="dash-card dash-card--pad">
            <SkeletonBlock lines={6} />
          </div>
        }
      >
        {(d) => <Device d={d} liveness={liveness} />}
      </QueryRegion>
    </div>
  );
}

function Device({ d, liveness }: { d: Detail; liveness: QueryState<DeviceLiveness> }) {
  const now = useNow(30_000);
  useWatch(d._id, !d.revoked);
  const r = d.report;
  const latest = d.versions[0]?.version;
  const waiting = latest !== undefined && r?.appliedVersion !== latest;
  const [renaming, setRenaming] = useState(false);
  const [messaging, setMessaging] = useState(false);

  return (
    <>
      <PageHeader
        back={{ to: "/devices", label: s.back }}
        title={<span className="dash-wrap">{d.name}</span>}
        meta={
          <>
            <DeviceOnline presence={d.presence} now={now} />
            <KioskCell row={d} />
            {r?.outOfSupport ? <Pill tone="danger">{devicesStrings.outOfSupport}</Pill> : null}
          </>
        }
        actions={
          <RoleGate minRole="admin">
            {d.revoked ? null : (
              <Button variant="ghost" onClick={() => setMessaging(true)}>
                <IconBell aria-hidden="true" />
                {broadcastStrings.sendToPc}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setRenaming(true)}>
              <IconPen aria-hidden="true" />
              {strings.common.rename}
            </Button>
          </RoleGate>
        }
      />
      <RenameDialog d={d} open={renaming} onClose={() => setRenaming(false)} />
      <SendBroadcastDialog open={messaging} target={{ kind: "device", id: d._id, name: d.name }} onClose={() => setMessaging(false)} />

      {d.lock ? <InlineNotice tone="danger" title={s.lockedNotice} /> : null}
      {d.revoked ? <InlineNotice tone="danger" title={s.revoked} /> : null}
      {d.flags.noGroup && !d.revoked ? <InlineNotice tone="warning" title={s.noGroupWarning} /> : null}
      {r?.outOfSupport ? <InlineNotice tone="warning" title={s.outOfSupportWarning} /> : null}
      {r?.kioskError ? <InlineNotice tone="danger" title={s.kioskError(r.kioskError)} /> : null}
      {r?.restartPending ? <InlineNotice tone="accent" title={s.restartPending} /> : null}
      {/* Reported empty (not just missing): the agent has no key to check a signed policy with. */}
      {!d.revoked && r?.trustedKeyIds?.length === 0 ? <InlineNotice tone="warning" title={s.noTrustedKeyTitle} detail={s.noTrustedKeyDetail} /> : null}
      {d.flags.rotateCredential ? <InlineNotice tone="neutral" title={s.rotatePending} /> : null}

      <div className="dash-grid dash-grid--main">
        <div className="dash-stack">
          <Card title={s.status}>
            {/* A PC that has pinged but not reported yet still shows its last contact. */}
            <dl className="dash-kv">
              <LastContact liveness={liveness} />
              {r ? (
                <>
                  <KV label={s.lastReport} value={<RelativeTime ms={r.updatedAt} />} />
                  <KV label={s.agentVersion} value={<span className="dash-mono">{r.agentVersion ?? "—"}</span>} />
                  <KV label={s.windows} value={r.os ? `${r.os} ${r.osBuild ?? ""}` : "—"} />
                  <KV label={s.edition} value={r.osEdition ?? "—"} />
                  <KV label={s.ram} value={r.ramMb ? formatGb(Math.round(r.ramMb / 1024)) : "—"} />
                  <KV label={s.diskFree} value={r.diskFreeGb !== undefined ? formatGb(r.diskFreeGb) : "—"} />
                  <KV label={s.kioskPhase} value={kioskPhaseStrings[r.kioskPhase ?? "unknown"]} />
                  <KV label={s.shellHealth} value={shellHealthStrings[r.shellHealth ?? "unknown"]} />
                  <KV label={s.lockdown} value={r.lockdownLevel ?? "—"} />
                  <KV label={s.trustedKeys} value={<TrustedKeys ids={r.trustedKeyIds} />} />
                </>
              ) : null}
            </dl>
            {r ? null : <EmptyState compact title={s.compatNone} />}
          </Card>

          <LockdownCard deviceId={d._id} />

          <Installs deviceId={d._id} />

          <Card title={s.policy} className="dash-card--tight">
            <div className="dash-form">
              {latest === undefined ? (
                <p className="dash-muted">{s.versionsNone}</p>
              ) : (
                <InlineNotice tone={waiting ? "warning" : "success"} title={waiting ? s.waiting(r?.appliedVersion, latest) : s.upToDate} />
              )}
              {d.versions.length ? (
                <DataTable
                  caption={s.versions}
                  columns={versionCols(r?.appliedVersion)}
                  rows={d.versions}
                  getKey={(ver) => String(ver.version)}
                />
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
                  <KV label={s.protection} value={<ProtectionLevel c={r.compat} />} />
                  <KV label={s.webview2} value={<WebView2Value c={r.compat} />} />
                  <KV label={s.browsers} value={<BrowsersValue c={r.compat} />} />
                </dl>
                {r.compat.protection === "reduced" ? (
                  <InlineNotice tone="neutral" title={s.reducedTitle} detail={s.reducedDetail(missingLayers(r.compat))} />
                ) : null}
                {r.compat.blockers.length === 0 && r.compat.warnings.length === 0 ? (
                  <InlineNotice tone="success" title={s.noIssues} />
                ) : null}
                {r.compat.blockers.length ? (
                  <InlineNotice tone="danger" title={s.blockers} detail={r.compat.blockers.map(s.compatCode).join(" ")} />
                ) : null}
                {r.compat.warnings.length ? (
                  <InlineNotice tone="warning" title={s.warnings} detail={r.compat.warnings.map(s.compatCode).join(" ")} />
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
          <LockCard d={d} />
          <ProtectionCard deviceId={d._id} />
          <UsbAllowCard deviceId={d._id} />
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

/** The recent policy versions (`fleet:get` carries the last few: a small table, no paging). */
function versionCols(applied: number | undefined): Column<DocVersion>[] {
  return [
    { key: "version", header: s.versionCol, primary: true, cell: (v) => <span className="dash-chip dash-mono">v{formatNumber(v.version)}</span> },
    { key: "reason", header: s.versionReason, cell: (v) => v.reason },
    { key: "date", header: s.versionDate, cell: (v) => formatDateTime(v.createdAt) },
    {
      key: "applied",
      header: s.applied,
      isEmpty: (v) => applied !== v.version,
      cell: (v) => (applied === v.version ? <Pill tone="success">{s.applied}</Pill> : null),
    },
  ];
}

/** The key ids the PC reports it trusts (`trustedKeyIds`); missing = an older agent that does not report them. */
function TrustedKeys({ ids }: { ids: string[] | undefined }) {
  if (ids === undefined) return <>—</>;
  if (ids.length === 0) return <>{s.trustedKeysNone}</>;
  return (
    <span className="dash-wrap" title={s.trustedKeysCount(ids.length)}>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 ? ", " : ""}
          <span className="dash-mono">{id}</span>
        </span>
      ))}
    </span>
  );
}

type Compat = NonNullable<NonNullable<Detail["report"]>["compat"]>;

/** The layers the PC cannot use, in words (the agent's `layers`, plan 4.12). */
function missingLayers(c: Compat): string[] {
  const missing: string[] = [];
  if (c.layers?.appLocker === false) missing.push(s.layerAppLocker);
  if (c.layers?.appControl === false) missing.push(s.layerAppControl);
  return missing;
}

function ProtectionLevel({ c }: { c: Compat }) {
  if (c.protection === undefined) return <span className="dash-muted">{s.protectionNotReported}</span>;
  return c.protection === "full" ? (
    <Pill tone="success">{s.protectionFull}</Pill>
  ) : (
    <Pill tone="warning">{s.protectionReduced}</Pill>
  );
}

function WebView2Value({ c }: { c: Compat }) {
  if (c.webview2 === undefined) return <span className="dash-muted">{s.notReported}</span>;
  return c.webview2.present && c.webview2.version ? (
    <span className="dash-mono">{c.webview2.version}</span>
  ) : (
    <span>{s.webview2Missing}</span>
  );
}

function BrowsersValue({ c }: { c: Compat }) {
  if (c.browsers === undefined) return <span className="dash-muted">{s.notReported}</span>;
  const found: string[] = [];
  if (c.browsers.edge) found.push(s.browserEdge);
  if (c.browsers.chrome) found.push(s.browserChrome);
  return <span>{found.length ? found.join(", ") : s.browsersNone}</span>;
}

function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="dash-kv__item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** `fleet:installs`: newest update first, the only order the server knows; no total (one page at a time). */
const INSTALLS_LIST: ListConfig = { sorts: ["updated"], defaultSort: { key: "updated", dir: "desc" }, storage: "local" };

function Installs({ deviceId }: { deviceId: string }) {
  const navigate = useNavigate();
  const paging = useListPaging(useListView(INSTALLS_LIST), { total: null });
  const installs = useDeviceInstalls(deviceId, paging.query);
  const retry = useRetryApp();
  const toast = useToast();
  const canAct = useCan("admin");
  const [confirming, setConfirming] = useState<DeviceInstallRow | null>(null);
  const cols: Column<DeviceInstallRow>[] = [
    {
      key: "app",
      header: appsStrings.colName,
      primary: true,
      cell: (i) => (
        <Link className="dash-link dash-link--plain dash-truncate" to={`/apps/${i.appId}`}>
          {i.appName}
        </Link>
      ),
    },
    { key: "state", header: appEditStrings.installState, cell: (i) => <InstallStatePill state={i.state} /> },
    {
      key: "detail",
      header: strings.common.details,
      isEmpty: (i) => i.state !== "failed",
      cell: (i) => (i.state === "failed" ? <span className="dash-muted" style={{ fontSize: 13 }}>{installDetail(i.detail)}</span> : null),
    },
    { key: "updated", header: s.colUpdated, sortable: true, sortDefaultDir: "desc", cell: (i) => <RelativeTime ms={i.updatedAt} /> },
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
            disabled={i.retryable === false}
            title={i.retryable === false ? installStrings.retryUnavailable : undefined}
            onClick={() => setConfirming(i)}
          >
            {installStrings.retry}
          </Button>
        ) : null,
    },
  ];
  return (
    <Card title={s.installs} body="none" className="dash-card--tight">
      {/* `apps:retry` restarts the app for every PC, so it is confirmed first. */}
      <ConfirmDialog
        open={confirming !== null}
        title={installStrings.retryConfirmTitle(confirming?.appName ?? "")}
        body={installStrings.retryConfirmBody(confirming?.appName ?? "")}
        confirmLabel={installStrings.retryConfirmAction}
        onConfirm={() => retry({ appId: confirming?.appId ?? "" })}
        onDone={() => toast(installStrings.retried)}
        onClose={() => setConfirming(null)}
      />
      <ServerTable
        caption={s.installs}
        columns={cols}
        getKey={(i) => i._id}
        paging={paging}
        list={installs}
        total={null}
        onRowClick={(i) => navigate(`/apps/${i.appId}`)}
        empty={<EmptyState compact title={s.installsNone} />}
        skeletonRows={3}
      />
    </Card>
  );
}

function Settings({ d }: { d: Detail }) {
  const canAct = useCan("admin");
  const setKiosk = useSetKiosk();
  const move = useMoveDevice();
  const toast = useToast();
  const [groupId, setGroupId] = useState(d.group?._id ?? "");
  const [base, setBase] = useState({ groupId: d.group?._id ?? "" });
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
                setKiosk({ deviceId: d._id, expectedRevision: d.revision, enabled }).catch((e) => toast(messageFor(e), "danger"))
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
              move({ deviceId: d._id, expectedRevision: d.revision, groupId }).then(
                () => {
                  setPending(false);
                  setBase({ groupId });
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
                  {groupId === "" ? <option value="">{devicesStrings.noGroup}</option> : null}
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
                setBase({ groupId: d.group?._id ?? "" });
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
            <KV label={s.group} value={d.group?.name ?? devicesStrings.noGroup} />
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

