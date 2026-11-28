import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button, InfoTip, Input, Select } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-circle-linear";
import type { EmployeeDetail as Detail } from "../../data/types";
import { ChipPicker } from "../../components/ChipPicker";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { PasswordInput } from "../../components/PasswordInput";
import { serverFieldError } from "../../components/serverField";
import { formatGb } from "../../lib/format";
import { generatePassword } from "../../lib/password";
import { employeeStrings as s } from "../../lib/screenStrings/employee";
import { employeesStrings } from "../../lib/screenStrings/employees";
import { strings } from "../../lib/strings";
import { GeneratedPassword } from "./GeneratedPassword";
import { suggestUsername, type ProfileFormState, type ProfileValues, type QuotaMode } from "./profile";

/** "Storage" in words, for the read-only profile and the Advanced line. */
function quotaWords(d: Detail): string {
  if (d.quotaGb === undefined) return `${employeesStrings.defaultQuota} (${d.defaultQuotaGb ? formatGb(d.defaultQuotaGb) : employeesStrings.unlimited})`;
  return d.quotaGb === 0 ? employeesStrings.unlimited : formatGb(d.quotaGb);
}

/** A label with its (i) and one short line, then a control that has no input of its own (the chip pickers). */
function PickerField({ label, info, hint, children }: { label: string; info?: string; hint?: string; children: (labelId: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="dash-field">
      <div className="rb-labelrow">
        <span className="dash-field__label" id={`${id}-l`}>
          {label}
        </span>
        {info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
      </div>
      {hint ? <p className="dash-field__hint">{hint}</p> : null}
      {children(`${id}-l`)}
    </div>
  );
}

export function ProfileForm({
  d,
  isNew,
  f,
  onSave,
  onReload,
}: {
  d: Detail;
  isNew?: boolean;
  f: ProfileFormState;
  onSave: (values: ProfileValues) => Promise<void>;
  onReload?: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const wantFocus = useRef(false);
  const pwLabel = useId();
  // A new employee's sign-in name follows the full name until the person changes it by hand.
  const [touched, setTouched] = useState(!isNew);
  const [editing, setEditing] = useState(false);
  const [appsOpen, setAppsOpen] = useState(f.values.appIds.length > 0);
  const [advOpen, setAdvOpen] = useState(false);

  const groupOptions = useMemo(() => d.groupOptions.map((g) => ({ value: g._id, label: g.name })), [d.groupOptions]);
  const appOptions = useMemo(
    () => d.appOptions.map((a) => ({ value: a._id, label: a.name, hint: a.kind === "desktop" ? s.desktopNote : undefined })),
    [d.appOptions],
  );

  // A wrong or taken sign-in name opens the field with the reason under it, and keeps it open while it is fixed.
  const usernameError =
    (touched || f.values.name.trim() !== "" ? f.errors.username : undefined) ?? serverFieldError(f.serverError, "username") ?? undefined;
  if (usernameError && !editing) setEditing(true);
  const quotaError = f.errors.quota;
  const mode = f.values.quotaMode;

  return (
    <Card title={s.profile} className="emp-card">
      <form
        ref={form}
        className="dash-form emp-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(onSave, form.current);
        }}
      >
        <div className="dash-form-grid">
          <Field label={s.name} error={f.errors.name} required>
            {(p) => (
              <Input
                {...p}
                value={f.values.name}
                autoComplete="off"
                onChange={(e) => {
                  f.set("name", e.target.value);
                  if (!touched) f.set("username", suggestUsername(e.target.value));
                }}
              />
            )}
          </Field>
          <Field label={s.username} info={s.usernameInfo} error={usernameError}>
            {(p) =>
              editing ? (
                <div className="emp-signin__edit">
                  <Input
                    {...p}
                    ref={(el) => {
                      if (el && wantFocus.current) {
                        wantFocus.current = false;
                        el.focus();
                      }
                    }}
                    className="dash-mono"
                    value={f.values.username}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setTouched(true);
                      f.set("username", e.target.value);
                    }}
                  />
                  <Button variant="ghost" className="dash-btn--sm" disabled={Boolean(usernameError)} onClick={() => setEditing(false)}>
                    {s.usernameDone}
                  </Button>
                </div>
              ) : (
                <div className="emp-signin">
                  <output id={p.id} className="emp-signin__value dash-mono" data-empty={f.values.username === "" || undefined}>
                    {f.values.username || s.usernameWait}
                  </output>
                  <Button
                    variant="ghost"
                    className="dash-btn--sm"
                    onClick={() => {
                      wantFocus.current = true;
                      setEditing(true);
                    }}
                  >
                    {s.change}
                  </Button>
                </div>
              )
            }
          </Field>
        </div>

        <PickerField label={s.groups} hint={s.groupsHint}>
          {(labelId) =>
            d.groupOptions.length === 0 ? (
              <p className="dash-muted emp-empty">
                {s.groupsNone}{" "}
                <Link className="dash-link" to="/groups">
                  {s.groupsCreate}
                </Link>
              </p>
            ) : (
              <ChipPicker
                label={s.groups}
                labelledBy={labelId}
                value={f.values.groupIds}
                onChange={(next) => f.set("groupIds", next)}
                options={groupOptions}
                emptyText={s.groupsEmpty}
                addLabel={s.groupsAdd}
                searchPlaceholder={s.groupsSearch}
                noMatchText={s.groupsNoMatch}
              />
            )
          }
        </PickerField>

        {appsOpen && d.appOptions.length > 0 ? (
          <PickerField label={s.apps} info={s.appsInfo}>
            {(labelId) => (
              <ChipPicker
                label={s.apps}
                labelledBy={labelId}
                value={f.values.appIds}
                onChange={(next) => f.set("appIds", next)}
                options={appOptions}
                emptyText={s.appsEmpty}
                addLabel={s.appsPick}
                searchPlaceholder={s.appsSearch}
                noMatchText={s.appsNoMatch}
              />
            )}
          </PickerField>
        ) : d.appOptions.length > 0 ? (
          <div>
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setAppsOpen(true)}>
              <IconAdd aria-hidden="true" />
              {s.appsAdd}
            </Button>
          </div>
        ) : null}

        {isNew ? (
          f.values.typed ? (
            <Field label={s.password} info={s.passwordInfo} hint={strings.validate.passwordEmployee} error={f.errors.password} required>
              {(p) => (
                <div className="emp-pwtyped">
                  <PasswordInput {...p} autoComplete="new-password" value={f.values.password} onChange={(e) => f.set("password", e.target.value)} />
                  <Button
                    variant="ghost"
                    className="dash-btn--sm"
                    onClick={() => {
                      f.set("typed", false);
                      f.set("password", generatePassword());
                    }}
                  >
                    {s.useGenerated}
                  </Button>
                </div>
              )}
            </Field>
          ) : (
            <div className="dash-field">
              <div className="rb-labelrow">
                <span className="dash-field__label" id={pwLabel}>
                  {s.password}
                </span>
                <InfoTip label={`About ${s.password}`}>{s.passwordInfo}</InfoTip>
              </div>
              <GeneratedPassword value={f.values.password} labelledBy={pwLabel} onGenerate={() => f.set("password", generatePassword())} />
              <p className="dash-field__hint">
                {s.passwordGeneratedHint}{" "}
                <button
                  type="button"
                  className="dash-link emp-linkbtn"
                  onClick={() => {
                    f.set("typed", true);
                    f.set("password", "");
                  }}
                >
                  {s.typeOwn}
                </button>
              </p>
            </div>
          )
        ) : null}

        <details
          className="dash-advanced emp-adv"
          open={advOpen || Boolean(quotaError)}
          onToggle={(e) => setAdvOpen(e.currentTarget.open)}
        >
          <summary>
            {s.advanced}
            <span className="emp-adv__now">{s.quotaNow(mode, d.defaultQuotaGb, f.values.quota)}</span>
          </summary>
          <div className="dash-advanced__body">
            <div className="dash-form-grid">
              <Field label={s.quota} info={s.quotaInfo}>
                {(p) => (
                  <Select
                    {...p}
                    value={mode}
                    onChange={(next) => f.set("quotaMode", next as QuotaMode)}
                    options={[
                      { value: "default", label: s.quotaDefault(d.defaultQuotaGb) },
                      { value: "unlimited", label: s.quotaUnlimited },
                      { value: "custom", label: s.quotaCustom },
                    ]}
                  />
                )}
              </Field>
              {mode === "custom" ? (
                <Field label={s.quotaAmount} error={quotaError} required>
                  {(p) => <Input {...p} inputMode="numeric" value={f.values.quota} onChange={(e) => f.set("quota", e.target.value)} />}
                </Field>
              ) : null}
            </div>
          </div>
        </details>

        <FormError error={f.serverError} onReload={onReload} fields={["username"]} />
        <div className="emp-bar" data-clean={!isNew && !f.dirty ? "" : undefined}>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : isNew ? s.create : strings.common.saveChanges}
          </Button>
          {isNew ? (
            <Link to="/employees" className="rb-btn rb-btn--ghost">
              {strings.common.cancel}
            </Link>
          ) : f.dirty ? (
            <span className="dash-form__status">{strings.common.unsavedHint}</span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

/** A viewer reads the same profile as text and chips. */
export function ReadOnlyProfile({ d }: { d: Detail }) {
  const groups = d.groupOptions.map((g) => ({ value: g._id, label: g.name }));
  const apps = d.appOptions.map((a) => ({ value: a._id, label: a.name }));
  return (
    <Card title={s.profile} className="emp-card">
      <dl className="dash-form-grid emp-ro">
        <div className="emp-ro__item">
          <dt>{s.name}</dt>
          <dd>{d.name}</dd>
        </div>
        <div className="emp-ro__item">
          <dt>{s.username}</dt>
          <dd className="dash-mono">{d.username}</dd>
        </div>
        <div className="emp-ro__item dash-form-grid__full">
          <dt>{s.groups}</dt>
          <dd>
            <ChipPicker label={s.groups} value={d.groupIds} onChange={() => undefined} options={groups} emptyText={strings.common.none} disabled />
          </dd>
        </div>
        {d.appIds.length > 0 ? (
          <div className="emp-ro__item dash-form-grid__full">
            <dt>{s.apps}</dt>
            <dd>
              <ChipPicker label={s.apps} value={d.appIds} onChange={() => undefined} options={apps} emptyText={strings.common.none} disabled />
            </dd>
          </div>
        ) : null}
        <div className="emp-ro__item">
          <dt>{s.quota}</dt>
          <dd>{quotaWords(d)}</dd>
        </div>
      </dl>
    </Card>
  );
}
