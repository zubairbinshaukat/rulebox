import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Checkbox, Input, InfoTip, Pill, Select } from "@rulebox/ui";
import IconLock from "~icons/solar/lock-keyhole-minimalistic-linear";
import IconDanger from "~icons/solar/danger-triangle-linear";
import { useCreateWifiWithPassphrase, useDeleteWifi, useGroupsScreen, useSaveWifi, useSetWifiPassphrase, useWifiDetail } from "../data";
import type { WifiApplyCounts, WifiDetail, WifiInput, WifiSecurity } from "../data/types";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { HistoryPanel } from "../components/HistoryPanel";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { PasswordInput } from "../components/PasswordInput";
import { QueryRegion } from "../components/Region";
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
import { MAX_SSID_BYTES, MAX_WIFI_GROUPS, MAX_WIFI_NAME, defaultWifiName, passphraseProblem, showSsidCounter, ssidBytes, ssidProblem } from "../lib/wifiRules";
import { BLANK_WIFI, sameGroups } from "./networks/model";
import { AdvancedBox, GroupPicker, HowCard, SwitchRow } from "./networks/parts";
import { networksStrings as n } from "./networks/strings";
import { wifiStrings as s } from "./networks/wifiStrings";
import "./networks/networks.css";

type Secured = Exclude<WifiSecurity, "open">;

interface Values extends Record<string, unknown> {
  ssid: string;
  /** The name in Rulebox. Until `nameEdited`, it is the Wi-Fi name (trimmed): it follows the field above. */
  name: string;
  nameEdited: boolean;
  password: string;
  /** Edit: the saved password's "Change" was pressed, so the field shows. */
  changePassword: boolean;
  /** "This network has no password". */
  open: boolean;
  /** The kind of password security; an open network keeps the last one so un-ticking the box restores it. */
  security: Secured;
  hidden: boolean;
  autoConnect: boolean;
  groupIds: string[];
}

const RECOMMENDED: Secured = "wpa2Wpa3Personal";

const valuesOf = (d: WifiDetail): Values => ({
  ssid: d.ssid,
  name: d.name,
  nameEdited: d.name !== "",
  password: "",
  changePassword: false,
  open: d.security === "open",
  security: d.security === "open" ? RECOMMENDED : d.security,
  hidden: d.hidden,
  autoConnect: d.autoConnect,
  groupIds: d.groupIds,
});

/** The name Rulebox uses: what was typed, else the Wi-Fi name. */
const effectiveName = (x: Values): string => (x.nameEdited ? x.name.trim() : defaultWifiName(x.ssid));

const inputOf = (x: Values): WifiInput => ({
  name: effectiveName(x),
  ssid: x.ssid,
  hidden: x.hidden,
  security: x.open ? "open" : x.security,
  autoConnect: x.autoConnect,
  groupIds: x.groupIds,
});

/** True when anything but the password differs from what was last saved. */
function profileChanged(a: Values, b: Values): boolean {
  return (
    a.ssid !== b.ssid ||
    effectiveName(a) !== effectiveName(b) ||
    a.open !== b.open ||
    (!b.open && a.security !== b.security) ||
    a.hidden !== b.hidden ||
    a.autoConnect !== b.autoConnect ||
    !sameGroups(a.groupIds, b.groupIds)
  );
}

/** `networks:wifiDetail`; `/networks/wifi/new` is the same form with blank values and nothing subscribed. */
export default function WifiEdit() {
  const { id = "new" } = useParams();
  return <div className="dash-page net-page">{id === "new" ? <NewWifi d={BLANK_WIFI} /> : <LoadedWifi id={id} />}</div>;
}

function LoadedWifi({ id }: { id: string }) {
  const detail = useWifiDetail(id);
  return (
    <>
      {detail.status !== "ready" ? (
        <PageHeader title={detail.status === "loading" ? strings.app.loading : s.title} back={{ to: "/networks", label: n.back }} />
      ) : null}
      <QueryRegion state={detail} skeleton={<div className="dash-card dash-card--pad" aria-label={s.loading}><SkeletonBlock lines={6} /></div>}>
        {(d) => <ExistingWifi d={d} />}
      </QueryRegion>
    </>
  );
}

