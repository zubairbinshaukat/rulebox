import type { ReactNode } from "react";
import { InfoTip, Input, SegmentedControl, Switch } from "@rulebox/ui";
import type { UpdateMode } from "../../../data/types";
import { Field, FieldSet } from "../../../components/Field";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appEditStrings } from "../../../lib/screenStrings/appEdit";
import { appUpdateStrings } from "../../../lib/screenStrings/appUpdates";
import type { FormApi } from "../appForm";
import { HuePicker } from "../HuePicker";

const t = appAddStrings;

/** Which update modes the add page offers: "Rulebox updates it" needs a vendor feed, which belongs to the Updates tab. */
const ADD_MODES: readonly UpdateMode[] = ["pinned", "vendor"];

/**
 * "More options" of a Windows app: the description, the tile colour, what happens on removal and (on the add page) how the app is
 * kept up to date. Closed by default; Rulebox already picked sensible values for all of them. Controlled, so "Change" next to the
 * version line can open it.
 */
export function DesktopMore({
  f,
  readOnly,
  open,
  onOpen,
  uninstall,
  updates,
  browser,
  appKey,
  children,
}: {
  f: FormApi;
  readOnly: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** Show the "remove from PCs" switch (an MSI, a portable file or a winget MSI: an EXE can't be uninstalled). */
  uninstall: boolean;
  /** Show the update mode (the add page; the edit page has an Updates tab). */
  updates: boolean;
  /** A Chrome or Edge program: it always updates itself. */
  browser: boolean;
  appKey: string;
  children?: ReactNode;
}) {
  const x = f.values;
  const mode: UpdateMode = browser ? "vendor" : x.updateMode === "managed" ? "pinned" : x.updateMode;
  return (
    <details className="dash-advanced apps-more" open={open} onToggle={(ev) => onOpen(ev.currentTarget.open)}>
      <summary>{t.more}</summary>
      <div className="dash-advanced__body">
        <Field label={appEditStrings.description} info={appEditStrings.info.description} error={f.errors.description} optional>
          {(p) => <Input {...p} autoComplete="off" value={x.description} disabled={readOnly} onChange={(e) => f.set("description", e.target.value)} />}
        </Field>
        <HuePicker value={x.hue} onChange={(h) => f.set("hue", h)} name={`hue-${appKey}`} disabled={readOnly} />
        {uninstall ? (
          <div className="rb-labelrow">
            <Switch checked={x.removeWhenUnassigned} onChange={(on) => f.set("removeWhenUnassigned", on)} label={t.lines.remove} disabled={readOnly} />
            <InfoTip label={`About ${t.lines.remove}`}>{t.lines.removeInfo}</InfoTip>
          </div>
        ) : null}
        {updates ? (
          <FieldSet legend={appUpdateStrings.updates} info={appUpdateStrings.modeInfo[mode]} infoLabel={`About ${appUpdateStrings.updates}`}>
            {browser ? (
              <p className="dash-muted">{appUpdateStrings.modeBrowser}</p>
            ) : (
              <div className="apps-modes">
                <SegmentedControl<UpdateMode>
                  aria-label={appUpdateStrings.updates}
                  options={ADD_MODES.map((m) => ({ value: m, label: appUpdateStrings.modeLabels[m] }))}
                  value={mode}
                  onChange={(m) => f.set("updateMode", m)}
                />
              </div>
            )}
            {mode === "vendor" && !browser ? (
              <Field label={appUpdateStrings.publisher} info={appUpdateStrings.publisherHint} error={f.errors.publisher} required>
                {(p) => <Input {...p} spellCheck={false} autoComplete="off" maxLength={200} value={x.publisher} disabled={readOnly} onChange={(e) => f.set("publisher", e.target.value)} />}
              </Field>
            ) : null}
          </FieldSet>
        ) : null}
        {children}
      </div>
    </details>
  );
}
