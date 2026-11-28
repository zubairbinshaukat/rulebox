import { Link } from "react-router";
import type { CSSProperties } from "react";
import { AppGlyph } from "../../components/AppGlyph";
import { appAddStrings } from "../../lib/screenStrings/appAdd";
import { galleryTarget } from "./addSearch";
import type { GalleryApp } from "./gallery/catalog";

const s = appAddStrings.start;

/**
 * The popular apps as cards: a letter tile (no vendor logo is bundled, D2), the name, three to six words, and a "Website" badge for
 * the apps that open as a website. The grid lays itself out by its own width (as many columns of at least 168 px as fit), so it fills
 * the main column of the page and the whole width of a phone alike. A card is a link to the review page (a middle click opens it in
 * a new tab); for a viewer it is a disabled button, because only an Admin or Owner can add.
 */
export function GalleryGrid({ apps, disabled = false, label }: { apps: readonly GalleryApp[]; disabled?: boolean; label: string }) {
  return (
    <ul className="apps-grid" aria-label={label}>
      {apps.map((app, i) => (
        <li key={app.key} className="apps-grid__item" style={{ "--i": Math.min(i, 12) } as CSSProperties}>
          {disabled ? (
            <button type="button" className="apps-card" disabled>
              <Card app={app} />
            </button>
          ) : (
            <Link className="apps-card" to={galleryTarget(app.kind, app.key)}>
              <Card app={app} />
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

function Card({ app }: { app: GalleryApp }) {
  return (
    <>
      <AppGlyph name={app.name} hue={app.hue} size="lg" />
      <span className="apps-card__text">
        <span className="apps-card__name" title={app.name}>
          {app.name}
        </span>
        <span className="apps-card__blurb">{app.blurb}</span>
      </span>
      {app.kind === "web" ? <span className="apps-card__badge">{s.websiteBadge}</span> : null}
    </>
  );
}
