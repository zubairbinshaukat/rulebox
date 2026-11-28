import { lazy, Suspense, useEffect } from "react";
import { useSearchParams } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { SkeletonBlock } from "../components/Skeleton";
import { settingsStrings } from "../lib/screenStrings/settings";
import { useMember } from "../lib/member";
import { AboutTab } from "./settings/AboutTab";
import { OrganizationTab } from "./settings/OrganizationTab";
import { SectionHead } from "./settings/SectionHead";
import { SectionNav } from "./settings/SectionNav";
import { isSectionId, type SectionId } from "./settings/sections";
import "./settings/settings.css";

// Only the open section loads: General is the front door, the rest are chunks of their own (most visits never open them).
const AdminExitTab = lazy(() => import("./settings/AdminExitTab").then((m) => ({ default: m.AdminExitTab })));
const MembersTab = lazy(() => import("./settings/MembersTab").then((m) => ({ default: m.MembersTab })));
const SigningTab = lazy(() => import("./settings/SigningTab").then((m) => ({ default: m.SigningTab })));
const SecurityTab = lazy(() => import("./settings/SecurityTab"));
const UpdatesTab = lazy(() => import("./settings/UpdatesTab"));

function Loading() {
  return (
    <div className="dash-card dash-card--pad" aria-busy="true" aria-label={settingsStrings.sectionLoading}>
      <SkeletonBlock lines={6} />
    </div>
  );
}

function Section({ id }: { id: SectionId }) {
  switch (id) {
    case "organization":
      return <OrganizationTab />;
    case "about":
      return <AboutTab />;
    case "adminExit":
      return <AdminExitTab />;
    case "members":
      return <MembersTab />;
    case "signing":
      return <SigningTab />;
    case "security":
      return <SecurityTab />;
    case "updates":
      return <UpdatesTab />;
  }
}

/**
 * Settings (UI pass): a grouped section navigation (`?tab=`) and the open section. Each section is one query (`settings:get`,
 * `keys:status`, `ruleboxRelease:get`, `members:page`, `stepUp:status`); a section that is not open loads and asks for nothing.
 */
export default function Settings() {
  const [params, setParams] = useSearchParams();
  const me = useMember();
  const raw = params.get("tab");
  const known = isSectionId(raw);
  const active: SectionId = known ? raw : "organization";

  // An unknown id is General: the address is cleaned up (replace, so Back does not return to it).
  useEffect(() => {
    if (raw !== null && !known) setParams({}, { replace: true });
  }, [raw, known, setParams]);

  return (
    <div className="dash-page">
      <PageHeader title={settingsStrings.title} lead={settingsStrings.lead} />
      <div className="set-page">
        <div className="set-layout">
          <SectionNav active={active} pinMissing={!me.pin.set} />
          <div className="set-section dash-enter" key={active}>
            <SectionHead id={active} />
            <Suspense fallback={<Loading />}>
              <Section id={active} />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
