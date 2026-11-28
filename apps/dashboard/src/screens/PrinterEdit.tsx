import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Checkbox, Input, InfoTip, Pill, SearchSelect, Select } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-linear";
import { useDeletePrinter, useGroupsScreen, useNetworks, usePrinterDetail, useSavePrinter, useSetApprovedPrinterDrivers } from "../data";
import type { PrinterDetail, PrinterInput, PrinterKind, WifiApplyCounts } from "../data/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field, FieldSet } from "../components/Field";
import { FormError } from "../components/FormError";
import { HistoryPanel } from "../components/HistoryPanel";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { serverFieldError } from "../components/serverField";
import { SkeletonBlock } from "../components/Skeleton";
import { addedNameProblem } from "../lib/driverRules";
import { toAppError } from "../lib/errors";
import { useCan } from "../lib/member";
import {
  MAX_PRINTER_GROUPS,
  MAX_PRINTER_NAME,
  PRINTER_KINDS,
  addressProblem,
  defaultDriverFor,
  driverChoices,
  parsePrinterAddress,
  portProblem,
  printerNameProblem,
  queueProblem,
} from "../lib/printerRules";
import { strings } from "../lib/strings";
import { useToast } from "../lib/toast";
import { useForm } from "../lib/useForm";
import { BLANK_PRINTER, printerAddressText, printerHost } from "./networks/model";
import { AdvancedBox, GroupPicker, SwitchRow } from "./networks/parts";
import { printerStrings as s } from "./networks/printerStrings";
import { networksStrings as n } from "./networks/strings";
import "./networks/networks.css";

/** The driver Select's own values: "Automatic" and "Another driver…" are not names. */
const AUTO = "\u0000auto";
const OTHER = "\u0000other";

interface Values extends Record<string, unknown> {
  /** The ONE address field: what the admin typed (automatic), or the address in the shape the server stores (a connection type was picked). */
  address: string;
  /** "auto": the connection is read from the address. Otherwise the picked kind. */
  mode: "auto" | PrinterKind;
  /** Text, so an empty field can mean "the default port". Only with a picked connection type. */
  port: string;
  queue: string;
  name: string;
  driver: string;
  otherDriver: string;
  groupIds: string[];
  /** "Make it the default printer": the default in every picked group. */
  defaultAll: boolean;
  /** The groups it is the default of when not in all of them (Advanced). */
  defaultForGroupIds: string[];
}

const valuesOf = (d: PrinterDetail): Values => ({
  address: d.address === "" ? "" : printerAddressText(d),
  mode: "auto",
  port: "",
  queue: "",
  name: d.name,
  driver: d.address === "" || d.driver === defaultDriverFor(d.kind) ? AUTO : d.driver,
  otherDriver: "",
  groupIds: d.groupIds,
  defaultAll: d.groupIds.length > 0 && d.groupIds.every((g) => d.defaultForGroupIds.includes(g)),
  defaultForGroupIds: d.defaultForGroupIds,
});

interface Resolved {
  kind: PrinterKind;
  address: string;
  port?: number;
  queue?: string;
}

/** What the address fields mean: read from the one address (automatic), or as typed for the picked connection type. Null = no printer. */
function resolve(x: Values): Resolved | null {
  if (x.mode === "auto") return parsePrinterAddress(x.address);
  const port = x.mode === "raw" && x.port.trim() !== "" && portProblem(x.port) === null ? Number(x.port.trim()) : undefined;
  return { kind: x.mode, address: x.address.trim(), ...(port !== undefined ? { port } : {}), ...(x.mode === "lpr" ? { queue: x.queue.trim() } : {}) };
}

/** The problem with the address field, as a sentence (null = fine). */
function addressError(x: Values): string | null {
  if (x.address.trim() === "") return s.addressProblems.empty;
  const r = resolve(x);
  if (r === null) {
    // Nothing a printer could be: but an address that starts like one gets its own, more helpful sentence.
    const text = x.address.trim();
    const hint = /^(ipp|https):\/\//i.test(text) ? addressProblem("ipp", text) : text.startsWith("\\\\") ? addressProblem("share", text) : null;
    return hint === null ? s.addressNone : s.addressProblems[hint];
  }
  const p = addressProblem(r.kind, r.address);
  return p === null ? null : s.addressProblems[p];
}

