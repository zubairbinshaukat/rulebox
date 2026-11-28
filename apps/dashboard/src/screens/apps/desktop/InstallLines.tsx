import type { ReactNode } from "react";
import { Button, InfoTip } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-bold-duotone";
import IconWarn from "~icons/solar/danger-triangle-linear";
import IconInfo from "~icons/solar/info-circle-linear";
import { InlineNotice } from "../../../components/Notice";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { COMMON_SWITCHES, type SilentStatus } from "../../../lib/apps/silentMode";
import type { Line } from "./model";

const t = appAddStrings;

/**
 * What the app does on a PC, as short lines a person can read at a glance: "Installs silently", "Checked before it installs", where it
 * comes from, what happens on removal, the version. Each line has an (i) with the sentence behind it; a warning stays visible under
 * its line. Technical values (hashes, switches, sizes) are not here: they live under Advanced.
 */
export function InstallLines({ lines, onVersion, children }: { lines: readonly Line[]; /** "Change" next to the version line. */ onVersion?: () => void; children?: ReactNode }) {
  if (lines.length === 0 && !children) return null;
  return (
    <ul className="apps-lines" aria-label={t.review.summary}>
      {lines.map((line) => (
        <li key={line.id} className="apps-line" data-tone={line.tone} data-line={line.id}>
          <span className="apps-line__icon" aria-hidden="true">
            {line.tone === "success" ? <IconCheck /> : line.tone === "warning" ? <IconWarn /> : <IconInfo />}
          </span>
          <span className="apps-line__body">
            <span className="apps-line__label">
              {line.label}
              <InfoTip label={`About ${line.label}`}>{line.info}</InfoTip>
            </span>
            {line.note ? <span className="apps-line__note">{line.note}</span> : null}
          </span>
          {line.id === "version" && onVersion ? (
            <button type="button" className="apps-line__change" onClick={onVersion}>
              {t.lines.versionChange}
            </button>
          ) : null}
        </li>
      ))}
      {children}
    </ul>
  );
}

/**
 * The two cases where Add must wait because the PC could not run the installer without a click: a plain program nobody recognised
 * (no silent switches) and an installer that needs a recorded answer file. They are warnings with a way forward, never silence.
 */
export function SilentBlock({
  silent,
  readOnly,
  onOpenAdvanced,
  onPickSwitch,
}: {
  silent: SilentStatus;
  readOnly: boolean;
  onOpenAdvanced: () => void;
  onPickSwitch: (switches: string) => void;
}) {
  if (silent.state === "needs_answer") {
    return (
      <InlineNotice
        tone="warning"
        title={t.answer.needed}
        detail={t.answer.neededBody}
        action={
          <Button type="button" variant="ghost" className="dash-btn--sm" onClick={onOpenAdvanced}>
            {t.silent.openAdvanced}
          </Button>
        }
      />
    );
  }
  if (silent.state !== "unknown") return null;
  return (
    <div className="apps-unknown" role="status">
      <div className="apps-unknown__head">
        <span className="apps-line__icon" aria-hidden="true" data-tone="warning">
          <IconWarn />
        </span>
        <div>
          <p className="apps-unknown__title">
            {silent.label}
            <InfoTip label={`About ${t.silent.unknownTitle}`}>{silent.info}</InfoTip>
          </p>
          <p className="apps-unknown__body">{t.silent.unknownBody}</p>
        </div>
      </div>
      {!readOnly ? (
        <div className="apps-unknown__actions">
          <span className="apps-unknown__label" id="apps-common-switches">
            {t.silent.commonSwitches}
          </span>
          <span className="apps-unknown__chips" role="group" aria-labelledby="apps-common-switches">
            {COMMON_SWITCHES.map((sw) => (
              <button key={sw} type="button" className="apps-switch" onClick={() => onPickSwitch(sw)}>
                {sw}
              </button>
            ))}
          </span>
          <span className="apps-unknown__hint">{t.silent.commonHint}</span>
          <Button type="button" variant="ghost" className="dash-btn--sm" onClick={onOpenAdvanced}>
            {t.silent.openAdvanced}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
