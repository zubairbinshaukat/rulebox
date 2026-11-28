import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useParams } from "react-router";
import IconBack from "~icons/solar/alt-arrow-left-linear";
import { useDeviceLiveness, useDevicePage, useWatchDevice } from "../data";
import type { DeviceLiveness, DevicePage } from "../data/types";
import { PageHeader } from "../components/PageHeader";
import { PageTabPanel, PageTabs, type PageTab } from "../components/PageTabs";
import { QueryRegion } from "../components/Region";
import { Skeleton, SkeletonBlock } from "../components/Skeleton";
import { useMember } from "../lib/member";
import { useNow } from "../lib/useNow";
import { useUrlTab } from "../lib/useUrlTab";
import { DeviceHeader } from "./device/Header";
import OverviewTab from "./device/OverviewTab";
import { presenceOf } from "./device/presence";
import { deviceProblems, problemBadge, type Problem, type ProblemTab } from "./device/problems";
import { deviceText as t } from "./device/strings";
import "./device/device.css";

// Every tab but the Overview is its own chunk (plan D18): the page opens on the Overview, and a tab that is not open loads and
// subscribes nothing.
const AppsTab = lazy(() => import("./device/AppsTab"));
const ProtectionTab = lazy(() => import("./device/ProtectionTab"));
const NetworkTab = lazy(() => import("./device/NetworkTab"));
const ActivityTab = lazy(() => import("./device/ActivityTab"));
const SettingsTab = lazy(() => import("./device/SettingsTab"));

const ALL_TABS = ["overview", "apps", "protection", "network", "activity", "settings"] as const satisfies readonly ProblemTab[];
/** A disconnected PC has nothing to run, protect or send (plan D17). */
const REVOKED_TABS = ["overview", "activity", "settings"] as const satisfies readonly ProblemTab[];

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

/** True while `target` has scrolled up behind the top bar: the tab bar then shows the PC's name (plan D19). */
function useScrolledPast(target: RefObject<HTMLElement | null>): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // The top bar is 64 px high and sticky: the title counts as gone when it slides under it.
    const io = new IntersectionObserver(([e]) => setPast(e !== undefined && !e.isIntersecting && e.boundingClientRect.top < 64), {
      rootMargin: "-64px 0px 0px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [target]);
  return past;
}

export default function DeviceDetail() {
  const { id = "" } = useParams();
  const page = useDevicePage(id);
  // Depends only on the route id, so it subscribes next to `fleet:page` instead of after it.
  const liveness = useDeviceLiveness(id);
  return (
    <div className="dash-page dev">
      {page.status === "error" ? <PageHeader title={t.devicesTitle} back={{ to: "/devices", label: t.back }} /> : null}
      <QueryRegion state={page} skeleton={<PageSkeleton />}>
        {/* Keyed by the route id: another PC starts with a closed disclosure, a fresh header and its own tab state. */}
        {(d) => <Device key={d._id} d={d} live={liveness.status === "ready" ? liveness.data : null} />}
      </QueryRegion>
    </div>
  );
}

function PageSkeleton() {
  return (
    <>
      <div className="dev-head" role="status" aria-label={t.loadingTitle}>
        <Link to="/devices" className="dash-head__back">
          <IconBack aria-hidden="true" />
          {t.back}
        </Link>
        <div className="dev-skel__title">
          <Skeleton width="min(320px, 70%)" height={30} radius={10} />
        </div>
        <div className="dev-head__pills">
          <Skeleton width={120} height={24} radius={12} />
          <Skeleton width={96} height={24} radius={12} />
        </div>
      </div>
      <div className="dev-bar">
        <div className="dev-skel__tabs">
          <Skeleton width={84} height={14} />
          <Skeleton width={56} height={14} />
          <Skeleton width={84} height={14} />
        </div>
      </div>
      <div className="dash-card dash-card--pad">
        <SkeletonBlock lines={6} />
      </div>
    </>
  );
}

/** The problems that belong to the Protection tab (the lockdown ones), for its badge. */
const isLockdownProblem = (p: Problem) => p.id === "lockdownRefused" || p.id === "rolledBack" || p.id === "tooOld" || p.id.startsWith("layer:");

function Device({ d, live }: { d: DevicePage; live: DeviceLiveness | null }) {
  const now = useNow(30_000);
  const { role } = useMember();
  useWatch(d._id, !d.revoked);
  const problems = useMemo(() => deviceProblems(d, live, now, role), [d, live, now, role]);
  const ids: readonly ProblemTab[] = d.revoked ? REVOKED_TABS : ALL_TABS;
  const [tab, setTab] = useUrlTab<ProblemTab>(ids, "overview");
  const [focus, setFocus] = useState<"group" | "remove" | undefined>(undefined);
  const title = useRef<HTMLHeadingElement>(null);
  const scrolled = useScrolledPast(title);

  const openTab = useCallback(
    (next: ProblemTab, to?: "group" | "remove") => {
      setFocus(to);
      setTab(next);
    },
    [setTab],
  );

  const tabs = useMemo<PageTab[]>(() => {
    const badge = problemBadge(problems);
    const lockdown = problemBadge(problems.filter(isLockdownProblem));
    const network = d.network.wifiFailed + d.network.printersFailed;
    const all: Record<ProblemTab, PageTab> = {
      overview: { id: "overview", label: t.tabs.overview, count: badge.count || undefined, tone: badge.danger ? "danger" : "warning" },
      apps: { id: "apps", label: t.tabs.apps, count: d.failedInstalls.count || undefined, tone: "warning" },
      protection: { id: "protection", label: t.tabs.protection, count: lockdown.count || undefined, tone: lockdown.danger ? "danger" : "warning" },
      network: { id: "network", label: t.tabs.network, count: network || undefined, tone: "warning" },
      activity: { id: "activity", label: t.tabs.activity },
      settings: { id: "settings", label: t.tabs.settings },
    };
    return ids.map((id) => all[id]);
  }, [problems, d.network, d.failedInstalls.count, ids]);

  const presence = presenceOf(d, live, now);

  return (
    <>
      <DeviceHeader d={d} live={live} now={now} titleRef={title} />
      <div className="dev-bar" data-scrolled={scrolled || undefined}>
        <PageTabs tabs={tabs} value={tab} onChange={(id) => openTab(id as ProblemTab)} aria-label={t.tabsLabel} idBase="dev" />
        <p className="dev-bar__name" aria-hidden="true">
          <span className="dev-bar__dot" data-tone={presence.tone} />
          <span className="dev-bar__text">{d.name}</span>
        </p>
      </div>
      <PageTabPanel idBase="dev" id={tab}>
        {tab === "overview" ? (
          <OverviewTab d={d} problems={problems} now={now} onTab={openTab} />
        ) : (
          <Suspense fallback={<PanelSkeleton />}>
            {tab === "apps" ? <AppsTab d={d} /> : null}
            {tab === "protection" ? <ProtectionTab d={d} /> : null}
            {tab === "network" ? <NetworkTab d={d} /> : null}
            {tab === "activity" ? <ActivityTab d={d} /> : null}
            {tab === "settings" ? <SettingsTab d={d} focus={focus} /> : null}
          </Suspense>
        )}
      </PageTabPanel>
    </>
  );
}

function PanelSkeleton() {
  return (
    <div className="dash-card dash-card--pad">
      <SkeletonBlock lines={6} />
    </div>
  );
}