const bare = (host: string) => (host.startsWith("[") ? host.slice(1, -1) : host);
const bracketed = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** The address field's text when the admin picks another connection type: the same host in the shape of the new type. */
function convertAddress(from: Resolved | null, kind: PrinterKind, typed: string): { address: string; port: string; queue: string } {
  if (from === null) return { address: typed, port: "", queue: "" };
  const host = bare(printerHost(from.kind, from.address));
  const port = from.port !== undefined ? String(from.port) : "";
  const queue = from.queue ?? "";
  if (kind === from.kind) return { address: from.address, port, queue };
  if (kind === "ipp") return { address: `ipp://${bracketed(host)}/ipp/print`, port: "", queue: "" };
  if (kind === "share") return { address: from.kind === "share" ? from.address : `\\\\${host}\\`, port: "", queue: "" };
  return { address: host, port: kind === "raw" ? port : "", queue: kind === "lpr" ? queue : "" };
}

/** `networks:printerDetail`; `/networks/printers/new` is the same form with blank values and nothing subscribed. */
export default function PrinterEdit() {
  const { id = "new" } = useParams();
  return <div className="dash-page net-page">{id === "new" ? <NewPrinter d={BLANK_PRINTER} /> : <LoadedPrinter id={id} />}</div>;
}

function LoadedPrinter({ id }: { id: string }) {
  const detail = usePrinterDetail(id);
  return (
    <>
      {detail.status !== "ready" ? (
        <PageHeader title={detail.status === "loading" ? strings.app.loading : s.title} back={{ to: "/networks", label: n.back }} />
      ) : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad" aria-label={s.loading}><SkeletonBlock lines={6} /></div>}>
        {(d) => <ExistingPrinter d={d} />}
      </QueryRegion>
    </>
  );
}

function NewPrinter({ d }: { d: PrinterDetail }) {
  const canAct = useCan("admin");
  const navigate = useNavigate();
  const toast = useToast();
  const save = useSavePrinter();
  const tips = (
    <>
      {s.examples.map((e) => (
        <span key={e.code}>
          {e.text}: {e.code}.{" "}
        </span>
      ))}
    </>
  );
  return (
    <>
      <PageHeader
        title={s.newTitle}
        back={{ to: "/networks", label: n.back }}
        meta={
          <span className="net-howinfo">
            {s.examplesTitle}
            <InfoTip label={`About ${s.examplesTitle}`}>{tips}</InfoTip>
          </span>
        }
      />
      {!canAct ? (
        <InlineNotice tone="neutral" title={strings.app.readOnly} />
      ) : (
        <div className="dash-split">
          <div className="dash-split__main net-formcol">
            <PrinterForm
              d={d}
              isNew
              save={save}
              onSaved={(r, x) => {
                toast(s.created(x.name.trim()));
                navigate(`/networks/printers/${r.id}`, { replace: true });
              }}
            />
          </div>
          <div className="dash-split__aside net-aside">
            <aside className="dash-card net-how" aria-label={s.examplesTitle}>
              <h2 className="net-how__title">{s.examplesTitle}</h2>
              <ul className="net-how__list">
                {s.examples.map((e) => (
                  <li key={e.code}>
                    <code className="net-how__code">{e.code}</code>
                    {e.text}
                  </li>
                ))}
              </ul>
              <p className="net-how__foot">{s.examplesFoot}</p>
            </aside>
          </div>
        </div>
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
        back={{ to: "/networks", label: n.back }}
        title={<span className="dash-wrap">{d.name}</span>}
        meta={
          <>
            {d.defaultGroupCount > 0 ? <Pill tone="accent">{n.defaultPill}</Pill> : null}
            <span className="dash-chip">{n.printerKindCard[d.kind]}</span>
            <span className="dash-chip dash-mono">{printerHost(d.kind, d.address)}</span>
          </>
        }
      />
      {!canAct ? <InlineNotice tone="neutral" title={n.readOnly} /> : null}
      <div className="dash-split">
        <div className="dash-split__main net-formcol">
          {canAct ? (
            <PrinterForm
              key={formKey}
              d={d}
              save={(input) => save({ ...input, id: d._id, expectedRevision: revision })}
              onSaved={(r) => {
                setRevision(r.revision);
                toast(s.saved);
              }}
              onReload={reload}
            />
          ) : (
            <ReadOnlyPrinter d={d} />
          )}
        </div>
        <div className="dash-split__aside">
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
    <Card title={s.title}>
      <dl className="dash-kv">
        <div className="dash-kv__item">
          <dt>{s.readName}</dt>
          <dd className="dash-wrap">{d.name}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readAddress}</dt>
          <dd className="dash-mono dash-wrap">{printerAddressText(d)}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readConnection}</dt>
          <dd>{s.kindNames[d.kind]}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readDriver}</dt>
          <dd>{d.driver}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{n.groupsRead}</dt>
          <dd>
            {d.groups.length ? d.groups.map((g) => g.name).join(", ") : strings.common.none}
            {d.groupCount > d.groups.length ? ` ${n.moreGroups(d.groupCount - d.groups.length)}` : ""}
          </dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readDefault}</dt>
          <dd>{d.defaultGroupCount > 0 ? s.defaultBadge(d.defaultGroupCount) : strings.common.no}</dd>
        </div>
      </dl>
    </Card>
  );
}

