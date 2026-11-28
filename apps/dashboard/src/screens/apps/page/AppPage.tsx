import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Pill, Input } from "@rulebox/ui";
import { useUpdateApp } from "../../../data";
import { DEFAULT_WEB_PERMISSIONS, type AppDetail, type DesktopAppInput, type WebAppInput, type WebPermissions } from "../../../data/types";
import { AppGlyph } from "../../../components/AppGlyph";
import { Field } from "../../../components/Field";
import { FormError } from "../../../components/FormError";
import { InlineNotice } from "../../../components/Notice";
import { PageHeader } from "../../../components/PageHeader";
import { PageTabPanel, PageTabs, type PageTab } from "../../../components/PageTabs";
import { SkeletonBlock } from "../../../components/Skeleton";
import { registerDetailSentences, messageFor } from "../../../lib/errors";
import { useCan } from "../../../lib/member";
import * as u from "../../../lib/apps/updateRules";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { browserRefusalStrings } from "../../../lib/screenStrings/appBrowser";
import { appEditStrings as s } from "../../../lib/screenStrings/appEdit";
import { appsStrings } from "../../../lib/screenStrings/apps";
import { installRefusalStrings } from "../../../lib/screenStrings/installRefusals";
import { updateRefusalStrings } from "../../../lib/screenStrings/updateRefusals";
import { strings } from "../../../lib/strings";
import { useForm } from "../../../lib/useForm";
import { useToast } from "../../../lib/toast";
import { useUrlTab } from "../../../lib/useUrlTab";
import * as v from "../../../lib/validate";
import { desktopSpec, effectiveMode, initialValues, validateValues, type FormValues } from "../appForm";
import { ArchiveActions } from "./ArchiveActions";
import DetailsTab, { type DetailsContext } from "./DetailsTab";
import { SaveBar } from "./SaveBar";
import "../apps.css";

export type { DetailsContext };

// The sentences for the refusals of the update modes, the installer details and browser rules ride this chunk, not the first load.
registerDetailSentences(updateRefusalStrings);
registerDetailSentences(installRefusalStrings);
registerDetailSentences(browserRefusalStrings);

// Every tab but Details is a chunk of its own: a tab that is not open loads and queries nothing.
const AccessTab = lazy(() => import("./AccessTab"));
const InstallsTab = lazy(() => import("./InstallsTab"));
const UpdatesTab = lazy(() => import("./UpdatesTab"));
const PermissionsTab = lazy(() => import("./PermissionsTab"));
const ActivityTab = lazy(() => import("./ActivityTab"));

const t = appAddStrings.tabs;
type TabId = "details" | "access" | "installs" | "updates" | "permissions" | "activity";
const DESKTOP_TABS: readonly TabId[] = ["details", "access", "installs", "updates", "activity"];
const WEB_TABS: readonly TabId[] = ["details", "access", "permissions", "activity"];
/** Form fields that belong to the Updates tab: a problem there is pointed at from the save bar. */
const UPDATE_FIELDS = ["version", "updateMode", "publisher", "publisherProduct", "minVersion", "feedUrl", "feedPubkey", "feedTarget"] as const;

/**
 * The slots a screen can plug into the page. The website form (its own screen) uses them:
 * - `renderDetails`: the body of the Details tab (given the page's one lifted form, see `DetailsContext`);
 * - `buildUpdate`: the `apps:update` payload for the form's values (default: today's `web` / `desktop` payload);
 * - `afterSave`: runs after a successful save (e.g. store a fetched icon); its failure only warns.
 */
export interface AppPageSlots {
  renderDetails?: (ctx: DetailsContext) => ReactNode;
  buildUpdate?: (values: FormValues, d: AppDetail) => { web?: WebAppInput; desktop?: DesktopAppInput };
  afterSave?: (values: FormValues, d: AppDetail) => Promise<void>;
}

/**
 * `/apps/:id`: one page for an app. Header (tile, name, kind, Archive/Delete), tabs synced to `?tab=`, one lifted form for Details and
 * Updates with one sticky save bar, Permissions with its own save (its draft is lifted here so a tab switch keeps it).
 */