function NewWifi({ d }: { d: WifiDetail }) {
  const canAct = useCan("admin");
  const save = useSaveWifi();
  const createSecured = useCreateWifiWithPassphrase();
  const navigate = useNavigate();
  const toast = useToast();
  const how = (
    <>
      {s.how1} {s.how2} {s.how3}
    </>
  );
  return (
    <>
      <PageHeader
        title={s.newTitle}
        back={{ to: "/networks", label: n.back }}
        meta={
          <span className="net-howinfo">
            {s.howTitle}
            <InfoTip label={`About ${s.howTitle}`}>{how}</InfoTip>
          </span>
        }
      />
      {!canAct ? (
        <InlineNotice tone="neutral" title={strings.app.readOnly} />
      ) : (
        <div className="dash-split">
          <div className="dash-split__main net-formcol">
            <ProfileForm
              d={d}
              isNew
              onSave={async (x) => {
                // A secured network goes up with its password in ONE call (one version for the PCs); an open one has no password.
                const r = x.open ? await save(inputOf(x)) : await createSecured({ ...inputOf(x), passphrase: x.password });
                toast(s.created(effectiveName(x)));
                navigate(`/networks/wifi/${r.id}`, { replace: true });
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

function ExistingWifi({ d }: { d: WifiDetail }) {
  const canAct = useCan("admin");
  const save = useSaveWifi();
  const setPassphrase = useSetWifiPassphrase();
  const toast = useToast();
  const [formKey, setFormKey] = useState(0);
  // The revision to send next, and what was last saved (so a retry after a failed password does not save the profile twice).
  const revision = useRef(d.revision);
  const saved = useRef<Values>(valuesOf(d));

  const reload = () => {
    revision.current = d.revision;
    saved.current = valuesOf(d);
    setFormKey((k) => k + 1);
  };

  const showSsid = d.ssid !== d.name;
  return (
    <>
      <PageHeader
        back={{ to: "/networks", label: n.back }}
        title={<span className="dash-wrap">{d.name}</span>}
        meta={
          <>
            {d.security === "open" ? (
              <Pill>{n.openNetwork}</Pill>
            ) : d.hasPassphrase ? (
              <Pill tone="success" dot>
                {n.passwordSet}
              </Pill>
            ) : (
              <Pill tone="warning" dot>
                {n.needsPassword}
              </Pill>
            )}
            {showSsid ? <span className="dash-chip dash-mono">{d.ssid}</span> : null}
            {d.hidden ? <span className="dash-chip">{n.hidden}</span> : null}
          </>
        }
      />
      {!canAct ? <InlineNotice tone="neutral" title={n.readOnly} /> : null}
      <div className="dash-split">
        <div className="dash-split__main net-formcol">
          {canAct ? (
            <ProfileForm
              key={formKey}
              d={d}
              onSave={async (x) => {
                const typed = !x.open && x.password !== "";
                const changed = profileChanged(x, saved.current);
                if (changed || !typed) {
                  const r = await save({ ...inputOf(x), id: d._id, expectedRevision: revision.current });
                  revision.current = r.revision;
                  saved.current = x;
                }
                if (typed) {
                  try {
                    const r = await setPassphrase({ id: d._id, passphrase: x.password, expectedRevision: revision.current });
                    revision.current = r.revision;
                  } catch (e) {
                    if (changed) toast(s.savedNoPassword);
                    throw e;
                  }
                }
                toast(s.saved);
              }}
              onReload={reload}
            />
          ) : (
            <ReadOnlyProfile d={d} />
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

function ReadOnlyProfile({ d }: { d: WifiDetail }) {
  return (
    <Card title={s.title}>
      <dl className="dash-kv">
        <div className="dash-kv__item">
          <dt>{s.readName}</dt>
          <dd className="dash-wrap">{d.name}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.ssid}</dt>
          <dd className="dash-wrap">{d.ssid}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readSecurity}</dt>
          <dd>{s.securityNames[d.security]}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readPassword}</dt>
          <dd>{d.security === "open" ? n.openNetwork : d.hasPassphrase && d.passphraseSetAt !== null ? s.passwordSetOn(formatDate(d.passphraseSetAt)) : d.hasPassphrase ? n.passwordSet : n.needsPassword}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.readHidden}</dt>
          <dd>{d.hidden ? strings.common.yes : strings.common.no}</dd>
        </div>
        <div className="dash-kv__item">
          <dt>{s.autoConnect}</dt>
          <dd>{d.autoConnect ? strings.common.yes : strings.common.no}</dd>
        </div>
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
  /** A password must be typed: a new secured network, or an existing one that has none (or was open until now). */
  const passwordRequired = (x: Values) => !x.open && (isNew === true || !d.hasPassphrase || d.security === "open");
  const f = useForm<Values>(valuesOf(d), (x) => {
    const ssid = ssidProblem(x.ssid);
    const pw = x.open ? null : x.password === "" ? (passwordRequired(x) ? "empty" : null) : passphraseProblem(x.password);
    return {
      name: v.name(effectiveName(x), MAX_WIFI_NAME) ? n.nameProblem(MAX_WIFI_NAME) : undefined,
      ssid: ssid === null ? undefined : s.ssidProblems[ssid],
      password: pw === null ? undefined : s.passphraseProblems[pw],
      groupIds: x.groupIds.length > MAX_WIFI_GROUPS ? n.groupsOver(MAX_WIFI_GROUPS) : undefined,
    };
  });
  const x = f.values;
  const used = ssidBytes(x.ssid);
  const describe = (e: unknown) => {
    const a = toAppError(e);
    return a ? n.describeError(a.code, a.detail) : null;
  };
  const serverField = (field: string, text: string) => serverFieldError(f.serverError, field, () => text);
  const nameError = f.errors.name ?? serverField("name", n.nameProblem(MAX_WIFI_NAME));
  const passwordError = f.errors.password ?? serverField("passphrase", s.passphraseServerRefused);
  const hasSaved = !isNew && d.security !== "open" && d.hasPassphrase;
  const showPasswordField = !x.open && (!hasSaved || x.changePassword);
  const nameShown = x.nameEdited ? x.name : x.ssid.trim() === "" ? "" : defaultWifiName(x.ssid);

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
            // Saved: the typed password is gone from the form (it only ever lived here).
            if (!isNew) f.reset({ ...values, password: "", changePassword: false });
          }, form.current);
        }}
      >
        <div className="dash-form-grid net-fields">
          <Field
            label={s.ssid}
            info={s.ssidInfo}
            hint={
              showSsidCounter(x.ssid) ? (
                <span className={used > MAX_SSID_BYTES ? "dash-net__over" : undefined} data-testid="ssid-bytes">
                  {used > MAX_SSID_BYTES ? s.ssidBytesOver(used) : s.ssidBytes(used)}
                </span>
              ) : undefined
            }
            error={f.errors.ssid ?? serverField("ssid", s.ssidServerRefused)}
            required
          >
            {(p) => (
              <Input
                {...p}
                value={x.ssid}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus={isNew}
                onChange={(e) => f.set("ssid", e.target.value)}
              />
            )}
          </Field>
          <div className="dash-stack" style={{ gap: 10 }}>
            {showPasswordField ? (
              <Field
                label={s.password}
                info={s.passwordInfo}
                hint={!isNew && hasSaved ? s.keepEmpty : undefined}
                error={passwordError}
                required={passwordRequired(x)}
              >
                {(p) => (
                  <PasswordInput
                    {...p}
                    autoComplete="new-password"
                    autoCorrect="off"
                    data-lpignore="true"
                    autoFocus={!isNew && x.changePassword}
                    value={x.password}
                    onChange={(e) => f.set("password", e.target.value)}
                  />
                )}
              </Field>
            ) : hasSaved && !x.open ? (
              <div className="dash-field">
                <span className="dash-field__label">{s.password}</span>
                <div className="net-pass">
                  <IconLock aria-hidden="true" className="net-pass__lock" />
                  <p className="net-pass__text">{d.passphraseSetAt !== null ? s.passwordSetOn(formatDate(d.passphraseSetAt)) : s.passwordIsSet}</p>
                  <Button type="button" variant="ghost" className="dash-btn--sm" onClick={() => f.set("changePassword", true)}>
                    {s.change}
                  </Button>
                </div>
              </div>
            ) : null}
            {!isNew && !x.open && !hasSaved ? (
              <p className="net-pass__note">
                <IconDanger aria-hidden="true" />
                {s.passwordMissing}
              </p>
            ) : null}
            <Checkbox
              label={s.openNetwork}
              checked={x.open}
              onChange={(e) => {
                f.set("open", e.target.checked);
                if (e.target.checked) f.set("password", "");
              }}
            />
            {x.open ? <p className="dash-field__hint">{s.openInfo}</p> : null}
            {x.open && hasSaved ? <p className="dash-field__hint">{s.openDeletes}</p> : null}
          </div>
        </div>
        <GroupPicker
          groups={groups}
          autoPick={isNew}
          selected={x.groupIds}
          onChange={(ids) => f.set("groupIds", ids)}
          error={f.errors.groupIds ?? serverField("groupIds", n.groupsServerRefused)}
        />
        <AdvancedBox forceOpen={nameError !== undefined && nameError !== null}>
          <div className="dash-form-grid net-fields">
            <Field label={s.nameInRulebox} info={s.nameInfo} error={nameError}>
              {(p) => (
                <Input
                  {...p}
                  value={nameShown}
                  autoComplete="off"
                  maxLength={MAX_WIFI_NAME * 2}
                  onChange={(e) => {
                    f.set("name", e.target.value);
                    f.set("nameEdited", true);
                  }}
                />
              )}
            </Field>
            <Field label={s.securityType} info={s.securityInfo}>
              {(p) => (
                <Select
                  {...p}
                  value={x.security}
                  disabled={x.open}
                  onChange={(value) => f.set("security", value as Secured)}
                  options={(["wpa2Wpa3Personal", "wpa2Personal", "wpa3Personal"] as const).map((k) => ({ value: k, label: s.securityNames[k], hint: s.securityHint[k] }))}
                />
              )}
            </Field>
          </div>
          <SwitchRow checked={x.hidden} onChange={(on) => f.set("hidden", on)} label={s.hiddenLabel} info={s.hiddenInfo} />
          <SwitchRow checked={x.autoConnect} onChange={(on) => f.set("autoConnect", on)} label={s.autoConnect} info={s.autoConnectInfo} />
        </AdvancedBox>
        <FormError error={f.serverError} onReload={onReload} fields={["name", "ssid", "groupIds", "passphrase"]} describe={describe} />
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

function ApplyCounts({ counts, hasGroups }: { counts: WifiApplyCounts; hasGroups: boolean }) {
  const items: [string, number, string][] = [
    [s.applied, counts.applied, "ok"],
    [s.waiting, counts.waiting, "wait"],
    [s.failed, counts.failed, "bad"],
    [s.unsupported, counts.unsupported, "none"],
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
