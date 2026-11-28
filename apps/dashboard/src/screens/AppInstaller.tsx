import { Button, InfoTip, Input, Select, Switch } from "@rulebox/ui";
import { INSTALL_TECHS, type InstallerInspection, type WizardTech } from "../data/types";
import { Field } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { appInstallerStrings as s } from "../lib/screenStrings/appInstaller";
import { appEditStrings } from "../lib/screenStrings/appEdit";
import type { PrefillKey } from "../lib/apps/installerPrefill";
import type { FormApi } from "./apps/appForm";

// The install command of a Windows program (Phase 6 Step 13, plan 4.7), as the "Install command" group inside Advanced (UI pass): the
// silent switches, the installer type, success codes, timeout, expected signer, answer file and MSI product code. Rulebox fills them in
// by itself from the installer type (see `apps/desktop/useInstallerCheck`); this is where a person who knows better changes them. One lazy
// chunk. Nothing here saves anything, and a detection never overwrites text the admin typed.

/** What the last check said, kept by the page so the add flow and the fields beside it agree. */
export interface InspectState {
  result: InstallerInspection | null;
  from: "url" | "file" | null;
  /** Fields that had the admin's own text and were left alone. */
  kept: PrefillKey[];
  /** What was filled in, for the "edited" mark: a field is "edited" when it no longer says this. */
  prefilled: { silentArgs?: string; successCodes?: string };
  /** One line about the SHA-256 of a local file. */
  note: string | null;
}

const edited = <span className="dash-field__optional"> ({s.edited})</span>;

/**
 * The fields of an MSI or EXE installer. `automatic` is what Rulebox would use by itself (the detection's or the stored technology's
 * switches): a person's own text gets the "(edited)" mark and a "Use automatic" button.
 */
export function InstallCommand({
  f,
  state,
  automatic,
  readOnly,
}: {
  f: FormApi;
  state: InspectState;
  automatic: { silentArgs: string; successCodes: string };
  readOnly: boolean;
}) {
  const x = f.values;
  const exe = x.source === "exe";
  const text = (key: string, value: string) => f.set(key as never, value as never);
  const argsEdited = x.silentArgs.trim().replace(/\s+/g, " ") !== automatic.silentArgs.trim().replace(/\s+/g, " ") && x.silentArgs.trim() !== "";
  const codesEdited = x.successCodes.trim() !== "" && x.successCodes.replace(/\s+/g, "") !== automatic.successCodes.replace(/\s+/g, "");
  const signer = state.result?.signer;
  return (
    <div className="dash-form-grid apps-command">
      {exe ? (
        <div className="dash-form-grid__full">
          <Field label={<>{s.silentArgs}{argsEdited ? edited : null}</>} infoLabel={`About ${s.silentArgs}`} info={s.info.silentArgs} error={f.errors.silentArgs} required>
            {(p) => (
              <div className="apps-check__row">
                <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" value={x.silentArgs} disabled={readOnly} onChange={(e) => text("silentArgs", e.target.value)} />
                {argsEdited && !readOnly ? (
                  <Button type="button" variant="ghost" className="dash-btn--sm" onClick={() => text("silentArgs", automatic.silentArgs)}>
                    {s.useAutomatic}
                  </Button>
                ) : null}
              </div>
            )}
          </Field>
        </div>
      ) : null}
      {exe ? (
        <Field label={s.tech} info={s.info.tech}>
          {(p) => (
            <Select
              {...p}
              value={x.tech}
              disabled={readOnly}
              onChange={(next) => f.set("tech", next as WizardTech | "")}
              options={[{ value: "", label: s.techNone }, ...INSTALL_TECHS.map((t) => ({ value: t, label: s.techOptions[t] }))]}
            />
          )}
        </Field>
      ) : null}
      {exe ? (
        <Field label={<>{s.successCodes}{codesEdited ? edited : null}</>} infoLabel={`About ${s.successCodes}`} info={s.info.successCodes} error={f.errors.successCodes} optional>
          {(p) => <Input {...p} className="dash-mono" spellCheck={false} inputMode="numeric" value={x.successCodes} disabled={readOnly} onChange={(e) => text("successCodes", e.target.value)} />}
        </Field>
      ) : null}
      <Field label={s.timeout} info={s.info.timeout} error={f.errors.timeoutMin} optional>
        {(p) => <Input {...p} className="dash-mono" inputMode="numeric" placeholder="30" maxLength={3} value={x.timeoutMin} disabled={readOnly} onChange={(e) => text("timeoutMin", e.target.value)} />}
      </Field>
      <Field label={s.publisher} info={s.info.publisher} error={f.errors.installPublisher} optional>
        {(p) => (
          <div className="apps-check__row">
            <Input {...p} spellCheck={false} autoComplete="off" maxLength={200} value={x.installPublisher} disabled={readOnly} onChange={(e) => text("installPublisher", e.target.value)} />
            {signer !== undefined && x.installPublisher.trim() === "" && !readOnly ? (
              <Button type="button" variant="ghost" className="dash-btn--sm" onClick={() => text("installPublisher", signer)}>
                {s.useSigner(signer)}
              </Button>
            ) : null}
          </div>
        )}
      </Field>
      {x.source === "msi" ? (
        <Field label={appEditStrings.productCode} info={s.info.productCode} error={f.errors.productCode} optional>
          {(p) => <Input {...p} className="dash-mono" spellCheck={false} placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}" value={x.productCode} disabled={readOnly} onChange={(e) => text("productCode", e.target.value)} />}
        </Field>
      ) : null}

      {exe ? (
        <div className="dash-form-grid__full apps-command__answer">
          <div className="rb-labelrow">
            <Switch checked={x.answerOn} onChange={(val) => f.set("answerOn", val)} label={s.answerOn} disabled={readOnly} />
            <InfoTip label={`About ${s.answerOn}`}>{s.info.answer}</InfoTip>
          </div>
          {x.tech === "installshield_script" && !x.answerOn ? <InlineNotice tone="warning" title={s.answerNeeded} /> : null}
          {x.answerOn ? (
            <div className="dash-form-grid">
              <Field label={s.answerUrl} info={s.answerUrlHint} error={f.errors.answerUrl} required>
                {(p) => <Input {...p} type="url" inputMode="url" spellCheck={false} autoCapitalize="off" placeholder="https://" value={x.answerUrl} disabled={readOnly} onChange={(e) => text("answerUrl", e.target.value)} />}
              </Field>
              <Field label={s.answerSha} error={f.errors.answerSha256} required>
                {(p) => <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={80} value={x.answerSha256} disabled={readOnly} onChange={(e) => text("answerSha256", e.target.value)} />}
              </Field>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
