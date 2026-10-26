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
import IconCheck from "~icons/solar/check-circle-linear";
import IconAdd from "~icons/solar/add-square-linear";
import IconUserPlus from "~icons/solar/user-plus-rounded-linear";
import IconWidgetAdd from "~icons/solar/widget-add-linear";
import IconRight from "~icons/solar/alt-arrow-right-linear";
import { useOverview } from "../data";
import type { OverviewScreen } from "../data/types";
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
import { onlineWindowMs } from "../lib/online";
import { strings } from "../lib/strings";
import { minuteOf, useNow } from "../lib/useNow";

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

function attentionOf(o: OverviewScreen): Attention[] {
  const out: Attention[] = [];
  if (o.signing.state === "none") {
    out.push({ key: "key", icon: IconKey, tone: "danger", title: s.noKeyTitle, detail: s.noKeyDetail, action: { to: "/settings?tab=signing", label: s.noKeyAction } });
  } else if (o.signing.state === "rotating") {
    out.push({ key: "rot", icon: IconKey, tone: "accent", title: s.rotatingTitle, detail: s.rotatingDetail, action: { to: "/settings?tab=signing", label: strings.common.open } });
  }
  if (o.publishFailedAt) {
    out.push({ key: "pub", icon: IconDanger, tone: "danger", title: s.publishFailedTitle, detail: s.publishFailedDetail, action: { to: "/audit", label: strings.app.nav.audit } });
  }
  if (o.devicesWithoutGroup > 0) {
    out.push({ key: "grp", icon: IconLayers, tone: "warning", title: s.noGroupTitle(o.devicesWithoutGroup), detail: s.noGroupDetail, action: { to: "/devices?group=none", label: s.noGroupAction } });
  }
  if (o.deviceCount > 300) {
    out.push({ key: "big", icon: IconWarn, tone: "warning", title: s.largeFleetTitle, detail: s.largeFleetDetail });
  }
  if (o.deviceCount > 0) {
    out.push({ key: "oos", icon: IconShield, tone: "accent", title: s.outOfSupportTitle, detail: s.outOfSupportDetail, action: { to: "/devices", label: s.noGroupAction } });
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

/** `overview:get`: totals, attention list, failed installs, recent activity. */
export default function Overview() {
  const now = useNow(30_000);
  const overview = useOverview(minuteOf(now));

  const lead = (() => {
    if (overview.status !== "ready") return undefined;
    const o = overview.data;
    const urgent = attentionOf(o).filter((a) => a.tone !== "accent").length + (o.failedInstalls.length > 0 ? 1 : 0);
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
                <Stat to="/devices" icon={IconMonitor} value={formatCount(o.deviceCount)} label={s.devices} />
                <Stat
                  to="/devices"
                  icon={IconPulse}
                  value={formatCount(o.seenRecently, 1000)}
                  label={s.seenRecently}
                  hint={s.seenRecentlyHint(onlineWindowMs(o.pingIntervalMs))}
                />
                <Stat to="/employees" icon={IconUsers} value={formatCount(o.employeeCount)} label={s.employees} />
                <Stat to="/apps" icon={IconWidget} value={formatCount(o.appCount)} label={s.apps} hint={strings.counts.groups(o.groupCount)} />
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

                  <Card title={s.failedInstalls} body="flush" actions={o.failedInstalls.length ? <span className="dash-chip">{formatCount(o.failedInstalls.length, 19)}</span> : null}>
                    {o.failedInstalls.length === 0 ? (
                      <EmptyState compact icon={<IconCheck />} title={s.failedInstallsNone} />
                    ) : (
                      <ul className="dash-list">
                        {o.failedInstalls.map((f) => (
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
                    )}
                  </Card>
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
