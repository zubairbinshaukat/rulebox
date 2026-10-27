import type { ComponentType, SVGProps } from "react";
import { NavLink } from "react-router";
import HomeLinear from "~icons/solar/home-2-linear";
import HomeDuo from "~icons/solar/home-2-bold-duotone";
import MonitorLinear from "~icons/solar/monitor-linear";
import MonitorDuo from "~icons/solar/monitor-bold-duotone";
import LayersLinear from "~icons/solar/layers-linear";
import LayersDuo from "~icons/solar/layers-bold-duotone";
import UsersLinear from "~icons/solar/users-group-rounded-linear";
import UsersDuo from "~icons/solar/users-group-rounded-bold-duotone";
import WidgetLinear from "~icons/solar/widget-2-linear";
import WidgetDuo from "~icons/solar/widget-2-bold-duotone";
import DocLinear from "~icons/solar/document-text-linear";
import DocDuo from "~icons/solar/document-text-bold-duotone";
import AddLinear from "~icons/solar/add-square-linear";
import AddDuo from "~icons/solar/add-square-bold-duotone";
import HistoryLinear from "~icons/solar/history-linear";
import HistoryDuo from "~icons/solar/history-bold-duotone";
import SettingsLinear from "~icons/solar/settings-linear";
import SettingsDuo from "~icons/solar/settings-bold-duotone";
import { strings } from "../lib/strings";
import { prefetchPath } from "./screens";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  activeIcon: Icon;
  end?: boolean;
}

const n = strings.app.nav;

const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: n.sectionFleet,
    items: [
      { to: "/", label: n.overview, icon: HomeLinear, activeIcon: HomeDuo, end: true },
      { to: "/devices", label: n.devices, icon: MonitorLinear, activeIcon: MonitorDuo },
      { to: "/groups", label: n.groups, icon: LayersLinear, activeIcon: LayersDuo },
      { to: "/enrollment", label: n.enrollment, icon: AddLinear, activeIcon: AddDuo },
    ],
  },
  {
    label: n.sectionPeople,
    items: [
      { to: "/employees", label: n.employees, icon: UsersLinear, activeIcon: UsersDuo },
      { to: "/apps", label: n.apps, icon: WidgetLinear, activeIcon: WidgetDuo },
      { to: "/file-types", label: n.fileTypes, icon: DocLinear, activeIcon: DocDuo },
    ],
  },
  {
    label: n.sectionAdmin,
    items: [
      { to: "/audit", label: n.audit, icon: HistoryLinear, activeIcon: HistoryDuo },
      { to: "/settings", label: n.settings, icon: SettingsLinear, activeIcon: SettingsDuo },
    ],
  },
];

/**
 * The main navigation. `NavLink` sets `aria-current="page"` on the active
 * item; its icon switches from `-linear` to `-bold-duotone` (Decision 16).
 */
export function Nav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="dash-nav" aria-label={strings.app.mainNav}>
      {NAV_SECTIONS.map((section) => (
        <div className="dash-nav__group" key={section.label}>
          <span className="dash-nav__label dash-overline">{section.label}</span>
          <ul className="dash-nav__list">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className="dash-nav__link"
                  title={item.label}
                  onClick={onNavigate}
                  // Start downloading the screen's chunk as soon as the user aims at it.
                  onPointerEnter={() => prefetchPath(item.to)}
                  onFocus={() => prefetchPath(item.to)}
                  onTouchStart={() => prefetchPath(item.to)}
                >
                  {({ isActive }) => {
                    const I = isActive ? item.activeIcon : item.icon;
                    return (
                      <>
                        <span className="dash-nav__icon" aria-hidden="true">
                          <I />
                        </span>
                        <span className="dash-nav__text">{item.label}</span>
                      </>
                    );
                  }}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