export default function AppPage({ d, ...slots }: { d: AppDetail } & AppPageSlots) {
  // `formKey` starts the form again from the app (Discard, Reload after a stale edit, Roll back).
  const [formKey, setFormKey] = useState(0);
  const [revision, setRevision] = useState(d.revision);
  return (
    <Body
      key={formKey}
      d={d}
      {...slots}
      revision={revision}
      onSaved={() => setRevision((r) => r + 1)}
      onPermissionsSaved={setRevision}
      onRestart={(next) => {
        if (next !== undefined) setRevision(next);
        else setRevision(d.revision);
        setFormKey((k) => k + 1);
      }}
    />
  );
}

function Body({
  d,
  revision,
  onSaved,
  onPermissionsSaved,
  onRestart,
  renderDetails,
  buildUpdate,
  afterSave,
}: { d: AppDetail; revision: number; onSaved: () => void; onPermissionsSaved: (revision: number) => void; onRestart: (revision?: number) => void } & AppPageSlots) {
  const canAct = useCan("admin");
  const toast = useToast();
  const update = useUpdateApp();
  const kind = d.kind;
  const readOnly = !canAct;
  const f = useForm<FormValues>(initialValues(d, kind), (x) => validateValues(kind, x));
  const ids = kind === "desktop" ? DESKTOP_TABS : WEB_TABS;
  const [tab, setTab] = useUrlTab<TabId>(ids, "details");
  const [draft, setDraft] = useState<WebPermissions>(d.web?.permissions ?? DEFAULT_WEB_PERMISSIONS);
  const x = f.values;

  // Leaving the page with unsaved edits asks first (the browser's own question).
  useEffect(() => {
    if (!f.dirty) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [f.dirty]);

  async function save(values: FormValues) {
    const payload = (buildUpdate ?? defaultUpdate)(values, d);
    await update({ appId: d._id, expectedRevision: revision, ...payload });
    onSaved();
    if (afterSave) {
      try {
        await afterSave(values, d);
      } catch (e) {
        toast(`${s.iconNotSaved} ${messageFor(e)}`, "danger");
      }
    }
    toast(s.saved);
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!readOnly) void f.submit(save);
  };

  const tabs = useMemo<PageTab[]>(() => {
    const all: Record<TabId, PageTab> = {
      details: { id: "details", label: t.details },
      access: { id: "access", label: t.access, count: d.assignments.length || undefined },
      installs: { id: "installs", label: t.installs },
      updates: { id: "updates", label: t.updates },
      permissions: { id: "permissions", label: t.permissions },
      activity: { id: "activity", label: t.activity },
    };
    return ids.map((id) => all[id]);
  }, [ids, d.assignments.length]);

  const ctx: DetailsContext = { d, f, readOnly, revision, goTab: (id) => setTab(id as TabId), onSubmit: submit };
  const errors = Object.entries(f.errors).filter(([, m]) => Boolean(m));
  const updatesProblem = kind === "desktop" && tab !== "updates" && errors.some(([k]) => (UPDATE_FIELDS as readonly string[]).includes(k));

  return (
    <div className="dash-page apps-page">
      <PageHeader
        back={{ to: "/apps", label: s.back }}
        title={
          <span className="apps-title">
            <AppGlyph name={d.name} hue={d.hue} iconUrl={d.iconUrl} size="lg" />
            <span className="dash-wrap">{d.name}</span>
          </span>
        }
        meta={
          <>
            <Pill tone="accent">{kind === "web" ? appsStrings.web : appsStrings.desktop}</Pill>
            {d.desktop ? <Pill>{appsStrings.sources[d.desktop.source]}</Pill> : null}
            {d.archived ? <Pill tone="warning">{appsStrings.archived}</Pill> : null}
          </>
        }
        actions={<ArchiveActions d={d} />}
      />
      {d.archived ? <InlineNotice tone="warning" title={s.archived} /> : null}
      {readOnly ? <InlineNotice tone="neutral" title={strings.app.readOnly} /> : null}

      <PageTabs tabs={tabs} value={tab} onChange={(id) => setTab(id as TabId)} aria-label={s.tabsLabel} idBase="app">
        <PageTabPanel idBase="app" id={tab}>
          {tab === "details" ? (
            renderDetails ? (
              renderDetails(ctx)
            ) : kind === "desktop" ? (
              <DetailsTab ctx={ctx} />
            ) : (
              <BasicDetails ctx={ctx} />
            )
          ) : (
            <Suspense fallback={<div className="dash-card dash-card--pad" data-suspense=""><SkeletonBlock lines={5} /></div>}>
              {tab === "access" ? <AccessTab d={d} /> : null}
              {tab === "installs" ? <InstallsTab d={d} /> : null}
              {tab === "updates" ? (
                <UpdatesTab d={d} f={f} mode={effectiveMode(x)} browser={u.browserAppOf(x.exe) !== null} readOnly={readOnly} revision={revision} onRolledBack={(next) => onRestart(next)} onSubmit={submit} />
              ) : null}
              {tab === "permissions" && d.web ? (
                <PermissionsTab d={d} revision={revision} readOnly={readOnly} draft={draft} onDraft={setDraft} onSaved={onPermissionsSaved} onReload={() => onRestart()} />
              ) : null}
              {tab === "activity" ? <ActivityTab d={d} /> : null}
            </Suspense>
          )}
        </PageTabPanel>
      </PageTabs>

      {f.dirty && !readOnly ? (
        <SaveBar pending={f.pending} onSave={() => void f.submit(save)} onDiscard={() => onRestart()}>
          <FormError error={f.serverError} onReload={() => onRestart()} />
          {errors.length > 0 ? (
            <InlineNotice
              tone="danger"
              title={strings.validate.fixErrors(errors.length)}
              action={
                updatesProblem ? (
                  <button type="button" className="dash-link" onClick={() => setTab("updates")}>
                    {t.updates}
                  </button>
                ) : undefined
              }
            />
          ) : null}
        </SaveBar>
      ) : f.serverError ? (
        <FormError error={f.serverError} onReload={() => onRestart()} />
      ) : null}
    </div>
  );
}

