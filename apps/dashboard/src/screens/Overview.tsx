import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router";
import IconCheck from "~icons/solar/check-circle-linear";
import IconDanger from "~icons/solar/danger-circle-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import IconMonitor from "~icons/solar/monitor-linear";
import IconUsers from "~icons/solar/users-group-rounded-linear";
import IconWidget from "~icons/solar/widget-2-linear";
import IconAdd from "~icons/solar/add-square-linear";
import IconUserPlus from "~icons/solar/user-plus-rounded-linear";
import IconWidgetAdd from "~icons/solar/widget-add-linear";
import IconRight from "~icons/solar/alt-arrow-right-linear";
import { useFailedInstallsPage, useOverview } from "../data";
import { NO_GROUP_FILTER, type FailedInstallRow, type LockdownWarnings, type OverviewScreen } from "../data/types";
import { AuditTimelineItem } from "../components/AuditItem";
import { AttentionList, type AttentionItem } from "../components/AttentionList";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { Skeleton, SkeletonRows } from "../components/Skeleton";
import { StatTile, StatTiles } from "../components/StatTile";
import { installDetail } from "../lib/install";
import { formatCount } from "../lib/format";
import { useCan } from "../lib/member";
import { strings } from "../lib/strings";
import { useNow } from "../lib/useNow";
import { overviewText as s } from "./overview/text";
import "./overview/overview.css";

// What the first look does not need loads when it is used: the lockdown lines (only when there are some), the list of every failed
// install (on "See all") and the phone's Add menu.
const FailedInstallsDialog = lazy(() => import("./overview/FailedInstallsDialog"));
const MoreMenu = lazy(() => import("../components/MoreMenu").then((m) => ({ default: m.MoreMenu })));
type LockdownModule = typeof import("./overview/LockdownAttention");

/** How many kinds of lockdown warnings the overview has (0 to 3; an older server sends none). */
function lockdownKinds(l: LockdownWarnings | undefined): number {
  return l ? +(l.notApplied.length > 0) + +(l.halted.length > 0) + +(l.auditOverdue.length > 0) : 0;
}

/** A limit this large means "no limit" (`UNLIMITED` of convex/lib/plans.ts): never a banner. */
const NO_LIMIT = 1_000_000;
/** Above this many PCs the free database plan may not be enough: told to owners, who can talk to the provider. */
const LARGE_FLEET = 300;

const LIMITED = [
  { kind: "devices", count: (c: OverviewScreen["counts"]) => c.deviceCount, max: (l: OverviewScreen["plan"]["limits"]) => l.maxDevices },
  { kind: "employees", count: (c: OverviewScreen["counts"]) => c.employeeCount, max: (l: OverviewScreen["plan"]["limits"]) => l.maxEmployees },
  { kind: "apps", count: (c: OverviewScreen["counts"]) => c.appCount, max: (l: OverviewScreen["plan"]["limits"]) => l.maxApps },
  { kind: "groups", count: (c: OverviewScreen["counts"]) => c.groupCount, max: (l: OverviewScreen["plan"]["limits"]) => l.maxGroups },
] as const;

const settings = (label: string = s.openSettings) => ({ to: "/settings?tab=signing", label });

/** Everything that needs the person, as cards: danger first, then warnings, then notes (the list sorts them). */
function attentionOf(o: OverviewScreen, isOwner: boolean): AttentionItem[] {
  const out: AttentionItem[] = [];
  const c = o.counts;
  if (o.signing === "none") {
    out.push({ key: "key", tone: "danger", title: s.noKeyTitle, body: s.noKeyDetail, action: settings() });
  } else if (o.signing === "rotating") {
    out.push({ key: "rot", tone: "info", title: s.rotatingTitle, body: s.rotatingDetail, action: settings() });
  }
  if (o.publishFailedAt !== null) {
    out.push({ key: "pub", tone: "danger", title: s.publishFailedTitle, body: s.publishFailedDetail, action: settings() });
  }
  if (o.rosterPending) {
    out.push({ key: "roster", tone: "warning", title: s.rosterPendingTitle, body: s.rosterPendingDetail, action: settings() });
  }
  if (o.plan.status !== "active") {
    out.push({ key: "susp", tone: "danger", title: s.suspendedTitle, body: s.suspendedDetail });
  }
  for (const l of LIMITED) {
    const max = l.max(o.plan.limits);
    if (max >= NO_LIMIT) continue;
    const count = l.count(c);
    // Exactly at the limit is information (nothing is wrong, nothing more can be added); only over it is urgent.
    if (count > max) {
      out.push({ key: `limit-${l.kind}`, tone: "warning", title: s.overLimitTitle(s.limitKinds[l.kind]), body: s.overLimitDetail });
    } else if (count === max) {
      out.push({ key: `limit-${l.kind}`, tone: "info", title: s.limitTitle(s.limitKinds[l.kind]), body: s.limitDetail });
    }
  }
  if (c.noGroupDeviceCount > 0) {
    out.push({ key: "grp", tone: "warning", title: s.noGroupTitle(c.noGroupDeviceCount), body: s.noGroupDetail, action: { to: `/devices?group=${NO_GROUP_FILTER}`, label: s.noGroupAction } });
  }
  if (isOwner && c.deviceCount > LARGE_FLEET) {
    out.push({ key: "big", tone: "info", title: s.largeFleetTitle, body: s.largeFleetDetail });
  }
  if (c.outOfSupportCount > 0) {
    out.push({ key: "oos", tone: "info", title: s.outOfSupportTitle(c.outOfSupportCount), body: s.outOfSupportDetail, action: { to: "/devices", label: s.outOfSupportAction } });
  }
  return out;
}

