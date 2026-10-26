import { useRef, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { strings } from "../lib/strings";
import { AboutTab } from "./settings/AboutTab";
import { AdminExitTab } from "./settings/AdminExitTab";
import { MembersTab } from "./settings/MembersTab";
import { OrganizationTab } from "./settings/OrganizationTab";
import { SigningTab } from "./settings/SigningTab";

const TABS = ["organization", "adminExit", "signing", "members", "about"] as const;
type Tab = (typeof TABS)[number];

/** Settings with tabs (`?tab=`): each tab is one query (`settings:get`, `keys:status`, `members:list`). */
export default function Settings() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "organization";
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const select = (t: Tab, focus = false) => {
    setParams(t === "organization" ? {} : { tab: t }, { replace: true });
    if (focus) refs.current[t]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    select(TABS[next]!, true);
  };

  return (
    <div className="dash-page">
      <PageHeader title={strings.settings.title} lead={strings.settings.lead} />
      <div role="tablist" aria-label={strings.settings.title} className="dash-tabs" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t}
            ref={(el) => {
              refs.current[t] = el;
            }}
            type="button"
            role="tab"
            id={`settings-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`settings-panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            className="dash-tabs__tab"
            onClick={() => select(t)}
          >
            {strings.settings.tabs[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} className="dash-stack">
        {tab === "organization" ? <OrganizationTab /> : null}
        {tab === "adminExit" ? <AdminExitTab /> : null}
        {tab === "signing" ? <SigningTab /> : null}
        {tab === "members" ? <MembersTab /> : null}
        {tab === "about" ? <AboutTab /> : null}
      </div>
    </div>
  );
}