/** Today's `apps:update` payload for the form's values. */
function defaultUpdate(values: FormValues, d: AppDetail): { web?: WebAppInput; desktop?: DesktopAppInput } {
  const common = { name: values.name.trim(), description: values.description.trim() || undefined, hue: values.hue };
  if (d.kind === "web") {
    return {
      web: {
        ...common,
        url: values.url.trim(),
        allowedDomains: v.lines(values.domains).map((line) => line.toLowerCase()),
        ...(values.browserKind === "edge" ? { browser: { kind: "edge" as const } } : {}),
        ...(values.browserKind === "chrome" ? { browser: { kind: "chrome" as const, appId: values.chromeAppId } } : {}),
      },
    };
  }
  return { desktop: { ...common, desktop: desktopSpec(values, d.desktop) } };
}

/** The Details of an app whose own form is not plugged in (`renderDetails`): the name and description, which every app has. */
function BasicDetails({ ctx }: { ctx: DetailsContext }) {
  const { f, readOnly } = ctx;
  return (
    <form className="dash-card dash-card--pad" noValidate onSubmit={ctx.onSubmit}>
      <fieldset disabled={readOnly} className="apps-fieldset">
        <div className="dash-form-grid">
          <Field label={s.name} error={f.errors.name} required>
            {(p) => <Input {...p} autoComplete="off" value={f.values.name} onChange={(e) => f.set("name", e.target.value)} />}
          </Field>
          <Field label={s.description} info={s.info.description} error={f.errors.description} optional>
            {(p) => <Input {...p} autoComplete="off" value={f.values.description} onChange={(e) => f.set("description", e.target.value)} />}
          </Field>
        </div>
      </fieldset>
    </form>
  );
}