/**
 * The lockdown lines are a chunk of their own: it loads only when `overview:get` names a warning, and the lines join the other
 * cards when it arrives. Until then `pending` is true, so the list does not claim that nothing needs the person.
 */
function useLockdownItems(w: LockdownWarnings | undefined): { items: AttentionItem[]; pending: boolean } {
  const wanted = lockdownKinds(w) > 0;
  const [mod, setMod] = useState<LockdownModule | null>(null);
  useEffect(() => {
    if (!wanted || mod !== null) return;
    let live = true;
    void import("./overview/LockdownAttention").then((m) => {
      if (live) setMod(m);
    });
    return () => {
      live = false;
    };
  }, [wanted, mod]);
  const items = useMemo(() => (wanted && mod && w ? mod.lockdownItems(w) : []), [wanted, mod, w]);
  return { items, pending: wanted && mod === null };
}

function partOfDay(now: number): "morning" | "afternoon" | "evening" {
  const h = new Date(now).getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

const PHONE = "(max-width: 599px)";
function usePhone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(PHONE);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches,
    () => false,
  );
}

/** Add a PC, Add employee, Add app: three buttons from a tablet up, one "Add" button with a menu on a phone. */
function AddActions() {
  const phone = usePhone();
  if (phone) {
    return (
      <Suspense fallback={<span className="rb-btn rb-btn--primary hm-add" aria-hidden="true">{s.addMenu}</span>}>
        <MoreMenu
          label={s.addMenu}
          className="rb-btn rb-btn--primary hm-add"
          items={[
            { label: s.addPc, icon: <IconAdd aria-hidden="true" />, to: "/enrollment" },
            { label: s.addEmployee, icon: <IconUserPlus aria-hidden="true" />, to: "/employees/new" },
            { label: s.addApp, icon: <IconWidgetAdd aria-hidden="true" />, to: "/apps/new" },
          ]}
        >
          <IconAdd aria-hidden="true" />
          {s.addMenu}
        </MoreMenu>
      </Suspense>
    );
  }
  return (
    <>
      <Link to="/enrollment" className="rb-btn rb-btn--ghost">
        <IconAdd aria-hidden="true" />
        {s.addPc}
      </Link>
      <Link to="/employees/new" className="rb-btn rb-btn--ghost">
        <IconUserPlus aria-hidden="true" />
        {s.addEmployee}
      </Link>
      <Link to="/apps/new" className="rb-btn rb-btn--primary">
        <IconWidgetAdd aria-hidden="true" />
        {s.addApp}
      </Link>
    </>
  );
}

/** The one line under the greeting: how things are, in words and a colour. */
function Status({ tone, children }: { tone: "ok" | "warning" | "danger"; children: ReactNode }) {
  const Glyph = tone === "ok" ? IconCheck : tone === "danger" ? IconDanger : IconWarn;
  return (
    <span className="hm-status" data-tone={tone}>
      <span className="hm-status__icon" aria-hidden="true">
        <Glyph />
      </span>
      <span>{children}</span>
    </span>
  );
}

