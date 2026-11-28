import type { ReactElement } from "react";
import { Button } from "@rulebox/ui";
import IconOff from "~icons/solar/minus-circle-linear";
import IconTrial from "~icons/solar/eye-linear";
import IconBlock from "~icons/solar/forbidden-circle-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import { LAYER_MODES, type LayerMode, type LockdownSettings } from "../../data/types";
import { programModeOf } from "./rules";
import { RadioCards, type RadioCardOption } from "./RadioCards";
import { LkSection } from "./Section";
import { lockdownStrings as s } from "./strings";

/** After this many days of trial run the page suggests switching to Block (plan Q2). */
export const TRIAL_HINT_DAYS = 7;

const ICONS: Record<LayerMode, ReactElement> = { off: <IconOff />, audit: <IconTrial />, enforce: <IconBlock /> };
const OPTIONS: readonly RadioCardOption<LayerMode>[] = LAYER_MODES.map((m) => ({ value: m, title: s.modes[m], lead: s.modeSub[m], icon: ICONS[m] }));

/**
 * "Program blocking": ONE decision for the three program checks (Off, Trial run, Block). The checks themselves are under Advanced; when
 * they differ, no card is checked and a line says so. The words under the cards say what the chosen mode does and how long the trial has run.
 */
export function ProgramMode({
  settings,
  trialDays,
  onPick,
  onShowChecks,
  disabled,
  className,
}: {
  settings: LockdownSettings;
  /** Whole days since the program checks went into trial run (0 = not in trial run or less than a day). */
  trialDays: number;
  onPick: (mode: LayerMode) => void;
  onShowChecks: () => void;
  disabled: boolean;
  className?: string;
}) {
  const mode = programModeOf(settings);
  return (
    <LkSection title={s.modeTitle} info={s.modeInfo} className={className}>
      {(headingId) => (
        <>
          <RadioCards variant="mode" labelledBy={headingId} value={mode === "mixed" ? null : mode} options={OPTIONS} onChange={onPick} disabled={disabled} />
          <div className="lk-modehelp" aria-live="polite">
            {mode === "mixed" ? (
              <p className="lk-modehelp__text">
                {s.mixed}{" "}
                <Button variant="ghost" className="dash-btn--sm" onClick={onShowChecks}>
                  {s.advanced}
                </Button>
              </p>
            ) : (
              <p className="lk-modehelp__text">{s.modeHelp[mode]}</p>
            )}
            {mode === "audit" && trialDays >= 1 ? (
              trialDays >= TRIAL_HINT_DAYS ? (
                <p className="lk-note" data-tone="warning">
                  <IconWarn aria-hidden="true" />
                  <span>{s.trialLong(trialDays)}</span>
                </p>
              ) : (
                <p className="lk-modehelp__sub">{s.trialDays(trialDays)}</p>
              )
            ) : null}
          </div>
        </>
      )}
    </LkSection>
  );
}
