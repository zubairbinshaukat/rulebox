import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Checkbox, Input, Pill, SegmentedControl, Select, Switch, Textarea } from "@rulebox/ui";
import IconDownload from "~icons/solar/download-minimalistic-linear";
import IconMagic from "~icons/solar/stars-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import IconArchive from "~icons/solar/archive-linear";
import IconTrash from "~icons/solar/trash-bin-trash-linear";
import {
  useAppDetail,
  useAppInstalls,
  useAssignApp,
  useCreateDesktopApp,
  useCreateWebApp,
  useDeleteApp,
  useFetchWebMeta,
  useResolveWinget,
  useRetryApp,
  useSetAppArchived,
  useUpdateApp,
} from "../data";
import {
  DEFAULT_WEB_PERMISSIONS,
  INSTALL_STATES,
  type AppDetail,
  type AppInstallRow,
  type AppKind,
  type Audience,
  type DesktopSource,
  type DesktopSpec,
  type InstallState,
  type WebPermissions,
  type WingetResolved,
} from "../data/types";
import { AppGlyph } from "../components/AppGlyph";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Field, FieldSet } from "../components/Field";
import { FormError } from "../components/FormError";
import { HistoryPanel } from "../components/HistoryPanel";
import { InstallStatePill } from "../components/InstallState";
import { installDetail } from "../lib/install";
import { LoadMore } from "../components/LoadMore";
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { PagedRegion, QueryRegion } from "../components/Region";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { useCan } from "../lib/member";
import { SkeletonBlock, SkeletonRows } from "../components/Skeleton";
import { useToast } from "../lib/toast";
import { formatBytes, formatCount, shortHex } from "../lib/format";
import { messageFor } from "../lib/errors";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";

const s = strings.appEdit;
const HUES = [175, 150, 100, 60, 40, 20, 0, 330, 300, 260, 220, 200];
const SOURCES: DesktopSource[] = ["winget", "msi", "exe", "portable", "preinstalled"];

interface FormValues extends Record<string, unknown> {
  name: string;
  description: string;
  hue: number | undefined;
  url: string;
  domains: string;
  source: DesktopSource;
  wingetId: string;
  wingetVersion: string;
  resolved: WingetResolved | null;
  installUrl: string;
  sha256: string;
  silentArgs: string;
  productCode: string;
  removeWhenUnassigned: boolean;
  exe: string;
  args: string;
  fileArg: string;
  resetFolders: string;
}

function initialValues(d: AppDetail, kind: AppKind): FormValues {
  const desk = d.desktop;
  const install = desk?.install;
  const source = desk?.source ?? "winget";
  return {
    name: d.name,
    description: d.description ?? "",
    hue: d.hue,
    url: d.web?.url ?? "",
    domains: (d.web?.allowedDomains ?? []).filter((x) => {
      try {
        return x !== new URL(d.web?.url ?? "").hostname;
      } catch {
        return true;
      }
    }).join("\n"),
    source,
    wingetId: desk?.wingetId ?? "",
    wingetVersion: desk?.wingetVersion ?? "",
    resolved:
      source === "winget" && install && desk?.wingetId
        ? { packageId: desk.wingetId, version: desk.wingetVersion ?? "", install }
        : null,
    installUrl: install?.url ?? "",
    sha256: install?.sha256 ?? "",
    silentArgs: v.joinArgs(install?.silentArgs ?? []),
    productCode: install?.productCode ?? "",
    removeWhenUnassigned: install?.removeWhenUnassigned ?? true,
    exe: desk?.exe ?? (kind === "desktop" ? "{ProgramFiles}\\" : ""),
    args: v.joinArgs(desk?.args ?? []),
    fileArg: v.joinArgs(desk?.fileArgTemplate ?? (kind === "desktop" ? ["{file}"] : [])),
    resetFolders: (desk?.resetFolders ?? []).join("\n"),
  };
}

