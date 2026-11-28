import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Checkbox, Input, InfoTip, Select, Textarea } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-linear";
import IconDanger from "~icons/solar/danger-triangle-linear";
import IconFile from "~icons/solar/file-check-linear";
import IconDetect from "~icons/solar/magnifer-linear";
import { useDeleteDriver, useDriverDetail, useGroupsScreen, useInspectInstaller, useRetryDriver, useSaveDriver } from "../data";
import type { DriverCounts, DriverDetail, DriverInput, DriverKind } from "../data/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { HistoryPanel } from "../components/HistoryPanel";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { serverFieldError } from "../components/serverField";
import { SkeletonBlock } from "../components/Skeleton";
import {
  DRIVER_CLASSES,
  DRIVER_KINDS,
  MAX_DRIVER_NAME,
  argsOf,
  codesOf,
  codesProblem,
  driverNameProblem,
  driverUrlProblem,
  infProblem,
  kindFromUrl,
  nameFromUrl,
  namesOf,
  providesProblem,
  sha256Problem,
  silentArgsProblem,
  sizeProblem,
} from "../lib/driverRules";
import { messageFor, registerDetailSentences, toAppError } from "../lib/errors";
import { formatBytes } from "../lib/format";
import { useCan } from "../lib/member";
import { MAX_PRINTER_GROUPS } from "../lib/printerRules";
import { installRefusalStrings } from "../lib/screenStrings/installRefusals";
import { strings } from "../lib/strings";
import { useToast } from "../lib/toast";
import { useForm } from "../lib/useForm";
import type { InfFile } from "../lib/drivers/zipInspect";
import { BLANK_DRIVER } from "./networks/model";
import { AdvancedBox, GroupPicker, HowCard } from "./networks/parts";
import { driverStrings as s } from "./networks/driverStrings";
import { networksStrings as n } from "./networks/strings";
import "./networks/networks.css";

registerDetailSentences(installRefusalStrings);

interface Values extends Record<string, unknown> {
  name: string;
  /** Until the admin types a name, it follows the file name in the link. */
  nameEdited: boolean;
  deviceClass: DriverDetail["deviceClass"];
  kind: DriverKind;
  url: string;
  sha256: string;
  /** Text, so an empty field means "unknown". */
  size: string;
  inf: string;
  /** One per line. */
  args: string;
  /** Comma separated. */
  codes: string;
  /** One per line. */
  provides: string;
  groupIds: string[];
}

const valuesOf = (d: DriverDetail): Values => ({
  name: d.name,
  nameEdited: d.name !== "",
  deviceClass: d.deviceClass,
  kind: d.kind,
  url: d.url,
  sha256: d.sha256,
  size: d.sizeBytes > 0 ? String(d.sizeBytes) : "",
  inf: d.inf ?? "",
  args: d.silentArgs.join("\n"),
  codes: d.successExitCodes.join(", "),
  provides: d.provides.join("\n"),
  groupIds: d.groupIds,
});

/** The call's input: an INF path only for a package, silent arguments only for an .exe, lower-case hash. */
const inputOf = (x: Values): DriverInput => ({
  name: x.name.trim(),
  kind: x.kind,
  deviceClass: x.deviceClass,
  url: x.url.trim(),
  sha256: x.sha256.trim().toLowerCase(),
  sizeBytes: x.size.trim() === "" ? 0 : Number(x.size.trim()),
  ...(x.kind === "inf" ? { inf: x.inf.trim() } : {}),
  silentArgs: x.kind === "exe" ? argsOf(x.args) : [],
  successExitCodes: x.kind === "exe" ? (codesOf(x.codes) ?? []) : [],
  provides: namesOf(x.provides),
  groupIds: x.groupIds,
});

/** What "Check the file" found, apart from the form's own fields. */
interface CheckState {
  busy: "file" | "link" | null;
  /** A problem with the file or the link itself, in words (never the server's text). */
  error: string | null;
  /** The fingerprint on the form comes from a file checked just now (not from what was saved). */
  fresh: boolean;
  /** A zip picked here: its driver files, and the file for reading the models of another one. */
  zip: { file: File; infs: InfFile[]; moreInfs: boolean } | null;
  /** The printer models of the chosen driver file. */
  models: string[];
}

const IDLE: CheckState = { busy: null, error: null, fresh: false, zip: null, models: [] };

