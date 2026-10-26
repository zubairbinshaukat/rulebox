import { useRef, useState } from "react";
import { Button, Checkbox, Input } from "@rulebox/ui";
import { useSettingsScreen, useUpdateSettings } from "../../data";
import type { SettingsScreen } from "../../data/types";
import { Card } from "../../components/Card";
import { Field, FieldSet } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { useCan } from "../../lib/member";
import { SkeletonBlock } from "../../components/Skeleton";
import { useToast } from "../../lib/toast";
import { strings } from "../../lib/strings";
import { useForm } from "../../lib/useForm";
import * as v from "../../lib/validate";

const s = strings.settings.org;

export function OrganizationTab() {
  const settings = useSettingsScreen();
  const [formKey, setFormKey] = useState(0);
  return (
    <QueryRegion state={settings} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
      {(data) => <OrgForm key={formKey} data={data} onReload={() => setFormKey((k) => k + 1)} />}
    </QueryRegion>
  );
}

function OrgForm({ data, onReload }: { data: SettingsScreen; onReload: () => void }) {
  const canAct = useCan("admin");
  const update = useUpdateSettings();
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
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

  return (
    <Card title={strings.settings.tabs.organization}>
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            await update({
              expectedRevision: revision,
              name: x.name.trim(),
              settings: {
                ...data.settings,
                offlineDays: Number(x.offlineDays),
                defaultQuotaGb: Number(x.defaultQuotaGb),
                power: { sleep: x.sleep, restart: x.restart, shutDown: x.shutDown },
              },
            });
            setRevision((r) => r + 1);
            toast(s.saved);
          }, form.current);
        }}
      >
        {!canAct ? <InlineNotice tone="neutral" title={strings.app.readOnly} /> : null}
        <fieldset disabled={!canAct} className="dash-form" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <Field label={s.name} hint={s.nameHint} error={f.errors.name} required>
            {(p) => <Input {...p} value={f.values.name} onChange={(e) => f.set("name", e.target.value)} autoComplete="organization" />}
          </Field>
          <div className="dash-form__row">
            <Field label={`${s.offlineDays} (${s.days})`} hint={s.offlineDaysHint} error={f.errors.offlineDays} required>
              {(p) => <Input {...p} type="number" min={0} max={30} inputMode="numeric" value={f.values.offlineDays} onChange={(e) => f.set("offlineDays", e.target.value)} />}
            </Field>
            <Field label={s.defaultQuota} hint={s.defaultQuotaHint} error={f.errors.defaultQuotaGb} required>
              {(p) => <Input {...p} type="number" min={0} max={2000} inputMode="numeric" value={f.values.defaultQuotaGb} onChange={(e) => f.set("defaultQuotaGb", e.target.value)} />}
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
        <FormError error={f.serverError} onReload={onReload} />
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
