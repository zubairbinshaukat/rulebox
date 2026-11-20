import { lazy, Suspense, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Checkbox, Input, Pill, SegmentedControl, Select, Switch, Textarea } from "@rulebox/ui";
import IconDownload from "~icons/solar/download-minimalistic-linear";
import IconMagic from "~icons/solar/stars-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import IconArchive from "~icons/solar/archive-linear";
import IconTrash from "~icons/solar/trash-bin-trash-linear";
import {
  useAppDetail,
  useAppInstallSummary,
  useAssignApp,
  useCreateDesktopApp,
  useCreateWebApp,
  useDeleteApp,
  useFetchWebMeta,
  useResolveWinget,
  useRetryApp,
  useSaveAppIcon,
  useSetAppArchived,
  useUpdateApp,
} from "../data";
import { useAppInstalls } from "../data/apps";
import {
  INSTALL_STATES,
  type AppDetail,
  type AppInstallRow,
  type AppKind,
  type ApplyWhen,
  type Audience,
  type BrowserKind,
  type DesktopSource,
  type DesktopSpec,
  type InstallCounts,
  type InstallState,
  type WizardTech,
  type UpdateMode,
  type UpdateSpec,
  type WingetResolved,
} from "../data/types";
import { AppPermissions } from "./AppPermissions";
import { BrowserRulesCard, OpensInCard } from "./AppBrowser";
import type { InspectState } from "./AppInstaller";
// The Updates card (Phase 6 Step 10) is a chunk of its own: most edits are of websites, and the card is the largest part of the form.
const UpdatesCard = lazy(() => import("./AppUpdates"));
// The installer details (Phase 6 Step 13: Detect, the pre-filled switches, answer file, timeout) are one lazy chunk too.
const DetectRow = lazy(() => import("./AppInstaller").then((m) => ({ default: m.DetectRow })));
const InstallerCard = lazy(() => import("./AppInstaller").then((m) => ({ default: m.InstallerCard })));
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
import { Modal } from "../components/Modal";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { Pager } from "../components/Pager";
import { QueryRegion } from "../components/Region";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { ServerTable } from "../components/ServerTable";
import { PAGE_SIZES } from "../lib/cursorPager";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { useCan } from "../lib/member";
import { SkeletonBlock, SkeletonRows } from "../components/Skeleton";
import { useToast } from "../lib/toast";
import { formatBytes, formatCount, shortHex } from "../lib/format";
import { messageFor, registerDetailSentences } from "../lib/errors";
import { strings } from "../lib/strings";
import { appEditStrings } from "../lib/screenStrings/appEdit";
import { updateRefusalStrings } from "../lib/screenStrings/updateRefusals";
import { appBrowserStrings, browserRefusalStrings } from "../lib/screenStrings/appBrowser";
import { installFormStrings, installRefusalStrings } from "../lib/screenStrings/installRefusals";
import { appsStrings } from "../lib/screenStrings/apps";
import { devicesStrings } from "../lib/screenStrings/devices";
import { groupStrings } from "../lib/screenStrings/group";
import { installStrings } from "../lib/screenStrings/install";
import { installStateStrings } from "../lib/screenStrings/installState";
import { useForm } from "../lib/useForm";
import { assignmentErrorMessage } from "./groups/errors";
import * as v from "../lib/validate";
import * as u from "../lib/apps/updateRules";
import * as ins from "../lib/apps/installerRules";
import { browserSitesProblem } from "../lib/apps/browserRules";

const s = appEditStrings;
// The sentences for the refusals of the update modes ride this chunk, not the first load (`lib/errors.ts`).
registerDetailSentences(updateRefusalStrings);
registerDetailSentences(browserRefusalStrings);
registerDetailSentences(installRefusalStrings);
const HUES = [175, 150, 100, 60, 40, 20, 0, 330, 300, 260, 220, 200];
const SOURCES: DesktopSource[] = ["winget", "msi", "exe", "portable", "preinstalled"];

