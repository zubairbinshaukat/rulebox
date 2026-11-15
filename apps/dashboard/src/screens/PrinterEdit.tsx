import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Checkbox, Input, Select } from "@rulebox/ui";
import { useDeletePrinter, useGroupsScreen, useNetworks, usePrinterDetail, useSavePrinter } from "../data";
import type { PrinterDetail, PrinterInput, PrinterKind, WifiApplyCounts } from "../data/types";
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
import { useCan } from "../lib/member";
import {
  MAX_PRINTER_GROUPS,
  MAX_PRINTER_NAME,
  PRINTER_KINDS,
  addressProblem,
  driverChoices,
  portProblem,
  printerNameProblem,
  queueProblem,
} from "../lib/printerRules";
import { strings } from "../lib/strings";
import { useToast } from "../lib/toast";
import { useForm } from "../lib/useForm";
import { BLANK_PRINTER } from "./networks/model";
import { networksStrings as s } from "./networks/strings";

interface Values extends Record<string, unknown> {
  name: string;
  kind: PrinterKind;
  address: string;
  /** Text, so an empty field can mean "the default port". */
  port: string;
  queue: string;
  driver: string;
  groupIds: string[];
  defaultForGroupIds: string[];
}

const valuesOf = (d: PrinterDetail): Values => ({
  name: d.name,
  kind: d.kind,
  address: d.address,
  port: d.port === null ? "" : String(d.port),
  queue: d.queue ?? "",
  driver: d.driver,
  groupIds: d.groupIds,
  defaultForGroupIds: d.defaultForGroupIds,
});

/** The call's input: a port only for raw printers, a queue only for LPR, defaults only in groups that are picked. */
const inputOf = (x: Values): PrinterInput => ({
  name: x.name.trim(),
  kind: x.kind,
  address: x.address.trim(),
  ...(x.kind === "raw" && x.port.trim() !== "" ? { port: Number(x.port.trim()) } : {}),
  ...(x.kind === "lpr" ? { queue: x.queue.trim() } : {}),
  driver: x.driver,
  groupIds: x.groupIds,
  defaultForGroupIds: x.defaultForGroupIds.filter((g) => x.groupIds.includes(g)),
});

/** `networks:printerDetail`; `/networks/printers/new` is the same form with blank values and nothing subscribed. */
export default function PrinterEdit() {
  const { id = "new" } = useParams();
  return <div className="dash-page">{id === "new" ? <NewPrinter d={BLANK_PRINTER} /> : <LoadedPrinter id={id} />}</div>;
}

function LoadedPrinter({ id }: { id: string }) {
  const detail = usePrinterDetail(id);
  return (
    <>
      {detail.status !== "ready" ? (
        <PageHeader title={detail.status === "loading" ? strings.app.loading : s.printerTitle} back={{ to: "/networks", label: s.back }} />
      ) : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad" aria-label={s.printerLoading}><SkeletonBlock lines={6} /></div>}>
        {(d) => <ExistingPrinter d={d} />}
      </QueryRegion>
    </>
  );
}

function NewPrinter({ d }: { d: PrinterDetail }) {
  const canAct = useCan("admin");
  const save = useSavePrinter();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <>
      <PageHeader title={s.printerNewTitle} back={{ to: "/networks", label: s.back }} />
      {!canAct ? (
        <InlineNotice tone="neutral" title={strings.app.readOnly} />
      ) : (
        <PrinterForm
          d={d}
          isNew
          onSave={async (x) => {
            const r = await save(inputOf(x));
            toast(s.printerCreated(x.name.trim()));
            navigate(`/networks/printers/${r.id}`, { replace: true });
          }}
        />
      )}
    </>
  );
}

function ExistingPrinter({ d }: { d: PrinterDetail }) {
  const canAct = useCan("admin");
  const save = useSavePrinter();
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
            <span className="dash-chip">{s.kindShort[d.kind]}</span>
            <span className="dash-chip dash-mono">{d.address}</span>
          </>
        }
      />
      {!canAct ? <InlineNotice tone="neutral" title={s.readOnly} /> : null}
      <div className="dash-grid dash-grid--main">
        <div className="dash-stack">
          {canAct ? (
            <PrinterForm
              key={formKey}
              d={d}
              onSave={async (x) => {
                const r = await save({ ...inputOf(x), id: d._id, expectedRevision: revision });
                setRevision(r.revision);
                toast(s.printerSaved);
              }}
              onReload={reload}
            />
          ) : (
            <ReadOnlyPrinter d={d} />
          )}
        </div>
        <div className="dash-stack">
          <ApplyCounts counts={d.counts} hasGroups={d.groupIds.length > 0} />
          <RoleGate minRole="admin">
            <DeleteCard d={d} />
          </RoleGate>
          <HistoryPanel targetId={d._id} />
        </div>
      </div>
    </>
  );
}

