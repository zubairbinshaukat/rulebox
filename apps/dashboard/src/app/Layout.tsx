import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useGSAP } from "@gsap/react";
import { Button, LogoMark, Pill } from "@rulebox/ui";
import IconMenu from "~icons/solar/hamburger-menu-linear";
import IconRefresh from "~icons/solar/refresh-linear";
import { DASHBOARD_API_VERSION, IS_DEMO } from "../data";
import { useMember } from "../lib/member";
import { RegionBoundary } from "../components/Region";
import { Modal } from "../components/Modal";
import { SkeletonBlock } from "../components/Skeleton";
import { enter, useMotionLevel } from "../lib/motion";
import { requestTitleFocus, takeTitleFocus } from "../lib/focus";
import { strings } from "../lib/strings";
import { AccountMenu } from "./AccountMenu";
import { ConnectionBanner } from "./ConnectionBanner";
import { Nav } from "./Nav";

const DemoControls = IS_DEMO ? lazy(() => import("./DemoControls")) : null;


function PageFallback() {
  return (
    <div className="dash-page" aria-busy="true">
      <SkeletonBlock lines={2} />
      <div className="dash-card dash-card--pad">
        <SkeletonBlock lines={5} />
      </div>
    </div>
  );
}

/**
 * The signed-in shell (Step 4 #4): left navigation (a menu button and sheet
 * below 768 px), top bar with the organization, banners, account menu, and
 * the page with a short GSAP entrance on every route change.
 */
export function Layout() {
  const me = useMember();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const level = useMotionLevel();
  const first = useRef(true);

  useGSAP(
    () => {
      if (page.current) enter(page.current, level);
    },
    { dependencies: [location.pathname], scope: page },
  );

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    requestTitleFocus();
    window.scrollTo({ top: 0 });
    // A screen that is already loaded has its title now; a lazy one focuses it on mount.
    const t = setTimeout(() => {
      const h1 = document.querySelector<HTMLElement>("[data-page-title]");
      if (h1 && takeTitleFocus()) h1.focus({ preventScroll: true });
    }, 60);
    return () => clearTimeout(t);
  }, [location.pathname]);

  const versionMismatch = me.serverApiVersion !== DASHBOARD_API_VERSION;

  return (
    <>
      <a href="#main" className="dash-skip">
        {strings.app.skipToContent}
      </a>
      <div className="dash">
        <aside className="dash-side">
          <Link to="/" className="dash-brand">
            <LogoMark size={34} />
            <span className="dash-brand__text">
              <span className="dash-brand__name">{strings.app.name}</span>
              <span className="dash-brand__org" title={me.orgName}>
                {me.orgName}
              </span>
            </span>
          </Link>
          <Nav />
          <div className="dash-side__foot">
            {IS_DEMO ? (
              <Pill tone="warning" className="dash-keep">
                {strings.app.demoBadge}
              </Pill>
            ) : null}
            <span>v{__APP_VERSION__}</span>
          </div>
        </aside>

        <div className="dash-main-col">
          <header className="dash-top">
            <button
              type="button"
              className="dash-icon-btn dash-top__menu"
              aria-label={strings.app.openMenu}
              aria-haspopup="dialog"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <IconMenu aria-hidden="true" />
            </button>
            <div className="dash-top__context">
              <Link to="/" className="dash-top__brand" aria-label={strings.app.name}>
                <LogoMark size={28} />
              </Link>
              <span className="dash-top__org" title={me.orgName}>
                {me.orgName}
              </span>
              {IS_DEMO ? (
                <Pill tone="warning" className="dash-top__orglabel">
                  {strings.app.demoBadge}
                </Pill>
              ) : null}
            </div>
            <div className="dash-top__actions">
              {DemoControls ? (
                <Suspense fallback={null}>
                  <DemoControls />
                </Suspense>
              ) : null}
              <AccountMenu />
            </div>
          </header>

          <ConnectionBanner />
          {versionMismatch ? (
            <div className="dash-banner dash-banner--accent" role="status">
              <span className="dash-banner__icon" aria-hidden="true">
                <IconRefresh />
              </span>
              <p className="dash-banner__text">{strings.app.newVersion}</p>
              <Button variant="ghost" className="dash-btn--sm" onClick={() => window.location.reload()}>
                {strings.app.reload}
              </Button>
            </div>
          ) : null}

          <main id="main" className="dash-main" tabIndex={-1}>
            <div ref={page} key={location.pathname}>
              <RegionBoundary resetKey={location.pathname}>
                <Suspense fallback={<PageFallback />}>
                  <Outlet />
                </Suspense>
              </RegionBoundary>
            </div>
          </main>
        </div>
      </div>

      <Modal open={navOpen} title={strings.app.menuTitle} onClose={() => setNavOpen(false)} className="dash-dialog--nav">
        <Nav onNavigate={() => setNavOpen(false)} />
      </Modal>
    </>
  );
}
