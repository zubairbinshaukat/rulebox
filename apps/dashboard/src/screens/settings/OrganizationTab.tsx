import { useRef, useState } from "react";
import { Button, Checkbox, Input, Pill } from "@rulebox/ui";
import { usePlan, useSettingsScreen, useUpdateSettings } from "../../data";
import type { LimitKind, PlanScreen, SettingsScreen } from "../../data/types";
import { Card } from "../../components/Card";
import { Field, FieldSet } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { serverFieldError } from "../../components/serverField";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { useCan } from "../../lib/member";
import { SkeletonBlock } from "../../components/Skeleton";
import { useToast } from "../../lib/toast";
import { strings } from "../../lib/strings";
import { useForm } from "../../lib/useForm";
import * as v from "../../lib/validate";
import { org as s, plan as planText, UNLIMITED } from "./strings";

const FIELDS = ["name", "offlineDays", "defaultQuotaGb"] as const;

/** Settings → Organization: `settings:get` (the form) and `settings:plan` (the plan panel). */
export function OrganizationTab() {
  const settings = useSettingsScreen();
  const [formKey, setFormKey] = useState(0);
  return (
    <>
      <QueryRegion state={settings} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
        {(data) => <OrgForm key={formKey} data={data} onReload={() => setFormKey((k) => k + 1)} />}
      </QueryRegion>
      <PlanCard />
    </>
  );
}

function OrgForm({ data, onReload }: { data: SettingsScreen; onReload: () => void }) {
  const canAct = useCan("admin");
  const update = useUpdateSettings();
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  // The revision this form was loaded from, then the one the server answered.
  const [revision, setRevision] = useState(data.revision);
  const f = useForm(
    {
      name: data.name,
      offlineDays: String(data.settings.offlineDays),
      defaultQuotaGb: String(data.settings.defaultQuotaGb),
      sleep: data.settings.power.sleep,
      restart: data.settings.power.restart,
      shutDown: data.settings.power.shutDown,
    },
    (x) => ({
      name: v.name(x.name, v.NAME_MAX.org) ?? undefined,
      offlineDays: v.intRange(x.offlineDays, 0, 30) ?? undefined,
      defaultQuotaGb: v.intRange(x.defaultQuotaGb, 0, 2000) ?? undefined,
    }),
  );
  const server = (field: string) => serverFieldError(f.serverError, field, () => strings.errors.invalidArgument);

  return (
    <Card title={strings.settings.tabs.organization}>
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            const r = await update({
              expectedRevision: revision,
              name: x.name.trim(),
              settings: {
                ...data.settings,
                offlineDays: Number(x.offlineDays),
                defaultQuotaGb: Number(x.defaultQuotaGb),
                power: { sleep: x.sleep, restart: x.restart, shutDown: x.shutDown },
              },
            });
            setRevision(r.revision);
            toast(r.changed.length ? s.saved : s.noChange);
          }, form.current);
        }}
      >
        {!canAct ? <InlineNotice tone="neutral" title={strings.app.readOnly} /> : null}
        <fieldset disabled={!canAct} className="dash-form" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <Field label={s.name} hint={s.nameHint} error={f.errors.name ?? server("name")} required>
            {(p) => <Input {...p} value={f.values.name} onChange={(e) => f.set("name", e.target.value)} autoComplete="organization" />}
          </Field>
          <div className="dash-form__row">
            <Field label={`${s.offlineDays} (${s.days})`} hint={s.offlineDaysHint} error={f.errors.offlineDays ?? server("offlineDays")} required>
              {(p) => <Input {...p} type="number" min={0} max={30} step={1} inputMode="numeric" value={f.values.offlineDays} onChange={(e) => f.set("offlineDays", e.target.value)} />}
            </Field>
            <Field label={s.defaultQuota} hint={s.defaultQuotaHint} error={f.errors.defaultQuotaGb ?? server("defaultQuotaGb")} required>
              {(p) => <Input {...p} type="number" min={0} max={2000} step={1} inputMode="numeric" value={f.values.defaultQuotaGb} onChange={(e) => f.set("defaultQuotaGb", e.target.value)} />}
            </Field>
          </div>
          <FieldSet legend={s.power} hint={s.powerHint}>
            <div className="dash-checks dash-checks--inline">
              <Checkbox label={s.sleep} checked={f.values.sleep} onChange={(e) => f.set("sleep", e.target.checked)} />
              <Checkbox label={s.restart} checked={f.values.restart} onChange={(e) => f.set("restart", e.target.checked)} />
              <Checkbox label={s.shutDown} checked={f.values.shutDown} onChange={(e) => f.set("shutDown", e.target.checked)} />
            </div>
          </FieldSet>
        </fieldset>
        <FormError error={f.serverError} onReload={onReload} fields={FIELDS} />
        {canAct ? (
          <div className="dash-form__actions">
            <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
              {f.pending ? strings.common.saving : strings.common.saveChanges}
            </Button>
            {f.dirty ? <span className="dash-form__status">{strings.common.unsavedHint}</span> : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}

const KINDS: readonly LimitKind[] = ["devices", "employees", "apps", "groups", "members", "enrollmentCodes"];
const LIMIT_OF: Record<LimitKind, Exclude<keyof PlanScreen["limits"], "watchMode">> = {
  devices: "maxDevices",
  employees: "maxEmployees",
  apps: "maxApps",
  groups: "maxGroups",
  members: "maxMembers",
  enrollmentCodes: "maxEnrollmentCodesActive",
};

/** The plan and its usage. No upgrade button and no payment UI: "Contact us to upgrade." */
function PlanCard() {
  const plan = usePlan();
  return (
    <Card title={planText.title}>
      <QueryRegion state={plan} skeleton={<SkeletonBlock lines={4} />}>
        {(d) => {
          const limitOf = (k: LimitKind) => d.limits[LIMIT_OF[k]];
          // The headline names what most people hit first: PCs and groups.
          const headline = planText.headline(
            d.plan,
            (["devices", "groups"] as const).filter((k) => limitOf(k) < UNLIMITED).map((k) => planText.of(k, d.usage[k], limitOf(k))),
          );
          return (
            <div className="dash-stack">
              <p className="dash-row">
                <strong>{headline}</strong>
                {d.status !== "active" ? <Pill tone="danger">{planText.status[d.status]}</Pill> : null}
              </p>
              {d.status !== "active" ? <InlineNotice tone="danger" title={planText.suspended} /> : null}
              <dl className="dash-kv">
                {KINDS.map((k) => {
                  const limit = limitOf(k);
                  const full = limit < UNLIMITED && d.usage[k] >= limit;
                  return (
                    <div key={k} className="dash-kv__item">
                      <dt>{planText.kinds[k]}</dt>
                      <dd className="dash-row">
                        <span>{limit < UNLIMITED ? planText.of(k, d.usage[k], limit) : `${planText.of(k, d.usage[k], limit)} · ${planText.noLimit}`}</span>
                        {full ? <Pill tone="warning">{planText.reached}</Pill> : null}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <p className="dash-muted">
                {planText.auditDays(d.limits.auditRetentionDays)}
                {d.plan !== "custom" ? ` ${planText.contact}` : null}
              </p>
            </div>
          );
        }}
      </QueryRegion>
    </Card>
  );
}
