import { Link } from "react-router";
import { LogoMark } from "@rulebox/ui";
import { DASHBOARD_API_VERSION, IS_DEMO } from "../../data";
import { Card } from "../../components/Card";
import { strings } from "../../lib/strings";

const s = strings.settings.about;

export function AboutTab() {
  return (
    <Card title={strings.settings.tabs.about}>
      <div className="dash-form">
        <div className="dash-row" style={{ gap: 16 }}>
          <LogoMark size={48} label={strings.app.name} />
          <div>
            <p style={{ fontWeight: 650, fontSize: 17 }}>{strings.app.name}</p>
            <p className="dash-muted">{s.lead}</p>
          </div>
        </div>
        <dl className="dash-kv">
          <div className="dash-kv__item">
            <dt>{s.dashboardVersion}</dt>
            <dd className="dash-mono">
              {__APP_VERSION__}
              {IS_DEMO ? ` (${strings.app.demoBadge})` : ""}
            </dd>
          </div>
          <div className="dash-kv__item">
            <dt>{s.apiVersion}</dt>
            <dd className="dash-mono">{DASHBOARD_API_VERSION}</dd>
          </div>
        </dl>
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>{s.credits}</h3>
          <ul style={{ margin: 0, paddingInlineStart: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            <li>{s.solar}</li>
            <li>{s.gsap}</li>
            <li>{s.fonts}</li>
          </ul>
          <p className="dash-muted" style={{ marginTop: 10, fontSize: 13 }}>
            {s.notices}
          </p>
        </div>
        <p>
          <Link className="dash-link" to="/gallery">
            {s.gallery}
          </Link>
        </p>
      </div>
    </Card>
  );
}
