import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { InfoTip } from "@rulebox/ui";
import IconGlobal from "~icons/solar/global-linear";
import IconInstaller from "~icons/solar/download-minimalistic-linear";
import IconMonitor from "~icons/solar/monitor-linear";
import IconFile from "~icons/solar/file-check-linear";
import IconChevron from "~icons/solar/alt-arrow-right-linear";
import IconCatalogue from "~icons/solar/widget-2-linear";
import { EmptyState } from "../../components/EmptyState";
import { InlineNotice } from "../../components/Notice";
import { PageHeader } from "../../components/PageHeader";
import { SearchInput } from "../../components/SearchInput";
import { useCan } from "../../lib/member";
import { appAddStrings } from "../../lib/screenStrings/appAdd";
import { appEditStrings } from "../../lib/screenStrings/appEdit";
import { siteTarget, siteOf, wingetIdOf, wingetTarget, galleryTarget } from "./addSearch";
import { GALLERY_CATEGORIES, searchGallery, type GalleryCategory } from "./gallery/catalog";
import { GalleryGrid } from "./GalleryGrid";
import "./apps.css";

const s = appAddStrings.start;

/** `/apps/new`: pick a popular app, paste a website address or a winget id, or take one of the other ways. */
export default function AddAppStart() {
  const canAct = useCan("admin");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<GalleryCategory | "all">("all");

  const query = text.trim();
  const apps = useMemo(() => searchGallery(query, query === "" ? category : "all"), [query, category]);
  const winget = wingetIdOf(text);
  // `VideoLAN.VLC` has the shape of an address, but with capitals and no scheme it is a package id: only the catalogue row is offered.
  const asId = winget !== null && !/^https?:/i.test(query) && /[A-Z]/.test(query);
  const site = asId ? null : siteOf(text);

  // Enter picks the one thing the text can only mean: a single popular app, else the winget id (when it has capitals or is a link) or the site.
  function enter(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || !canAct || query === "") return;
    e.preventDefault();
    if (apps.length === 1 && !site && !winget) {
      navigate(galleryTarget(apps[0]!.kind, apps[0]!.key));
    } else if (apps.length === 0) {
      const preferWinget = winget !== null && (site === null || /[A-Z]/.test(query) || /^https?:/i.test(query));
      if (preferWinget && winget) navigate(wingetTarget(winget));
      else if (site) navigate(siteTarget(site.url));
    }
  }

  const specials = site !== null || winget !== null;
  return (
    <div className="dash-page apps-start">
      <PageHeader title={s.title} lead={s.lead} back={{ to: "/apps", label: appEditStrings.back }} />
      {!canAct ? <InlineNotice tone="neutral" title={s.viewerNotice} /> : null}
      {params.get("missing") !== null ? <InlineNotice tone="warning" title={s.unknownApp} /> : null}

      <div className="dash-split dash-split--sticky apps-start__split">
        <div className="dash-split__main apps-start__main">
          <div className="apps-start__search" onKeyDownCapture={enter}>
            <SearchInput label={s.searchLabel} placeholder={s.search} value={text} onChange={setText} maxLength={300} />
          </div>

          {query === "" ? (
            <div className="apps-chips" role="group" aria-label={s.categoriesLabel}>
              {(["all", ...GALLERY_CATEGORIES] as const).map((c) => (
                <button key={c} type="button" className="apps-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
                  {s.categories[c]}
                </button>
              ))}
            </div>
          ) : null}

          {specials ? (
            <ul className="apps-results" aria-label={s.results}>
              {site !== null ? (
                <ResultRow
                  icon={<IconGlobal aria-hidden="true" />}
                  title={s.addSite(site.host)}
                  hint={s.siteHint}
                  to={canAct ? siteTarget(site.url) : undefined}
                />
              ) : null}
              {winget !== null ? (
                <ResultRow
                  icon={<IconCatalogue aria-hidden="true" />}
                  title={s.lookUp(winget)}
                  hint={s.wingetHint}
                  info={<InfoTip label={`About ${s.catalogue}`}>{s.lookUpInfo}</InfoTip>}
                  to={canAct ? wingetTarget(winget) : undefined}
                />
              ) : null}
            </ul>
          ) : null}

          {apps.length > 0 ? (
            <GalleryGrid apps={apps} disabled={!canAct} label={s.popular} />
          ) : !specials ? (
            <EmptyState compact title={s.noMatch} />
          ) : null}
          <span className="dash-sr" role="status" aria-live="polite">
            {s.shown(apps.length)}
          </span>
          <p className="apps-trademarks">{s.trademarks}</p>
        </div>

        <aside className="dash-split__aside apps-start__aside" aria-labelledby="apps-ways">
          <section className="dash-card apps-ways">
            <h2 id="apps-ways" className="apps-ways__title">
              {s.otherWays}
            </h2>
            <ul className="apps-ways__list">
              <Way icon={<IconGlobal aria-hidden="true" />} label={s.ways.website} hint={s.waysHint.website} to={canAct ? "/apps/new?kind=web" : undefined} />
              <Way
                icon={<IconInstaller aria-hidden="true" />}
                label={s.ways.installer}
                hint={s.waysHint.installer}
                info={s.installerInfo}
                to={canAct ? "/apps/new?kind=desktop&source=installer" : undefined}
              />
            </ul>
            <details className="apps-ways__more">
              <summary>{s.moreWays}</summary>
              <ul className="apps-ways__list">
                <Way
                  icon={<IconMonitor aria-hidden="true" />}
                  label={s.ways.preinstalled}
                  hint={s.waysHint.preinstalled}
                  to={canAct ? "/apps/new?kind=desktop&source=preinstalled" : undefined}
                />
                <Way
                  icon={<IconFile aria-hidden="true" />}
                  label={s.ways.portable}
                  hint={s.waysHint.portable}
                  info={s.portableInfo}
                  to={canAct ? "/apps/new?kind=desktop&source=portable" : undefined}
                />
              </ul>
            </details>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Row({ icon, title, hint, to, info }: { icon: ReactNode; title: string; hint: string; to: string | undefined; info?: ReactNode }) {
  const body = (
    <>
      <span className="apps-way__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="apps-way__text">
        <span className="apps-way__label">{title}</span>
        <span className="apps-way__hint">{hint}</span>
      </span>
      <IconChevron className="apps-way__go" aria-hidden="true" />
    </>
  );
  return (
    <li className="apps-way">
      {to !== undefined ? (
        <Link className="apps-way__link" to={to}>
          {body}
        </Link>
      ) : (
        <button type="button" className="apps-way__link" disabled>
          {body}
        </button>
      )}
      {info}
    </li>
  );
}

function ResultRow(props: { icon: ReactNode; title: string; hint: string; to: string | undefined; info?: ReactNode }) {
  return <Row {...props} />;
}

function Way({ icon, label, hint, to, info }: { icon: ReactNode; label: string; hint: string; to: string | undefined; info?: string }) {
  return <Row icon={icon} title={label} hint={hint} to={to} info={info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : undefined} />;
}