export interface FormValues extends Record<string, unknown> {
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
  // Phase 6: versions and update modes
  version: string;
  updateMode: UpdateMode;
  publisher: string;
  publisherProduct: string;
  minVersion: string;
  feedUrl: string;
  feedPubkey: string;
  feedTarget: string;
  autoPublish: boolean;
  applyWhen: ApplyWhen;
  rollbackOnFail: boolean;
  // Phase 6 Step 16: browser web apps (a website) and browser rules (Chrome or Edge as a program)
  browserKind: BrowserKind;
  chromeAppId: string;
  sites: string;
  // Phase 6 Step 13: installer details (an MSI or EXE program)
  tech: WizardTech | "";
  successCodes: string;
  timeoutMin: string;
  installPublisher: string;
  answerOn: boolean;
  answerUrl: string;
  answerSha256: string;
}

export type FormApi = ReturnType<typeof useForm<FormValues>>;

/** Chrome and Edge can only be Vendor mode (plan 4.4.2): the form shows and saves that whatever was picked. */
function effectiveMode(x: FormValues): UpdateMode {
  return u.browserAppOf(x.exe) !== null ? "vendor" : x.updateMode;
}

function initialValues(d: AppDetail, kind: AppKind): FormValues {
  const desk = d.desktop;
  const install = desk?.install;
  const up = desk?.update;
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
    version: desk?.version ?? "",
    updateMode: up?.mode ?? "pinned",
    publisher: up?.publisher ?? "",
    publisherProduct: up?.publisherProduct ?? "",
    minVersion: up?.minVersion ?? "",
    feedUrl: up?.feed?.url ?? "",
    feedPubkey: up?.feed?.pubkey ?? "",
    feedTarget: up?.feed?.target ?? "windows-x86_64-nsis",
    autoPublish: up?.autoPublish ?? true,
    applyWhen: up?.applyWhen ?? "boot_or_signed_out",
    rollbackOnFail: up?.rollbackOnFail ?? true,
    browserKind: d.web?.browser?.kind ?? "builtin",
    chromeAppId: d.web?.browser?.kind === "chrome" ? (d.web.browser.appId ?? "") : "",
    sites: (desk?.browserSites ?? []).join("\n"),
    tech: install?.tech !== undefined ? ins.storedTech(install.tech) : "",
    successCodes: ins.formatExitCodes(install?.successExitCodes ?? [0]),
    timeoutMin: install?.timeoutMin !== undefined ? String(install.timeoutMin) : "",
    installPublisher: install?.publisher ?? "",
    answerOn: install?.answerFile !== undefined,
    answerUrl: install?.answerFile?.url ?? "",
    answerSha256: install?.answerFile?.sha256 ?? "",
  };
}

/** The installer details of an MSI or EXE program against the rules of plan 4.2 and 4.6 (the server decides; these are the inline messages). */
function installerProblems(x: FormValues): Partial<Record<keyof FormValues & string, string>> {
  if (x.source !== "msi" && x.source !== "exe") return {};
  const out: Partial<Record<keyof FormValues & string, string>> = {};
  if (ins.timeoutProblem(x.timeoutMin)) out.timeoutMin = installFormStrings.timeoutBad;
  if (x.installPublisher.trim().length > ins.MAX_PUBLISHER) out.installPublisher = installFormStrings.publisherBad;
  if (x.source !== "exe") return out;
  if (ins.parseExitCodes(x.successCodes) === null) out.successCodes = installFormStrings.successCodesBad;
  const args = v.splitArgs(x.silentArgs);
  const usesToken = args.some((a) => a.includes("{AnswerFile}"));
  if (ins.silentArgTokenProblem(args)) out.silentArgs ??= installFormStrings.tokenBad;
  if (x.answerOn) {
    const url = ins.answerUrlProblem(x.answerUrl);
    if (url !== null) out.answerUrl = installFormStrings.answerUrlBad;
    const hash = v.sha256(x.answerSha256);
    if (hash !== null) out.answerSha256 = hash;
    if (!usesToken) out.silentArgs ??= installFormStrings.answerNeedsToken;
  } else if (usesToken) {
    out.silentArgs ??= installFormStrings.tokenNeedsAnswer;
  }
  return out;
}

