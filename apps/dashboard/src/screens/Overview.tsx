import type { ComponentType, ReactNode, SVGProps } from "react";
import { Link } from "react-router";
import IconMonitor from "~icons/solar/monitor-linear";
import IconPulse from "~icons/solar/wi-fi-router-minimalistic-linear";
import IconUsers from "~icons/solar/users-group-rounded-linear";
import IconWidget from "~icons/solar/widget-2-linear";
import IconKey from "~icons/solar/key-minimalistic-linear";
import IconLayers from "~icons/solar/layers-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import IconDanger from "~icons/solar/danger-circle-linear";
import IconShield from "~icons/solar/shield-warning-linear";
import IconUserWarn from "~icons/solar/user-block-rounded-linear";
import IconCheck from "~icons/solar/check-circle-linear";
import IconAdd from "~icons/solar/add-square-linear";
import IconUserPlus from "~icons/solar/user-plus-rounded-linear";
import IconWidgetAdd from "~icons/solar/widget-add-linear";
import IconRight from "~icons/solar/alt-arrow-right-linear";
import { useFailedInstalls, useOverview } from "../data";
import { NO_GROUP_FILTER, type OverviewScreen } from "../data/types";
import { AuditTimelineItem } from "../components/AuditItem";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { installDetail } from "../lib/install";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { SkeletonRows, SkeletonStats } from "../components/Skeleton";
import { formatCount } from "../lib/format";
import { strings } from "../lib/strings";
import { useNow } from "../lib/useNow";

const s = strings.overview;
type Icon = ComponentType<SVGProps<SVGSVGElement>>;

interface Attention {
  key: string;
  icon: Icon;
  tone: "warning" | "danger" | "accent";
  title: string;
  detail: string;
  action?: { to: string; label: string };
}

/** A limit this large means "no limit" (`UNLIMITED` of convex/lib/plans.ts): never a banner. */
const NO_LIMIT = 1_000_000;

const LIMITED = [
  { kind: "devices", count: (c: OverviewScreen["counts"]) => c.deviceCount, max: (l: OverviewScreen["plan"]["limits"]) => l.maxDevices },
  { kind: "employees", count: (c: OverviewScreen["counts"]) => c.employeeCount, max: (l: OverviewScreen["plan"]["limits"]) => l.maxEmployees },
  { kind: "apps", count: (c: OverviewScreen["counts"]) => c.appCount, max: (l: OverviewScreen["plan"]["limits"]) => l.maxApps },
  { kind: "groups", count: (c: OverviewScreen["counts"]) => c.groupCount, max: (l: OverviewScreen["plan"]["limits"]) => l.maxGroups },
] as const;

