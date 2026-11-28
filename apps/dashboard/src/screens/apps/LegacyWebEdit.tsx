import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Input, Pill, Textarea } from "@rulebox/ui";
import IconMagic from "~icons/solar/stars-linear";
import { useCreateWebApp, useFetchWebMeta, useSaveAppIcon, useUpdateApp } from "../../data";
import { DEFAULT_WEB_PERMISSIONS, type AppDetail, type WebPermissions } from "../../data/types";
import { AppGlyph } from "../../components/AppGlyph";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { HistoryPanel } from "../../components/HistoryPanel";
import { InlineNotice } from "../../components/Notice";
import { PageHeader } from "../../components/PageHeader";
import { messageFor, registerDetailSentences } from "../../lib/errors";
import { useCan } from "../../lib/member";
import { appEditStrings } from "../../lib/screenStrings/appEdit";
import { browserRefusalStrings } from "../../lib/screenStrings/appBrowser";
import { appsStrings } from "../../lib/screenStrings/apps";
import { strings } from "../../lib/strings";
import { useForm } from "../../lib/useForm";
import { useToast } from "../../lib/toast";
import * as v from "../../lib/validate";
import { AppPermissions } from "../AppPermissions";
import { OpensInCard } from "../AppBrowser";
import { initialValues, nearestHue, validateValues, type FormValues } from "./appForm";
import { HuePicker } from "./HuePicker";
import { ArchiveActions } from "./page/ArchiveActions";
import { AssignmentsCard } from "./page/AccessTab";
import "./apps.css";

const s = appEditStrings;
registerDetailSentences(browserRefusalStrings);

/**
 * The website form as it was before the UI pass (a single page: address, allowed domains, opens in, permissions, groups, history).
 * It stays here, unchanged, until the website form with the site-access picker replaces it inside `AppPage` (see `AppPageSlots`).
 */
export default function LegacyWebEdit({ d, isNew }: { d: AppDetail; isNew: boolean }) {
  const canAct = useCan("admin");
  const [formKey, setFormKey] = useState(0);
  const [revision, setRevision] = useState(d.revision);
  const [draft, setDraft] = useState<WebPermissions>(d.web?.permissions ?? DEFAULT_WEB_PERMISSIONS);
  const title = isNew ? s.newWebTitle : d.name;
  const reload = () => {
    setRevision(d.revision);
    setDraft(d.web?.permissions ?? DEFAULT_WEB_PERMISSIONS);
    setFormKey((k) => k + 1);
  };
  return (
    <>
      <PageHeader
        back={{ to: "/apps", label: s.back }}
        title={
          <span className="dash-row" style={{ flexWrap: "nowrap", alignItems: "center", gap: 14 }}>
            {!isNew ? <AppGlyph name={d.name} hue={d.hue} size="lg" /> : null}
            <span className="dash-wrap">{title}</span>
          </span>
        }
        meta={
          !isNew ? (
            <>
              <Pill tone="accent">{appsStrings.web}</Pill>
              {d.archived ? <Pill tone="warning">{appsStrings.archived}</Pill> : null}
            </>
          ) : undefined
        }
        actions={!isNew ? <ArchiveActions d={d} /> : undefined}
      />
      {!isNew && d.archived ? <InlineNotice tone="warning" title={s.archived} /> : null}
      {!isNew && !canAct ? <InlineNotice tone="neutral" title={strings.app.readOnly} /> : null}
      <div className={isNew ? "dash-stack" : "dash-grid dash-grid--main"}>
        <div className="dash-stack">
          <WebForm key={formKey} d={d} isNew={isNew} readOnly={!canAct} revision={revision} onSaved={() => setRevision((r) => r + 1)} onReload={reload} />
          {!isNew && d.web ? (
            <AppPermissions key={formKey} d={d} revision={revision} readOnly={!canAct} draft={draft} onDraft={setDraft} onSaved={setRevision} onReload={reload} />
          ) : null}
        </div>
        {!isNew ? (
          <div className="dash-stack">
            <AssignmentsCard d={d} />
            <HistoryPanel targetId={d._id} title={s.history} />
          </div>
        ) : null}
      </div>
    </>
  );
}