function ReadOnlyPrinter({ d }: { d: PrinterDetail }) {
  return (
    <Card title={s.printerTitle}>
      <dl className="dash-kv">
        <div className="dash-kv__item">
          <dt>{s.name}</dt>
          <dd className="dash-wrap">{d.name}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.kindNames[d.kind]}</dt>
          <dd className="dash-mono dash-wrap">{d.address}</dd>
        </div>
        {d.port !== null ? (
          <div className="dash-kv__item">
            <dt>{s.port}</dt>
            <dd className="dash-mono">{d.port}</dd>
          </div>
        ) : null}
        {d.queue !== null ? (
          <div className="dash-kv__item">
            <dt>{s.queue}</dt>
            <dd className="dash-mono">{d.queue}</dd>
          </div>
        ) : null}
        <div className="dash-kv__item">
          <dt>{s.driverLabel}</dt>
          <dd>{d.driver}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.groups}</dt>
          <dd>
            {d.groups.length ? d.groups.map((g) => g.name).join(", ") : strings.common.none}
            {d.groupCount > d.groups.length ? ` ${s.moreGroups(d.groupCount - d.groups.length)}` : ""}
          </dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.defaultsLegend}</dt>
          <dd>{d.defaultGroupCount > 0 ? s.defaultBadge(d.defaultGroupCount) : strings.common.no}</dd>
        </div>
      </dl>
    </Card>
  );
}

