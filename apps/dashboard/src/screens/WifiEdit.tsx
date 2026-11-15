import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Checkbox, Input, Select, Switch } from "@rulebox/ui";
import IconKey from "~icons/solar/key-linear";
import { useDeleteWifi, useGroupsScreen, useSaveWifi, useWifiDetail } from "../data";
import type { WifiApplyCounts, WifiDetail, WifiInput, WifiSecurity } from "../data/types";
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
import { formatDate } from "../lib/format";
import { useCan } from "../lib/member";
import { strings } from "../lib/strings";
import { useToast } from "../lib/toast";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";
import { MAX_SSID_BYTES, MAX_WIFI_GROUPS, MAX_WIFI_NAME, WIFI_SECURITIES, ssidBytes, ssidProblem } from "../lib/wifiRules";
import { BLANK_WIFI } from "./networks/model";
import { PassphraseDialog } from "./networks/PassphraseDialog";
import { networksStrings as s } from "./networks/strings";

interface Values extends Record<string, unknown> {
  name: string;
  ssid: string;
  security: WifiSecurity;
  hidden: boolean;
  autoConnect: boolean;
  groupIds: string[];
}

const valuesOf = (d: WifiDetail): Values => ({
  name: d.name,
  ssid: d.ssid,
  security: d.security,
  hidden: d.hidden,
  autoConnect: d.autoConnect,
  groupIds: d.groupIds,
});

/** `networks:wifiDetail`; `/networks/wifi/new` is the same form with blank values and nothing subscribed. */
export default function WifiEdit() {
  const { id = "new" } = useParams();
  return (
    <div className="dash-page">
      {id === "new" ? <NewWifi d={BLANK_WIFI} /> : <LoadedWifi id={id} />}
    </div>
  );
}

function LoadedWifi({ id }: { id: string }) {
  const detail = useWifiDetail(id);
  return (
    <>
      {detail.status !== "ready" ? (
        <PageHeader title={detail.status === "loading" ? strings.app.loading : s.title} back={{ to: "/networks", label: s.back }} />
      ) : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
        {(d) => <ExistingWifi d={d} />}
      </QueryRegion>
    </>
  );
}

function NewWifi({ d }: { d: WifiDetail }) {
  const canAct = useCan("admin");
  const save = useSaveWifi();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <>
      <PageHeader title={s.newTitle} back={{ to: "/networks", label: s.back }} />
      {!canAct ? (
        <InlineNotice tone="neutral" title={strings.app.readOnly} />
      ) : (
        <ProfileForm
          d={d}
          isNew
          onSave={async (x) => {
            const r = await save(inputOf(x));
            toast(x.security === "open" ? s.createdOpen(x.name.trim()) : s.created(x.name.trim()));
            navigate(`/networks/wifi/${r.id}`, { replace: true });
          }}
        />
      )}
    </>
  );
}

const inputOf = (x: Values): WifiInput => ({
  name: x.name.trim(),
  ssid: x.ssid,
  hidden: x.hidden,
  security: x.security,
  autoConnect: x.autoConnect,
  groupIds: x.groupIds,
});

function ExistingWifi({ d }: { d: WifiDetail }) {
  const canAct = useCan("admin");
  const save = useSaveWifi();
  const toast = useToast();
  const [revision, setRevision] = useState(d.revision);
  const [formKey, setFormKey] = useState(0);
  const [passphraseOpen, setPassphraseOpen] = useState(false);

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
            <span className="dash-chip dash-mono">{d.ssid}</span>
            <span className="dash-chip">{s.securityShort[d.security]}</span>
            {d.hidden ? <span className="dash-chip">{s.hidden}</span> : null}
          </>
        }
      />
      {!canAct ? <InlineNotice tone="neutral" title={s.readOnly} /> : null}
      <div className="dash-grid dash-grid--main">
        <div className="dash-stack">
          {canAct ? (
            <ProfileForm
              key={formKey}
              d={d}
              onSave={async (x) => {
                const r = await save({ ...inputOf(x), id: d._id, expectedRevision: revision });
                // The revision to send next.
                setRevision(r.revision);
                toast(s.saved);
              }}
              onReload={reload}
            />
          ) : (
            <ReadOnlyProfile d={d} />
          )}
        </div>
        <div className="dash-stack">
          <Card
            title={s.passphraseCard}
            sub={s.passphraseCardSub}
            actions={
              d.security !== "open" ? (
                <RoleGate minRole="admin">
                  <Button variant="ghost" className="dash-btn--sm" onClick={() => setPassphraseOpen(true)}>
                    <IconKey aria-hidden="true" />
                    {d.hasPassphrase ? s.replacePassphrase : s.setPassphrase}
                  </Button>
                </RoleGate>
              ) : undefined
            }
          >
            {d.security === "open" ? (
              <p className="dash-muted">{s.passphraseOpen}</p>
            ) : d.hasPassphrase && d.passphraseSetAt !== null ? (
              <p>{s.passphraseSetOn(formatDate(d.passphraseSetAt))}</p>
            ) : d.hasPassphrase ? (
              <p>{s.passphraseSet}</p>
            ) : (
              <InlineNotice tone="warning" title={s.passphraseNotSet} />
            )}
            {passphraseOpen ? (
              <PassphraseDialog
                id={d._id}
                revision={revision}
                replacing={d.hasPassphrase}
                onSaved={setRevision}
                onClose={() => setPassphraseOpen(false)}
                onReload={reload}
              />
            ) : null}
          </Card>
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