function attentionOf(o: OverviewScreen): Attention[] {
  const out: Attention[] = [];
  const c = o.counts;
  if (o.signing === "none") {
    out.push({ key: "key", icon: IconKey, tone: "danger", title: s.noKeyTitle, detail: s.noKeyDetail, action: { to: "/settings?tab=signing", label: s.noKeyAction } });
  } else if (o.signing === "rotating") {
    out.push({ key: "rot", icon: IconKey, tone: "accent", title: s.rotatingTitle, detail: s.rotatingDetail, action: { to: "/settings?tab=signing", label: strings.common.open } });
  }
  if (o.publishFailedAt !== null) {
    out.push({ key: "pub", icon: IconDanger, tone: "danger", title: s.publishFailedTitle, detail: s.publishFailedDetail, action: { to: "/settings?tab=signing", label: strings.common.open } });
  }
  if (o.rosterPending) {
    out.push({ key: "roster", icon: IconUserWarn, tone: "warning", title: s.rosterPendingTitle, detail: s.rosterPendingDetail, action: { to: "/settings?tab=signing", label: s.noKeyAction } });
  }
  if (o.plan.status !== "active") {
    out.push({ key: "susp", icon: IconDanger, tone: "danger", title: s.suspendedTitle, detail: s.suspendedDetail });
  }
  for (const l of LIMITED) {
    const max = l.max(o.plan.limits);
    if (max >= NO_LIMIT) continue;
    const count = l.count(c);
    // Exactly at the limit is information (nothing is wrong, nothing more can be added); only over it is urgent.
    if (count > max) {
      out.push({ key: `limit-${l.kind}`, icon: IconWarn, tone: "warning", title: s.overLimitTitle(s.limitKinds[l.kind]), detail: s.overLimitDetail });
    } else if (count === max) {
      out.push({ key: `limit-${l.kind}`, icon: IconWarn, tone: "accent", title: s.limitTitle(s.limitKinds[l.kind]), detail: s.limitDetail });
    }
  }
  if (c.noGroupDeviceCount > 0) {
    out.push({ key: "grp", icon: IconLayers, tone: "warning", title: s.noGroupTitle(c.noGroupDeviceCount), detail: s.noGroupDetail, action: { to: `/devices?group=${NO_GROUP_FILTER}`, label: s.noGroupAction } });
  }
  if (c.deviceCount > 300) {
    out.push({ key: "big", icon: IconWarn, tone: "warning", title: s.largeFleetTitle, detail: s.largeFleetDetail });
  }
  if (c.outOfSupportCount > 0) {
    out.push({ key: "oos", icon: IconShield, tone: "accent", title: s.outOfSupportTitle(c.outOfSupportCount), detail: s.outOfSupportDetail, action: { to: "/devices", label: s.outOfSupportAction } });
  }
  return out;
}

