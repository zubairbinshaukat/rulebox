import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Checkbox, Input, Select, Textarea } from "@rulebox/ui";
import { useDeleteDriver, useDriverDetail, useGroupsScreen, useRetryDriver, useSaveDriver } from "../data";
import type { DriverClass, DriverCounts, DriverDetail, DriverInput, DriverKind } from "../data/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field, FieldSet } from "../components/Field";
import { FormError } from "../components/FormError";
import { HistoryPanel } from "../components/HistoryPanel";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion, RegionError } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { serverFieldError } from "../components/serverField";
import { SkeletonBlock } from "../components/Skeleton";
import { toAppError } from "../lib/errors";
import { formatNumber, plural } from "../lib/format";
import { useCan } from "../lib/member";
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
  namesOf,
  providesProblem,
  sha256Problem,
  silentArgsProblem,
  sizeProblem,
} from "../lib/driverRules";
import { MAX_PRINTER_GROUPS } from "../lib/printerRules";
import { strings } from "../lib/strings";
import { useToast } from "../lib/toast";
import { useForm } from "../lib/useForm";
import { BLANK_DRIVER } from "./networks/model";
import { networksStrings as s } from "./networks/strings";

interface Values extends Record<string, unknown> {
  name: string;
  deviceClass: DriverClass;
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

/** `drivers:detail`; `/networks/drivers/new` is the same form with blank values and nothing subscribed. */
export default function DriverEdit() {
  const { id = "new" } = useParams();
  return <div className="dash-page">{id === "new" ? <NewDriver d={BLANK_DRIVER} /> : <LoadedDriver id={id} />}</div>;
}

function LoadedDriver({ id }: { id: string }) {
  const detail = useDriverDetail(id);
  return (
    <>
      {detail.status !== "ready" ? (
        <PageHeader title={detail.status === "loading" ? strings.app.loading : s.driverTitle} back={{ to: "/networks", label: s.back }} />
      ) : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad" aria-label={s.driverLoading}><SkeletonBlock lines={6} /></div>}>
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
      <PageHeader title={s.driverNewTitle} back={{ to: "/networks", label: s.back }} />
      {!canAct ? (
        <InlineNotice tone="neutral" title={strings.app.readOnly} />
      ) : (
        <DriverForm
          d={d}
          isNew
          onSave={async (x) => {
            const r = await save(inputOf(x));
            toast(s.driverCreated(x.name.trim()));
            navigate(`/networks/drivers/${r.id}`, { replace: true });
          }}
        />
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
        back={{ to: "/networks", label: s.back }}
        title={<span className="dash-wrap">{d.name}</span>}
        meta={
          <>
            <span className="dash-chip">{s.driverKindShort[d.kind]}</span>
            <span className="dash-chip">{s.driverClassShort[d.deviceClass]}</span>
          </>
        }
      />
      {!canAct ? <InlineNotice tone="neutral" title={s.readOnly} /> : null}
      <div className="dash-grid dash-grid--main">
        <div className="dash-stack">
          {canAct ? (
            <DriverForm
              key={formKey}
              d={d}
              onSave={async (x) => {
                const r = await save({ ...inputOf(x), id: d._id, expectedRevision: revision });
                setRevision(r.revision);
                toast(s.driverSaved);
              }}
              onReload={reload}
            />
          ) : (
            <ReadOnlyDriver d={d} />
          )}
        </div>
        <div className="dash-stack">
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
    <Card title={s.driverTitle}>
      <dl className="dash-kv">
        <div className="dash-kv__item">
          <dt>{s.name}</dt>
          <dd className="dash-wrap">{d.name}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.driverKind}</dt>
          <dd>{s.driverKindNames[d.kind]}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.driverClassLabel}</dt>
          <dd>{s.driverClassShort[d.deviceClass]}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.driverUrl}</dt>
          <dd className="dash-mono dash-wrap">{d.url}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.driverSha}</dt>
          <dd className="dash-mono dash-wrap">{d.sha256}</dd>
        </div>
        {d.inf !== null ? (
          <div className="dash-kv__item">
            <dt>{s.driverInf}</dt>
            <dd className="dash-mono dash-wrap">{d.inf}</dd>
          </div>
        ) : null}
        {d.provides.length > 0 ? (
          <div className="dash-kv__item">
            <dt>{s.driverProvides}</dt>
            <dd>{d.provides.join(", ")}</dd>
          </div>
        ) : null}
        <div className="dash-kv__item">
          <dt>{s.groups}</dt>
          <dd>
            {d.groups.length ? d.groups.map((g) => g.name).join(", ") : strings.common.none}
            {d.groupCount > d.groups.length ? ` ${s.moreGroups(d.groupCount - d.groups.length)}` : ""}
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
  const groups = useGroupsScreen();
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
      name: name === null ? undefined : s.driverNameProblems[name],
      url: url === null ? undefined : s.driverUrlProblems[url],
      sha256: sha === null ? undefined : s.driverShaProblems[sha],
      size: size === null ? undefined : s.driverSizeProblems[size],
      inf: inf === null ? undefined : s.driverInfProblems[inf],
      args: args === null ? undefined : s.driverArgsProblems[args],
      codes: codes === null ? undefined : s.driverCodesProblems[codes],
      provides: provides === null ? undefined : s.driverProvidesProblems[provides],
      groupIds: x.groupIds.length > MAX_PRINTER_GROUPS ? s.groupsOver(MAX_PRINTER_GROUPS) : undefined,
    };
  });
  const describe = (e: unknown) => {
    const a = toAppError(e);
    return a ? s.describeError(a.code, a.detail) : null;
  };
  const serverField = (field: string, text: string) => serverFieldError(f.serverError, field, () => text);
  const kind = f.values.kind;

  return (
    <Card title={isNew ? s.driverNewTitle : s.driverTitle}>
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            await onSave(x);
          }, form.current);
        }}
      >
        <InlineNotice tone="neutral" title={s.driverRules} />
        <Field label={s.name} hint={s.driverNameHint} error={f.errors.name ?? serverField("name", s.driverNameTaken)} required>
          {(p) => <Input {...p} value={f.values.name} autoComplete="off" maxLength={MAX_DRIVER_NAME * 2} onChange={(e) => f.set("name", e.target.value)} />}
        </Field>
        <Field label={s.driverClassLabel} hint={s.driverClassHint}>
          {(p) => (
            <Select {...p} value={f.values.deviceClass} onChange={(e) => f.set("deviceClass", e.target.value as DriverClass)}>
              {DRIVER_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {s.driverClassShort[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={s.driverKind} hint={s.driverKindHelp[kind]}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => f.set("kind", e.target.value as DriverKind)}>
              {DRIVER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {s.driverKindNames[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={s.driverUrl} hint={s.driverUrlHint} error={f.errors.url ?? serverField("url", s.driverUrlProblems.scheme)} required>
          {(p) => (
            <Input
              {...p}
              className="dash-mono"
              type="url"
              value={f.values.url}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => f.set("url", e.target.value)}
            />
          )}
        </Field>
        <Field label={s.driverSha} hint={s.driverShaHint} error={f.errors.sha256 ?? serverField("sha256", s.driverShaProblems.format)} required>
          {(p) => <Input {...p} className="dash-mono" value={f.values.sha256} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => f.set("sha256", e.target.value)} />}
        </Field>
        <Field label={s.driverSize} hint={s.driverSizeHint} error={f.errors.size ?? serverField("sizeBytes", s.driverSizeProblems.range)} optional>
          {(p) => <Input {...p} className="dash-mono" inputMode="numeric" value={f.values.size} autoComplete="off" onChange={(e) => f.set("size", e.target.value)} />}
        </Field>
        {kind === "inf" ? (
          <Field label={s.driverInf} hint={s.driverInfHint} error={f.errors.inf ?? serverField("inf", s.driverInfProblems.path)} required>
            {(p) => <Input {...p} className="dash-mono" value={f.values.inf} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => f.set("inf", e.target.value)} />}
          </Field>
        ) : null}
        {kind === "exe" ? (
          <Field label={s.driverArgs} hint={s.driverArgsHint} error={f.errors.args ?? serverField("silentArgs", s.driverArgsProblems.required)} required>
            {(p) => <Textarea {...p} className="dash-mono" rows={3} value={f.values.args} spellCheck={false} onChange={(e) => f.set("args", e.target.value)} />}
          </Field>
        ) : null}
        {kind === "exe" ? (
          <Field label={s.driverCodes} hint={s.driverCodesHint} error={f.errors.codes ?? serverField("successExitCodes", s.driverCodesProblems.number)} optional>
            {(p) => <Input {...p} className="dash-mono" value={f.values.codes} autoComplete="off" onChange={(e) => f.set("codes", e.target.value)} />}
          </Field>
        ) : null}
        <Field label={s.driverProvides} hint={s.driverProvidesHint} error={f.errors.provides ?? serverField("provides", s.driverProvidesProblems.length)} optional>
          {(p) => <Textarea {...p} rows={2} value={f.values.provides} spellCheck={false} onChange={(e) => f.set("provides", e.target.value)} />}
        </Field>
        <FieldSet legend={s.groups} hint={s.driverGroupsHint} error={f.errors.groupIds ?? serverField("groupIds", s.groupsServerRefused)}>
          {groups.status === "loading" ? (
            <SkeletonBlock lines={2} />
          ) : groups.status === "error" ? (
            <RegionError error={groups.error} onRetry={groups.retry} />
          ) : groups.data.length === 0 ? (
            <p className="dash-muted">{s.noGroupsExist}</p>
          ) : (
            <div className="dash-checks dash-checks--scroll">
              {groups.data.map((g) => (
                <Checkbox
                  key={g._id}
                  label={g.name}
                  checked={f.values.groupIds.includes(g._id)}
                  onChange={(e) => f.set("groupIds", e.target.checked ? [...f.values.groupIds, g._id] : f.values.groupIds.filter((x) => x !== g._id))}
                />
              ))}
            </div>
          )}
        </FieldSet>
        <FormError
          error={f.serverError}
          onReload={onReload}
          fields={["name", "url", "sha256", "sizeBytes", "inf", "silentArgs", "successExitCodes", "provides", "groupIds"]}
          describe={describe}
        />
        <div className="dash-form__actions">
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : isNew ? s.createDriver : strings.common.saveChanges}
          </Button>
          {isNew ? (
            <Link to="/networks" className="rb-btn rb-btn--ghost">
              {strings.common.cancel}
            </Link>
          ) : f.dirty ? (
            <span className="dash-form__status">{s.unsaved}</span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function InstallCounts({ counts, hasGroups }: { counts: DriverCounts; hasGroups: boolean }) {
  const items: [string, number, string][] = [
    [s.driverInstalled, counts.installed, "ok"],
    [s.driverPending, counts.pending, "wait"],
    [s.driverRestart, counts.restartNeeded, "wait"],
    [s.driverFailed, counts.failed, "bad"],
    [s.driverRemoved, counts.removed, "ok"],
  ];
  if (counts.unsupported > 0) items.push([s.driverUnsupported, counts.unsupported, "bad"]);
  return (
    <Card title={s.driverCountsTitle} sub={s.driverCountsSub}>
      {!hasGroups || counts.sampled === 0 ? (
        <p className="dash-muted">{hasGroups ? s.driverCountsNone : s.noGroups}</p>
      ) : (
        <>
          <dl className="dash-net__counts">
            {items.map(([label, n, tone]) => (
              <div key={label} className={`dash-net__count dash-net__count--${tone}`}>
                <dt>{label}</dt>
                <dd>{n}</dd>
              </div>
            ))}
          </dl>
          <p className="dash-cell-sub">{counts.capped ? s.countsCapped(counts.sampled) : `${formatNumber(counts.sampled)} ${plural(counts.sampled, { one: "PC", other: "PCs" })} counted.`}</p>
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
              .then(() => toast(s.driverRetried))
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          {s.retryDriver}
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
    <Card title={s.removeDriver} tone="danger">
      <div className="dash-row dash-row--between">
        <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.driverDeleteBody}</span>
        <Button variant="danger-ghost" onClick={() => setOpen(true)}>
          {s.removeDriver}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title={s.driverDeleteTitle(d.name)}
        body={s.driverDeleteBody}
        confirmLabel={s.removeDriver}
        danger
        typeToConfirm={d.name}
        describeError={(e) => {
          const a = toAppError(e);
          return a ? s.describeError(a.code, a.detail) : null;
        }}
        onConfirm={() => del({ id: d._id })}
        onDone={() => {
          toast(s.driverDeleted(d.name));
          navigate("/networks", { replace: true });
        }}
        onClose={() => setOpen(false)}
      />
    </Card>
  );
}
