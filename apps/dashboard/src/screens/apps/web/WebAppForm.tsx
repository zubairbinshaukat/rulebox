import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input, Textarea } from "@rulebox/ui";
import { useFetchWebMeta } from "../../../data";
import type { AppDetail } from "../../../data/types";
import { AppGlyph } from "../../../components/AppGlyph";
import { Field } from "../../../components/Field";
import { serverFieldError } from "../../../components/serverField";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appEditStrings } from "../../../lib/screenStrings/appEdit";
import { appSiteAccessStrings } from "../../../lib/screenStrings/appSiteAccess";
import * as v from "../../../lib/validate";
import { OpensInFields } from "../../AppBrowser";
import { nearestHue, type FormApi } from "../appForm";
import { HuePicker } from "../HuePicker";
import { SiteAccessPicker } from "./SiteAccessPicker";
import { SitePreview } from "./SitePreview";
import { DEFAULT_SUGGESTIONS, type SiteSuggestion } from "./siteEntries";
import type { WebIconState } from "./useWebIcon";
import { withHttps, wwwDefault } from "./webAddress";
import "../apps.css";
import "./web.css";

const t = appAddStrings;
const w = appAddStrings.web;

export interface WebAppFormProps {
  /** The app (`blankWebDetail()` for a new one). */
  d: AppDetail;
  /** The page's form (`initialValues(d, "web")`, `validateValues("web", ...)`): the form writes `url`, `name`, `description`, `hue`, `domains`, `browserKind`, `chromeAppId`. */
  f: FormApi;
  isNew: boolean;
  /** A viewer or an archived app: nothing can be changed. */
  readOnly: boolean;
  icon: WebIconState;
  /** Drawn under the preview (the "Add website" bar of the add page). The Details tab leaves it out: the page's save bar saves. */
  footer?: ReactNode;
  /** A popular app's own sign-in sites, on top of Microsoft and Google. */
  suggestions?: readonly SiteSuggestion[];
  /** Read the site's name and icon as soon as the form opens (a pasted address, a popular app). */
  autoFetch?: boolean;
}

type Meta = { state: "idle" | "busy" | "done" | "failed"; icon: boolean; name: boolean };

/**
 * The website form (UI pass, add-app plan 3.1 and 13): the address (the site's name, icon and colour are read by themselves, once per
 * address), the name, the site-access picker with its live preview, "More options" (Opens in, appearance, description) and "Advanced"
 * (the allowed sites as a plain list). No `<form>` of its own: the add page and the Details tab wrap it and own the save. The stored data
 * is unchanged (`domains` stays the form's list of lines; the picker reads and writes it).
 */