function WebForm({ d, isNew, readOnly, revision, onSaved, onReload }: { d: AppDetail; isNew: boolean; readOnly: boolean; revision: number; onSaved: () => void; onReload: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const createWeb = useCreateWebApp();
  const update = useUpdateApp();
  const fetchMeta = useFetchWebMeta();
  const saveIcon = useSaveAppIcon();
  // The icon "Fetch details" previewed (a `data:` URL) and the address it came from: stored with the app when the form is saved, and only
  // while the address still is that one (a previous site's icon is never saved).
  const [fetchedIcon, setIcon] = useState<{ forUrl: string; data: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const f = useForm<FormValues>(initialValues(d, "web"), (x) => validateValues("web", x));
  const [helper, setHelper] = useState<{ pending: boolean; error: unknown; note: string | null }>({ pending: false, error: null, note: null });
  const x = f.values;
  const icon = fetchedIcon !== null && fetchedIcon.forUrl === x.url.trim() ? fetchedIcon.data : null;

  async function runHelper(fn: () => Promise<string>) {
    setHelper({ pending: true, error: null, note: null });
    try {
      setHelper({ pending: false, error: null, note: await fn() });
    } catch (e) {
      setHelper({ pending: false, error: e, note: null });
    }
  }

  /** The app is saved by now; a failing icon upload must not undo that, so it only warns. */
  async function storeIcon(appId: string, forUrl: string) {
    if (fetchedIcon === null || fetchedIcon.forUrl !== forUrl) return;
    try {
      await saveIcon({ appId, png: fetchedIcon.data });
      setIcon(null);
    } catch (e) {
      toast(`${s.iconNotSaved} ${messageFor(e)}`, "danger");
    }
  }

  async function save(values: FormValues) {
    const common = { name: values.name.trim(), description: values.description.trim() || undefined, hue: values.hue };
    const web = {
      ...common,
      url: values.url.trim(),
      allowedDomains: v.lines(values.domains).map((s2) => s2.toLowerCase()),
      // The Rulebox window is no field at all (the server stores none either).
      ...(values.browserKind === "edge" ? { browser: { kind: "edge" as const } } : {}),
      ...(values.browserKind === "chrome" ? { browser: { kind: "chrome" as const, appId: values.chromeAppId } } : {}),
    };
    if (isNew) {
      const id = await createWeb(web);
      await storeIcon(id, web.url);
      toast(s.created(common.name));
      navigate(`/apps/${id}`, { replace: true });
    } else {
      await update({ appId: d._id, expectedRevision: revision, web });
      onSaved();
      await storeIcon(d._id, web.url);
      toast(s.saved);
    }
  }

  return (
    <form
      ref={form}
      className="dash-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!readOnly) void f.submit(save, form.current);
      }}
    >
      <fieldset disabled={readOnly} className="dash-stack apps-fieldset">
        <Card title={s.general}>
          <div className="dash-form">
            <div className="dash-form__row">
              <Field label={s.name} error={f.errors.name} required>
                {(p) => <Input {...p} value={x.name} onChange={(e) => f.set("name", e.target.value)} autoComplete="off" />}
              </Field>
              <Field label={s.description} error={f.errors.description} optional>
                {(p) => <Input {...p} value={x.description} onChange={(e) => f.set("description", e.target.value)} autoComplete="off" />}
              </Field>
            </div>
            <HuePicker value={x.hue} onChange={(h) => f.set("hue", h)} name={`hue-${d._id}`} />
          </div>
        </Card>

        <Card title={s.url}>
          <div className="dash-form">
            <Field label={s.url} hint={s.urlHint} error={f.errors.url} required>
              {(p) => (
                <div className="dash-row" style={{ flexWrap: "nowrap", alignItems: "stretch" }}>
                  <Input {...p} type="url" inputMode="url" placeholder="https://" spellCheck={false} autoCapitalize="off" value={x.url} onChange={(e) => f.set("url", e.target.value)} />
                  <Button
                    variant="ghost"
                    disabled={helper.pending || Boolean(v.webUrl(x.url))}
                    aria-busy={helper.pending}
                    onClick={() =>
                      void runHelper(async () => {
                        const requested = x.url.trim();
                        const meta = await fetchMeta({ url: requested });
                        if (meta.name && !x.name.trim()) f.set("name", meta.name);
                        if (meta.hue !== undefined) f.set("hue", nearestHue(meta.hue));
                        setIcon(meta.iconPreviewUrl ? { forUrl: requested, data: meta.iconPreviewUrl } : null);
                        return meta.iconPreviewUrl ? s.fetchedWithIcon : s.fetched;
                      })
                    }
                  >
                    <IconMagic aria-hidden="true" />
                    {helper.pending ? s.fetching : s.fetch}
                  </Button>
                </div>
              )}
            </Field>
            {helper.error ? <InlineNotice tone="danger" alert title={messageFor(helper.error)} /> : helper.note ? <InlineNotice tone="success" title={helper.note} /> : null}
            {icon !== null ? (
              <div className="dash-row" style={{ flexWrap: "nowrap", alignItems: "center", gap: 12 }}>
                <AppGlyph name={x.name || "?"} hue={x.hue} iconUrl={icon} size="lg" />
                <span className="dash-muted">{s.iconPreview}</span>
              </div>
            ) : null}
            <Field label={s.allowedDomains} hint={s.allowedDomainsHint} error={f.errors.domains} optional>
              {(p) => <Textarea {...p} rows={3} spellCheck={false} autoCapitalize="off" className="dash-mono" value={x.domains} onChange={(e) => f.set("domains", e.target.value)} />}
            </Field>
            {isNew ? <p className="dash-muted">{s.permissionsHint}</p> : null}
          </div>
        </Card>
        <OpensInCard d={d} f={f} isNew={isNew} />
      </fieldset>

      {!readOnly ? (
        <div className="dash-card dash-card--pad">
          <div className="dash-form">
            <FormError error={f.serverError} onReload={onReload} />
            {Object.values(f.errors).some(Boolean) ? <InlineNotice tone="danger" title={strings.validate.fixErrors(Object.values(f.errors).filter(Boolean).length)} /> : null}
            <div className="dash-form__actions">
              <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
                {f.pending ? strings.common.saving : isNew ? strings.common.create : strings.common.saveChanges}
              </Button>
              <Link to="/apps" className="rb-btn rb-btn--ghost">
                {strings.common.cancel}
              </Link>
              {f.dirty && !isNew ? <span className="dash-form__status">{strings.common.unsavedHint}</span> : null}
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