function PrinterForm({
  d,
  isNew,
  onSave,
  onReload,
}: {
  d: PrinterDetail;
  isNew?: boolean;
  onSave: (values: Values) => Promise<void>;
  onReload?: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const groups = useGroupsScreen();
  const networks = useNetworks();
  const f = useForm<Values>(valuesOf(d), (x) => {
    const name = printerNameProblem(x.name);
    const address = addressProblem(x.kind, x.address);
    return {
      name: name === null ? undefined : s.printerNameProblems[name],
      address: address === null ? undefined : s.addressProblems[address],
      port: x.kind === "raw" && portProblem(x.port) !== null ? s.portProblems.range : undefined,
      queue: x.kind === "lpr" ? (queueProblem(x.queue) === null ? undefined : s.queueProblems[queueProblem(x.queue) ?? "required"]) : undefined,
      groupIds: x.groupIds.length > MAX_PRINTER_GROUPS ? s.groupsOver(MAX_PRINTER_GROUPS) : undefined,
    };
  });
  const approved = networks.status === "ready" ? networks.data.approvedDrivers : driverChoices([]);
  // Names a Drivers entry delivers are tagged (they only work on PCs of the groups that entry is assigned to).
  const delivered = new Set((networks.status === "ready" ? networks.data.drivers : []).flatMap((d) => d.provides.map((n) => n.toLowerCase())));
  // A driver the printer has but the list no longer offers stays selectable (and is marked) so a save does not silently change it.
  const choices = approved.includes(f.values.driver) || f.values.driver === "" ? approved : [...approved, f.values.driver];
  const describe = (e: unknown) => {
    const a = toAppError(e);
    return a ? s.describeError(a.code, a.detail) : null;
  };
  const serverField = (field: string, text: string) => serverFieldError(f.serverError, field, () => text);
  const kind = f.values.kind;
  const selectedGroups = (groups.status === "ready" ? groups.data : []).filter((g) => f.values.groupIds.includes(g._id));

  return (
    <Card title={isNew ? s.printerNewTitle : s.printerTitle}>
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
        <Field label={s.name} hint={s.printerNameHint} error={f.errors.name ?? serverField("name", s.nameTaken)} required>
          {(p) => <Input {...p} value={f.values.name} autoComplete="off" maxLength={MAX_PRINTER_NAME * 2} onChange={(e) => f.set("name", e.target.value)} />}
        </Field>
        <Field label={s.kindLabel} hint={s.kindHelp[kind]}>
          {(p) => (
            <Select
              {...p}
              value={kind}
              onChange={(e) => {
                f.set("kind", e.target.value as PrinterKind);
                // The other kinds have no port or queue: drop what no longer applies.
                f.set("port", "");
                f.set("queue", "");
              }}
            >
              {PRINTER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {s.kindNames[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={s.addressLabel[kind]} hint={s.addressHint[kind]} error={f.errors.address ?? serverField("address", s.addressProblems.host)} required>
          {(p) => (
            <Input
              {...p}
              className="dash-mono"
              value={f.values.address}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => f.set("address", e.target.value)}
            />
          )}
        </Field>
        {kind === "raw" ? (
          <Field label={s.port} hint={s.portHint} error={f.errors.port ?? serverField("port", s.portProblems.range)}>
            {(p) => <Input {...p} className="dash-mono" inputMode="numeric" value={f.values.port} autoComplete="off" onChange={(e) => f.set("port", e.target.value)} />}
          </Field>
        ) : null}
        {kind === "lpr" ? (
          <Field label={s.queue} hint={s.queueHint} error={f.errors.queue ?? serverField("queue", s.queueProblems.required)} required>
            {(p) => <Input {...p} className="dash-mono" value={f.values.queue} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => f.set("queue", e.target.value)} />}
          </Field>
        ) : null}
        <Field label={s.driverLabel} hint={s.driverHint} error={serverField("driver", s.driverRefused)}>
          {(p) => (
            <Select {...p} value={f.values.driver} onChange={(e) => f.set("driver", e.target.value)}>
              {choices.map((name) => (
                <option key={name} value={name}>
                  {!approved.includes(name) ? `${name} (${s.driverNotListed})` : delivered.has(name.toLowerCase()) ? `${name} (${s.driverDelivered})` : name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FieldSet legend={s.groups} hint={s.printerGroupsHint} error={f.errors.groupIds ?? serverField("groupIds", s.groupsServerRefused)}>
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
                  onChange={(e) => {
                    f.set("groupIds", e.target.checked ? [...f.values.groupIds, g._id] : f.values.groupIds.filter((x) => x !== g._id));
                    // Leaving a group also drops its default.
                    if (!e.target.checked) f.set("defaultForGroupIds", f.values.defaultForGroupIds.filter((x) => x !== g._id));
                  }}
                />
              ))}
            </div>
          )}
        </FieldSet>
        <FieldSet legend={s.defaultsLegend} hint={s.defaultsHint} error={serverField("defaultForGroupIds", s.defaultTaken)}>
          {selectedGroups.length === 0 ? (
            <p className="dash-muted">{s.noDefaultGroups}</p>
          ) : (
            <div className="dash-checks dash-checks--scroll">
              {selectedGroups.map((g) => (
                <Checkbox
                  key={g._id}
                  label={s.defaultIn(g.name)}
                  checked={f.values.defaultForGroupIds.includes(g._id)}
                  onChange={(e) =>
                    f.set("defaultForGroupIds", e.target.checked ? [...f.values.defaultForGroupIds, g._id] : f.values.defaultForGroupIds.filter((x) => x !== g._id))
                  }
                />
              ))}
            </div>
          )}
        </FieldSet>
        <FormError error={f.serverError} onReload={onReload} fields={["name", "address", "port", "queue", "driver", "groupIds", "defaultForGroupIds"]} describe={describe} />
        <div className="dash-form__actions">
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : isNew ? s.createPrinter : strings.common.saveChanges}
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

function ApplyCounts({ counts, hasGroups }: { counts: WifiApplyCounts; hasGroups: boolean }) {
  const items: [string, number, string][] = [
    [s.printerApplied, counts.applied, "ok"],
    [s.printerFailed, counts.failed, "bad"],
  ];
  return (
    <Card title={s.countsTitle} sub={s.printerCountsSub}>
      {!hasGroups || counts.sampled === 0 ? (
        <p className="dash-muted">{hasGroups ? s.printerCountsNone : s.noGroups}</p>
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
          <p className="dash-cell-sub">{counts.capped ? s.countsCapped(counts.sampled) : s.countsSampled(counts.sampled)}</p>
        </>
      )}
    </Card>
  );
}

function DeleteCard({ d }: { d: PrinterDetail }) {
  const del = useDeletePrinter();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <Card title={s.removePrinter} tone="danger">
      <div className="dash-row dash-row--between">
        <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.printerDeleteBody}</span>
        <Button variant="danger-ghost" onClick={() => setOpen(true)}>
          {s.removePrinter}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title={s.printerDeleteTitle(d.name)}
        body={s.printerDeleteBody}
        confirmLabel={s.removePrinter}
        danger
        typeToConfirm={d.name}
        describeError={(e) => {
          const a = toAppError(e);
          return a ? s.describeError(a.code, a.detail) : null;
        }}
        onConfirm={() => del({ id: d._id })}
        onDone={() => {
          toast(s.printerDeleted(d.name));
          navigate("/networks", { replace: true });
        }}
        onClose={() => setOpen(false)}
      />
    </Card>
  );
}
