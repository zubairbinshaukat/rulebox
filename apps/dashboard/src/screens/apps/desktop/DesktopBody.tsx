import { Input } from "@rulebox/ui";
import { Field } from "../../../components/Field";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appEditStrings } from "../../../lib/screenStrings/appEdit";
import * as u from "../../../lib/apps/updateRules";
import { BrowserRulesCard } from "../../AppBrowser";
import type { FormApi } from "../appForm";
import { DesktopAdvanced } from "./DesktopAdvanced";
import { DesktopMore } from "./DesktopMore";
import { InstallLines, SilentBlock } from "./InstallLines";
import { useDisclosures } from "./disclosures";
import { companyFolder, linesOf } from "./model";
import { ProgramPathInput } from "./ProgramPathInput";
import type { InstallerCheck } from "./useInstallerCheck";

const t = appAddStrings;

/**
 * The body of a Windows app's form, the same on the add page and on the Details tab: the name, how it installs (status lines), the
 * program to start, "More options" and "Advanced". The page decides what wraps it (a card and the Add bar, or the save bar).
 */
export function DesktopBody({
  f,
  check,
  readOnly,
  isNew,
  appKey,
  disclosures,
  onVersion,
  nameFirst = true,
}: {
  f: FormApi;
  check: InstallerCheck;
  readOnly: boolean;
  isNew: boolean;
  appKey: string;
  disclosures: ReturnType<typeof useDisclosures>;
  onVersion?: () => void;
  nameFirst?: boolean;
}) {
  const x = f.values;
  const { silent, lines } = linesOf(x, check.inspect.result);
  const browser = u.browserAppOf(x.exe) !== null;
  const removable = x.source === "msi" || x.source === "portable" || (x.source === "winget" && x.resolved?.install.kind === "msi");
  const company = companyFolder(check.inspect.result?.companyName ?? x.resolved?.publisher);
  return (
    <div className="dash-form apps-body">
      {nameFirst ? (
        <div className={isNew ? undefined : "dash-form-grid"}>
          <Field label={appEditStrings.name} info={t.review.nameInfo} error={f.errors.name} required>
            {(p) => <Input {...p} autoComplete="off" value={x.name} disabled={readOnly} onChange={(e) => f.set("name", e.target.value)} />}
          </Field>
          {!isNew ? (
            <Field label={appEditStrings.description} info={appEditStrings.info.description} error={f.errors.description} optional>
              {(p) => <Input {...p} autoComplete="off" value={x.description} disabled={readOnly} onChange={(e) => f.set("description", e.target.value)} />}
            </Field>
          ) : null}
        </div>
      ) : null}

      <InstallLines lines={lines} onVersion={onVersion} />
      <SilentBlock
        silent={silent}
        readOnly={readOnly}
        onOpenAdvanced={() => disclosures.setAdvanced(true)}
        onPickSwitch={(sw) => {
          f.set("silentArgs", sw);
          disclosures.setAdvanced(true);
        }}
      />

      {x.source !== "portable" ? (
        <ProgramPathInput
          value={x.exe}
          onChange={(next) => f.set("exe", next)}
          error={f.errors.exe}
          disabled={readOnly}
          hint={company !== null ? t.program.usually(company) : undefined}
        />
      ) : null}

      {browser ? <BrowserRulesCard f={f} /> : null}

      <DesktopMore
        f={f}
        readOnly={readOnly}
        open={disclosures.more}
        onOpen={disclosures.setMore}
        uninstall={removable}
        updates={isNew}
        browser={browser}
        appKey={appKey}
      />
      <DesktopAdvanced f={f} check={check} readOnly={readOnly} open={disclosures.advanced} onOpen={disclosures.setAdvanced} linkHere={!isNew} />
    </div>
  );
}