function partOfDay(now: number): "morning" | "afternoon" | "evening" {
  const h = new Date(now).getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

function Stat({ to, icon: I, value, label, hint }: { to: string; icon: Icon; value: string; label: string; hint?: ReactNode }) {
  return (
    <Link to={to} className="dash-stat">
      <span className="dash-stat__icon" aria-hidden="true">
        <I />
      </span>
      <span className="dash-stat__value">{value}</span>
      <span className="dash-stat__label">{label}</span>
      {hint ? <span className="dash-stat__hint">{hint}</span> : null}
    </Link>
  );
}

/**
 * The failed-installs card. Its list (`overview:failedInstalls`) is subscribed
 * only while the counter of `overview:get` says something failed, so an
 * organization with nothing failed never reads an install result.
 */
function FailedInstalls({ count }: { count: number }) {
  const failed = useFailedInstalls(count > 0);
  return (
    <Card title={s.failedInstalls} body="flush" actions={count > 0 ? <span className="dash-chip">{formatCount(count, 999)}</span> : null}>
      {count === 0 ? (
        <EmptyState compact icon={<IconCheck />} title={s.failedInstallsNone} />
      ) : (
        <QueryRegion state={failed} skeleton={<SkeletonRows rows={3} columns={2} />}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState compact icon={<IconCheck />} title={s.failedInstallsNone} />
            ) : (
              <>
                <ul className="dash-list">
                  {rows.map((f) => (
                    <li key={f._id} className="dash-list__item">
                      <span className="dash-list__icon dash-list__icon--danger" aria-hidden="true">
                        <IconDanger />
                      </span>
                      <div className="dash-list__body">
                        <p className="dash-list__title dash-truncate">
                          <Link className="dash-link dash-link--plain" to={`/apps/${f.appId}`}>
                            {f.appName}
                          </Link>{" "}
                          <span className="dash-muted">·</span>{" "}
                          <Link className="dash-link" to={`/devices/${f.deviceId}`}>
                            {f.deviceName}
                          </Link>
                        </p>
                        <p className="dash-list__meta">
                          {installDetail(f.detail)} · <RelativeTime ms={f.updatedAt} />
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                {count > rows.length ? <p className="dash-list__meta" style={{ padding: "10px clamp(16px, 2vw, 22px)" }}>{s.failedInstallsShown(rows.length, count)}</p> : null}
              </>
            )
          }
        </QueryRegion>
      )}
    </Card>
  );
}

/** `overview:get`: totals, attention list, recent activity; the failed installs are their own card. */
export default function Overview() {
  const now = useNow(60_000);
  const overview = useOverview();

  const lead = (() => {
    if (overview.status !== "ready") return undefined;
    const o = overview.data;
    const urgent = attentionOf(o).filter((a) => a.tone !== "accent").length + (o.counts.failedInstallCount > 0 ? 1 : 0);
    return urgent ? s.leadAttention(urgent) : s.leadCalm;
  })();

  return (
    <div className="dash-page">
      <PageHeader
        title={s.greeting(partOfDay(now))}
        lead={lead}
        actions={
                  <RoleGate minRole="admin">
                    <Link to="/enrollment" className="rb-btn rb-btn--ghost">
                      <IconAdd aria-hidden="true" />
                      {s.addPc}
                    </Link>
                    <Link to="/employees/new" className="rb-btn rb-btn--ghost">
                      <IconUserPlus aria-hidden="true" />
                      {s.addEmployee}
                    </Link>
                    <Link to="/apps/new?kind=web" className="rb-btn rb-btn--primary">
                      <IconWidgetAdd aria-hidden="true" />
                      {s.addApp}
                    </Link>
          </RoleGate>
        }
      />
      <QueryRegion
        state={overview}
        skeleton={<SkeletonStats />}
      >
        {(o) => {
          const attention = attentionOf(o);
          return (
            <>
              <div className="dash-stats">
                <Stat to="/devices" icon={IconMonitor} value={formatCount(o.counts.deviceCount)} label={s.devices} />
                <Stat to="/devices" icon={IconPulse} value={formatCount(o.onlineCount)} label={s.online} hint={s.onlineOf(o.counts.deviceCount)} />
                <Stat to="/employees" icon={IconUsers} value={formatCount(o.counts.employeeCount)} label={s.employees} />
                <Stat to="/apps" icon={IconWidget} value={formatCount(o.counts.appCount)} label={s.apps} hint={strings.counts.groups(o.counts.groupCount)} />
              </div>

              <div className="dash-grid dash-grid--main">
                <div className="dash-stack">
                  <Card title={s.attention} body="flush">
                    {attention.length === 0 ? (
                      <EmptyState compact title={s.attentionNone} />
                    ) : (
                      <ul className="dash-list">
                        {attention.map((a) => (
                          <li key={a.key} className="dash-list__item">
                            <span className={`dash-list__icon dash-list__icon--${a.tone}`} aria-hidden="true">
                              <a.icon />
                            </span>
                            <div className="dash-list__body">
                              <p className="dash-list__title">{a.title}</p>
                              <p className="dash-list__meta">{a.detail}</p>
                            </div>
                            {a.action ? (
                              <Link to={a.action.to} className="rb-btn rb-btn--ghost dash-btn--sm">
                                {a.action.label}
                              </Link>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>

                  <FailedInstalls count={o.counts.failedInstallCount} />
                </div>

                <Card
                  title={s.recentActivity}
                  body="flush"
                  actions={
                    <Link to="/audit" className="rb-btn dash-btn--quiet dash-btn--sm">
                      {strings.common.viewAll}
                      <IconRight aria-hidden="true" />
                    </Link>
                  }
                >
                  {o.recentAudit.length === 0 ? (
                    <EmptyState compact title={s.recentActivityNone} />
                  ) : (
                    <ul className="dash-timeline">
                      {o.recentAudit.map((e) => (
                        <AuditTimelineItem key={e._id} entry={e} />
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </>
          );
        }}
      </QueryRegion>
      {overview.status === "loading" ? (
        <div className="dash-card">
          <SkeletonRows rows={5} />
        </div>
      ) : null}
    </div>
  );
}
