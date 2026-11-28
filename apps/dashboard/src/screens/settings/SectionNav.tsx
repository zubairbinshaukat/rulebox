import { useEffect, useRef, type ComponentType, type SVGProps } from "react";
import { Link } from "react-router";
import IconSettings from "~icons/solar/settings-linear";
import IconMembers from "~icons/solar/users-group-rounded-linear";
import IconShield from "~icons/solar/shield-user-linear";
import IconKeyboard from "~icons/solar/keyboard-linear";
import IconDownload from "~icons/solar/download-minimalistic-linear";
import IconKey from "~icons/solar/key-linear";
import IconInfo from "~icons/solar/info-circle-linear";
import IconLock from "~icons/solar/lock-keyhole-minimalistic-linear";
import { settingsStrings } from "../../lib/screenStrings/settings";
import { GROUPS, OWNER_ONLY, sectionSearch, type SectionId } from "./sections";

const ICONS: Record<SectionId, ComponentType<SVGProps<SVGSVGElement>>> = {
  organization: IconSettings,
  members: IconMembers,
  security: IconShield,
  adminExit: IconKeyboard,
  updates: IconDownload,
  signing: IconKey,
  about: IconInfo,
};

const s = settingsStrings.nav;

/**
 * The section navigation of Settings: links that set `?tab=` (replace history, so the Back button leaves Settings instead of walking
 * through sections). Vertical and grouped from 880 px of Settings width, a scrolling strip below (CSS container query, `settings.css`).
 * The open section is `aria-current="page"`; owner-only sections carry a lock for everyone; "Your security" a dot while there is no PIN.
 */
export function SectionNav({ active, pinMissing }: { active: SectionId; pinMissing: boolean }) {
  const nav = useRef<HTMLElement>(null);

  // On a phone the strip scrolls: keep the open section in view (a deep link to the far end).
  useEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || typeof el.scrollIntoView !== "function") return;
    const calm =
      document.documentElement.dataset.lite === "true" ||
      (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    el.scrollIntoView({ inline: "nearest", block: "nearest", behavior: calm ? "auto" : "smooth" });
  }, [active]);

  return (
    <nav ref={nav} className="set-nav" aria-label={s.label}>
      <ul className="set-nav__groups">
        {GROUPS.map((g) => (
          <li key={g.id} className="set-nav__group">
            <span className="set-nav__label" id={`set-group-${g.id}`}>
              {s.groups[g.id]}
            </span>
            <ul className="set-nav__items" aria-labelledby={`set-group-${g.id}`}>
              {g.sections.map((id) => {
                const Icon = ICONS[id];
                return (
                  <li key={id}>
                    <Link
                      to={{ search: sectionSearch(id) }}
                      replace
                      className="set-nav__link"
                      aria-current={id === active ? "page" : undefined}
                    >
                      <Icon className="set-nav__icon" aria-hidden="true" />
                      <span className="set-nav__text">{s.items[id]}</span>
                      {OWNER_ONLY.has(id) ? (
                        <span className="set-nav__mark" title={s.ownerOnly}>
                          <IconLock aria-hidden="true" />
                          <span className="set-sr">{s.ownerOnly}</span>
                        </span>
                      ) : null}
                      {id === "security" && pinMissing ? (
                        <span className="set-nav__dot" title={s.pinMissing}>
                          <span className="set-sr">{s.pinMissing}</span>
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