function validateValues(kind: AppKind, x: FormValues): Partial<Record<keyof FormValues & string, string>> {
  const common = {
    name: v.name(x.name, v.NAME_MAX.app) ?? undefined,
    description: v.optionalText(x.description, v.NAME_MAX.description) ?? undefined,
  };
  if (kind === "web") {
    return { ...common, url: v.webUrl(x.url) ?? undefined, domains: v.domains(v.lines(x.domains)) ?? undefined };
  }
  const needsInstall = x.source === "msi" || x.source === "exe" || x.source === "portable";
  return {
    ...common,
    wingetId: x.source === "winget" ? (v.wingetId(x.wingetId) ?? (x.resolved ? undefined : s.resolveFirst)) : undefined,
    installUrl: needsInstall ? (v.installerUrl(x.installUrl) ?? undefined) : undefined,
    sha256: needsInstall ? (v.sha256(x.sha256) ?? undefined) : undefined,
    silentArgs: x.source === "exe" ? (v.silentArgs(v.splitArgs(x.silentArgs)) ?? undefined) : undefined,
    productCode: x.source === "msi" ? (v.productCode(x.productCode) ?? undefined) : undefined,
    exe: v.exePath(x.exe, x.source === "portable") ?? undefined,
    args: v.args(v.splitArgs(x.args)) ?? undefined,
    fileArg: v.fileArgTemplate(v.splitArgs(x.fileArg)) ?? undefined,
    resetFolders: v.resetFolders(v.lines(x.resetFolders)) ?? undefined,
  };
}

function desktopSpec(x: FormValues): DesktopSpec {
  const base = {
    source: x.source,
    exe: x.exe.trim(),
    args: v.splitArgs(x.args),
    fileArgTemplate: v.splitArgs(x.fileArg),
    resetFolders: v.lines(x.resetFolders),
  };
  switch (x.source) {
    case "winget":
      return { ...base, wingetId: x.resolved?.packageId ?? x.wingetId.trim(), wingetVersion: x.resolved?.version, install: x.resolved?.install };
    case "preinstalled":
      return base;
    default:
      return {
        ...base,
        install: {
          kind: x.source,
          url: x.installUrl.trim(),
          sha256: x.sha256.trim().toLowerCase(),
          sizeBytes: 0,
          silentArgs: x.source === "exe" ? v.splitArgs(x.silentArgs) : [],
          productCode: x.source === "msi" && x.productCode.trim() ? x.productCode.trim().toUpperCase() : undefined,
          successExitCodes: [0],
          removeWhenUnassigned: x.source === "exe" ? false : x.removeWhenUnassigned,
        },
      };
  }
}

/** `apps:get`; `/apps/new?kind=web|desktop` uses the same form. */
export default function AppEdit() {
  const { id = "new" } = useParams();
  const [params] = useSearchParams();
  const isNew = id === "new";
  const detail = useAppDetail(isNew ? "new" : id);
  const kind: AppKind | null = isNew ? (params.get("kind") === "desktop" ? "desktop" : "web") : null;
  return (
    <div className="dash-page">
      {detail.status !== "ready" ? (
        <PageHeader title={detail.status === "loading" ? strings.app.loading : strings.apps.title} back={{ to: "/apps", label: s.back }} />
      ) : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
        {(d) => <AppScreen key={`${d._id}:${kind ?? d.kind}`} d={d} kind={kind ?? d.kind} isNew={isNew} />}
      </QueryRegion>
    </div>
  );
}

function AppScreen({ d, kind, isNew }: { d: AppDetail; kind: AppKind; isNew: boolean }) {
  const canAct = useCan("admin");
  const [formKey, setFormKey] = useState(0);
  const [revision, setRevision] = useState(d.revision);
  const title = isNew ? (kind === "web" ? s.newWebTitle : s.newDesktopTitle) : d.name;
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
              <Pill tone="accent">{kind === "web" ? strings.apps.web : strings.apps.desktop}</Pill>
              {d.desktop ? <Pill>{strings.apps.sources[d.desktop.source]}</Pill> : null}
              {d.archived ? <Pill tone="warning">{strings.apps.archived}</Pill> : null}
            </>
          ) : undefined
        }
        actions={!isNew ? <ArchiveActions d={d} /> : undefined}
      />
      {!isNew && d.archived ? <InlineNotice tone="warning" title={s.archived} /> : null}
      {!isNew && !canAct ? <InlineNotice tone="neutral" title={strings.app.readOnly} /> : null}
      <div className={isNew ? "dash-stack" : "dash-grid dash-grid--main"}>
        <div className="dash-stack">
          <AppForm
            key={formKey}
            d={d}
            kind={kind}
            isNew={isNew}
            readOnly={!canAct}
            revision={revision}
            onSaved={() => setRevision((r) => r + 1)}
            onReload={() => {
              setRevision(d.revision);
              setFormKey((k) => k + 1);
            }}
          />
          {!isNew && kind === "desktop" ? <InstallStatus d={d} /> : null}
        </div>
        {!isNew ? (
          <div className="dash-stack">
            <AssignmentsCard d={d} />
            {kind === "desktop" ? (
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
                <p style={{ marginTop: 12 }}>
                  <Link className="dash-link" to="/file-types">
                    {s.fileTypesManage}
                  </Link>
                </p>
              </Card>
            ) : null}
            <HistoryPanel targetId={d._id} title={s.history} />
          </div>
        ) : null}
      </div>
    </>
  );
}