/** The version fields of the form against the rules of plan 4.4 (the server decides; these are the inline messages). */
function updateProblems(x: FormValues): Partial<Record<keyof FormValues & string, string>> {
  const mode = effectiveMode(x);
  const version = x.version.trim();
  const min = x.minVersion.trim();
  const hasInstaller = x.source !== "preinstalled";
  const out: Partial<Record<keyof FormValues & string, string>> = {};
  if (version !== "" && !u.isVersionText(version)) out.version = s.versionText;
  if (mode === "managed") {
    if (!hasInstaller) out.updateMode = s.needsInstaller;
    if (out.version === undefined) out.version = version === "" ? s.versionNeeded : u.isOrderedVersion(version) ? undefined : s.versionNotOrdered;
    if (x.feedUrl.trim() !== "") {
      if (v.installerUrl(x.feedUrl) !== null) out.feedUrl = s.feedUrlBad;
      if (!u.isFeedKey(x.feedPubkey)) out.feedPubkey = s.feedKeyBad;
      if (!u.isFeedTarget(x.feedTarget)) out.feedTarget = s.feedTargetBad;
    }
  }
  if (mode === "vendor") {
    const publisher = x.publisher.trim();
    if (publisher === "" && u.browserAppOf(x.exe) === null) out.publisher = s.needsPublisher;
    else if (publisher !== "" && x.publisherProduct.trim() === "" && u.publisherTooBroad(publisher)) out.publisher = s.publisherBroadWindows;
    if (min !== "") {
      if (!u.isOrderedVersion(min)) out.minVersion = s.versionNotOrdered;
      else if (!hasInstaller) out.minVersion = s.needsInstaller;
      else if (out.version === undefined && !u.isOrderedVersion(version)) out.version = version === "" ? s.versionNeeded : s.versionNotOrdered;
      else if (u.numbersAbove(min, version)) out.minVersion = s.minAboveVersion;
    }
  }
  return out;
}

/** `desktop.update` as the form saves it: Pinned is no block at all (the server stores none). */
function updateSpec(x: FormValues): UpdateSpec | undefined {
  const mode = effectiveMode(x);
  if (mode === "pinned") return undefined;
  if (mode === "vendor") {
    return { mode, publisher: x.publisher.trim() || undefined, publisherProduct: x.publisherProduct.trim() || undefined, minVersion: x.minVersion.trim() || undefined };
  }
  return {
    mode,
    feed: x.feedUrl.trim() ? { kind: "tauri", url: x.feedUrl.trim(), pubkey: x.feedPubkey.replace(/\s+/g, ""), target: x.feedTarget.trim() } : undefined,
    autoPublish: x.autoPublish,
    applyWhen: x.applyWhen,
    rollbackOnFail: x.rollbackOnFail,
  };
}

function validateValues(kind: AppKind, x: FormValues): Partial<Record<keyof FormValues & string, string>> {
  const common = {
    name: v.name(x.name, v.NAME_MAX.app) ?? undefined,
    description: v.optionalText(x.description, v.NAME_MAX.description) ?? undefined,
  };
  if (kind === "web") {
    return {
      ...common,
      url: v.webUrl(x.url) ?? undefined,
      domains: v.domains(v.lines(x.domains)) ?? undefined,
      chromeAppId: x.browserKind === "chrome" && x.chromeAppId === "" ? appBrowserStrings.chromeNeeded : undefined,
    };
  }
  const needsInstall = x.source === "msi" || x.source === "exe" || x.source === "portable";
  const problems: Partial<Record<keyof FormValues & string, string | undefined>> = {
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
    ...updateProblems(x),
    sites: u.browserAppOf(x.exe) !== null ? (browserSitesProblem(v.lines(x.sites).map((l) => l.toLowerCase()), appBrowserStrings.sitesTooMany) ?? undefined) : undefined,
  };
  // The installer details (Phase 6 Step 13) never replace a message a field already has.
  for (const [key, message] of Object.entries(installerProblems(x))) problems[key as keyof FormValues & string] ??= message;
  return problems;
}