function PrinterForm({
  d,
  isNew,
  save,
  onSaved,
  onReload,
}: {
  d: PrinterDetail;
  isNew?: boolean;
  save: (input: PrinterInput) => Promise<{ id: string; revision: number }>;
  onSaved: (result: { id: string; revision: number }, values: Values) => void;
  onReload?: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const groups = useGroupsScreen();
  const networks = useNetworks();
  const setApproved = useSetApprovedPrinterDrivers();
  // Names this form already added to the approved list (a retry after a failed save must not add them twice).
  const added = useRef<Set<string>>(new Set());
  const f = useForm<Values>(valuesOf(d), (x) => {
    const name = printerNameProblem(x.name);
    const manual = x.mode !== "auto";
    const other = x.driver === OTHER ? addedNameProblem(x.otherDriver) : null;
    return {
      name: name === null ? undefined : s.nameProblems[name],
      address: addressError(x) ?? undefined,
      port: x.mode === "raw" && portProblem(x.port) !== null ? s.portProblems.range : undefined,
      queue: manual && x.mode === "lpr" ? (queueProblem(x.queue) === null ? undefined : s.queueProblems[queueProblem(x.queue) ?? "required"]) : undefined,
      otherDriver: other === null ? undefined : n.approvedProblems[other],
      groupIds: x.groupIds.length > MAX_PRINTER_GROUPS ? n.groupsOver(MAX_PRINTER_GROUPS) : undefined,
    };
  });
  const x = f.values;
  const ready = networks.status === "ready" ? networks.data : null;
  const approved = ready ? ready.approvedDrivers : driverChoices([]);
  // Names a Drivers entry delivers are tagged (they only work on PCs of the groups that entry is assigned to).
  const delivered = new Set((ready ? ready.drivers : []).flatMap((dr) => dr.provides.map((p) => p.toLowerCase())));
  const resolved = resolve(x);
  const describe = (e: unknown) => {
    const a = toAppError(e);
    return a ? n.describeError(a.code, a.detail) : null;
  };
  const serverField = (field: string, text: string) => serverFieldError(f.serverError, field, () => text);
  const addressErr = f.errors.address ?? serverField("address", s.addressProblems.host);
  const portErr = f.errors.port ?? serverField("port", s.portProblems.range);
  const queueErr = f.errors.queue ?? serverField("queue", s.queueProblems.required);
  const driverErr = serverField("driver", s.driverRefused);
  const advancedError = [portErr, queueErr, driverErr, f.errors.otherDriver].some((e) => e !== undefined && e !== null);
  const detected = x.mode === "auto" && resolved !== null && f.errors.address === undefined && addressError(x) === null ? resolved : null;

  // A driver the printer has but the list no longer offers stays selectable (and is marked) so a save does not silently change it.
  const known = approved.some((a) => a.toLowerCase() === x.driver.toLowerCase());
  const driverOptions = [
    { value: AUTO, label: s.driverAuto },
    ...approved.map((name) => ({ value: name, label: name, hint: delivered.has(name.toLowerCase()) ? s.driverDelivered : undefined })),
    ...(x.driver !== AUTO && x.driver !== OTHER && !known ? [{ value: x.driver, label: x.driver, hint: s.driverNotListed }] : []),
    { value: OTHER, label: s.driverOther, disabled: ready === null },
  ];

  const pickGroups = (ids: string[]) => {
    f.set("groupIds", ids);
    // Leaving a group also drops its default.
    f.set("defaultForGroupIds", x.defaultForGroupIds.filter((g) => ids.includes(g)));
  };
  const selectedGroups = (groups.status === "ready" ? groups.data : []).filter((g) => x.groupIds.includes(g._id));
  const effectiveDefaults = x.defaultAll ? x.groupIds : x.defaultForGroupIds.filter((g) => x.groupIds.includes(g));

  const submit = async (values: Values) => {
    const r = resolve(values);
    if (r === null) return;
    let driver = values.driver === AUTO ? defaultDriverFor(r.kind) : values.driver;
    if (values.driver === OTHER && ready !== null) {
      const typed = values.otherDriver.trim();
      const existing = approved.find((a) => a.toLowerCase() === typed.toLowerCase());
      driver = existing ?? typed;
      if (existing === undefined && !added.current.has(typed.toLowerCase())) {
        await setApproved({ names: [...ready.addedDrivers, typed] });
        added.current.add(typed.toLowerCase());
      }
    }
    const input: PrinterInput = {
      name: values.name.trim(),
      kind: r.kind,
      address: r.address,
      ...(r.kind === "raw" && r.port !== undefined ? { port: r.port } : {}),
      ...(r.kind === "lpr" ? { queue: r.queue ?? "" } : {}),
      driver,
      groupIds: values.groupIds,
      defaultForGroupIds: values.defaultAll ? values.groupIds : values.defaultForGroupIds.filter((g) => values.groupIds.includes(g)),
    };
    onSaved(await save(input), values);
  };

  return (
    <Card className="dash-enter">
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(submit, form.current);
        }}
      >
        <div className="dash-form-grid net-fields">
          <Field label={s.address} info={s.addressInfo} error={addressErr} required>
            {(p) => (
              <>
                <Input
                  {...p}
                  className="dash-mono"
                  value={x.address}
                  placeholder={s.addressPlaceholder}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  autoFocus={isNew}
                  onChange={(e) => f.set("address", e.target.value)}
                />
                {detected !== null ? (
                  <p className="net-detect">
                    <IconCheck aria-hidden="true" />
                    <span>{s.connectsAs(detectedText(detected))}</span>
                    <InfoTip label={`About ${s.connectsAs("")}`.trim()}>{s.connectsAsInfo}</InfoTip>
                  </p>
                ) : null}
              </>
            )}
          </Field>
          <Field label={s.name} info={s.nameInfo} error={f.errors.name ?? serverField("name", s.nameTaken)} required>
            {(p) => (
              <Input
                {...p}
                value={x.name}
                placeholder={s.namePlaceholder}
                autoComplete="off"
                maxLength={MAX_PRINTER_NAME * 2}
                onChange={(e) => f.set("name", e.target.value)}
              />
            )}
          </Field>
        </div>
        <GroupPicker groups={groups} autoPick={isNew} selected={x.groupIds} onChange={pickGroups} error={f.errors.groupIds ?? serverField("groupIds", n.groupsServerRefused)} />
        <div className="dash-stack" style={{ gap: 6 }}>
          <SwitchRow
            checked={effectiveDefaults.length > 0}
            onChange={(on) => {
              f.set("defaultAll", on);
              f.set("defaultForGroupIds", on ? x.groupIds : []);
            }}
            label={s.makeDefault}
            info={s.makeDefaultInfo}
          />
          {effectiveDefaults.length > 0 && effectiveDefaults.length < x.groupIds.length ? <p className="dash-field__hint">{s.defaultSome}</p> : null}
          {serverField("defaultForGroupIds", s.defaultTaken) ? (
            <p className="dash-field__error">
              <span>{s.defaultTaken}</span>
            </p>
          ) : null}
        </div>
        <AdvancedBox forceOpen={advancedError}>
          <div className="dash-form-grid net-fields">
            <Field label={s.connectionType} info={s.connectionInfo}>
              {(p) => (
                <Select
                  {...p}
                  value={x.mode}
                  onChange={(value) => {
                    if (value === "auto") {
                      // Back to reading the address: show the picked type's address the way it would be typed.
                      const r = resolve(x);
                      f.set("mode", "auto");
                      if (r !== null) f.set("address", printerAddressText({ kind: r.kind, address: r.address, port: r.port ?? null, queue: r.queue ?? null }));
                      return;
                    }
                    const converted = convertAddress(resolve(x), value as PrinterKind, x.address);
                    f.set("mode", value as PrinterKind);
                    f.set("address", converted.address);
                    f.set("port", converted.port);
                    f.set("queue", converted.queue);
                  }}
                  options={[
                    { value: "auto", label: s.automatic, hint: detected !== null ? detectedText(detected) : undefined },
                    ...PRINTER_KINDS.map((k) => ({ value: k, label: s.kindNames[k], hint: s.kindHelp[k] })),
                  ]}
                />
              )}
            </Field>
            {x.mode === "raw" ? (
              <Field label={s.port} hint={s.portHint} error={portErr}>
                {(p) => <Input {...p} className="dash-mono" inputMode="numeric" value={x.port} autoComplete="off" onChange={(e) => f.set("port", e.target.value)} />}
              </Field>
            ) : null}
            {x.mode === "lpr" ? (
              <Field label={s.queue} hint={s.queueHint} error={queueErr} required>
                {(p) => (
                  <Input {...p} className="dash-mono" value={x.queue} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => f.set("queue", e.target.value)} />
                )}
              </Field>
            ) : null}
            <Field label={s.driver} info={s.driverInfo} error={driverErr} className="dash-form-grid__full">
              {(p) => (
                <SearchSelect
                  {...p}
                  value={x.driver}
                  onChange={(value) => f.set("driver", value)}
                  options={driverOptions}
                  searchPlaceholder={s.driverSearch}
                  emptyText={s.driverNoneFound}
                />
              )}
            </Field>
            {x.driver === OTHER ? (
              <Field label={s.driverOtherName} hint={s.driverOtherHint} error={f.errors.otherDriver} required className="dash-form-grid__full">
                {(p) => <Input {...p} value={x.otherDriver} autoComplete="off" onChange={(e) => f.set("otherDriver", e.target.value)} />}
              </Field>
            ) : null}
          </div>
          {selectedGroups.length > 1 ? (
            <FieldSet legend={s.defaultsLegend}>
              <div className="dash-checks net-checks">
                {selectedGroups.map((g) => (
                  <Checkbox
                    key={g._id}
                    label={s.defaultIn(g.name)}
                    checked={effectiveDefaults.includes(g._id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...effectiveDefaults, g._id] : effectiveDefaults.filter((y) => y !== g._id);
                      f.set("defaultForGroupIds", next);
                      f.set("defaultAll", next.length === x.groupIds.length);
                    }}
                  />
                ))}
              </div>
            </FieldSet>
          ) : null}
        </AdvancedBox>
        <FormError
          error={f.serverError}
          onReload={onReload}
          fields={["name", "address", "port", "queue", "driver", "groupIds", "defaultForGroupIds"]}
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

/** The "Connects as" text: the kind in words, with the port or the queue when there is one. */
function detectedText(r: Resolved): string {
  if (r.kind === "raw") return s.detected.raw(r.port ?? 9100);
  if (r.kind === "lpr") return s.detected.lpr(r.queue ?? "");
  return s.detected[r.kind];
}

function ApplyCounts({ counts, hasGroups }: { counts: WifiApplyCounts; hasGroups: boolean }) {
  const items: [string, number, string][] = [
    [s.applied, counts.applied, "ok"],
    [s.failed, counts.failed, "bad"],
  ];
  return (
    <Card title={n.countsTitle} sub={n.countsSub}>
      {!hasGroups || counts.sampled === 0 ? (
        <p className="dash-muted">{hasGroups ? n.countsNone : n.noGroups}</p>
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

function DeleteCard({ d }: { d: PrinterDetail }) {
  const del = useDeletePrinter();
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