function ReadOnlyProfile({ d }: { d: WifiDetail }) {
  return (
    <Card title={s.title}>
      <dl className="dash-kv">
        <div className="dash-kv__item">
          <dt>{s.name}</dt>
          <dd className="dash-wrap">{d.name}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.ssid}</dt>
          <dd className="dash-mono dash-wrap">{d.ssid}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.security}</dt>
          <dd>{s.securityNames[d.security]}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.hiddenLabel}</dt>
          <dd>{d.hidden ? strings.common.yes : strings.common.no}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.autoConnect}</dt>
          <dd>{d.autoConnect ? strings.common.yes : strings.common.no}</dd>
        </div>
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

function ProfileForm({
  d,
  isNew,
  onSave,
  onReload,
}: {
  d: WifiDetail;
  isNew?: boolean;
  onSave: (values: Values) => Promise<void>;
  onReload?: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const groups = useGroupsScreen();
  const f = useForm<Values>(valuesOf(d), (x) => {
    const ssid = ssidProblem(x.ssid);
    return {
      name: v.name(x.name, MAX_WIFI_NAME) ? s.nameProblem(MAX_WIFI_NAME) : undefined,
      ssid: ssid === null ? undefined : s.ssidProblems[ssid],
      groupIds: x.groupIds.length > MAX_WIFI_GROUPS ? s.groupsOver(MAX_WIFI_GROUPS) : undefined,
    };
  });
  const used = ssidBytes(f.values.ssid);
  const describe = (e: unknown) => {
    const a = toAppError(e);
    return a ? s.describeError(a.code, a.detail) : null;
  };
  const serverField = (field: string, text: string) => serverFieldError(f.serverError, field, () => text);

  return (
    <Card title={isNew ? s.newTitle : s.title}>
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
        <Field label={s.name} hint={s.nameHint} error={f.errors.name ?? serverField("name", s.nameProblem(MAX_WIFI_NAME))} required>
          {(p) => <Input {...p} value={f.values.name} autoComplete="off" maxLength={MAX_WIFI_NAME * 2} onChange={(e) => f.set("name", e.target.value)} />}
        </Field>
        <Field
          label={s.ssid}
          hint={
            <>
              {s.ssidHint}{" "}
              <span className={used > MAX_SSID_BYTES ? "dash-net__over" : undefined} data-testid="ssid-bytes">
                {used > MAX_SSID_BYTES ? s.ssidBytesOver(used) : s.ssidBytes(used)}
              </span>
            </>
          }
          error={f.errors.ssid ?? serverField("ssid", s.ssidServerRefused)}
          required
        >
          {(p) => (
            <Input
              {...p}
              className="dash-mono"
              value={f.values.ssid}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => f.set("ssid", e.target.value)}
            />
          )}
        </Field>
        <Field label={s.security} hint={s.securityHelp[f.values.security]}>
          {(p) => (
            <Select {...p} value={f.values.security} onChange={(e) => f.set("security", e.target.value as WifiSecurity)}>
              {WIFI_SECURITIES.map((k) => (
                <option key={k} value={k}>
                  {s.securityNames[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="dash-net__switch">
          <Switch checked={f.values.hidden} onChange={(on) => f.set("hidden", on)} label={s.hiddenLabel} />
          <span className="dash-cell-sub">{s.hiddenHint}</span>
        </div>
        <div className="dash-net__switch">
          <Switch checked={f.values.autoConnect} onChange={(on) => f.set("autoConnect", on)} label={s.autoConnect} />
          <span className="dash-cell-sub">{s.autoConnectHint}</span>
        </div>
        <FieldSet legend={s.groups} hint={s.groupsHint} error={f.errors.groupIds ?? serverField("groupIds", s.groupsServerRefused)}>
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
        {isNew && f.values.security !== "open" ? <p className="dash-muted">{s.noPassphraseInForm}</p> : null}
        <FormError error={f.serverError} onReload={onReload} fields={["name", "ssid", "groupIds"]} describe={describe} />
        <div className="dash-form__actions">
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : isNew ? s.create : strings.common.saveChanges}
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
    [s.applied, counts.applied, "ok"],
    [s.waiting, counts.waiting, "wait"],
    [s.failed, counts.failed, "bad"],
    [s.unsupported, counts.unsupported, "none"],
  ];
  return (
    <Card title={s.countsTitle} sub={s.countsSub}>
      {!hasGroups || counts.sampled === 0 ? (
        <p className="dash-muted">{hasGroups ? s.countsNone : s.noGroups}</p>
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

function DeleteCard({ d }: { d: WifiDetail }) {
  const del = useDeleteWifi();
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
          return a ? s.describeError(a.code, a.detail) : null;
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
