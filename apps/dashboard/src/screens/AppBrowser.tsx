import { Link } from "react-router";
import { Select, SegmentedControl, Textarea } from "@rulebox/ui";
import { useAppOptions } from "../data";
import { BROWSER_KINDS, type AppDetail, type BrowserKind } from "../data/types";
import { Card } from "../components/Card";
import { Field, FieldSet } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { SkeletonBlock } from "../components/Skeleton";
import { appBrowserStrings as s } from "../lib/screenStrings/appBrowser";
import type { FormApi } from "./AppEdit";

/**
 * "Opens in" for a website (Phase 6 Step 16, plan 4.9.1): the Rulebox window, Edge, or Chrome with the Chrome program it uses. Under it,
 * the plain list of what browser mode cannot do (4.9.8). The Chrome programs are `apps:options` (`useAppOptions`), subscribed only while
 * Chrome is picked: no query of its own and nothing extra for a website that opens in the Rulebox window.
 */
export function OpensInCard({ d, f, isNew }: { d: AppDetail; f: FormApi; isNew: boolean }) {
  const kind = f.values.browserKind;
  return (
    <Card title={s.opensIn} sub={s.opensInSub}>
      <div className="dash-form">
        <FieldSet legend={s.opensIn} hint={s.kindHelp[kind]}>
          <div style={{ overflowX: "auto", maxWidth: "100%" }}>
            <SegmentedControl<BrowserKind>
              aria-label={s.opensIn}
              options={BROWSER_KINDS.map((k) => ({ value: k, label: s.kinds[k] }))}
              value={kind}
              onChange={(k) => f.set("browserKind", k)}
            />
          </div>
        </FieldSet>
        {kind === "chrome" ? <ChromePicker d={d} f={f} isNew={isNew} /> : null}
        <p className="dash-field__hint">{s.fallbackNote}</p>
        {kind !== "builtin" ? <BrowserLimits /> : null}
      </div>
    </Card>
  );
}

/** The plain list of plan 4.9.8: what browser mode cannot do. */
function BrowserLimits() {
  return (
    <FieldSet legend={s.limitsTitle}>
      <ul className="dash-muted" style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
        {s.limits.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </FieldSet>
  );
}

function ChromePicker({ d, f, isNew }: { d: AppDetail; f: FormApi; isNew: boolean }) {
  const programs = useAppOptions();
  const x = f.values;
  // The choice the server holds: a warning while it names a program that can no longer be used.
  const saved = !isNew && d.web?.browser?.kind === "chrome" && d.web.browser.appId === x.chromeAppId ? d.web.browser : undefined;
  const warning =
    saved === undefined ? null : d.chromeApp === undefined ? s.chromeGone : d.chromeApp.usable ? null : s.chromeUnusable(d.chromeApp.name);

  if (programs.status !== "ready") {
    return programs.status === "loading" ? <SkeletonBlock lines={2} /> : <InlineNotice tone="danger" alert title={s.chromeLoading} />;
  }
  const chrome = programs.data.filter((p) => p.browser === "chrome");
  const known = chrome.some((p) => p._id === x.chromeAppId);
  return (
    <>
      <Field label={s.chromeApp} hint={s.chromeAppHint} error={f.errors.chromeAppId} required>
        {(p) => (
          <Select {...p} value={x.chromeAppId} onChange={(e) => f.set("chromeAppId", e.target.value)}>
            <option value="">{s.chromeAppPick}</option>
            {x.chromeAppId !== "" && !known ? <option value={x.chromeAppId}>{d.chromeApp?.name ?? x.chromeAppId}</option> : null}
            {chrome.map((p2) => (
              <option key={p2._id} value={p2._id}>
                {p2.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {chrome.length === 0 ? (
        <InlineNotice
          tone="neutral"
          title={s.chromeNone}
          action={
            <Link className="dash-link" to="/apps/new?kind=desktop">
              {s.chromeAdd}
            </Link>
          }
        />
      ) : null}
      {warning !== null ? <InlineNotice tone="warning" title={warning} /> : null}
    </>
  );
}

/**
 * "Browser rules" of a Chrome or Edge program (plan 4.9.7): its allowed sites, one per line. Without any the browser opens only to its own
 * blocked page. The update mode of such a program is Vendor (the Updates card says so).
 */
export function BrowserRulesCard({ f }: { f: FormApi }) {
  const empty = f.values.sites.trim() === "";
  return (
    <Card title={s.rules} sub={s.rulesSub}>
      <div className="dash-form">
        <Field label={s.sites} hint={s.sitesHint} error={f.errors.sites} optional>
          {(p) => (
            <Textarea {...p} rows={5} spellCheck={false} autoCapitalize="off" className="dash-mono" value={f.values.sites} onChange={(e) => f.set("sites", e.target.value)} />
          )}
        </Field>
        {empty ? <InlineNotice tone="warning" title={s.sitesEmpty} /> : null}
        <BrowserLimits />
      </div>
    </Card>
  );
}
