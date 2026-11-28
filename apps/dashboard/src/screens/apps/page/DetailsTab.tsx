import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button } from "@rulebox/ui";
import IconRefresh from "~icons/solar/refresh-linear";
import { useResolveWinget } from "../../../data";
import type { AppDetail, WingetResolved } from "../../../data/types";
import { Card } from "../../../components/Card";
import { InlineNotice } from "../../../components/Notice";
import { messageFor } from "../../../lib/errors";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appEditStrings as s } from "../../../lib/screenStrings/appEdit";
import { appsStrings } from "../../../lib/screenStrings/apps";
import { strings } from "../../../lib/strings";
import * as v from "../../../lib/validate";
import type { FormApi } from "../appForm";
import { DesktopBody } from "../desktop/DesktopBody";
import { useDisclosures } from "../desktop/disclosures";
import { useInstallerCheck } from "../desktop/useInstallerCheck";

const t = appAddStrings;

/**
 * What a Details tab body gets from the page. A website form (built by another screen) is rendered through `AppPage`'s
 * `renderDetails` with exactly this: the lifted form, the role, the saved revision. Nothing else is needed to take part in the page's
 * shared save bar.
 */
export interface DetailsContext {
  d: AppDetail;
  /** The page's one form. Details and Updates share it; the save bar saves it. */
  f: FormApi;
  readOnly: boolean;
  revision: number;
  /** Go to another tab (`"updates"`). */
  goTab: (tab: string) => void;
  /** The form's submit (Enter in a field): the page saves. */
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/** The Details tab of a Windows app: the same body as the add page, plus the facts aside. */
export default function DetailsTab({ ctx }: { ctx: DetailsContext }) {
  const { d, f, readOnly } = ctx;
  const check = useInstallerCheck(f);
  const disclosures = useDisclosures(f.errors as Record<string, string | undefined>, true);
  return (
    <form className="dash-split apps-details" noValidate onSubmit={ctx.onSubmit}>
      <fieldset disabled={readOnly} className="apps-fieldset dash-split__main">
        <div className="dash-card dash-card--pad">
          <DesktopBody f={f} check={check} readOnly={readOnly} isNew={false} appKey={d._id} disclosures={disclosures} onVersion={() => ctx.goTab("updates")} />
        </div>
      </fieldset>
      <aside className="dash-split__aside">
        <SourceCard d={d} f={f} readOnly={readOnly} />
        <Card title={s.fileTypes}>
          {d.fileTypes.length ? (
            <div className="dash-pills">
              {d.fileTypes.map((ext) => (
                <span key={ext} className="dash-chip dash-mono">
                  {ext}
                </span>
              ))}
            </div>
          ) : (
            <p className="dash-muted">{strings.common.none}</p>
          )}
          <p className="apps-aside__link">
            <Link className="dash-link" to="/file-types">
              {s.fileTypesManage}
            </Link>
          </p>
        </Card>
      </aside>
    </form>
  );
}

/** "Where it comes from": the source in plain words, the version, and for a winget app "Check for update". */
function SourceCard({ d, f, readOnly }: { d: AppDetail; f: FormApi; readOnly: boolean }) {
  const x = f.values;
  const resolve = useResolveWinget();
  const [state, setState] = useState<{ pending: boolean; error: string | null; newer: string | null; same: boolean }>({ pending: false, error: null, newer: null, same: false });
  const latest = useRef<WingetResolved | null>(null);
  const r = x.resolved;
  const source = d.desktop?.source ?? x.source;
  async function look() {
    if (!r) return;
    setState({ pending: true, error: null, newer: null, same: false });
    try {
      const next = await resolve({ packageId: r.packageId });
      if (next.version === r.version) setState({ pending: false, error: null, newer: null, same: true });
      else setState({ pending: false, error: null, newer: next.version, same: false });
      latest.current = next;
    } catch (e) {
      setState({ pending: false, error: messageFor(e), newer: null, same: false });
    }
  }
  function use() {
    const next = latest.current;
    if (!next) return;
    f.set("resolved", next);
    f.set("wingetVersion", next.version);
    f.set("silentArgs", v.joinArgs(next.install.silentArgs));
    f.set("removeWhenUnassigned", next.install.removeWhenUnassigned);
    f.set("version", next.version);
    setState((st) => ({ ...st, newer: null }));
  }
  return (
    <Card title={s.source}>
      <p className="apps-aside__source">{appsStrings.sourcesPlain[source]}</p>
      {x.version.trim() ? <p className="dash-muted">{t.review.versionOf(x.version.trim())}</p> : null}
      {source === "winget" && r && !readOnly ? (
        <div className="apps-aside__actions">
          <Button type="button" variant="ghost" className="dash-btn--sm" disabled={state.pending} aria-busy={state.pending} onClick={() => void look()}>
            <IconRefresh aria-hidden="true" />
            {state.pending ? s.resolving : s.checkUpdate}
          </Button>
          {state.same ? <p className="dash-muted">{t.review.newest}</p> : null}
          {state.newer ? (
            <InlineNotice
              tone="accent"
              title={t.review.newerFound(state.newer)}
              action={
                <Button type="button" className="dash-btn--sm" onClick={use}>
                  {t.review.useNewer}
                </Button>
              }
            />
          ) : null}
          {state.error ? <InlineNotice tone="danger" alert title={state.error} /> : null}
        </div>
      ) : null}
    </Card>
  );
}
