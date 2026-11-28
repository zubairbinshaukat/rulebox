import { useRef, useState } from "react";
import { Button, Checkbox, Input, InfoTip, Pill, Select } from "@rulebox/ui";
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
import { presetOptions } from "./presets";
import { OFFLINE_PRESETS, org as s, plan as planText, QUOTA_PRESETS, UNLIMITED } from "./strings";

const FIELDS = ["name", "offlineDays", "defaultQuotaGb"] as const;

/** Settings → General: `settings:get` (the form) and `settings:plan` (the plan panel), side by side from the laptop width up. */
export function OrganizationTab() {
  const settings = useSettingsScreen();
  const canAct = useCan("admin");
  const [formKey, setFormKey] = useState(0);
  return (
    <>
      {!canAct ? <InlineNotice tone="neutral" title={strings.app.readOnly} /> : null}
      <div className="set-general">
        <QueryRegion state={settings} skeleton={<div className="dash-card dash-card--pad set-general__sk"><SkeletonBlock lines={6} /></div>}>
          {(data) => <OrgForm key={formKey} data={data} onReload={() => setFormKey((k) => k + 1)} />}
        </QueryRegion>
        <PlanCard />
      </div>
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
  // The options come from the loaded value, so a stored 15 days stays an option after the form changed it.
  const [offlineOptions] = useState(() => presetOptions(OFFLINE_PRESETS, data.settings.offlineDays, s.days));
  const [quotaOptions] = useState(() => presetOptions(QUOTA_PRESETS, data.settings.defaultQuotaGb, s.gb));

  return (
    <form
      ref={form}
      className="set-general__form"
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
      <Card level={3} title={s.orgCard} className="set-general__name">
        <fieldset disabled={!canAct} className="set-fs">
          <Field label={s.name} info={s.nameInfo} error={f.errors.name ?? server("name")} required>
            {(p) => <Input {...p} value={f.values.name} onChange={(e) => f.set("name", e.target.value)} autoComplete="organization" />}
          </Field>
        </fieldset>
      </Card>

      <Card level={3} title={s.pcsCard} className="set-general__pcs">
        <fieldset disabled={!canAct} className="set-fs set-fs--stack">
          <div className="set-fields">
            <Field label={s.offlineDays} info={s.offlineInfo} error={f.errors.offlineDays ?? server("offlineDays")} required>
              {(p) => <Select {...p} value={f.values.offlineDays} onChange={(val) => f.set("offlineDays", val)} options={offlineOptions} />}
            </Field>
            <Field label={s.defaultQuota} info={s.quotaInfo} error={f.errors.defaultQuotaGb ?? server("defaultQuotaGb")} required>
              {(p) => <Select {...p} value={f.values.defaultQuotaGb} onChange={(val) => f.set("defaultQuotaGb", val)} options={quotaOptions} />}
            </Field>
          </div>
          <FieldSet legend={s.power} info={s.powerInfo}>
            <div className="dash-checks dash-checks--inline">
              <Checkbox label={s.sleep} checked={f.values.sleep} onChange={(e) => f.set("sleep", e.target.checked)} />
              <Checkbox label={s.restart} checked={f.values.restart} onChange={(e) => f.set("restart", e.target.checked)} />
              <Checkbox label={s.shutDown} checked={f.values.shutDown} onChange={(e) => f.set("shutDown", e.target.checked)} />
            </div>
          </FieldSet>
        </fieldset>
      </Card>

      <div className="set-save" data-dirty={f.dirty || undefined}>
        <FormError error={f.serverError} onReload={onReload} fields={FIELDS} />
        {canAct ? (
          <div className="set-save__row">
            <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
              {f.pending ? strings.common.saving : strings.common.saveChanges}
            </Button>
            {f.dirty ? <span className="dash-form__status">{strings.common.unsavedHint}</span> : null}
          </div>
        ) : null}
      </div>
    </form>
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

/** The plan and its usage. No upgrade button and no payment UI: "Contact us to upgrade." shows only when a limit is reached. */
function PlanCard() {
  const plan = usePlan();
  return (
    <QueryRegion state={plan} skeleton={<div className="dash-card dash-card--pad set-general__plan"><SkeletonBlock lines={5} /></div>}>
      {(d) => {
        const limitOf = (k: LimitKind) => d.limits[LIMIT_OF[k]];
        // The headline names what most people hit first: PCs and groups.
        const headline = planText.headline(
          d.plan,
          (["devices", "groups"] as const).filter((k) => limitOf(k) < UNLIMITED).map((k) => planText.of(k, d.usage[k], limitOf(k))),
        );
        const anyFull = KINDS.some((k) => limitOf(k) < UNLIMITED && d.usage[k] >= limitOf(k));
        return (
          <Card
            level={3}
            title={planText.title}
            className="set-general__plan"
            actions={
              <InfoTip label={planText.infoLabel} placement="bottom">
                {planText.info} {planText.auditDays(d.limits.auditRetentionDays)}
              </InfoTip>
            }
          >
            <div className="set-plan">
              <p className="set-plan__headline">
                <strong>{headline}</strong>
                {d.status !== "active" ? <Pill tone="danger">{planText.status[d.status]}</Pill> : null}
              </p>
              {d.status !== "active" ? <InlineNotice tone="danger" title={planText.suspended} /> : null}
              <dl className="set-usage">
                {KINDS.map((k) => {
                  const limit = limitOf(k);
                  const limited = limit < UNLIMITED;
                  const full = limited && d.usage[k] >= limit;
                  const fill = limited ? Math.min(100, Math.round((d.usage[k] / Math.max(1, limit)) * 100)) : 0;
                  return (
                    <div key={k} className="set-usage__row" data-full={full || undefined}>
                      <dt>{planText.kinds[k]}</dt>
                      <dd>
                        <span className="set-usage__value">{planText.rowValue(d.usage[k], limit)}</span>
                        {!limited ? <span className="set-usage__note">{planText.noLimit}</span> : null}
                      </dd>
                      {limited ? (
                        <span className="set-meter" aria-hidden="true">
                          <span style={{ width: `${fill}%` }} />
                        </span>
                      ) : null}
                      {full ? <Pill tone="warning" className="set-usage__flag">{planText.reached}</Pill> : null}
                    </div>
                  );
                })}
              </dl>
              {d.plan !== "custom" && (anyFull || d.status !== "active") ? <p className="dash-muted">{planText.contact}</p> : null}
            </div>
          </Card>
        );
      }}
    </QueryRegion>
  );
}