/** `previous` is never sent: it is the server's field (`apps:update` ignores it). */
function desktopSpec(x: FormValues, before?: DesktopSpec): DesktopSpec {
  const version = x.version.trim() || undefined;
  const update = updateSpec(x);
  // The allowed sites belong to Chrome and Edge only (the server refuses them for another program).
  const sites = u.browserAppOf(x.exe) !== null ? [...new Set(v.lines(x.sites).map((l) => l.toLowerCase()))] : [];
  const base = {
    source: x.source,
    exe: x.exe.trim(),
    args: v.splitArgs(x.args),
    fileArgTemplate: v.splitArgs(x.fileArg),
    resetFolders: v.lines(x.resetFolders),
    ...(version !== undefined ? { version } : {}),
    ...(update !== undefined ? { update } : {}),
    ...(sites.length > 0 ? { browserSites: sites } : {}),
  };
  // The form does not know an installer's size: the same installer keeps the one the server has.
  const sameInstaller = before?.install !== undefined && before.install.url === x.installUrl.trim() && before.install.sha256 === x.sha256.trim().toLowerCase();
  switch (x.source) {
    case "winget":
      return { ...base, wingetId: x.resolved?.packageId ?? x.wingetId.trim(), wingetVersion: x.resolved?.version, install: x.resolved?.install };
    case "preinstalled":
      return base;
    default: {
      // Phase 6 Step 13: the installer details of an MSI or EXE. A portable file runs no installer, so it has none.
      const runs = x.source === "msi" || x.source === "exe";
      const exe = x.source === "exe";
      const answerUrl = x.answerUrl.trim();
      const answerSha = x.answerSha256.trim().toLowerCase();
      const oldAnswer = before?.install?.answerFile;
      // The form does not know an answer file's size either: the same file keeps the one the server has.
      const answerSize = oldAnswer !== undefined && oldAnswer.url === answerUrl && oldAnswer.sha256 === answerSha ? oldAnswer.sizeBytes : 0;
      const publisher = x.installPublisher.trim();
      return {
        ...base,
        install: {
          kind: x.source,
          url: x.installUrl.trim(),
          sha256: x.sha256.trim().toLowerCase(),
          sizeBytes: sameInstaller ? before.install!.sizeBytes : 0,
          silentArgs: exe ? v.splitArgs(x.silentArgs) : [],
          productCode: x.source === "msi" && x.productCode.trim() ? x.productCode.trim().toUpperCase() : undefined,
          successExitCodes: (runs ? ins.parseExitCodes(x.successCodes) : null) ?? [0],
          removeWhenUnassigned: exe ? false : x.removeWhenUnassigned,
          ...(exe && x.tech !== "" ? { tech: x.tech } : {}),
          ...(exe && x.answerOn ? { answerFile: { url: answerUrl, sha256: answerSha, sizeBytes: answerSize } } : {}),
          ...(runs && x.timeoutMin.trim() !== "" ? { timeoutMin: Number(x.timeoutMin) } : {}),
          ...(runs && publisher !== "" ? { publisher } : {}),
        },
      };
    }
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
        <PageHeader title={detail.status === "loading" ? strings.app.loading : appsStrings.title} back={{ to: "/apps", label: s.back }} />
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
              <Pill tone="accent">{kind === "web" ? appsStrings.web : appsStrings.desktop}</Pill>
              {d.desktop ? <Pill>{appsStrings.sources[d.desktop.source]}</Pill> : null}
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
          <AppForm
            key={formKey}
            d={d}
            kind={kind}
            isNew={isNew}
            readOnly={!canAct}
            revision={revision}
            onSaved={() => setRevision((r) => r + 1)}
            onRolledBack={(next) => {
              setRevision(next);
              setFormKey((k) => k + 1);
            }}
            onReload={() => {
              setRevision(d.revision);
              setFormKey((k) => k + 1);
            }}
          />
          {!isNew && kind === "web" && d.web ? (
            <AppPermissions
              key={formKey}
              d={d}
              revision={revision}
              readOnly={!canAct}
              onSaved={setRevision}
              onReload={() => {
                setRevision(d.revision);
                setFormKey((k) => k + 1);
              }}
            />
          ) : null}
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
  onRolledBack,
  onReload,
}: {
  d: AppDetail;
  kind: AppKind;
  isNew: boolean;
  readOnly: boolean;
  revision: number;
  onSaved: () => void;
  /** After `apps:rollbackVersion`: the revision to send next (the form starts again from the rolled-back app). */
  onRolledBack: (revision: number) => void;
  onReload: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const createWeb = useCreateWebApp();
  const createDesktop = useCreateDesktopApp();
  const update = useUpdateApp();
  const fetchMeta = useFetchWebMeta();
  const resolve = useResolveWinget();
  const saveIcon = useSaveAppIcon();
  // The icon "Fetch details" previewed (a `data:` URL) and the address it came from: stored with the app
  // when the form is saved, and only while the address still is that one (a previous site's icon is never saved).
  const [fetchedIcon, setIcon] = useState<{ forUrl: string; data: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const f = useForm<FormValues>(initialValues(d, kind), (x) => validateValues(kind, x));
  const [helper, setHelper] = useState<{ pending: boolean; error: unknown; note: string | null }>({ pending: false, error: null, note: null });
  // What the last "Detect" said (Phase 6 Step 13): shared by the row under the installer address and the installer details card.
  const [inspect, setInspect] = useState<InspectState>({ result: null, from: null, kept: [], prefilled: {}, note: null });
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
    if (kind === "web") {
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
    } else {
      const desktop = { ...common, desktop: desktopSpec(values, d.desktop) };
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
          <>
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
                <HelperResult helper={helper} />
                {icon !== null ? (
                  <div className="dash-row" style={{ flexWrap: "nowrap", alignItems: "center", gap: 12 }}>
                    <AppGlyph name={x.name || "?"} hue={x.hue} iconUrl={icon} size="lg" />
                    <span className="dash-muted">{s.iconPreview}</span>
                  </div>
                ) : null}
                <Field label={s.allowedDomains} hint={s.allowedDomainsHint} error={f.errors.domains} optional>
                  {(p) => (
                    <Textarea {...p} rows={3} spellCheck={false} autoCapitalize="off" className="dash-mono" value={x.domains} onChange={(e) => f.set("domains", e.target.value)} />
                  )}
                </Field>
                {isNew ? <p className="dash-muted">{s.permissionsHint}</p> : null}
              </div>
            </Card>
            <OpensInCard d={d} f={f} isNew={isNew} />
          </>
        ) : (
          <>
            <Card title={s.source} sub={s.sourceHints[x.source]}>
              <div className="dash-form">
                <div style={{ overflowX: "auto", maxWidth: "100%" }}>
                  <SegmentedControl<DesktopSource>
                    aria-label={s.source}
                    options={SOURCES.map((src) => ({ value: src, label: appsStrings.sources[src] }))}
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
                    {x.source !== "portable" ? (
                      <Suspense fallback={null}>
                        <DetectRow f={f} state={inspect} setState={setInspect} readOnly={readOnly} />
                      </Suspense>
                    ) : null}
                    <Field label={s.sha256} error={f.errors.sha256} required>
                      {(p) => (
                        <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={80} value={x.sha256} onChange={(e) => f.set("sha256", e.target.value)} />
                      )}
                    </Field>
                  </>
                ) : null}
                {x.source === "exe" ? (
                  <>
                    <Field
                      label={
                        <>
                          {s.silentArgs}
                          {inspect.prefilled.silentArgs !== undefined && x.silentArgs.trim() !== inspect.prefilled.silentArgs ? <span className="dash-field__optional"> ({installFormStrings.edited})</span> : null}
                        </>
                      }
                      hint={s.silentArgsHint}
                      error={f.errors.silentArgs}
                      required
                    >
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

            {x.source === "msi" || x.source === "exe" ? (
              <Suspense fallback={null}>
                <InstallerCard f={f} state={inspect} readOnly={readOnly} />
              </Suspense>
            ) : null}

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

            {u.browserAppOf(x.exe) !== null ? <BrowserRulesCard f={f} /> : null}

            <Suspense fallback={<div className="dash-card dash-card--pad"><SkeletonBlock lines={4} /></div>}>
              <UpdatesCard d={d} f={f} mode={effectiveMode(x)} browser={u.browserAppOf(x.exe) !== null} isNew={isNew} readOnly={readOnly} revision={revision} onRolledBack={onRolledBack} />
            </Suspense>
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
        <dd>{appsStrings.sources[r.install.kind]}</dd>
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

type AssignmentItem = AppDetail["assignments"][number];

/**
 * The groups that assign this app. They come with `apps:get` (the server reads them bounded), so the table only
 * shows a slice of what is already loaded: nothing is sorted or filtered here and no query is added. The pager
 * appears once there is more than one page.
 */
function AssignmentsTable({ rows }: { rows: AssignmentItem[] }) {
  const navigate = useNavigate();
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages);
  const cols = useMemo<Column<AssignmentItem>[]>(
    () => [
      {
        key: "group",
        header: strings.enrollment.group,
        primary: true,
        // One column in the narrow side card: the group, and under it who gets the app and where it is pinned.
        cell: (a) => (
          <span className="dash-cell-stack">
            <Link className="dash-link dash-link--plain dash-truncate" to={`/groups/${a.groupId}`} title={a.groupName}>
              {a.groupName}
            </Link>
            <span className="dash-cell-sub" style={{ whiteSpace: "normal" }}>
              {a.audience === "everyone" ? groupStrings.audienceEveryone : groupStrings.audienceSelected}
              {a.pinnedTaskbar ? ` · ${groupStrings.pinnedTaskbar}` : ""}
              {a.pinnedDesktop ? ` · ${groupStrings.pinnedDesktop}` : ""}
            </span>
          </span>
        ),
      },
    ],
    [],
  );
  return (
    <DataTable
      caption={s.assignments}
      columns={cols}
      rows={rows.slice((current - 1) * size, current * size)}
      getKey={(a) => a._id}
      onRowClick={(a) => navigate(`/groups/${a.groupId}`)}
      footer={
        rows.length > PAGE_SIZES[0] ? (
          <Pager
            page={current}
            pageSize={size}
            total={rows.length}
            hasNext={current < pages}
            reachablePages={new Set(Array.from({ length: pages }, (_, i) => i + 1))}
            onPage={setPage}
            onPageSize={(n) => {
              setSize(n);
              setPage(1);
            }}
          />
        ) : undefined
      }
    />
  );
}

function AssignmentsCard({ d }: { d: AppDetail }) {
  const [assigning, setAssigning] = useState(false);
  return (
    <Card
      title={s.assignments}
      body="none"
      className="dash-card--tight"
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
        <AssignmentsTable rows={d.assignments} />
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
        <Field label={groupStrings.audience}>
          {(p) => (
            <Select {...p} value={f.values.audience} onChange={(e) => f.set("audience", e.target.value as Audience)}>
              <option value="everyone">{groupStrings.audienceEveryone}</option>
              <option value="selected">{groupStrings.audienceSelected}</option>
            </Select>
          )}
        </Field>
        <FieldSet legend={groupStrings.pins}>
          <div className="dash-checks dash-checks--inline">
            <Checkbox label={groupStrings.pinTaskbar} checked={f.values.pinnedTaskbar} onChange={(e) => f.set("pinnedTaskbar", e.target.checked)} />
            <Checkbox label={groupStrings.pinDesktop} checked={f.values.pinnedDesktop} onChange={(e) => f.set("pinnedDesktop", e.target.checked)} />
          </div>
        </FieldSet>
        <FormError error={f.serverError} describe={assignmentErrorMessage} />
      </div>
    </Modal>
  );
}

/** The install card: counts per state (`apps:installSummary`, a query of its own) and the PCs in the chosen state. */
function InstallStatus({ d }: { d: AppDetail }) {
  const summary = useAppInstallSummary(d._id);
  return (
    <QueryRegion state={summary} skeleton={<Card title={s.installStatus} body="none"><SkeletonRows rows={3} columns={3} /></Card>}>
      {(counts) => <InstallCard d={d} counts={counts} />}
    </QueryRegion>
  );
}

function InstallCard({ d, counts }: { d: AppDetail; counts: InstallCounts }) {
  const present = INSTALL_STATES.filter((st) => (counts[st] ?? 0) > 0);
  // `chosen` is only ever a click. Until then the first state with PCs is shown (`anchor`), and it stays
  // on screen when another state fills later (the first installed PC): the view only moves when the user
  // clicks, or when the state on screen has no PCs left.
  const [chosen, setState] = useState<InstallState | null>(null);
  const [anchor, setAnchor] = useState<InstallState | null>(null);
  const clicked = chosen !== null && present.includes(chosen) ? chosen : null;
  const picked = clicked ?? (anchor !== null && present.includes(anchor) ? anchor : (present[0] ?? null));
  if (clicked === null && anchor !== picked) setAnchor(picked);
  const state = picked ?? "installed";
  const retry = useRetryApp();
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  return (
    <Card
      title={s.installStatus}
      body="none"
      actions={
        (counts.failed ?? 0) > 0 ? (
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
                    toast(installStrings.retried);
                  },
                  (e) => {
                    setRetrying(false);
                    toast(messageFor(e), "danger");
                  },
                );
              }}
            >
              {installStrings.retry}
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
                {installStateStrings[st]}
                <span className="dash-state-btn__count">{formatCount(counts[st] ?? 0, 1000)}</span>
              </button>
            ))}
          </div>
          {counts.capped ? (
            <p className="dash-list__meta" style={{ padding: "0 clamp(16px, 2vw, 22px) 12px" }}>
              {s.installCapped}
            </p>
          ) : null}
          <InstallList appId={d._id} state={state} />
        </>
      )}
    </Card>
  );
}