export function WebAppForm({ d, f, isNew, readOnly, icon, footer, suggestions, autoFetch = false }: WebAppFormProps) {
  const x = f.values;
  const fetchMeta = useFetchWebMeta();
  const [meta, setMeta] = useState<Meta>({ state: "idle", icon: false, name: false });
  // The address the last read was for (an existing app's own address counts: it is not read again until it changes).
  const fetchedFor = useRef<string | null>(isNew ? null : withHttps(x.url));
  // What the read filled in: replaced by the next read only while the person has not changed it.
  const auto = useRef<{ name?: string; hue?: number }>({});
  // The address the "www" default was last applied for.
  const wwwFor = useRef<string | null>(null);
  const mounted = useRef(true);
  const latest = useRef(x);
  useEffect(() => {
    latest.current = x;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const entries = v.lines(x.domains);
  const address = withHttps(x.url);
  const validAddress = v.webUrl(address) === null;

  function run(text: string) {
    fetchedFor.current = text;
    setMeta({ state: "busy", icon: false, name: false });
    fetchMeta({ url: text }).then(
      (m) => {
        if (!mounted.current || fetchedFor.current !== text) return;
        const now = latest.current;
        let named = false;
        // A new website takes the name and colour of the site; an existing one only gets the icon (its name and colour are the admin's).
        if (isNew) {
          if (m.name && (now.name.trim() === "" || now.name === auto.current.name)) {
            f.set("name", m.name);
            auto.current.name = m.name;
            named = true;
          }
          if (m.hue !== undefined && (now.hue === undefined || now.hue === auto.current.hue)) {
            const hue = nearestHue(m.hue);
            f.set("hue", hue);
            auto.current.hue = hue;
          }
        }
        icon.setIcon(m.iconPreviewUrl ? { forUrl: text, data: m.iconPreviewUrl } : null);
        setMeta({ state: "done", icon: Boolean(m.iconPreviewUrl), name: named || Boolean(m.name) });
      },
      () => {
        if (!mounted.current || fetchedFor.current !== text) return;
        setMeta({ state: "failed", icon: false, name: false });
      },
    );
  }

  /** The address is final (left the box, Enter): add `https://`, the "www" default of a new site, and read the site once per address. */
  function commit(force = false) {
    const text = withHttps(x.url);
    if (text !== x.url) f.set("url", text);
    if (readOnly || v.webUrl(text) !== null) return;
    if (isNew && wwwFor.current !== text) {
      // Once per address: a person who then picks "Only www..." keeps that choice.
      wwwFor.current = text;
      const next = wwwDefault(text, entries);
      if (next !== null) f.set("domains", next.join("\n"));
    }
    if (!force && fetchedFor.current === text) return;
    run(text);
  }

  const started = useRef(false);
  useEffect(() => {
    if (!autoFetch || started.current) return;
    started.current = true;
    if (readOnly || v.webUrl(withHttps(latest.current.url)) !== null) return;
    run(withHttps(latest.current.url));
    // Once, when the form opens with an address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shownIcon = icon.icon !== null && icon.icon.forUrl === address ? icon.icon.data : d.iconUrl !== undefined && d.web !== undefined && withHttps(d.web.url) === address ? d.iconUrl : undefined;

  // A problem inside "More options" opens it (an error is never hidden); the person can close it again.
  const [more, setMore] = useState(false);
  const [seenMore, setSeenMore] = useState(false);
  if ((f.errors.description || f.errors.chromeAppId) && !seenMore) {
    setSeenMore(true);
    setMore(true);
  }
  const [advanced, setAdvanced] = useState(false);

  return (
    <div className="web-form">
      <div className="web-form__main dash-card dash-card--pad">
        <fieldset disabled={readOnly} className="apps-fieldset web-form__fields">
          <Field label={w.address} info={w.addressInfo} error={f.errors.url ?? serverFieldError(f.serverError, "url")} required>
            {(p) => (
              <Input
                {...p}
                type="text"
                inputMode="url"
                placeholder={w.addressPlaceholder}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                value={x.url}
                onChange={(e) => f.set("url", e.target.value)}
                onBlur={() => commit()}
                onKeyDown={(e) => {
                  // Enter finishes the address; it does not save the app.
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  commit();
                }}
              />
            )}
          </Field>
          <div className="web-fetch" role="status" aria-live="polite">
            {meta.state === "busy" ? <span className="web-fetch__busy">{w.fetching}</span> : null}
            {meta.state === "done" ? <span className="web-fetch__ok">{meta.icon ? appSiteAccessStrings.form.found : appSiteAccessStrings.form.foundName}</span> : null}
            {meta.state === "failed" ? <span className="web-fetch__fail">{w.fetchFailed}</span> : null}
            {(meta.state === "done" || meta.state === "failed") && validAddress && !readOnly ? (
              <Button type="button" variant="ghost" className="dash-btn--sm" onClick={() => commit(true)}>
                {w.fetchAgain}
              </Button>
            ) : null}
          </div>
  
          <div className="web-name">
            <AppGlyph name={x.name || "?"} hue={x.hue} iconUrl={shownIcon} size="lg" />
            <Field label={appEditStrings.name} error={f.errors.name} required>
              {(p) => <Input {...p} autoComplete="off" value={x.name} onChange={(e) => f.set("name", e.target.value)} />}
            </Field>
          </div>
  
          <SiteAccessPicker
            url={x.url}
            value={entries}
            onChange={(next) => f.set("domains", next.join("\n"))}
            browser={x.browserKind}
            suggestions={suggestions ? [...DEFAULT_SUGGESTIONS, ...suggestions] : DEFAULT_SUGGESTIONS}
            error={f.errors.domains ?? serverFieldError(f.serverError, "allowedDomains") ?? undefined}
            disabled={readOnly}
            withPreview={false}
          />
  
          {isNew ? <p className="dash-muted">{w.permissionsHint}</p> : null}
  
          <details className="dash-advanced apps-more" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
            <summary>{t.more}</summary>
            <div className="dash-advanced__body">
              <OpensInFields d={d} f={f} isNew={isNew} />
              <Field label={appEditStrings.description} info={appEditStrings.info.description} error={f.errors.description} optional>
                {(p) => <Input {...p} autoComplete="off" value={x.description} onChange={(e) => f.set("description", e.target.value)} />}
              </Field>
              <HuePicker value={x.hue} onChange={(h) => f.set("hue", h)} name={`hue-${d._id}`} disabled={readOnly} />
            </div>
          </details>
  
          <details className="dash-advanced apps-advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
            <summary>{t.advanced}</summary>
            <div className="dash-advanced__body">
              <Field label={w.rawList} info={w.rawListInfo} hint={appEditStrings.allowedDomainsHint}>
                {(p) => (
                  <Textarea {...p} rows={4} spellCheck={false} autoCapitalize="off" className="dash-mono" value={x.domains} onChange={(e) => f.set("domains", e.target.value)} />
                )}
              </Field>
            </div>
          </details>
        </fieldset>
      </div>

      <div className="web-form__aside">
        <SitePreview url={x.url} value={entries} browser={x.browserKind} />
        {footer}
      </div>
    </div>
  );
}
