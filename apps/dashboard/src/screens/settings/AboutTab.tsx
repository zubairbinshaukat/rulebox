import { Link } from "react-router";
import { LogoMark, Pill } from "@rulebox/ui";
import IconCode from "~icons/solar/code-linear";
import IconOut from "~icons/solar/arrow-right-up-linear";
import { DASHBOARD_API_VERSION, IS_DEMO } from "../../data";
import { Card } from "../../components/Card";
import { strings } from "../../lib/strings";
import { settingsStrings } from "../../lib/screenStrings/settings";

const s = settingsStrings.about;

/** Only builds for developers and the demo have the design gallery; a normal installation never links to it. */
const SHOW_GALLERY = IS_DEMO || import.meta.env.DEV;

export function AboutTab() {
  return (
    <div className="set-about">
      <Card level={3} className="set-about__id">
        <div className="set-about__hero">
          <LogoMark size={64} label={strings.app.name} />
          <div className="set-about__text">
            <p className="set-about__name">{strings.app.name}</p>
            <p className="set-about__meta">
              <Pill tone="accent">
                {s.version} {__APP_VERSION__}
                {IS_DEMO ? ` (${strings.demo.badge})` : ""}
              </Pill>
              <a className="dash-link" href={s.repoUrl} target="_blank" rel="noopener noreferrer">
                <IconCode aria-hidden="true" />
                {s.source}
                <IconOut aria-hidden="true" />
              </a>
            </p>
          </div>
        </div>
      </Card>

      <Card level={3} title={s.credits} className="set-about__credits">
        <ul className="set-credits">
          <li>{s.solar}</li>
          <li>{s.fonts}</li>
        </ul>
        <p className="dash-muted set-credits__note">{s.notices}</p>
      </Card>

      <details className="dash-advanced set-about__tech">
        <summary>{s.technical}</summary>
        <div className="dash-advanced__body">
          <dl className="dash-kv">
            <div className="dash-kv__item">
              <dt>{s.apiVersion}</dt>
              <dd className="dash-mono">{DASHBOARD_API_VERSION}</dd>
            </div>
          </dl>
          {SHOW_GALLERY ? (
            <p>
              <Link className="dash-link" to="/gallery">
                {s.gallery}
              </Link>
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}
