import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-circle-linear";
import IconBack from "~icons/solar/alt-arrow-left-linear";
import { useGroupDetail } from "../data";
import type { AssignmentRow, GroupDetail as Detail } from "../data/types";
import { PageHeader } from "../components/PageHeader";
import { PageTabPanel, PageTabs, type PageTab } from "../components/PageTabs";
import { QueryRegion } from "../components/Region";
import { Skeleton, SkeletonBlock } from "../components/Skeleton";
import { useCan, useMember } from "../lib/member";
import { useNow } from "../lib/useNow";
import { useUrlTab } from "../lib/useUrlTab";
import { AssignmentHost, type AssignmentDialog } from "./group/AssignmentHost";
import { GroupHeader } from "./group/Header";
import OverviewTab from "./group/OverviewTab";
import { useScrolledAway, useScrolledPast } from "./group/hooks";
import { groupProblems, problemBadge } from "./group/problems";
import { groupPage as t } from "./group/strings";
import "./group/group.css";

// Every tab but the Overview is its own chunk: the page opens on the Overview, and a tab that is not open loads and subscribes
// nothing (the PCs and People lists are paginated server queries that run only while their tab is open).
const PcsTab = lazy(() => import("./group/PcsTab"));
const PeopleTab = lazy(() => import("./group/PeopleTab"));
const ActivityTab = lazy(() => import("./group/ActivityTab"));

const TABS = ["overview", "pcs", "people", "activity"] as const;
type Tab = (typeof TABS)[number];

/**
 * `groups:get` for the header and the Overview, and, only while their tab is open, the paginated devices `fleet:list({ groupId })`,
 * employees `employees:list({ groupId })` and the history `audit:forTarget`. Employees: add and remove (each is a signed roster
 * change for the group). Apps: assign, edit audience and pins, unassign.
 */
export default function GroupDetail() {
  const { id = "" } = useParams();
  const detail = useGroupDetail(id);
  return (
    <div className="dash-page grp">
      {detail.status === "error" ? <PageHeader title={t.groupsTitle} back={{ to: "/groups", label: t.back }} /> : null}
      <QueryRegion state={detail} skeleton={<PageSkeleton />}>
        {/* Keyed by the route id: another group starts with a fresh header and its own tab state. */}
        {(g) => <Group key={g._id} g={g} />}
      </QueryRegion>
    </div>
  );
}

function PageSkeleton() {
  return (
    <>
      <div className="grp-head" role="status" aria-label={t.loadingTitle}>
        <Link to="/groups" className="dash-head__back">
          <IconBack aria-hidden="true" />
          {t.back}
        </Link>
        <div className="grp-skel__title">
          <Skeleton width="min(320px, 70%)" height={30} radius={10} />
        </div>
        <Skeleton width="min(420px, 90%)" height={14} />
      </div>
      <div className="grp-bar">
        <div className="grp-skel__tabs">
          <Skeleton width={84} height={14} />
          <Skeleton width={56} height={14} />
          <Skeleton width={72} height={14} />
        </div>
      </div>
      <div className="dash-card dash-card--pad">
        <SkeletonBlock lines={6} />
      </div>
    </>
  );
}

function Group({ g }: { g: Detail }) {
  const now = useNow(60_000);
  const { role } = useMember();
  const admin = useCan("admin");
  const problems = useMemo(() => groupProblems(g, role, now), [g, role, now]);
  const [tab, setTab] = useUrlTab<Tab>(TABS, "overview");
  // The checklist's "Add people" step opens the People tab with the picker already open.
  const [pickPeople, setPickPeople] = useState(false);
  const [dialog, setDialog] = useState<AssignmentDialog | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const scrolled = useScrolledPast(title);
  const mainButtonAway = useScrolledAway(actions);

  const openTab = useCallback(
    (next: Tab, pick = false) => {
      setPickPeople(pick);
      setTab(next);
    },
    [setTab],
  );
  const assign = useCallback(() => setDialog({ kind: "assign" }), []);
  const edit = useCallback((assignment: AssignmentRow) => setDialog({ kind: "edit", assignment }), []);
  const unassign = useCallback((assignment: AssignmentRow) => setDialog({ kind: "unassign", assignment }), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  const tabs = useMemo<PageTab[]>(() => {
    const badge = problemBadge(problems);
    // A count the server caps (500+) is left out of the tab: the tile on the Overview says "500+".
    const count = (n: number) => (n > 0 && n <= 500 ? n : undefined);
    return [
      { id: "overview", label: t.tabs.overview, count: badge.count || undefined, tone: badge.danger ? "danger" : "warning" },
      { id: "pcs", label: t.tabs.pcs, count: count(g.deviceCount) },
      { id: "people", label: t.tabs.people, count: count(g.employeeCount) },
      { id: "activity", label: t.tabs.activity },
    ];
  }, [problems, g.deviceCount, g.employeeCount]);

  return (
    <>
      <GroupHeader g={g} titleRef={title} actionsRef={actions} onAssign={assign} />
      <div className="grp-bar" data-scrolled={scrolled || undefined}>
        <PageTabs tabs={tabs} value={tab} onChange={(id) => openTab(id as Tab)} aria-label={t.tabsLabel} idBase="grp" />
        <p className="grp-bar__name" aria-hidden="true">
          <span className="grp-bar__text">{g.name}</span>
        </p>
      </div>
      <PageTabPanel idBase="grp" id={tab}>
        {tab === "overview" ? (
          <OverviewTab
            g={g}
            problems={problems}
            now={now}
            onTab={openTab}
            onAssign={assign}
            onAddPeople={() => openTab("people", true)}
            onEditApp={edit}
            onUnassign={unassign}
          />
        ) : (
          <Suspense fallback={<PanelSkeleton />}>
            {tab === "pcs" ? <PcsTab groupId={g._id} /> : null}
            {tab === "people" ? <PeopleTab groupId={g._id} startAdding={pickPeople} /> : null}
            {tab === "activity" ? <ActivityTab groupId={g._id} /> : null}
          </Suspense>
        )}
      </PageTabPanel>
      <AssignmentHost g={g} dialog={dialog} onClose={closeDialog} />
      {/* A phone: the header's main button again, at the bottom, once the header has scrolled away. */}
      {admin && tab === "overview" ? (
        <>
          <div className="grp-quick" data-show={mainButtonAway || undefined} aria-hidden={!mainButtonAway} inert={!mainButtonAway}>
            <Button variant="primary" onClick={assign}>
              <IconAdd aria-hidden="true" />
              {t.assignApp}
            </Button>
          </div>
          <div className="grp-quick__space" aria-hidden="true" />
        </>
      ) : null}
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