function HuePicker({ value, onChange, name }: { value: number | undefined; onChange: (h: number) => void; name: string }) {
  return (
    <FieldSet legend={s.hue} hint={s.hueHint}>
      <div className="dash-hue" role="radiogroup" aria-label={s.hue}>
        {HUES.map((h) => (
          <label key={h} className="dash-hue__swatch" style={{ "--h": h } as CSSProperties} title={`${s.hue} ${h}`}>
            <input type="radio" className="dash-sr" name={name} checked={value === h} onChange={() => onChange(h)} aria-label={`${s.hue} ${h}°`} />
          </label>
        ))}
      </div>
    </FieldSet>
  );
}

function AppForm({
  d,
  kind,
  isNew,
  readOnly,
  revision,
  onSaved,
  onReload,
}: {
  d: AppDetail;
  kind: AppKind;
  isNew: boolean;
  readOnly: boolean;
  revision: number;
  onSaved: () => void;
  onReload: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const createWeb = useCreateWebApp();
  const createDesktop = useCreateDesktopApp();
  const update = useUpdateApp();
  const fetchMeta = useFetchWebMeta();
  const resolve = useResolveWinget();
  const form = useRef<HTMLFormElement>(null);
  const f = useForm<FormValues>(initialValues(d, kind), (x) => validateValues(kind, x));
  const [helper, setHelper] = useState<{ pending: boolean; error: unknown; note: string | null }>({ pending: false, error: null, note: null });
  const x = f.values;

  async function runHelper(fn: () => Promise<string>) {
    setHelper({ pending: true, error: null, note: null });
    try {
      setHelper({ pending: false, error: null, note: await fn() });
    } catch (e) {
      setHelper({ pending: false, error: e, note: null });
    }
  }

  async function save(values: FormValues) {
    const common = { name: values.name.trim(), description: values.description.trim() || undefined, hue: values.hue };
    if (kind === "web") {
      const web = { ...common, url: values.url.trim(), allowedDomains: v.lines(values.domains).map((s2) => s2.toLowerCase()) };
      if (isNew) {
        const id = await createWeb(web);
        toast(s.created(common.name));
        navigate(`/apps/${id}`, { replace: true });
      } else {
        await update({ appId: d._id, expectedRevision: revision, web });
        onSaved();
        toast(s.saved);
      }
    } else {
      const desktop = { ...common, desktop: desktopSpec(values) };
      if (isNew) {
        const id = await createDesktop(desktop);
        toast(s.created(common.name));
        navigate(`/apps/${id}`, { replace: true });
      } else {
        await update({ appId: d._id, expectedRevision: revision, desktop });
        onSaved();
        toast(s.saved);
      }
    }
  }

  const permissions = Object.entries(DEFAULT_WEB_PERMISSIONS) as [keyof WebPermissions, boolean][];

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
      <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} className="dash-stack">
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

        {kind === "web" ? (
          <Card title={s.url}>
            <div className="dash-form">
              <Field label={s.url} hint={s.urlHint} error={f.errors.url} required>
                {(p) => (
                  <div className="dash-row" style={{ flexWrap: "nowrap", alignItems: "stretch" }}>
                    <Input
                      {...p}
                      type="url"
                      inputMode="url"
                      placeholder="https://"
                      spellCheck={false}
                      autoCapitalize="off"
                      value={x.url}
                      onChange={(e) => f.set("url", e.target.value)}
                    />
                    <Button
                      variant="ghost"
                      disabled={helper.pending || Boolean(v.webUrl(x.url))}
                      aria-busy={helper.pending}
                      onClick={() =>
                        void runHelper(async () => {
                          const meta = await fetchMeta({ url: x.url.trim() });
                          if (meta.name && !x.name.trim()) f.set("name", meta.name);
                          if (meta.hue !== undefined) f.set("hue", nearestHue(meta.hue));
                          return s.fetched;
                        })
                      }
                    >
                      <IconMagic aria-hidden="true" />
                      {helper.pending ? s.fetching : s.fetch}
                    </Button>
                  </div>
                )}
              </Field>
              <HelperResult helper={helper} />
              <Field label={s.allowedDomains} hint={s.allowedDomainsHint} error={f.errors.domains} optional>
                {(p) => (
                  <Textarea {...p} rows={3} spellCheck={false} autoCapitalize="off" className="dash-mono" value={x.domains} onChange={(e) => f.set("domains", e.target.value)} />
                )}
              </Field>
              <FieldSet legend={s.permissions} hint={s.permissionsHint}>
                <div className="dash-pills">
                  {permissions.map(([key, on]) => (
                    <Pill key={key} tone={on ? "success" : "neutral"} dot>
                      {s.permissionNames[key]}: {on ? strings.common.yes : strings.common.no}
                    </Pill>
                  ))}
                </div>
              </FieldSet>
            </div>
          </Card>
        ) : (
          <>
            <Card title={s.source} sub={s.sourceHints[x.source]}>
              <div className="dash-form">
                <div style={{ overflowX: "auto", maxWidth: "100%" }}>
                  <SegmentedControl<DesktopSource>
                    aria-label={s.source}
                    options={SOURCES.map((src) => ({ value: src, label: strings.apps.sources[src] }))}
                    value={x.source}
                    onChange={(src) => {
                      f.set("source", src);
                      if (src === "portable" && !x.exe.startsWith("{RuleboxApps}")) f.set("exe", "{RuleboxApps}\\{AppId}\\app.exe");
                      if (src !== "portable" && x.exe.startsWith("{RuleboxApps}")) f.set("exe", "{ProgramFiles}\\");
                    }}
                  />
                </div>

                {x.source === "winget" ? (
                  <>
                    <div className="dash-form__row">
                      <Field label={s.wingetId} error={f.errors.wingetId} required>
                        {(p) => (
                          <Input
                            {...p}
                            className="dash-mono"
                            placeholder="VideoLAN.VLC"
                            spellCheck={false}
                            autoCapitalize="off"
                            value={x.wingetId}
                            onChange={(e) => {
                              f.set("wingetId", e.target.value);
                              f.set("resolved", null);
                            }}
                          />
                        )}
                      </Field>
                      <Field label={s.wingetVersion} hint={s.wingetVersionHint} optional>
                        {(p) => (
                          <Input
                            {...p}
                            className="dash-mono"
                            spellCheck={false}
                            value={x.wingetVersion}
                            onChange={(e) => {
                              f.set("wingetVersion", e.target.value);
                              f.set("resolved", null);
                            }}
                          />
                        )}
                      </Field>
                    </div>
                    <div className="dash-row">
                      <Button
                        variant="ghost"
                        disabled={helper.pending || Boolean(v.wingetId(x.wingetId))}
                        aria-busy={helper.pending}
                        onClick={() =>
                          void runHelper(async () => {
                            const r = await resolve({ packageId: x.wingetId.trim(), version: x.wingetVersion.trim() || undefined });
                            f.set("resolved", r);
                            f.set("wingetVersion", r.version);
                            if (!x.name.trim() && r.name) f.set("name", r.name);
                            f.set("removeWhenUnassigned", r.install.removeWhenUnassigned);
                            return s.resolved(r.packageId, r.version);
                          })
                        }
                      >
                        <IconDownload aria-hidden="true" />
                        {helper.pending ? s.resolving : x.resolved && !isNew ? s.checkUpdate : s.resolve}
                      </Button>
                    </div>
                    <HelperResult helper={helper} />
                    {x.resolved ? <ResolvedSummary r={x.resolved} /> : null}
                  </>
                ) : null}

                {x.source === "msi" || x.source === "exe" || x.source === "portable" ? (
                  <>
                    <Field label={s.installerUrl} hint={s.urlHint} error={f.errors.installUrl} required>
                      {(p) => (
                        <Input {...p} type="url" inputMode="url" spellCheck={false} autoCapitalize="off" placeholder="https://" value={x.installUrl} onChange={(e) => f.set("installUrl", e.target.value)} />
                      )}
                    </Field>
                    <Field label={s.sha256} error={f.errors.sha256} required>
                      {(p) => (
                        <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={80} value={x.sha256} onChange={(e) => f.set("sha256", e.target.value)} />
                      )}
                    </Field>
                  </>
                ) : null}
                {x.source === "exe" ? (
                  <>
                    <Field label={s.silentArgs} hint={s.silentArgsHint} error={f.errors.silentArgs} required>
                      {(p) => <Input {...p} className="dash-mono" spellCheck={false} value={x.silentArgs} onChange={(e) => f.set("silentArgs", e.target.value)} />}
                    </Field>
                    <InlineNotice tone="neutral" title={s.removeExeNote} />
                  </>
                ) : null}
                {x.source === "msi" ? (
                  <Field label={s.productCode} hint={s.productCodeHint} error={f.errors.productCode} optional>
                    {(p) => <Input {...p} className="dash-mono" spellCheck={false} placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}" value={x.productCode} onChange={(e) => f.set("productCode", e.target.value)} />}
                  </Field>
                ) : null}
                {x.source === "msi" || x.source === "portable" || (x.source === "winget" && x.resolved?.install.kind === "msi") ? (
                  <Switch checked={x.removeWhenUnassigned} onChange={(val) => f.set("removeWhenUnassigned", val)} label={s.removeWhenUnassigned} disabled={readOnly} />
                ) : null}
              </div>
            </Card>

            <Card title={s.exe}>
              <div className="dash-form">
                <Field
                  label={s.exe}
                  hint={x.resolved?.defaultInstallLocation ? `${s.exeHint} ${s.exeSuggest(x.resolved.defaultInstallLocation)}` : s.exeHint}
                  error={f.errors.exe}
                  required
                >
                  {(p) => <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" value={x.exe} onChange={(e) => f.set("exe", e.target.value)} />}
                </Field>
                <div className="dash-form__row">
                  <Field label={s.args} hint={s.argsHint} error={f.errors.args} optional>
                    {(p) => <Input {...p} className="dash-mono" spellCheck={false} value={x.args} onChange={(e) => f.set("args", e.target.value)} />}
                  </Field>
                  <Field label={s.fileArg} hint={s.fileArgHint} error={f.errors.fileArg} optional>
                    {(p) => <Input {...p} className="dash-mono" spellCheck={false} value={x.fileArg} onChange={(e) => f.set("fileArg", e.target.value)} />}
                  </Field>
                </div>
                <Field label={s.resetFolders} hint={s.resetFoldersHint} error={f.errors.resetFolders} optional>
                  {(p) => <Textarea {...p} rows={3} className="dash-mono" spellCheck={false} value={x.resetFolders} onChange={(e) => f.set("resetFolders", e.target.value)} />}
                </Field>
              </div>
            </Card>
          </>
        )}
      </fieldset>

      {!readOnly ? (
        <div className="dash-card dash-card--pad">
          <div className="dash-form">
            <FormError error={f.serverError} onReload={onReload} />
            {Object.values(f.errors).some(Boolean) ? (
              <InlineNotice tone="danger" title={strings.validate.fixErrors(Object.values(f.errors).filter(Boolean).length)} />
            ) : null}
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

function nearestHue(h: number): number {
  return HUES.reduce((best, x) => (Math.abs(x - h) < Math.abs(best - h) ? x : best), HUES[0]!);
}

function HelperResult({ helper }: { helper: { pending: boolean; error: unknown; note: string | null } }) {
  if (helper.error) return <InlineNotice tone="danger" alert title={messageFor(helper.error)} />;
  if (helper.note) return <InlineNotice tone="success" title={helper.note} />;
  return null;
}

function ResolvedSummary({ r }: { r: WingetResolved }) {
  return (
    <dl className="dash-kv" style={{ padding: 14, borderRadius: 12, background: "var(--rb-paper)", border: "1px solid var(--rb-line)" }}>
      <div className="dash-kv__item">
        <dt>{s.wingetId}</dt>
        <dd className="dash-mono">
          {r.packageId} {r.version}
        </dd>
      </div>
      <div className="dash-kv__item">
        <dt>{s.kind}</dt>
        <dd>{strings.apps.sources[r.install.kind]}</dd>
      </div>
      <div className="dash-kv__item">
        <dt>{s.sha256}</dt>
        <dd className="dash-mono" title={r.install.sha256}>
          {shortHex(r.install.sha256, 12, 6)}
        </dd>
      </div>
      {r.install.sizeBytes ? (
        <div className="dash-kv__item">
          <dt>{s.sizeBytes}</dt>
          <dd>{formatBytes(r.install.sizeBytes)}</dd>
        </div>
      ) : null}
      {r.install.silentArgs.length ? (
        <div className="dash-kv__item">
          <dt>{s.silentArgs}</dt>
          <dd className="dash-mono">{r.install.silentArgs.join(" ")}</dd>
        </div>
      ) : null}
      <div className="dash-kv__item" style={{ gridColumn: "1 / -1" }}>
        <dt>{s.installerUrl}</dt>
        <dd className="dash-mono" style={{ fontSize: 12.5 }}>
          {r.install.url}
        </dd>
      </div>
    </dl>
  );
}

function ArchiveActions({ d }: { d: AppDetail }) {
  const setArchived = useSetAppArchived();
  const del = useDeleteApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null);
  return (
    <RoleGate minRole="admin">
      {d.archived ? (
        <>
          <Button variant="ghost" onClick={() => setArchived({ appId: d._id, archived: false }).catch((e) => toast(messageFor(e), "danger"))}>
            {s.unarchive}
          </Button>
          <Button variant="danger-ghost" onClick={() => setDialog("delete")}>
            <IconTrash aria-hidden="true" />
            {strings.common.delete}
          </Button>
        </>
      ) : (
        <Button variant="danger-ghost" onClick={() => setDialog("archive")}>
          <IconArchive aria-hidden="true" />
          {s.archive}
        </Button>
      )}
      <ConfirmDialog
        open={dialog === "archive"}
        title={s.archiveTitle}
        body={s.archiveBody}
        confirmLabel={s.archive}
        danger
        typeToConfirm={d.name}
        onConfirm={() => setArchived({ appId: d._id, archived: true })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        title={s.deleteTitle}
        body={s.deleteBody}
        confirmLabel={strings.common.delete}
        danger
        typeToConfirm={d.name}
        onConfirm={() => del({ appId: d._id })}
        onDone={() => {
          toast(s.deleted(d.name));
          navigate("/apps?archived=1", { replace: true });
        }}
        onClose={() => setDialog(null)}
      />
    </RoleGate>
  );
}

function AssignmentsCard({ d }: { d: AppDetail }) {
  const [assigning, setAssigning] = useState(false);
  return (
    <Card
      title={s.assignments}
      body="flush"
      actions={
        !d.archived ? (
          <RoleGate minRole="admin">
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setAssigning(true)}>
              <IconAdd aria-hidden="true" />
              {s.assign}
            </Button>
          </RoleGate>
        ) : undefined
      }
    >
      {d.assignments.length === 0 ? (
        <EmptyState compact title={s.assignmentsNone} />
      ) : (
        <ul className="dash-list">
          {d.assignments.map((a) => (
            <li key={a._id} className="dash-list__item">
              <div className="dash-list__body">
                <Link className="dash-link dash-link--plain dash-truncate" to={`/groups/${a.groupId}`} title={a.groupName}>
                  {a.groupName}
                </Link>
                <p className="dash-list__meta">
                  {a.audience === "everyone" ? strings.group.audienceEveryone : strings.group.audienceSelected}
                  {a.pinnedTaskbar ? ` · ${strings.group.pinnedTaskbar}` : ""}
                  {a.pinnedDesktop ? ` · ${strings.group.pinnedDesktop}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {d.directEmployeeCount > 0 ? (
        <p className="dash-muted" style={{ padding: "12px 22px 16px", fontSize: 13 }}>
          {s.directEmployees(d.directEmployeeCount)}
        </p>
      ) : null}
      {assigning ? <AssignToGroup d={d} onClose={() => setAssigning(false)} /> : null}
    </Card>
  );
}

function AssignToGroup({ d, onClose }: { d: AppDetail; onClose: () => void }) {
  const assign = useAssignApp();
  const toast = useToast();
  const options = d.groupOptions.filter((g) => !d.assignments.some((a) => a.groupId === g._id));
  const f = useForm(
    { groupId: options[0]?._id ?? "", audience: "everyone" as Audience, pinnedTaskbar: false, pinnedDesktop: true },
    (x) => ({ groupId: x.groupId ? undefined : strings.validate.pickGroup }),
  );
  return (
    <Modal
      open
      title={s.assign}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await assign({ appId: d._id, ...x });
          toast(strings.common.saved);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending || options.length === 0} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : s.assign}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={strings.enrollment.group} error={f.errors.groupId} required>
          {(p) => (
            <Select {...p} value={f.values.groupId} onChange={(e) => f.set("groupId", e.target.value)}>
              {options.map((g) => (
                <option key={g._id} value={g._id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={strings.group.audience}>
          {(p) => (
            <Select {...p} value={f.values.audience} onChange={(e) => f.set("audience", e.target.value as Audience)}>
              <option value="everyone">{strings.group.audienceEveryone}</option>
              <option value="selected">{strings.group.audienceSelected}</option>
            </Select>
          )}
        </Field>
        <FieldSet legend={strings.group.pins}>
          <div className="dash-checks dash-checks--inline">
            <Checkbox label={strings.group.pinTaskbar} checked={f.values.pinnedTaskbar} onChange={(e) => f.set("pinnedTaskbar", e.target.checked)} />
            <Checkbox label={strings.group.pinDesktop} checked={f.values.pinnedDesktop} onChange={(e) => f.set("pinnedDesktop", e.target.checked)} />
          </div>
        </FieldSet>
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}

function InstallStatus({ d }: { d: AppDetail }) {
  const present = INSTALL_STATES.filter((st) => (d.installCounts[st] ?? 0) > 0);
  const [state, setState] = useState<InstallState>(present[0] ?? "installed");
  const retry = useRetryApp();
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  return (
    <Card
      title={s.installStatus}
      body="none"
      actions={
        (d.installCounts.failed ?? 0) > 0 ? (
          <RoleGate minRole="admin">
            <Button
              variant="ghost"
              className="dash-btn--sm"
              disabled={retrying}
              aria-busy={retrying}
              onClick={() => {
                setRetrying(true);
                retry({ appId: d._id }).then(
                  () => {
                    setRetrying(false);
                    toast(strings.install.retried);
                  },
                  (e) => {
                    setRetrying(false);
                    toast(messageFor(e), "danger");
                  },
                );
              }}
            >
              {strings.install.retry}
            </Button>
          </RoleGate>
        ) : undefined
      }
    >
      {present.length === 0 ? (
        <EmptyState compact title={s.installStatusNone} />
      ) : (
        <>
          <div className="dash-row" style={{ padding: "12px clamp(16px, 2vw, 22px)" }} role="group" aria-label={s.installState}>
            {present.map((st) => (
              <button key={st} type="button" className="dash-state-btn" aria-pressed={state === st} onClick={() => setState(st)}>
                {strings.installState[st]}
                <span className="dash-state-btn__count">{formatCount(d.installCounts[st] ?? 0, 1000)}</span>
              </button>
            ))}
          </div>
          <InstallList appId={d._id} state={state} />
        </>
      )}
    </Card>
  );
}

function InstallList({ appId, state }: { appId: string; state: InstallState }) {
  const rows = useAppInstalls(appId, state);
  const cols = useMemo<Column<AppInstallRow>[]>(
    () => [
      {
        key: "device",
        header: strings.devices.colName,
        primary: true,
        cell: (r) => (
          <Link className="dash-link dash-link--plain dash-truncate" to={`/devices/${r.deviceId}`}>
            {r.deviceName}
          </Link>
        ),
      },
      { key: "state", header: s.installState, cell: (r) => <InstallStatePill state={r.state} /> },
      {
        key: "detail",
        header: strings.common.details,
        cell: (r) =>
          r.state === "failed" ? (
            <span className="dash-muted" style={{ fontSize: 13 }}>
              {installDetail(r.detail)}
              {r.exitCode !== undefined ? ` · ${strings.install.exitCode(r.exitCode)}` : ""}
            </span>
          ) : (
            <RelativeTime ms={r.updatedAt} />
          ),
      },
    ],
    [],
  );
  return (
    <PagedRegion state={rows} skeleton={<SkeletonRows rows={4} columns={3} />}>
      {(p) =>
        p.items.length === 0 ? (
          <EmptyState compact title={s.installStatusNone} />
        ) : (
          <>
            <DataTable caption={s.installStatus} columns={cols} rows={p.items} getKey={(r) => r._id} />
            <LoadMore shown={p.items.length} canLoadMore={p.canLoadMore} isLoadingMore={p.isLoadingMore} loadMore={p.loadMore} />
          </>
        )
      }
    </PagedRegion>
  );
}