/** `drivers:detail`; `/networks/drivers/new` is the same form with blank values and nothing subscribed. */
export default function DriverEdit() {
  const { id = "new" } = useParams();
  return <div className="dash-page net-page">{id === "new" ? <NewDriver d={BLANK_DRIVER} /> : <LoadedDriver id={id} />}</div>;
}

function LoadedDriver({ id }: { id: string }) {
  const detail = useDriverDetail(id);
  return (
    <>
      {detail.status !== "ready" ? (
        <PageHeader title={detail.status === "loading" ? strings.app.loading : s.title} back={{ to: "/networks", label: n.back }} />
      ) : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad" aria-label={s.loading}><SkeletonBlock lines={6} /></div>}>
        {(d) => <ExistingDriver d={d} />}
      </QueryRegion>
    </>
  );
}

function NewDriver({ d }: { d: DriverDetail }) {
  const canAct = useCan("admin");
  const save = useSaveDriver();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <>
      <PageHeader
        title={s.newTitle}
        back={{ to: "/networks", label: n.back }}
        meta={
          <span className="net-howinfo">
            {s.howTitle}
            <InfoTip label={`About ${s.howTitle}`}>
              {s.how1} {s.how2} {s.how3}
            </InfoTip>
          </span>
        }
      />
      {!canAct ? (
        <InlineNotice tone="neutral" title={strings.app.readOnly} />
      ) : (
        <div className="dash-split">
          <div className="dash-split__main net-formcol">
            <DriverForm
              d={d}
              isNew
              onSave={async (x) => {
                const r = await save(inputOf(x));
                toast(s.created(x.name.trim()));
                navigate(`/networks/drivers/${r.id}`, { replace: true });
              }}
            />
          </div>
          <div className="dash-split__aside net-aside">
            <HowCard title={s.howTitle} lines={[s.how1, s.how2, s.how3]} />
          </div>
        </div>
      )}
    </>
  );
}

function ExistingDriver({ d }: { d: DriverDetail }) {
  const canAct = useCan("admin");
  const save = useSaveDriver();
  const toast = useToast();
  const [revision, setRevision] = useState(d.revision);
  const [formKey, setFormKey] = useState(0);

  const reload = () => {
    setRevision(d.revision);
    setFormKey((k) => k + 1);
  };

  return (
    <>
      <PageHeader
        back={{ to: "/networks", label: n.back }}
        title={<span className="dash-wrap">{d.name}</span>}
        meta={
          <>
            <span className="dash-chip">{s.kindShort[d.kind]}</span>
            <span className="dash-chip">{s.classNames[d.deviceClass]}</span>
          </>
        }
      />
      {!canAct ? <InlineNotice tone="neutral" title={n.readOnly} /> : null}
      <div className="dash-split">
        <div className="dash-split__main net-formcol">
          {canAct ? (
            <DriverForm
              key={formKey}
              d={d}
              onSave={async (x) => {
                const r = await save({ ...inputOf(x), id: d._id, expectedRevision: revision });
                setRevision(r.revision);
                toast(s.saved);
              }}
              onReload={reload}
            />
          ) : (
            <ReadOnlyDriver d={d} />
          )}
        </div>
        <div className="dash-split__aside">
          <InstallCounts counts={d.counts} hasGroups={d.groupIds.length > 0} />
          <RoleGate minRole="admin">
            <RetryCard d={d} />
            <DeleteCard d={d} />
          </RoleGate>
          <HistoryPanel targetId={d._id} />
        </div>
      </div>
    </>
  );
}