/** The newest five failed installs, one line each. The rest is behind "See all" (a dialog with the table). */
function FailedCard({ count, paused, onSeeAll }: { count: number; paused: boolean; onSeeAll: () => void }) {
  const failed = useFailedInstallsPage({ sort: { key: "updated", dir: "desc" }, search: "", numItems: 5, cursor: null, enabled: count > 0 && !paused });
  // While the dialog is open its own list is the only one subscribed; this card keeps showing what it had.
  const [kept, setKept] = useState<FailedInstallRow[] | null>(null);
  if (!paused && failed.status === "ready" && failed.items !== kept) setKept(failed.items);
  const rows = paused ? kept : failed.status === "ready" ? failed.items : null;
  return (
    <Card
      title={s.failedInstalls}
      body="flush"
      className="hm-failed"
      actions={
        count > 5 ? (
          <button type="button" className="rb-btn dash-btn--quiet dash-btn--sm" onClick={onSeeAll}>
            {s.seeAll(count)}
            <IconRight aria-hidden="true" />
          </button>
        ) : null
      }
    >
      {count === 0 ? (
        <EmptyState compact icon={<IconCheck />} title={s.failedInstallsNone} />
      ) : rows === null ? (
        <SkeletonRows rows={3} columns={2} />
      ) : (
        <ul className="hm-fail">
          {rows.slice(0, 5).map((f) => (
            <li key={f._id} className="hm-fail__item">
              <div className="hm-fail__text">
                <p className="hm-fail__title">
                  <Link className="dash-link dash-link--plain" to={`/apps/${f.appId}`}>
                    {f.appName}
                  </Link>{" "}
                  {s.on}{" "}
                  <Link className="dash-link dash-link--plain" to={`/devices/${f.deviceId}`}>
                    {f.deviceName}
                  </Link>
                </p>
                <p className="hm-fail__why" title={installDetail(f.detail)}>
                  {installDetail(f.detail)}
                </p>
              </div>
              <span className="hm-fail__when">
                <RelativeTime ms={f.updatedAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="hm-skeleton" role="status" aria-label={strings.app.loading}>
      <div className="hm-skeleton__tiles">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} width="100%" height={72} radius={16} />
        ))}
      </div>
      <div className="dash-card">
        <SkeletonRows rows={4} />
      </div>
    </div>
  );
}

/** `overview:get`: totals, what needs the person, recent activity; the failed installs are a card with a list of their own. */
export default function Overview() {
  const now = useNow(60_000);
  const overview = useOverview();
  const isOwner = useCan("owner");
  const lockdown = useLockdownItems(overview.status === "ready" ? overview.data.lockdown : undefined);
  const [seeingAll, setSeeingAll] = useState(false);

  return (
    <div className="dash-page hm">
      <PageHeader
        title={s.greeting(partOfDay(now))}
        lead={
          overview.status === "ready" ? (
            <StatusLine o={overview.data} isOwner={isOwner} lockdownKinds={lockdownKinds(overview.data.lockdown)} />
          ) : undefined
        }
        actions={
          <RoleGate minRole="admin">
            <AddActions />
          </RoleGate>
        }
      />
      <QueryRegion state={overview} skeleton={<OverviewSkeleton />}>
        {(o) => {
          const items = [...attentionOf(o, isOwner), ...lockdown.items];
          const failed = o.counts.failedInstallCount;
          return (
            <>
              <StatTiles label={s.tilesLabel} className="hm-tiles">
                <StatTile label={s.pcs} value={formatCount(o.counts.deviceCount)} sub={s.pcsOnline(o.onlineCount)} icon={<IconMonitor />} to="/devices" />
                <StatTile label={s.employees} value={formatCount(o.counts.employeeCount)} icon={<IconUsers />} to="/employees" index={1} />
                <StatTile label={s.apps} value={formatCount(o.counts.appCount)} sub={s.inGroups(o.counts.groupCount)} icon={<IconWidget />} to="/apps" index={2} />
                {failed > 0 ? (
                  <StatTile label={s.failedTile} value={formatCount(failed, 999)} sub={s.failedTileSub} icon={<IconWarn />} tone="warning" onClick={() => setSeeingAll(true)} index={3} />
                ) : (
                  <StatTile label={s.failedTile} value="0" sub={s.failedTileNone} icon={<IconCheck />} tone="ok" index={3} />
                )}
              </StatTiles>

              <div className="hm-body">
                <section className="hm-attention" aria-labelledby="hm-attention">
                  <h2 id="hm-attention" className="dash-section-title">
                    {s.attention}
                    {items.length > 0 ? (
                      <span className="hm-count" data-tone={items.some((i) => i.tone === "danger") ? "danger" : items.some((i) => i.tone === "warning") ? "warning" : "info"}>
                        {items.length}
                      </span>
                    ) : null}
                  </h2>
                  {lockdown.pending && items.length === 0 ? (
                    <SkeletonRows rows={1} columns={2} />
                  ) : (
                    <AttentionList items={items} label={s.attentionLabel} emptyText={s.attentionNone} />
                  )}
                </section>

                <FailedCard count={failed} paused={seeingAll} onSeeAll={() => setSeeingAll(true)} />

                <Card
                  title={s.recentActivity}
                  body="flush"
                  className="hm-activity"
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
              {seeingAll ? (
                <Suspense fallback={null}>
                  <FailedInstallsDialog count={failed} onClose={() => setSeeingAll(false)} />
                </Suspense>
              ) : null}
            </>
          );
        }}
      </QueryRegion>
    </div>
  );
}

function StatusLine({ o, isOwner, lockdownKinds: kinds }: { o: OverviewScreen; isOwner: boolean; lockdownKinds: number }) {
  const attention = attentionOf(o, isOwner);
  const urgent = attention.filter((a) => a.tone !== "info").length + (o.counts.failedInstallCount > 0 ? 1 : 0) + kinds;
  if (urgent > 0) {
    const danger = attention.some((a) => a.tone === "danger") || (o.lockdown?.notApplied.length ?? 0) > 0;
    return <Status tone={danger ? "danger" : "warning"}>{s.statusAttention(urgent)}</Status>;
  }
  if (o.counts.deviceCount === 0) {
    return (
      <Status tone="ok">
        {s.statusWelcome}{" "}
        <RoleGate minRole="admin">
          <Link to="/enrollment" className="dash-link">
            {s.addFirstPc}
          </Link>
        </RoleGate>
      </Status>
    );
  }
  return <Status tone="ok">{s.statusCalm(o.counts.deviceCount)}</Status>;
}
