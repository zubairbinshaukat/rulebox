import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { strings } from "../lib/strings";

export default function NotFound() {
  return (
    <div className="dash-page">
      <div className="dash-notfound">
        <span className="dash-notfound__code" aria-hidden="true">
          404
        </span>
        <PageHeader title={strings.notFound.title} />
        <p className="dash-muted" style={{ maxWidth: "44ch" }}>
          {strings.notFound.body}
        </p>
        <Link to="/" className="rb-btn rb-btn--primary">
          {strings.notFound.home}
        </Link>
      </div>
    </div>
  );
}
