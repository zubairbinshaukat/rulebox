import { useEffect, useRef, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import { Backdrop, LogoMark, SegmentedControl, type Theme } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-linear";
import { IS_DEMO } from "../data";
import { useTheme } from "../app/theme";
import { enter, useMotionLevel } from "../lib/motion";
import { strings } from "../lib/strings";
import { InlineNotice } from "./Notice";

const THEMES = [
  { value: "light", label: strings.app.themeLight },
  { value: "dark", label: strings.app.themeDark },
  { value: "auto", label: strings.app.themeAuto },
] as const;

/** Sign-in, join, reset and MFA: brand panel + one focused card. */
export function AuthShell({
  title,
  lead,
  children,
  wide,
  demoHint,
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  demoHint?: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const level = useMotionLevel();
  const [theme, setTheme] = useTheme();
  useGSAP(() => {
    if (card.current) enter(card.current, level);
  }, { scope: card });
  useEffect(() => {
    document.title = `${title} · ${strings.app.name}`;
  }, [title]);

  return (
    <div className="dash-auth">
      <aside className="dash-auth__side">
        <Backdrop />
        <div className="dash-auth__brand">
          <LogoMark size={36} />
          <span>{strings.app.name}</span>
        </div>
        <div>
          <p className="dash-auth__headline">{strings.auth.sideTitle}</p>
          <ul className="dash-auth__points">
            {strings.auth.sidePoints.map((p) => (
              <li key={p}>
                <IconCheck aria-hidden="true" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="dash-auth__foot">{strings.app.tagline}</p>
      </aside>
      <main className="dash-auth__main" id="main">
        <div ref={card} className={["dash-auth__card", wide ? "dash-auth__card--wide" : ""].filter(Boolean).join(" ")}>
          <div>
            <h1 className="dash-auth__title">{title}</h1>
            {lead ? <p className="dash-auth__lead">{lead}</p> : null}
          </div>
          {IS_DEMO && demoHint ? <InlineNotice tone="accent" title={strings.app.demoBadge} detail={demoHint} /> : null}
          {children}
          <div>
            <SegmentedControl<Theme> options={THEMES} value={theme} onChange={setTheme} aria-label={strings.app.theme} />
          </div>
        </div>
      </main>
    </div>
  );
}
