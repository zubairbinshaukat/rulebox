import { lazy, Suspense } from "react";
import { useParams, useSearchParams } from "react-router";
import { useAppDetail } from "../data";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { appEditStrings as s } from "../lib/screenStrings/appEdit";
import { appsStrings } from "../lib/screenStrings/apps";
import { strings } from "../lib/strings";

// The route is a thin switch (UI pass, add-app plan step 15, D26): every screen is a chunk of its own, so the route chunk stays small and
// a person adding a Windows app never loads the website form, nor the other way round.
const AddAppStart = lazy(() => import("./apps/AddAppStart"));
const DesktopAdd = lazy(() => import("./apps/desktop/DesktopAdd"));
const AppPage = lazy(() => import("./apps/page/AppPage"));
// Websites keep today's single-page form until the website form with the site-access picker takes their place inside `AppPage`.
const LegacyWebEdit = lazy(() => import("./apps/LegacyWebEdit"));

const wait = (
  <div className="dash-page" data-suspense="">
    <div className="dash-card dash-card--pad">
      <SkeletonBlock lines={6} />
    </div>
  </div>
);

/**
 * `/apps/new` (the start page with the popular apps), `/apps/new?kind=desktop&gallery=|winget=|source=` (the Windows app review),
 * `/apps/new?kind=web` (a website), `/apps/:id` (the app's page).
 */
export default function AppEdit() {
  const { id = "new" } = useParams();
  const [params] = useSearchParams();
  const isNew = id === "new";
  const detail = useAppDetail(isNew ? "new" : id);
  const kind = params.get("kind");

  if (isNew && kind !== "web") return <Suspense fallback={wait}>{kind === "desktop" ? <DesktopAdd /> : <AddAppStart />}</Suspense>;

  return (
    <div className="dash-page">
      {detail.status !== "ready" ? (
        <PageHeader title={detail.status === "loading" ? strings.app.loading : appsStrings.title} back={{ to: "/apps", label: s.back }} />
      ) : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
        {(d) => (
          <Suspense fallback={<div className="dash-card dash-card--pad" data-suspense=""><SkeletonBlock lines={6} /></div>}>
            {isNew || d.kind === "web" ? <LegacyWebEdit key={d._id} d={d} isNew={isNew} /> : <AppPage key={d._id} d={d} />}
          </Suspense>
        )}
      </QueryRegion>
    </div>
  );
}