/** `apps:installs` sorts by time ("updated") only. Local state: the page also holds other lists. */
const INSTALLS_LIST: ListConfig = { sorts: ["updated"], defaultSort: { key: "updated", dir: "desc" }, storage: "local" };

function InstallList({ appId, state }: { appId: string; state: InstallState }) {
  const view = useListView(INSTALLS_LIST);
  // Another app or install state is another list: start over on its first page.
  const paging = useListPaging(view, { total: null, scope: `${appId}:${state}` });
  const rows = useAppInstalls(appId, state, paging.query);
  const cols = useMemo<Column<AppInstallRow>[]>(
    () => [
      {
        key: "device",
        header: devicesStrings.colName,
        primary: true,
        cell: (r) => (
          <Link className="dash-link dash-link--plain dash-truncate" to={`/devices/${r.deviceId}`}>
            {r.deviceName}
          </Link>
        ),
      },
      { key: "state", header: s.installState, cell: (r) => <InstallStatePill state={r.state} /> },
      // Display only: the server does not sort or filter by it (the list stays ordered by time).
      {
        key: "version",
        header: s.installedVersion,
        isEmpty: (r) => r.installedVersion === undefined,
        cell: (r) => (r.installedVersion !== undefined ? <span className="dash-mono">{r.installedVersion}</span> : <span className="dash-muted">—</span>),
      },
      {
        key: "detail",
        header: strings.common.details,
        isEmpty: (r) => r.state !== "failed",
        cell: (r) =>
          r.state === "failed" ? (
            <span className="dash-muted" style={{ fontSize: 13 }}>
              {installDetail(r.detail)}
              {r.exitCode !== undefined ? ` · ${installStrings.exitCode(r.exitCode)}` : ""}
            </span>
          ) : (
            <span className="dash-muted">—</span>
          ),
      },
      { key: "updated", header: s.colUpdated, sortable: true, sortDefaultDir: "desc", cell: (r) => <RelativeTime ms={r.updatedAt} /> },
    ],
    [],
  );
  const navigate = useNavigate();
  return (
    <ServerTable<AppInstallRow>
      caption={s.installStatus}
      columns={cols}
      getKey={(r) => r._id}
      paging={paging}
      list={rows}
      total={null}
      skeletonRows={4}
      onRowClick={(r) => navigate(`/devices/${r.deviceId}`)}
      empty={<EmptyState compact title={s.installStatusNone} />}
    />
  );
}