function ReadOnlyDriver({ d }: { d: DriverDetail }) {
  return (
    <Card title={s.title}>
      <dl className="dash-kv">
        <div className="dash-kv__item">
          <dt>{s.readName}</dt>
          <dd className="dash-wrap">{d.name}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readType}</dt>
          <dd>{s.kindNames[d.kind]}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readDevice}</dt>
          <dd>{s.classNames[d.deviceClass]}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readUrl}</dt>
          <dd className="dash-mono dash-wrap">{d.url}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readSha}</dt>
          <dd className="dash-mono dash-wrap">{d.sha256}</dd>
        </div>
        {d.inf !== null ? (
          <div className="dash-kv__item">
            <dt>{s.readInf}</dt>
            <dd className="dash-mono dash-wrap">{d.inf}</dd>
          </div>
        ) : null}
        {d.provides.length > 0 ? (
          <div className="dash-kv__item">
            <dt>{s.readProvides}</dt>
            <dd>{d.provides.join(", ")}</dd>
          </div>
        ) : null}
        <div className="dash-kv__item">
          <dt>{n.groupsRead}</dt>
          <dd>
            {d.groups.length ? d.groups.map((g) => g.name).join(", ") : strings.common.none}
            {d.groupCount > d.groups.length ? ` ${n.moreGroups(d.groupCount - d.groups.length)}` : ""}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function DriverForm({
  d,
  isNew,
  onSave,
  onReload,
}: {
  d: DriverDetail;
  isNew?: boolean;
  onSave: (values: Values) => Promise<void>;
  onReload?: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const groups = useGroupsScreen();
  const inspect = useInspectInstaller();
  const [check, setCheck] = useState<CheckState>(IDLE);
  const f = useForm<Values>(valuesOf(d), (x) => {
    const name = driverNameProblem(x.name);
    const url = driverUrlProblem(x.url);
    const sha = sha256Problem(x.sha256);
    const size = sizeProblem(x.size);
    const inf = x.kind === "inf" ? infProblem(x.inf) : null;
    const args = x.kind === "exe" ? silentArgsProblem(argsOf(x.args)) : null;
    const codes = x.kind === "exe" ? codesProblem(x.codes) : null;
    const provides = providesProblem(namesOf(x.provides));
    return {
      name: name === null ? undefined : s.nameProblems[name],
      url: url === null ? undefined : s.urlProblems[url],
      sha256: sha === null ? undefined : s.shaProblems[sha],
      size: size === null ? undefined : s.sizeProblems[size],
      inf: inf === null ? undefined : s.infProblems[inf],
      args: args === null ? undefined : s.argsProblems[args],
      codes: codes === null ? undefined : s.codesProblems[codes],
      provides: provides === null ? undefined : s.providesProblems[provides],
      groupIds: x.groupIds.length > MAX_PRINTER_GROUPS ? n.groupsOver(MAX_PRINTER_GROUPS) : undefined,
    };
  });
  const x = f.values;
  // The newest values: a check takes a moment and the admin may type meanwhile; typed text is never overwritten.
  const latest = useRef(x);
  useEffect(() => {
    latest.current = x;
  });
  const describe = (e: unknown) => {
    const a = toAppError(e);
    return a ? n.describeError(a.code, a.detail) : null;
  };
  const serverField = (field: string, text: string) => serverFieldError(f.serverError, field, () => text);

  const shaErr = f.errors.sha256 ?? serverField("sha256", s.shaProblems.format);
  const sizeErr = f.errors.size ?? serverField("sizeBytes", s.sizeProblems.range);
  const infErr = f.errors.inf ?? serverField("inf", s.infProblems.path);
  const argsErr = f.errors.args ?? serverField("silentArgs", s.argsProblems.required);
  const codesErr = f.errors.codes ?? serverField("successExitCodes", s.codesProblems.number);
  const providesErr = f.errors.provides ?? serverField("provides", s.providesProblems.length);
  const advancedError = [shaErr, sizeErr, infErr, argsErr, codesErr, providesErr].some((e) => e !== undefined && e !== null);

  const onUrl = (text: string) => {
    f.set("url", text);
    const k = kindFromUrl(text);
    if (k !== null) f.set("kind", k);
    if (!latest.current.nameEdited) {
      const nm = nameFromUrl(text);
      if (nm !== "") f.set("name", nm);
    }
  };

  /** Fills the form from a driver zip that was picked here (its driver files and the models of the first one). */
  async function readZip(file: File): Promise<void> {
    const { inspectDriverZip, ZipError } = await import("../lib/drivers/zipInspect");
    try {
      const z = await inspectDriverZip(file);
      if (z.infs.length === 0) {
        setCheck((c) => ({ ...c, zip: null, models: [], error: s.noInf }));
        return;
      }
      const first = z.infs[0]!;
      const models = first.models ?? [];
      f.set("inf", first.path);
      if (latest.current.provides.trim() === "" && models.length > 0) f.set("provides", models.join("\n"));
      setCheck((c) => ({ ...c, zip: { file, infs: z.infs, moreInfs: z.moreInfs }, models, error: null }));
    } catch (e) {
      setCheck((c) => ({ ...c, zip: null, models: [], error: e instanceof ZipError ? s.zipUnreadable : s.fileFailed }));
    }
  }

  async function pickFile(file: File): Promise<void> {
    setCheck({ ...IDLE, busy: "file" });
    try {
      // The detector, the hashing and the zip reader are chunks of their own, loaded only now. Nothing is uploaded.
      const { checkLocalFile } = await import("../lib/apps/localInstaller");
      const checked = await checkLocalFile(file);
      f.set("sha256", checked.sha256);
      f.set("size", String(checked.sizeBytes));
      // The file is a better hint for the name than a link like ".../download?id=3", until the admin types a name.
      if (!latest.current.nameEdited) {
        const nm = nameFromUrl(file.name);
        if (nm !== "") f.set("name", nm);
      }
      const insp = checked.inspection;
      if (insp !== null) {
        f.set("kind", insp.kind);
        if (insp.kind === "exe") {
          f.set("args", insp.silentArgs.join("\n"));
          f.set("codes", insp.successExitCodes.filter((c) => c !== 0).join(", "));
        }
        setCheck({ ...IDLE, fresh: true });
        return;
      }
      f.set("kind", "inf");
      setCheck({ ...IDLE, fresh: true });
      await readZip(file);
    } catch {
      setCheck({ ...IDLE, error: s.fileFailed });
    }
  }

  async function detect(): Promise<void> {
    setCheck((c) => ({ ...c, busy: "link", error: null }));
    try {
      const r = await inspect({ url: latest.current.url.trim() });
      f.set("kind", r.kind);
      if (r.kind === "exe") {
        f.set("args", r.silentArgs.join("\n"));
        f.set("codes", r.successExitCodes.filter((c) => c !== 0).join(", "));
      }
      if (r.sizeBytes !== undefined && latest.current.size.trim() === "") f.set("size", String(r.sizeBytes));
      setCheck((c) => ({ ...c, busy: null }));
    } catch (e) {
      setCheck((c) => ({ ...c, busy: null, error: messageFor(e) }));
    }
  }

  async function pickInf(path: string): Promise<void> {
    f.set("inf", path);
    const zip = check.zip;
    if (zip === null) return;
    const known = zip.infs.find((i) => i.path === path)?.models;
    let models = known ?? [];
    if (known === null || known === undefined) {
      const { modelsOfInfPath } = await import("../lib/drivers/zipInspect");
      models = await modelsOfInfPath(zip.file, path).catch(() => []);
    }
    f.set("provides", models.join("\n"));
    setCheck((c) => ({ ...c, models }));
  }

  const toggleModel = (m: string, on: boolean) => {
    const lines = namesOf(x.provides);
    const next = on ? (lines.some((l) => l.toLowerCase() === m.toLowerCase()) ? lines : [...lines, m]) : lines.filter((l) => l.toLowerCase() !== m.toLowerCase());
    f.set("provides", next.join("\n"));
  };

  const shaOk = sha256Problem(x.sha256) === null;
  const sizeNum = sizeProblem(x.size) === null && x.size.trim() !== "" ? Number(x.size.trim()) : 0;
  const summary =
    shaOk || sizeNum > 0 || check.models.length > 0
      ? s.summary(s.kindShort[x.kind], check.models.length, sizeNum > 0 ? formatBytes(sizeNum) : "", shaOk ? (check.fresh ? "checked" : "saved") : null)
      : null;
  const busy = check.busy !== null;
  const showDetect = kindFromUrl(x.url) !== "inf";

  return (
    <Card className="dash-enter">
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (values) => {
            await onSave(values);
          }, form.current);
        }}
      >
        <Field label={s.url} info={s.urlInfo} error={f.errors.url ?? serverField("url", s.urlProblems.scheme)} required>
          {(p) => (
            <Input
              {...p}
              className="dash-mono"
              type="url"
              value={x.url}
              placeholder={s.urlPlaceholder}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus={isNew}
              onChange={(e) => onUrl(e.target.value)}
            />
          )}
        </Field>
        <div className="net-check">
          <p className="net-check__title">
            {s.checkTitle}
            <InfoTip label={`About ${s.checkTitle}`}>{s.checkFileInfo}</InfoTip>
          </p>
          <div className="net-check__buttons">
            <Button type="button" variant="ghost" disabled={busy} aria-busy={check.busy === "file"} onClick={() => chooser.current?.click()}>
              <IconFile aria-hidden="true" />
              {check.busy === "file" ? s.checkingFile : s.checkFile}
            </Button>
            {showDetect ? (
              <Button type="button" variant="ghost" disabled={busy || driverUrlProblem(x.url) !== null} aria-busy={check.busy === "link"} onClick={() => void detect()}>
                <IconDetect aria-hidden="true" />
                {check.busy === "link" ? s.detecting : s.detect}
              </Button>
            ) : null}
            <input
              ref={chooser}
              type="file"
              accept=".zip,.exe,.msi"
              className="dash-sr"
              tabIndex={-1}
              aria-label={s.chooseFile}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void pickFile(file);
              }}
            />
          </div>
          {summary !== null ? (
            <p className="net-check__sum">
              <span className="net-check__ok" aria-hidden="true">
                <IconCheck />
              </span>
              {summary}
            </p>
          ) : null}
          {check.error !== null ? (
            <p className="net-check__warn" role="alert">
              <IconDanger aria-hidden="true" />
              {check.error}
            </p>
          ) : null}
          {f.errors.sha256 !== undefined && x.sha256.trim() === "" ? (
            <p className="net-check__warn">
              <IconDanger aria-hidden="true" />
              {s.checkNeeded}
            </p>
          ) : null}
        </div>
        <div className="dash-form-grid net-fields">
          <Field label={s.name} info={s.nameInfo} error={f.errors.name ?? serverField("name", s.nameTaken)} required>
            {(p) => (
              <Input
                {...p}
                value={x.name}
                autoComplete="off"
                maxLength={MAX_DRIVER_NAME * 2}
                onChange={(e) => {
                  f.set("name", e.target.value);
                  f.set("nameEdited", true);
                }}
              />
            )}
          </Field>
          {check.zip !== null && check.zip.infs.length > 1 ? (
            <Field label={s.infPick} info={s.infPickInfo} error={infErr}>
              {(p) => (
                <Select
                  {...p}
                  value={x.inf}
                  onChange={(path) => void pickInf(path)}
                  options={check.zip!.infs.map((i) => ({ value: i.path, label: i.path, hint: i.models !== null ? s.addsModels(i.models.length) : undefined }))}
                />
              )}
            </Field>
          ) : null}
        </div>
        {check.models.length > 0 ? (
          <fieldset className="dash-field">
            <legend className="dash-field__label">
              <span className="rb-labelrow">
                <span>{s.adds}</span>
                <InfoTip label={`About ${s.adds}`}>{s.addsInfo}</InfoTip>
              </span>
            </legend>
            <div className="dash-checks net-checks">
              {check.models.map((m) => (
                <Checkbox key={m} label={m} checked={namesOf(x.provides).some((l) => l.toLowerCase() === m.toLowerCase())} onChange={(e) => toggleModel(m, e.target.checked)} />
              ))}
            </div>
          </fieldset>
        ) : null}
        <GroupPicker groups={groups} selected={x.groupIds} onChange={(ids) => f.set("groupIds", ids)} error={f.errors.groupIds ?? serverField("groupIds", n.groupsServerRefused)} />
        <AdvancedBox forceOpen={advancedError}>
          <div className="dash-form-grid net-fields">
            <Field label={s.deviceType} info={s.deviceTypeInfo}>
              {(p) => (
                <Select
                  {...p}
                  value={x.deviceClass}
                  onChange={(value) => f.set("deviceClass", value as Values["deviceClass"])}
                  options={DRIVER_CLASSES.map((c) => ({ value: c, label: s.classNames[c] }))}
                />
              )}
            </Field>
            <Field label={s.fileType} info={s.fileTypeInfo}>
              {(p) => (
                <Select {...p} value={x.kind} onChange={(value) => f.set("kind", value as DriverKind)} options={DRIVER_KINDS.map((k) => ({ value: k, label: s.kindNames[k] }))} />
              )}
            </Field>
            <Field label={s.sha} info={s.shaInfo} error={shaErr} required className="dash-form-grid__full">
              {(p) => <Input {...p} className="dash-mono" value={x.sha256} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => f.set("sha256", e.target.value)} />}
            </Field>
            <Field label={s.size} info={s.sizeInfo} error={sizeErr} optional>
              {(p) => <Input {...p} className="dash-mono" inputMode="numeric" value={x.size} autoComplete="off" onChange={(e) => f.set("size", e.target.value)} />}
            </Field>
            {x.kind === "inf" ? (
              <Field label={s.inf} info={s.infInfo} error={infErr} required>
                {(p) => <Input {...p} className="dash-mono" value={x.inf} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => f.set("inf", e.target.value)} />}
              </Field>
            ) : null}
            {x.kind === "exe" ? (
              <Field label={s.args} info={s.argsInfo} error={argsErr} required className="dash-form-grid__full">
                {(p) => <Textarea {...p} className="dash-mono" rows={3} value={x.args} spellCheck={false} onChange={(e) => f.set("args", e.target.value)} />}
              </Field>
            ) : null}
            {x.kind === "exe" ? (
              <Field label={s.codes} info={s.codesInfo} error={codesErr} optional>
                {(p) => <Input {...p} className="dash-mono" value={x.codes} autoComplete="off" onChange={(e) => f.set("codes", e.target.value)} />}
              </Field>
            ) : null}
            <Field label={s.provides} info={s.providesInfo} error={providesErr} optional className="dash-form-grid__full">
              {(p) => <Textarea {...p} rows={2} value={x.provides} spellCheck={false} onChange={(e) => f.set("provides", e.target.value)} />}
            </Field>
          </div>
        </AdvancedBox>
        <FormError
          error={f.serverError}
          onReload={onReload}
          fields={["name", "url", "sha256", "sizeBytes", "inf", "silentArgs", "successExitCodes", "provides", "groupIds"]}
          describe={describe}
        />
        <div className="dash-form__actions net-actions">
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : isNew ? s.create : strings.common.saveChanges}
          </Button>
          {isNew ? (
            <Link to="/networks" className="rb-btn rb-btn--ghost">
              {strings.common.cancel}
            </Link>
          ) : f.dirty ? (
            <span className="dash-form__status">{n.unsaved}</span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function InstallCounts({ counts, hasGroups }: { counts: DriverCounts; hasGroups: boolean }) {
  const items: [string, number, string][] = [
    [s.installed, counts.installed, "ok"],
    [s.pending, counts.pending, "wait"],
    [s.restart, counts.restartNeeded, "wait"],
    [s.failed, counts.failed, "bad"],
    [s.removed, counts.removed, "ok"],
  ];
  if (counts.unsupported > 0) items.push([s.unsupported, counts.unsupported, "bad"]);
  return (
    <Card title={s.countsTitle} sub={s.countsSub}>
      {!hasGroups || counts.sampled === 0 ? (
        <p className="dash-muted">{hasGroups ? s.countsNone : n.noGroups}</p>
      ) : (
        <>
          <dl className="dash-net__counts">
            {items.map(([label, count, tone]) => (
              <div key={label} className={`dash-net__count dash-net__count--${tone}`}>
                <dt>{label}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <p className="dash-cell-sub">{counts.capped ? n.countsCapped(counts.sampled) : n.countsSampled(counts.sampled)}</p>
        </>
      )}
    </Card>
  );
}

function RetryCard({ d }: { d: DriverDetail }) {
  const retry = useRetryDriver();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Card title={s.retryTitle}>
      <div className="dash-row dash-row--between">
        <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.retryBody}</span>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError(null);
            retry({ id: d._id })
              .then(() => toast(s.retried))
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          {s.retry}
        </Button>
      </div>
      <FormError error={error} />
    </Card>
  );
}

function DeleteCard({ d }: { d: DriverDetail }) {
  const del = useDeleteDriver();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <Card title={s.remove} tone="danger">
      <div className="dash-row dash-row--between">
        <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.deleteBody}</span>
        <Button variant="danger-ghost" onClick={() => setOpen(true)}>
          {s.remove}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title={s.deleteTitle(d.name)}
        body={s.deleteBody}
        confirmLabel={s.remove}
        danger
        typeToConfirm={d.name}
        describeError={(e) => {
          const a = toAppError(e);
          return a ? n.describeError(a.code, a.detail) : null;
        }}
        onConfirm={() => del({ id: d._id })}
        onDone={() => {
          toast(s.deleted(d.name));
          navigate("/networks", { replace: true });
        }}
        onClose={() => setOpen(false)}
      />
    </Card>
  );
}
